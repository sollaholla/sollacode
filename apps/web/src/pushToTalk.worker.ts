import { env, pipeline } from "@huggingface/transformers";
import onnxWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { configurePackagedOnnxWasm } from "./pushToTalkOnnx";
import { createLocalTranscriptionRunner } from "./localTranscription";
/* eslint-disable unicorn/require-post-message-target-origin -- DedicatedWorkerGlobalScope.postMessage has a transfer-list second argument, not a target origin. */
import {
  assembleTranscriptionText,
  LOCAL_TRANSCRIPTION_MODEL,
  LONG_FORM_TRANSCRIPTION_OPTIONS,
} from "./pushToTalkTranscription";

env.useBrowserCache = true;

// Transformers.js defaults ONNX Runtime to jsDelivr in browsers. When the app
// is served from Electron's privileged `sollacode://` scheme, ONNX fetches that
// remote module and turns it into a `blob:sollacode://...` dynamic import,
// which Chromium rejects. Point only the binary at Vite's app-controlled asset
// URL. ONNX can then use its already-bundled module factory and fetch the WASM
// binary from the same custom-scheme origin without a blob module import.
const onnxWasm = env.backends.onnx.wasm;
if (!onnxWasm) {
  throw new Error("The packaged ONNX WASM runtime is unavailable.");
}
configurePackagedOnnxWasm(onnxWasm, onnxWasmUrl, self.location.href);

const runner = createLocalTranscriptionRunner({
  hasWebGpu: typeof navigator !== "undefined" && "gpu" in navigator,
  create: async (device, id) => {
    const transcriber = await pipeline(
      "automatic-speech-recognition",
      LOCAL_TRANSCRIPTION_MODEL.id,
      {
        device,
        dtype: LOCAL_TRANSCRIPTION_MODEL.dtype,
        revision: LOCAL_TRANSCRIPTION_MODEL.revision,
        progress_callback: (progress) => {
          if (progress.status !== "progress") return;
          self.postMessage({ id, status: "loading", progress: progress.progress });
        },
      },
    );
    return Object.assign(
      async (audio: Float32Array, requestId: number) => {
        self.postMessage({ id: requestId, status: "transcribing" });
        return transcriber(audio, LONG_FORM_TRANSCRIPTION_OPTIONS);
      },
      { dispose: () => transcriber.dispose() },
    );
  },
});

self.addEventListener(
  "message",
  async (
    event: MessageEvent<
      { readonly id: number; readonly audio: Float32Array } | { readonly type: "dispose" }
    >,
  ) => {
    if ("type" in event.data) {
      await runner.dispose();
      self.close();
      return;
    }
    try {
      const result = await runner.transcribe(event.data.audio, event.data.id);
      self.postMessage({ id: event.data.id, text: assembleTranscriptionText(result) });
    } catch (cause) {
      self.postMessage({
        id: event.data.id,
        error: cause instanceof Error ? cause.message : "Local transcription failed.",
      });
    }
  },
);
