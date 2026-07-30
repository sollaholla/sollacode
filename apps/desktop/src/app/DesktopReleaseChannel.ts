const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function resolveDesktopReleaseChannel(appVersion: string): "latest" | "nightly" {
  return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}
