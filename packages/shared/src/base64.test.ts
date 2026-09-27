import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vite-plus/test";

import { base64ToBytes, bytesToBase64 } from "./base64.ts";

describe("binary base64", () => {
  it.each([0, 1, 2, 3, 256, 0x8000, 0x8001, 2 * 1024 * 1024])(
    "preserves every byte across padding and chunk boundaries (%i bytes)",
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
      const encoded = bytesToBase64(bytes);
      expect(encoded).toBe(NodeBuffer.Buffer.from(bytes).toString("base64"));
      expect(base64ToBytes(encoded)).toEqual(bytes);
    },
  );

  it("encodes only the selected view of a buffer", () => {
    const bytes = new Uint8Array([255, 1, 2, 3, 254]);
    expect(bytesToBase64(bytes.subarray(1, 4))).toBe("AQID");
  });

  it("preserves atob whitespace and unpadded input support", () => {
    expect(base64ToBytes(" Y Q\n")).toEqual(new Uint8Array([97]));
  });

  it("rejects malformed input", () => {
    expect(() => base64ToBytes("%%%")).toThrow();
  });
});
