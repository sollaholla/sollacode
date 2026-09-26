import {
  CREDENTIAL_KINDS,
  credentialErrorMessage,
  credentialKindOf,
  credentialOriginFromInput,
  credentialSaveInput,
  credentialSecretName,
  initialCredentialDraft,
  sortCredentials,
  upsertCredential,
  type CredentialDraft,
  type CredentialEditorMode,
  type CredentialSaveInput,
} from "@t3tools/client-runtime/preview/credential-form";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { PreviewCredentialId, PreviewCredentialSummary } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "./components/SettingsSection";

const FIELD_LABEL_CLASS = "text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted";

function settled<A>(result: AtomCommandResult<A, unknown>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

/**
 * Settings → Credentials on the phone. Saved passwords, PINs, and codes live in
 * the desktop app on each environment's own machine, so each connected
 * environment gets its own list, reached through the server. The secret is
 * write-only here too: the phone sends a new one and never receives a saved one.
 */
export function SettingsCredentialsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { connectedEnvironments } = useRemoteConnectionStatus();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Credentials" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Logins, PINs, and codes agents can use on sites in the browser panel. Agents see each
          entry's label, type, username, and site. Solla Code types the secret into the page itself,
          only on the exact site it was saved for, so it never reaches an agent, a chat, or a log.
        </Text>
        {connectedEnvironments.length === 0 ? (
          <View className="rounded-[24px] bg-card px-6 py-8">
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              Connect an environment to manage its saved credentials.
            </Text>
          </View>
        ) : (
          connectedEnvironments.map((environment) => (
            <EnvironmentCredentials
              key={environment.environmentId}
              environment={environment}
              title={
                connectedEnvironments.length > 1
                  ? environment.environmentLabel
                  : "Saved credentials"
              }
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

type Editing =
  | { readonly kind: "add" }
  | { readonly kind: "edit"; readonly id: PreviewCredentialId };

function EnvironmentCredentials(props: {
  readonly environment: ConnectedEnvironmentSummary;
  readonly title: string;
}) {
  const environmentId = props.environment.environmentId;
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-icon-muted");
  const listCommand = useAtomCommand(previewEnvironment.listCredentials, { reportFailure: false });
  const saveCommand = useAtomCommand(previewEnvironment.saveCredential, { reportFailure: false });
  const removeCommand = useAtomCommand(previewEnvironment.removeCredential, {
    reportFailure: false,
  });
  const [credentials, setCredentials] = useState<readonly PreviewCredentialSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    listCommand({ environmentId, input: {} }).then(
      (result) => {
        if (cancelled) return;
        try {
          setCredentials(settled(result));
        } catch (cause) {
          setCredentials(null);
          setLoadError(credentialErrorMessage(cause, "Could not load saved credentials."));
        }
      },
      (cause: unknown) => {
        if (cancelled) return;
        setCredentials(null);
        setLoadError(credentialErrorMessage(cause, "Could not load saved credentials."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId, listCommand, loadAttempt]);

  const save = useCallback(
    async (input: CredentialSaveInput) => settled(await saveCommand({ environmentId, input })),
    [environmentId, saveCommand],
  );
  const remove = useCallback(
    async (id: PreviewCredentialId) => {
      settled(await removeCommand({ environmentId, input: { id } }));
      setCredentials((current) => current?.filter((item) => item.id !== id) ?? null);
      setEditing(null);
    },
    [environmentId, removeCommand],
  );
  const onSaved = useCallback((saved: PreviewCredentialSummary) => {
    setCredentials((current) => upsertCredential(current ?? [], saved));
    setEditing(null);
  }, []);

  let content;
  if (loadError !== null) {
    // Not the empty state: nothing here says there is nothing saved,
    // only that they could not be reached, which is usually a desktop that is
    // closed or asleep.
    content = (
      <View className="gap-3 p-4">
        <Text className="text-base font-t3-bold text-foreground">
          Couldn't load saved credentials
        </Text>
        <Text className="text-sm leading-normal text-foreground-muted">{loadError}</Text>
        <Pressable
          accessibilityRole="button"
          className="min-h-[42px] flex-row items-center justify-center gap-1.5 self-start rounded-[14px] border border-input-border bg-input px-3.5 py-2.5 active:opacity-70"
          onPress={() => setLoadAttempt((attempt) => attempt + 1)}
        >
          <SymbolView name="arrow.clockwise" size={13} tintColor={mutedColor} type="monochrome" />
          <Text className="text-sm text-foreground">Try again</Text>
        </Pressable>
      </View>
    );
  } else if (credentials === null) {
    content = (
      <View className="flex-row items-center gap-3 p-4">
        <ActivityIndicator color={mutedColor} size="small" />
        <Text className="text-sm text-foreground-muted">Loading saved credentials…</Text>
      </View>
    );
  } else {
    content = (
      <>
        {credentials.length === 0 && editing?.kind !== "add" ? (
          <Text className="p-4 text-sm leading-normal text-foreground-muted">
            No saved credentials. Save a login or PIN here and agents can use it on that site in the
            browser panel without ever seeing it.
          </Text>
        ) : null}
        {sortCredentials(credentials).map((credential, index) => (
          <View key={credential.id} className={cn(index !== 0 && "border-t border-border")}>
            <Pressable
              accessibilityLabel={`Edit ${credential.label}`}
              accessibilityRole="button"
              className="flex-row items-center gap-4 p-4 active:opacity-70"
              onPress={() =>
                setEditing((current) =>
                  current?.kind === "edit" && current.id === credential.id
                    ? null
                    : { kind: "edit", id: credential.id },
                )
              }
            >
              <SymbolView
                name={credentialKindOf(credential) === "code" ? "number" : "key"}
                size={20}
                tintColor={iconColor}
                type="monochrome"
              />
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-base text-foreground" numberOfLines={1}>
                  {credential.label}
                </Text>
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {credentialKindOf(credential) === "code" ? "PIN or code · " : ""}
                  {credential.username ? `${credential.username} · ` : ""}
                  {credential.origin}
                </Text>
              </View>
            </Pressable>
            {editing?.kind === "edit" && editing.id === credential.id ? (
              <CredentialForm
                mode={{ kind: "edit", credential }}
                save={save}
                remove={() => remove(credential.id)}
                onSaved={onSaved}
                onCancel={() => setEditing(null)}
              />
            ) : null}
          </View>
        ))}
        <View className={cn(credentials.length > 0 && "border-t border-border")}>
          {editing?.kind === "add" ? (
            <CredentialForm
              mode={{ kind: "add" }}
              save={save}
              onSaved={onSaved}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center gap-4 p-4 active:opacity-70"
              onPress={() => setEditing({ kind: "add" })}
            >
              <SymbolView name="plus" size={20} tintColor={iconColor} type="monochrome" />
              <Text className="text-base text-foreground">Add credential</Text>
            </Pressable>
          )}
        </View>
      </>
    );
  }

  return (
    <SettingsSection title={props.title} card>
      {content}
    </SettingsSection>
  );
}

/**
 * Adds or edits one saved password, PIN, or code in place. Editing starts the
 * secret blank and a blank secret keeps the saved one, since the phone never
 * receives it. Delete asks again inside the form instead of raising a system alert.
 */
function CredentialForm(props: {
  readonly mode: CredentialEditorMode;
  readonly save: (input: CredentialSaveInput) => Promise<PreviewCredentialSummary>;
  readonly remove?: () => Promise<void>;
  readonly onSaved: (saved: PreviewCredentialSummary) => void;
  readonly onCancel: () => void;
}) {
  const primaryForeground = useThemeColor("--color-primary-foreground");
  const dangerForeground = useThemeColor("--color-danger-foreground");
  const [draft, setDraft] = useState<CredentialDraft>(() => initialCredentialDraft(props.mode));
  const [busy, setBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = props.mode.kind === "edit";
  const input = credentialSaveInput(props.mode, draft);
  const origin = credentialOriginFromInput(draft.origin);
  const secretName = credentialSecretName(draft.kind);
  const kindOption = CREDENTIAL_KINDS.find((option) => option.kind === draft.kind);

  const update = (field: keyof CredentialDraft) => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  const run = async (action: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(credentialErrorMessage(cause, fallback));
      setBusy(false);
    }
  };

  const submit = () => {
    if (!input) return;
    void run(
      async () => props.onSaved(await props.save(input)),
      `Could not save the ${secretName}.`,
    );
  };

  const remove = props.remove;

  return (
    <View className="gap-3 px-4 pb-4">
      <View className="gap-1.5">
        <Text className={FIELD_LABEL_CLASS}>Type</Text>
        <View accessibilityRole="radiogroup" className="flex-row gap-2">
          {CREDENTIAL_KINDS.map((option) => {
            const selected = option.kind === draft.kind;
            return (
              <Pressable
                key={option.kind}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                className={cn(
                  "min-h-[42px] flex-1 items-center justify-center rounded-[14px] border px-3 active:opacity-70",
                  selected ? "border-primary bg-primary" : "border-input-border bg-input",
                )}
                onPress={() => setDraft((current) => ({ ...current, kind: option.kind }))}
              >
                <Text
                  className={cn(
                    "text-sm",
                    selected ? "font-t3-bold text-primary-foreground" : "text-foreground",
                  )}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {kindOption ? (
          <Text className="px-1 text-xs text-foreground-muted">{kindOption.description}</Text>
        ) : null}
      </View>
      <View className="gap-1.5">
        <Text className={FIELD_LABEL_CLASS}>Label</Text>
        <TextInput
          accessibilityLabel="Label"
          autoCapitalize="words"
          autoCorrect={false}
          maxLength={128}
          placeholder={draft.kind === "code" ? "Rent payment PIN" : "Work GitHub"}
          value={draft.label}
          onChangeText={update("label")}
        />
      </View>
      <View className="gap-1.5">
        <Text className={FIELD_LABEL_CLASS}>Website</Text>
        <TextInput
          accessibilityLabel="Website"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          maxLength={2048}
          placeholder="https://github.com"
          textContentType="URL"
          value={draft.origin}
          onChangeText={update("origin")}
        />
        <Text className="px-1 text-xs text-foreground-muted">
          {origin
            ? `Fills only pages on ${origin}.`
            : "HTTPS sites, plus localhost for development."}
        </Text>
      </View>
      {draft.kind === "password" ? (
        <View className="gap-1.5">
          <Text className={FIELD_LABEL_CLASS}>Username or email (optional)</Text>
          <TextInput
            accessibilityLabel="Username or email"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={512}
            textContentType="none"
            value={draft.username}
            onChangeText={update("username")}
          />
        </View>
      ) : null}
      <View className="gap-1.5">
        <Text className={FIELD_LABEL_CLASS}>{secretName}</Text>
        <TextInput
          accessibilityLabel={secretName}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={4096}
          placeholder={editing ? "Unchanged" : undefined}
          secureTextEntry
          textContentType={draft.kind === "code" ? "none" : "password"}
          value={draft.secret}
          onChangeText={update("secret")}
        />
        {editing ? (
          <Text className="px-1 text-xs text-foreground-muted">
            Leave blank to keep the saved {secretName}.
          </Text>
        ) : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {confirmingRemove && remove ? (
        <View className="gap-3 rounded-[14px] border border-danger-border bg-danger p-3">
          <Text className="text-sm text-danger-foreground">
            Delete this saved {secretName}? Agents will no longer be able to fill it.
          </Text>
          <View className="flex-row justify-end gap-2">
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              className="min-h-[42px] items-center justify-center rounded-[14px] border border-input-border bg-input px-3.5 active:opacity-70"
              onPress={() => setConfirmingRemove(false)}
            >
              <Text className="text-sm text-foreground">Keep</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              className="min-h-[42px] flex-row items-center justify-center gap-1.5 rounded-[14px] border border-danger-border px-3.5 active:opacity-70"
              onPress={() => void run(remove, `Could not delete the ${secretName}.`)}
            >
              <SymbolView name="trash" size={13} tintColor={dangerForeground} type="monochrome" />
              <Text className="text-sm font-t3-bold text-danger-foreground">
                {busy ? "Deleting…" : "Delete"}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View className="flex-row justify-end gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || !input }}
            disabled={busy || !input}
            className={cn(
              "min-h-[42px] flex-1 flex-row items-center justify-center gap-1.5 rounded-[14px] bg-primary px-3.5 py-2.5 active:opacity-70",
              (busy || !input) && "opacity-[0.45]",
            )}
            onPress={submit}
          >
            <SymbolView
              name="checkmark"
              size={13}
              tintColor={primaryForeground}
              type="monochrome"
            />
            <Text className="text-xs font-t3-bold tracking-[0.8px] uppercase text-primary-foreground">
              {busy ? "Saving…" : editing ? "Save changes" : `Save ${secretName}`}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            className="min-h-[42px] items-center justify-center rounded-[14px] border border-input-border bg-input px-3.5 active:opacity-70"
            onPress={props.onCancel}
          >
            <Text className="text-sm text-foreground">Cancel</Text>
          </Pressable>
          {remove ? (
            <Pressable
              accessibilityLabel={`Delete saved ${secretName}`}
              accessibilityRole="button"
              disabled={busy}
              className="h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-danger-border bg-danger active:opacity-70"
              onPress={() => setConfirmingRemove(true)}
            >
              <SymbolView name="trash" size={14} tintColor={dangerForeground} type="monochrome" />
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}
