// @vitest-environment happy-dom

import {
  EnvironmentId,
  ThreadId,
  VmAgentBlockerId,
  VmAgentId,
  VmAgentNotificationId,
  type VmAgentBlocker,
  type VmAgentNotification,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { InlineAgentAttention } from "./agentNotifications";

const mocks = vi.hoisted(() => {
  const composer = {
    readSnapshot: vi.fn(() => ({
      value: "",
      cursor: 0,
      expandedCursor: 0,
      terminalContextIds: [] as string[],
    })),
    insertTextAtEnd: vi.fn(() => true),
    focusAtEnd: vi.fn(),
  };
  return {
    composer,
    composerRef: { current: composer },
    markRead: vi.fn(async () => ({ _tag: "Success" as const })),
    markReadToken: Symbol.for("agent-notification-mark-read"),
    openPreview: vi.fn(async () => ({ _tag: "Success" as const })),
    openPreviewToken: Symbol.for("preview-open"),
    openUrlInThreadPreview: vi.fn(async () => "opened-tab" as const),
    resolveBlocker: vi.fn(async () => ({ _tag: "Success" as const })),
    resolveBlockerToken: Symbol.for("agent-blocker-resolve"),
    revealChat: vi.fn(),
    updateNotification: vi.fn(async () => ({ _tag: "Success" as const })),
    updateNotificationToken: Symbol.for("agent-notification-update"),
  };
});

vi.mock("~/composerHandleContext", () => ({
  useComposerHandleContext: () => mocks.composerRef,
}));

vi.mock("~/components/preview/openUrlInThreadPreview", () => ({
  openUrlInThreadPreview: mocks.openUrlInThreadPreview,
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: { open: mocks.openPreviewToken },
}));

vi.mock("~/state/vmAgents", () => ({
  vmAgentEnvironment: {
    markNotificationRead: mocks.markReadToken,
    resolveBlocker: mocks.resolveBlockerToken,
    updateNotification: mocks.updateNotificationToken,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === mocks.markReadToken) return mocks.markRead;
    if (command === mocks.resolveBlockerToken) return mocks.resolveBlocker;
    if (command === mocks.updateNotificationToken) return mocks.updateNotification;
    if (command === mocks.openPreviewToken) return mocks.openPreview;
    throw new Error("Unexpected agent attention command token.");
  },
}));

import { AgentAttentionStack } from "./AgentAttentionStack";
import { detachWaitingOnYou, getWaitingOnYouAttachment } from "./waitingOnYouAttachment";

const environmentId = EnvironmentId.make("environment-1");
const threadRef = {
  environmentId,
  threadId: ThreadId.make("thread-1"),
} as const;

function blocker(id: string, overrides: Partial<VmAgentBlocker> = {}): VmAgentBlocker {
  return {
    blockerId: VmAgentBlockerId.make(id),
    vmAgentId: VmAgentId.make("agent-1"),
    title: "Sign in to continue",
    detail: "The browser needs the user's account.",
    url: "https://example.com/login",
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

function notification(
  id: string,
  overrides: Partial<VmAgentNotification> = {},
): VmAgentNotification {
  return {
    notificationId: VmAgentNotificationId.make(id),
    vmAgentId: VmAgentId.make("agent-1"),
    taskId: null,
    runId: null,
    kind: "agent-message",
    title: "Agent update",
    body: "A new result is ready.",
    deepLink: "/agents/local/agent-1",
    readAt: null,
    archivedAt: null,
    createdAt: "2026-08-25T13:00:00.000Z",
    ...overrides,
  };
}

function blockerItem(value: VmAgentBlocker): InlineAgentAttention["items"][number] {
  return {
    kind: "blocker",
    id: `blocker:${value.blockerId}`,
    occurredAt: value.updatedAt,
    blocker: value,
  };
}

function notificationItem(value: VmAgentNotification): InlineAgentAttention["items"][number] {
  return {
    kind: "notification",
    id: `notification:${value.notificationId}`,
    occurredAt: value.createdAt,
    notification: value,
  };
}

let container: HTMLDivElement;
let root: Root;

function buttonLabelled(label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Could not find button labelled ${label}.`);
  }
  return button;
}

async function renderAttention(attention: InlineAgentAttention): Promise<void> {
  await act(async () => {
    root.render(
      <AgentAttentionStack
        environmentId={environmentId}
        attention={attention}
        threadRef={threadRef}
        onRevealChat={mocks.revealChat}
      />,
    );
    await Promise.resolve();
  });
}

async function flushAction(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.composer.focusAtEnd.mockClear();
  mocks.composer.insertTextAtEnd.mockClear();
  mocks.composer.readSnapshot.mockClear();
  mocks.markRead.mockClear();
  mocks.openPreview.mockClear();
  mocks.openUrlInThreadPreview.mockClear();
  mocks.resolveBlocker.mockClear();
  mocks.revealChat.mockClear();
  detachWaitingOnYou(scopedThreadKey(threadRef));
  mocks.updateNotification.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("AgentAttentionStack", () => {
  it("marks a stacked notification read only after hover expands it", async () => {
    const alert = notification("notification-1");
    await renderAttention({
      items: [blockerItem(blocker("blocker-1")), notificationItem(alert)],
      hiddenCount: 0,
    });

    expect(mocks.markRead).not.toHaveBeenCalled();
    const stack = container.querySelector("[data-agent-attention-stack] > div");
    if (!(stack instanceof HTMLDivElement)) throw new Error("Missing attention banner stack.");

    await flushAction(() => {
      stack.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    expect(mocks.markRead).toHaveBeenCalledWith({
      environmentId,
      input: {
        vmAgentId: alert.vmAgentId,
        notificationId: alert.notificationId,
      },
    });
  });

  it("routes follow-up, open, resolve, and dismiss actions to their owning paths", async () => {
    const request = blocker("blocker-1");
    await renderAttention({ items: [blockerItem(request)], hiddenCount: 0 });

    act(() => buttonLabelled("Follow up").click());
    expect(mocks.revealChat).toHaveBeenCalledTimes(1);
    // Follow-up tags the request onto the composer instead of typing about it;
    // sending that message is what closes the request out.
    expect(getWaitingOnYouAttachment(scopedThreadKey(threadRef))).toEqual({
      vmAgentId: request.vmAgentId,
      blockerId: request.blockerId,
      title: request.title,
    });
    expect(mocks.composer.insertTextAtEnd).not.toHaveBeenCalled();
    expect(mocks.composer.focusAtEnd).toHaveBeenCalledTimes(1);

    await flushAction(() => buttonLabelled("Open").click());
    expect(mocks.revealChat).toHaveBeenCalledTimes(2);
    expect(mocks.openUrlInThreadPreview).toHaveBeenCalledWith({
      threadRef,
      url: request.url,
      openPreview: mocks.openPreview,
      openExternally: expect.any(Function),
    });

    await flushAction(() => buttonLabelled("Mark resolved").click());
    expect(mocks.resolveBlocker).toHaveBeenNthCalledWith(1, {
      environmentId,
      input: {
        vmAgentId: request.vmAgentId,
        blockerId: request.blockerId,
      },
    });

    await flushAction(() => buttonLabelled("Dismiss without marking it done").click());
    expect(mocks.resolveBlocker).toHaveBeenNthCalledWith(2, {
      environmentId,
      input: {
        vmAgentId: request.vmAgentId,
        blockerId: request.blockerId,
        dismissed: true,
      },
    });
    expect(mocks.updateNotification).not.toHaveBeenCalled();
  });

  it("routes alert dismissal through notification archival rather than blocker resolution", async () => {
    const alert = notification("notification-1");
    await renderAttention({ items: [notificationItem(alert)], hiddenCount: 0 });

    expect(mocks.markRead).toHaveBeenCalledTimes(1);
    await flushAction(() => buttonLabelled("Dismiss agent alert").click());

    expect(mocks.updateNotification).toHaveBeenCalledWith({
      environmentId,
      input: {
        vmAgentId: alert.vmAgentId,
        notificationId: alert.notificationId,
        read: true,
        archived: true,
      },
    });
    expect(mocks.resolveBlocker).not.toHaveBeenCalled();
  });
});
