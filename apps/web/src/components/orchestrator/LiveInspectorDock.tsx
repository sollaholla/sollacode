import { MessageId } from "@t3tools/contracts";
import { MessageCircleIcon, SendIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import type { Subtitle } from "../../orchestrator/liveInspector";
import type { OrchestratorThreadTarget } from "../../orchestrator/useOrchestratorThread";
import { randomUUID } from "../../lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

/**
 * The bottom of the Live Inspector: the conversation with the orchestrator as
 * subtitles, and the chat button that opens a box to type to it. Typing never
 * leaves the stage; the reply arrives as the next subtitle.
 */
export function LiveInspectorDock({
  orchestrator,
  subtitle,
  orchestratorWorking,
  composerOpen,
  onComposerOpenChange,
}: {
  orchestrator: OrchestratorThreadTarget | null;
  subtitle: Subtitle | null;
  orchestratorWorking: boolean;
  composerOpen: boolean;
  onComposerOpenChange: (open: boolean) => void;
}) {
  const enqueueTurn = useAtomCommand(threadEnvironment.enqueueTurn, { reportFailure: false });
  // Kept while the box is closed, and after a failed send, so nothing typed is lost.
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (composerOpen) textareaRef.current?.focus();
  }, [composerOpen]);

  const send = async () => {
    const text = draft.trim();
    if (orchestrator === null || text.length === 0 || sending) return;
    setSending(true);
    setError(null);
    const { ref, shell } = orchestrator;
    const result = await enqueueTurn({
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        message: {
          messageId: MessageId.make(randomUUID()),
          role: "user",
          text,
          attachments: [],
        },
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt: new Date().toISOString(),
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      setError("Couldn't send that. Try again.");
      return;
    }
    setDraft("");
    onComposerOpenChange(false);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onComposerOpenChange(false);
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 bg-gradient-to-t from-background via-background/90 to-transparent px-4 pt-12 pb-[max(env(safe-area-inset-bottom),1rem)]">
      <div aria-live="polite" className="min-h-6 max-w-2xl text-center">
        {subtitle !== null ? (
          <p
            key={subtitle.key}
            className="live-inspector-enter line-clamp-3 text-[15px] leading-snug text-foreground"
            data-testid="live-inspector-subtitle"
          >
            <span className="font-semibold text-gold-600 dark:text-gold-300">
              {subtitle.speaker === "you" ? "You" : "Orchestrator"}:
            </span>{" "}
            {subtitle.text}
          </p>
        ) : orchestratorWorking ? (
          <p className="text-sm text-muted-foreground">The orchestrator is on it…</p>
        ) : null}
      </div>

      {composerOpen ? (
        <form
          onSubmit={onSubmit}
          className="live-inspector-enter pointer-events-auto w-full max-w-xl rounded-2xl border border-[var(--gold-line)] bg-card p-2 shadow-lg"
        >
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Tell the orchestrator what you want…"
            aria-label="Message to the orchestrator"
            className="block max-h-40 w-full resize-none bg-transparent px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between gap-2 px-1 pt-1">
            {error !== null ? (
              <span className="text-xs text-destructive" role="alert">
                {error}
              </span>
            ) : (
              <span className="hidden text-xs text-muted-foreground sm:inline">
                Enter to send · Shift+Enter for a new line · Esc to close
              </span>
            )}
            <div className="ms-auto flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close the message box"
                onClick={() => onComposerOpenChange(false)}
              >
                <XIcon />
              </Button>
              <Button type="submit" size="sm" disabled={draft.trim().length === 0 || sending}>
                {sending ? "Sending…" : "Send"}
                <SendIcon />
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => onComposerOpenChange(true)}
          disabled={orchestrator === null}
          aria-label="Type to the orchestrator"
          title={
            orchestrator === null
              ? "The orchestrator isn't available on this connection"
              : "Type to the orchestrator (/)"
          }
          data-testid="live-inspector-chat"
          className="pointer-events-auto inline-flex size-14 items-center justify-center rounded-full border border-[var(--gold-line)] bg-card text-gold-600 shadow-lg transition-transform outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 dark:text-gold-300"
        >
          <MessageCircleIcon className="size-6" />
        </button>
      )}
    </div>
  );
}
