import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { PROVIDER_SETUP_VERSION } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LinkIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { GettingStarted } from "../components/GettingStarted";
import { ProviderSetup } from "../components/onboarding/ProviderSetup";
import { selectLandingProject } from "../lib/projectLanding";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { RouteLoadingState } from "../components/PaneLoadingState";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  useAllEnvironmentShellsBootstrapped,
  useListedProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { primaryServerConfigAtom } from "../state/server";
import { useProviderSignInRequestStore } from "../providerSignInRequestStore";
import { APP_DISPLAY_NAME } from "~/branding";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments } = useEnvironments();

  if (authGateState.status === "hosted-static" && environments.length === 0) {
    return <HostedStaticOnboardingState />;
  }

  return <IndexDraftLanding />;
}

/**
 * Landing on the index route drops straight into a draft thread for the most
 * recently active project, so the first screen is a prompt instead of a dead
 * end. Falls back to an add-project hero when no project exists yet.
 */
function IndexDraftLanding() {
  const projects = useListedProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const pendingSignIn = useProviderSignInRequestStore((state) => state.pending);
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const mostRecentProject = useMemo(
    () =>
      bootstrapped ? selectLandingProject(projects, threads, pendingSignIn?.environmentId) : null,
    [bootstrapped, projects, threads, pendingSignIn?.environmentId],
  );

  useEffect(() => {
    if (mostRecentProject === null || startingRef.current) {
      return;
    }
    startingRef.current = true;
    void handleNewThread(scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id), {
      replace: true,
    }).catch(() => {
      startingRef.current = false;
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [handleNewThread, mostRecentProject, startState.retryRequest]);

  if (!bootstrapped) {
    return <RouteLoadingState label="Loading your workspace…" />;
  }
  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : (
      <RouteLoadingState label="Opening…" />
    );
  }
  return <NoProjectsHero />;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RotateCcwIcon className="size-4" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

/**
 * A fresh environment opens provider setup until it is finished or skipped,
 * then the getting-started checklist, which can reopen setup.
 */
function NoProjectsHero() {
  const config = useAtomValue(primaryServerConfigAtom);
  const pendingSignIn = useProviderSignInRequestStore((state) => state.pending);
  const [setupOverride, setSetupOverride] = useState<"open" | "closed" | null>(null);
  const setupPending =
    config !== null && config.settings.providerSetupVersion < PROVIDER_SETUP_VERSION;
  const showSetup = setupOverride === "open" || (setupOverride === null && setupPending);
  const connectedProviders = (config?.providers ?? [])
    .filter(
      (provider) =>
        provider.enabled && provider.installed && provider.auth.status === "authenticated",
    )
    .map((provider) => provider.displayName ?? provider.driver);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-background pt-12">
        {showSetup ? (
          <ProviderSetup onDone={() => setSetupOverride("closed")} />
        ) : (
          <GettingStarted
            connectedProviders={connectedProviders}
            pendingSignInName={pendingSignIn?.displayName ?? null}
            onSetUpProviders={() => setSetupOverride("open")}
          />
        )}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "workspace-topbar border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">Connect your computer</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                Open Solla Code on the computer where your projects live. In Settings → Connections,
                choose Show QR code, then open its connection link on this device.
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  Enter connection link
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
