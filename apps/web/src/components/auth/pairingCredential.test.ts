import { describe, expect, it } from "vite-plus/test";
import { parsePairingCredential } from "./pairingCredential";

describe("parsePairingCredential", () => {
  const host = "https://computer.example/pair";
  it("accepts a full same-host link or a trimmed code", () => {
    expect(parsePairingCredential(" https://computer.example/pair#token=secret-code ", host)).toBe(
      "secret-code",
    );
    expect(parsePairingCredential(" secret-code ", host)).toBe("secret-code");
  });
  it("does not submit another host's token to this computer", () => {
    expect(() => parsePairingCredential("https://another.example/pair#token=secret", host)).toThrow(
      "another computer",
    );
    expect(() => parsePairingCredential("http://computer.example/pair#token=secret", host)).toThrow(
      "another computer",
    );
  });
  it("gives recovery instructions for empty, incomplete, or unsupported links", () => {
    expect(() => parsePairingCredential(" ", host)).toThrow("Paste a connection link");
    expect(() => parsePairingCredential("https://computer.example/pair", host)).toThrow(
      "no pairing code",
    );
    expect(() => parsePairingCredential("https://", host)).toThrow("incomplete");
    expect(() => parsePairingCredential("file:///tmp/example", host)).toThrow("http or https");
  });
});
