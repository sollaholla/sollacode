// @vitest-environment happy-dom

import { ProviderDriverKind } from "@t3tools/contracts";
import { act, type ComponentProps, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPrimaryActions, formatPushToTalkActionLabel } from "./ComposerPrimaryActions";
import { deriveQueuedGrokMessageIds } from "../ChatView.logic";
import { useComposerTextPresence } from "./composerTextPresence";
import { shouldSendComposerWhileProcessing } from "./mobileComposerPresentation";

const actions = (overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {}) => (
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
  />
);

const renderActions = (overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {}) =>
  renderToStaticMarkup(actions(overrides));

function ExternalComposerClearHarness(props: {
  readonly onRender: (state: {
    readonly prompt: string;
    readonly currentEditorHasText: boolean;
  }) => void;
}) {
  const [prompt, setPrompt] = useState("queued follow-up");
  const { currentEditorHasText, syncEditorTextPresence } = useComposerTextPresence(prompt);
  props.onRender({ prompt, currentEditorHasText });

  return (
    <>
      <button
        type="button"
        aria-label="Clear composer externally"
        onClick={() => {
          setPrompt("");
          syncEditorTextPresence("");
        }}
      />
      {actions({
        isRunning: true,
        sendWhileRunning: shouldSendComposerWhileProcessing({
          isProcessing: true,
          hasCurrentEditorText: currentEditorHasText,
        }),
        promptHasText: currentEditorHasText,
        hasSendableContent: currentEditorHasText,
      })}
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("keeps Send pressable while reconnecting, so the press can be answered", () => {
    // A disabled button swallows the click, which is exactly how pressing send
    // on a dropped socket did nothing at all. Enabled, onSend explains itself.
    const markup = renderActions({ isConnecting: true });

    expect(markup).toContain('aria-label="Connecting"');
    expect(markup).not.toContain('disabled="" aria-label="Connecting"');
  });

  it("keeps Send pressable while the host is unreachable", () => {
    const markup = renderActions({ isEnvironmentUnavailable: true });

    expect(markup).toContain('aria-label="Environment disconnected"');
    expect(markup).not.toContain('disabled="" aria-label="Environment disconnected"');
  });

  it("still disables Send with nothing to send", () => {
    const markup = renderActions({ hasSendableContent: false, promptHasText: false });

    expect(markup).toContain('disabled="" aria-label="Send message"');
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

  it("keeps Stop primary and offers a distinct queued action for an empty running composer", () => {
    const markup = renderActions({
      isRunning: true,
      hasQueuedSendNow: true,
      sendWhileRunning: false,
      promptHasText: false,
      hasSendableContent: false,
    });

    expect(markup).toContain('aria-label="Send queued now"');
    expect(markup).toContain(">Send queued now</span>");
    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Send message"');
    expect(markup).not.toContain('disabled=""');
  });

  it("removes the actionable Send state in the same transition as an external composer clear", async () => {
    const renders: Array<{ prompt: string; currentEditorHasText: boolean }> = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ExternalComposerClearHarness onRender={(state) => renders.push(state)} />);
    });
    expect(container.querySelector('button[aria-label="Send message"]')).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Clear composer externally"]')
        ?.click();
    });

    expect(renders).not.toContainEqual({ prompt: "", currentEditorHasText: true });
    expect(container.querySelector('button[aria-label="Send message"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Stop generation"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it("ignores transcript-only rows while still surfacing a real queued Grok follow-up", () => {
    const queuedIds = deriveQueuedGrokMessageIds({
      activeSessionProviderDriver: ProviderDriverKind.make("grok"),
      phase: "running",
      activeWorkStartedAt: "2026-08-27T12:00:00.000Z",
      messages: [
        {
          id: "voice-transcript",
          role: "user",
          turnId: null,
          createdAt: "2026-08-27T12:01:00.000Z",
          voiceTranscript: true,
        },
        {
          id: "real-follow-up-1",
          role: "user",
          turnId: null,
          createdAt: "2026-08-27T12:02:00.000Z",
        },
        {
          id: "real-follow-up-2",
          role: "user",
          turnId: null,
          createdAt: "2026-08-27T12:03:00.000Z",
          voiceTranscript: false,
        },
      ] as never,
      promotedMessageIds: new Set(),
      pendingMessageIds: new Set(),
      deliveredMessageIds: new Set(),
    });

    expect(queuedIds).toEqual(["real-follow-up-1", "real-follow-up-2"]);
    const markup = renderActions({
      isRunning: true,
      hasQueuedSendNow: queuedIds.length > 0,
      sendWhileRunning: false,
      promptHasText: false,
      hasSendableContent: false,
    });
    expect(markup).toContain('aria-label="Send queued now"');
    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Send message"');
  });

  it("shows separate queue and draft actions when a queued message has a new draft", () => {
    const markup = renderActions({
      isRunning: true,
      hasQueuedSendNow: true,
      sendWhileRunning: true,
      promptHasText: true,
      hasSendableContent: true,
    });

    expect(markup).toContain('aria-label="Send queued now"');
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).not.toContain('aria-label="Stop generation"');
  });

  it("keeps Stop visible while queued promotion is busy", () => {
    const markup = renderActions({
      isRunning: true,
      hasQueuedSendNow: true,
      isPromotingQueued: true,
      sendWhileRunning: false,
      promptHasText: false,
      hasSendableContent: false,
    });

    expect(markup).toContain('disabled="" aria-label="Sending queued messages now"');
    expect(markup).toContain('aria-label="Stop generation"');
  });

  it("invokes queued promotion without submitting the draft action", async () => {
    const onPromoteQueued = vi.fn();
    const onSubmit = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {actions({
            isRunning: true,
            hasQueuedSendNow: true,
            sendWhileRunning: true,
            promptHasText: true,
            hasSendableContent: true,
            onPromoteQueued,
          })}
        </form>,
      );
    });

    const queuedButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send queued now"]',
    );
    expect(queuedButton).not.toBeNull();
    await act(async () => queuedButton?.click());

    expect(onPromoteQueued).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    container.remove();
  });

  it("shows the microphone beside a pending plan-question action", () => {
    const markup = renderActions({
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning: false,
    });

    const microphoneIndex = markup.indexOf(
      'aria-label="Unmute microphone — hold to record (Cmd+D)"',
    );
    const submitIndex = markup.indexOf("Submit answer");
    expect(microphoneIndex).toBeGreaterThan(-1);
    expect(submitIndex).toBeGreaterThan(microphoneIndex);
  });

  it("shows the microphone beside both plan follow-up actions", () => {
    const refineMarkup = renderActions({
      showPlanFollowUpPrompt: true,
      promptHasText: true,
    });
    const implementMarkup = renderActions({
      showPlanFollowUpPrompt: true,
      promptHasText: false,
      hasSendableContent: false,
    });

    expect(refineMarkup.indexOf('aria-label="Unmute microphone')).toBeGreaterThan(-1);
    expect(refineMarkup.indexOf(">Refine</button>")).toBeGreaterThan(
      refineMarkup.indexOf('aria-label="Unmute microphone'),
    );
    expect(implementMarkup.indexOf('aria-label="Unmute microphone')).toBeGreaterThan(-1);
    expect(implementMarkup.indexOf(">Implement</button>")).toBeGreaterThan(
      implementMarkup.indexOf('aria-label="Unmute microphone'),
    );
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
    expect(markup).not.toContain('aria-label="Send queued now"');
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

  it("shows the dedicated push-to-talk chord for each platform", () => {
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
