// @effect-diagnostics nodeBuiltinImport:off - Compiling and driving the real PowerShell helper needs a raw child process, a temp script on disk, and its stdio.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  RemoteInputController,
  remoteInputCommand,
  remoteInputScriptSource,
} from "./RemoteInput.ts";

describe("RemoteInput", () => {
  it.effect("starts the persistent macOS helper and acknowledges a safe reset command", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (platform !== "darwin") return;
      const controller = new RemoteInputController(platform);
      yield* Effect.promise(() => controller.probe());
      yield* Effect.promise(() => controller.dispose());
    }),
  );

  it.effect("answers a live cursor-lock query from the real macOS helper", () =>
    Effect.gen(function* () {
      // Runs the actual JXA source, so this catches a syntax error or a bad
      // ObjC bridge call in the new cursor path — the kind of break that would
      // take the whole input helper down with it, not just this query.
      const platform = yield* HostProcessPlatform;
      if (platform !== "darwin") return;
      const controller = new RemoteInputController(platform);
      const locked = yield* Effect.promise(() => controller.readPointerLock());
      assert.isBoolean(locked);
      // Nothing has grabbed the cursor in a test run.
      assert.isFalse(locked);
      yield* Effect.promise(() => controller.dispose());
    }),
  );

  /**
   * Behavioural coverage for the Windows helper, which otherwise has only
   * string assertions against its source.
   *
   * PowerShell Core runs cross-platform, and `Add-Type` compiles the C# without
   * needing user32 to exist, so both the script's syntax and its P/Invoke
   * declarations can be checked from any host. The class itself is swapped for
   * a recorder — the real one would need Windows to execute — which leaves the
   * dispatch logic under test: it is the part that decides absolute versus
   * relative motion, and the part this change rewrote.
   *
   * Skipped where `pwsh` is unavailable rather than failing: this is extra
   * assurance, not a build requirement.
   */
  const pwshAvailable = (() => {
    try {
      NodeChildProcess.execFileSync(
        "pwsh",
        ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"],
        {
          stdio: "ignore",
          timeout: 20_000,
        },
      );
      return true;
    } catch {
      return false;
    }
  })();

  it("compiles the Windows C# and routes input to the right injector call", function () {
    if (!pwshAvailable) return;
    const source = remoteInputScriptSource("win32");
    const open = source.indexOf("Add-Type @'");
    const close = source.indexOf("'@", open);
    assert.isAbove(open, -1);
    assert.isAbove(close, open);

    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "solla-ps-test-"));
    const realCSharp = source.slice(open + "Add-Type @'".length, close);
    const compileScript = NodePath.join(directory, "compile.ps1");
    NodeFS.writeFileSync(
      compileScript,
      `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${realCSharp}\n'@\nWrite-Output 'compiled'\n`,
    );
    const compiled = NodeChildProcess.execFileSync("pwsh", ["-NoProfile", "-File", compileScript], {
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.include(compiled, "compiled");

    // Same script, real dispatch, recording stand-in for the P/Invoke class.
    const recorder = `
using System;
using System.Collections.Generic;
public static class SollaRemoteInput {
  public static List<string> Calls = new List<string>();
  public static string Blocked = null;
  public static void Pointer(double x, double y, uint flags, int data) { Calls.Add("Pointer"); }
  public static void MoveRelative(int dx, int dy) { Calls.Add("MoveRelative:" + dx + "," + dy); }
  public static void Mouse(uint flags, int data) { Calls.Add("Mouse:" + flags); }
  public static void Key(ushort vk, bool down) { Calls.Add("Key:" + vk + ":" + down); }
  public static bool CursorLocked() { Calls.Add("CursorLocked"); return true; }
  public static string CursorShape() { Calls.Add("CursorShape"); return "default"; }
  public static void RestorePointerMode() { Calls.Add("RestorePointerMode"); }
  public static string BlockReason() { return Blocked; }
}
`;
    const harness = `${source.slice(0, open)}Add-Type @'${recorder}'@${source.slice(close + 2)}
[Console]::Error.WriteLine("CALLS " + ([SollaRemoteInput]::Calls -join " | "))
`;
    const harnessScript = NodePath.join(directory, "harness.ps1");
    NodeFS.writeFileSync(harnessScript, harness);

    const commands = [
      `{"id":1,"kind":"input","input":{"type":"key","action":"down","code":"KeyW","key":"w","repeat":false}}`,
      `{"id":2,"kind":"input","input":{"type":"pointer","action":"move","x":0.5,"y":0.5,"button":"left","dx":12,"dy":-7}}`,
      `{"id":3,"kind":"input","input":{"type":"pointer","action":"move","x":0.25,"y":0.75,"button":"left"}}`,
      `{"id":4,"kind":"cursor"}`,
    ].join("\n");

    const run = NodeChildProcess.spawnSync("pwsh", ["-NoProfile", "-File", harnessScript], {
      input: `${commands}\n`,
      encoding: "utf8",
      timeout: 120_000,
    });
    const replies = String(run.stdout);
    const calls = String(run.stderr);

    // The cursor query must answer with the lock flag, not a bare ack.
    assert.match(replies, /"locked":\s*true/u);
    // A delta-bearing move takes the relative path; mouse-look depends on it.
    assert.include(calls, "MoveRelative:12,-7");
    // A move without deltas still warps absolutely, for ordinary desktop use.
    assert.include(calls, "Pointer");
    assert.include(calls, "CursorLocked");
    // W is 0x57; the held key is released by the reset on shutdown.
    assert.include(calls, "Key:87:True");
    assert.include(calls, "Key:87:False");

    // A UAC prompt: input is refused for a while, then given back. Nothing may
    // be injected meanwhile, the refusal must be reported rather than raised,
    // and whatever was held has to be released before normal input resumes —
    // otherwise the desktop comes back with a stuck key.
    const blockedHarness =
      `${source.slice(0, open)}Add-Type @'${recorder}'@${source.slice(close + 2)}`.replace(
        "$script:wasBlocked = $false\n\nfunction Resume-AfterBlock",
        "$script:wasBlocked = $false\n[SollaRemoteInput]::Blocked = 'secure-desktop'\n\nfunction Resume-AfterBlock",
      );
    const blockedScript = NodePath.join(directory, "blocked.ps1");
    NodeFS.writeFileSync(
      blockedScript,
      `${blockedHarness}\n[Console]::Error.WriteLine("CALLS " + ([SollaRemoteInput]::Calls -join " | "))\n`,
    );
    const blockedRun = NodeChildProcess.spawnSync("pwsh", ["-NoProfile", "-File", blockedScript], {
      input:
        [
          `{"id":1,"kind":"input","input":{"type":"key","action":"down","code":"KeyW","key":"w","repeat":false}}`,
          `{"id":2,"kind":"cursor"}`,
        ].join("\n") + "\n",
      encoding: "utf8",
      timeout: 120_000,
    });
    const blockedReplies = String(blockedRun.stdout);
    // Reported as a condition, not a failure: `ok` stays true so no caller
    // upstream mistakes it for a broken session and tears the stream down.
    assert.match(blockedReplies, /"blocked":\s*"secure-desktop"/u);
    assert.notMatch(blockedReplies, /"ok":\s*false/u);
    // The lock poll answers while blocked, which is how recovery is noticed.
    assert.match(blockedReplies, /"locked":\s*true/u);
    // Nothing reached the injector; posting to our own desktop would be lost.
    assert.notInclude(String(blockedRun.stderr), "Key:87:True");

    NodeFS.rmSync(directory, { recursive: true, force: true });
  }, 180_000);

  it("treats a blocked host desktop as a reported condition, not an error", () => {
    const source = remoteInputScriptSource("win32");
    // OpenInputDesktop being refused is the reliable signal that UAC, the lock
    // screen, or Ctrl+Alt+Del owns input: the secure desktop is unopenable by
    // design. SendInput cannot be used to detect it — it succeeds against our
    // own desktop while the user is looking at another one.
    assert.include(source, "OpenInputDesktop");
    assert.include(source, "GetUserObjectInformationW");
    assert.include(source, "BlockReason");
    assert.include(source, "secure-desktop");
    assert.include(source, "elevated-window");
    // Recovery must release anything held while input was gone.
    assert.include(source, "Resume-AfterBlock");
  });

  it("maps right-hand modifiers to their own virtual keys", () => {
    // Input is injected by scan code, and the scan code is derived from the
    // virtual key — so the ambiguous VK_SHIFT/CONTROL/MENU forms silently turn
    // every right-hand modifier into its left twin and break AltGr.
    const source = remoteInputScriptSource("win32");
    assert.include(source, "ShiftLeft=0xA0; ShiftRight=0xA1");
    assert.include(source, "ControlLeft=0xA2; ControlRight=0xA3; AltLeft=0xA4; AltRight=0xA5");
    assert.notInclude(source, "ShiftLeft=0x10; ShiftRight=0x10");
    // Right Control and right Alt are only told apart from their left twins by
    // the E0 prefix.
    assert.include(source, "case 0xA3:");
    assert.include(source, "case 0xA5:");
  });

  it("reports macOS secure event input instead of dropping keys silently", () => {
    const source = remoteInputScriptSource("darwin");
    assert.include(source, "IsSecureEventInputEnabled");
    assert.include(source, "secure-input");
    // Carbon is optional: a failed top-level import would take the helper down.
    assert.include(source, 'ObjC.import("Carbon")');
  });

  it("launches the Windows helper from a script file instead of an oversized command", () => {
    const command = remoteInputCommand("win32");
    assert.equal(command.command, "powershell.exe");
    assert.isTrue(command.args.includes("-File"));
    assert.isFalse(command.args.includes("-EncodedCommand"));
    assert.match(command.args.at(-1) ?? "", /solla-remote-input\.ps1$/u);
  });

  it("uses checked SendInput calls instead of silently acknowledged legacy Windows input", () => {
    const source = remoteInputScriptSource("win32");
    assert.include(source, "SendInput");
    assert.include(source, "Windows rejected remote ");
    assert.notInclude(source, "mouse_event");
    assert.notInclude(source, "keybd_event");
    assert.notInclude(source, "SetCursorPos");
  });

  it("carries a scan code on Windows keys so held WASD reaches DirectInput games", () => {
    // A virtual-key-only SendInput leaves scanCode empty. Win32 windows read
    // WM_KEYDOWN and cope; DirectInput and Raw Input read the scan code off the
    // packet and see a key that never physically went down, so holding W does
    // nothing in game. Regression guard for that exact shape.
    const source = remoteInputScriptSource("win32");
    assert.include(source, "KEYEVENTF_SCANCODE");
    assert.include(source, "MapVirtualKey");
    assert.include(source, "KEYEVENTF_EXTENDEDKEY");
    assert.notInclude(source, "scanCode = 0,");
  });

  it("suspends Windows pointer acceleration while the cursor is captive", () => {
    // Measured on a real Windows host with the stock settings (thresholds 6/10,
    // accel on): relative deltas of 1px and 2px were swallowed entirely, and a
    // 120px delta was delivered as 302px — a 2.5x amplification that made fine
    // aim impossible and every flick overshoot. With acceleration suspended the
    // same sweep measured exactly 1:1 at every magnitude.
    const source = remoteInputScriptSource("win32");
    assert.include(source, "SPI_SETMOUSE");
    assert.include(source, "SetRelativePointerMode");
    // Runtime-only: the trailing winIni argument is 0, so no SPIF_UPDATEINIFILE
    // is set and a hard kill cannot outlive the session or rewrite the user's
    // saved preference on disk.
    assert.include(source, "SystemParametersInfo(SPI_SETMOUSE, 0, savedMouseAcceleration, 0)");
    assert.include(source, "SystemParametersInfo(SPI_SETMOUSE, 0, new int[3] { 0, 0, 0 }, 0)");
    // The restore path must be reachable from the reset that runs at shutdown.
    assert.include(source, "RestorePointerMode");
    assert.include(source, "[SollaRemoteInput]::RestorePointerMode()");
  });

  it("can move the Windows pointer relatively for captured-cursor mouse-look", () => {
    // Absolute warps read as one enormous flick to a game sampling deltas,
    // which is the "fling" that makes shooters unusable over remote control.
    const source = remoteInputScriptSource("win32");
    assert.include(source, "MoveRelative");
    assert.include(source, "flags = MOUSEEVENTF_MOVE");
  });
});
