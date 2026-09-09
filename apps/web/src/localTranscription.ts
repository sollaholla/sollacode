import type { assembleTranscriptionText } from "./pushToTalkTranscription";

type Transcript = Parameters<typeof assembleTranscriptionText>[0];
interface Transcriber {
  (audio: Float32Array, requestId: number): Promise<Transcript>;
  dispose(): Promise<void>;
}

/** Reuse the model; a failed GPU gets one CPU retry with the same complete recording. */
export function createLocalTranscriptionRunner(input: {
  readonly hasWebGpu: boolean;
  readonly create: (device: "webgpu" | "wasm", requestId: number) => Promise<Transcriber>;
}) {
  let device: "webgpu" | "wasm" = input.hasWebGpu ? "webgpu" : "wasm";
  let pending: Promise<Transcriber> | null = null;
  const get = (requestId: number) => (pending ??= input.create(device, requestId));
  const dispose = async () => {
    const previous = pending;
    pending = null;
    const transcriber = await previous?.catch(() => null);
    await transcriber?.dispose().catch(() => undefined);
  };
  return {
    async transcribe(audio: Float32Array, requestId: number): Promise<Transcript> {
      try {
        return await (
          await get(requestId)
        )(audio, requestId);
      } catch (cause) {
        await dispose();
        if (device === "wasm") throw cause;
        device = "wasm";
        try {
          return await (
            await get(requestId)
          )(audio, requestId);
        } catch (fallbackCause) {
          await dispose();
          throw fallbackCause;
        }
      }
    },
    dispose,
  };
}
