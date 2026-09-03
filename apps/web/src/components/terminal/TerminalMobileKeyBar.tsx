import { Fragment } from "react";

import { cn } from "~/lib/utils";

import { bracketedPaste, TERMINAL_MOBILE_KEYS, type TerminalMobileKey } from "./mobileKeys";

/**
 * The keys a phone keyboard does not have, under the terminal.
 *
 * It sits in the flow rather than over the surface, so the terminal fits to
 * what is left and no output is ever hidden behind it. Touch-only: a desktop
 * keyboard already sends every one of these.
 */
export function TerminalMobileKeyBar(props: {
  readonly onSend: (data: string) => void;
  readonly onReadClipboard: () => Promise<string>;
  readonly className?: string;
}): React.JSX.Element {
  const press = (key: TerminalMobileKey) => {
    if (typeof key.data === "string") {
      props.onSend(key.data);
      return;
    }
    void props
      .onReadClipboard()
      .then((text) => {
        if (text.length > 0) props.onSend(bracketedPaste(text));
      })
      // A denied or empty clipboard is not worth interrupting the user over;
      // the paste simply does not happen.
      .catch(() => undefined);
  };

  return (
    <div
      aria-label="Terminal keys"
      className={cn(
        "hidden shrink-0 gap-1 overflow-x-auto border-t border-[var(--line)] bg-[var(--card)] px-2 py-1.5",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "pointer-coarse:flex",
        props.className,
      )}
      data-terminal-mobile-keys=""
      role="toolbar"
    >
      {TERMINAL_MOBILE_KEYS.map((key, index) => (
        <Fragment key={key.id}>
          {index > 0 && TERMINAL_MOBILE_KEYS[index - 1]?.group !== key.group ? (
            <span aria-hidden className="my-1 w-px shrink-0 bg-[var(--line)]" />
          ) : null}
          <button
            aria-label={key.title}
            className={cn(
              "inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-[6px] px-2",
              "border border-[var(--line)] bg-surface text-xs font-medium text-foreground",
              "active:bg-surface-hover",
            )}
            data-terminal-mobile-key={key.id}
            // The terminal keeps focus, so the keyboard does not collapse and
            // reopen between presses.
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              press(key);
            }}
            title={key.title}
            type="button"
          >
            {key.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
