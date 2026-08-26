import { env, pipeline } from "@huggingface/transformers";
import onnxWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { configurePackagedOnnxWasm } from "./pushToTalkOnnx";
/* eslint-disable unicorn/require-post-message-target-origin -- DedicatedWorkerGlobalScope.postMessage has a transfer-list second argument, not a target origin. */
import {
  assembleTranscriptionText,
  LOCAL_TRANSCRIPTION_MODEL,
  LONG_FORM_TRANSCRIPTION_OPTIONS,
} from "./pushToTalkTranscription";

let transcriberPromise: ReturnType<typeof pipeline<"automatic-speech-recognition">> | null = null;

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

function getTranscriber(id: number) {
  transcriberPromise ??= pipeline("automatic-speech-recognition", LOCAL_TRANSCRIPTION_MODEL.id, {
    // q4 keeps the substantially more accurate 166M-parameter fallback
    // practical in a browser cache. The full model is never bundled into the
    // app or sent to a paid API.
    dtype: LOCAL_TRANSCRIPTION_MODEL.dtype,
    revision: LOCAL_TRANSCRIPTION_MODEL.revision,
    progress_callback: (progress) => {
      if (progress.status !== "progress") return;
      self.postMessage({
        id,
        status: "loading",
        progress: progress.progress,
      });
    },
  });
  return transcriberPromise;
}

self.addEventListener(
  "message",
  async (
    event: MessageEvent<
      { readonly id: number; readonly audio: Float32Array } | { readonly type: "dispose" }
    >,
  ) => {
    if ("type" in event.data) {
      const transcriber = await transcriberPromise;
      await transcriber?.dispose();
      self.close();
      return;
    }
    try {
      const transcriber = await getTranscriber(event.data.id);
      self.postMessage({ id: event.data.id, status: "transcribing" });
      const result = await transcriber(event.data.audio, LONG_FORM_TRANSCRIPTION_OPTIONS);
      self.postMessage({ id: event.data.id, text: assembleTranscriptionText(result) });
    } catch (cause) {
      self.postMessage({
        id: event.data.id,
        error: cause instanceof Error ? cause.message : "Local transcription failed.",
      });
    }
  },
);
