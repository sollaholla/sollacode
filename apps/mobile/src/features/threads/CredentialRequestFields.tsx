import { credentialRequestSaveInput } from "@t3tools/client-runtime/preview/credential-form";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  CREDENTIAL_PASSKEYS_ON_ANSWER,
  CREDENTIAL_REQUEST_QUESTION_ID,
  credentialProvidedAnswers,
  credentialRequestSiteName,
  type CredentialRequest,
} from "@t3tools/shared/credentialRequest";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";

const FIELD_CLASS =
  "min-h-[50px] rounded-2xl border border-neutral-200 bg-white px-3.5 py-3 font-sans text-base text-neutral-950 dark:border-white/8 dark:bg-neutral-950/70 dark:text-neutral-50";

/**
 * Collects a login for the site an agent is signing in to. The secret goes
 * straight to the host's desktop vault; the thread only ever gets the id of the
 * entry it became.
 */
export function CredentialRequestFields(props: {
  readonly request: CredentialRequest & { readonly mode: "password" | "code" };
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onProvided: (answers: Record<string, string>) => void;
}) {
  const saveCredential = useAtomCommand(previewEnvironment.saveCredential, {
    reportFailure: false,
  });
  const [username, setUsername] = useState(props.request.usernameHint ?? "");
  const [secret, setSecret] = useState("");
  const [save, setSave] = useState(props.request.mode === "password");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const site = credentialRequestSiteName(props.request.origin);
  const isCode = props.request.mode === "code";
  const input = credentialRequestSaveInput({
    origin: props.request.origin,
    kind: props.request.mode,
    username,
    secret,
    save,
  });
  const canSubmit = input !== null && !saving && !props.disabled;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const result = await saveCredential({ environmentId: props.environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The login could not be stored.");
      return;
    }
    setSecret("");
    props.onProvided(credentialProvidedAnswers({ credentialId: result.value.id, saved: save }));
  };

  return (
    <View className="gap-2">
      {isCode ? null : (
        <TextInput
          accessibilityLabel={`Username for ${site}`}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          editable={!saving && !props.disabled}
          placeholder="Username or email"
          value={username}
          onChangeText={setUsername}
          className={FIELD_CLASS}
        />
      )}
      <TextInput
        accessibilityLabel={`${isCode ? "Code" : "Password"} for ${site}`}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        editable={!saving && !props.disabled}
        placeholder={isCode ? "PIN or code" : "Password"}
        secureTextEntry
        value={secret}
        onChangeText={setSecret}
        className={FIELD_CLASS}
      />
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: save }}
        disabled={saving || props.disabled}
        className="flex-row items-center gap-2 py-1"
        onPress={() => setSave((current) => !current)}
      >
        <View
          className={cn(
            "size-5 items-center justify-center rounded-md border",
            save ? "border-blue-500 bg-blue-500" : "border-neutral-300 dark:border-white/20",
          )}
        >
          {save ? <Text className="font-t3-bold text-xs text-white">✓</Text> : null}
        </View>
        <Text className="font-sans text-sm text-neutral-700 dark:text-neutral-300">
          Save for {site}
        </Text>
      </Pressable>
      <Text className="font-sans text-xs text-neutral-500">
        {save
          ? "Stored encrypted on your computer and filled only on this exact site. The agent never sees it."
          : "Kept in memory for up to an hour for this sign-in, then forgotten. The agent never sees it."}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" className="font-sans text-sm text-red-600">
          {error}
        </Text>
      ) : null}
      <Pressable
        className={cn(
          "min-h-11 items-center justify-center rounded-2xl px-4 py-3.5",
          canSubmit ? "bg-blue-500" : "bg-neutral-200 dark:bg-neutral-700/60",
        )}
        disabled={!canSubmit}
        onPress={() => void submit()}
      >
        <Text className="font-t3-extrabold text-sm text-white">
          {saving ? "Storing…" : "Continue"}
        </Text>
      </Pressable>
    </View>
  );
}

/** Turns on passkeys for the site an agent's page wants one on, then tells the agent. */
export function PasskeyRequestAction(props: {
  readonly origin: string;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onTurnedOn: (answers: Record<string, string>) => void;
}) {
  const setSite = useAtomCommand(previewEnvironment.passkeysSetSite, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnOn = async () => {
    setBusy(true);
    setError(null);
    const result = await setSite({
      environmentId: props.environmentId,
      input: { site: props.origin, enabled: true },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Passkeys could not be turned on.");
      return;
    }
    props.onTurnedOn({ [CREDENTIAL_REQUEST_QUESTION_ID]: CREDENTIAL_PASSKEYS_ON_ANSWER });
  };
  return (
    <View className="gap-2">
      <Text className="font-sans text-sm text-neutral-500">
        Solla can hold a passkey for this site, encrypted on your computer. Passkeys in iCloud
        Keychain, Google Password Manager, or on this phone can't be used here.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" className="font-sans text-sm text-red-600">
          {error}
        </Text>
      ) : null}
      <Pressable
        className={cn(
          "min-h-11 items-center justify-center rounded-2xl px-4 py-3.5",
          busy || props.disabled ? "bg-neutral-200 dark:bg-neutral-700/60" : "bg-blue-500",
        )}
        disabled={busy || props.disabled}
        onPress={() => void turnOn()}
      >
        <Text className="font-t3-extrabold text-sm text-white">
          {busy ? "Turning on…" : `Use passkeys on ${credentialRequestSiteName(props.origin)}`}
        </Text>
      </Pressable>
    </View>
  );
}
