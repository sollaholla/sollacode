import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * The collapse handle shared by the cards stacked above the composer.
 *
 * The queued-message card and the background-task panel sit directly on top of
 * one another, and after their containers were unified the owner reported that
 * the *handles* still did not match: one was a tall left-aligned title block
 * with a chevron on the right, the other a compact muted bar with the chevron
 * on the left, a live dot and a count pill. They asked for one look, preferring
 * the background-task panel's, so that is the shape this encodes — and keeping
 * it in one component is what stops the two drifting apart again.
 *
 * The button is an `absolute inset-0` peer rather than a wrapper around the
 * content so that the row's own controls (Clear, and anything else a caller
 * puts in `actions`) stay clickable instead of nesting inside the toggle.
 */
export function ComposerStackPanelHeader(props: {
  readonly title: string;
  /** Accessible name for the region, used to label the toggle. */
  readonly label: string;
  readonly collapsed: boolean;
  readonly onToggle: (collapsed: boolean) => void;
  /** Shown when there is live work, matching the task panel's running dot. */
  readonly active?: boolean;
  /** Right-hand controls, rendered before the count pill. */
  readonly actions?: ReactNode;
  /** The pill on the far right. Omitted when there is nothing to count. */
  readonly count?: number;
}) {
  return (
    <header className="relative flex min-h-9 shrink-0 items-center gap-2 bg-muted/20 px-3">
      <button
        type="button"
        aria-expanded={!props.collapsed}
        aria-label={`${props.collapsed ? "Expand" : "Collapse"} ${props.label}`}
        onClick={() => props.onToggle(!props.collapsed)}
        className="peer absolute inset-0 cursor-pointer text-left text-xs font-medium text-muted-foreground hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <div className="pointer-events-none z-10 flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium text-muted-foreground peer-hover:text-foreground peer-focus-visible:text-foreground">
        <ChevronDown
          aria-hidden
          className={cn("size-3.5 shrink-0 transition-transform", props.collapsed && "rotate-180")}
        />
        {props.active === true ? (
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-sky-500 ring-2 ring-sky-500/15"
          />
        ) : null}
        <h2 className="truncate">{props.title}</h2>
      </div>
      <div className="z-10 flex shrink-0 items-center gap-1.5">
        {props.actions}
        {props.count === undefined ? null : (
          <span className="pointer-events-none rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums peer-hover:text-foreground peer-focus-visible:text-foreground">
            {props.count}
          </span>
        )}
      </div>
    </header>
  );
}
