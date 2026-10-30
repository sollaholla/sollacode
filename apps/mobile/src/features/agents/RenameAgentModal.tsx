import type { EnvironmentId, VmAgent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { vmAgentEnvironment } from "../../state/vmAgents";

/** Mount for one edit so reopening starts from the latest registry name. */
export function RenameAgentModal(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
  readonly onClose: () => void;
}) {
  const rename = useAtomCommand(vmAgentEnvironment.rename, { reportFailure: false });
  const [draft, setDraft] = useState(props.agent.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const name = draft.trim();
  const canSave = name.length > 0 && name.length <= 64 && name !== props.agent.name && !saving;
  const cancel = () => {
    if (!savingRef.current) props.onClose();
  };

  const save = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const result = await rename({
      environmentId: props.environmentId,
      input: { vmAgentId: props.agent.vmAgentId, name },
    });
    savingRef.current = false;
    setSaving(false);
    if (result._tag === "Success") {
      props.onClose();
    } else {
      const failure = Cause.squash(result.cause);
      setError(
        failure instanceof Error && failure.message.trim().length > 0
          ? failure.message
          : "This agent could not be renamed. Try again.",
      );
    }
  };

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={cancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1 items-center justify-center bg-backdrop px-6"
      >
        <View
          accessibilityViewIsModal
          className="w-full max-w-md gap-4 rounded-2xl border border-border bg-sheet p-5"
        >
          <Text accessibilityRole="header" className="text-xl font-t3-bold text-foreground">
            Rename agent
          </Text>
          <Text className="text-sm text-foreground-muted">
            The mention handle stays @{props.agent.handle}.
          </Text>
          <TextInput
            accessibilityLabel="Agent name"
            autoFocus
            autoCorrect={false}
            editable={!saving}
            maxLength={64}
            returnKeyType="done"
            selectTextOnFocus
            value={draft}
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            onSubmitEditing={() => void save()}
          />
          {error !== null ? (
            <Text accessibilityRole="alert" className="text-sm text-red-600 dark:text-red-300">
              {error}
            </Text>
          ) : null}
          <View className="flex-row justify-end gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saving }}
              disabled={saving}
              className="min-h-11 items-center justify-center rounded-xl px-4 disabled:opacity-50"
              onPress={cancel}
            >
              <Text className="font-t3-bold text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Save agent name"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave, busy: saving }}
              disabled={!canSave}
              className="min-h-11 items-center justify-center rounded-xl bg-primary px-4 disabled:opacity-50"
              onPress={() => void save()}
            >
              <Text className="font-t3-bold text-primary-foreground">
                {saving ? "Saving…" : "Save"}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
