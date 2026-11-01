import * as Schema from "effect/Schema";

import { getLocalStorageItem, useLocalStorage } from "../hooks/useLocalStorage";
import { microphoneConstraints } from "./voiceIsolation";

/** A microphone the person can pick for voice. A null `deviceId` is the system default. */
export interface MicrophoneOption {
  readonly deviceId: string | null;
  readonly label: string;
}

/** The microphones offered for voice, the system default first. */
export interface MicrophoneChoices {
  /** The device the system default is right now, when the browser says so. */
  readonly defaultLabel: string | null;
  readonly devices: ReadonlyArray<MicrophoneOption>;
}

// Chrome lists the system default (and on Windows the communications device)
// again under these ids; they are aliases, not microphones of their own.
const ALIAS_IDS = new Set(["default", "communications"]);
const DEFAULT_PREFIX = /^default\s*[-–—:]\s*/iu;

const audioInputs = (devices: ReadonlyArray<MediaDeviceInfo>) =>
  devices.filter((device) => device.kind === "audioinput");

/**
 * The system default microphone's identity, to notice when it changes. Chrome
 * names it in its `default` alias; other browsers list it first.
 */
export function defaultMicrophoneKey(devices: ReadonlyArray<MediaDeviceInfo>): string | null {
  const inputs = audioInputs(devices);
  const alias = inputs.find((device) => device.deviceId === "default");
  if (alias) return `${alias.groupId}\u0000${alias.label}`;
  return inputs[0]?.deviceId ?? null;
}

/** What the voice microphone menu offers, from the browser's device list. */
export function microphoneChoices(devices: ReadonlyArray<MediaDeviceInfo>): MicrophoneChoices {
  const inputs = audioInputs(devices);
  const alias = inputs.find((device) => device.deviceId === "default");
  const real = inputs.filter((device) => device.deviceId && !ALIAS_IDS.has(device.deviceId));
  const defaultLabel = alias
    ? alias.label.replace(DEFAULT_PREFIX, "").trim() || null
    : real[0]?.label.trim() || null;
  return {
    defaultLabel,
    devices: real.map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label.trim() || `Microphone ${index + 1}`,
    })),
  };
}

export async function listMicrophones(): Promise<MicrophoneChoices> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return { defaultLabel: null, devices: [] };
  }
  return microphoneChoices(await navigator.mediaDevices.enumerateDevices());
}

/** Audio constraints for one microphone, or for the system default when `deviceId` is null. */
export function microphoneConstraintsFor(deviceId: string | null): MediaTrackConstraints {
  return {
    ...microphoneConstraints(),
    ...(deviceId === null ? {} : { deviceId: { exact: deviceId } }),
  };
}

/** A capture failure meaning the asked-for microphone is not there (unplugged, renamed). */
export function isMissingMicrophoneError(error: unknown): boolean {
  const name = (error as { readonly name?: unknown } | null)?.name;
  return name === "OverconstrainedError" || name === "NotFoundError";
}

/**
 * What to tell the person when voice could not open a microphone, or null when
 * the failure was something else. The browser's own wording ("Permission
 * denied") names neither the microphone nor what to do about it.
 */
export function microphoneFailureMessage(error: unknown): string | null {
  switch ((error as { readonly name?: unknown } | null)?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Solla Code isn't allowed to use the microphone. Allow it in your browser or system settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Connect one, then try again.";
    case "NotReadableError":
      return "The microphone couldn't be opened. Another app may be using it.";
    default:
      return null;
  }
}

/** Opens a microphone, or the system default when the chosen one is gone or none is chosen. */
export async function openMicrophoneStream(deviceId: string | null): Promise<MediaStream> {
  if (deviceId !== null) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraintsFor(deviceId),
      });
    } catch (error) {
      if (!isMissingMicrophoneError(error)) throw error;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: microphoneConstraintsFor(null) });
}

const PREFERRED_MICROPHONE_KEY = "solla:voice-microphone";
const PreferredMicrophone = Schema.NullOr(Schema.String);

/**
 * The microphone voice uses on this device: agent calls and the orchestrator's
 * GPT-Live voice. Null (the default) follows the system's default microphone.
 */
export function usePreferredMicrophone() {
  return useLocalStorage(PREFERRED_MICROPHONE_KEY, null, PreferredMicrophone);
}

/** The stored choice, read when a voice session opens. */
export function readPreferredMicrophone(): string | null {
  try {
    return getLocalStorageItem(PREFERRED_MICROPHONE_KEY, PreferredMicrophone);
  } catch {
    return null;
  }
}
