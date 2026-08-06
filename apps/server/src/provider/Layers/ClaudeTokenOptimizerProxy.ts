// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - This Promise is an abort-aware HTTP retry delay outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";

import type { ChatAttachment, ThreadId, TurnId } from "@t3tools/contracts";
import {
  createProxy,
  setAllowedModelBases,
  type ProxyEvent,
  type PxpipeTransformInfo,
} from "pxpipe-proxy";

import { attachmentRelativePath, createAttachmentId } from "../../attachmentStore.ts";
import { isRetryableUpstreamStatus } from "../providerOverloadRetry.ts";

const FABLE_MODEL_ID = "claude-fable-5";
/**
 * Rendered-page glyph font. pxpipe's Claude profile default is the 5×8
 * `spleen-5x8` bitmap atlas, which puts ~5 px glyphs in front of the vision
 * encoder. Production Fable kept flagging those pages as "too dense" and fell
 * back to re-reading the raw image even after the 312→280 column reduction, so
 * raise the effective DPI instead of shaving more columns: `jetbrains-mono-10`
 * is a 6×11 cell (+65% glyph area) rasterized from a real typeface with a
 * grayscale-antialiased atlas, not a 1-bit frame-buffer font.
 *
 * Installed through pxpipe's documented `PXPIPE_GPT_PROFILES` override channel
 * (see installFableRenderProfile below) rather than by patching the package:
 * the resolved profile is the single source that feeds rendering
 * (`renderTextToPngs`), pagination, the profitability gate, and patch-grid
 * pricing (`denseGateGeometry` → `renderCellWidth`/`renderCellHeight`), so
 * every token estimate tracks the new cell geometry automatically.
 */
export const FABLE_RENDER_FONT = "jetbrains-mono-10";
/**
 * Rendered-page wrap width in monospace cells, overriding pxpipe's Claude
 * profile default (312 cols ≈ 28,080 chars/page). With the 6 px-wide
 * FABLE_RENDER_FONT cells, 240 cols caps the page at 240 × 6 px + 8 px pad =
 * 1448 px — inside the measured no-resample envelope (long edge ≤ 1568 px AND
 * ≤ ~1.15 MP; 1448 × 728 = 1.054 MP), so pages stay WYSIWYG for the encoder.
 * We deliberately do NOT stretch into the high-res tier's documented
 * 2576 px / 4784-token bounds: the no-resample envelope was measured at the
 * standard tier (/tmp/pxexp/LEVER1-findings.md) and an unmeasured 2576 px page
 * that DID get resampled would blur every glyph — the exact failure mode this
 * change exists to fix.
 *
 * Economics: a full page is 240 cols × 65 rows = 15,600 chars for
 * ⌈1448/28⌉ × ⌈728/28⌉ = 1352 patch tokens ≈ 11.5 chars/token — less headroom
 * than the old 5×8 geometry (~19 chars/token) but still ~2.9× denser than
 * ~4 chars/token text, and the profitability gate re-evaluates against the
 * real geometry, so unprofitable blocks simply stay text.
 *
 * No other budget math needs touching: pxpipe threads an explicit `cols`
 * through the slab, tool_result, reminder, and history-collapse paths AND
 * through the profitability gate + image-cost pricing (`denseGateGeometry`,
 * `maxCharsPerImage`), so paging and break-even economics follow this single
 * knob automatically.
 */
export const FABLE_RENDER_COLS = 240;
const MAX_RENDERED_PAGE_BYTES = 10 * 1024 * 1024;
// Keep ordinary Claude responses replayable until the upstream stream closes.
// This prevents a mid-response ECONNRESET from committing a truncated response
// to the CLI. The cap bounds aggregate memory when many side chats are active;
// responses beyond it fall back to streaming once the buffer is full.
const MAX_RETRYABLE_RESPONSE_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1_000;
export const CLAUDE_UPSTREAM_RETRY_DELAY_CAP_MS = 15_000;

/**
 * Point the Fable profile at FABLE_RENDER_FONT via pxpipe's documented
 * `PXPIPE_GPT_PROFILES` env override. pxpipe re-parses the variable lazily
 * whenever the raw string changes, so install order versus module load does
 * not matter. An operator-provided entry for the same model id wins field by
 * field (their object is spread last); unrelated model entries are preserved
 * verbatim. Unset fields inherit from the built-in Claude profile, so this
 * only changes the glyph atlas — geometry, pricing, and history behavior stay
 * on the shipped defaults.
 */
function installFableRenderProfile(): void {
  let profiles: Record<string, unknown> = {};
  const raw = process.env["PXPIPE_GPT_PROFILES"];
  if (raw !== undefined && raw !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        profiles = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON is ignored by pxpipe as well; replace it wholesale.
    }
  }
  const operatorEntry = profiles[FABLE_MODEL_ID];
  profiles[FABLE_MODEL_ID] = {
    style: { font: FABLE_RENDER_FONT },
    ...(operatorEntry !== null && typeof operatorEntry === "object" ? operatorEntry : {}),
  };
  process.env["PXPIPE_GPT_PROFILES"] = JSON.stringify(profiles);
}
installFableRenderProfile();

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

export interface ClaudeUpstreamRetryEvent {
  readonly attempt: number;
  readonly delayMs: number;
  readonly status: number | null;
  readonly cause?: unknown;
}

export interface ClaudeUpstreamFailureEvent {
  readonly status: number;
  readonly path: string;
  readonly durationMs: number;
  readonly error?: string | undefined;
  readonly requestBodySha8?: string | undefined;
}

/**
 * Solla owns Claude's upstream retry schedule. It is deliberately unbounded;
 * aborting the pending HTTP request (Stop, session shutdown, or disconnect)
 * is the only retry-loop terminator for a retryable transport failure.
 */
export function claudeUpstreamRetryDelayMs(
  attempt: number,
  options?: {
    readonly initialDelayMs?: number;
    readonly capMs?: number;
  },
): number {
  const initialDelayMs = Math.max(0, options?.initialDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS);
  const capMs = Math.max(0, options?.capMs ?? CLAUDE_UPSTREAM_RETRY_DELAY_CAP_MS);
  const exponent = Math.max(0, Math.min(30, Math.trunc(attempt) - 1));
  return Math.min(capMs, initialDelayMs * 2 ** exponent);
}

/**
 * Whether an optimizer result is worth putting in the work log.
 *
 * The optimizer runs on every upstream request, and its totals are cumulative
 * for the session — so an unchanged result repeats the identical
 * "Optimized N pages · saved ~X tokens" line after every tool call, burying the
 * actual work. Reporting only on change keeps the signal and drops the repeats.
 */
export function shouldReportTokenOptimizerSummary(
  lastReported: string | undefined,
  next: string,
): boolean {
  return lastReported !== next;
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

async function requestBody(req: NodeHttp.IncomingMessage): Promise<Buffer | null> {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timeout = NodeTimers.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      NodeTimers.clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function reportRetry(
  input: Pick<Parameters<typeof startClaudeTokenOptimizerProxy>[0], "onRetry" | "onError">,
  event: ClaudeUpstreamRetryEvent,
): Promise<void> {
  try {
    await input.onRetry?.(event);
  } catch (cause) {
    try {
      await input.onError?.(cause);
    } catch {
      // Retry telemetry must never alter the transport retry loop.
    }
  }
}

function writeFetchResponseHead(response: Response, res: NodeHttp.ServerResponse): void {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  response.headers.forEach((value, name) => res.setHeader(name, value));
}

async function writeResponseChunk(res: NodeHttp.ServerResponse, chunk: Uint8Array): Promise<void> {
  if (res.write(Buffer.from(chunk))) return;
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

async function writeFetchResponse(response: Response, res: NodeHttp.ServerResponse): Promise<void> {
  const body = response.body;

  if (!body) {
    writeFetchResponseHead(response, res);
    res.end();
    return;
  }

  const reader = body.getReader();
  const bufferedChunks: Uint8Array[] = [];
  let bufferedBytes = 0;
  let streaming = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;

      if (
        !streaming &&
        bufferedBytes + chunk.value.byteLength <= MAX_RETRYABLE_RESPONSE_BUFFER_BYTES
      ) {
        bufferedChunks.push(chunk.value);
        bufferedBytes += chunk.value.byteLength;
        continue;
      }

      if (!streaming) {
        writeFetchResponseHead(response, res);
        streaming = true;
        for (const bufferedChunk of bufferedChunks) {
          await writeResponseChunk(res, bufferedChunk);
        }
        bufferedChunks.length = 0;
      }
      await writeResponseChunk(res, chunk.value);
    }

    if (!streaming) {
      // Do not commit response headers or bytes until the upstream body has
      // ended cleanly. A reset anywhere in the normal-size response therefore
      // throws back into the retry loop with the downstream request untouched.
      writeFetchResponseHead(response, res);
      res.end(
        Buffer.concat(
          bufferedChunks.map((chunk) => Buffer.from(chunk)),
          bufferedBytes,
        ),
      );
      return;
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
  readonly onUpstreamFailure?:
    | ((event: ClaudeUpstreamFailureEvent) => void | Promise<void>)
    | undefined;
  readonly onRetry?: ((event: ClaudeUpstreamRetryEvent) => void | Promise<void>) | undefined;
  readonly initialRetryDelayMs?: number | undefined;
  readonly maxRetryDelayMs?: number | undefined;
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
      // See FABLE_RENDER_COLS/FABLE_RENDER_FONT: larger 6×11 glyphs wrapped
      // at 240 cols instead of the profile's 5×8 glyphs at 312 cols.
      cols: FABLE_RENDER_COLS,
      // Judge a stable prefix over several turns instead of claiming savings
      // from a single cold request that may destroy a warm text cache.
      historyAmortizationHorizon: 5,
    }),
    onRequest: async (event) => {
      try {
        if (isRetryableUpstreamStatus(event.status)) {
          await input.onUpstreamFailure?.({
            status: event.status,
            path: event.path,
            durationMs: event.durationMs,
            ...(event.error !== undefined ? { error: event.error } : {}),
            ...(event.reqBodySha8 !== undefined ? { requestBodySha8: event.reqBodySha8 } : {}),
          });
        }
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
        res.once("close", () => {
          if (!res.writableEnded) controller.abort();
        });
        const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
        const init: RequestInit & { duplex?: "half" } = {
          method: req.method ?? "GET",
          headers: requestHeaders(req),
          signal: controller.signal,
        };
        const body = await requestBody(req);
        if (body !== null) {
          init.body = body;
        }
        const url = new URL(req.url ?? "/", origin).toString();
        let attempt = 0;
        while (!controller.signal.aborted) {
          try {
            const response = await proxy(new Request(url, init));
            if (!isRetryableUpstreamStatus(response.status)) {
              await writeFetchResponse(response, res);
              return;
            }
            await response.body?.cancel().catch(() => undefined);
            attempt += 1;
            const delayMs = claudeUpstreamRetryDelayMs(attempt, {
              ...(input.initialRetryDelayMs !== undefined
                ? { initialDelayMs: input.initialRetryDelayMs }
                : {}),
              ...(input.maxRetryDelayMs !== undefined ? { capMs: input.maxRetryDelayMs } : {}),
            });
            await reportRetry(input, { attempt, delayMs, status: response.status });
            await waitForRetry(delayMs, controller.signal);
          } catch (cause) {
            if (controller.signal.aborted) throw cause;
            if (res.headersSent) {
              // Only oversized responses cross the bounded replay buffer. Once
              // bytes have reached the CLI they cannot be safely replayed.
              // Terminate instead of appending a second response to the first.
              res.destroy(cause instanceof Error ? cause : undefined);
              return;
            }
            attempt += 1;
            const delayMs = claudeUpstreamRetryDelayMs(attempt, {
              ...(input.initialRetryDelayMs !== undefined
                ? { initialDelayMs: input.initialRetryDelayMs }
                : {}),
              ...(input.maxRetryDelayMs !== undefined ? { capMs: input.maxRetryDelayMs } : {}),
            });
            await reportRetry(input, { attempt, delayMs, status: null, cause });
            await waitForRetry(delayMs, controller.signal);
          }
        }
      } catch (cause) {
        if (req.aborted || res.destroyed) return;
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
        }
        if (!res.writableEnded) {
          res.end(
            JSON.stringify({
              error: {
                type: "solla_claude_transport_proxy_error",
                message: cause instanceof Error ? cause.message : "Local Claude transport failed.",
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
