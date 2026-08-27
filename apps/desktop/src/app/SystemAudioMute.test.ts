import { describe, expect, it, vi } from "vite-plus/test";

import { makeSystemAudioMuteController } from "./SystemAudioMute.ts";

describe("SystemAudioMute", () => {
  it("mutes macOS output for recording and restores an initially unmuted computer", () => {
    const scripts: string[] = [];
    const cancelSafetyRestore = vi.fn();
    const controller = makeSystemAudioMuteController({
      platform: "darwin",
      runAppleScript: (script) => {
        scripts.push(script);
        return script.startsWith("output muted") ? "false\n" : "";
      },
      scheduleSafetyRestore: () => cancelSafetyRestore,
    });

    expect(controller.setCaptureActive("dictation", true)).toBe(true);
    expect(controller.setCaptureActive("dictation", true)).toBe(true);
    expect(controller.setCaptureActive("dictation", false)).toBe(true);
    expect(scripts).toEqual([
      "output muted of (get volume settings)",
      "set volume output muted true",
      "set volume output muted false",
    ]);
    expect(cancelSafetyRestore).toHaveBeenCalledOnce();
  });

  it("preserves an already-muted computer", () => {
    const scripts: string[] = [];
    const controller = makeSystemAudioMuteController({
      platform: "darwin",
      runAppleScript: (script) => {
        scripts.push(script);
        return "true\n";
      },
      scheduleSafetyRestore: () => () => undefined,
    });

    expect(controller.setCaptureActive("dictation", true)).toBe(true);
    expect(controller.setCaptureActive("dictation", false)).toBe(true);
    expect(scripts).toEqual(["output muted of (get volume settings)"]);
  });

  it("is a no-op outside macOS", () => {
    const runAppleScript = vi.fn(() => "");
    const controller = makeSystemAudioMuteController({
      platform: "win32",
      runAppleScript,
    });

    expect(controller.setCaptureActive("dictation", true)).toBe(false);
    expect(controller.setCaptureActive("dictation", false)).toBe(false);
    expect(runAppleScript).not.toHaveBeenCalled();
  });

  it("keeps output muted until every voice-capture owner releases it", () => {
    const scripts: string[] = [];
    const controller = makeSystemAudioMuteController({
      platform: "darwin",
      runAppleScript: (script) => {
        scripts.push(script);
        return script.startsWith("output muted") ? "false\n" : "";
      },
      scheduleSafetyRestore: () => () => undefined,
    });

    expect(controller.setCaptureActive("dictation", true)).toBe(true);
    expect(controller.setCaptureActive("orchestrator", true)).toBe(true);
    expect(controller.setCaptureActive("dictation", false)).toBe(true);
    expect(scripts).toEqual([
      "output muted of (get volume settings)",
      "set volume output muted true",
    ]);

    expect(controller.setCaptureActive("orchestrator", false)).toBe(true);
    expect(scripts).toEqual([
      "output muted of (get volume settings)",
      "set volume output muted true",
      "set volume output muted false",
    ]);
  });
});
