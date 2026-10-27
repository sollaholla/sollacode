import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isAgentsProjectId,
  isOrchestratorProjectId,
  type EnvironmentId,
  type ProviderAccountSwitchState,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LogInIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProviderSignInRequestStore } from "../../providerSignInRequestStore";
import { useListedProjects } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderAccountSwitchConfirmation } from "../chat/ProviderAccountSwitchConfirmation";
import { ProviderAccountSwitchOverlay } from "../chat/ProviderAccountSwitchOverlay";
import {
  isProviderAccountSwitchActive,
  reconcileProviderAccountSwitch,
} from "../chat/providerAccountSwitchState";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

/** Settings owns its sign-in surface, so account setup never requires a chat. */
export function ProviderSettingsSignIn(props: {
  readonly command: string;
  readonly displayName: string;
  readonly driver: ProviderDriverKind | string;
  readonly instanceId: ProviderInstanceId;
  readonly supportsAccountSwitch: boolean;
  readonly signedIn: boolean;
  readonly provider: ServerProvider | null;
}) {
  const environment = usePrimaryEnvironment();
  const projects = useListedProjects();
  const openThread = useNewThreadHandler();
  const navigate = useNavigate();
  const requestSignIn = useProviderSignInRequestStore((state) => state.request);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matchingProject = projects.find(
    (project) =>
      project.environmentId === environment?.environmentId &&
      !isOrchestratorProjectId(project.id) &&
      !isAgentsProjectId(project.id),
  );
  const needsProject = !props.supportsAccountSwitch && !matchingProject;
  const label = props.signedIn ? "Switch account" : `Sign in to ${props.displayName}`;

  const launchTerminalSignIn = async () => {
    if (!environment || launching) return;
    setLaunching(true);
    setError(null);
    requestSignIn({
      environmentId: environment.environmentId,
      instanceId: props.instanceId,
      driver: props.driver,
      displayName: props.displayName,
      command: props.command,
      supportsAccountSwitch: false,
    });
    try {
      if (matchingProject) {
        await openThread(scopeProjectRef(environment.environmentId, matchingProject.id));
      } else {
        await navigate({ to: "/" });
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not open the sign-in terminal. Try again.",
      );
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {props.signedIn ? "Change account" : "Sign in"}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!environment || launching}
          aria-label={needsProject ? `Add a project to sign in to ${props.displayName}` : label}
          onClick={() => {
            if (!props.supportsAccountSwitch) {
              void launchTerminalSignIn();
            } else if (props.signedIn) {
              setConfirmationOpen(true);
            } else {
              setFlowOpen(true);
            }
          }}
        >
          <LogInIcon className="size-3.5" />
          {launching ? "Opening…" : needsProject ? "Add a project to sign in" : label}
        </Button>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {!environment
          ? "Connect a computer before signing in."
          : needsProject
            ? `${props.displayName} uses a terminal to sign in. Choose a project on ${environment.label} first; sign-in will continue there.`
            : `Sign-in runs on ${environment.label}, where ${props.displayName} is installed.`}
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <ProviderAccountSwitchConfirmation
        open={confirmationOpen}
        environmentLabel={environment?.label ?? null}
        authenticationPaused={false}
        onClose={() => setConfirmationOpen(false)}
        onConfirm={() => {
          setConfirmationOpen(false);
          setFlowOpen(true);
        }}
      />
      {flowOpen && environment ? (
        <ProviderSettingsAuthDialog
          key={`${environment.environmentId}:${props.instanceId}`}
          environmentId={environment.environmentId}
          environmentLabel={environment.label}
          instanceId={props.instanceId}
          displayName={props.displayName}
          provider={props.provider}
          onClose={() => setFlowOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function ProviderSettingsAuthDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly provider: ServerProvider | null;
  readonly onClose: () => void;
}) {
  const start = useAtomCommand(serverEnvironment.startProviderAccountSwitch, {
    reportFailure: false,
  });
  const get = useAtomCommand(serverEnvironment.getProviderAccountSwitch, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAccountSwitch, {
    reportFailure: false,
  });
  const submitCode = useAtomCommand(serverEnvironment.submitProviderAccountSwitchCode, {
    reportFailure: false,
  });
  const openLink = useAtomCommand(serverEnvironment.openProviderAccountSwitchAuthLink, {
    reportFailure: false,
  });
  const [flow, setFlow] = useState<ProviderAccountSwitchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const begin = useCallback(async () => {
    const generation = ++generationRef.current;
    setError(null);
    setFlow(null);
    setBusy(true);
    const result = await start({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId },
    });
    if (!mountedRef.current || generation !== generationRef.current) return;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureMessage(result));
    } else {
      setFlow(result.value);
    }
  }, [props.environmentId, props.instanceId, start]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void begin();
  }, [begin]);

  const activeId = flow && isProviderAccountSwitchActive(flow) ? flow.id : null;
  useEffect(() => {
    if (!activeId) return;
    let disposed = false;
    let polling = false;
    let timer: number | undefined;
    const poll = async () => {
      if (disposed || polling || document.visibilityState === "hidden") return;
      polling = true;
      const result = await get({
        environmentId: props.environmentId,
        input: { instanceId: props.instanceId, switchId: activeId },
      });
      polling = false;
      if (disposed) return;
      if (result._tag !== "Failure")
        setFlow((current) => reconcileProviderAccountSwitch(current, activeId, result.value));
      timer = window.setTimeout(() => void poll(), 750);
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeId, get, props.environmentId, props.instanceId]);

  const actOnFlow = async (action: "cancel" | "open" | "code", code?: string) => {
    if (!flow || busy) return false;
    const switchId = flow.id;
    const input = { instanceId: props.instanceId, switchId };
    setBusy(true);
    setError(null);
    if (action === "open") {
      const result = await openLink({ environmentId: props.environmentId, input });
      if (!mountedRef.current) return false;
      setBusy(false);
      if (result._tag === "Failure") setError(failureMessage(result));
      return result._tag !== "Failure";
    }
    const result =
      action === "cancel"
        ? await cancel({ environmentId: props.environmentId, input })
        : await submitCode({
            environmentId: props.environmentId,
            input: { ...input, code: code ?? "" },
          });
    if (!mountedRef.current) return false;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureMessage(result));
      return false;
    }
    setFlow((current) => reconcileProviderAccountSwitch(current, switchId, result.value));
    return true;
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-h-[90dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Sign in to {props.displayName}</DialogTitle>
          <DialogDescription>
            Authentication runs on {props.environmentLabel}. Complete the provider’s login there.
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 pb-5">
          {error ? (
            <p
              role="alert"
              className="mb-3 rounded-lg bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
          {flow ? (
            <ProviderAccountSwitchOverlay
              embedded
              state={flow}
              provider={props.provider}
              cancelling={busy}
              submittingCode={busy}
              onCancel={() => void actOnFlow("cancel")}
              onDismiss={props.onClose}
              onOpenAuthLink={() => void actOnFlow("open")}
              onRetry={() => void begin()}
              onSubmitAuthCode={(code) => actOnFlow("code", code)}
            />
          ) : (
            <div className="space-y-4 py-4">
              <p role="status" className="text-sm text-muted-foreground">
                {busy ? "Opening provider sign-in…" : "Sign-in did not start."}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={props.onClose}>
                  Close
                </Button>
                {!busy ? <Button onClick={() => void begin()}>Try again</Button> : null}
              </div>
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}
