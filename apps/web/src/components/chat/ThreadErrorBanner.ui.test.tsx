// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  canResumeFailedThreadSession,
  runResumeIncompleteTurn,
} from "@t3tools/client-runtime/state/thread-activity";
import { RESUME_PROMPT } from "@t3tools/shared/resumePrompt";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

afterEach(() => vi.unstubAllGlobals());

describe("session error Resume control", () => {
  it("keeps dismiss and session reset separate and reports reset progress", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const dismiss = vi.fn();
    const reset = vi.fn();
    const render = (resettingSession = false) => (
      <ThreadErrorBanner
        error="Provider failed"
        onDismiss={dismiss}
        onResetSession={reset}
        resettingSession={resettingSession}
      />
    );
    try {
      await act(async () => root.render(render()));
      await act(async () =>
        container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]')!.click(),
      );
      expect(dismiss).toHaveBeenCalledOnce();
      expect(reset).not.toHaveBeenCalled();
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Reset provider session"]',
      )!;
      expect(button.textContent).toBe("Reset session");
      await act(async () => button.click());
      expect(reset).toHaveBeenCalledOnce();
      expect(dismiss).toHaveBeenCalledOnce();
      await act(async () => root.render(render(true)));
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe("Resetting…");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("sends one resume from a lost handoff without an assistant anchor, then leaves running work alone", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const inFlightRef = { current: false };
    let resolveDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    const send = vi.fn(() => delivery);
    let sent: Promise<boolean> | undefined;
    function Harness() {
      const [running, setRunning] = useState(false);
      const [busy, setBusy] = useState(false);
      // The installed legacy shape: old completed turn, no new assistant or
      // runtime.error activity, and a durable session error as the only signal.
      const thread = {
        latestTurn: { state: "completed" },
        pendingWork: null,
        session: {
          status: running ? "running" : "stopped",
          activeTurnId: running ? "replacement" : null,
          lastError: running
            ? null
            : "The provider received your message, but its turn state was lost. Use Resume to continue.",
        },
      };
      const eligible = canResumeFailedThreadSession(thread);
      return (
        <ThreadErrorBanner
          error={thread.session.lastError}
          resuming={busy}
          {...(eligible
            ? {
                onResume: () => {
                  if (!canResumeFailedThreadSession(thread) || inFlightRef.current) return;
                  setBusy(true);
                  sent = runResumeIncompleteTurn({ inFlightRef, send }).then((result) => {
                    setRunning(true);
                    setBusy(false);
                    return result;
                  });
                },
              }
            : {})}
        />
      );
    }
    try {
      await act(async () => root.render(<Harness />));
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Resume thread"]',
      );
      expect(button).not.toBeNull();
      await act(async () => {
        button!.click();
        button!.click();
      });
      expect(send).toHaveBeenCalledExactlyOnceWith(RESUME_PROMPT);
      expect(button!.disabled).toBe(true);
      await act(async () => {
        resolveDelivery();
        await sent;
      });
      expect(container.querySelector('button[aria-label="Resume thread"]')).toBeNull();
      expect(inFlightRef.current).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
