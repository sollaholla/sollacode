import { describe, expect, it } from "vite-plus/test";
import { configurePackagedOnnxWasm } from "./pushToTalkOnnx";

describe("configurePackagedOnnxWasm", () => {
  it("keeps the ONNX backend on the packaged custom-scheme origin", () => {
    const wasm: {
      proxy?: boolean;
      wasmPaths?: string | { readonly wasm?: string | URL; readonly mjs?: string | URL };
    } = {
      proxy: true,
      wasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/",
    };

    const resolved = configurePackagedOnnxWasm(
      wasm,
      "/assets/ort-wasm-simd-threaded.asyncify-HASH.wasm",
      "sollacode://app/assets/pushToTalk.worker-HASH.js",
    );

    expect(resolved).toBe("sollacode://app/assets/ort-wasm-simd-threaded.asyncify-HASH.wasm");
    expect(wasm).toEqual({
      proxy: false,
      wasmPaths: {
        wasm: "sollacode://app/assets/ort-wasm-simd-threaded.asyncify-HASH.wasm",
      },
    });
    expect(JSON.stringify(wasm)).not.toContain("blob:");
    expect(JSON.stringify(wasm)).not.toContain("https:");
  });
});
