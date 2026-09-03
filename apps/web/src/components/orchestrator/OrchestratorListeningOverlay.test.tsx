import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { VoiceSessionState } from "../../orchestrator/realtimeSession";
import { VoiceOrb } from "./OrchestratorListeningOverlay";

/** No levels ever arrive, which is exactly the first-frame case under test. */
const noLevels = () => () => undefined;

function render(input: { state: VoiceSessionState; working?: boolean }) {
  return renderToStaticMarkup(
    <VoiceOrb
      state={input.state}
      {...(input.working === undefined ? {} : { working: input.working })}
      subscribeLevels={noLevels}
    />,
  );
}

describe("the overlay orb", () => {
  it("shows an open microphone while listening", () => {
    const markup = render({ state: "listening" });
    expect(markup).toContain('data-voice-speaker="idle"');
    // lucide renders its name onto the svg, which is what makes the icon —
    // the part of this the user actually asked for — assertable at all.
    expect(markup).toContain("lucide-mic");
  });

  it("shows the assistant's own icon and colour while it speaks", () => {
    const markup = render({ state: "speaking" });
    expect(markup).toContain('data-voice-speaker="assistant"');
    expect(markup).toContain("lucide-audio-lines");
    expect(markup).toContain('data-orb-tint="assistant"');
  });

  it("does not show an open microphone during a silent tool call", () => {
    // The reported complaint: the pause between "let me check that…" and the
    // answer looked identical to an open microphone, so the user talked into a
    // session that was not listening.
    const markup = render({ state: "listening", working: true });
    expect(markup).toContain('data-voice-speaker="waiting"');
    expect(markup).toContain("lucide-loader");
    expect(markup).not.toContain("lucide-mic ");
  });

  it("reads as connecting before the session is up", () => {
    // Seeded from the state rather than defaulting to idle: this is rendered
    // before any level has arrived, and connecting is when the overlay matters.
    const markup = render({ state: "connecting" });
    expect(markup).toContain('data-voice-speaker="connecting"');
    expect(markup).toContain('data-orb-tint="connecting"');
  });

  it("gives every speaker its own colour", () => {
    // The original complaint was one colour at two opacities for every state,
    // so the thing worth asserting is that no two of these render alike. Only
    // four are reachable without live levels; `user` is covered by
    // `resolveVoiceSpeaker`'s own tests.
    const cases: ReadonlyArray<{ state: VoiceSessionState; working?: boolean }> = [
      { state: "connecting" },
      { state: "speaking" },
      { state: "listening" },
      { state: "listening", working: true },
    ];
    const colours = cases.map((input) => {
      const markup = render(input);
      // The black hole paints its disk from the `--orb-outer` variable; that
      // is the colour the eye reads, so that is what must differ.
      return /--orb-outer:\s*([^;]+);/.exec(markup)?.[1];
    });
    expect(colours.every((colour) => colour !== undefined)).toBe(true);
    expect(new Set(colours).size).toBe(cases.length);
  });
});
