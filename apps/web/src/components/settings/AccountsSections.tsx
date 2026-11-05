"use client";

import {
  ACCOUNT_PROVIDER_LABELS,
  accountDisplayName,
  accountEventSentence,
  accountSignInUrl,
  summarizeAccounts,
  type AccountSummary,
} from "@t3tools/client-runtime/preview/account-summary";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { credentialErrorMessage } from "@t3tools/client-runtime/preview/credential-form";
import {
  isAgentsProjectId,
  type DesktopPreviewBridge,
  type EnvironmentId,
  type PreviewAccountOwner,
  type PreviewAccountSession,
  type PreviewAccountsSnapshot,
  type PreviewBrowserProfile,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  HardDriveIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  UserRoundIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { threadForAccountOwner } from "~/browser/accountSignInTarget";
import { useProjects, useThreadShells } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { openUrlInThreadPreview } from "../preview/openUrlInThreadPreview";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { confirmInApp } from "../ui/appConfirm";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingsSection } from "./settingsLayout";

/** What the page needs, from the desktop directly or relayed through the server. */
export type AccountsSource = Pick<
  NonNullable<DesktopPreviewBridge["accounts"]>,
  "snapshot" | "signOut" | "link"
>;

function useOwnerLabel() {
  const projects = useProjects();
  const threadShells = useThreadShells();
  return useCallback(
    (owner: PreviewAccountOwner): string => {
      if (owner.kind === "project") {
        return (
          projects.find(
            (project) =>
              project.environmentId === owner.environmentId && project.id === owner.ownerId,
          )?.title ?? "a removed project"
        );
      }
      return (
        threadShells.find(
          (thread) => thread.environmentId === owner.environmentId && thread.id === owner.ownerId,
        )?.title ?? "a removed agent"
      );
    },
    [projects, threadShells],
  );
}

/** Everywhere an account could be given to: every project, and every agent. */
function useProfileTargets(environmentId: EnvironmentId | null) {
  const projects = useProjects();
  const threadShells = useThreadShells();
  return useMemo(() => {
    if (environmentId === null) return { projects: [], agents: [] };
    return {
      projects: projects
        .filter(
          (project) => project.environmentId === environmentId && !isAgentsProjectId(project.id),
        )
        .map((project) => ({
          key: `project:${project.id}`,
          label: project.title,
          ownerId: project.id as string,
          profile: { kind: "project", projectId: project.id } as PreviewBrowserProfile,
        })),
      agents: threadShells
        .filter(
          (thread) =>
            thread.environmentId === environmentId &&
            isAgentsProjectId(thread.projectId) &&
            !thread.browserProfileThreadId,
        )
        .map((thread) => ({
          key: `agent:${thread.id}`,
          label: thread.title,
          ownerId: thread.id as string,
          profile: { kind: "agent", rootThreadId: thread.id } as PreviewBrowserProfile,
        })),
    };
  }, [environmentId, projects, threadShells]);
}

interface UseInTarget {
  readonly key: string;
  readonly label: string;
  readonly profile: PreviewBrowserProfile;
}

/** Picks a project or agent to sign in with an account. A group label needs its group. */
export function UseInMenu(props: {
  readonly projects: ReadonlyArray<UseInTarget>;
  readonly agents: ReadonlyArray<UseInTarget>;
  readonly disabled: boolean;
  readonly defaultOpen?: boolean;
  readonly onPick: (profile: PreviewBrowserProfile) => void;
}) {
  const group = (label: string, targets: ReadonlyArray<UseInTarget>) =>
    targets.length > 0 ? (
      <MenuGroup>
        <MenuGroupLabel>{label}</MenuGroupLabel>
        {targets.map((target) => (
          <MenuItem key={target.key} onClick={() => props.onPick(target.profile)}>
            {target.label}
          </MenuItem>
        ))}
      </MenuGroup>
    ) : null;
  return (
    <Menu {...(props.defaultOpen === undefined ? {} : { defaultOpen: props.defaultOpen })}>
      <MenuTrigger
        render={
          <Button size="sm" variant="outline" disabled={props.disabled}>
            Use in…
            <ChevronDownIcon />
          </Button>
        }
      />
      <MenuPopup align="end" className="w-64">
        {group("Projects", props.projects)}
        {group("Agents", props.agents)}
      </MenuPopup>
    </Menu>
  );
}

function AccountRow(props: {
  readonly account: AccountSummary;
  readonly environmentId: EnvironmentId | null;
  readonly ownerLabel: (owner: PreviewAccountOwner) => string;
  readonly busy: boolean;
  readonly onSignOut: (session: PreviewAccountSession) => void;
  readonly onSignInAgain: (session: PreviewAccountSession) => void;
  readonly onUseIn: (session: PreviewAccountSession, to: PreviewBrowserProfile) => void;
}) {
  const { account, busy } = props;
  const targets = useProfileTargets(props.environmentId);
  const source = account.profiles.find((profile) => profile.live);
  const signedIn = new Set(
    account.profiles.filter((profile) => profile.live).map((profile) => profile.owner.ownerId),
  );
  const availableProjects = targets.projects.filter((target) => !signedIn.has(target.ownerId));
  const availableAgents = targets.agents.filter((target) => !signedIn.has(target.ownerId));
  return (
    <li className="rounded-lg border border-border/70 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <UserRoundIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {account.identity ?? `${ACCOUNT_PROVIDER_LABELS[account.provider]} account`}
          </p>
          <p className="text-xs text-muted-foreground">
            {ACCOUNT_PROVIDER_LABELS[account.provider]} ·{" "}
            {account.live ? "Signed in" : "Signed out"}
          </p>
        </div>
        {source && availableProjects.length + availableAgents.length > 0 ? (
          <UseInMenu
            projects={availableProjects}
            agents={availableAgents}
            disabled={busy}
            onPick={(profile) => props.onUseIn(source, profile)}
          />
        ) : null}
      </div>
      <ul className="mt-2 flex flex-col gap-1 border-t border-border/50 pt-2">
        {account.profiles.map((profile) => (
          <li key={profile.directory} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {props.ownerLabel(profile.owner)}
              {profile.owner.kind === "agent" ? " · agent" : ""}
              {profile.linked ? " · linked" : ""}
              {profile.live ? "" : " · signed out"}
            </span>
            {profile.live ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => props.onSignOut(profile)}
              >
                Sign out
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => props.onSignInAgain(profile)}
              >
                Sign in again
              </Button>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Settings → Accounts: who is signed in where, what happened lately, and what is kept. */
export function AccountsSections(props: {
  readonly source: AccountsSource;
  readonly environmentId: EnvironmentId | null;
}) {
  const { environmentId, source } = props;
  const [snapshot, setSnapshot] = useState<PreviewAccountsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const ownerLabel = useOwnerLabel();
  const threadShells = useThreadShells();
  const navigate = useNavigate();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  const load = useCallback(
    async (refresh: boolean) => {
      setRefreshing(true);
      try {
        setSnapshot(await source.snapshot({ refresh }));
        setError(null);
      } catch (cause) {
        setError(credentialErrorMessage(cause, "Could not check your accounts."));
      } finally {
        setRefreshing(false);
      }
    },
    [source],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const act = useCallback(
    async (action: () => Promise<void>, fallback: string) => {
      setBusy(true);
      try {
        await action();
        await load(false);
      } catch (cause) {
        setError(credentialErrorMessage(cause, fallback));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const signOut = useCallback(
    async (session: PreviewAccountSession) => {
      const confirmed = await confirmInApp(
        `Sign out of ${accountDisplayName(session)} in ${ownerLabel(session.owner)}?`,
        { confirmLabel: "Sign out" },
      );
      if (!confirmed) return;
      await act(
        () => source.signOut({ provider: session.provider, directory: session.directory }),
        "Could not sign out.",
      );
    },
    [act, ownerLabel, source],
  );

  const signInAgain = useCallback(
    (session: PreviewAccountSession) => {
      const threadId: ThreadId | null = threadForAccountOwner({
        owner: session.owner,
        activeThreadId: null,
        threads: threadShells.map((shell) => ({
          id: shell.id,
          environmentId: shell.environmentId,
          projectId: shell.projectId,
          updatedAt: shell.updatedAt,
          browserProfileThreadId: shell.browserProfileThreadId,
        })),
      });
      if (threadId === null) {
        setError("Start a thread in this project first, then sign in from its browser.");
        return;
      }
      const threadRef = scopeThreadRef(session.owner.environmentId as EnvironmentId, threadId);
      void openUrlInThreadPreview({
        threadRef,
        url: accountSignInUrl(session.provider, session.identity),
        openPreview,
        openExternally: () => undefined,
      }).then(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: threadRef.environmentId, threadId },
        }),
      );
    },
    [navigate, openPreview, threadShells],
  );

  const accounts = useMemo(
    () => (snapshot ? summarizeAccounts(snapshot.sessions) : []),
    [snapshot],
  );
  const events = (snapshot?.recentEvents ?? [])
    .filter((event) => event.reason !== "signed-in")
    .slice(0, 5);

  return (
    <>
      <SettingsSection
        id="setting-signed-in-accounts"
        title="Signed-in accounts"
        icon={<UserRoundIcon className="size-5" />}
        headerAction={
          <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void load(true)}>
            <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
            Check again
          </Button>
        }
      >
        <p className="mb-4 max-w-2xl px-3 text-sm leading-relaxed text-muted-foreground sm:px-0">
          Each project has its own browser, shared by all its threads, so signing in once holds
          across that project. Each agent has its own too, and starts signed out. Use an account in
          another project or agent here, and it stays signed in on both.
        </p>
        {error ? (
          <Alert variant="error" className="mb-3">
            <LockKeyholeIcon />
            <AlertTitle>Accounts</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {snapshot !== null && accounts.length === 0 ? (
          <p className="px-3 text-sm text-muted-foreground sm:px-0">
            No Google, GitHub, Microsoft, or Apple sign-ins yet. Sign in on a site in a project's
            browser and it appears here.
          </p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => (
            <AccountRow
              key={account.key}
              account={account}
              environmentId={environmentId}
              ownerLabel={ownerLabel}
              busy={busy}
              onSignOut={(session) => void signOut(session)}
              onSignInAgain={signInAgain}
              onUseIn={(session, to) => {
                if (environmentId === null) return;
                void act(
                  () =>
                    source.link({
                      provider: session.provider,
                      fromDirectory: session.directory,
                      environmentId,
                      to,
                    }),
                  "Could not use that account there.",
                );
              }}
            />
          ))}
        </ul>
        {events.length > 0 ? (
          <div className="mt-4 px-3 sm:px-0">
            <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">Recent sign-outs</h4>
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {events.map((event) => (
                <li key={`${event.at}-${event.directory}-${event.provider}`}>
                  <time dateTime={event.at} className="tabular-nums">
                    {new Date(event.at).toLocaleString()}
                  </time>
                  {" · "}
                  {accountEventSentence(event, ownerLabel)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SettingsSection>
      {snapshot !== null ? (
        <SettingsSection
          id="setting-browser-data"
          title="Browser data"
          icon={<HardDriveIcon className="size-5" />}
        >
          <p className="max-w-2xl px-3 text-sm leading-relaxed text-muted-foreground sm:px-0">
            {snapshot.profileCount} browser {snapshot.profileCount === 1 ? "profile" : "profiles"},{" "}
            {snapshot.encryptedProfileCount} with encrypted cookies
            {snapshot.retiredProfileCount > 0
              ? `, ${snapshot.retiredProfileCount} set aside for removal`
              : ""}
            . When a project or agent is removed, Solla Code sets its browser data aside and deletes
            it after three days.
          </p>
        </SettingsSection>
      ) : null}
    </>
  );
}
