// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";

/** Something slow startup is doing that a person waiting should be told about. */
export type StartupStage = "compacting-database";

const STAGE_TEXT: Record<StartupStage, string> = {
  "compacting-database": "Solla Code is compacting its database. This can take a few minutes.",
};

let currentStage: StartupStage | null = null;

/**
 * Labels the "starting" responses until cleared. Clients that only see the
 * header (the desktop's readiness probe, a reconnecting phone) can read it as
 * `x-solla-startup-stage`.
 */
export function setStartupStage(stage: StartupStage | null): void {
  currentStage = stage;
}

const startingHtml = (text: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="2">
<title>Solla Code is starting</title>
<style>html{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px system-ui,sans-serif;background:#0b0b0c;color:#d8d2c4}</style>
</head>
<body><p>${text}</p></body>
</html>
`;

/**
 * Answers requests that reach the server before its routes exist.
 *
 * The listener opens as soon as the HTTP layer is built, but the app attaches
 * its request handler only after every runtime service has started, which
 * can take minutes on a large database. Node answers nothing for a request
 * with no handler, so a phone reconnecting during a restart waited on a
 * request that would never finish. Such requests now get a 503 (a page that
 * refreshes itself, for browser navigations), and this handler removes
 * itself the moment the app's own handler is attached.
 */
export function answerRequestsWhileStarting<S extends NodeHttp.Server>(server: S): S {
  const respond = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const wantsPage =
      request.method === "GET" && (request.headers.accept ?? "").includes("text/html");
    const stage = currentStage;
    response.writeHead(503, {
      "cache-control": "no-store",
      "retry-after": "2",
      "content-type": wantsPage ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      ...(stage === null ? {} : { "x-solla-startup-stage": stage }),
    });
    const text = stage === null ? null : STAGE_TEXT[stage];
    response.end(
      wantsPage
        ? startingHtml(text ?? "Solla Code is starting…")
        : (text ?? "Solla Code is starting."),
    );
  };
  const stepAside = (event: string | symbol) => {
    if (event !== "request") return;
    server.off("request", respond);
    server.off("newListener", stepAside);
  };
  server.on("request", respond);
  server.on("newListener", stepAside);
  return server;
}
