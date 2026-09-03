import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boundProviderTurnInput } from "./providerInputBounding.ts";

describe("boundProviderTurnInput", () => {
  it("returns a prompt that already fits untouched", () => {
    const text = "a".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    const bounded = boundProviderTurnInput({ text, spillPath: "/tmp/spill.txt" });
    expect(bounded.bounded).toBe(false);
    expect(bounded.text).toBe(text);
    expect(bounded.omittedChars).toBe(0);
  });

  it("fits an over-cap prompt inside the ceiling the send schema enforces", () => {
    // The failure this guards: a pasted crash report made `sendTurn` reject
    // the whole turn, so the message could never be delivered at all.
    const text = `${"H".repeat(200_000)}${"T".repeat(300_000)}`;
    const bounded = boundProviderTurnInput({ text, spillPath: "/state/spill.txt" });
    expect(bounded.bounded).toBe(true);
    expect(bounded.text.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(bounded.originalChars).toBe(500_000);
    expect(bounded.omittedChars).toBe(400_000);
  });

  it("keeps the head and the tail, and names the file holding the rest", () => {
    const text = `OPENING REQUEST\n${"x".repeat(400_000)}\nCLOSING INSTRUCTION`;
    const bounded = boundProviderTurnInput({ text, spillPath: "/state/spill.txt" });
    expect(bounded.text.startsWith("OPENING REQUEST")).toBe(true);
    expect(bounded.text.endsWith("CLOSING INSTRUCTION")).toBe(true);
    expect(bounded.text).toContain("/state/spill.txt");
  });

  it("says the middle is unrecoverable when the spill could not be written", () => {
    const bounded = boundProviderTurnInput({ text: "y".repeat(300_000), spillPath: null });
    expect(bounded.text.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(bounded.text).toContain("unrecoverable");
  });

  it("still fits when the ceiling is too small for a head and a tail", () => {
    const bounded = boundProviderTurnInput({
      text: "z".repeat(5_000),
      spillPath: "/state/spill.txt",
      maxChars: 800,
    });
    expect(bounded.text.length).toBeLessThanOrEqual(800);
    expect(bounded.bounded).toBe(true);
  });
});
