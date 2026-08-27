// @effect-diagnostics nodeBuiltinImport:off - Exit-safe macOS audio restoration requires synchronous process APIs.
// @effect-diagnostics globalTimers:off - A short unref'ed safety timer restores audio if the renderer disappears.
import * as NodeChildProcess from "node:child_process";

const APPLE_SCRIPT_PATH = "/usr/bin/osascript";
const MAX_RECORDING_MUTE_MS = 125_000;

type RunAppleScript = (script: string) => string;

export interface SystemAudioMuteController {
  readonly setCaptureActive: (owner: VoiceCaptureAudioMuteOwner, active: boolean) => boolean;
  readonly restoreAll: () => boolean;
}

export type VoiceCaptureAudioMuteOwner = "dictation" | "orchestrator";

export function makeSystemAudioMuteController(input: {
  readonly platform: NodeJS.Platform;
  readonly runAppleScript?: RunAppleScript;
  readonly scheduleSafetyRestore?: (restore: () => void) => () => void;
}): SystemAudioMuteController {
  const platform = input.platform;
  const runAppleScript =
    input.runAppleScript ??
    ((script: string) =>
      NodeChildProcess.execFileSync(APPLE_SCRIPT_PATH, ["-e", script], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "pipe"],
      }));
  const scheduleSafetyRestore =
    input.scheduleSafetyRestore ??
    ((restore: () => void) => {
      const timeout = setTimeout(restore, MAX_RECORDING_MUTE_MS);
      timeout.unref();
      return () => clearTimeout(timeout);
    });

  let originalMuted: boolean | null = null;
  let cancelSafetyRestore: (() => void) | null = null;
  const activeOwners = new Set<VoiceCaptureAudioMuteOwner>();

  const restore = (): boolean => {
    activeOwners.clear();
    if (originalMuted === null) return platform === "darwin";
    const shouldRemainMuted = originalMuted;
    originalMuted = null;
    cancelSafetyRestore?.();
    cancelSafetyRestore = null;
    try {
      if (!shouldRemainMuted) {
        runAppleScript("set volume output muted false");
      }
      return true;
    } catch {
      return false;
    }
  };

  return {
    setCaptureActive(owner, active) {
      if (platform !== "darwin") return false;
      if (!active) {
        activeOwners.delete(owner);
        return activeOwners.size > 0 || restore();
      }
      if (activeOwners.has(owner)) return true;
      activeOwners.add(owner);
      if (originalMuted !== null) return true;

      let wasMuted = false;
      try {
        wasMuted = runAppleScript("output muted of (get volume settings)").trim() === "true";
        if (!wasMuted) {
          runAppleScript("set volume output muted true");
        }
        originalMuted = wasMuted;
        cancelSafetyRestore = scheduleSafetyRestore(() => {
          restore();
        });
        return true;
      } catch {
        activeOwners.delete(owner);
        if (!wasMuted) {
          try {
            runAppleScript("set volume output muted false");
          } catch {
            // Best effort: audio muting must never prevent microphone capture.
          }
        }
        originalMuted = null;
        return false;
      }
    },
    restoreAll: restore,
  };
}

let systemAudioMuteController: SystemAudioMuteController | null = null;

process.once("exit", () => {
  systemAudioMuteController?.restoreAll();
});

export function setVoiceCaptureSystemAudioMuted(
  platform: NodeJS.Platform,
  owner: VoiceCaptureAudioMuteOwner,
  muted: boolean,
): boolean {
  systemAudioMuteController ??= makeSystemAudioMuteController({ platform });
  return systemAudioMuteController.setCaptureActive(owner, muted);
}
