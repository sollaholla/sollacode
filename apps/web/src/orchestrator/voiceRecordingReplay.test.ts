import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  describeRecordingCoverage,
  expandRecordedFrame,
  type VoiceRecording,
} from "./testing/recordingFormat";
import { readRecordings } from "./testing/liveProvider";
import {
  describeVoiceInvariantViolations,
  findVoiceInvariantViolations,
} from "./testing/voiceInvariants";
import { openVoiceScenario } from "./testing/voiceScenario";

/**
 * Replays real provider conversations through the real session.
 *
 * These fixtures were recorded from the live provider by
 * `voiceLiveProvider.test.ts`; this runs them offline on every test run, so
 * the exact frame order a provider produced stays a regression test long after
 * the run that captured it. When the provider changes its sequence, re-record
 * and the difference shows up here rather than on someone's phone.
 *
 * Each recording is also put through the degraded variants that a network and
 * a phone actually produce: the last frames lost, and the audio clock frozen
 * partway. Both are cases where a real conversation stops behaving like the
 * recorded one, and both are where the session used to get stuck.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const recordings = await readRecordings();

describe("recorded provider conversations", () => {
  it("has at least one recording to replay", () => {
    // A suite that silently tests nothing is worse than one that fails: this
    // is the line that notices the fixtures went missing.
    expect(recordings.length).toBeGreaterThan(0);
  });

  for (const { name, json } of recordings) {
    const recording = json as VoiceRecording;

    describe(name, () => {
      it("covers a full spoken response", () => {
        expect(describeRecordingCoverage(recording).reason).toBe("covers a full spoken response");
      });

      it("plays through to listening", async () => {
        vi.useFakeTimers();
        const scenario = await openVoiceScenario({ interruptWhileSpeaking: false });
        for (const frame of recording.frames) {
          await scenario.deliver(expandRecordedFrame(frame));
        }
        await scenario.advance(20_000);

        expect(scenario.session.state).toBe("listening");
        const violations = findVoiceInvariantViolations(scenario.timeline, { halfDuplex: true });
        expect(describeVoiceInvariantViolations(violations)).toBe("no violations");
      });

      it("recovers when the connection drops before the closing frames", async () => {
        // A phone changing network mid-reply: the audio arrived, the frames
        // that end the response never did.
        vi.useFakeTimers();
        const scenario = await openVoiceScenario({ interruptWhileSpeaking: false });
        const upToLastAudio = recording.frames.filter(
          (frame) => frame.audioBytes !== undefined || frame.frame.type === "response.created",
        );
        for (const frame of upToLastAudio) {
          await scenario.deliver(expandRecordedFrame(frame));
        }
        await scenario.advance(60_000);

        expect(scenario.session.state).toBe("listening");
      });

      it("recovers when the phone suspends the audio clock partway through", async () => {
        vi.useFakeTimers();
        const scenario = await openVoiceScenario({ interruptWhileSpeaking: false });
        const half = Math.floor(recording.frames.length / 2);
        for (const [index, frame] of recording.frames.entries()) {
          await scenario.deliver(expandRecordedFrame(frame));
          if (index === half) scenario.freezeAudioClock();
        }
        await scenario.advance(60_000);

        expect(scenario.session.state).toBe("listening");
        const violations = findVoiceInvariantViolations(scenario.timeline, { halfDuplex: true });
        expect(describeVoiceInvariantViolations(violations)).toBe("no violations");
      });
    });
  }
});
