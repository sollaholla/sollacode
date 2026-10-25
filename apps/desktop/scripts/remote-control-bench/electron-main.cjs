// Electron entry for the remote-control benchmark, launched by run.ts through
// Playwright's Electron driver. Two hidden windows: the host (synthetic
// desktop + encoder) and a laptop-sized viewer. Nothing is ever shown, so the
// benchmark never takes focus from whoever is using the machine.
const { app, BrowserWindow } = require("electron");

const deviceScaleFactor = process.env.BENCH_DEVICE_SCALE_FACTOR ?? "2";
app.commandLine.appendSwitch("force-device-scale-factor", deviceScaleFactor);
// Hidden windows must keep painting and running timers at full rate.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

app.on("window-all-closed", () => {});

app.whenReady().then(() => {
  const make = (url, width, height) => {
    const window = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      webPreferences: { backgroundThrottling: false },
    });
    void window.loadURL(url);
    return window;
  };
  make(process.env.BENCH_HOST_URL, 1280, 800);
  make(process.env.BENCH_VIEWER_URL, 1440, 900);
});
