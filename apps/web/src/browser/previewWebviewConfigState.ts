import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopPreviewBridge,
  DesktopPreviewWebviewConfig,
  EnvironmentId,
  PreviewBrowserProfile,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";

import { browserProfileKey, parseBrowserProfileKey } from "./hostedBrowserProfileBinding";

const PREVIEW_CONFIG_STALE_TIME_MS = 5 * 60_000;
const PREVIEW_CONFIG_IDLE_TTL_MS = 10 * 60_000;
const KEY_SEPARATOR = "\u0000";

export class PreviewWebviewBridgeUnavailableError extends Schema.TaggedErrorClass<PreviewWebviewBridgeUnavailableError>()(
  "PreviewWebviewBridgeUnavailableError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `Desktop preview configuration is unavailable for environment "${this.environmentId}".`;
  }
}

export class PreviewWebviewConfigLoadError extends Schema.TaggedErrorClass<PreviewWebviewConfigLoadError>()(
  "PreviewWebviewConfigLoadError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load desktop preview configuration for environment "${this.environmentId}".`;
  }
}

export const PreviewWebviewConfigError = Schema.Union([
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
]);
export type PreviewWebviewConfigError = typeof PreviewWebviewConfigError.Type;

type PreviewConfigBridge = Pick<DesktopPreviewBridge, "getPreviewConfig">;

export const loadPreviewWebviewConfig = (
  environmentId: EnvironmentId,
  threadId?: ThreadId,
  bridge: PreviewConfigBridge | null = previewBridge,
  browserProfile?: PreviewBrowserProfile,
): Effect.Effect<DesktopPreviewWebviewConfig, PreviewWebviewConfigError> => {
  if (bridge === null) {
    return Effect.fail(new PreviewWebviewBridgeUnavailableError({ environmentId }));
  }

  return Effect.tryPromise({
    try: () => bridge.getPreviewConfig(environmentId, threadId, browserProfile),
    catch: (cause) => new PreviewWebviewConfigLoadError({ environmentId, cause }),
  });
};

// Keyed by host + profile. Threads keep distinct tabs but share their project's
// or agent's browser partition.
const previewWebviewConfigAtom = Atom.family((key: string) => {
  const [environmentId, threadId, profileKey] = key.split(KEY_SEPARATOR) as [
    EnvironmentId,
    string,
    string,
  ];
  return Atom.make(
    loadPreviewWebviewConfig(
      environmentId,
      threadId ? (threadId as ThreadId) : undefined,
      previewBridge,
      parseBrowserProfileKey(profileKey),
    ),
  ).pipe(
    Atom.swr({
      staleTime: PREVIEW_CONFIG_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PREVIEW_CONFIG_IDLE_TTL_MS),
    Atom.withLabel(`preview:webview-config:${key}`),
  );
});

export function usePreviewWebviewConfig(
  environmentId: EnvironmentId,
  threadId?: ThreadId,
  browserProfile?: PreviewBrowserProfile,
): DesktopPreviewWebviewConfig | null {
  const result = useAtomValue(
    previewWebviewConfigAtom(
      [environmentId, threadId ?? "", browserProfile ? browserProfileKey(browserProfile) : ""].join(
        KEY_SEPARATOR,
      ),
    ),
  );
  return Option.getOrNull(AsyncResult.value(result));
}
