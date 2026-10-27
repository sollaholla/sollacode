import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, Platform, Pressable, ScrollView, View } from "react-native";
import type { TextInput as NativeTextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ConnectionSheetButton } from "./ConnectionSheetButton";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  buildPairingUrl,
  cameraPermissionAction,
  extractPairingUrlFromQrPayload,
  parsePairingUrl,
  readPairingLink,
} from "./pairing";

type ConnectionsNewRouteParams = {
  readonly mode?: string;
};

export function ConnectionsNewRouteScreen({
  route,
}: StaticScreenProps<ConnectionsNewRouteParams | undefined>) {
  const {
    connectionPairingUrl,
    onChangeConnectionPairingUrl,
    onConnectPress,
    pairingConnectionError,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const [linkInput, setLinkInput] = useState(connectionPairingUrl);
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(route.params?.mode === "scan_qr");
  const [cameraPermission, requestCameraPermission, getCameraPermission] = useCameraPermissions();
  const scannerLocked = useRef(false);
  const submitting = useRef(false);
  const codeInputRef = useRef<NativeTextInput>(null);
  const headerIconColor = useThemeColor("--color-icon");
  const cameraAction = cameraPermissionAction(cameraPermission);
  const connectDisabled = isSubmitting || (showManual ? !hostInput.trim() : !linkInput.trim());

  useEffect(() => {
    const { host, code } = parsePairingUrl(connectionPairingUrl);
    setLinkInput(connectionPairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [connectionPairingUrl]);

  useEffect(() => {
    if (!showScanner) return;
    // Returning from system Settings does not refocus the navigation route.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void getCameraPermission().catch(() => {});
    });
    return () => subscription.remove();
  }, [getCameraPermission, showScanner]);

  const openSystemSettings = useCallback(async () => {
    try {
      await Linking.openSettings();
    } catch {
      setLocalError("Open this device’s Settings and allow camera access for Solla Code.");
    }
  }, []);

  const openScanner = useCallback(async () => {
    setLocalError(null);
    scannerLocked.current = false;
    setShowScanner(true);
    if (cameraAction !== "request") return;
    try {
      await requestCameraPermission();
    } catch {
      setLocalError("Could not open the camera. You can paste a connection link instead.");
    }
  }, [cameraAction, requestCameraPermission]);

  const closeScanner = useCallback(() => {
    setShowScanner(false);
    scannerLocked.current = false;
  }, []);

  const applyPairingLink = useCallback((pairingUrl: string) => {
    const { host, code } = parsePairingUrl(pairingUrl);
    setLinkInput(pairingUrl);
    setHostInput(host);
    setCodeInput(code);
    setShowManual(false);
    setLocalError(null);
    setShowScanner(false);
  }, []);

  const handleQrScan = useCallback(
    ({ data }: { readonly data: string }) => {
      // The camera can emit multiple scans before React commits a state update.
      if (scannerLocked.current) return;
      scannerLocked.current = true;
      try {
        applyPairingLink(extractPairingUrlFromQrPayload(data));
      } catch {
        Alert.alert(
          "Not a Solla Code connection code",
          "On your computer, open Settings → Connections → Connect another device and scan that QR code.",
          [
            {
              text: "Try again",
              onPress: () => {
                scannerLocked.current = false;
              },
            },
          ],
        );
      }
    },
    [applyPairingLink],
  );

  const pastePairingLink = useCallback(async () => {
    try {
      const clipboard = await Clipboard.getStringAsync();
      applyPairingLink(readPairingLink(clipboard));
    } catch {
      setLocalError(
        "Copy the full connection link from Solla Code on your computer, then paste it here.",
      );
    }
  }, [applyPairingLink]);

  const handleSubmit = useCallback(async () => {
    if (submitting.current) return;
    setLocalError(null);
    let pairingUrl: string;
    try {
      pairingUrl = readPairingLink(showManual ? buildPairingUrl(hostInput, codeInput) : linkInput);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Enter a valid connection link.");
      return;
    }
    submitting.current = true;
    setIsSubmitting(true);
    try {
      onChangeConnectionPairingUrl(pairingUrl);
      const result = await onConnectPress(pairingUrl);
      if (AsyncResult.isSuccess(result)) {
        if (navigation.canGoBack()) navigation.goBack();
        else navigation.dispatch(StackActions.replace("Home"));
      }
    } finally {
      submitting.current = false;
      setIsSubmitting(false);
    }
  }, [
    codeInput,
    hostInput,
    linkInput,
    showManual,
    onChangeConnectionPairingUrl,
    onConnectPress,
    navigation,
  ]);

  const toggleManual = () => {
    if (!showManual) {
      const { host, code } = parsePairingUrl(linkInput);
      setHostInput(host);
      setCodeInput(code);
    } else {
      setLinkInput(buildPairingUrl(hostInput, codeInput));
    }
    setShowManual(!showManual);
    setLocalError(null);
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          ...(Platform.OS === "android" ? { headerShown: false } : null),
          title: showScanner ? "Scan QR code" : "Connect a computer",
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={showScanner ? "Scan QR code" : "Connect a computer"}
          onBack={() => navigation.goBack()}
          actions={
            showScanner
              ? [{ accessibilityLabel: "Close scanner", icon: "xmark", onPress: closeScanner }]
              : []
          }
        />
      ) : showScanner ? (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Button
            accessibilityLabel="Close scanner"
            icon="xmark"
            onPress={closeScanner}
            separateBackground
            tintColor={headerIconColor}
          />
        </NativeHeaderToolbar>
      ) : null}

      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <View collapsable={false} className="gap-5">
          <View className="gap-2 px-1">
            <Text className="text-lg font-t3-bold">Your workspace, on this device</Text>
            <Text className="text-sm leading-normal text-foreground-muted">
              Projects and agents run on your computer. Connect this device to use the same threads
              wherever you are. No separate Solla account is needed.
            </Text>
            <Text className="text-sm leading-normal text-foreground-muted">
              On your computer, open Solla Code → Settings → Connections → Connect another device.
            </Text>
          </View>

          {showScanner ? (
            <View className="gap-4">
              {cameraAction === "scan" && isFocused ? (
                <View className="overflow-hidden rounded-[24px] border-continuous">
                  <CameraView
                    barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                    onBarcodeScanned={handleQrScan}
                    style={{ aspectRatio: 1, width: "100%" }}
                  />
                </View>
              ) : (
                <View className="items-center gap-3 rounded-[24px] border-continuous bg-card px-5 py-8">
                  <Text className="text-center text-base font-t3-bold">
                    {cameraAction === "settings"
                      ? "Camera access is off"
                      : "Scan your computer’s QR code"}
                  </Text>
                  <Text className="text-center text-sm leading-normal text-foreground-muted">
                    {cameraAction === "settings"
                      ? "Allow camera access in this device’s Settings, or use a connection link below."
                      : "Allow camera access to scan the QR code shown by Solla Code on your computer."}
                  </Text>
                  <ConnectionSheetButton
                    icon={cameraAction === "settings" ? "gearshape" : "camera"}
                    label={cameraAction === "settings" ? "Open Settings" : "Allow camera"}
                    tone="primary"
                    onPress={() => {
                      void (cameraAction === "settings" ? openSystemSettings() : openScanner());
                    }}
                  />
                </View>
              )}
              <ConnectionSheetButton
                icon="link"
                label="Use a connection link"
                onPress={closeScanner}
              />
            </View>
          ) : (
            <>
              <View className="gap-3">
                <ConnectionSheetButton
                  icon="qrcode.viewfinder"
                  label="Scan QR code"
                  tone="primary"
                  disabled={isSubmitting}
                  onPress={() => {
                    void openScanner();
                  }}
                />
                <ConnectionSheetButton
                  icon="doc.on.clipboard"
                  label="Paste connection link"
                  disabled={isSubmitting}
                  onPress={() => {
                    void pastePairingLink();
                  }}
                />
              </View>
              <View collapsable={false} className="gap-4 rounded-[24px] bg-card p-4">
                {showManual ? (
                  <>
                    <View className="gap-1.5">
                      <Text className="text-sm font-t3-bold">Computer address</Text>
                      <TextInput
                        accessibilityLabel="Computer address"
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        placeholder="https://your-computer.example.com"
                        value={hostInput}
                        editable={!isSubmitting}
                        onChangeText={(value) => {
                          setHostInput(value);
                          setLocalError(null);
                        }}
                        returnKeyType="next"
                        submitBehavior="submit"
                        onSubmitEditing={() => codeInputRef.current?.focus()}
                      />
                      <Text className="text-xs text-foreground-muted">
                        Use the full address shown on your computer, including http:// or https://.
                      </Text>
                    </View>
                    <View className="gap-1.5">
                      <Text className="text-sm font-t3-bold">Pairing code</Text>
                      <TextInput
                        ref={codeInputRef}
                        accessibilityLabel="Pairing code"
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder="Code from your computer"
                        value={codeInput}
                        editable={!isSubmitting}
                        onChangeText={(value) => {
                          setCodeInput(value);
                          setLocalError(null);
                        }}
                        returnKeyType="go"
                        onSubmitEditing={() => {
                          void handleSubmit();
                        }}
                      />
                    </View>
                  </>
                ) : (
                  <View className="gap-1.5">
                    <Text className="text-sm font-t3-bold">Connection link</Text>
                    <TextInput
                      accessibilityLabel="Connection link"
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      placeholder="Paste the full link from your computer"
                      value={linkInput}
                      editable={!isSubmitting}
                      onChangeText={(value) => {
                        setLinkInput(value);
                        setLocalError(null);
                      }}
                      returnKeyType="go"
                      onSubmitEditing={() => {
                        void handleSubmit();
                      }}
                    />
                  </View>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showManual, disabled: isSubmitting }}
                  disabled={isSubmitting}
                  onPress={toggleManual}
                  className="min-h-11 justify-center"
                >
                  <Text className="text-sm text-primary">
                    {showManual
                      ? "Use a connection link instead"
                      : "Enter an address and code instead"}
                  </Text>
                </Pressable>
                {(localError ?? pairingConnectionError) ? (
                  <ErrorBanner message={(localError ?? pairingConnectionError)!} />
                ) : null}
                <ConnectionSheetButton
                  icon="link"
                  label={isSubmitting ? "Connecting…" : "Connect"}
                  disabled={connectDisabled}
                  tone="primary"
                  onPress={() => {
                    void handleSubmit();
                  }}
                />
                <Text className="text-xs leading-normal text-foreground-muted">
                  Links expire and can only be used once. If a link no longer works, create a new
                  one on your computer.
                </Text>
              </View>
            </>
          )}
          {showScanner && localError ? <ErrorBanner message={localError} /> : null}
        </View>
      </ScrollView>
    </View>
  );
}
