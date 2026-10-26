// @effect-diagnostics nodeBuiltinImport:off - Isolated browser benchmark driver.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { startLinkEmulator } from "../../apps/desktop/scripts/remote-control-bench/linkEmulator.ts";
import type { PreviewBenchMediaApi } from "./media-renderer.ts";
import type { ReceivedEvent, ViewerHandle, ViewerSize } from "./viewer.ts";

type Playwright = typeof import("../../apps/desktop/node_modules/playwright-core/index.js");
type Browser = Awaited<ReturnType<Playwright["webkit"]["launch"]>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
type Snapshot = ReturnType<PreviewBenchMediaApi["viewerSnapshot"]>;

/** Persistent, isolated viewers; only one subscribes during each sample. Assets bypass the measured link. */
export async function createVideoViewerDriver(options: {
  readonly out: string;
  readonly images: boolean;
  readonly host: { readonly call: <A>(op: string, args?: unknown) => Promise<A> };
}) {
  const script = NodeFS.readFileSync(NodePath.join(options.out, "renderer", "encoder.js"));
  const assets = NodeHttp.createServer((request, response) => {
    if (request.url === "/encoder.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end(script);
    } else if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<!doctype html><body style="margin:0;background:white"><script src="/encoder.js"></script>',
      );
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    assets.once("error", reject);
    assets.listen(0, "127.0.0.1", () => resolve());
  });
  const address = assets.address();
  if (!address || typeof address === "string")
    throw new Error("Video asset server has no TCP address.");
  let browser: Browser | null = null;
  let phone: Page | null = null;
  const phonePage = async (size: ViewerSize) => {
    if (phone) return phone;
    const desktopPackage = NodeURL.fileURLToPath(
      new URL("../../apps/desktop/package.json", import.meta.url),
    );
    const require = NodeModule.createRequire(desktopPackage);
    const { webkit } = require("playwright-core") as Playwright;
    browser = await webkit.launch({
      headless: true,
      ...(process.env.BENCH_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.BENCH_WEBKIT_EXECUTABLE }
        : {}),
    });
    phone = await browser.newPage({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.devicePixelRatio,
      isMobile: true,
      hasTouch: true,
    });
    await phone.goto(`http://127.0.0.1:${address.port}/`);
    await phone.waitForFunction(() => "previewBenchMedia" in globalThis);
    return phone;
  };
  return {
    async start(url: string, size: ViewerSize): Promise<ViewerHandle> {
      const page = size.name === "phone" ? await phonePage(size) : null;
      const link = await startLinkEmulator(Number(new URL(url).port));
      const measuredUrl = new URL(url);
      measuredUrl.port = String(link.port);
      const call = async <A>(method: string, args: unknown[] = []): Promise<A> => {
        if (!page) return options.host.call<A>("videoViewer", { method, args, size });
        return page.evaluate(
          ({ method, args }) => {
            const api = (
              globalThis as typeof globalThis & { previewBenchMedia: PreviewBenchMediaApi }
            ).previewBenchMedia;
            return Reflect.apply(api[method as keyof PreviewBenchMediaApi], api, args);
          },
          { method, args },
        ) as Promise<A>;
      };
      try {
        await call("startViewer", [{ url: measuredUrl.toString(), size }]);
      } catch (error) {
        try {
          await call("stopViewer");
        } finally {
          await link.close();
        }
        throw error;
      }
      const events: ReceivedEvent[] = [];
      let last: Snapshot | null = null;
      let stopped = false;
      const firstPictureAt = call<number>("firstPicture");
      void firstPictureAt.catch(() => undefined);
      return {
        events,
        firstPictureAt,
        bytes: () =>
          link.snapshot().reduce(
            (sum, connection) => ({
              read: sum.read + connection.downstream,
              written: sum.written + connection.upstream,
            }),
            { read: 0, written: 0 },
          ),
        input: (action) => call<void>("viewerInput", [action]),
        viewerStats: () => ({ engine: page ? "WebKit" : "Electron", ...last?.stats }),
        image: () => last?.png,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          try {
            last = await call<Snapshot>("viewerSnapshot", [options.images]);
            events.push(...last.frames);
            if (last.failure) throw new Error(last.failure);
          } finally {
            try {
              await call("stopViewer");
            } finally {
              await link.close();
            }
          }
        },
      };
    },
    async close() {
      try {
        await browser?.close();
      } finally {
        await new Promise<void>((resolve, reject) =>
          assets.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  };
}

export type VideoViewerDriver = Awaited<ReturnType<typeof createVideoViewerDriver>>;
