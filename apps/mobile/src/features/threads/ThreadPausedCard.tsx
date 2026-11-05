import {
  classifyThreadPause,
  describeThreadPause,
} from "@t3tools/client-runtime/state/thread-activity";
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

function Choice(props: {
  readonly label: string;
  readonly primary?: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.primary === true
          ? "min-h-11 flex-1 items-center justify-center rounded-lg bg-primary px-3"
          : "min-h-11 flex-1 items-center justify-center rounded-lg border border-border px-3"
      }
    >
      <Text
        className={
          props.primary === true
            ? "font-t3-bold text-sm text-primary-foreground"
            : "font-t3-bold text-sm text-foreground"
        }
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/**
 * What a thread shows when its provider stopped. Nothing was lost and nothing
 * moves on its own: the person resumes, picks another model, or changes account.
 */
export function ThreadPausedCard(props: {
  readonly lastError: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentInstanceId: string | null;
  readonly currentModel: string | null;
  readonly resuming: boolean;
  readonly disabled: boolean;
  readonly onResume: (modelSelection?: ModelSelection) => void;
  /** Other chats stopped on this model, which Resume all brings back with this one. */
  readonly otherPausedCount: number;
  readonly onResumeAll: () => void;
}) {
  const navigation = useNavigation();
  const [choosingModel, setChoosingModel] = useState(false);
  const current = props.providers.find((entry) => entry.instanceId === props.currentInstanceId);
  const title = describeThreadPause(
    classifyThreadPause(props.lastError),
    current?.displayName ?? "The provider",
  );
  const usable = props.providers.filter(
    (entry) => entry.enabled && entry.installed && entry.auth.status !== "unauthenticated",
  );
  const blocked = props.disabled || props.resuming;

  return (
    <View className="mx-4 mb-3 gap-2 rounded-xl border border-border bg-card p-3">
      <View>
        <Text className="font-t3-bold text-sm text-foreground">{title}</Text>
        <Text className="text-xs text-foreground-muted">
          This chat is paused. Nothing was lost.
        </Text>
      </View>
      {choosingModel ? (
        <ScrollView className="max-h-56" keyboardShouldPersistTaps="handled">
          {usable.map((entry) => (
            <View key={entry.instanceId} className="pb-2">
              <Text className="pb-1 text-xs text-foreground-muted">
                {entry.displayName ?? entry.driver}
              </Text>
              {entry.models
                .filter(
                  (model) =>
                    entry.instanceId !== props.currentInstanceId ||
                    model.slug !== props.currentModel,
                )
                .map((model) => (
                  <Pressable
                    key={model.slug}
                    accessibilityRole="button"
                    accessibilityLabel={`Resume on ${model.name}`}
                    disabled={blocked}
                    className="min-h-11 justify-center"
                    onPress={() => {
                      setChoosingModel(false);
                      props.onResume({ instanceId: entry.instanceId, model: model.slug });
                    }}
                  >
                    <Text className="text-sm text-foreground">{model.name}</Text>
                  </Pressable>
                ))}
            </View>
          ))}
        </ScrollView>
      ) : null}
      {props.otherPausedCount > 0 ? (
        <View className="flex-row">
          <Choice
            label={`Resume all ${props.otherPausedCount + 1} chats on this model`}
            disabled={blocked}
            onPress={props.onResumeAll}
          />
        </View>
      ) : null}
      <View className="flex-row gap-2">
        <Choice
          label={choosingModel ? "Cancel" : "Switch model"}
          disabled={props.disabled}
          onPress={() => setChoosingModel((open) => !open)}
        />
        <Choice
          label="Switch account"
          disabled={props.disabled}
          onPress={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
        />
        <Choice
          label={props.resuming ? "Resuming…" : "Resume"}
          primary
          disabled={blocked}
          onPress={() => props.onResume()}
        />
      </View>
    </View>
  );
}
