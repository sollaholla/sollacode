/**
 * PCM16 helpers for the Grok Voice WebSocket transport.
 *
 * xAI's Speech-to-Speech API defaults to 24 kHz little-endian PCM on both
 * directions when `audio.*.format.type` is `audio/pcm`. The browser captures
 * float32; these convert at the wire boundary.
 */

export const REALTIME_PCM_SAMPLE_RATE = 24_000;

export function float32ToPcm16Base64(samples: ArrayLike<number>): string {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    pcm[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return bytesToBase64(new Uint8Array(pcm.buffer));
}

export function pcm16Base64ToFloat32(base64: string): Float32Array<ArrayBuffer> {
  const bytes = base64ToBytes(base64);
  const usable = bytes.byteLength - (bytes.byteLength % 2);
  if (usable === 0) return new Float32Array(0);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);
  const samples = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    samples[index] = (pcm[index] ?? 0) / 32768;
  }
  return samples;
}

export function resampleLinear(
  input: ArrayLike<number>,
  fromRate: number,
  toRate: number,
): Float32Array<ArrayBuffer> {
  if (fromRate <= 0 || toRate <= 0 || input.length === 0) {
    return input instanceof Float32Array ? new Float32Array(input) : Float32Array.from(input);
  }
  if (fromRate === toRate) {
    return input instanceof Float32Array ? new Float32Array(input) : Float32Array.from(input);
  }
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const source = index * ratio;
    const left = Math.floor(source);
    const right = Math.min(left + 1, input.length - 1);
    const mix = source - left;
    output[index] = (input[left] ?? 0) * (1 - mix) + (input[right] ?? 0) * mix;
  }
  return output;
}

export interface StreamingLinearResampler {
  readonly process: (input: ArrayLike<number>) => Float32Array<ArrayBuffer>;
  readonly reset: () => void;
}

/** Linear resampling with fractional phase carried across capture callbacks. */
export function createStreamingLinearResampler(
  fromRate: number,
  toRate: number,
): StreamingLinearResampler {
  const ratio = fromRate / toRate;
  let position = 0;
  let previousSample: number | null = null;

  return {
    process: (input) => {
      if (input.length === 0) return new Float32Array(0);
      if (fromRate <= 0 || toRate <= 0 || fromRate === toRate) {
        return input instanceof Float32Array ? new Float32Array(input) : Float32Array.from(input);
      }

      const samples = new Float32Array(input.length + (previousSample === null ? 0 : 1));
      let offset = 0;
      if (previousSample !== null) {
        samples[0] = previousSample;
        offset = 1;
      }
      for (let index = 0; index < input.length; index += 1) {
        samples[index + offset] = input[index] ?? 0;
      }

      const output: Array<number> = [];
      while (position < samples.length - 1) {
        const left = Math.floor(position);
        const mix = position - left;
        output.push((samples[left] ?? 0) * (1 - mix) + (samples[left + 1] ?? 0) * mix);
        position += ratio;
      }
      position -= samples.length - 1;
      previousSample = samples[samples.length - 1] ?? null;
      return Float32Array.from(output);
    },
    reset: () => {
      position = 0;
      previousSample = null;
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
