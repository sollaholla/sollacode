import { ChevronDownIcon, LoaderCircleIcon, PauseIcon, PlayIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import type {
  ThreadPauseAccountChoice,
  ThreadPauseModelChoice,
  ThreadPauseModelGroup,
} from "./threadPauseChoices";

function leftLabel(percentLeft: number | null): string | null {
  return percentLeft === null ? null : `${percentLeft}% left`;
}

function ChoiceLabel(props: { readonly name: string; readonly percentLeft: number | null }) {
  const left = leftLabel(props.percentLeft);
  return (
    <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
      <span className="truncate">{props.name}</span>
      {left === null ? null : (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{left}</span>
      )}
    </span>
  );
}

/**
 * What a thread shows when its provider stopped: out of usage, a refusal, an
 * outage. Nothing was lost and nothing moves on its own; the person resumes,
 * picks another model, or picks another account.
 */
export const ThreadPausedCard = memo(function ThreadPausedCard(props: {
  readonly title: string;
  /** A second line of plain fact, such as when usage comes back. */
  readonly note: string | null;
  /** The provider's own words, kept behind Details. */
  readonly detail: string;
  readonly resuming: boolean;
  readonly disabled: boolean;
  readonly modelGroups: ReadonlyArray<ThreadPauseModelGroup>;
  readonly accounts: ReadonlyArray<ThreadPauseAccountChoice>;
  /** Signs the provider that stopped in to a different account. */
  readonly onSignInAnother?: (() => void) | undefined;
  readonly onResume: () => void;
  readonly onSwitchModel: (choice: ThreadPauseModelChoice) => void;
  readonly onSwitchAccount: (choice: ThreadPauseAccountChoice) => void;
  readonly onDismiss: () => void;
  readonly onResetSession: () => void;
  /** Offered when the failure is this computer's: out of disk or memory. */
  readonly onFixWithAi?: (() => void) | undefined;
  readonly fixingWithAi: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasAccountChoices = props.accounts.length > 0 || props.onSignInAnother !== undefined;

  return (
    <div
      className="pointer-events-auto mx-auto w-full max-w-3xl px-2 py-2"
      data-testid="thread-paused-card"
    >
      <div className="rounded-xl border border-border bg-card px-3 py-2.5 shadow-sm" role="status">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <PauseIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-40 flex-1">
            <p className="text-sm font-medium text-foreground">{props.title}</p>
            <p className="text-xs text-muted-foreground">
              {props.note ?? "This chat is paused. Nothing was lost."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {props.modelGroups.length > 0 ? (
              <Menu>
                <MenuTrigger
                  disabled={props.disabled}
                  render={<Button type="button" size="sm" variant="outline" />}
                >
                  Switch model
                  <ChevronDownIcon className="size-3.5" aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end" side="top" className="max-h-80 min-w-64">
                  {props.modelGroups.map((group) => (
                    <MenuGroup key={group.instanceId}>
                      <MenuGroupLabel>{group.label}</MenuGroupLabel>
                      {group.models.map((choice) => (
                        <MenuItem key={choice.model} onClick={() => props.onSwitchModel(choice)}>
                          <ChoiceLabel name={choice.name} percentLeft={choice.percentLeft} />
                        </MenuItem>
                      ))}
                    </MenuGroup>
                  ))}
                </MenuPopup>
              </Menu>
            ) : null}
            {hasAccountChoices ? (
              <Menu>
                <MenuTrigger
                  disabled={props.disabled}
                  render={<Button type="button" size="sm" variant="outline" />}
                >
                  Switch account
                  <ChevronDownIcon className="size-3.5" aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end" side="top" className="min-w-56">
                  {props.accounts.map((choice) => (
                    <MenuItem key={choice.instanceId} onClick={() => props.onSwitchAccount(choice)}>
                      <ChoiceLabel name={choice.label} percentLeft={choice.percentLeft} />
                    </MenuItem>
                  ))}
                  {props.onSignInAnother ? (
                    <MenuItem onClick={props.onSignInAnother}>Sign in to another account</MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={props.disabled || props.resuming}
              onClick={props.onResume}
            >
              {props.resuming ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <PlayIcon className="size-3.5" aria-hidden />
              )}
              {props.resuming ? "Resuming…" : "Resume"}
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={props.onDismiss}
              aria-label="Dismiss"
            >
              <XIcon aria-hidden />
            </Button>
          </div>
        </div>
        <div className="mt-1 ps-7">
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {detailsOpen ? "Hide details" : "Details"}
          </button>
          {detailsOpen ? (
            <div className="mt-1 space-y-1.5">
              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                {props.detail}
              </p>
              <div className="flex items-center gap-1">
                <Button type="button" size="xs" variant="ghost" onClick={props.onResetSession}>
                  Reset session
                </Button>
                {props.onFixWithAi ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={props.fixingWithAi}
                    onClick={props.onFixWithAi}
                  >
                    Fix with AI
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
