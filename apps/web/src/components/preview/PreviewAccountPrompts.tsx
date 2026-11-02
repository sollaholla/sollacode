"use client";

import { ACCOUNT_PROVIDER_LABELS } from "@t3tools/client-runtime/preview/account-summary";
import type { PreviewAccountPrompt, PreviewAccountPromptAnswer } from "@t3tools/contracts";
import { KeyRoundIcon, UserRoundCheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useProjects } from "~/state/entities";

import { Button } from "../ui/button";

function answer(id: string, value: PreviewAccountPromptAnswer): void {
  void window.desktopBridge?.preview?.accounts.answerPrompt(id, value).catch((error: unknown) => {
    console.error("Could not answer the sign-in question.", error);
  });
}

function PromptBar(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="pointer-events-auto flex w-full max-w-md flex-col gap-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 shrink-0 text-muted-foreground [&>svg]:size-4">{props.icon}</span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-xs font-medium text-foreground">{props.title}</p>
          {props.detail ? (
            <p className="truncate text-[11px] text-muted-foreground">{props.detail}</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">{props.children}</div>
    </div>
  );
}

const compact = "h-7 px-2 text-xs";

function siteOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function RememberPrompt(props: { readonly prompt: PreviewAccountPrompt & { kind: "remember" } }) {
  const { id, origin, update, username } = props.prompt;
  if (update) {
    return (
      <PromptBar
        icon={<KeyRoundIcon />}
        title={`Update the saved password for ${username}?`}
        detail={siteOf(origin)}
      >
        <Button size="sm" variant="ghost" className={compact} onClick={() => answer(id, "dismiss")}>
          Not now
        </Button>
        <Button size="sm" className={compact} onClick={() => answer(id, "accept")}>
          Update
        </Button>
      </PromptBar>
    );
  }
  return (
    <PromptBar
      icon={<KeyRoundIcon />}
      title={`Remember ${username} on this computer?`}
      detail={siteOf(origin)}
    >
      <Button
        size="sm"
        variant="ghost"
        className={compact}
        onClick={() => answer(id, "never-for-site")}
      >
        Never for this site
      </Button>
      <Button size="sm" variant="outline" className={compact} onClick={() => answer(id, "dismiss")}>
        Just this once
      </Button>
      <Button size="sm" className={compact} onClick={() => answer(id, "accept")}>
        Remember
      </Button>
    </PromptBar>
  );
}

function UseAccountPrompt(props: {
  readonly prompt: PreviewAccountPrompt & { kind: "use-account" };
}) {
  const { fromOwner, id, identity, provider } = props.prompt;
  const projects = useProjects();
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === fromOwner.environmentId && candidate.id === fromOwner.ownerId,
  );
  const name = identity ?? `your ${ACCOUNT_PROVIDER_LABELS[provider]} account`;
  return (
    <PromptBar
      icon={<UserRoundCheckIcon />}
      title={`Use ${name}${project ? ` from ${project.title}` : ""}?`}
      detail="Signs this project in too, and keeps both signed in."
    >
      <Button size="sm" variant="ghost" className={compact} onClick={() => answer(id, "dismiss")}>
        Not now
      </Button>
      <Button size="sm" className={compact} onClick={() => answer(id, "accept")}>
        Use account
      </Button>
    </PromptBar>
  );
}

/** Sign-in questions on a browser tab: never a dialog, so the page stays usable behind them. */
export function PreviewAccountPrompts(props: {
  readonly prompts: ReadonlyArray<PreviewAccountPrompt> | undefined;
}) {
  const prompts = props.prompts ?? [];
  if (prompts.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-50 flex flex-col items-center gap-2 p-2"
      data-preview-account-prompts="true"
    >
      {prompts.slice(0, 2).map((prompt) => {
        switch (prompt.kind) {
          case "remember":
            return <RememberPrompt key={prompt.id} prompt={prompt} />;
          case "use-account":
            return <UseAccountPrompt key={prompt.id} prompt={prompt} />;
          case "fill-saved":
            return (
              <PromptBar
                key={prompt.id}
                icon={<KeyRoundIcon />}
                title={
                  prompt.username
                    ? `Fill the saved password for ${prompt.username}?`
                    : "Fill the saved password?"
                }
                detail={siteOf(prompt.origin)}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  className={compact}
                  onClick={() => answer(prompt.id, "dismiss")}
                >
                  Not now
                </Button>
                <Button size="sm" className={compact} onClick={() => answer(prompt.id, "accept")}>
                  Fill
                </Button>
              </PromptBar>
            );
        }
      })}
    </div>
  );
}
