import { describe, expect, it } from "vite-plus/test";
import { resolveDesktopPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  it.each(["http://192.168.1.44:3773", "https://host.tailnet.example.ts.net"])(
    "keeps %s pairing on its environment and carries the credential in the fragment",
    (origin) => {
      expect(resolveDesktopPairingUrl(origin, "PAIRCODE")).toBe(`${origin}/pair#token=PAIRCODE`);
    },
  );
});
