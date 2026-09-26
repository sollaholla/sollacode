import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ensureVoiceMlxRuntime, isVoiceMlxSupported } from "./voiceNoteMlxRuntime.ts";

/** Desktop setup has its own lifetime; HTTP startup and voice-note sends never wait on downloads. */
export function voiceNoteRuntimeStartupLayer(input: {
  readonly baseDir: string;
  readonly desktop: boolean;
  readonly development: boolean;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}) {
  if (!input.desktop || input.development || !isVoiceMlxSupported(input.platform, input.arch))
    return Layer.empty;
  return Layer.effectDiscard(
    Effect.tryPromise((signal) => ensureVoiceMlxRuntime({ baseDir: input.baseDir, signal })).pipe(
      Effect.tap((runtime) =>
        Effect.logInfo("High quality local speech recognition ready", {
          engine: runtime.engine,
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Local speech model setup unavailable; native speech remains available", {
          cause,
        }),
      ),
      Effect.forkScoped,
    ),
  );
}
