"use client";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  RemoteControlHost,
  RemoteControlHostStreamEvent,
  RemoteControlSession,
} from "@t3tools/contracts";
import { MonitorUpIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { remoteControlEnvironment } from "~/state/remoteControl";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  isRemoteControlDeviceRemembered,
  rememberRemoteControlDevice,
} from "~/remoteControlTrustedDevices";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";

function hostPlatform(): RemoteControlHost["platform"] {
  const platform = navigator.userAgent.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "unknown";
}

function commandError(result: Parameters<typeof squashAtomCommandFailure>[0]): Error {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause : new Error(String(cause));
}

interface PendingApproval {
  readonly connectionId: string;
  readonly requestId: string;
  readonly session: RemoteControlSession;
}

interface ActiveShare {
  readonly connectionId: string;
  readonly session: RemoteControlSession;
}

export function RemoteControlCoordinator() {
  const environment = usePrimaryEnvironment();
  const bridge = window.desktopBridge;

  if (!bridge || !environment || environment.connection.phase !== "connected") return null;

  return (
    <RemoteControlHostCoordinator
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  );
}

function RemoteControlHostCoordinator(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const bridge = window.desktopBridge!;
  const generatedId = useId();
  const clientId = `desktop-${generatedId}`;
  const host = useMemo<RemoteControlHost>(
    () => ({
      clientId,
      environmentId,
      platform: hostPlatform(),
      capabilities: ["screen", "pointer", "keyboard"],
    }),
    [clientId, environmentId],
  );
  const hostEvents = useEnvironmentQuery(
    remoteControlEnvironment.hostEvents({
      environmentId,
      input: host,
    }),
  );
  const respond = useAtomCommand(remoteControlEnvironment.respondToRequest, {
    label: "remote control approval",
    reportFailure: false,
  });
  const publishFrame = useAtomCommand(remoteControlEnvironment.publishFrame, {
    label: "remote control screen frame",
    reportFailure: false,
  });
  const endByHost = useAtomCommand(remoteControlEnvironment.endByHost, {
    label: "stop remote control",
    reportFailure: false,
  });
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [active, setActive] = useState<ActiveShare | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const autoApprovalRequestIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const event: RemoteControlHostStreamEvent | null = hostEvents.data;
    if (!event) return;
    if (event.type === "input") {
      const current = activeRef.current;
      if (!current || current.session.sessionId !== event.sessionId) return;
      void bridge.sendRemoteControlInput(event.input).catch((cause: unknown) => {
        const message =
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "Solla Code could not apply input from the controlling device.";
        setCaptureError(message);
        setActive((value) => (value?.session.sessionId === event.sessionId ? null : value));
        void bridge.resetRemoteControlInput();
        void endByHost({
          environmentId,
          input: {
            clientId,
            connectionId: event.connectionId,
            sessionId: event.sessionId,
            failureReason: message,
          },
        });
      });
      return;
    }
    if (event.type === "access-requested") {
      const request = {
        connectionId: event.connectionId,
        requestId: event.requestId,
        session: event.session,
      };
      if (
        isRemoteControlDeviceRemembered(
          environmentId,
          event.session.requester.deviceId,
          event.session.requestedCapabilities,
        )
      ) {
        if (autoApprovalRequestIdRef.current === event.requestId) return;
        autoApprovalRequestIdRef.current = event.requestId;
        setPending(null);
        setIsResponding(true);
        void (async () => {
          try {
            const outcome = await respond({
              environmentId,
              input: {
                clientId,
                connectionId: event.connectionId,
                requestId: event.requestId,
                decision: "approve",
                grantedCapabilities: event.session.requestedCapabilities,
              },
            });
            if (outcome._tag === "Failure") throw commandError(outcome);
            setCaptureError(null);
            setActive({
              connectionId: event.connectionId,
              session: outcome.value,
            });
          } catch {
            // Trust only removes the consent prompt. Any stale connection or
            // capability mismatch falls back to the normal explicit prompt.
            setRememberDevice(false);
            setPending(request);
          } finally {
            setIsResponding(false);
          }
        })();
        return;
      }
      setRememberDevice(false);
      setPending(request);
      return;
    }
    if (event.type === "session-ended") {
      setPending((current) =>
        current?.session.sessionId === event.session.sessionId ? null : current,
      );
      setActive((current) =>
        current?.session.sessionId === event.session.sessionId ? null : current,
      );
    }
  }, [bridge, clientId, endByHost, environmentId, hostEvents.data, respond]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let sequence = 0;

    const run = async () => {
      try {
        while (true) {
          if (cancelled || activeRef.current?.session.sessionId !== active.session.sessionId) {
            return;
          }
          const captured = await bridge.captureRemoteControlFrame({
            maxWidth: 1_280,
            jpegQuality: 58,
          });
          if (cancelled) return;
          const outcome = await publishFrame({
            environmentId,
            input: {
              clientId,
              connectionId: active.connectionId,
              frame: {
                sessionId: active.session.sessionId,
                sequence,
                ...captured,
              },
            },
          });
          if (outcome._tag === "Failure") throw commandError(outcome);
          sequence += 1;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
        }
      } catch (cause) {
        if (cancelled) return;
        const message =
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "Solla Code could not capture this screen.";
        setCaptureError(message);
        setActive((current) =>
          current?.session.sessionId === active.session.sessionId ? null : current,
        );
        void endByHost({
          environmentId,
          input: {
            clientId,
            connectionId: active.connectionId,
            sessionId: active.session.sessionId,
            failureReason: message,
          },
        });
      }
    };

    void run();
    return () => {
      cancelled = true;
      void bridge.resetRemoteControlInput();
    };
  }, [active, bridge, clientId, endByHost, environmentId, publishFrame]);

  const answerRequest = async (
    decision: "approve" | "decline",
    access: "view" | "control" = "view",
  ) => {
    if (!pending) return;
    setIsResponding(true);
    try {
      const outcome = await respond({
        environmentId,
        input: {
          clientId,
          connectionId: pending.connectionId,
          requestId: pending.requestId,
          decision,
          ...(decision === "approve"
            ? {
                grantedCapabilities:
                  access === "control"
                    ? pending.session.requestedCapabilities
                    : (["screen"] as const),
              }
            : {}),
        },
      });
      if (outcome._tag === "Failure") throw commandError(outcome);
      if (decision === "approve") {
        setCaptureError(null);
        if (rememberDevice) {
          rememberRemoteControlDevice(
            environmentId,
            pending.session.requester.deviceId,
            outcome.value.grantedCapabilities,
          );
        }
        setActive({
          connectionId: pending.connectionId,
          session: outcome.value,
        });
      }
      setRememberDevice(false);
      setPending(null);
    } catch (cause) {
      setCaptureError(
        cause instanceof Error
          ? cause.message
          : "The remote-control request could not be answered.",
      );
    } finally {
      setIsResponding(false);
    }
  };

  const stopSharing = async () => {
    if (!active) return;
    const ending = active;
    setActive(null);
    await bridge.resetRemoteControlInput().catch(() => undefined);
    const outcome = await endByHost({
      environmentId,
      input: {
        clientId,
        connectionId: ending.connectionId,
        sessionId: ending.session.sessionId,
      },
    });
    if (outcome._tag === "Failure") setCaptureError(commandError(outcome).message);
  };

  return (
    <>
      {active ? (
        <div className="fixed left-1/2 top-3 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full border border-success/35 bg-background/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
          <span className="size-2 rounded-full bg-success" aria-hidden />
          <span className="font-medium">
            {active.session.grantedCapabilities.some(
              (capability) => capability === "pointer" || capability === "keyboard",
            )
              ? `Controlled by ${active.session.requester.label}`
              : `Screen shared with ${active.session.requester.label}`}
          </span>
          <Button size="xs" variant="outline" onClick={() => void stopSharing()}>
            Stop
          </Button>
        </div>
      ) : null}

      <Dialog open={pending !== null}>
        <DialogPopup showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MonitorUpIcon className="size-5" />
              {pending?.session.requestedCapabilities.some(
                (capability) => capability === "pointer" || capability === "keyboard",
              )
                ? "Allow remote control?"
                : "Share this screen?"}
            </DialogTitle>
            <DialogDescription>
              {pending?.session.requester.label ?? "A connected device"} wants to view and control
              this computer through your existing trusted Solla Code connection.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
              <ShieldCheckIcon className="mt-0.5 size-5 shrink-0 text-success" />
              <div className="space-y-1">
                <p className="font-medium">You choose the access level</p>
                <p className="text-muted-foreground">
                  View only shares the primary display. Allow control also enables pointer and
                  keyboard input. You can stop the session from this computer at any time.
                </p>
              </div>
            </div>
            <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 px-3 py-2.5">
              <Checkbox
                className="mt-0.5"
                checked={rememberDevice}
                disabled={isResponding}
                onCheckedChange={(checked) => setRememberDevice(checked === true)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">Remember for this device</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">
                  Future requests for the access level you approve will start automatically.
                  Additional permissions or pairing the device again requires approval.
                </span>
              </span>
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isResponding}
              onClick={() => void answerRequest("decline")}
            >
              Decline
            </Button>
            <Button
              variant="outline"
              disabled={isResponding}
              onClick={() => void answerRequest("approve", "view")}
            >
              View only
            </Button>
            <Button
              disabled={isResponding}
              onClick={() => void answerRequest("approve", "control")}
            >
              {isResponding ? <Spinner className="size-4" /> : null}
              Allow control
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={captureError !== null} onOpenChange={(open) => !open && setCaptureError(null)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Screen sharing needs attention</DialogTitle>
            <DialogDescription>{captureError}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p className="text-sm text-muted-foreground">
              On macOS, open System Settings → Privacy &amp; Security → Screen Recording, enable
              Solla Code, and also enable Accessibility for keyboard and pointer control. Then
              completely quit and reopen it. No GitHub sign-in is required.
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => setCaptureError(null)}>Got it</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
