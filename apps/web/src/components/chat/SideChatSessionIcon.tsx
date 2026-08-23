import { MessagesSquare } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

import { TERMINAL_WORKING_DOT_CLASS } from "./TerminalSessionIcon";

/**
 * A side chat, with the same working dot the terminal icon uses.
 *
 * The status chips beside the composer are read as a set, and a bare spinner
 * said only "something is busy" — it did not say *what*, which is the one
 * thing the chip exists to answer. The terminal chip has always shown a
 * terminal; this shows a conversation, so the two are told apart by their
 * glyph rather than by reading the count and inferring.
 *
 * Shares the dot class rather than restating it: the chips sit next to each
 * other, and two subtly different "working" markers would read as two
 * different states.
 */
export const SideChatSessionIcon = memo(function SideChatSessionIcon({
  working,
  className = "size-3.5",
  workingLabel = "Side chat working",
}: {
  readonly working: boolean;
  readonly className?: string;
  readonly workingLabel?: string;
}) {
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      data-side-chat-working={working ? "true" : undefined}
    >
      <MessagesSquare className="size-full shrink-0" aria-hidden />
      {working ? (
        <span aria-label={workingLabel} className={TERMINAL_WORKING_DOT_CLASS} role="status" />
      ) : null}
    </span>
  );
});
