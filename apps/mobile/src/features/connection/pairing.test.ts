import { describe, expect, it } from "vite-plus/test";

import {
  buildPairingUrl,
  cameraPermissionAction,
  extractPairingUrlFromQrPayload,
  PairingQrPayloadEmptyError,
  parsePairingUrl,
  readPairingLink,
} from "./pairing";

describe("extractPairingUrlFromQrPayload", () => {
  it("trims raw pairing urls from qr payloads", () => {
    expect(
      extractPairingUrlFromQrPayload("  https://remote.example.com/pair#token=pairing-token  "),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    expect(
      extractPairingUrlFromQrPayload(
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("rejects empty qr payloads", () => {
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(PairingQrPayloadEmptyError);
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(
      "Scanned QR code did not contain a pairing URL.",
    );
  });

  it("rejects unrelated QR codes before leaving the scanner", () => {
    expect(() => extractPairingUrlFromQrPayload("hello")).toThrow();
    expect(() => extractPairingUrlFromQrPayload("https://example.com/menu")).toThrow();
    expect(() => extractPairingUrlFromQrPayload("javascript:alert(1)#token=code")).toThrow();
  });

  it.each(["t3code", "t3code-dev", "t3code-preview"])(
    "accepts %s mobile links without changing the backend protocol",
    (scheme) => {
      const backend = "http://192.168.1.4:3773/pair#token=code";
      expect(readPairingLink(`${scheme}://pair?pairingUrl=${encodeURIComponent(backend)}`)).toBe(
        backend,
      );
    },
  );
});

describe("manual pairing details", () => {
  it("round-trips direct and hosted links through manual address and code fields", () => {
    for (const link of [
      "http://192.168.1.4:3773/pair#token=local-code",
      "https://computer.example/pair?token=query-code",
      "https://app.t3.codes/pair?host=https%3A%2F%2Fcomputer.example%2F#token=hosted-code",
    ]) {
      const { host, code } = parsePairingUrl(link);
      expect(parsePairingUrl(readPairingLink(buildPairingUrl(host, code)))).toEqual({ host, code });
    }
  });

  it("accepts a complete link without a separate code and preserves implicit HTTPS for existing manual input", () => {
    const link = "https://computer.example/pair#token=code";
    expect(readPairingLink(buildPairingUrl(link, ""))).toBe(link);
    expect(readPairingLink(buildPairingUrl("computer.example", "code"))).toBe(
      "https://computer.example/#token=code",
    );
    expect(() => readPairingLink(buildPairingUrl("https://computer.example", ""))).toThrow();
  });
});

describe("camera permission recovery", () => {
  it("requests access only when the OS can still show a permission prompt", () => {
    expect(cameraPermissionAction(null)).toBe("request");
    expect(cameraPermissionAction({ granted: false, canAskAgain: true })).toBe("request");
    expect(cameraPermissionAction({ granted: false, canAskAgain: false })).toBe("settings");
  });

  it("returns to scanning after access is granted in system Settings", () => {
    expect(cameraPermissionAction({ granted: true, canAskAgain: false })).toBe("scan");
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});
