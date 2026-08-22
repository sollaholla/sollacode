import Constants from "expo-constants";
import { Image } from "expo-image";

const appVariant = Constants.expoConfig?.extra?.appVariant;
const BRAND_MARK_SOURCE =
  appVariant === "development"
    ? require("../../../../assets/dev/blueprint-brand-mark-192.png")
    : appVariant === "preview"
      ? require("../../../../assets/nightly/nightly-brand-mark-192.png")
      : require("../../../../assets/prod/black-brand-mark-192.png");

export function BrandMark(props: { readonly compact?: boolean }) {
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;

  return (
    <Image
      source={BRAND_MARK_SOURCE}
      accessible
      accessibilityIgnoresInvertColors
      accessibilityLabel="Solla Code"
      contentFit="contain"
      style={{ width: iconSize, height: iconSize }}
    />
  );
}
