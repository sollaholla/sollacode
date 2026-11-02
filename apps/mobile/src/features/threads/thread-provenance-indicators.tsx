import { memo } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadCreatorLabel } from "../../state/threadCreator";
import type { ThreadProvenance } from "./thread-provenance";

export const ThreadProvenanceIndicators = memo(function ThreadProvenanceIndicators(props: {
  readonly thread: ThreadProvenance;
  readonly selected?: boolean;
  readonly size?: number;
}) {
  const subtleColor = useThemeColor("--color-icon-subtle");
  const creatorLabel = useThreadCreatorLabel(props.thread);
  const tintColor = props.selected ? "#ffffff" : subtleColor;
  const size = props.size ?? 12;
  if (creatorLabel === null) return null;

  return (
    <View className="shrink-0 flex-row items-center gap-1">
      <SymbolView
        accessibilityLabel={creatorLabel}
        name={{ ios: "sparkles", android: "auto_awesome" }}
        size={size}
        testID={`thread-agent-created-${props.thread.id}`}
        tintColor={tintColor}
        type="monochrome"
      />
    </View>
  );
});
