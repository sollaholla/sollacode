import * as Effect from "effect/Effect";
import type {
  PreviewAutomationCloseResult,
  PreviewAutomationOperation,
  PreviewAutomationOpenInput,
  PreviewAutomationOpenResult,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeResult,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationWaitForDownloadResult,
  PreviewAutomationStatus,
  PreviewAutomationSelectOptionResult,
  PreviewAutomationUploadResult,
  PreviewTabId,
} from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

export function normalizePreviewOpenInput(
  input: PreviewAutomationOpenInput,
): PreviewAutomationOpenInput {
  const open = input.open ?? input.show ?? true;
  return {
    ...input,
    open,
    show: open,
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({
    scope,
    operation,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  });
});

const invokeTargeted = <A>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId);
};

/**
 * The most one tool call may wait before answering.
 *
 * The MCP client gives a tool call 60s (the SDK default; the LAN Chat client
 * uses the same), then reports "Request timed out" to the model and discards
 * the result the desktop goes on to produce. `preview_wait_for_download`
 * defaulted to 120s and `preview_wait_for` allowed 60s, so a long wait could
 * only ever end as that error -- live 2026-09-03 a download wait ran the full
 * minute on the desktop and the model received "MCP error -32001". A long
 * wait is served in slices instead: each call returns inside the budget, and
 * a result that ran out with nothing to report says to call again.
 */
export const PREVIEW_WAIT_SLICE_MS = 50_000;

export function boundedPreviewWaitMs(requested: number | undefined, fallback: number): number {
  const wanted = requested ?? fallback;
  return Math.min(Math.max(1, Math.floor(wanted)), PREVIEW_WAIT_SLICE_MS);
}

const DOWNLOAD_WAIT_DEFAULT_MS = 120_000;
const PAGE_WAIT_DEFAULT_MS = 15_000;

const handlers = {
  preview_status: (input) => invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  preview_open: (input) =>
    invokeTargeted<PreviewAutomationOpenResult>("open", normalizePreviewOpenInput(input)),
  preview_navigate: (input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  preview_resize: (input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  preview_set_appearance: (input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  preview_snapshot: (input) => invokeTargeted<PreviewAutomationSnapshot>("snapshot", input ?? {}),
  preview_click: (input) =>
    invokeTargeted<void>("click", input, input.timeoutMs).pipe(Effect.as({})),
  preview_drag: (input) => invokeTargeted<void>("drag", input, input.timeoutMs).pipe(Effect.as({})),
  preview_type: (input) => invokeTargeted<void>("type", input, input.timeoutMs).pipe(Effect.as({})),
  preview_upload: (input) =>
    invokeTargeted<PreviewAutomationUploadResult>("upload", input, input.timeoutMs),
  preview_select_option: (input) =>
    invokeTargeted<PreviewAutomationSelectOptionResult>("selectOption", input, input.timeoutMs),
  preview_press: (input) => invokeTargeted<void>("press", input).pipe(Effect.as({})),
  preview_scroll: (input) => invokeTargeted<void>("scroll", input).pipe(Effect.as({})),
  preview_evaluate: (input) =>
    invokeTargeted<unknown>("evaluate", input).pipe(Effect.map((result) => result ?? null)),
  preview_wait_for: (input) => {
    const timeoutMs = boundedPreviewWaitMs(input.timeoutMs, PAGE_WAIT_DEFAULT_MS);
    return invokeTargeted<void>("waitFor", { ...input, timeoutMs }, timeoutMs).pipe(Effect.as({}));
  },
  preview_wait_for_download: (input) => {
    const wanted = input.timeoutMs ?? DOWNLOAD_WAIT_DEFAULT_MS;
    const timeoutMs = boundedPreviewWaitMs(input.timeoutMs, DOWNLOAD_WAIT_DEFAULT_MS);
    return invokeTargeted<PreviewAutomationWaitForDownloadResult>(
      "waitForDownload",
      { ...input, timeoutMs },
      timeoutMs,
    ).pipe(
      Effect.map((result) =>
        wanted > timeoutMs && result.outcome === "none" && result.message === undefined
          ? {
              ...result,
              message: `Waited ${Math.round(timeoutMs / 1000)}s of the ${Math.round(wanted / 1000)}s requested with no download and no approval prompt yet. Call preview_wait_for_download again to keep waiting.`,
            }
          : result,
      ),
    );
  },
  preview_close: (input) => invokeTargeted<PreviewAutomationCloseResult>("close", input),
  preview_recording_start: (input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  preview_recording_stop: (input) =>
    invokeTargeted<PreviewAutomationRecordingArtifact>("recordingStop", input ?? {}),
} satisfies Parameters<typeof PreviewToolkit.toLayer>[0];

const { preview_snapshot, ...standardHandlers } = handlers;

export const PreviewStandardToolkitHandlersLive = PreviewStandardToolkit.toLayer(standardHandlers);

export const PreviewSnapshotToolkitHandlersLive = PreviewSnapshotToolkit.toLayer({
  preview_snapshot,
});

export const PreviewToolkitHandlersLive = PreviewToolkit.toLayer(handlers);
