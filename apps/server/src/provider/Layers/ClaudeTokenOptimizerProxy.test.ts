// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId, TurnId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
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
      expect(NodeFS.existsSync(NodePath.join(attachmentsDir, `${attachment.id}.png`))).toBe(true);
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
