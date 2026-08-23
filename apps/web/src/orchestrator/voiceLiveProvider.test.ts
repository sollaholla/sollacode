import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  mintLiveClientSecret,
  readLiveApiKey,
  recordLiveTurn,
  writeRecording,
} from "./testing/liveProvider";
import {
  describeRecordingCoverage,
  expandRecordedFrame,
  type VoiceRecording,
} from "./testing/recordingFormat";
import {
  describeVoiceInvariantViolations,
  findVoiceInvariantViolations,
} from "./testing/voiceInvariants";
import { openVoiceScenario } from "./testing/voiceScenario";
import { DEFAULT_XAI_REALTIME_MODEL } from "@t3tools/contracts";

/**
 * The live half of the harness: one real conversation with the provider.
 *
 * Everything else in this suite replays frames somebody wrote down, which is
 * only as good as those frames still being what the provider sends. This
 * checks that, records what came back as a fixture, and then feeds it straight
 * through the real session to confirm the state machine survives the actual
 * sequence rather than the remembered one.
 *
 * Skipped unless a key is present, so the default suite stays offline and
 * deterministic. Run it deliberately:
 *
 *     T3_LIVE_VOICE=1 npx vitest run apps/web/src/orchestrator/voiceLiveProvider.test.ts
 *
 * The key is used only to mint an ephemeral secret against xAI. Recordings
 * carry provider frames with the audio replaced by byte counts, so nothing
 * written here contains a credential or a recorded voice.
 */

const enabled = process.env.T3_LIVE_VOICE === "1";
/** `describe.skip` rather than a runtime guard, so a skip is reported as one. */
const describeLive = enabled ? describe : describe.skip;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describeLive("live provider conformance", () => {
  it("records a real spoken response and replays it through the session", async () => {
    const apiKey = await readLiveApiKey();
    if (apiKey === null) {
      throw new Error(
        "T3_LIVE_VOICE=1 but no xAI key was found. Set XAI_API_KEY, or configure one in Settings → Orchestrator.",
      );
    }

    const model = process.env.XAI_REALTIME_MODEL?.trim() || DEFAULT_XAI_REALTIME_MODEL;
    const prompt = "Say hello in one short sentence.";
    const clientSecret = await mintLiveClientSecret(apiKey);
    const turn = await recordLiveTurn({ clientSecret, model, prompt });

    const recording: VoiceRecording = {
      provider: "xai",
      model,
      recordedAt: new Date().toISOString(),
      prompt,
      frames: turn.frames,
    };

    // A recording with no audio or no completed response would replay green
    // while touching none of the state machine, which reads as coverage and
    // is not.
    const coverage = describeRecordingCoverage(recording);
    expect(coverage.reason).toBe("covers a full spoken response");

    await writeRecording(`${recording.provider}-${model}.json`, recording);

    // The whole point: the real sequence, through the real session.
    vi.useFakeTimers();
    const scenario = await openVoiceScenario({ interruptWhileSpeaking: false });
    for (const frame of turn.frames) {
      // Expanded, not passed through: an audio frame replays as silence of
      // the recorded length, so playback lasts exactly as long as it did.
      await scenario.deliver(expandRecordedFrame(frame));
    }
    await scenario.advance(20_000);

    const violations = findVoiceInvariantViolations(scenario.timeline, { halfDuplex: true });
    expect(describeVoiceInvariantViolations(violations)).toBe("no violations");
    expect(scenario.session.state).toBe("listening");
  });
});
