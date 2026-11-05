"use client";

import {
  ACCOUNT_PROVIDER_LABELS,
  accountDisplayName,
  accountEventSentence,
  accountRemovalQuestion,
  accountSignInUrl,
  accountsRemovedAlongside,
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
  ChevronRightIcon,
  EllipsisIcon,
  HardDriveIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  Trash2Icon,
  UserRoundIcon,
  XIcon,
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

const placesLabel = (count: number) => (count === 1 ? "1 place" : `${count} places`);

function AccountRow(props: {
  readonly account: AccountSummary;
  readonly environmentId: EnvironmentId | null;
  readonly ownerLabel: (owner: PreviewAccountOwner) => string;
  readonly busy: boolean;
  readonly onSignOut: (session: PreviewAccountSession) => void;
  readonly onSignInAgain: (session: PreviewAccountSession) => void;
  readonly onUseIn: (session: PreviewAccountSession, to: PreviewBrowserProfile) => void;
  readonly onRemove: (sessions: ReadonlyArray<PreviewAccountSession>, whole: boolean) => void;
}) {
  const { account, busy } = props;
  const targets = useProfileTargets(props.environmentId);
  const source = account.profiles.find((profile) => profile.live);
  const signedIn = new Set(
    account.profiles.filter((profile) => profile.live).map((profile) => profile.owner.ownerId),
  );
  const availableProjects = targets.projects.filter((target) => !signedIn.has(target.ownerId));
  const availableAgents = targets.agents.filter((target) => !signedIn.has(target.ownerId));
  const provider = ACCOUNT_PROVIDER_LABELS[account.provider];
  return (
    <li className="overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          aria-hidden
          className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-foreground"
        >
          {provider.slice(0, 1)}
          {account.live ? (
            <span className="absolute right-0 bottom-0 size-2.5 rounded-full bg-success ring-2 ring-card" />
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {account.identity ?? `${provider} account`}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {provider} · {account.live ? `Signed in, ${placesLabel(signedIn.size)}` : "Signed out"}
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
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy}
                aria-label={`More for ${account.identity ?? provider}`}
              >
                <EllipsisIcon />
              </Button>
            }
          />
          <MenuPopup align="end" className="w-48">
            <MenuItem variant="destructive" onClick={() => props.onRemove(account.profiles, true)}>
              <Trash2Icon />
              Remove account
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <ul className="divide-y divide-border/50 border-t border-border/50">
        {account.profiles.map((profile) => (
          <li key={profile.directory} className="flex min-h-10 items-center gap-2 px-4 py-1.5">
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {props.ownerLabel(profile.owner)}
            </span>
            {profile.owner.kind === "agent" ? (
              <span className="shrink-0 text-xs text-muted-foreground">Agent</span>
            ) : null}
            {profile.linked ? (
              <span className="shrink-0 text-xs text-muted-foreground">Linked</span>
            ) : null}
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
              <>
                <span className="shrink-0 text-xs text-muted-foreground">Signed out</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => props.onSignInAgain(profile)}
                >
                  Sign in
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Remove from ${props.ownerLabel(profile.owner)}`}
                  title="Remove"
                  onClick={() => props.onRemove([profile], false)}
                >
                  <XIcon />
                </Button>
              </>
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

  const remove = useCallback(
    async (sessions: ReadonlyArray<PreviewAccountSession>, whole: boolean) => {
      const first = sessions[0];
      if (!first) return;
      const confirmed = await confirmInApp(
        accountRemovalQuestion({
          name: accountDisplayName(first),
          from: whole ? null : ownerLabel(first.owner),
          alsoSignedOut: accountsRemovedAlongside(sessions, snapshot?.sessions ?? []),
        }),
        { confirmLabel: "Remove" },
      );
      if (!confirmed) return;
      await act(async () => {
        for (const session of sessions) {
          await source.signOut({ provider: session.provider, directory: session.directory });
        }
      }, "Could not remove that account.");
    },
    [act, ownerLabel, snapshot, source],
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
        title="Accounts"
        icon={<UserRoundIcon className="size-5" />}
        headerAction={
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={refreshing}
            aria-label="Check accounts again"
            title="Check again"
            onClick={() => void load(true)}
          >
            <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
          </Button>
        }
      >
        <p className="mb-3 max-w-2xl px-3 text-sm text-muted-foreground sm:px-4">
          Each project and agent has its own browser. Sign in once and it holds there.
        </p>
        {error ? (
          <Alert variant="error" className="mb-3">
            <LockKeyholeIcon />
            <AlertTitle>Accounts</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {snapshot !== null && accounts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-6 py-8 text-center">
            <UserRoundIcon className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">No accounts yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Sign in to Google, GitHub, Microsoft, or Apple in a project's browser and it appears
              here.
            </p>
          </div>
        ) : null}
        <ul className="flex flex-col gap-3">
          {accounts.map((account) => (
            <AccountRow
              key={account.key}
              account={account}
              environmentId={environmentId}
              ownerLabel={ownerLabel}
              busy={busy}
              onSignOut={(session) => void signOut(session)}
              onSignInAgain={signInAgain}
              onRemove={(sessions, whole) => void remove(sessions, whole)}
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
          <details className="group mt-3 px-3 sm:px-4">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
              Recent sign-outs
            </summary>
            <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
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
          </details>
        ) : null}
        {snapshot !== null ? (
          <p
            id="setting-browser-data"
            className="mt-3 flex items-center gap-1.5 px-3 text-xs text-muted-foreground sm:px-4"
          >
            <HardDriveIcon className="size-3.5 shrink-0" aria-hidden />
            {snapshot.profileCount} browser {snapshot.profileCount === 1 ? "profile" : "profiles"},{" "}
            {snapshot.encryptedProfileCount} encrypted
            {snapshot.retiredProfileCount > 0
              ? `, ${snapshot.retiredProfileCount} waiting to be deleted`
              : ""}
          </p>
        ) : null}
      </SettingsSection>
    </>
  );
}
