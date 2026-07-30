interface OnnxWasmEnvironment {
  proxy?: boolean;
  wasmPaths?: string | { readonly wasm?: string | URL; readonly mjs?: string | URL };
}

export function configurePackagedOnnxWasm(
  wasm: OnnxWasmEnvironment,
  wasmAssetUrl: string,
  workerLocation: string,
): string {
  const resolvedWasmUrl = new URL(wasmAssetUrl, workerLocation).href;
  wasm.wasmPaths = { wasm: resolvedWasmUrl };
  wasm.proxy = false;
  return resolvedWasmUrl;
}
