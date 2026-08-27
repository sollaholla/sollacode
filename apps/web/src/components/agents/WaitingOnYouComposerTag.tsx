"use client";

import { HandIcon, XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

import type { WaitingOnYouAttachment } from "./waitingOnYouAttachment";

/**
 * The waiting-on-you request tagged onto the message being written.
 *
 * It sits directly above the composer so the connection is obvious: this reply
 * answers that request, and sending it closes the request out. Taking the tag
 * off leaves the request open and the draft untouched.
 */
export function WaitingOnYouComposerTag(props: {
  readonly attachment: WaitingOnYouAttachment;
  readonly onDetach: () => void;
}) {
  return (
    <div className="mb-1.5 flex justify-center px-1" data-waiting-on-you-tag="true">
      <div className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-warning/40 bg-warning/8 py-1 pl-2.5 pr-1 text-xs">
        <HandIcon className="size-3 shrink-0 text-warning" aria-hidden />
        <span className="shrink-0 font-medium text-warning">Answering</span>
        <span className="min-w-0 truncate text-muted-foreground" title={props.attachment.title}>
          {props.attachment.title}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-5 shrink-0 rounded-full"
          aria-label="Detach this request from the message"
          onClick={props.onDetach}
        >
          <XIcon className="size-3" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
