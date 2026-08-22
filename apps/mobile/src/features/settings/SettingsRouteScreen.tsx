import { useAtomSet, useAtomValue } from "@effect/atom-react";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useNavigation } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { useThemeColor } from "../../lib/useThemeColor";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function SettingsRouteScreen() {
  const navigation = useNavigation();

  return (
    <>
      <WorkspaceSidebarToolbar />
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Settings" onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions
          options={{
            unstable_headerRightItems:
              Platform.OS === "ios"
                ? () => [
                    withNativeGlassHeaderItem({
                      accessibilityLabel: "Close settings",
                      icon: { name: "xmark", type: "sfSymbol" } as const,
                      identifier: "settings-close",
                      label: "",
                      onPress: () => navigation.goBack(),
                      type: "button",
                    }),
                  ]
                : undefined,
          }}
        />
      )}
      <LocalSettingsRouteScreen />
    </>
  );
}

function LocalSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentCount = Object.keys(savedConnectionsById).length;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title="Configuration">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            target="SettingsEnvironments"
          />
          <SettingsRow icon="person.2" label="Agents" fullScreenTarget="Agents" />
        </SettingsSection>

        <GeneralSettingsSection />

        <OrchestratorSettingsSection />

        <SettingsSection title="Appearance">
          <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        </SettingsSection>

        <BetaSettingsSection />

        <ArchivedThreadsSettingsSection />

        <AppSettingsSection />
      </ScrollView>
    </View>
  );
}

function GeneralSettingsSection() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const projectGroupingEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.projectGroupingEnabled !== false
    : true;

  return (
    <SettingsSection title="General">
      <SettingsSwitchRow
        icon="folder"
        label="Project Grouping"
        value={projectGroupingEnabled}
        onValueChange={(value) => savePreferences({ projectGroupingEnabled: value })}
      />
    </SettingsSection>
  );
}

function OrchestratorSettingsSection() {
  return (
    <SettingsSection title="Orchestrator">
      <SettingsRow icon="waveform" label="Open Orchestrator" fullScreenTarget="Orchestrator" />
    </SettingsSection>
  );
}

/**
 * Device-local beta toggles. Mobile has no client-settings sync, so this is
 * the counterpart of web's Settings → Beta backed by mobile preferences.
 */
function BetaSettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const threadListV2Enabled = useThreadListV2Enabled();

  return (
    <View className="gap-3">
      <SettingsSection title="Beta">
        <SettingsSwitchRow
          icon="sidebar.left"
          label="Thread List v2"
          value={threadListV2Enabled}
          onValueChange={(value) => savePreferences({ threadListV2Enabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        One flat thread list in creation order. Active work renders as cards; settled threads
        collapse to compact rows. Switch back any time.
      </Text>
    </View>
  );
}

type UpdateCheckState = "idle" | "checking" | "downloading" | "restarting" | "current";

function AppSettingsSection() {
  const icon = useThemeColor("--color-icon");
  const [updateState, setUpdateState] = useState<UpdateCheckState>("idle");
  const updateInFlight = useRef(false);

  const version = Constants.expoConfig?.version ?? "0.0.0";
  // Fall back to "production" to match resolveAppVariant in app.config.ts, so a
  // missing variant never mislabels a production build as development.
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const versionLabel = variantLabel ? `${version} · ${variantLabel}` : version;
  // Which JS is actually running: the bundle shipped in the binary, or an OTA
  // update downloaded on top of it. Surfacing this makes "am I even on the
  // right build?" answerable at a glance.
  const bundleLabel = Updates.isEnabled
    ? Updates.isEmbeddedLaunch
      ? "Embedded"
      : Updates.updateId
        ? `OTA ${Updates.updateId.slice(0, 7)}`
        : null
    : null;

  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";

  // "Up to date" is a transient acknowledgement, not a state worth persisting —
  // drop back to the bundle label so the row keeps answering "what am I running?".
  useEffect(() => {
    if (updateState !== "current") return;
    const timer = setTimeout(() => setUpdateState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [updateState]);

  const checkForUpdate = useCallback(async () => {
    // `disabled={busy}` only takes effect on the next render, so two taps in the
    // same frame would both get through. The ref closes that window.
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    try {
      await runUpdateCheck(setUpdateState);
    } finally {
      updateInFlight.current = false;
    }
  }, []);

  const statusLabel =
    updateState === "checking"
      ? "Checking…"
      : updateState === "downloading"
        ? "Downloading…"
        : updateState === "restarting"
          ? "Restarting…"
          : updateState === "current"
            ? "Up to date"
            : bundleLabel;

  const versionRow = (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="info.circle"
        size={22}
        tintColor={icon}
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">Version</Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
      {Updates.isEnabled ? (
        <View className="w-[22px] items-center">
          {busy ? (
            <ActivityIndicator color={icon} size="small" />
          ) : (
            <SymbolView
              name="arrow.clockwise"
              size={18}
              tintColor={icon}
              type="monochrome"
              weight="semibold"
            />
          )}
        </View>
      ) : null}
    </View>
  );

  return (
    <SettingsSection title="App">
      <SettingsRow icon="internaldrive" label="Client Storage" target="SettingsClientStorage" />
      <SettingsRow icon="doc.text" label="Legal" fullScreenTarget="SettingsLegal" />
      {Updates.isEnabled ? (
        <Pressable
          accessibilityLabel="Check for updates"
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void checkForUpdate()}
        >
          {versionRow}
        </Pressable>
      ) : (
        versionRow
      )}
    </SettingsSection>
  );
}

async function runUpdateCheck(setUpdateState: (state: UpdateCheckState) => void): Promise<void> {
  setUpdateState("checking");
  const check = await settlePromise(() => Updates.checkForUpdateAsync());
  if (check._tag === "Failure") {
    reportUpdateFailure(check, "Could not check for updates.");
    setUpdateState("idle");
    return;
  }
  // A rollback directive (`eas update:rollback`) arrives as isAvailable: false
  // with isRollBackToEmbedded: true — there is nothing newer to install, but the
  // running OTA still has to be dropped for the embedded bundle.
  if (!check.value.isAvailable && !check.value.isRollBackToEmbedded) {
    setUpdateState("current");
    return;
  }

  setUpdateState("downloading");
  const fetched = await settlePromise(() => Updates.fetchUpdateAsync());
  if (fetched._tag === "Failure") {
    reportUpdateFailure(fetched, "Could not download the update.");
    setUpdateState("idle");
    return;
  }
  // isNew is always false for a rollback, so it can't be the sole gate here either.
  if (!fetched.value.isNew && !fetched.value.isRollBackToEmbedded) {
    setUpdateState("current");
    return;
  }

  setUpdateState("restarting");
  // reloadAsync never resolves on success — the JS context is torn down — so
  // reaching the failure branch below is the only way this returns.
  const reloaded = await settlePromise(() => Updates.reloadAsync());
  if (reloaded._tag === "Failure") {
    reportUpdateFailure(reloaded, "Downloaded, but could not restart the app.");
    setUpdateState("idle");
  }
}

function reportUpdateFailure(result: AtomCommandResult<unknown, unknown>, fallback: string): void {
  reportAtomCommandResult(result, { label: "app update check" });
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  Alert.alert("Update failed", error instanceof Error ? error.message : fallback);
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function ArchivedThreadsSettingsSection() {
  return (
    <SettingsSection title="Threads">
      <SettingsRow icon="archivebox" label="Archived Threads" target="SettingsArchive" />
    </SettingsSection>
  );
}
