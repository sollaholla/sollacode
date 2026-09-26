import { type ServerLifecycleWelcomePayload } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  Outlet,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from "react";

import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { resolveServerBackedAppDisplayName } from "../branding.logic";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPaletteLoader } from "../components/CommandPaletteLoader";
import { DesktopPermissionsGate } from "../components/desktop/DesktopPermissions";
import { ProviderUpdateLaunchNotification } from "../components/ProviderUpdateLaunchNotification";
import { StartupResumeCoordinator } from "../components/StartupResumeCoordinator";
import { LanPairingCoordinator } from "../components/LanPairingCoordinator";
import { Button } from "../components/ui/button";
import { AppConfirmHost } from "../components/ui/appConfirm";
import {
  AnchoredToastProvider,
  stackedThreadToast,
  ToastProvider,
  toastManager,
} from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { useClientSettings } from "../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { useUiStateStore } from "../uiStateStore";
import { syncBrowserChromeTheme } from "../hooks/useTheme";
import { configureClientTracing } from "../observability/clientTracing";
import {
  isPrimaryEnvironmentRequestError,
  isTransientBootstrapError,
  resolveInitialServerAuthGateState,
} from "../environments/primary";
import { hasHostedPairingRequest, isHostedStaticApp } from "../hostedPairing";
import { shellEnvironment } from "../state/shell";
import { useAtomValue } from "@effect/atom-react";
import { useAtomCommand } from "../state/use-atom-command";
import { OrchestratorListeningOverlay } from "../components/orchestrator/OrchestratorListeningOverlay";
import { OrchestratorSessionProvider } from "../orchestrator/OrchestratorSessionProvider";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  primaryServerConfigAtom,
  primaryServerConfigEventAtom,
  primaryServerWelcomeAtom,
} from "../state/server";
import {
  readProject,
  setActiveEnvironmentId,
  useActiveEnvironmentId,
  useAllEnvironmentShellsBootstrapped,
} from "../state/entities";
import {
  createKeybindingsUpdateToastController,
  type KeybindingsUpdateToastController,
} from "../components/KeybindingsUpdateToast.logic";
import {
  attemptDynamicImportRecovery,
  dynamicImportRecoveryCleanupDelayMs,
  dynamicImportRecoveryCleanupUrlAfterNavigation,
  dynamicImportRecoveryCleanupUrlWhenStale,
  isDynamicImportFailure,
  reloadWithFreshAppShell,
  shouldAutoRecoverDynamicImportFailure,
} from "./-rootErrorRecovery.logic";
import { installRootErrorAutoRetry } from "./-rootErrorRetry.logic";
import { LazyChatView } from "../lazyChatView";
import { finishStartup, setStartupStage, startupRouteShowsChatView } from "../startupSplash";

const SshPasswordPromptDialog = lazy(() =>
  import("../components/desktop/SshPasswordPromptDialog").then((module) => ({
    default: module.SshPasswordPromptDialog,
  })),
);
const RemoteControlCoordinator = lazy(() =>
  import("../components/remoteControl/RemoteControlCoordinator").then((module) => ({
    default: module.RemoteControlCoordinator,
  })),
);

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/pair" && hasHostedPairingRequest(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-pairing",
        } as const,
      };
    }

    if (isHostedStaticApp(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    // The chat view is most of what a first screen downloads; start it now so
    // it arrives alongside the sign-in check instead of after it.
    if (startupRouteShowsChatView(location.pathname)) {
      void LazyChatView.preload?.().catch(() => undefined);
    }
    const authGateState = await resolveInitialServerAuthGateState();
    return {
      authGateState,
    };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const initialPathnameRef = useRef(pathname);
  const { authGateState } = Route.useRouteContext();
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";
  const desktopBridgeAvailable = window.desktopBridge !== undefined;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  useEffect(() => {
    const cleanUrl = dynamicImportRecoveryCleanupUrlAfterNavigation({
      href: window.location.href,
      initialPathname: initialPathnameRef.current,
      currentPathname: pathname,
    });
    if (cleanUrl !== null) {
      window.history.replaceState(window.history.state, "", cleanUrl);
    }
  }, [pathname]);

  // A client that never navigates (a phone left on one thread) keeps the
  // recovery marker forever. It stops guarding once it ages past the
  // cooldown; drop it then so the address stays clean and a later release's
  // recovery starts from an unmarked URL.
  useEffect(() => {
    const delay = dynamicImportRecoveryCleanupDelayMs({
      href: window.location.href,
      now: Date.now(),
    });
    if (delay === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      const cleanUrl = dynamicImportRecoveryCleanupUrlWhenStale({
        href: window.location.href,
        now: Date.now(),
      });
      if (cleanUrl !== null) {
        window.history.replaceState(window.history.state, "", cleanUrl);
      }
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [pathname]);

  if (pathname === "/pair" || pathname === "/connect" || pathname.startsWith("/connect/")) {
    return (
      <>
        <StartupSplashDone />
        <DocumentTitleSync />
        <Outlet />
      </>
    );
  }

  if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
    return (
      <>
        <StartupSplashDone />
        <DocumentTitleSync />
        <Outlet />
      </>
    );
  }

  const appShell = (
    <OrchestratorSessionProvider>
      <CommandPaletteLoader>
        <AppSidebarLayout>
          <Outlet />
        </AppSidebarLayout>
      </CommandPaletteLoader>
      {/* Inside the provider so it can read the live session, and after the
          shell so it layers over it. */}
      <OrchestratorListeningOverlay />
    </OrchestratorSessionProvider>
  );

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        {/* Mounted unconditionally: a confirmation that cannot render is a
            caller left hanging, which is the failure this replaces. */}
        <AppConfirmHost />
        <StartupSplashGate />
        <DocumentTitleSync />
        <GlassAppearanceSync />
        <DesktopPermissionsGate>
          {primaryEnvironmentAuthenticated ? <AuthenticatedTracingBootstrap /> : null}
          {desktopBridgeAvailable ? (
            <Suspense fallback={null}>
              <SshPasswordPromptDialog />
            </Suspense>
          ) : null}
          {primaryEnvironmentAuthenticated ? <LanPairingCoordinator /> : null}
          {primaryEnvironmentAuthenticated && desktopBridgeAvailable ? (
            <Suspense fallback={null}>
              <RemoteControlCoordinator />
            </Suspense>
          ) : null}
          <HostedStaticEnvironmentBootstrap />
          {primaryEnvironmentAuthenticated ? <EventRouter /> : null}
          {primaryEnvironmentAuthenticated ? <ProviderUpdateLaunchNotification /> : null}
          {primaryEnvironmentAuthenticated ? <StartupResumeCoordinator /> : null}
          {appShell}
        </DesktopPermissionsGate>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

/**
 * Keeps the startup splash up until the first screen can render: the
 * workspace (cached or live) and, when that screen is the chat view, its code.
 * Runs once — the splash never comes back after it is gone.
 */
function StartupSplashGate() {
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const initialPathname = useRef(useLocation({ select: (location) => location.pathname }));

  useEffect(() => {
    if (!bootstrapped) {
      setStartupStage("connecting");
      return;
    }
    let cancelled = false;
    const firstScreenReady = startupRouteShowsChatView(initialPathname.current)
      ? (setStartupStage("opening"), LazyChatView.preload?.() ?? Promise.resolve())
      : Promise.resolve();
    void firstScreenReady
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) finishStartup();
      });
    return () => {
      cancelled = true;
    };
  }, [bootstrapped]);

  return null;
}

/** Screens with nothing to wait for (pairing, sign-in, errors) end startup at once. */
function StartupSplashDone() {
  useEffect(() => {
    finishStartup();
  }, []);
  return null;
}

function GlassAppearanceSync() {
  const glassOpacity = useClientSettings((settings) => settings.glassOpacity);

  useEffect(() => {
    document.documentElement.style.setProperty("--glass-opacity", `${glassOpacity}%`);
  }, [glassOpacity]);

  return null;
}

function DocumentTitleSync() {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;
  const title = resolveServerBackedAppDisplayName({
    baseName: APP_BASE_NAME,
    fallbackDisplayName: APP_DISPLAY_NAME,
    fallbackStageLabel: APP_STAGE_LABEL,
    primaryServerVersion,
  });

  useEffect(() => {
    document.title = title;
  }, [title]);

  return null;
}

function HostedStaticEnvironmentBootstrap() {
  const { environments } = useEnvironments();
  const activeEnvironmentId = useActiveEnvironmentId();

  useEffect(() => {
    if (
      environments.some(
        (environment) => environment.entry.target._tag === "PrimaryConnectionTarget",
      )
    ) {
      return;
    }

    if (activeEnvironmentId) {
      return;
    }

    const firstSavedEnvironment = environments[0];
    if (!firstSavedEnvironment) {
      return;
    }

    setActiveEnvironmentId(firstSavedEnvironment.environmentId);
  }, [activeEnvironmentId, environments]);

  return null;
}

function RootRouteErrorView({ error }: ErrorComponentProps) {
  const router = useRouter();
  const dynamicImportFailure = isDynamicImportFailure(error);
  // The server was out of reach, not broken: try again on our own.
  const unreachable = isPrimaryEnvironmentRequestError(error) && isTransientBootstrapError(error);
  const autoRecoverDynamicImportFailure = shouldAutoRecoverDynamicImportFailure({
    dynamicImportFailure,
    desktopBridgeAvailable: window.desktopBridge !== undefined,
  });
  // The desktop app's own server is on the same machine, so its message is
  // about a second copy holding the port; a phone just lost its connection.
  const unreachableFromAnotherDevice = unreachable && window.desktopBridge === undefined;
  const message = dynamicImportFailure
    ? "This page could not load part of the app. Reload to fetch the current version."
    : unreachableFromAnotherDevice
      ? "Solla Code can't reach its server right now. It keeps trying and loads as soon as the connection is back."
      : errorMessage(error);
  const details = errorDetails(error);

  useEffect(() => {
    if (!autoRecoverDynamicImportFailure) {
      return;
    }

    attemptDynamicImportRecovery({
      appVersion: APP_VERSION,
      error,
      getStorage: () => window.sessionStorage,
      location: window.location,
      now: Date.now(),
    });
  }, [autoRecoverDynamicImportFailure, error]);

  useEffect(() => {
    if (!unreachable) return;
    return installRootErrorAutoRetry({
      window,
      document,
      retry: () => void router.invalidate(),
    });
  }, [unreachable, router]);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <StartupSplashDone />
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          {unreachableFromAnotherDevice ? "Waiting for the connection" : "Something went wrong."}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              if (dynamicImportFailure) {
                reloadWithFreshAppShell(window.location, Date.now());
                return;
              }
              // `reset` alone only re-renders this boundary; a failure while
              // the root route loaded needs the route to run again.
              void router.invalidate();
            }}
          >
            {dynamicImportFailure ? "Reload app" : "Try again"}
          </Button>
          {dynamicImportFailure ? null : (
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              Reload app
            </Button>
          )}
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function AuthenticatedTracingBootstrap() {
  useEffect(() => {
    void configureClientTracing();
  }, []);

  return null;
}

function EventRouter() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironment = usePrimaryEnvironment();
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverConfigEvent = useAtomValue(primaryServerConfigEventAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const handledConfigEventRef = useRef(serverConfigEvent);
  const [keybindingsToastController] = useState<KeybindingsUpdateToastController>(() =>
    createKeybindingsUpdateToastController({}),
  );

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    setActiveEnvironmentId(payload.environment.environmentId);
    void (async () => {
      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      const bootstrapProject = readProject(
        scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
      );
      const bootstrapProjectKey =
        (bootstrapProject
          ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
          : null) ??
        (serverConfig?.cwd
          ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
          : null) ??
        scopedProjectKey(
          scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
        );
      useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

      if (readPathname() !== "/") {
        return;
      }
      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: payload.environment.environmentId,
          threadId: payload.bootstrapThreadId,
        },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  const handleServerConfigUpdated = useEffectEvent(() => {
    const decision = keybindingsToastController.handle(serverConfigEvent);
    if (!decision) {
      return;
    }

    if (decision._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Keybindings updated",
        description: "Keybindings configuration reloaded successfully.",
      });
      return;
    }

    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: decision.message,
        actionVariant: "outline",
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            if (!serverConfig || !primaryEnvironment) {
              return;
            }

            const editor = resolveAndPersistPreferredEditor(serverConfig.availableEditors);
            if (!editor) {
              return;
            }
            void (async () => {
              const result = await openInEditor({
                environmentId: primaryEnvironment.environmentId,
                input: {
                  cwd: serverConfig.keybindingsConfigPath,
                  editor,
                },
              });
              if (result._tag === "Success") {
                return;
              }
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                }),
              );
            })();
          },
        },
      }),
    );
  });

  useEffect(() => {
    if (!serverConfig) {
      return;
    }

    setActiveEnvironmentId(serverConfig.environment.environmentId);
  }, [serverConfig]);

  useEffect(() => {
    handleWelcome(serverWelcome);
  }, [serverWelcome]);

  useEffect(() => {
    if (serverConfigEvent === null || handledConfigEventRef.current === serverConfigEvent) {
      return;
    }
    handledConfigEventRef.current = serverConfigEvent;
    handleServerConfigUpdated();
  }, [serverConfigEvent]);

  return null;
}
