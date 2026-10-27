import { SymbolView } from "../../components/AppSymbol";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useThemeColor } from "../../lib/useThemeColor";
import type { deriveHomeEmptyState } from "../home/home-empty-state";

export function WorkspaceEmptyDetail(props: {
  readonly onStartNewTask?: () => void;
  readonly emptyState?: ReturnType<typeof deriveHomeEmptyState>;
  readonly onEmptyAction?: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");

  if (props.emptyState) {
    return (
      <View className="flex-1 items-center justify-center bg-screen px-6">
        <View className="w-full max-w-[430px]">
          <EmptyState
            variant="plain"
            title={props.emptyState.title}
            detail={props.emptyState.detail}
            actionLabel={props.emptyState.actionLabel}
            onAction={props.onEmptyAction}
          />
          {props.emptyState.loading ? <ActivityIndicator color={iconColor} /> : null}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center bg-screen px-10">
      <View className="max-w-[360px] items-center gap-3">
        <SymbolView name="sidebar.left" size={34} tintColor={iconColor} type="hierarchical" />
        <Text className="text-center text-xl font-t3-bold">Select a thread</Text>
        <Text className="text-center text-base text-foreground-muted">
          Choose a thread from the sidebar or start a new task.
        </Text>
        {props.onStartNewTask ? (
          <Pressable
            accessibilityRole="button"
            className="mt-2 flex-row items-center gap-2 rounded-full bg-primary px-5 py-3 active:opacity-70"
            onPress={props.onStartNewTask}
          >
            <Text className="text-base font-t3-bold text-primary-foreground">New Task</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
