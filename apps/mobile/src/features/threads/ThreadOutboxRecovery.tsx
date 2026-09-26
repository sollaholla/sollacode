import { Pressable, Text, View } from "react-native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { removeThreadOutboxMessage, updateThreadOutboxMessage } from "../../state/thread-outbox";
import { scopedThreadKey } from "../../lib/scopedEntities";

/**
 * Rejections retain their text and attachments until an explicit retry/discard.
 * Same card as the web composer's outbox: what went wrong on top, then each
 * message with its reason and the two ways out.
 */
export function ThreadOutboxRecovery({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const queues = useThreadOutboxMessages();
  const dangerColor = useThemeColor("--color-danger-foreground");
  const failed = (queues[scopedThreadKey(environmentId, threadId)] ?? []).filter(
    (message) => message.deliveryError,
  );
  if (!failed.length) return null;
  return (
    <View
      accessibilityLabel="Message outbox"
      className="mx-3 mt-2 gap-3 rounded-2xl border border-danger-border bg-card p-3"
    >
      <View className="flex-row items-start gap-3">
        <View className="size-8 items-center justify-center rounded-lg border border-danger-border bg-danger">
          <SymbolView
            name="exclamationmark.triangle"
            size={16}
            tintColor={dangerColor}
            type="monochrome"
          />
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="text-sm font-semibold text-foreground">
            {failed.length === 1
              ? "A saved message couldn't be sent"
              : `${failed.length} saved messages couldn't be sent`}
          </Text>
          <Text className="text-xs text-foreground-muted">
            Retry it, or discard it and write it again.
          </Text>
        </View>
      </View>
      {failed.map((message) => (
        <View
          key={message.messageId}
          className="gap-1.5 rounded-xl border border-border bg-card-alt px-3 py-2.5"
        >
          <Text className="text-[13px] text-foreground" numberOfLines={3}>
            {message.text}
          </Text>
          <Text className="text-xs text-danger-foreground">{message.deliveryError}</Text>
          <View className="flex-row gap-2 pt-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry saved message"
              className="min-h-9 items-center justify-center rounded-lg border border-border bg-card px-4"
              onPress={() => {
                const { deliveryError: _, ...pending } = message;
                void updateThreadOutboxMessage(pending).catch(console.warn);
              }}
            >
              <Text className="text-sm font-medium text-foreground">Retry</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Discard saved message"
              className="min-h-9 items-center justify-center rounded-lg px-4"
              onPress={() => void removeThreadOutboxMessage(message).catch(console.warn)}
            >
              <Text className="text-sm text-foreground-muted">Discard</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}
