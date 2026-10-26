// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off - Owned, disposable real-server verification driver.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { buildRenderer, startHost, type HostProcess } from "./run.ts";
import { SCENES } from "./scenes.mjs";

const args = process.argv.slice(2);
const argument = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const required = (name: string) => {
  const value = argument(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};
const base = new URL(required("base-url"));
if (
  base.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
  base.port === "3773"
) {
  throw new Error(
    "Use an isolated loopback development backend, not the packaged app's port 3773.",
  );
}
const environmentId = required("environment-id");
const threadId = required("thread-id");
const tabId = required("tab-id");
const out = NodePath.resolve(required("out"));
const bearerFile = argument("bearer-file");
const bearerToken = bearerFile
  ? NodeFS.readFileSync(bearerFile, "utf8").trim()
  : process.env.BENCH_SESSION_BEARER;
if (!bearerToken)
  throw new Error(
    "Supply --bearer-file or BENCH_SESSION_BEARER from the disposable dev environment.",
  );
NodeFS.mkdirSync(out, { recursive: true });
await buildRenderer(out);
if (args.includes("--build-only")) {
  console.log("Integration renderer built; no server or Electron process launched.");
} else {
  await run();
}

function fixtureHtml() {
  return SCENES.idle!()
    .replace("<head>", "<head><title>Solla preview integration</title>")
    .replace(
      "<main>",
      `<main><section style="padding:16px;border:2px solid #246;background:#eef4ff">
      <h1>Preview input verification</h1>
      <label>Message <input id="fixture-message" aria-label="Message" style="font-size:20px;width:360px" oninput="window.__tickMarker()"></label>
      <button id="fixture-click" style="font-size:20px;padding:12px" onclick="window.__fixtureClicks=(window.__fixtureClicks||0)+1;this.textContent='Clicked '+window.__fixtureClicks;window.__tickMarker()">Click counter</button>
      <p>Scroll through the paragraphs below, then return here and type into the field.</p>
    </section>`,
    );
}

async function run() {
  let host: HostProcess | null = null;
  let video = true;
  let scene = "fixture";
  let pointerSequence = 0;
  let stopping = false;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let controls = Promise.resolve();
  let origin = "";
  const socket = new URL("/ws", base);
  socket.protocol = "ws:";
  const sceneUrl = () => `${origin}/scene/${scene}`;
  const requireHost = () => {
    if (!host) throw new Error("The integration host is not ready.");
    return host;
  };
  const connect = async () => {
    await requireHost().call("connect", {
      url: socket.toString(),
      environmentId,
      threadId,
      tabId,
      bearerToken,
      video,
      reportStatus: true,
    });
    await requireHost().call("scene", {
      name: scene === "fixture" ? "idle" : scene,
      url: sceneUrl(),
    });
  };
  const restart = async () => {
    await host?.close();
    host = await startHost(out);
    await connect();
  };
  const status = async () => ({
    environmentId,
    threadId,
    tabId,
    video,
    scene,
    sceneUrl: sceneUrl(),
    source: await requireHost().call("fixtureState"),
    counters: await requireHost().call("counters"),
  });
  const json = (response: NodeHttp.ServerResponse, code: number, value: unknown) => {
    response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const server = NodeHttp.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && path.startsWith("/scene/")) {
      const name = path.slice("/scene/".length);
      const html = name === "fixture" ? fixtureHtml() : SCENES[name]?.();
      if (!html) {
        json(response, 404, { error: "Unknown scene" });
        return;
      }
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && path === "/status") {
      void status().then(
        (value) => json(response, 200, value),
        () => json(response, 503, { error: "Host unavailable" }),
      );
      return;
    }
    if (
      request.method !== "POST" ||
      path !== "/control" ||
      !request.headers["content-type"]?.startsWith("application/json") ||
      (request.headers.origin && request.headers.origin !== origin)
    ) {
      json(response, 404, { error: "No such control" });
      return;
    }
    controls = controls.then(async () => {
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const data = Buffer.from(chunk);
          bytes += data.length;
          if (bytes > 8192) throw new Error("Control body too large");
          chunks.push(data);
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || !("action" in value))
          throw new Error("Missing action");
        switch (value.action) {
          case "scene": {
            if (
              !("name" in value) ||
              typeof value.name !== "string" ||
              (value.name !== "fixture" && !Object.hasOwn(SCENES, value.name))
            )
              throw new Error("Invalid scene");
            scene = value.name;
            await requireHost().call("scene", {
              name: scene === "fixture" ? "idle" : scene,
              url: sceneUrl(),
            });
            break;
          }
          case "video":
            if (!("enabled" in value) || typeof value.enabled !== "boolean")
              throw new Error("Expected enabled boolean");
            video = value.enabled;
            await connect();
            break;
          case "restart":
            await restart();
            break;
          case "capture":
            if (!("available" in value) || typeof value.available !== "boolean")
              throw new Error("Expected capture availability.");
            await requireHost().call("capture", { available: value.available });
            break;
          case "resize": {
            if (
              !("width" in value) ||
              !("height" in value) ||
              ![value.width, value.height].every(
                (dimension) =>
                  typeof dimension === "number" &&
                  Number.isInteger(dimension) &&
                  dimension >= 240 &&
                  dimension <= 1600,
              )
            )
              throw new Error("Expected source width and height between 240 and 1600.");
            await requireHost().call("resize", { width: value.width, height: value.height });
            break;
          }
          case "title":
            if (!("title" in value) || typeof value.title !== "string" || value.title.length > 200)
              throw new Error("Invalid title");
            await requireHost().call("pageMetadata", { title: value.title });
            break;
          case "pointer": {
            if (
              !("x" in value) ||
              !("y" in value) ||
              typeof value.x !== "number" ||
              typeof value.y !== "number" ||
              !Number.isFinite(value.x) ||
              !Number.isFinite(value.y) ||
              value.x < 0 ||
              value.x > 1 ||
              value.y < 0 ||
              value.y > 1
            )
              throw new Error("Invalid pointer coordinates");
            await requireHost().call("pageMetadata", {
              agentPointer: { x: value.x, y: value.y, phase: "move", sequence: ++pointerSequence },
            });
            break;
          }
          case "stop":
            json(response, 200, { stopping: true });
            void stop();
            return;
          default:
            throw new Error("Unknown action");
        }
        json(response, 200, await status());
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : "Control failed" });
      }
    });
  });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(lifetime);
    try {
      await host?.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture server has no loopback port");
    origin = `http://127.0.0.1:${address.port}`;
    await restart();
    const ready = {
      controlUrl: `${origin}/control`,
      statusUrl: `${origin}/status`,
      sceneUrl: sceneUrl(),
      environmentId,
      threadId,
      tabId,
      expiresAfterMinutes: 30,
    };
    NodeFS.writeFileSync(
      NodePath.join(out, "integration-ready.json"),
      JSON.stringify(ready, null, 2),
    );
    console.log(JSON.stringify(ready));
    lifetime = setTimeout(() => {
      void stop();
    }, 30 * 60_000);
  } catch (error) {
    await stop();
    throw error;
  }
}
