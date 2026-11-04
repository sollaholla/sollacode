import {
  passkeyAccountName,
  passkeySiteRows,
} from "@t3tools/client-runtime/preview/credential-form";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { PreviewPasskeysSnapshot } from "@t3tools/contracts";
import { passkeySiteFromInput } from "@t3tools/shared/passkeySites";
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { previewEnvironment } from "../../state/preview";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const settled = <A,>(result: AtomCommandResult<A, unknown>): A => {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
};

/** The sites this environment's desktop holds passkeys for, relayed from it. */
export function EnvironmentPasskeys(props: {
  readonly environment: ConnectedEnvironmentSummary;
  readonly title: string;
}) {
  const environmentId = props.environment.environmentId;
  const snapshotCommand = useAtomCommand(previewEnvironment.passkeysSnapshot, {
    reportFailure: false,
  });
  const setSiteCommand = useAtomCommand(previewEnvironment.passkeysSetSite, {
    reportFailure: false,
  });
  const removeCommand = useAtomCommand(previewEnvironment.passkeysRemove, {
    reportFailure: false,
  });
  const [snapshot, setSnapshot] = useState<PreviewPasskeysSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  // Removing asks once in place, since a passkey can't be recovered.
  const [removing, setRemoving] = useState<string | null>(null);
  const draftSite = passkeySiteFromInput(draft);

  const act = useCallback(async (action: () => Promise<PreviewPasskeysSnapshot>) => {
    setBusy(true);
    try {
      setSnapshot(await action());
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change passkeys.");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void act(async () => settled(await snapshotCommand({ environmentId, input: {} })));
  }, [act, environmentId, snapshotCommand]);

  const setSite = (site: string, enabled: boolean) =>
    act(async () => settled(await setSiteCommand({ environmentId, input: { site, enabled } })));

  return (
    <SettingsSection title={props.title} card>
      <View className="gap-3 p-4">
        <Text className="text-sm leading-normal text-foreground-muted">
          The browser can't reach passkeys in iCloud Keychain, Google Password Manager, or on this
          phone. Turn this on for a site and add a new passkey in its security settings. Your
          computer keeps it encrypted and uses it on that site for you and your agents, without
          asking each time. Google can't use this.
        </Text>
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-red-600">
            {error}
          </Text>
        ) : null}
        {snapshot
          ? passkeySiteRows(snapshot).map((row) => (
              <View key={row.site} className="gap-2 border-t border-border pt-3">
                <View className="flex-row items-center gap-3">
                  <View className="flex-1">
                    <Text className="text-base font-t3-bold text-foreground">{row.site}</Text>
                    <Text className="text-sm text-foreground-muted">
                      {row.enabled ? "On" : "Off"} ·{" "}
                      {row.passkeys.length === 1 ? "1 passkey" : `${row.passkeys.length} passkeys`}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    className="min-h-[42px] justify-center rounded-[10px] border border-border px-3"
                    onPress={() => void setSite(row.site, !row.enabled)}
                  >
                    <Text className="text-sm text-foreground">
                      {row.enabled ? "Turn off" : "Turn on"}
                    </Text>
                  </Pressable>
                </View>
                {row.passkeys.map((passkey) => (
                  <View key={passkey.id} className="flex-row items-center gap-3">
                    <Text numberOfLines={1} className="flex-1 text-sm text-foreground">
                      {passkeyAccountName(passkey)}
                    </Text>
                    {removing === passkey.id ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        className="min-h-[42px] justify-center px-2"
                        onPress={() => {
                          setRemoving(null);
                          void act(async () =>
                            settled(
                              await removeCommand({ environmentId, input: { id: passkey.id } }),
                            ),
                          );
                        }}
                      >
                        <Text className="text-sm font-t3-bold text-red-600">Remove for good</Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        className="min-h-[42px] justify-center px-2"
                        onPress={() => setRemoving(passkey.id)}
                      >
                        <Text className="text-sm text-foreground-muted">Remove</Text>
                      </Pressable>
                    )}
                  </View>
                ))}
              </View>
            ))
          : null}
        <View className="flex-row items-center gap-2 border-t border-border pt-3">
          <TextInput
            accessibilityLabel="Site to use passkeys on"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="example.com"
            value={draft}
            onChangeText={setDraft}
            className="min-h-[42px] flex-1 rounded-[10px] border border-border px-3 text-base text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || draftSite === null}
            className={cn(
              "min-h-[42px] justify-center rounded-[10px] border border-border px-3",
              (busy || draftSite === null) && "opacity-50",
            )}
            onPress={() => {
              if (!draftSite) return;
              void setSite(draftSite, true).then((done) => {
                if (done) setDraft("");
              });
            }}
          >
            <Text className="text-sm text-foreground">Turn on</Text>
          </Pressable>
        </View>
      </View>
    </SettingsSection>
  );
}
