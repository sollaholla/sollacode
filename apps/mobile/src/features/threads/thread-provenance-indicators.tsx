import { memo } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ThreadProvenance } from "./thread-provenance";

export const ThreadProvenanceIndicators = memo(function ThreadProvenanceIndicators(props: {
  readonly thread: ThreadProvenance;
  readonly selected?: boolean;
  readonly size?: number;
}) {
  const subtleColor = useThemeColor("--color-icon-subtle");
  const tintColor = props.selected ? "#ffffff" : subtleColor;
  const size = props.size ?? 12;
  if (props.thread.createdByThreadId == null && props.thread.browserProfileThreadId == null) {
    return null;
  }

  return (
    <View className="shrink-0 flex-row items-center gap-1">
      {props.thread.createdByThreadId != null ? (
        <SymbolView
          accessibilityLabel="Created by an agent"
          name={{ ios: "sparkles", android: "auto_awesome" }}
          size={size}
          testID={`thread-agent-created-${props.thread.id}`}
          tintColor={tintColor}
          type="monochrome"
        />
      ) : null}
      {props.thread.browserProfileThreadId != null ? (
        <SymbolView
          accessibilityLabel="Uses a shared agent browser profile"
          name="link"
          size={size}
          testID={`thread-shared-browser-${props.thread.id}`}
          tintColor={tintColor}
          type="monochrome"
        />
      ) : null}
    </View>
  );
});
