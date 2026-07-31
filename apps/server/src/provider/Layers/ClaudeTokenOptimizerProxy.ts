// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import type { ChatAttachment, ThreadId, TurnId } from "@t3tools/contracts";
import {
  createProxy,
  setAllowedModelBases,
  type ProxyEvent,
  type PxpipeTransformInfo,
} from "pxpipe-proxy";

import { attachmentRelativePath, createAttachmentId } from "../../attachmentStore.ts";

const FABLE_MODEL_ID = "claude-fable-5";
const MAX_RENDERED_PAGE_BYTES = 10 * 1024 * 1024;

// pxpipe has profiles for other providers/models, but Solla's beta deliberately
// starts with the reader that was measured for this transport.
setAllowedModelBases([FABLE_MODEL_ID]);

export interface ClaudeTokenOptimizerState {
  enabled: boolean;
  activeTurnId: TurnId | undefined;
}

export interface ClaudeTokenOptimizerApplied {
  readonly turnId: TurnId | undefined;
  readonly model: string | undefined;
  readonly compressedChars: number;
  readonly pageCount: number;
  readonly estimatedTextTokens: number | undefined;
  readonly estimatedImageTokens: number | undefined;
  readonly estimatedNativeTokens: number | undefined;
  readonly estimatedTokensSaved: number | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export interface ClaudeTokenOptimizerProxy {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

function normalizeUpstream(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\/+$/u, "");
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function requestHeaders(req: NodeHttp.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(req.headers)) {
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) headers.append(name, value);
    } else if (rawValue !== undefined) {
      headers.set(name, rawValue);
    }
  }
  return headers;
}

function requestBody(req: NodeHttp.IncomingMessage): NonNullable<RequestInit["body"]> | null {
  return req.method === "GET" || req.method === "HEAD"
    ? null
    : (NodeStream.Readable.toWeb(req) as ReadableStream<Uint8Array>);
}

async function writeFetchResponse(response: Response, res: NodeHttp.ServerResponse): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  response.headers.forEach((value, name) => res.setHeader(name, value));

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!res.write(Buffer.from(chunk.value))) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            res.off("error", onError);
            resolve();
          };
          const onError = (cause: Error) => {
            res.off("drain", onDrain);
            reject(cause);
          };
          res.once("drain", onDrain);
          res.once("error", onError);
        });
      }
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}

async function persistRenderedPages(input: {
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly info: PxpipeTransformInfo;
}): Promise<ReadonlyArray<ChatAttachment>> {
  const pages = input.info.imagePngs ?? [];
  if (pages.length === 0) return [];

  await NodeFSP.mkdir(input.attachmentsDir, { recursive: true });
  const attachments: ChatAttachment[] = [];
  for (const [index, bytes] of pages.entries()) {
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_RENDERED_PAGE_BYTES) continue;
    const id = createAttachmentId(input.threadId);
    if (!id) continue;
    const attachment = {
      type: "image" as const,
      id,
      name: `token-optimizer-page-${index + 1}.png`,
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
    };
    await NodeFSP.writeFile(
      NodePath.join(input.attachmentsDir, attachmentRelativePath(attachment)),
      bytes,
      {
        flag: "wx",
      },
    );
    attachments.push(attachment);
  }
  return attachments;
}

function optimizerResult(input: {
  readonly event: ProxyEvent;
  readonly info: PxpipeTransformInfo;
  readonly turnId: TurnId | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): ClaudeTokenOptimizerApplied {
  const estimatedTextTokens = input.info.baselineImagedTokens ?? input.info.gateEval?.textTokens;
  const estimatedImageTokens = input.info.imageTokens ?? input.info.gateEval?.imageTokens;
  const estimatedNativeTokens = input.info.nativeInjectedTokens;
  const estimatedTokensSaved =
    estimatedTextTokens !== undefined && estimatedImageTokens !== undefined
      ? Math.max(0, estimatedTextTokens - estimatedImageTokens - (estimatedNativeTokens ?? 0))
      : undefined;
  return {
    turnId: input.turnId,
    model: input.event.model,
    compressedChars: input.info.compressedChars,
    pageCount: input.info.imageCount,
    estimatedTextTokens,
    estimatedImageTokens,
    estimatedNativeTokens,
    estimatedTokensSaved,
    attachments: input.attachments,
  };
}

export async function startClaudeTokenOptimizerProxy(input: {
  readonly threadId: ThreadId;
  readonly attachmentsDir: string;
  readonly upstream?: string | undefined;
  readonly state: ClaudeTokenOptimizerState;
  readonly onApplied: (event: ClaudeTokenOptimizerApplied) => void | Promise<void>;
  readonly onError?: ((cause: unknown) => void | Promise<void>) | undefined;
}): Promise<ClaudeTokenOptimizerProxy> {
  const reportedRequests = new Set<string>();
  const upstream = normalizeUpstream(input.upstream);
  const proxy = createProxy({
    ...(upstream !== undefined ? { upstream } : {}),
    transform: () => ({
      compress: input.state.enabled,
      compressTools: true,
      compressToolResults: true,
      emitRecoverable: true,
      // Judge a stable prefix over several turns instead of claiming savings
      // from a single cold request that may destroy a warm text cache.
      historyAmortizationHorizon: 5,
    }),
    onRequest: async (event) => {
      try {
        const info = event.info;
        if (!info?.compressed || !input.state.enabled) return;
        const requestKey =
          event.reqBodySha8 ??
          `${input.state.activeTurnId ?? "no-turn"}:${info.systemSha8 ?? "no-system"}:${info.compressedChars}:${info.imageCount}`;
        if (reportedRequests.has(requestKey)) return;
        reportedRequests.add(requestKey);

        const attachments = await persistRenderedPages({
          attachmentsDir: input.attachmentsDir,
          threadId: input.threadId,
          info,
        });
        await input.onApplied(
          optimizerResult({
            event,
            info,
            turnId: input.state.activeTurnId,
            attachments,
          }),
        );
      } catch (cause) {
        try {
          await input.onError?.(cause);
        } catch {
          // Telemetry and preview persistence are strictly best-effort. Neither
          // may turn a successful provider response into a failed user turn.
        }
      }
    },
  });

  const server = NodeHttp.createServer((req, res) => {
    void (async () => {
      try {
        const controller = new AbortController();
        req.once("aborted", () => controller.abort());
        const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
        const init: RequestInit & { duplex?: "half" } = {
          method: req.method ?? "GET",
          headers: requestHeaders(req),
          signal: controller.signal,
        };
        const body = requestBody(req);
        if (body !== null) {
          init.body = body;
          init.duplex = "half";
        }
        const response = await proxy(new Request(new URL(req.url ?? "/", origin).toString(), init));
        await writeFetchResponse(response, res);
      } catch (cause) {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
        }
        if (!res.writableEnded) {
          res.end(
            JSON.stringify({
              error: {
                type: "solla_token_optimizer_proxy_error",
                message: cause instanceof Error ? cause.message : "Local optimizer proxy failed.",
              },
            }),
          );
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Token Optimizer proxy did not bind to a TCP port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}
