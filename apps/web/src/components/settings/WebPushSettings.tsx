import { useCallback, useEffect, useRef, useState } from "react";
import type { WebPushPreferences, WebPushStatus, WebPushSubscription } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  browserPushUnavailableReason,
  currentBrowserPushSubscription,
  enableBrowserPush,
  setBrowserPushEnabled,
} from "../../browser/webPush";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function subscriptionInput(subscription: PushSubscription): WebPushSubscription {
  const data = subscription.toJSON();
  if (!data.endpoint || !data.keys?.p256dh || !data.keys.auth)
    throw new Error("The browser returned an incomplete subscription.");
  return { endpoint: data.endpoint, keys: { p256dh: data.keys.p256dh, auth: data.keys.auth } };
}

export function WebPushSettings() {
  const environment = usePrimaryEnvironment();
  const environmentId = environment?.environmentId;
  const getStatus = useAtomCommand(serverEnvironment.webPushStatus, { reportFailure: false });
  const subscribe = useAtomCommand(serverEnvironment.webPushSubscribe, { reportFailure: false });
  const unsubscribe = useAtomCommand(serverEnvironment.webPushUnsubscribe, {
    reportFailure: false,
  });
  const sendTest = useAtomCommand(serverEnvironment.webPushTest, { reportFailure: false });
  const [status, setStatus] = useState<WebPushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unavailable = browserPushUnavailableReason();
  const connected = environment?.connection.phase === "connected";
  const refresh = useCallback(async () => {
    if (!environmentId || !connected || !window.isSecureContext || window.desktopBridge) return;
    const subscription = await currentBrowserPushSubscription();
    const result = await getStatus({
      environmentId,
      input: subscription ? { endpoint: subscription.endpoint } : {},
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    setStatus(result.value);
    setBrowserPushEnabled(environmentId, result.value.subscribed);
  }, [environmentId, connected, getStatus]);
  useEffect(() => {
    void refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Unable to check push notifications."),
    );
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update notifications.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const save = async (subscription: PushSubscription, preferences: WebPushPreferences) => {
    if (!environmentId) return;
    const result = await subscribe({
      environmentId,
      input: { subscription: subscriptionInput(subscription), preferences },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    setBrowserPushEnabled(environmentId, true);
  };

  return (
    <SettingsSection title="Push notifications on this device">
      <SettingsRow
        title={
          status?.subscribed
            ? "Notifications enabled"
            : "Receive notifications while Solla Code is closed"
        }
        description={
          unavailable ??
          `Agent alerts and approval requests from ${environment?.label ?? "this host"}. The host must be running and online. Each browser or Home Screen installation is enabled separately.`
        }
        control={
          <Button
            disabled={(!status?.subscribed && !!unavailable) || !connected || !status || busy}
            onClick={() =>
              void run(async () => {
                if (!environmentId || !status) return;
                if (status.subscribed) {
                  const subscription = await currentBrowserPushSubscription();
                  if (subscription) {
                    const result = await unsubscribe({
                      environmentId,
                      input: { endpoint: subscription.endpoint },
                    });
                    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                    await subscription.unsubscribe();
                  }
                  setBrowserPushEnabled(environmentId, false);
                } else {
                  const subscription = await enableBrowserPush(status.publicKey);
                  await save(subscription, status.preferences);
                }
              })
            }
          >
            {busy ? "Working…" : status?.subscribed ? "Turn off" : "Enable notifications"}
          </Button>
        }
      />
      {status?.subscribed && (
        <>
          {(
            [
              [
                "agentAlerts",
                "Agent alerts",
                "Messages and task notifications allowed by each agent's preferences.",
              ],
              [
                "requests",
                "Approval and input requests",
                "Provider approvals, questions, and agent blockers.",
              ],
              [
                "includeDetails",
                "Show notification details",
                "Include message text on the lock screen. Off keeps the notification text private.",
              ],
            ] as const
          ).map(([key, title, description]) => (
            <SettingsRow
              key={key}
              title={title}
              description={description}
              control={
                <Switch
                  aria-label={title}
                  checked={status.preferences[key]}
                  disabled={busy || !connected}
                  onCheckedChange={(checked) =>
                    void run(async () => {
                      const subscription = await currentBrowserPushSubscription();
                      if (!subscription)
                        throw new Error(
                          "The browser subscription expired. Enable notifications again.",
                        );
                      await save(subscription, { ...status.preferences, [key]: Boolean(checked) });
                    })
                  }
                />
              }
            />
          ))}
          <Button
            variant="outline"
            disabled={busy || !connected}
            onClick={() =>
              void run(async () => {
                if (!environmentId) return;
                const subscription = await currentBrowserPushSubscription();
                if (!subscription) throw new Error("Enable notifications again before testing.");
                const result = await sendTest({
                  environmentId,
                  input: { endpoint: subscription.endpoint },
                });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                setMessage("Test accepted by the push service. Check this device's notifications.");
              })
            }
          >
            Send test notification
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </SettingsSection>
  );
}
