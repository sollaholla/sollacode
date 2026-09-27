import { View } from "react-native";

function LoadingStripFrame(props: { readonly children: React.ReactNode }) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden"
    >
      {props.children}
    </View>
  );
}

export function LoadingStrip(props: { readonly progress?: number }) {
  if (props.progress === undefined) {
    return (
      <LoadingStripFrame>
        <View className="h-full w-full bg-primary/35" />
      </LoadingStripFrame>
    );
  }

  const clampedProgress = Math.min(1, Math.max(0, props.progress));

  return (
    <LoadingStripFrame>
      <View
        className="h-full rounded-r-full bg-primary"
        style={{ width: `${clampedProgress * 100}%` }}
      />
    </LoadingStripFrame>
  );
}
