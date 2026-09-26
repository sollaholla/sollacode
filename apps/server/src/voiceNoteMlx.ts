// @effect-diagnostics nodeBuiltinImport:off - Inference runs in an owned local process.
import { runVoiceProcess } from "@t3tools/shared/nativeVoice/VoiceProcess";
import type { VoiceMlxRuntime } from "./voiceNoteMlxRuntime.ts";

const INFERENCE_SOURCE = String.raw`
import base64, json, sys
import numpy as np
import mlx.core as mx
from parakeet_mlx import from_pretrained
from parakeet_mlx.audio import get_logmel

request = json.load(sys.stdin)
audio = np.frombuffer(base64.b64decode(request["pcm16"]), dtype="<i2").astype(np.float32) / 32768.0
model = from_pretrained(request["modelPath"])
if model.preprocessor_config.sample_rate != 16000:
    raise RuntimeError("The local speech model uses an unexpected sample rate")
mel = get_logmel(mx.array(audio, dtype=mx.float32), model.preprocessor_config)
result = model.generate(mel)[0]
json.dump({"text": result.text.strip()}, sys.stdout)
`;

/** Run only a prepared local model; downloads never occupy an inference deadline. */
export async function transcribeVoiceMlx(
  pcm16: Uint8Array,
  runtime: VoiceMlxRuntime,
  signal: AbortSignal,
  hostEnvironment: NodeJS.ProcessEnv,
): Promise<string> {
  signal.throwIfAborted();
  const result = await runVoiceProcess(runtime.pythonPath, ["-I", "-c", INFERENCE_SOURCE], {
    timeoutMs: 180_000,
    signal,
    env: { ...hostEnvironment, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    input: JSON.stringify({
      pcm16: Buffer.from(pcm16).toString("base64"),
      modelPath: runtime.modelPath,
    }),
  });
  signal.throwIfAborted();
  if (result.exitCode !== 0) throw new Error("The local accelerated speech model failed.");
  const decoded: unknown = JSON.parse(result.stdout);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("text" in decoded) ||
    typeof decoded.text !== "string"
  ) {
    throw new Error("The local accelerated speech model returned an invalid transcript.");
  }
  return decoded.text.trim();
}
