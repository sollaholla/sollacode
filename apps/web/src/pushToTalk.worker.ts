import { env, pipeline } from "@huggingface/transformers";
import onnxWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { configurePackagedOnnxWasm } from "./pushToTalkOnnx";
/* eslint-disable unicorn/require-post-message-target-origin -- DedicatedWorkerGlobalScope.postMessage has a transfer-list second argument, not a target origin. */
import {
  assembleTranscriptionText,
  LONG_FORM_TRANSCRIPTION_OPTIONS,
} from "./pushToTalkTranscription";

const MODEL_ID = "onnx-community/whisper-tiny.en";
const MODEL_REVISION = "2575352d61be1bf7225cf8f8b268a4678025fc58";
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
  transcriberPromise ??= pipeline("automatic-speech-recognition", MODEL_ID, {
    // The repository's legacy `_quantized` decoder is not compatible with
    // ONNX Runtime Web 1.26's MatMulNBits graph optimizer (it fails with a
    // missing scale initializer). The q4 export is larger but is a complete,
    // supported graph and remains practical for the tiny local model.
    dtype: "q4",
    revision: MODEL_REVISION,
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
