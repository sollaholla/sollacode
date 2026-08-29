"use client";

import type {
  PreviewAutomationConsoleEntry,
  PreviewAutomationNetworkEntry,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";

const LEVEL_STYLES: Record<string, string> = {
  error: "text-red-500",
  warning: "text-amber-500",
  warn: "text-amber-500",
};

/**
 * The console and network log for a guest this machine is not hosting.
 *
 * A browser you cannot open DevTools on is most of the way to useless for
 * building web pages, and DevTools itself is a separate Chromium window rather
 * than pixels in the page, so it cannot ride the mirror the way the picker
 * does. These are the two things it is opened for that the host already
 * collects for every frame — so showing them costs the guest's machine
 * nothing it was not already doing.
 */
export function PreviewRemoteConsole(props: {
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry> | undefined;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry> | undefined;
  readonly className?: string;
}) {
  const { consoleEntries, networkEntries, className } = props;
  const failures = (networkEntries ?? []).filter(
    (entry) => entry.failed || (entry.status !== null && entry.status >= 400),
  );
  const empty = (consoleEntries?.length ?? 0) === 0 && failures.length === 0;

  return (
    <div
      className={cn(
        "flex flex-col overflow-y-auto border-t border-border/70 bg-background/95 font-mono text-[11px] leading-relaxed",
        className,
      )}
    >
      {empty ? (
        <p className="px-3 py-2 text-muted-foreground">
          No console output or failed requests for this page.
        </p>
      ) : null}
      {(consoleEntries ?? []).map((entry) => (
        <div
          key={`console-${entry.timestamp}-${entry.level}-${entry.text}`}
          className="flex gap-2 px-3 py-1 hover:bg-muted/40"
        >
          <span
            className={cn(
              "shrink-0 uppercase",
              LEVEL_STYLES[entry.level] ?? "text-muted-foreground",
            )}
          >
            {entry.level}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{entry.text}</span>
        </div>
      ))}
      {failures.map((entry) => (
        <div
          key={`network-${entry.timestamp}-${entry.method}-${entry.url}`}
          className="flex gap-2 px-3 py-1 text-red-500 hover:bg-muted/40"
        >
          <span className="shrink-0">{entry.status === null ? "failed" : entry.status}</span>
          <span className="shrink-0 text-muted-foreground">{entry.method}</span>
          <span className="min-w-0 truncate">{entry.url}</span>
        </div>
      ))}
    </div>
  );
}
