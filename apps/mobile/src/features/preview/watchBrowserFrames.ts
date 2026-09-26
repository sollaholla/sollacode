import { AppState } from "react-native";

/** A focused route still stays mounted when the app goes into the background. */
export function watchBrowserFrames(options: {
  readonly capture: () => Promise<unknown>;
  readonly intervalMs: () => number;
  readonly onPause: () => void;
}) {
  let active = true;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (!active || inFlight || AppState.currentState !== "active") return;
    inFlight = true;
    try {
      await options.capture();
    } finally {
      inFlight = false;
      if (active && AppState.currentState === "active") {
        timer = setTimeout(() => void tick(), options.intervalMs());
      }
    }
  };
  const subscription = AppState.addEventListener("change", (state) => {
    clearTimeout(timer);
    if (state === "active") void tick();
    else options.onPause();
  });
  void tick();
  return () => {
    active = false;
    clearTimeout(timer);
    subscription.remove();
    options.onPause();
  };
}
