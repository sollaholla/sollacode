import type { TimestampFormat } from "@t3tools/contracts/settings";
import { CheckIcon, CloudOffIcon, PaperclipIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export interface OfflineOutboxMessage {
  readonly id: string;
  readonly text: string;
  readonly attachmentCount: number;
  readonly savedAt: string;
  /** Why the last delivery attempt failed; absent while it is simply waiting. */
  readonly error: string | undefined;
}

/**
 * On a weak connection most saved messages go out within a moment. Only one
 * still waiting after this long is worth a chip; the message itself is
 * already in the conversation.
 */
export const OUTBOX_SHOW_AFTER_MS = 3_000;
/**
 * Once everything has gone, the chip says so for this long before leaving,
 * so a connection that keeps dropping does not flash it on and off.
 */
export const OUTBOX_SENT_LINGER_MS = 4_000;

export type OfflineOutboxChipPhase = "hidden" | "waiting" | "failed" | "sent";

/** How long until a message saved at `savedAt` has waited long enough to show. */
export function outboxShowDelayMs(savedAt: string | undefined, now: number): number {
  const saved = savedAt === undefined ? Number.NaN : Date.parse(savedAt);
  if (Number.isNaN(saved)) return OUTBOX_SHOW_AFTER_MS;
  return Math.max(0, OUTBOX_SHOW_AFTER_MS - (now - saved));
}

/**
 * Whether the outbox chip shows, and as what. A refused message shows at
 * once, since it needs an answer; a waiting one only after it has waited a
 * while; and the chip stays a little after the last one is sent.
 */
export function useOfflineOutboxChipPhase(
  messages: ReadonlyArray<OfflineOutboxMessage>,
): OfflineOutboxChipPhase {
  const [shown, setShown] = useState(false);
  const count = messages.length;
  const failed = messages.some((message) => message.error !== undefined);
  const oldestSavedAt = messages.reduce<string | undefined>(
    (oldest, message) =>
      oldest === undefined || message.savedAt < oldest ? message.savedAt : oldest,
    undefined,
  );

  useEffect(() => {
    if (count > 0) {
      if (shown) return;
      const delay = failed ? 0 : outboxShowDelayMs(oldestSavedAt, Date.now());
      const timer = setTimeout(() => setShown(true), delay);
      return () => clearTimeout(timer);
    }
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), OUTBOX_SENT_LINGER_MS);
    return () => clearTimeout(timer);
  }, [count, failed, oldestSavedAt, shown]);

  if (failed) return "failed";
  if (!shown) return "hidden";
  return count === 0 ? "sent" : "waiting";
}

const CHIP_CLASS_NAME =
  "chat-composer-status-chip pointer-events-auto flex items-center gap-1.5 rounded-full border bg-background/95 px-2.5 py-1 text-xs font-medium";

function attachmentLabel(count: number): string {
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

/**
 * The composer rail's quiet note that messages are saved on this device and
 * waiting for the connection. Tapping it opens the details: each message,
 * when it was saved, and for a refused one, why and what to do about it.
 */
export function OfflineOutboxChip(props: {
  readonly phase: Exclude<OfflineOutboxChipPhase, "hidden">;
  readonly messages: ReadonlyArray<OfflineOutboxMessage>;
  readonly timestampFormat: TimestampFormat;
  readonly onRetry: (id: string) => void;
  readonly onDiscard: (id: string) => void;
}) {
  if (props.phase === "sent") {
    return (
      <span
        className={cn(CHIP_CLASS_NAME, "border-border/60 font-normal text-muted-foreground")}
        data-chat-composer-status-chip="outbox"
        data-offline-outbox="sent"
      >
        <CheckIcon aria-hidden className="size-3" />
        Sent
      </span>
    );
  }
  const failed = props.phase === "failed";
  const count = props.messages.length;
  const summary = failed
    ? `${count === 1 ? "A saved message" : `${count} saved messages`} couldn't be sent`
    : `${count === 1 ? "1 message" : `${count} messages`} waiting to send`;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${summary}. Show details.`}
        title={summary}
        className={cn(
          CHIP_CLASS_NAME,
          "cursor-pointer transition-colors",
          failed
            ? "border-destructive/40 text-destructive hover:bg-destructive/5"
            : "border-amber-500/35 text-amber-700 hover:border-amber-500/60 dark:text-amber-300",
        )}
        data-chat-composer-status-chip="outbox"
        data-offline-outbox={props.phase}
      >
        {failed ? (
          <TriangleAlertIcon aria-hidden className="size-3" />
        ) : (
          <CloudOffIcon aria-hidden className="size-3" />
        )}
        <span aria-hidden className="chat-composer-status-label-full">
          {failed ? "Not sent" : "Waiting to send"}
        </span>
        <span aria-hidden className="chat-composer-status-label-compact">
          {failed ? "Not sent" : "Waiting"}
        </span>
        {count > 1 ? (
          <span aria-hidden className="tabular-nums">
            {count}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        className="w-[min(20rem,calc(100vw-2rem))]"
        viewportClassName="py-3 [--viewport-inline-padding:--spacing(3)]"
      >
        <OfflineOutboxDetails
          messages={props.messages}
          timestampFormat={props.timestampFormat}
          onRetry={props.onRetry}
          onDiscard={props.onDiscard}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** The chip's expanded view: the outbox card, sized for a popover. */
export function OfflineOutboxDetails(props: {
  readonly messages: ReadonlyArray<OfflineOutboxMessage>;
  readonly timestampFormat: TimestampFormat;
  readonly onRetry: (id: string) => void;
  readonly onDiscard: (id: string) => void;
}) {
  const failedCount = props.messages.filter((message) => message.error !== undefined).length;
  const needsAttention = failedCount > 0;
  const title = needsAttention
    ? failedCount === 1
      ? "A saved message couldn't be sent"
      : `${failedCount} saved messages couldn't be sent`
    : props.messages.length === 1
      ? "Message waiting to send"
      : `${props.messages.length} messages waiting to send`;
  return (
    <section aria-label="Message outbox" className="space-y-2.5">
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md border",
            needsAttention
              ? "border-destructive/25 bg-destructive/10 text-destructive"
              : "border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-300",
          )}
        >
          {needsAttention ? (
            <TriangleAlertIcon className="size-3.5" />
          ) : (
            <CloudOffIcon className="size-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug text-foreground">{title}</p>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {needsAttention
              ? "Retry it, or discard it and write it again."
              : "Saved on this device. Sends by itself once you're back online."}
          </p>
        </div>
      </header>
      <ul className="max-h-64 space-y-1 overflow-y-auto overscroll-contain">
        {props.messages.map((message) => (
          <li
            key={message.id}
            className={cn(
              "rounded-md border px-2.5 py-1.5",
              message.error !== undefined
                ? "border-destructive/25 bg-destructive/5"
                : "border-border/60 bg-card/60",
            )}
          >
            <p
              className={cn(
                "whitespace-pre-wrap break-words text-xs leading-snug text-foreground/90",
                message.error === undefined && "line-clamp-2",
              )}
            >
              {message.text.trim().length > 0 ? (
                message.text
              ) : (
                <span className="italic text-muted-foreground">No text</span>
              )}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
              <span>Saved {formatShortTimestamp(message.savedAt, props.timestampFormat)}</span>
              {message.attachmentCount > 0 ? (
                <span className="inline-flex items-center gap-1">
                  <PaperclipIcon aria-hidden className="size-3" />
                  {attachmentLabel(message.attachmentCount)}
                </span>
              ) : null}
            </p>
            {message.error !== undefined ? (
              <>
                <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-destructive">
                  {message.error}
                </p>
                <div className="mt-1.5 flex gap-1.5">
                  <Button size="xs" variant="outline" onClick={() => props.onRetry(message.id)}>
                    Retry
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => props.onDiscard(message.id)}>
                    Discard
                  </Button>
                </div>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
