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

  it("types a shifted character instead of posting its bare key code", () => {
    // A touch keyboard sends no Shift key of its own: "@" arrives as a single
    // event with key "@" and code Digit2. Posting that code produced "2", and
    // "!" produced "1", because the code table is the unshifted US layout.
    const source = remoteInputScriptSource("darwin");
    const lift = (name: string) => {
      const start = source.indexOf(`function ${name}(`);
      assert.isAtLeast(start, 0, `missing ${name}`);
      let depth = 0;
      for (let index = source.indexOf("{", start); index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") {
          depth -= 1;
          if (depth === 0) return source.slice(start, index + 1);
        }
      }
      throw new Error(`unbalanced ${name}`);
    };
    const table = /var unshiftedChars = \{[\s\S]*?\n\};/u.exec(source);
    const modifiers = /var MODIFIER_KINDS = \{[\s\S]*?\n\};/u.exec(source);
    assert.isNotNull(table);
    assert.isNotNull(modifiers);
    const harness = new Function(`
      var pressedKeys = {};
      ${modifiers?.[0]}
      ${table?.[0]}
      ${lift("hasNonShiftModifierHeld")}
      ${lift("needsLiteralText")}
      return { needsLiteralText: needsLiteralText, setHeld: function (h) { pressedKeys = h; } };
    `)() as {
      needsLiteralText: (input: { action: string; code: string; key: string }) => boolean;
      setHeld: (held: Record<string, number>) => void;
    };

    const check = (
      input: { action: string; code: string; key: string },
      held: Record<string, number>,
      expected: boolean,
      why: string,
    ) => {
      harness.setHeld(held);
      assert.strictEqual(harness.needsLiteralText(input), expected, why);
    };

    check({ action: "down", code: "Digit2", key: "@" }, {}, true, "@ must be typed, not posted");
    check({ action: "down", code: "Digit1", key: "!" }, {}, true, "! must be typed, not posted");
    check({ action: "down", code: "KeyW", key: "W" }, {}, true, "a capital needs the character");
    check({ action: "down", code: "Digit2", key: "2" }, {}, false, "a plain 2 is just the key");
    // A held key must stay on the key path: typing it as text fires once, so a
    // game holding W to walk would take a single step and stop.
    check({ action: "down", code: "KeyW", key: "w" }, {}, false, "held keys keep their down edge");
    check({ action: "up", code: "Digit2", key: "@" }, {}, false, "an up edge never types");
    // Shortcuts are not typing: Cmd+2 must remain Cmd+2.
    check(
      { action: "down", code: "Digit2", key: "@" },
      { MetaLeft: 55 },
      false,
      "cmd is a shortcut",
    );
    check(
      { action: "down", code: "Digit2", key: "@" },
      { ControlLeft: 59 },
      false,
      "ctrl is a shortcut",
    );
    check(
      { action: "down", code: "Digit2", key: "@" },
      { ShiftLeft: 56 },
      true,
      "shift alone still types",
    );
    check(
      { action: "down", code: "Enter", key: "Enter" },
      {},
      false,
      "named keys are not characters",
    );
  });

  it("types a shifted character on Windows instead of posting its bare key code", function () {
    if (!pwshAvailable) return;
    // Same defect as the macOS case above, and the same rule: SendInput's key
    // path takes a virtual key, which is the unshifted layout, so a touch
    // keyboard's "@" landed as "2". KEYEVENTF_UNICODE already existed for the
    // text channel; shifted characters are routed to it.
    const source = remoteInputScriptSource("win32");
    const open = source.indexOf("Add-Type @'");
    const close = source.indexOf("'@", open);
    assert.isAbove(close, open);

    const recorder = `
using System;
using System.Collections.Generic;
public static class SollaRemoteInput {
  public static List<string> Calls = new List<string>();
  public static void Pointer(double x, double y, uint flags, int data) { }
  public static void MoveRelative(int dx, int dy) { }
  public static void Mouse(uint flags, int data) { }
  public static void Key(ushort vk, bool down) { Calls.Add("Key:" + vk + ":" + down); }
  public static void Text(string value) { Calls.Add("Text:" + value); }
  public static bool CursorLocked() { return false; }
  public static string CursorShape() { return "default"; }
  public static void RestorePointerMode() { }
  public static string BlockReason() { return null; }
}
`;
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "solla-ps-keys-"));
    const script = NodePath.join(directory, "keys.ps1");
    NodeFS.writeFileSync(
      script,
      `${source.slice(0, open)}Add-Type @'${recorder}'@${source.slice(close + 2)}
[Console]::Error.WriteLine("CALLS " + ([SollaRemoteInput]::Calls -join " | "))
`,
    );

    const key = (code: string, character: string) =>
      `{"id":1,"kind":"input","input":{"type":"key","action":"down","code":"${code}","key":"${character}","repeat":false}}`;
    const feed = (lines: ReadonlyArray<string>) => {
      const run = NodeChildProcess.spawnSync("pwsh", ["-NoProfile", "-File", script], {
        input: `${lines.join("\n")}\n`,
        encoding: "utf8",
        timeout: 120_000,
      });
      return String(run.stderr);
    };

    // Shifted characters, sent alone so the key path can be asserted absent.
    const shifted = feed([key("Digit2", "@"), key("Digit1", "!"), key("KeyA", "A")]);
    assert.include(shifted, "Text:@", "@ must be typed");
    assert.include(shifted, "Text:!", "! must be typed");
    // PowerShell compares case-insensitively by default, so a capital would
    // otherwise look identical to its unshifted letter and take the key path.
    assert.include(shifted, "Text:A", "a capital needs the character");
    assert.notInclude(shifted, "Key:50:True", "Digit2 must not be posted for @");
    assert.notInclude(shifted, "Key:49:True", "Digit1 must not be posted for !");

    // Characters the bare key really does produce stay on the key path, so held
    // keys keep the down edge that games and key repeat depend on.
    const plain = feed([key("Digit2", "2"), key("KeyA", "a")]);
    assert.include(plain, "Key:50:True", "a plain 2 is just the key");
    assert.include(plain, "Key:65:True", "a lowercase a is just the key");
    assert.notInclude(plain, "Text:", "nothing unshifted may be typed as text");

    NodeFS.rmSync(directory, { recursive: true, force: true });
  }, 180_000);

  it("never inspects or reports secure event input on macOS", () => {
    // Removed at the owner's request. They control their own Mac from a phone,
    // where there is no keyboard to fall back to, so neither refusing to inject
    // nor warning about their own password field helped them - both only stood
    // between them and the prompt they were trying to answer.
    const source = remoteInputScriptSource("darwin");
    assert.notInclude(source, "IsSecureEventInputEnabled");
    assert.notInclude(source, "secure-input");
    assert.notInclude(source, "blockReason");
    // Carbon was imported only for that check.
    assert.notInclude(source, 'ObjC.import("Carbon")');
  });

  it("still refuses the Windows secure desktop, where keys would land elsewhere", () => {
    // Not the same thing as the macOS check: UAC, the lock screen and
    // Ctrl+Alt+Del own a desktop this process cannot open, so SendInput would
    // deliver the keystrokes to whatever window is focused on OUR desktop -
    // typing a password there in the clear.
    const source = remoteInputScriptSource("win32");
    assert.include(source, "blocked -eq 'secure-desktop'");
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

describe("macOS mouse-look", () => {
  it("carries motion in the event's delta fields, not just its position", () => {
    // A game that has captured the cursor reads NSEvent deltaX/deltaY, which
    // come from the CGEvent's delta fields. CGEventCreateMouseEvent leaves
    // them at zero, so the FPS look pad warped the hidden cursor around and
    // turned the camera by nothing at all.
    const source = remoteInputScriptSource("darwin");
    assert.include(source, "CGEventSetIntegerValueField(event, kMouseEventDeltaX");
    assert.include(source, "CGEventSetIntegerValueField(event, kMouseEventDeltaY");
    assert.include(source, 'typeof input.dx === "number" ? input.dx : point.x - previous.x');
  });
});

describe("macOS remote input script framework imports", () => {
  it("imports AppKit, because NSScreen is not in Foundation", () => {
    const source = remoteInputScriptSource("darwin");
    // Foundation and ApplicationServices do not define NSScreen. Without an
    // AppKit import `$.NSScreen` is undefined, so every pointer event died on
    // "undefined is not an object (evaluating '$.NSScreen.screens')" — and the
    // viewer reported it as the screen no longer being capturable even though
    // capture was fine (reported 2026-09-01).
    assert.include(source, 'ObjC.import("AppKit")');
    assert.include(source, "$.NSScreen.screens");
  });

  it("falls back to the main display when AppKit is unavailable", () => {
    const source = remoteInputScriptSource("darwin");
    // The import is guarded, so the pointer still has to land somewhere rather
    // than throwing on every event.
    assert.include(source, "CGDisplayBounds");
    assert.include(source, "CGMainDisplayID");
  });
});
