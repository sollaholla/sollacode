import { describe, expect, it, vi } from "vite-plus/test";

import {
  beginVoiceCaptureSystemAudioMute,
  shouldMuteSystemAudioForOrchestrator,
} from "./systemAudioMute";

describe("shouldMuteSystemAudioForOrchestrator", () => {
  it("mutes only while the live microphone is accepting the user's speech", () => {
    expect(
      shouldMuteSystemAudioForOrchestrator({ state: "listening", working: false, enabled: true }),
    ).toBe(true);
    expect(
      shouldMuteSystemAudioForOrchestrator({ state: "speaking", working: false, enabled: true }),
    ).toBe(false);
    expect(
      shouldMuteSystemAudioForOrchestrator({ state: "listening", working: true, enabled: true }),
    ).toBe(false);
    expect(
      shouldMuteSystemAudioForOrchestrator({ state: "listening", working: false, enabled: false }),
    ).toBe(false);
  });
});

describe("beginVoiceCaptureSystemAudioMute", () => {
  it("releases immediately and again after a late mute request completes", async () => {
    let finishMute: (() => void) | undefined;
    const setMuted = vi.fn((muted: boolean) => {
      if (!muted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishMute = resolve;
      });
    });

    const release = beginVoiceCaptureSystemAudioMute({ setMuted });
    release();
    finishMute?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(setMuted.mock.calls).toEqual([[true], [false], [false]]);
  });

  it("does not let a late old lease unmute a newer listening lease", async () => {
    const pending: Array<() => void> = [];
    const setMuted = vi.fn((muted: boolean) => {
      if (!muted) return Promise.resolve();
      return new Promise<void>((resolve) => pending.push(resolve));
    });
    let activeLease: object | null = null;

    const firstLease = {};
    activeLease = firstLease;
    const releaseFirst = beginVoiceCaptureSystemAudioMute({
      setMuted,
      superseded: () => activeLease !== null && activeLease !== firstLease,
    });
    activeLease = null;
    releaseFirst();

    const secondLease = {};
    activeLease = secondLease;
    const releaseSecond = beginVoiceCaptureSystemAudioMute({
      setMuted,
      superseded: () => activeLease !== null && activeLease !== secondLease,
    });

    pending[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(setMuted.mock.calls).toEqual([[true], [false], [true]]);

    pending[1]?.();
    await Promise.resolve();
    activeLease = null;
    releaseSecond();
    expect(setMuted.mock.calls).toEqual([[true], [false], [true], [false]]);
  });
});
