// @effect-diagnostics nodeBuiltinImport:off - Isolate native inference so cancellation can terminate it.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { runVoiceProcess } from "@t3tools/shared/nativeVoice/VoiceProcess";

const FALLBACK_SOURCE = String.raw`
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const { pipeline, env } = await import(request.moduleUrl);
env.cacheDir = request.cacheDir;
const model = await pipeline("automatic-speech-recognition", "onnx-community/distil-small.en", {
  device: "cpu", dtype: "q4", revision: "69be759f982d1d4c5b8a987d4140752742619bd0",
});
const pcm = Buffer.from(request.pcm16, "base64");
const audio = new Float32Array(pcm.length / 2);
for (let i = 0; i < audio.length; i++) audio[i] = pcm.readInt16LE(i * 2) / 32768;
const result = await model(audio, { chunk_length_s: 30, stride_length_s: 5 });
const text = (Array.isArray(result) ? result : [result]).map(part => part.text.trim()).join(" ").trim();
process.stdout.write(JSON.stringify({ text }));
`;

export async function transcribeVoiceFallback(
  pcm16: Uint8Array,
  cacheDir: string,
  signal: AbortSignal,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  signal.throwIfAborted();
  const moduleUrl = NodeURL.pathToFileURL(
    NodeModule.createRequire(import.meta.url).resolve("@huggingface/transformers"),
  ).href;
  const result = await runVoiceProcess(
    process.execPath,
    ["--input-type=module", "-e", FALLBACK_SOURCE],
    {
      timeoutMs: 180_000,
      signal,
      env: { ...hostEnvironment, ELECTRON_RUN_AS_NODE: "1" },
      input: JSON.stringify({ moduleUrl, cacheDir, pcm16: Buffer.from(pcm16).toString("base64") }),
    },
  );
  signal.throwIfAborted();
  if (result.exitCode !== 0)
    throw new Error("The host's local speech model failed. Your voice note remains in the draft.");
  const decoded: unknown = JSON.parse(result.stdout);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("text" in decoded) ||
    typeof decoded.text !== "string"
  )
    throw new Error("The host speech model returned an invalid transcript.");
  return decoded.text;
}
