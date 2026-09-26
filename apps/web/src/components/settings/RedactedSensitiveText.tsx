import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { confirmInApp } from "../ui/appConfirm";

const REDACTED_TEXT_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const DEFAULT_REVEAL_CONFIRMATION =
  "Reveal this sensitive information? Make sure nobody else can see your screen.";

export function confirmSensitiveReveal(message = DEFAULT_REVEAL_CONFIRMATION): Promise<boolean> {
  // Never `window.confirm`: it freezes the renderer thread, which is what took
  // the whole app - and preview automation with it - down on 2026-09-11.
  return confirmInApp(message, { confirmLabel: "Reveal" });
}

function redactedPlaceholder(value: string): string {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }

  const nextChar = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return REDACTED_TEXT_ALPHABET[Math.abs(state) % REDACTED_TEXT_ALPHABET.length] ?? "x";
  };

  return Array.from(value, (char) => {
    if (char === "@" || char === "." || char === "-" || char === "_") return char;
    return nextChar();
  }).join("");
}

export function RedactedSensitiveText(props: {
  readonly value: string | null | undefined;
  readonly ariaLabel: string;
  readonly revealTooltip: string;
  readonly hideTooltip: string;
  readonly confirmationMessage?: string;
  readonly confirmationMode?: "dialog" | "inline";
  readonly className?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const value = props.value?.trim();
  const redacted = useMemo(() => (value ? redactedPlaceholder(value) : ""), [value]);

  if (!value) return null;

  if (confirming) {
    return (
      <span
        className="flex min-w-0 flex-wrap items-center gap-2"
        role="group"
        aria-label="Confirm account reveal"
      >
        <span className="basis-full text-xs text-muted-foreground">
          {props.confirmationMessage ?? DEFAULT_REVEAL_CONFIRMATION}
        </span>
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-xs"
          onClick={() => {
            setConfirming(false);
            setRevealed(true);
          }}
        >
          Reveal
        </button>
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-xs"
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "min-w-0 cursor-pointer rounded-sm font-mono text-[11px] leading-none transition hover:text-foreground",
              revealed ? "text-muted-foreground" : "select-none text-muted-foreground blur-[2px]",
              props.className,
            )}
            onClick={() => {
              if (revealed) {
                setRevealed(false);
                return;
              }
              if (props.confirmationMode === "inline") {
                setConfirming(true);
                return;
              }
              void confirmSensitiveReveal(props.confirmationMessage).then((confirmed) => {
                if (confirmed) setRevealed(true);
              });
            }}
            aria-label={props.ariaLabel}
            aria-pressed={revealed}
          >
            {revealed ? value : redacted}
          </button>
        }
      />
      <TooltipPopup side="top">{revealed ? props.hideTooltip : props.revealTooltip}</TooltipPopup>
    </Tooltip>
  );
}
