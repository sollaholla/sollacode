// @effect-diagnostics nodeBuiltinImport:off - Pure path joins for host SDK locations.
import * as NodePath from "node:path";

import type { DeviceKind, DeviceModelOption, DeviceSummary } from "@t3tools/contracts";

/** Where an Android SDK usually lives, in the order the SDK tools themselves check. */
export function androidSdkCandidates(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}): string[] {
  const candidates = [input.env.ANDROID_HOME, input.env.ANDROID_SDK_ROOT];
  if (input.platform === "darwin") {
    candidates.push(NodePath.join(input.home, "Library", "Android", "sdk"));
  } else if (input.platform === "win32") {
    const localAppData = input.env.LOCALAPPDATA ?? NodePath.join(input.home, "AppData", "Local");
    candidates.push(NodePath.win32.join(localAppData, "Android", "Sdk"));
  } else {
    candidates.push(NodePath.join(input.home, "Android", "Sdk"));
  }
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

/**
 * Java for `avdmanager`. Android Studio bundles one, which is the only Java
 * most people who install it have.
 */
export function androidJavaHomeCandidates(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): string[] {
  const candidates = [input.env.JAVA_HOME];
  if (input.platform === "darwin") {
    candidates.push("/Applications/Android Studio.app/Contents/jbr/Contents/Home");
  } else if (input.platform === "win32") {
    candidates.push("C:\\Program Files\\Android\\Android Studio\\jbr");
  } else {
    candidates.push("/opt/android-studio/jbr", "/snap/android-studio/current/jbr");
  }
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

/** `key=value` files: AVD `config.ini`, `<name>.ini`, and image `source.properties`. */
export function parseIni(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0 || line.trimStart().startsWith("#")) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

const ANDROID_VERSIONS = new Map<number, string>([
  [37, "17"],
  [36, "16"],
  [35, "15"],
  [34, "14"],
  [33, "13"],
  [32, "12L"],
  [31, "12"],
  [30, "11"],
  [29, "10"],
  [28, "9"],
  [27, "8.1"],
  [26, "8.0"],
]);

export function androidVersionName(apiLevel: number): string {
  const version = ANDROID_VERSIONS.get(apiLevel);
  return version ? `Android ${version}` : `Android API ${apiLevel}`;
}

function apiLevelFromImagePath(imagePath: string): number | null {
  const match = /android-(\d+)/u.exec(imagePath);
  return match ? Number(match[1]) : null;
}

/**
 * One installed system image, read from its `source.properties`.
 * `relativeDir` is its path under the SDK, such as
 * `system-images/android-36/google_apis/arm64-v8a`.
 */
export function parseSystemImage(
  relativeDir: string,
  sourceProperties: string,
): { id: string; name: string; apiLevel: number } | null {
  const segments = relativeDir.split(/[\\/]/u).filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "system-images") return null;
  const properties = parseIni(sourceProperties);
  const apiLevel =
    Number(properties.get("AndroidVersion.ApiLevel")) || apiLevelFromImagePath(segments[1]!);
  if (!apiLevel) return null;
  const tag = properties.get("SystemImage.TagDisplay") ?? segments[2]!;
  // Wear, TV, and automotive images can't run the phone and tablet models offered here.
  if (/wear|tv|automotive|desktop|xr/iu.test(segments[2]!)) return null;
  return {
    id: segments.join(";"),
    name: `${androidVersionName(apiLevel)} · ${tag} (API ${apiLevel})`,
    apiLevel,
  };
}

const RECENT_PIXEL_GENERATION = 6;
const GENERIC_PROFILES = new Set(["medium_phone", "small_phone", "medium_tablet", "small_tablet"]);

function profileKind(id: string): DeviceKind {
  return /tablet/iu.test(id) ? "tablet" : "phone";
}

/**
 * Phone and tablet hardware profiles from `avdmanager list device`: recent
 * Pixels newest first, then the Pixel Fold and Tablet, then the generic sizes.
 * Profiles with a `Tag` line are watches, TVs, cars, glasses, or desktops.
 */
export function parseAvdmanagerDevices(output: string): DeviceModelOption[] {
  const models: Array<DeviceModelOption & { readonly rank: number }> = [];
  for (const block of output.split(/^-{3,}\s*$/mu)) {
    const id = /^id:\s*\d+\s+or\s+"([^"]+)"/mu.exec(block)?.[1];
    const name = /^\s*Name:\s*(.+)$/mu.exec(block)?.[1]?.trim();
    if (!id || !name || /^\s*Tag\s*:/mu.test(block)) continue;
    const generation = /^pixel_(\d+)/u.exec(id)?.[1];
    let rank: number;
    if (generation !== undefined) {
      if (Number(generation) < RECENT_PIXEL_GENERATION) continue;
      rank = 1000 - Number(generation);
    } else if (id === "pixel_fold" || id === "pixel_tablet") {
      rank = 2000;
    } else if (GENERIC_PROFILES.has(id)) {
      rank = 3000;
    } else {
      continue;
    }
    models.push({ id, name, kind: profileKind(id), rank });
  }
  return models
    .toSorted((left, right) => left.rank - right.rank || left.name.localeCompare(right.name))
    .map(({ rank: _rank, ...model }) => model);
}

const PROFILE_WORDS = new Map([
  ["xl", "XL"],
  ["se", "SE"],
]);

/** `pixel_9_pro` → `Pixel 9 Pro`, for AVDs whose profile isn't in the catalog. */
export function humanizeDeviceProfile(profile: string): string {
  return profile
    .split(/[_\s]+/u)
    .filter(Boolean)
    .map((word) => PROFILE_WORDS.get(word) ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** An emulator, read from its AVD `config.ini`. State is filled in from adb. */
export function parseAvd(input: {
  readonly name: string;
  readonly config: string;
}): Omit<DeviceSummary, "state"> {
  const config = parseIni(input.config);
  const profile = config.get("hw.device.name") ?? null;
  const apiLevel = apiLevelFromImagePath(config.get("image.sysdir.1") ?? "");
  const width = Number(config.get("hw.lcd.width"));
  const height = Number(config.get("hw.lcd.height"));
  const kind: DeviceKind =
    (profile !== null && profileKind(profile) === "tablet") ||
    (width > 0 && height > 0 && width > height)
      ? "tablet"
      : "phone";
  return {
    platform: "android",
    id: input.name,
    name: config.get("avd.ini.displayname") || input.name.replaceAll("_", " "),
    model: profile ? humanizeDeviceProfile(profile) : null,
    system: apiLevel === null ? null : androidVersionName(apiLevel),
    kind,
  };
}

/** Running emulators from `adb devices`, by serial. */
export function parseAdbDevices(output: string): Array<{ serial: string; online: boolean }> {
  const emulators: Array<{ serial: string; online: boolean }> = [];
  for (const line of output.split(/\r?\n/u)) {
    const [serial, status] = line.trim().split(/\s+/u);
    if (!serial?.startsWith("emulator-") || !status) continue;
    emulators.push({ serial, online: status === "device" });
  }
  return emulators;
}

/** `adb -s <serial> emu avd name` prints the AVD name, then `OK`. */
export function parseEmulatorAvdName(output: string): string | null {
  const name = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== "OK");
  return name ?? null;
}

/** AVD names allow letters, digits, `.`, `_`, and `-`; the display name keeps the rest. */
export function avdNameFromDisplayName(displayName: string): string {
  const base = displayName
    .normalize("NFKD")
    .replace(/[^\w.-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^[_.-]+|[_.-]+$/gu, "");
  return base.length > 0 ? base.slice(0, 64) : "Emulator";
}
