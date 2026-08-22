const WINDOWS_DISABLED_CAPTURE_FEATURES = ["WebRtcAllowWgcScreenCapturer"] as const;

/**
 * WGC can refuse monitor capture with E_ACCESSDENIED on otherwise capturable
 * Windows desktops. Chromium's screen-capture feature flag is explicitly
 * overridable, so use its DirectX/GDI path on Windows and leave every other
 * platform untouched.
 */
export function disabledCaptureFeatures(platform: NodeJS.Platform): string | undefined {
  return platform === "win32" ? WINDOWS_DISABLED_CAPTURE_FEATURES.join(",") : undefined;
}
