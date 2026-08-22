import { describe, expect, it } from "vite-plus/test";

import {
  ECHO_PRONE_MAX_VIEWPORT,
  isEchoProneDevice,
  resolveInterruptWhileSpeaking,
} from "./echoProneDevice";

describe("isEchoProneDevice", () => {
  it("treats a phone as echo-prone", () => {
    // The reported failure: one "hi, can you hear me?" on a phone speaker, and
    // the transcript fills with turns nobody spoke.
    expect(isEchoProneDevice({ coarsePointer: true, viewportWidth: 390 })).toBe(true);
  });

  it("leaves a desktop alone", () => {
    expect(isEchoProneDevice({ coarsePointer: false, viewportWidth: 1440 })).toBe(false);
  });

  it("does not punish a touchscreen laptop", () => {
    // Fine pointer means a mouse, which means a real computer: speakers far
    // enough away and a better microphone.
    expect(isEchoProneDevice({ coarsePointer: false, viewportWidth: 390 })).toBe(false);
  });

  it("treats a tablet at the boundary as echo-prone", () => {
    expect(isEchoProneDevice({ coarsePointer: true, viewportWidth: ECHO_PRONE_MAX_VIEWPORT })).toBe(
      true,
    );
    expect(
      isEchoProneDevice({ coarsePointer: true, viewportWidth: ECHO_PRONE_MAX_VIEWPORT + 1 }),
    ).toBe(false);
  });

  it("assumes echo-prone when the width is unknown but the pointer is coarse", () => {
    expect(isEchoProneDevice({ coarsePointer: true, viewportWidth: Number.NaN })).toBe(true);
  });
});

describe("resolveInterruptWhileSpeaking", () => {
  it("closes the microphone on an echo-prone device whatever the setting says", () => {
    expect(resolveInterruptWhileSpeaking({ setting: true, echoProne: true })).toBe(false);
  });

  it("honours the setting everywhere else", () => {
    expect(resolveInterruptWhileSpeaking({ setting: true, echoProne: false })).toBe(true);
    expect(resolveInterruptWhileSpeaking({ setting: false, echoProne: false })).toBe(false);
  });
});
