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

    expect(markup).toContain('aria-label="Mute microphone — release to transcribe (Cmd+D)"');
    expect(markup).toContain('title="Mute microphone — release to transcribe (Cmd+D)"');
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

  it("keeps Send disabled while a voice message is transcribing", () => {
    const markup = renderActions({
      pushToTalkStatus: "transcribing",
      pushToTalkDisabled: true,
    });

    expect(markup).toContain('aria-label="Transcribing voice message (Cmd+D)"');
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  it("keeps the microphone enabled beside Stop while the agent is working", () => {
    const markup = renderActions({
      isRunning: true,
      pushToTalkDisabled: false,
      pushToTalkDisabledReason: null,
    });

    const microphoneIndex = markup.indexOf(
      'aria-label="Unmute microphone — hold to record (Cmd+D)"',
    );
    const stopIndex = markup.indexOf('aria-label="Stop generation"');
    expect(microphoneIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(microphoneIndex);
    expect(markup).toContain('aria-disabled="false"');
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

  it("shows an immediate Apply changes action when composer settings differ", () => {
    const markup = renderActions({
      settingsUpdateLabel: "GPT-5.6-Sol with high effort · Plan mode",
      onApplySettings: vi.fn(),
    });

    expect(markup).toContain(
      'aria-label="Apply conversation changes: GPT-5.6-Sol with high effort · Plan mode"',
    );
    expect(markup).toContain(">Apply changes</span>");
  });

  it("uses an icon-only Apply action while running so composer tools do not get squished", () => {
    const markup = renderActions({
      isRunning: true,
      settingsUpdateLabel: "GPT-5.6-Sol with high effort · Plan mode",
      onApplySettings: vi.fn(),
    });

    expect(markup).toContain(
      'aria-label="Apply conversation changes: GPT-5.6-Sol with high effort · Plan mode"',
    );
    expect(markup).not.toContain(">Apply changes</span>");
    expect(markup).not.toContain(">Apply</span>");
    expect(markup).toContain("size-9 p-0 sm:size-8");
  });

  it("shows an interrupting state after Stop is pressed", () => {
    const markup = renderActions({
      isRunning: true,
      promptHasText: false,
      sendWhileRunning: false,
      hasSendableContent: false,
      isInterrupting: true,
    });

    expect(markup).toContain('aria-label="Stopping generation"');
    expect(markup).toContain('disabled=""');
  });

  it("uses the platform shortcut in every state-aware action label", () => {
    expect(formatPushToTalkActionLabel(null, "MacIntel")).toBe(
      "Unmute microphone — hold to record (Cmd+D)",
    );
    expect(formatPushToTalkActionLabel("recording", "MacIntel")).toBe(
      "Mute microphone — release to transcribe (Cmd+D)",
    );
    expect(formatPushToTalkActionLabel("recording", "MacIntel", null, true)).toBe(
      "Mute microphone — release to transcribe and send (Cmd+D)",
    );
    expect(formatPushToTalkActionLabel("transcribing", "Win32")).toBe(
      "Transcribing voice message (Ctrl+D)",
    );
  });
});
