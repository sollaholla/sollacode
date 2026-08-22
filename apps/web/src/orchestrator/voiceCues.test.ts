import { describe, expect, it, vi } from "vite-plus/test";

import {
  createVoiceCuePlayer,
  cueClass,
  cueDurationMs,
  DEFAULT_VOICE_CUE_POLICY,
  mayPlayCue,
  playCueOnce,
  resolveVoiceCuePolicy,
  shouldPlayThinkingCue,
  THINKING_PULSE_INTERVAL_MS,
  type CueAudioContextLike,
  type VoiceCue,
} from "./voiceCues";

function fakeContext() {
  const started: number[] = [];
  const gains: number[] = [];
  const context: CueAudioContextLike = {
    currentTime: 0,
    destination: {},
    createOscillator: () => ({
      frequency: { setValueAtTime: (value: number) => started.push(value) },
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    }),
    createGain: () => ({
      gain: {
        setValueAtTime: (value: number) => gains.push(value),
        linearRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
    }),
  };
  return { context, started, gains };
}

function playedSteps(cue: VoiceCue): number[] {
  const { context, started } = fakeContext();
  createVoiceCuePlayer(context).play(cue);
  return started;
}

describe("the cue vocabulary", () => {
  it("reserves rising for mic-open and falling for accepted", () => {
    // Contour carries the meaning: register is the first thing a pocket or a
    // cheap speaker eats, so no two cues may share a contour with different
    // meanings. Rising = you may act; falling = closed, success.
    expect(playedSteps("mic-open")).toEqual([660, 880]);
    expect(playedSteps("accepted")).toEqual([880, 660]);
  });

  it("marks both negative cues as knocks on a single pitch", () => {
    // Repetition, not direction, is what marks the negative family — a knock
    // cannot be mistaken for `accepted` however bad the speaker.
    const dropped = playedSteps("dropped");
    const deaf = playedSteps("deaf");
    expect(new Set(dropped).size).toBe(1);
    expect(new Set(deaf).size).toBe(1);
    // `deaf` is the graver sibling: lower and slower, never merely different.
    expect(deaf[0]).toBeLessThan(dropped[0] ?? Number.NaN);
    expect(cueDurationMs("deaf")).toBeGreaterThan(cueDurationMs("dropped") * 2);
  });

  it("keeps the heard click short enough to land mid-sentence", () => {
    // It fires while the user is talking, so it must be over before they
    // notice it started.
    expect(playedSteps("heard")).toHaveLength(1);
    expect(cueDurationMs("heard")).toBeLessThanOrEqual(30);
  });
});

describe("createVoiceCuePlayer", () => {
  it("pulses while thinking and stops when told", () => {
    vi.useFakeTimers();
    try {
      const { context, started } = fakeContext();
      const player = createVoiceCuePlayer(context);
      player.startThinking();
      // Leave the acceptance tone a clean first beat; fast answers never need
      // to make a waiting sound at all.
      expect(started).toHaveLength(0);
      vi.advanceTimersByTime(THINKING_PULSE_INTERVAL_MS * 2);
      expect(started).toHaveLength(2);
      player.stopThinking();
      vi.advanceTimersByTime(THINKING_PULSE_INTERVAL_MS * 3);
      expect(started).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stack thinking loops", () => {
    vi.useFakeTimers();
    try {
      const { context, started } = fakeContext();
      const player = createVoiceCuePlayer(context);
      player.startThinking();
      player.startThinking();
      vi.advanceTimersByTime(THINKING_PULSE_INTERVAL_MS);
      expect(started).toHaveLength(1);
      player.stopThinking();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op without Web Audio", () => {
    const player = createVoiceCuePlayer(null);
    expect(() => {
      player.play("mic-open");
      player.startThinking();
      player.stopThinking();
      player.dispose();
    }).not.toThrow();
  });

  it("consults the policy on every play, not at construction", () => {
    // Turning cues off in settings must land mid-session — a session can stay
    // up for hours, and "it applies next time" is no answer to a mute switch.
    const { context, started } = fakeContext();
    let enabled = true;
    const player = createVoiceCuePlayer(context, () => ({ enabled, volume: 1 }));
    player.play("mic-open");
    enabled = false;
    player.play("mic-open");
    expect(started).toHaveLength(2);
  });

  it("scales the designed gain by the policy volume", () => {
    const { context, gains } = fakeContext();
    const half = createVoiceCuePlayer(context, () => ({ enabled: true, volume: 0.5 }));
    half.play("accepted");
    const { context: fullContext, gains: fullGains } = fakeContext();
    createVoiceCuePlayer(fullContext).play("accepted");
    expect(gains).toHaveLength(fullGains.length);
    gains.forEach((gain, index) => {
      expect(gain).toBeCloseTo((fullGains[index] ?? 0) / 2, 10);
    });
  });

  it("treats zero volume as off", () => {
    const { context, started } = fakeContext();
    createVoiceCuePlayer(context, () => ({ enabled: true, volume: 0 })).play("deaf");
    expect(started).toHaveLength(0);
  });
});

describe("resolveVoiceCuePolicy", () => {
  it("maps the persisted percent onto a 0..1 multiplier", () => {
    expect(resolveVoiceCuePolicy({ soundCues: true, soundCueVolume: 100 })).toEqual(
      DEFAULT_VOICE_CUE_POLICY,
    );
    expect(resolveVoiceCuePolicy({ soundCues: false, soundCueVolume: 40 })).toEqual({
      enabled: false,
      volume: 0.4,
    });
  });

  it("clamps whatever the storage held", () => {
    // Settings files come from disk; a hand-edited or stale value must not
    // become a cue at 12x volume in someone's ear.
    expect(resolveVoiceCuePolicy({ soundCues: true, soundCueVolume: 1_200 }).volume).toBe(1);
    expect(resolveVoiceCuePolicy({ soundCues: true, soundCueVolume: -5 }).volume).toBe(0);
  });
});

describe("playCueOnce", () => {
  function installOnceAudioContext() {
    const created: Array<{ closed: boolean; tones: number[] }> = [];
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function AudioContextMock(this: Record<string, unknown>) {
        const record = { closed: false, tones: [] as number[] };
        created.push(record);
        this.state = "running";
        this.currentTime = 0;
        this.destination = {};
        this.createOscillator = () => ({
          frequency: { setValueAtTime: (value: number) => record.tones.push(value) },
          connect: () => undefined,
          start: () => undefined,
          stop: () => undefined,
        });
        this.createGain = () => ({
          gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined },
          connect: () => undefined,
        });
        this.resume = async () => undefined;
        this.close = async () => {
          record.closed = true;
        };
      }),
    );
    return created;
  }

  it("plays the tone on a context of its own and closes it", async () => {
    vi.useFakeTimers();
    try {
      const created = installOnceAudioContext();
      const played = playCueOnce("mic-open");
      await vi.advanceTimersByTimeAsync(cueDurationMs("mic-open") + 50);
      await played;
      expect(created).toHaveLength(1);
      expect(created[0]?.tones).toEqual([660, 880]);
      expect(created[0]?.closed).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not even open a context when cues are off", async () => {
    // The policy check must come first: an AudioContext is a real resource on
    // a phone, and "disabled" that still allocates one is not disabled.
    const created = installOnceAudioContext();
    try {
      await playCueOnce("mic-open", { enabled: false, volume: 1 });
      expect(created).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("mayPlayCue", () => {
  it("gates by class: ambient cues yield to everyone", () => {
    // The rule the whole feature rests on: a cue is a courtesy, and
    // interrupting someone mid-sentence to say "I'm listening" is absurd.
    expect(cueClass("mic-open")).toBe("ambient");
    expect(cueClass("working")).toBe("ambient");
    expect(mayPlayCue({ cue: "mic-open", userSpeaking: true, assistantAudible: false })).toBe(
      false,
    );
    expect(mayPlayCue({ cue: "working", userSpeaking: false, assistantAudible: true })).toBe(false);
    expect(mayPlayCue({ cue: "mic-open", userSpeaking: false, assistantAudible: false })).toBe(
      true,
    );
  });

  it("lets confirmations land over the user but never over the assistant", () => {
    // They are *about* the user's speech: `accepted` fires at the instant the
    // turn closed, `heard` exists to land mid-sentence.
    expect(cueClass("accepted")).toBe("confirmation");
    expect(cueClass("heard")).toBe("confirmation");
    expect(mayPlayCue({ cue: "accepted", userSpeaking: true, assistantAudible: false })).toBe(true);
    expect(mayPlayCue({ cue: "heard", userSpeaking: true, assistantAudible: false })).toBe(true);
    expect(mayPlayCue({ cue: "accepted", userSpeaking: false, assistantAudible: true })).toBe(
      false,
    );
  });

  it("lets corrective cues interrupt anything", () => {
    // `dropped` fires precisely because the user talked over a reply, so the
    // moment it is true is the moment audio is playing; `deaf` is someone
    // talking to a session that cannot hear them, worth any interruption.
    expect(cueClass("dropped")).toBe("corrective");
    expect(cueClass("deaf")).toBe("corrective");
    expect(mayPlayCue({ cue: "dropped", userSpeaking: false, assistantAudible: true })).toBe(true);
    expect(mayPlayCue({ cue: "deaf", userSpeaking: true, assistantAudible: true })).toBe(true);
  });
});

describe("shouldPlayThinkingCue", () => {
  it("sounds only while the user waits with nothing to listen to", () => {
    expect(
      shouldPlayThinkingCue({
        awaitingUserAnswer: true,
        assistantAudible: false,
        userSpeaking: false,
      }),
    ).toBe(true);
  });

  it("stops the moment the answer becomes audible", () => {
    // The answer is its own feedback; a pulse under it is noise.
    expect(
      shouldPlayThinkingCue({
        awaitingUserAnswer: true,
        assistantAudible: true,
        userSpeaking: false,
      }),
    ).toBe(false);
  });

  it("never sounds for background work", () => {
    // A thread finishing is not the user waiting on a reply, and beeping
    // through housekeeping would turn every background task into an alarm.
    expect(
      shouldPlayThinkingCue({
        awaitingUserAnswer: false,
        assistantAudible: false,
        userSpeaking: false,
      }),
    ).toBe(false);
  });

  it("never sounds under the user", () => {
    expect(
      shouldPlayThinkingCue({
        awaitingUserAnswer: true,
        assistantAudible: false,
        userSpeaking: true,
      }),
    ).toBe(false);
  });
});

describe("the waiting tone while the assistant works", () => {
  it("keeps sounding when the assistant spoke and went quiet mid-work", () => {
    // "Let me check that…" then silence: the window `awaitingUserAnswer`
    // describes has already closed, so without this the user hears a
    // finished-sounding sentence and starts talking into a busy session.
    expect(
      shouldPlayThinkingCue({
        awaitingUserAnswer: false,
        assistantAudible: false,
        userSpeaking: false,
        assistantWorking: true,
      }),
    ).toBe(true);
  });

  it("stays silent once the answer is actually coming out", () => {
    expect(
      shouldPlayThinkingCue({
        awaitingUserAnswer: false,
        assistantAudible: true,
        userSpeaking: false,
        assistantWorking: true,
      }),
    ).toBe(false);
  });

  it("never sounds under the user", () => {
    expect(
      shouldPlayThinkingCue({
        awaitingUserAnswer: true,
        assistantAudible: false,
        userSpeaking: true,
        assistantWorking: true,
      }),
    ).toBe(false);
  });

  it("stays silent when nothing is pending at all", () => {
    expect(
      shouldPlayThinkingCue({
        awaitingUserAnswer: false,
        assistantAudible: false,
        userSpeaking: false,
      }),
    ).toBe(false);
  });
});
