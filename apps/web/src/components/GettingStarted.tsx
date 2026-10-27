import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  FolderOpenIcon,
  MonitorSmartphoneIcon,
  PlugIcon,
} from "lucide-react";

import { openCommandPalette } from "../commandPaletteBus";
import { Button } from "./ui/button";

/** The first workspace offers real setup actions before any project exists. */
export function GettingStarted({
  connectedProviders,
  pendingSignInName,
  onSetUpProviders,
}: {
  readonly connectedProviders: readonly string[];
  readonly pendingSignInName: string | null;
  readonly onSetUpProviders: () => void;
}) {
  const hasAccount = connectedProviders.length > 0;
  const accountSummary = summarizeProviderNames(connectedProviders);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col px-5 py-10 sm:px-8 sm:py-16">
      <p className="text-xs font-medium tracking-wide text-muted-foreground">GET STARTED</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        Start your first project
      </h1>
      <p className="mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">
        Connect an AI account, then choose a folder to work in. No separate Solla Code account is
        needed.
      </p>
      {pendingSignInName ? (
        <p
          role="status"
          className="mt-4 rounded-lg border border-border bg-muted/40 p-4 text-sm text-foreground"
        >
          Open a project on the computer you are signing in to. Then {pendingSignInName} sign-in
          will continue in its terminal.
        </p>
      ) : null}
      <ol className="mt-8 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/30">
        <li className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
              {hasAccount ? (
                <CheckIcon aria-hidden className="size-4 text-success" />
              ) : (
                <PlugIcon aria-hidden className="size-4" />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-medium text-foreground">
                {hasAccount ? "AI account connected" : "Connect an AI account"}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {hasAccount
                  ? `${accountSummary} ${connectedProviders.length === 1 ? "is" : "are"} signed in on this computer.`
                  : "Sign in to Codex, Claude, or another provider. Existing accounts on this computer are detected automatically."}
              </p>
            </div>
          </div>
          <Button variant="outline" className="shrink-0" onClick={onSetUpProviders}>
            {hasAccount ? "Add providers" : "Set up providers"}
          </Button>
        </li>
        <li className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
              <FolderOpenIcon aria-hidden className="size-4" />
            </div>
            <div>
              <h2 className="text-sm font-medium text-foreground">Choose a project folder</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Open an existing folder or create one. Your threads and changes stay organized by
                project.
              </p>
            </div>
          </div>
          <Button className="shrink-0" onClick={() => openCommandPalette({ open: "add-project" })}>
            Open project <ArrowRightIcon aria-hidden className="size-4" />
          </Button>
        </li>
        <li className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
              <MonitorSmartphoneIcon aria-hidden className="size-4" />
            </div>
            <div>
              <h2 className="text-sm font-medium text-foreground">Continue on another device</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Optional. Pair your phone or another computer to access this workspace.
              </p>
            </div>
          </div>
          <Button variant="ghost" className="shrink-0" render={<Link to="/settings/connections" />}>
            Connect device
          </Button>
        </li>
      </ol>
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
        You can change accounts, add projects, and manage connected devices in Settings at any time.
      </p>
    </div>
  );
}

/** "Codex", "Codex and Claude", or "Codex, Claude, and 3 more". */
function summarizeProviderNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}
