// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off - The abort test needs a caller-owned request signal.
// @effect-diagnostics globalTimers:off - A delayed socket reset reproduces a mid-stream transport failure.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";

import { ThreadId, TurnId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_UPSTREAM_RETRY_DELAY_CAP_MS,
  claudeUpstreamRetryDelayMs,
  shouldReportTokenOptimizerSummary,
  startClaudeTokenOptimizerProxy,
  type ClaudeTokenOptimizerApplied,
  type ClaudeTokenOptimizerProxy,
} from "./ClaudeTokenOptimizerProxy.ts";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    await dispose();
  }
});

async function listen(server: NodeHttp.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
        },
      },
      (res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of res) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          });
        })().catch(reject);
      },
    );
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("ClaudeTokenOptimizerProxy", () => {
  it("retries retryable upstream responses below the SDK until one succeeds", async () => {
    let requests = 0;
    const upstream = NodeHttp.createServer((_req, res) => {
      requests += 1;
      res.setHeader("content-type", "application/json");
      if (requests <= 2) {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: "pxpipe upstream unreachable" }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamUrl = await listen(upstream);
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const retries: Array<{ attempt: number; delayMs: number; status: number | null }> = [];
    const upstreamFailures: Array<{ status: number; path: string }> = [];
    const proxy = await startClaudeTokenOptimizerProxy({
      threadId: ThreadId.make("thread-invisible-retry"),
      attachmentsDir: NodeOS.tmpdir(),
      upstream: upstreamUrl,
      state: { enabled: false, activeTurnId: TurnId.make("turn-invisible-retry") },
      onApplied: () => undefined,
      onRetry: ({ attempt, delayMs, status }) => {
        retries.push({ attempt, delayMs, status });
      },
      onUpstreamFailure: ({ status, path }) => {
        upstreamFailures.push({ status, path });
      },
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
    });
    cleanup.push(() => proxy.close());

    const response = await postJson(`${proxy.baseUrl}/v1/messages`, { prompt: "one request" });
    expect(response).toEqual({ status: 200, body: { ok: true } });
    expect(requests).toBe(3);
    expect(retries).toEqual([
      { attempt: 1, delayMs: 1, status: 502 },
      { attempt: 2, delayMs: 1, status: 502 },
    ]);
    expect(upstreamFailures).toEqual([
      { status: 502, path: "/v1/messages" },
      { status: 502, path: "/v1/messages" },
    ]);
  });

  it("retries an upstream reset after headers but before the first response byte", async () => {
    let requests = 0;
    const upstream = NodeHttp.createServer((_req, res) => {
      requests += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      if (requests === 1) {
        // Undici resolves fetch as soon as the headers arrive. If the proxy
        // commits those headers downstream before reading one body byte, this
        // reset becomes the CLI's terminal "Unable to connect ... ECONNRESET"
        // result instead of staying inside Solla's retry loop.
        res.flushHeaders();
        res.socket?.destroy();
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamUrl = await listen(upstream);
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const retries: Array<{ attempt: number; status: number | null }> = [];
    const proxy = await startClaudeTokenOptimizerProxy({
      threadId: ThreadId.make("thread-reset-before-first-byte"),
      attachmentsDir: NodeOS.tmpdir(),
      upstream: upstreamUrl,
      state: { enabled: false, activeTurnId: TurnId.make("turn-reset-before-first-byte") },
      onApplied: () => undefined,
      onRetry: ({ attempt, status }) => {
        retries.push({ attempt, status });
      },
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
    });
    cleanup.push(() => proxy.close());

    await expect(
      postJson(`${proxy.baseUrl}/v1/messages`, { prompt: "survive reset" }),
    ).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(requests).toBe(2);
    expect(retries).toEqual([{ attempt: 1, status: null }]);
  });

  it("retries an upstream reset after a partial response without leaking it downstream", async () => {
    let requests = 0;
    const upstream = NodeHttp.createServer((_req, res) => {
      requests += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      if (requests === 1) {
        res.write('{"partial":');
        res.flushHeaders();
        NodeTimers.setTimeout(() => res.socket?.destroy(), 10);
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamUrl = await listen(upstream);
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const retries: Array<{ attempt: number; status: number | null }> = [];
    const proxy = await startClaudeTokenOptimizerProxy({
      threadId: ThreadId.make("thread-reset-mid-response"),
      attachmentsDir: NodeOS.tmpdir(),
      upstream: upstreamUrl,
      state: { enabled: false, activeTurnId: TurnId.make("turn-reset-mid-response") },
      onApplied: () => undefined,
      onRetry: ({ attempt, status }) => {
        retries.push({ attempt, status });
      },
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
    });
    cleanup.push(() => proxy.close());

    await expect(
      postJson(`${proxy.baseUrl}/v1/messages`, { prompt: "survive partial reset" }),
    ).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(requests).toBe(2);
    expect(retries).toEqual([{ attempt: 1, status: null }]);
  });

  it("ends an otherwise infinite retry loop when the caller aborts", async () => {
    const upstream = NodeHttp.createServer((_req, res) => {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "still unavailable" }));
    });
    const upstreamUrl = await listen(upstream);
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    let sawRetry: (() => void) | undefined;
    const retrying = new Promise<void>((resolve) => {
      sawRetry = resolve;
    });
    const proxy = await startClaudeTokenOptimizerProxy({
      threadId: ThreadId.make("thread-abort-retry"),
      attachmentsDir: NodeOS.tmpdir(),
      upstream: upstreamUrl,
      state: { enabled: false, activeTurnId: TurnId.make("turn-abort-retry") },
      onApplied: () => undefined,
      onRetry: () => sawRetry?.(),
    });
    cleanup.push(() => proxy.close());

    const controller = new AbortController();
    const request = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ prompt: "wait" }),
      headers: { "content-type": "application/json" },
      signal: controller.signal,
    });
    await retrying;
    controller.abort();
    await expect(request).rejects.toThrow();
  });

  it("renders profitable Fable context, forwards the request, and persists preview pages", async () => {
    let forwardedBody: unknown;
    const upstream = NodeHttp.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        forwardedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-fable-5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      })();
    });
    const upstreamUrl = await listen(upstream);
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "solla-token-optimizer-"),
    );
    cleanup.push(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true }));

    let resolveApplied: (event: ClaudeTokenOptimizerApplied) => void = () => undefined;
    const applied = new Promise<ClaudeTokenOptimizerApplied>((resolve) => {
      resolveApplied = resolve;
    });
    let proxy: ClaudeTokenOptimizerProxy | undefined;
    proxy = await startClaudeTokenOptimizerProxy({
      threadId: ThreadId.make("thread-token-optimizer"),
      attachmentsDir,
      upstream: upstreamUrl,
      state: {
        enabled: true,
        activeTurnId: TurnId.make("turn-token-optimizer"),
      },
      onApplied: resolveApplied,
    });
    cleanup.push(() => proxy?.close());

    const response = await postJson(`${proxy.baseUrl}/v1/messages`, {
      model: "claude-fable-5",
      max_tokens: 32,
      system: [
        {
          type: "text",
          text: "Repository instructions and API documentation. ".repeat(4_000),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "Say ok" }],
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ content: [{ text: "ok" }] });

    const result = await applied;
    expect(JSON.stringify(forwardedBody)).toContain('"type":"image"');
    expect(result.turnId).toBe("turn-token-optimizer");
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.compressedChars).toBeGreaterThan(100_000);
    expect(result.estimatedTokensSaved).toBeGreaterThan(0);
    expect(result.attachments).toHaveLength(result.pageCount);
    for (const attachment of result.attachments) {
      const pagePath = NodePath.join(attachmentsDir, `${attachment.id}.png`);
      expect(NodeFS.existsSync(pagePath)).toBe(true);
      // FABLE_RENDER_COLS density cap: pages must render at the reduced
      // 280-col width (2×4 px pad + 280 × 5 px cells = 1408 px), not pxpipe's
      // 312-col / 1568 px Claude profile default. PNG width lives in the IHDR
      // chunk at byte offset 16.
      const width = NodeFS.readFileSync(pagePath).readUInt32BE(16);
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThanOrEqual(1408);
    }
  });

  it("passes non-Fable Claude models through without rendering pages", async () => {
    let forwardedBody: unknown;
    const upstream = NodeHttp.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        forwardedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      })();
    });
    const upstreamUrl = await listen(upstream);
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "solla-token-optimizer-opus-"),
    );
    cleanup.push(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true }));

    let appliedCount = 0;
    const proxy = await startClaudeTokenOptimizerProxy({
      threadId: ThreadId.make("thread-token-optimizer-opus"),
      attachmentsDir,
      upstream: upstreamUrl,
      state: {
        enabled: true,
        activeTurnId: TurnId.make("turn-token-optimizer-opus"),
      },
      onApplied: () => {
        appliedCount += 1;
      },
    });
    cleanup.push(() => proxy.close());

    const originalSystemText = "Repository instructions and API documentation. ".repeat(4_000);
    const response = await postJson(`${proxy.baseUrl}/v1/messages`, {
      model: "claude-opus-5",
      max_tokens: 32,
      system: [{ type: "text", text: originalSystemText }],
      messages: [{ role: "user", content: "Say ok" }],
    });

    expect(response.status).toBe(200);
    expect(JSON.stringify(forwardedBody)).not.toContain('"type":"image"');
    expect(forwardedBody).toMatchObject({
      model: "claude-opus-5",
      system: [{ text: originalSystemText }],
    });
    expect(appliedCount).toBe(0);
    expect(NodeFS.readdirSync(attachmentsDir)).toEqual([]);
  });
});

describe("shouldReportTokenOptimizerSummary", () => {
  it("reports the first result", () => {
    expect(shouldReportTokenOptimizerSummary(undefined, "Optimized 97 pages")).toBe(true);
  });

  it("suppresses an unchanged repeat", () => {
    // The optimizer runs per upstream request and its totals are cumulative, so
    // this identical line otherwise lands after every single tool call.
    const summary = "Optimized 97 pages · saved ~55,081.5 tokens";
    expect(shouldReportTokenOptimizerSummary(summary, summary)).toBe(false);
  });

  it("reports again once the totals move", () => {
    expect(
      shouldReportTokenOptimizerSummary(
        "Optimized 97 pages · saved ~55,081.5 tokens",
        "Optimized 98 pages · saved ~56,000 tokens",
      ),
    ).toBe(true);
  });
});

describe("claudeUpstreamRetryDelayMs", () => {
  it("backs off indefinitely without ever exceeding fifteen seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 100].map((attempt) => claudeUpstreamRetryDelayMs(attempt))).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      CLAUDE_UPSTREAM_RETRY_DELAY_CAP_MS,
      CLAUDE_UPSTREAM_RETRY_DELAY_CAP_MS,
      CLAUDE_UPSTREAM_RETRY_DELAY_CAP_MS,
    ]);
  });
});
