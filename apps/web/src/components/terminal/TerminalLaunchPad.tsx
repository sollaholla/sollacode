import { Globe, Minus, Plus, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { TerminalSessionIcon } from "../chat/TerminalSessionIcon";

export interface TerminalLaunchProvider {
  /** Provider driver slug; doubles as the row key. */
  readonly driverKind: string;
  readonly label: string;
  /** Shell command that starts the provider's CLI. */
  readonly command: string;
}

/** Bounds for the pane count stepper. */
export function clampLaunchCount(count: number, max: number): number {
  return Math.min(Math.max(1, Math.round(count)), Math.max(1, max));
}

/**
 * Commands for the panes to open: `each` panes per selected provider, in the
 * order the launch pad lists them. With nothing selected, `each` plain shells
 * (null). Never more than `max` panes.
 */
export function resolveLaunchCommands(
  providers: ReadonlyArray<TerminalLaunchProvider>,
  selectedDriverKinds: ReadonlySet<string>,
  each: number,
  max: number,
): ReadonlyArray<string | null> {
  const chosen = providers.filter((provider) => selectedDriverKinds.has(provider.driverKind));
  const commands: Array<string | null> =
    chosen.length === 0
      ? Array.from({ length: each }, () => null)
      : chosen.flatMap((provider) => Array.from({ length: each }, () => provider.command));
  return commands.slice(0, Math.max(1, max));
}

/**
 * First-run surface for terminal mode: pick which installed provider CLIs to
 * start, how many panes to open, then launch them all at once as a grid.
 */
export function TerminalLaunchPad({
  providers,
  maxTerminals,
  onLaunch,
  onAddBrowser,
}: {
  readonly providers: ReadonlyArray<TerminalLaunchProvider>;
  readonly maxTerminals: number;
  readonly onLaunch: (commands: ReadonlyArray<string | null>) => void;
  readonly onAddBrowser?: (() => void) | undefined;
}) {
  // Nothing preselected: launching a provider CLI is a deliberate choice.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [each, setEach] = useState(1);
  // The stepper is "per selected provider", so its ceiling shrinks as more
  // providers are picked and the total stays within the layout's pane cap.
  const maxEach = clampLaunchCount(
    Math.floor(maxTerminals / Math.max(1, selected.size)),
    maxTerminals,
  );
  useEffect(() => {
    setEach((value) => clampLaunchCount(value, maxEach));
  }, [maxEach]);

  const commands = useMemo(
    () => resolveLaunchCommands(providers, selected, each, maxTerminals),
    [each, maxTerminals, providers, selected],
  );
  const count = commands.length;
  const providerPaneCount = commands.filter((command) => command !== null).length;
  const shellPaneCount = count - providerPaneCount;

  const toggleProvider = (driverKind: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(driverKind)) {
        next.delete(driverKind);
      } else {
        next.add(driverKind);
      }
      return next;
    });
  };
  const adjustCount = (delta: number) => {
    setEach((value) => clampLaunchCount(value + delta, maxEach));
  };

  return (
    <div
      data-testid="terminal-launch-pad"
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-6"
    >
      <div className="w-full max-w-md rounded-[14px] border border-[var(--line)] bg-[var(--card)] p-5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-[10px] bg-gold-500 text-[#0b0b0b]">
            <TerminalSquare className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
              Launch terminals
            </h2>
            <p className="text-[12px] text-muted-foreground">
              Installed CLIs start in their own panes. Extra panes open as plain shells.
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-1">
          {providers.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-[var(--line)] px-3 py-2.5 text-[12px] text-muted-foreground">
              No provider CLIs detected yet. Plain shells will open instead.
            </p>
          ) : (
            providers.map((provider) => {
              const checked = selected.has(provider.driverKind);
              return (
                <button
                  key={provider.driverKind}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggleProvider(provider.driverKind)}
                  className={cn(
                    "flex h-9 w-full items-center gap-2.5 rounded-[10px] border px-2.5 text-left text-[13px] transition-colors",
                    checked
                      ? "border-[var(--gold-line)] bg-[var(--gold-tint)] text-foreground"
                      : "border-[var(--line)] bg-surface-row text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[5px] border text-[10px]",
                      checked
                        ? "border-gold-500 bg-gold-500 text-[#0b0b0b]"
                        : "border-[var(--line)] bg-transparent",
                    )}
                  >
                    {checked ? "✓" : ""}
                  </span>
                  <TerminalSessionIcon
                    className="size-3.5"
                    working={false}
                    driverKind={provider.driverKind as never}
                    displayName={provider.label}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{provider.label}</span>
                  <code className="rounded-md bg-surface-hover px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {provider.command}
                  </code>
                </button>
              );
            })
          )}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 rounded-[10px] border border-[var(--line)] bg-surface-row px-2.5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-foreground">
              {selected.size > 0 ? "Terminals each" : "Terminals"}
            </div>
            <div className="text-[11.5px] text-muted-foreground">
              {selected.size > 0
                ? `${count} total · ${providerPaneCount} with a provider${
                    shellPaneCount > 0 ? `, ${shellPaneCount} plain` : ""
                  }`
                : `${count} plain ${count === 1 ? "shell" : "shells"}`}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Fewer terminals"
              disabled={each <= 1}
              onClick={() => adjustCount(-1)}
              className="flex size-7 items-center justify-center rounded-md border border-[var(--line)] text-foreground transition-colors hover:bg-surface-hover disabled:opacity-40"
            >
              <Minus className="size-3.5" />
            </button>
            <span
              aria-live="polite"
              className="w-7 text-center font-mono text-[13px] tabular-nums text-foreground"
            >
              {each}
            </span>
            <button
              type="button"
              aria-label="More terminals"
              disabled={each >= maxEach}
              onClick={() => adjustCount(1)}
              className="flex size-7 items-center justify-center rounded-md border border-[var(--line)] text-foreground transition-colors hover:bg-surface-hover disabled:opacity-40"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onLaunch(commands)}
            className="flex h-9 flex-1 items-center justify-center rounded-[10px] bg-gold-500 text-[13px] font-semibold text-[#0b0b0b] transition-colors hover:bg-gold-400"
          >
            Launch {count === 1 ? "terminal" : `${count} terminals`}
          </button>
          {onAddBrowser ? (
            <button
              type="button"
              onClick={onAddBrowser}
              className="flex h-9 items-center gap-1.5 rounded-[10px] border border-[var(--line)] px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-surface-hover"
            >
              <Globe className="size-3.5" />
              Browser
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onLaunch([null])}
          className="mt-2 w-full text-center text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Just open a blank shell
        </button>
      </div>
    </div>
  );
}
