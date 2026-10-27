import { describe, expect, it } from "vite-plus/test";

import {
  androidSdkCandidates,
  androidVersionName,
  avdNameFromDisplayName,
  parseAdbDevices,
  parseAvd,
  parseAvdmanagerDevices,
  parseEmulatorAvdName,
  parseSystemImage,
} from "./androidEmulators.ts";

const profile = (index: number, id: string, name: string, tag?: string) =>
  [
    `id: ${index} or "${id}"`,
    `    Name: ${name}`,
    "    OEM : Google",
    tag ? `    Tag : ${tag}` : null,
  ]
    .filter(Boolean)
    .join("\n");

describe("Android emulators", () => {
  it("finds the SDK where the SDK tools look for it", () => {
    expect(
      androidSdkCandidates({
        env: { ANDROID_HOME: "/sdk" },
        home: "/Users/me",
        platform: "darwin",
      }),
    ).toEqual(["/sdk", "/Users/me/Library/Android/sdk"]);
    expect(androidSdkCandidates({ env: {}, home: "/home/me", platform: "linux" })).toEqual([
      "/home/me/Android/Sdk",
    ]);
  });

  it("names installed phone images and skips watch and TV images", () => {
    expect(
      parseSystemImage(
        "system-images/android-36/google_apis/arm64-v8a",
        "AndroidVersion.ApiLevel=36\nSystemImage.TagDisplay=Google APIs\n",
      ),
    ).toEqual({
      id: "system-images;android-36;google_apis;arm64-v8a",
      name: "Android 16 · Google APIs (API 36)",
      apiLevel: 36,
    });
    expect(
      parseSystemImage(
        "system-images/android-35/android-wear/arm64-v8a",
        "AndroidVersion.ApiLevel=35",
      ),
    ).toBeNull();
    expect(androidVersionName(99)).toBe("Android API 99");
  });

  it("offers recent Pixels newest first, then the Fold, Tablet, and generic sizes", () => {
    const output = [
      "Available devices definitions:",
      profile(1, "automotive_1024p_landscape", "Automotive", "android-automotive"),
      profile(2, "pixel_5", "Pixel 5"),
      profile(3, "pixel_9", "Pixel 9"),
      profile(4, "pixel_tablet", "Pixel Tablet"),
      profile(5, "pixel_10_pro", "Pixel 10 Pro"),
      profile(6, "medium_phone", "Medium Phone"),
      profile(7, "Nexus 5", "Nexus 5"),
      profile(8, "wearos_large_round", "Wear OS Large Round", "android-wear"),
    ].join("\n---------\n");
    expect(parseAvdmanagerDevices(output)).toEqual([
      { id: "pixel_10_pro", name: "Pixel 10 Pro", kind: "phone" },
      { id: "pixel_9", name: "Pixel 9", kind: "phone" },
      { id: "pixel_tablet", name: "Pixel Tablet", kind: "tablet" },
      { id: "medium_phone", name: "Medium Phone", kind: "phone" },
    ]);
  });

  it("reads an AVD's name, model, Android version, and shape", () => {
    expect(
      parseAvd({
        name: "Pixel_10_Pro",
        config: [
          "avd.ini.displayname=Pixel 10 Pro",
          "hw.device.name=pixel_10_pro",
          "hw.lcd.width=1280",
          "hw.lcd.height=2856",
          "image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/",
        ].join("\n"),
      }),
    ).toEqual({
      platform: "android",
      id: "Pixel_10_Pro",
      name: "Pixel 10 Pro",
      model: "Pixel 10 Pro",
      system: "Android 16",
      kind: "phone",
    });
    expect(
      parseAvd({ name: "Big_Screen", config: "hw.lcd.width=2560\nhw.lcd.height=1600\n" }),
    ).toMatchObject({ name: "Big Screen", model: null, system: null, kind: "tablet" });
  });

  it("reads running emulators from adb", () => {
    expect(
      parseAdbDevices(
        "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M\tdevice\n\n",
      ),
    ).toEqual([
      { serial: "emulator-5554", online: true },
      { serial: "emulator-5556", online: false },
    ]);
    expect(parseEmulatorAvdName("Pixel_10_Pro\r\nOK\r\n")).toBe("Pixel_10_Pro");
    expect(parseEmulatorAvdName("OK\n")).toBeNull();
  });

  it("turns a display name into a valid AVD name", () => {
    expect(avdNameFromDisplayName("Pixel 10 Pro (test)")).toBe("Pixel_10_Pro_test");
    expect(avdNameFromDisplayName("  ")).toBe("Emulator");
  });
});
