import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerPrimaryActions, formatPushToTalkActionLabel } from "./ComposerPrimaryActions";

const renderActions = (overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {}) =>
  renderToStaticMarkup(
    <ComposerPrimaryActions
      compact={false}
      pendingAction={null}
      isRunning={false}
      showPlanFollowUpPrompt={false}
      promptHasText
      isSendBusy={false}
      sendDisabledReason={null}
      isConnecting={false}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent
      pushToTalkStatus={null}
      pushToTalkDisabled={false}
      pushToTalkDisabledReason={null}
      onPushToTalkStart={vi.fn()}
      onPushToTalkStop={vi.fn()}
      onPreviousPendingQuestion={vi.fn()}
      onInterrupt={vi.fn()}
      onImplementPlanInNewThread={vi.fn()}
      {...overrides}
    />,
  );

describe("composer push-to-talk action", () => {
  it("renders the microphone immediately before the send button", () => {
    const markup = renderActions();

    const microphoneIndex = markup.indexOf(
      'aria-label="Unmute microphone — hold to record (Cmd+D)"',
    );
    const sendIndex = markup.indexOf('aria-label="Send message"');
    expect(microphoneIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(microphoneIndex);
  });

  it("announces recording and disables send until transcription completes", () => {
    const markup = renderActions({
      pushToTalkStatus: "recording",
      pushToTalkDisabled: true,
    });

    expect(markup).toContain(
      'aria-label="Mute microphone — release to transcribe and send (Cmd+D)"',
    );
    expect(markup).toContain('title="Mute microphone — release to transcribe and send (Cmd+D)"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  it("truthfully labels model loading and disables both actions", () => {
    const markup = renderActions({
      pushToTalkStatus: "loading",
      pushToTalkDisabled: true,
    });

    expect(markup).toContain('aria-label="Loading local transcription model (Cmd+D)"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  it("keeps the microphone visible and focusable beside Stop while the agent is working", () => {
    const markup = renderActions({
      isRunning: true,
      pushToTalkDisabled: true,
      pushToTalkDisabledReason: "Microphone unavailable while the agent is working",
    });

    const microphoneIndex = markup.indexOf(
      'aria-label="Microphone unavailable while the agent is working (Cmd+D)"',
    );
    const stopIndex = markup.indexOf('aria-label="Stop generation"');
    expect(microphoneIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(microphoneIndex);
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).not.toContain('disabled=""');
  });

  it("shows an enabled Send while processing whenever the composer has text", () => {
    const markup = renderActions({
      isRunning: true,
      promptHasText: true,
      sendWhileRunning: true,
    });

    expect(markup).toContain('aria-label="Send message"');
    expect(markup).not.toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Send message" disabled=""');
  });

  it("keeps Stop while processing when the composer text is empty", () => {
    const markup = renderActions({
      isRunning: true,
      promptHasText: false,
      sendWhileRunning: false,
      hasSendableContent: false,
    });

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Send message"');
  });

  it("uses the platform shortcut in every state-aware action label", () => {
    expect(formatPushToTalkActionLabel(null, "MacIntel")).toBe(
      "Unmute microphone — hold to record (Cmd+D)",
    );
    expect(formatPushToTalkActionLabel("recording", "MacIntel")).toBe(
      "Mute microphone — release to transcribe and send (Cmd+D)",
    );
    expect(formatPushToTalkActionLabel("transcribing", "Win32")).toBe(
      "Transcribing voice message (Ctrl+D)",
    );
    expect(
      formatPushToTalkActionLabel(
        null,
        "MacIntel",
        "Microphone unavailable while the agent is working",
      ),
    ).toBe("Microphone unavailable while the agent is working (Cmd+D)");
  });
});
