import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  describeVoiceInvariantViolations,
  findVoiceInvariantViolations,
  type VoiceTimelineSample,
} from "./testing/voiceInvariants";
import { openVoiceScenario, type VoiceScenario } from "./testing/voiceScenario";

/**
 * Conformance: the rules a voice session must keep whatever the provider does.
 *
 * Every scenario here drives the real session and then holds its whole
 * recorded timeline to the same invariants, rather than asserting the one
 * thing the scenario was written to check. That is deliberate — the bug this
 * suite was built around was a session stuck on "Speaking" with the microphone
 * shut, and no existing test failed, because no existing test thought to ask
 * whether the session could still hear anyone.
 *
 * The frame sequences are the ones a real provider produces, including the
 * degraded ones: a response that ends without its audio-done frame, a stray
 * delta after it, and a phone that suspends the audio clock mid-reply.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const expectNoViolations = (
  timeline: ReadonlyArray<VoiceTimelineSample>,
  options: { readonly halfDuplex?: boolean } = {},
) => {
  const violations = findVoiceInvariantViolations(timeline, options);
  expect(describeVoiceInvariantViolations(violations)).toBe("no violations");
};

/** Speaks one reply: the frames a provider sends for an ordinary answer. */
const speakReply = async (scenario: VoiceScenario, chunks = 3) => {
  await scenario.deliver({ type: "response.created" });
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    await scenario.deliver({ type: "response.output_audio.delta", delta: "AAAAAAAAAAA=" });
  }
};

describe("voice conformance", () => {
  it("holds every rule across an ordinary exchange", async () => {
    vi.useFakeTimers();
    const scenario = await openVoiceScenario({ interruptWhileSpeaking: false });

    await scenario.deliver({ type: "input_audio_buffer.speech_started" });
    await scenario.advance(400);
    await scenario.deliver({ type: "input_audio_buffer.speech_stopped" });
    await scenario.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "how's it going",
    });

    await speakReply(scenario);
    await scenario.deliver({ type: "response.output_audio.done" });
    await scenario.deliver({ type: "response.done" });
    await scenario.advance(3_000);

    expect(scenario.session.state).toBe("listening");
    expectNoViolations(scenario.timeline, { halfDuplex: true });
  });

  it("recovers when the response ends without its audio-done frame", async () => {
    vi.useFakeTimers();
    const scenario = await openVoiceScenario({ interruptWhileSpeaking: false });

    await speakReply(scenario);
    // Cancelled, errored, or simply dropped: `response.done` arrives and the
    // audio-done frame never does.
    await scenario.deliver({ type: "response.done" });
    await scenario.advance(3_000);

    expect(scenario.session.state).toBe("listening");
    expectNoViolations(scenario.timeline, { halfDuplex: true });
  });

  it("recovers when a stray audio delta lands after the audio-done frame", async () => {
    vi.useFakeTimers();
    const scenario = await openVoiceScenario({ interruptWhileSpeaking: false });

    await speakReply(scenario);
    await scenario.deliver({ type: "response.output_audio.done" });
    await scenario.deliver({ type: "response.output_audio.delta", delta: "AAAAAAAAAAA=" });
    await scenario.deliver({ type: "response.done" });
    await scenario.advance(3_000);

    expect(scenario.session.state).toBe("listening");
    expectNoViolations(scenario.timeline, { halfDuplex: true });
  });

  it("recovers when the phone suspends the audio clock mid-reply", async () => {
    // The reported failure. A locked screen, an incoming call or an output
    // route change suspends the AudioContext; buffers scheduled into it never
    // reach their end time, so the `ended` events the session waits on simply
    // never arrive. Wall time keeps moving, which is the only thing left that
    // can notice.
    vi.useFakeTimers();
    const scenario = await openVoiceScenario({ interruptWhileSpeaking: false });

    await speakReply(scenario);
    await scenario.deliver({ type: "response.output_audio.done" });
    await scenario.deliver({ type: "response.done" });
    scenario.freezeAudioClock();

    await scenario.advance(20_000);

    expect(scenario.session.state).toBe("listening");
    expectNoViolations(scenario.timeline, { halfDuplex: true });
  });

  it("holds the rules through a barge-in", async () => {
    vi.useFakeTimers();
    const scenario = await openVoiceScenario();

    await speakReply(scenario);
    await scenario.deliver({ type: "input_audio_buffer.speech_started" });
    await scenario.advance(300);
    await scenario.deliver({ type: "input_audio_buffer.speech_stopped" });
    await scenario.deliver({ type: "response.done" });
    await scenario.advance(3_000);

    expectNoViolations(scenario.timeline);
  });

  it("holds the rules when a reply is followed immediately by another", async () => {
    vi.useFakeTimers();
    const scenario = await openVoiceScenario({ interruptWhileSpeaking: false });

    await speakReply(scenario);
    await scenario.deliver({ type: "response.output_audio.done" });
    await scenario.deliver({ type: "response.done" });
    await scenario.advance(500);
    await speakReply(scenario, 2);
    await scenario.deliver({ type: "response.output_audio.done" });
    await scenario.deliver({ type: "response.done" });
    await scenario.advance(3_000);

    expect(scenario.session.state).toBe("listening");
    expectNoViolations(scenario.timeline, { halfDuplex: true });
  });
});
