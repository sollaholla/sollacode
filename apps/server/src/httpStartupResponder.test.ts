// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { answerRequestsWhileStarting } from "./httpStartupResponder.ts";

describe("answerRequestsWhileStarting", () => {
  let server: NodeHttp.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  const listen = async () => {
    server = answerRequestsWhileStarting(NodeHttp.createServer());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server!.address() as NodeNet.AddressInfo).port}`;
  };

  it("answers 503 before the app attaches its handler, instead of hanging", async () => {
    const origin = await listen();
    const api = await fetch(`${origin}/.well-known/t3/environment`);
    expect(api.status).toBe(503);
    expect(api.headers.get("retry-after")).toBe("2");
    expect(await api.text()).toBe("Solla Code is starting.");

    const page = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('http-equiv="refresh"');
  });

  it("steps aside once the app's own handler is attached", async () => {
    const origin = await listen();
    server!.on("request", (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ready");
    });
    expect(server!.listenerCount("request")).toBe(1);
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ready");
  });
});
