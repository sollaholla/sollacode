import { describe, expect, it } from "vite-plus/test";

import {
  defaultMicrophoneKey,
  isMissingMicrophoneError,
  microphoneChoices,
  microphoneConstraintsFor,
} from "./microphones";

const input = (deviceId: string, label: string, groupId = deviceId) =>
  ({ deviceId, groupId, kind: "audioinput", label }) as MediaDeviceInfo;

describe("microphone choices", () => {
  it("lists real microphones once, and names the system default from Chrome's alias", () => {
    const choices = microphoneChoices([
      input("default", "Default - AirPods Pro (Bluetooth)", "g-air"),
      input("communications", "Communications - MacBook Pro Microphone", "g-mac"),
      input("mac", "MacBook Pro Microphone", "g-mac"),
      input("air", "AirPods Pro (Bluetooth)", "g-air"),
      {
        deviceId: "spk",
        groupId: "g-mac",
        kind: "audiooutput",
        label: "Speakers",
      } as MediaDeviceInfo,
    ]);
    expect(choices.defaultLabel).toBe("AirPods Pro (Bluetooth)");
    expect(choices.devices).toEqual([
      { deviceId: "mac", label: "MacBook Pro Microphone" },
      { deviceId: "air", label: "AirPods Pro (Bluetooth)" },
    ]);
  });

  it("takes the first microphone as the default where there is no alias, and names unlabelled ones", () => {
    const choices = microphoneChoices([input("a", "iPhone Microphone"), input("b", "")]);
    expect(choices.defaultLabel).toBe("iPhone Microphone");
    expect(choices.devices[1]).toEqual({ deviceId: "b", label: "Microphone 2" });
  });

  it("notices the system default changing", () => {
    const before = defaultMicrophoneKey([input("default", "Default - Mac", "g-mac")]);
    const same = defaultMicrophoneKey([
      input("default", "Default - Mac", "g-mac"),
      input("air", "AirPods", "g-air"),
    ]);
    const after = defaultMicrophoneKey([input("default", "Default - AirPods", "g-air")]);
    expect(same).toBe(before);
    expect(after).not.toBe(before);
    expect(defaultMicrophoneKey([input("a", "First"), input("b", "Second")])).toBe("a");
    expect(defaultMicrophoneKey([])).toBeNull();
  });

  it("asks for an exact device only when one is chosen", () => {
    expect(microphoneConstraintsFor("mac")).toMatchObject({ deviceId: { exact: "mac" } });
    expect(microphoneConstraintsFor(null)).not.toHaveProperty("deviceId");
    expect(microphoneConstraintsFor(null)).toMatchObject({ echoCancellation: true });
  });

  it("treats only a missing device as a reason to fall back", () => {
    expect(isMissingMicrophoneError({ name: "OverconstrainedError" })).toBe(true);
    expect(isMissingMicrophoneError({ name: "NotFoundError" })).toBe(true);
    expect(isMissingMicrophoneError({ name: "NotAllowedError" })).toBe(false);
    expect(isMissingMicrophoneError(null)).toBe(false);
  });
});
