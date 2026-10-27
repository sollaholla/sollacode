import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ConnectComputerEmptyState } from "../connection/ConnectComputerEmptyState";
import { ConnectionEnvironmentRow } from "../connection/ConnectionEnvironmentRow";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  applyShowcaseLocalEnvironmentDisplayUrls,
  resolveShowcaseEnvironmentUpdateDisplayUrl,
} from "../showcase/showcaseEnvironmentRows";
import { markNativeShowcaseReady } from "../showcase/nativeShowcaseScene";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

export function SettingsEnvironmentsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const localEnvironments = SHOWCASE_ENABLED
    ? applyShowcaseLocalEnvironmentDisplayUrls(connectedEnvironments)
    : connectedEnvironments;
  const hasLocalEnvironments = localEnvironments.length > 0;
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const headerIconColor = useThemeColor("--color-icon");

  useEffect(() => {
    if (!SHOWCASE_ENABLED) return;
    const timer = setTimeout(() => markNativeShowcaseReady("environments"), 500);
    return () => clearTimeout(timer);
  }, []);

  const handleToggle = useCallback((environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);
  const handleUpdateEnvironment = useCallback(
    (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) => {
      if (!SHOWCASE_ENABLED) return onUpdateEnvironment(environmentId, updates);
      const actualEnvironment = connectedEnvironments.find(
        (environment) => environment.environmentId === environmentId,
      );
      const presentedEnvironment = localEnvironments.find(
        (environment) => environment.environmentId === environmentId,
      );
      return onUpdateEnvironment(environmentId, {
        ...updates,
        displayUrl:
          actualEnvironment && presentedEnvironment
            ? resolveShowcaseEnvironmentUpdateDisplayUrl({
                actualDisplayUrl: actualEnvironment.displayUrl,
                presentedDisplayUrl: presentedEnvironment.displayUrl,
                submittedDisplayUrl: updates.displayUrl,
              })
            : updates.displayUrl,
      });
    },
    [connectedEnvironments, localEnvironments, onUpdateEnvironment],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title="Environments"
            onBack={() => navigation.goBack()}
            actions={[
              {
                accessibilityLabel: "Connect a computer",
                icon: "plus",
                onPress: () =>
                  navigation.navigate("SettingsSheet", { screen: "SettingsEnvironmentNew" }),
              },
            ]}
          />
        </>
      ) : (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Button
            accessibilityLabel="Connect a computer"
            icon="plus"
            onPress={() =>
              navigation.navigate("SettingsSheet", { screen: "SettingsEnvironmentNew" })
            }
            separateBackground
            tintColor={headerIconColor}
          />
        </NativeHeaderToolbar>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        {hasLocalEnvironments ? (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {localEnvironments.map((environment, index) => (
              <View
                key={environment.environmentId}
                collapsable={false}
                className={cn(index !== 0 && "border-t border-border")}
              >
                <ConnectionEnvironmentRow
                  environment={environment}
                  expanded={expandedId === environment.environmentId}
                  onToggle={() => handleToggle(environment.environmentId)}
                  onReconnect={onReconnectEnvironment}
                  onRemove={onRemoveEnvironmentPress}
                  onUpdate={handleUpdateEnvironment}
                />
              </View>
            ))}
          </View>
        ) : (
          <ConnectComputerEmptyState
            onConnect={() =>
              navigation.navigate("SettingsSheet", { screen: "SettingsEnvironmentNew" })
            }
          />
        )}
      </ScrollView>
    </View>
  );
}
