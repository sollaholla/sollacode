import type {
  DesktopPermissionId,
  DesktopPermissionState,
  DesktopPermissionsBridge,
  DesktopPermissionsSnapshot,
} from "@t3tools/contracts";
import {
  CheckIcon,
  CircleHelpIcon,
  HardDriveIcon,
  LockKeyholeIcon,
  MicIcon,
  MonitorUpIcon,
  MousePointer2Icon,
  RefreshCwIcon,
  RotateCwIcon,
  SettingsIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

interface PermissionCopy {
  readonly title: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly icon: ComponentType<{ className?: string }>;
}

const PERMISSION_COPY: Readonly<Record<DesktopPermissionId, PermissionCopy>> = {
  "full-disk-access": {
    title: "Full Disk Access",
    description:
      "Covers protected Desktop, Documents, Downloads, and other app data so agent commands do not trigger separate macOS prompts.",
    recommended: true,
    icon: HardDriveIcon,
  },
  microphone: {
    title: "Microphone",
    description: "Used only for push-to-talk and voice orchestrator conversations you start.",
    recommended: false,
    icon: MicIcon,
  },
  "screen-recording": {
    title: "Screen Recording",
    description: "Lets a remote device view this Mac when you approve a remote-control session.",
    recommended: false,
    icon: MonitorUpIcon,
  },
  accessibility: {
    title: "Accessibility",
    description:
      "Lets a remote device send pointer and keyboard input after you approve remote control.",
    recommended: false,
    icon: MousePointer2Icon,
  },
};

const STATUS_COPY = {
  granted: { label: "Enabled", variant: "success" as const, icon: CheckIcon },
  denied: { label: "Needs attention", variant: "warning" as const, icon: LockKeyholeIcon },
  "not-determined": {
    label: "Not requested",
    variant: "secondary" as const,
    icon: CircleHelpIcon,
  },
  restricted: { label: "Restricted", variant: "error" as const, icon: LockKeyholeIcon },
  unknown: { label: "Can't verify", variant: "outline" as const, icon: CircleHelpIcon },
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The permission request could not be completed.";
}

interface PermissionController {
  readonly bridge: DesktopPermissionsBridge | undefined;
  readonly snapshot: DesktopPermissionsSnapshot | null;
  readonly loading: boolean;
  readonly busyId: DesktopPermissionId | null;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly act: (permission: DesktopPermissionState) => Promise<void>;
  readonly manage: (id: DesktopPermissionId) => Promise<void>;
  readonly complete: () => Promise<void>;
  readonly relaunch: () => Promise<void>;
}

function usePermissionController(): PermissionController {
  const bridge = window.desktopBridge?.permissions;
  const [snapshot, setSnapshot] = useState<DesktopPermissionsSnapshot | null>(null);
  const [loading, setLoading] = useState(bridge !== undefined);
  const [busyId, setBusyId] = useState<DesktopPermissionId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    try {
      setSnapshot(await bridge.getSnapshot());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!bridge) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [bridge, refresh]);

  const act = useCallback(
    async (permission: DesktopPermissionState) => {
      if (!bridge) return;
      setBusyId(permission.id);
      setError(null);
      try {
        if (permission.canRequest) {
          setSnapshot(await bridge.request({ id: permission.id }));
        } else {
          await bridge.openSystemSettings({ id: permission.id });
        }
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusyId(null);
      }
    },
    [bridge],
  );

  const manage = useCallback(
    async (id: DesktopPermissionId) => {
      if (!bridge) return;
      setBusyId(id);
      setError(null);
      try {
        await bridge.openSystemSettings({ id });
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusyId(null);
      }
    },
    [bridge],
  );

  const complete = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    try {
      setSnapshot(await bridge.completeOnboarding());
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [bridge]);

  const relaunch = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    try {
      await bridge.relaunch();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [bridge]);

  return { bridge, snapshot, loading, busyId, error, refresh, act, manage, complete, relaunch };
}

function PermissionCard({
  permission,
  busy,
  onAct,
  onManage,
}: {
  permission: DesktopPermissionState;
  busy: boolean;
  onAct: () => void;
  onManage: () => void;
}) {
  const copy = PERMISSION_COPY[permission.id];
  const status = STATUS_COPY[permission.status];
  const Icon = copy.icon;
  const StatusIcon = status.icon;
  const granted = permission.status === "granted";

  return (
    <div
      data-permission-id={permission.id}
      className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card/60 p-4 shadow-xs sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3.5">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
          <Icon className="size-4.5" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
              {copy.title}
            </h3>
            {copy.recommended ? (
              <Badge variant="info" size="sm">
                Recommended
              </Badge>
            ) : null}
            <Badge variant={status.variant} size="sm">
              <StatusIcon />
              {status.label}
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
            {copy.description}
          </p>
          {permission.requiresRestart && !granted ? (
            <p className="mt-1 text-xs text-muted-foreground">Restart after changing this grant.</p>
          ) : null}
          {permission.id === "full-disk-access" && permission.status === "denied" ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Already enabled in System Settings? Remove the old Solla Code entry, add the current
              app again, then restart. Local rebuilds can otherwise leave a stale grant behind.
            </p>
          ) : null}
          {(permission.id === "screen-recording" || permission.id === "accessibility") &&
          permission.status === "denied" ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Already on in System Settings? Turn Solla Code off and on again, then use Restart
              Solla Code below. A grant left by an older local build does not authorize the current
              signed app.
            </p>
          ) : null}
        </div>
      </div>
      <Button
        size="sm"
        variant={granted ? "outline" : permission.canRequest ? "default" : "secondary"}
        disabled={busy}
        aria-label={`${granted ? "Manage" : permission.canRequest ? "Enable" : "Open System Settings for"} ${copy.title}`}
        onClick={granted ? onManage : onAct}
      >
        {busy ? <RefreshCwIcon className="animate-spin" /> : <SettingsIcon />}
        {granted ? "Manage" : permission.canRequest ? "Enable" : "Open Settings"}
      </Button>
    </div>
  );
}

export function DesktopPermissionsView({
  snapshot,
  busyId,
  error,
  onboarding,
  onAct,
  onManage,
  onRefresh,
  onComplete,
  onRelaunch,
}: {
  snapshot: DesktopPermissionsSnapshot;
  busyId: DesktopPermissionId | null;
  error: string | null;
  onboarding: boolean;
  onAct: (permission: DesktopPermissionState) => void;
  onManage: (id: DesktopPermissionId) => void;
  onRefresh: () => void;
  onComplete: () => void;
  onRelaunch: () => void;
}) {
  const unavailableCount = snapshot.permissions.filter(
    (permission) => permission.status !== "granted",
  ).length;
  const shouldOfferRelaunch = snapshot.permissions.some(
    (permission) => permission.status !== "granted" && permission.requiresRestart,
  );

  return (
    <div className={cn("w-full", onboarding && "mx-auto max-w-3xl")}>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {/* The hero badge and title are onboarding chrome. In settings the
              SettingsSection header already shows a shield and "Permissions",
              so repeating them here stacked two badges and two titles. */}
          {onboarding ? (
            <>
              <div className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <ShieldCheckIcon className="size-5" />
              </div>
              <h1 className="text-2xl font-semibold tracking-[-0.035em] text-foreground">
                Set permissions before agents get to work
              </h1>
            </>
          ) : null}
          <p
            className={cn(
              "max-w-2xl text-sm leading-relaxed text-muted-foreground",
              onboarding && "mt-2",
            )}
          >
            Solla Code checks status without prompting. macOS consent appears only when you choose
            Enable, and you can revisit every grant here later.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh}>
          <RefreshCwIcon />
          Refresh
        </Button>
      </div>

      {error ? (
        <Alert variant="error" className="mb-4">
          <LockKeyholeIcon />
          <AlertTitle>Permission check failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-3">
        {snapshot.permissions.map((permission) => (
          <PermissionCard
            key={permission.id}
            permission={permission}
            busy={busyId === permission.id}
            onAct={() => onAct(permission)}
            onManage={() => onManage(permission.id)}
          />
        ))}
      </div>

      <div className="mt-6 flex flex-col-reverse gap-3 border-t border-border/70 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-relaxed text-muted-foreground">
          macOS owns these switches. Turning a grant off opens System Settings rather than changing
          it silently.
        </p>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {shouldOfferRelaunch ? (
            <Button variant="outline" onClick={onRelaunch}>
              <RotateCwIcon />
              Restart Solla Code
            </Button>
          ) : null}
          {onboarding ? (
            <Button onClick={onComplete}>
              {unavailableCount === 0
                ? "Continue to Solla Code"
                : `Continue with ${unavailableCount} unavailable`}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PermissionLoading({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
      <div className="text-center">
        <ShieldCheckIcon className="mx-auto size-7 text-primary" />
        <p className="mt-3 text-sm font-medium">Checking macOS permissions…</p>
        {children}
      </div>
    </div>
  );
}

export function shouldShowDesktopPermissionsOnboarding(
  snapshot: DesktopPermissionsSnapshot,
): boolean {
  return snapshot.supported && snapshot.onboardingRequired;
}

export function DesktopPermissionsGate({ children }: { children: ReactNode }) {
  const controller = usePermissionController();
  const [bypassed, setBypassed] = useState(false);

  if (!controller.bridge || bypassed) return children;
  if (controller.loading && controller.snapshot === null) return <PermissionLoading />;
  if (controller.snapshot === null) {
    return (
      <PermissionLoading>
        <p role="alert" className="mt-2 max-w-sm text-xs text-destructive">
          {controller.error ?? "Solla Code could not read permission status."}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void controller.refresh()}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setBypassed(true)}>
            Continue for now
          </Button>
        </div>
      </PermissionLoading>
    );
  }
  if (!shouldShowDesktopPermissionsOnboarding(controller.snapshot)) {
    return children;
  }

  return (
    <div className="min-h-dvh overflow-y-auto bg-background text-foreground">
      <div className="drag-region h-[52px] w-full" />
      <main className="px-5 pt-6 pb-10 sm:px-8 sm:pt-10">
        <DesktopPermissionsView
          snapshot={controller.snapshot}
          busyId={controller.busyId}
          error={controller.error}
          onboarding
          onAct={(permission) => void controller.act(permission)}
          onManage={(id) => void controller.manage(id)}
          onRefresh={() => void controller.refresh()}
          onComplete={() => void controller.complete()}
          onRelaunch={() => void controller.relaunch()}
        />
        {controller.error ? (
          <div className="mx-auto mt-3 flex max-w-3xl justify-end">
            <Button variant="ghost" size="sm" onClick={() => setBypassed(true)}>
              Continue for now
            </Button>
          </div>
        ) : null}
      </main>
    </div>
  );
}

export function DesktopPermissionsSettingsPanel() {
  const controller = usePermissionController();
  let content: ReactNode;
  if (!controller.bridge) {
    content = (
      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>Available in the macOS desktop app</AlertTitle>
        <AlertDescription>
          Operating-system permissions are managed by the Mac hosting Solla Code.
        </AlertDescription>
      </Alert>
    );
  } else if (controller.snapshot === null) {
    content = controller.loading ? (
      <div className="py-10 text-center text-sm text-muted-foreground">
        Checking macOS permissions…
      </div>
    ) : (
      <Alert variant="error">
        <LockKeyholeIcon />
        <AlertTitle>Permission status unavailable</AlertTitle>
        <AlertDescription>
          {controller.error ?? "Solla Code could not read permission status."}
        </AlertDescription>
      </Alert>
    );
  } else {
    content = (
      <DesktopPermissionsView
        snapshot={controller.snapshot}
        busyId={controller.busyId}
        error={controller.error}
        onboarding={false}
        onAct={(permission) => void controller.act(permission)}
        onManage={(id) => void controller.manage(id)}
        onRefresh={() => void controller.refresh()}
        onComplete={() => undefined}
        onRelaunch={() => void controller.relaunch()}
      />
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="Permissions" icon={<ShieldCheckIcon className="size-5" />}>
        {content}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
