import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Modal, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import {
  DEFAULT_MODEL_ACCESS_POLICY,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function ModelPolicyModal(props: {
  environmentId: EnvironmentId;
  threadId?: ThreadId;
  parentThreadId?: ThreadId | null;
  visible: boolean;
  onClose: () => void;
}) {
  const settings =
    useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId)) ??
    DEFAULT_SERVER_SETTINGS;
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ?? [];
  const [parent, setParent] = useState(false);
  const target = parent && props.parentThreadId ? props.parentThreadId : props.threadId;
  const policy = target
    ? (settings.threadModelPolicies[target] ?? DEFAULT_MODEL_ACCESS_POLICY)
    : settings.fallbackModelPolicy;
  const [draft, setDraft] = useState(policy);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  useEffect(() => {
    setDraft(policy);
    setNotice(null);
  }, [policy, props.visible, target]);
  const catalog = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      instanceId: provider.instanceId,
      model: model.slug,
      label: `${model.name} · ${provider.displayName ?? provider.instanceId}`,
    })),
  );
  for (const entry of draft.models)
    if (!catalog.some((row) => row.instanceId === entry.instanceId && row.model === entry.model))
      catalog.push({ ...entry, label: `${entry.model} · ${entry.instanceId} (unavailable)` });
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-sheet px-5 pt-8">
        <View className="mb-4 flex-row items-center justify-between">
          <Text className="text-xl font-semibold">
            {props.threadId ? "Model restrictions" : "Automatic fallback models"}
          </Text>
          <Pressable accessibilityRole="button" onPress={props.onClose} className="p-3">
            <Text>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerClassName="gap-4 pb-12" keyboardShouldPersistTaps="handled">
          <Text>
            {props.threadId
              ? "Applies to this chat and its side chats. Parent agent restrictions also apply."
              : "Controls automatic fallback and quota-reset restoration in this environment. Manual selection is unaffected."}{" "}
            When no allowed model is available, work waits.
          </Text>
          {props.parentThreadId && (
            <View className="flex-row items-center justify-between">
              <Text className="flex-1">Apply to parent agent or chat and all its side chats</Text>
              <Switch value={parent} disabled={saving} onValueChange={setParent} />
            </View>
          )}
          {(
            [
              ["all", "Allow all models"],
              ["block", "Block selected models"],
              ["allow", "Allow only selected models"],
            ] as const
          ).map(([mode, title]) => (
            <Pressable
              key={mode}
              accessibilityRole="radio"
              accessibilityState={{ checked: draft.mode === mode, disabled: saving }}
              disabled={saving}
              className="rounded-lg border border-border p-3"
              onPress={() => {
                setNotice(null);
                setDraft({ ...draft, mode });
              }}
            >
              <Text>
                {draft.mode === mode ? "● " : "○ "}
                {title}
              </Text>
            </Pressable>
          ))}
          {draft.mode !== "all" && (
            <>
              <TextInput
                accessibilityLabel="Search models for restrictions"
                placeholder="Search models…"
                value={search}
                onChangeText={setSearch}
                className="rounded-lg border border-border p-3 text-foreground"
              />
              {catalog
                .filter((row) => row.label.toLowerCase().includes(search.toLowerCase()))
                .map((row) => (
                  <View
                    key={`${row.instanceId}:${row.model}`}
                    className="flex-row items-center gap-3"
                  >
                    <Text className="flex-1">{row.label}</Text>
                    <Switch
                      accessibilityLabel={row.label}
                      disabled={saving}
                      value={draft.models.some(
                        (entry) => entry.instanceId === row.instanceId && entry.model === row.model,
                      )}
                      onValueChange={(checked) => {
                        setNotice(null);
                        setDraft({
                          ...draft,
                          models: checked
                            ? [...draft.models, { instanceId: row.instanceId, model: row.model }]
                            : draft.models.filter(
                                (entry) =>
                                  !(
                                    entry.instanceId === row.instanceId && entry.model === row.model
                                  ),
                              ),
                        });
                      }}
                    />
                  </View>
                ))}
              {draft.mode === "allow" && draft.models.length === 0 && (
                <Text>No models are allowed. Work will wait until you allow one.</Text>
              )}
            </>
          )}
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            className="rounded-lg bg-accent p-4"
            onPress={async () => {
              setSaving(true);
              setNotice(null);
              try {
                const result = await update({
                  environmentId: props.environmentId,
                  input: {
                    patch: target
                      ? { threadModelPolicies: { [target]: draft } }
                      : { fallbackModelPolicy: draft },
                  },
                });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                setNotice("Restrictions saved.");
              } catch (error) {
                setNotice(error instanceof Error ? error.message : "Could not save restrictions.");
              } finally {
                setSaving(false);
              }
            }}
          >
            <Text>{saving ? "Saving…" : "Save restrictions"}</Text>
          </Pressable>
          {notice && <Text accessibilityRole="alert">{notice}</Text>}
        </ScrollView>
      </View>
    </Modal>
  );
}
