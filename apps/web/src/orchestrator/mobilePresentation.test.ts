import { describe, expect, it } from "vite-plus/test";

import {
  MOBILE_ORB_MAX_PX,
  MOBILE_ORB_MIN_PX,
  computeMobileOrbDiameter,
  createVoiceSpeakerResolver,
  shouldShowVoiceOverlay,
  computeMobileOrbScale,
  describeMobileVoice,
  resolveVoiceSpeaker,
  voiceOrbIntensity,
} from "./mobilePresentation";

describe("describeMobileVoice", () => {
  it("offers to start when idle and connected", () => {
    const view = describeMobileVoice({ state: "idle", canStart: true, error: null });
    expect(view.title).toBe("Tap to talk");
    expect(view.action).toBe("start");
    expect(view.live).toBe(false);
  });

  it("says what to do when there is nothing to connect to", () => {
    // On a phone this is the whole diagnosis: there is no sidebar to inspect.
    const view = describeMobileVoice({ state: "idle", canStart: false, error: null });
    expect(view.title).toBe("Not connected");
    expect(view.hint).toContain("Connect to an environment");
  });

  it("names the wait while connecting so it does not read as a dead button", () => {
    const view = describeMobileVoice({ state: "connecting", canStart: true, error: null });
    expect(view.title).toBe("Connecting");
    expect(view.hint.length).toBeGreaterThan(0);
    expect(view.live).toBe(true);
  });

  it("tells the user they can interrupt while it is speaking", () => {
    const view = describeMobileVoice({ state: "speaking", canStart: true, error: null });
    expect(view.hint).toContain("interrupt");
    expect(view.action).toBe("stop");
  });

  it("does not promise talk-over interruption when handheld echo protection disables it", () => {
    const view = describeMobileVoice({
      state: "speaking",
      canStart: true,
      canInterrupt: false,
      error: null,
    });
    expect(view.hint).toContain("reopens when it finishes");
    expect(view.hint).not.toContain("interrupt");
  });

  it("surfaces why voice stopped rather than a bare error", () => {
    const view = describeMobileVoice({
      state: "idle",
      canStart: true,
      error: "Voice stopped after 30 seconds of silence.",
    });
    expect(view.title).toBe("Voice stopped");
    expect(view.hint).toBe("Voice stopped after 30 seconds of silence.");
    expect(view.action).toBe("start");
  });

  it("keeps a live session usable when an in-band error was reported", () => {
    // The API reports benign conditions in band; the session below is fine, and
    // saying "error" would send someone on a walk back to their desk.
    const view = describeMobileVoice({
      state: "listening",
      canStart: true,
      error: "conversation already has an active response",
    });
    expect(view.title).toBe("Listening");
    expect(view.live).toBe(true);
  });

  it("acknowledges a committed turn while the first answer is still silent", () => {
    const view = describeMobileVoice({
      state: "listening",
      canStart: true,
      working: true,
      error: null,
    });
    expect(view.title).toBe("Heard you — thinking");
    expect(view.hint).toContain("add something");
    expect(view.action).toBe("stop");
    expect(view.live).toBe(true);
  });

  it("does not invite interruption when handheld echo protection closed the microphone", () => {
    const view = describeMobileVoice({
      state: "listening",
      canStart: true,
      canInterrupt: false,
      working: true,
      error: null,
    });
    expect(view.title).toBe("Heard you — thinking");
    expect(view.hint).toContain("microphone reopens");
    expect(view.hint).not.toContain("add something");
  });

  it("always names the action, not the state, for assistive technology", () => {
    for (const state of ["idle", "connecting", "listening", "speaking", "error"] as const) {
      const view = describeMobileVoice({ state, canStart: true, error: null });
      expect(view.actionLabel).toMatch(/voice|connecting/i);
    }
  });
});

describe("computeMobileOrbDiameter", () => {
  it("scales with the screen but stays thumb-sized on a small one", () => {
    expect(computeMobileOrbDiameter(320)).toBe(MOBILE_ORB_MIN_PX);
    expect(computeMobileOrbDiameter(800)).toBe(MOBILE_ORB_MAX_PX);
    expect(computeMobileOrbDiameter(500)).toBe(250);
  });
});

describe("computeMobileOrbScale", () => {
  it("stays still when nothing is live", () => {
    expect(computeMobileOrbScale(1, false)).toBe(1);
  });

  it("swells with the level but never enough to jump the layout", () => {
    expect(computeMobileOrbScale(0, true)).toBe(1);
    expect(computeMobileOrbScale(1, true)).toBeCloseTo(1.18);
    // A level outside 0..1 must not be able to blow the orb through its container.
    expect(computeMobileOrbScale(9, true)).toBeCloseTo(1.18);
    expect(computeMobileOrbScale(-3, true)).toBe(1);
  });
});

describe("shouldShowVoiceOverlay", () => {
  const phone = { coarsePointer: true, viewportWidth: 390, isDesktopApp: false };

  it("covers the screen on a handheld, which has nowhere else to show the state", () => {
    expect(shouldShowVoiceOverlay(phone)).toBe(true);
  });

  it("never covers the desktop app, which has the floating bubble", () => {
    // Taking the whole screen to say "the microphone is open" removes the work
    // the user is talking about.
    expect(shouldShowVoiceOverlay({ ...phone, isDesktopApp: true })).toBe(false);
    expect(
      shouldShowVoiceOverlay({ coarsePointer: false, viewportWidth: 1440, isDesktopApp: true }),
    ).toBe(false);
  });

  it("stays away from a desktop browser, narrow window or not", () => {
    expect(
      shouldShowVoiceOverlay({ coarsePointer: false, viewportWidth: 1440, isDesktopApp: false }),
    ).toBe(false);
    // A narrowed window is still a mouse-driven desktop.
    expect(
      shouldShowVoiceOverlay({ coarsePointer: false, viewportWidth: 500, isDesktopApp: false }),
    ).toBe(false);
  });

  it("does not treat a big touchscreen as a handheld", () => {
    expect(
      shouldShowVoiceOverlay({ coarsePointer: true, viewportWidth: 1400, isDesktopApp: false }),
    ).toBe(false);
  });

  it("assumes a handheld when the width is unknown but the pointer is coarse", () => {
    expect(
      shouldShowVoiceOverlay({
        coarsePointer: true,
        viewportWidth: Number.NaN,
        isDesktopApp: false,
      }),
    ).toBe(true);
  });
});

describe("resolveVoiceSpeaker", () => {
  it("colours the assistant's own voice as the assistant, not the user", () => {
    // Playback comes back through the microphone on a phone, so a tie has to
    // resolve to the assistant — colouring that as the user would be wrong in
    // exactly the moment that is hardest to read.
    expect(resolveVoiceSpeaker({ state: "listening", micLevel: 0.9, assistantLevel: 0.9 })).toBe(
      "assistant",
    );
    expect(resolveVoiceSpeaker({ state: "speaking", micLevel: 0, assistantLevel: 0 })).toBe(
      "assistant",
    );
  });

  it("shows the user when they are the one making sound", () => {
    expect(resolveVoiceSpeaker({ state: "listening", micLevel: 0.4, assistantLevel: 0 })).toBe(
      "user",
    );
  });

  it("separates an open microphone from one that is hearing something", () => {
    // The old orb used one colour at two opacities for both, so nothing about
    // it answered "is it hearing me?".
    expect(resolveVoiceSpeaker({ state: "listening", micLevel: 0.01, assistantLevel: 0 })).toBe(
      "idle",
    );
  });

  it("shows waiting while the assistant works in silence", () => {
    expect(
      resolveVoiceSpeaker({
        state: "listening",
        micLevel: 0,
        assistantLevel: 0,
        working: true,
      }),
    ).toBe("waiting");
  });

  it("reports connecting and idle from the session state alone", () => {
    expect(resolveVoiceSpeaker({ state: "connecting", micLevel: 1, assistantLevel: 1 })).toBe(
      "connecting",
    );
    expect(resolveVoiceSpeaker({ state: "idle", micLevel: 1, assistantLevel: 1 })).toBe("idle");
    expect(resolveVoiceSpeaker({ state: "error", micLevel: 0, assistantLevel: 0 })).toBe("idle");
  });
});

describe("createVoiceSpeakerResolver", () => {
  it("holds the assistant icon across inter-word level dips", () => {
    const resolve = createVoiceSpeakerResolver(600);
    expect(resolve({ state: "listening", micLevel: 0, assistantLevel: 0.4 }, 1_000)).toBe(
      "assistant",
    );
    expect(resolve({ state: "listening", micLevel: 0, assistantLevel: 0 }, 1_300)).toBe(
      "assistant",
    );
    expect(resolve({ state: "listening", micLevel: 0, assistantLevel: 0 }, 1_599)).toBe(
      "assistant",
    );
    expect(resolve({ state: "listening", micLevel: 0, assistantLevel: 0 }, 1_600)).toBe("idle");
  });

  it("does not delay an explicit session stop or working state", () => {
    const resolve = createVoiceSpeakerResolver(600);
    expect(resolve({ state: "speaking", micLevel: 0, assistantLevel: 0 }, 1_000)).toBe("assistant");
    expect(resolve({ state: "idle", micLevel: 0, assistantLevel: 0 }, 1_001)).toBe("idle");
    expect(
      resolve({ state: "listening", micLevel: 0, assistantLevel: 0, working: true }, 1_002),
    ).toBe("waiting");
  });
});

describe("voiceOrbIntensity", () => {
  it("follows whichever side is talking", () => {
    expect(voiceOrbIntensity({ speaker: "user", micLevel: 0.6, assistantLevel: 0.1 })).toBeCloseTo(
      0.6,
    );
    expect(
      voiceOrbIntensity({ speaker: "assistant", micLevel: 0.6, assistantLevel: 0.3 }),
    ).toBeCloseTo(0.3);
  });

  it("reports nothing for the silent states, which supply their own motion", () => {
    expect(voiceOrbIntensity({ speaker: "waiting", micLevel: 0.9, assistantLevel: 0.9 })).toBe(0);
    expect(voiceOrbIntensity({ speaker: "idle", micLevel: 0.9, assistantLevel: 0.9 })).toBe(0);
  });

  it("clamps a nonsense level rather than blowing the orb up", () => {
    expect(voiceOrbIntensity({ speaker: "user", micLevel: 4, assistantLevel: 0 })).toBe(1);
    expect(voiceOrbIntensity({ speaker: "user", micLevel: Number.NaN, assistantLevel: 0 })).toBe(0);
  });
});
