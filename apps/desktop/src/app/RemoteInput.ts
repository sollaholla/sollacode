// @effect-diagnostics nodeBuiltinImport:off - A long-lived native input helper needs bidirectional stdio, private helper scripts, and per-command acknowledgements.
// @effect-diagnostics globalTimers:off - Each native input acknowledgement has a short transport timeout.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { DesktopRemoteControlInput } from "@t3tools/contracts";

const MACOS_REMOTE_INPUT_SOURCE = String.raw`
ObjC.import("ApplicationServices");
ObjC.import("Foundation");

var keyCodes = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7,
  KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15,
  KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21,
  Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27,
  Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32, BracketLeft: 33,
  KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39, KeyK: 40,
  Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46,
  Period: 47, Tab: 48, Space: 49, Backquote: 50, Backspace: 51, Escape: 53,
  PrimaryRight: 54, PrimaryLeft: 55, ShiftLeft: 56, AltLeft: 58, ControlLeft: 59,
  ShiftRight: 60, AltRight: 61, ControlRight: 62, MetaRight: 54, MetaLeft: 55,
  F17: 64, NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumLock: 71,
  NumpadDivide: 75, NumpadEnter: 76, NumpadSubtract: 78, F18: 79, F19: 80,
  NumpadEqual: 81, Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85,
  Numpad4: 86, Numpad5: 87, Numpad6: 88, Numpad7: 89, F20: 90,
  Numpad8: 91, Numpad9: 92, F5: 96, F6: 97, F7: 98, F3: 99, F8: 100,
  F9: 101, F11: 103, F13: 105, F16: 106, F14: 107, F10: 109, F12: 111,
  F15: 113, Insert: 114, Home: 115, PageUp: 116, Delete: 117, F4: 118,
  End: 119, F2: 120, PageDown: 121, F1: 122, ArrowLeft: 123, ArrowRight: 124,
  ArrowDown: 125, ArrowUp: 126
};

var pressedKeys = {};
var pressedButtons = {};
var lastPoint = $.CGPointMake(0, 0);

function writeReply(value) {
  var text = JSON.stringify(value) + "\n";
  var data = $(text).dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

function displayPoint(input) {
  var display = $.CGMainDisplayID();
  var width = Number($.CGDisplayPixelsWide(display));
  var height = Number($.CGDisplayPixelsHigh(display));
  lastPoint = $.CGPointMake(
    Math.round(Math.max(0, Math.min(1, input.x)) * Math.max(0, width - 1)),
    Math.round(Math.max(0, Math.min(1, input.y)) * Math.max(0, height - 1))
  );
  return lastPoint;
}

function mouseButton(name) {
  if (name === "right") return $.kCGMouseButtonRight;
  if (name === "middle") return $.kCGMouseButtonCenter;
  return $.kCGMouseButtonLeft;
}

function mouseEventType(action, name) {
  if (action === "move") {
    if (pressedButtons.left) return $.kCGEventLeftMouseDragged;
    if (pressedButtons.right) return $.kCGEventRightMouseDragged;
    return $.kCGEventMouseMoved;
  }
  if (name === "right") {
    return action === "down" ? $.kCGEventRightMouseDown : $.kCGEventRightMouseUp;
  }
  if (name === "middle") {
    return action === "down" ? $.kCGEventOtherMouseDown : $.kCGEventOtherMouseUp;
  }
  return action === "down" ? $.kCGEventLeftMouseDown : $.kCGEventLeftMouseUp;
}

function postPointer(input) {
  var point = displayPoint(input);
  var button = mouseButton(input.button);
  var event = $.CGEventCreateMouseEvent(null, mouseEventType(input.action, input.button), point, button);
  $.CGEventPost($.kCGHIDEventTap, event);
  if (input.action === "down") pressedButtons[input.button] = true;
  if (input.action === "up") delete pressedButtons[input.button];
}

function postWheel(input) {
  displayPoint(input);
  var vertical = Math.round(Math.max(-2000, Math.min(2000, -input.deltaY)));
  var horizontal = Math.round(Math.max(-2000, Math.min(2000, -input.deltaX)));
  var event = $.CGEventCreateScrollWheelEvent(
    null,
    $.kCGScrollEventUnitPixel,
    2,
    vertical,
    horizontal
  );
  $.CGEventPost($.kCGHIDEventTap, event);
}

function postKey(input) {
  var code = keyCodes[input.code];
  if (code === undefined) return;
  var isDown = input.action === "down";
  var event = $.CGEventCreateKeyboardEvent(null, code, isDown);
  $.CGEventPost($.kCGHIDEventTap, event);
  if (isDown) pressedKeys[input.code] = code;
  else delete pressedKeys[input.code];
}

function resetInput() {
  Object.keys(pressedKeys).forEach(function(codeName) {
    var event = $.CGEventCreateKeyboardEvent(null, pressedKeys[codeName], false);
    $.CGEventPost($.kCGHIDEventTap, event);
  });
  Object.keys(pressedButtons).forEach(function(buttonName) {
    var event = $.CGEventCreateMouseEvent(
      null,
      mouseEventType("up", buttonName),
      lastPoint,
      mouseButton(buttonName)
    );
    $.CGEventPost($.kCGHIDEventTap, event);
  });
  pressedKeys = {};
  pressedButtons = {};
}

function applyCommand(command) {
  if (command.kind === "reset") {
    resetInput();
    return;
  }
  var input = command.input;
  if (input.type === "pointer") postPointer(input);
  else if (input.type === "wheel") postWheel(input);
  else if (input.type === "key") postKey(input);
}

var handle = $.NSFileHandle.fileHandleWithStandardInput;
var pending = "";
while (true) {
  var data = handle.availableData;
  if (Number(data.length) === 0) break;
  pending += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  var newline = pending.indexOf("\n");
  while (newline >= 0) {
    var line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (line.length > 0) {
      var command = null;
      try {
        command = JSON.parse(line);
        applyCommand(command);
        writeReply({ id: command.id, ok: true });
      } catch (error) {
        writeReply({
          id: command && command.id ? command.id : -1,
          ok: false,
          error: String(error)
        });
      }
    }
    newline = pending.indexOf("\n");
  }
}
resetInput();
`;

const WINDOWS_REMOTE_INPUT_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class SollaRemoteInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern void mouse_event(
    uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(
    byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

  public static void Mouse(uint flags, int data) {
    mouse_event(flags, 0, 0, data, UIntPtr.Zero);
  }

  public static void Key(byte virtualKey, bool down) {
    keybd_event(virtualKey, 0, down ? 0u : 2u, UIntPtr.Zero);
  }
}
'@

$keyCodes = @{
  Backspace=0x08; Tab=0x09; Enter=0x0D; ShiftLeft=0x10; ShiftRight=0x10;
  ControlLeft=0x11; ControlRight=0x11; AltLeft=0x12; AltRight=0x12;
  Pause=0x13; CapsLock=0x14; Escape=0x1B; Space=0x20; PageUp=0x21;
  PageDown=0x22; End=0x23; Home=0x24; ArrowLeft=0x25; ArrowUp=0x26;
  ArrowRight=0x27; ArrowDown=0x28; PrintScreen=0x2C; Insert=0x2D;
  Delete=0x2E; Digit0=0x30; Digit1=0x31; Digit2=0x32; Digit3=0x33;
  Digit4=0x34; Digit5=0x35; Digit6=0x36; Digit7=0x37; Digit8=0x38;
  Digit9=0x39; KeyA=0x41; KeyB=0x42; KeyC=0x43; KeyD=0x44; KeyE=0x45;
  KeyF=0x46; KeyG=0x47; KeyH=0x48; KeyI=0x49; KeyJ=0x4A; KeyK=0x4B;
  KeyL=0x4C; KeyM=0x4D; KeyN=0x4E; KeyO=0x4F; KeyP=0x50; KeyQ=0x51;
  KeyR=0x52; KeyS=0x53; KeyT=0x54; KeyU=0x55; KeyV=0x56; KeyW=0x57;
  KeyX=0x58; KeyY=0x59; KeyZ=0x5A; MetaLeft=0x5B; MetaRight=0x5C;
  PrimaryLeft=0x11; PrimaryRight=0x11; Numpad0=0x60; Numpad1=0x61;
  Numpad2=0x62; Numpad3=0x63; Numpad4=0x64; Numpad5=0x65;
  Numpad6=0x66; Numpad7=0x67; Numpad8=0x68; Numpad9=0x69;
  NumpadMultiply=0x6A; NumpadAdd=0x6B; NumpadSubtract=0x6D;
  NumpadDecimal=0x6E; NumpadDivide=0x6F; F1=0x70; F2=0x71; F3=0x72;
  F4=0x73; F5=0x74; F6=0x75; F7=0x76; F8=0x77; F9=0x78; F10=0x79;
  F11=0x7A; F12=0x7B; NumLock=0x90; ScrollLock=0x91; Semicolon=0xBA;
  Equal=0xBB; Comma=0xBC; Minus=0xBD; Period=0xBE; Slash=0xBF;
  Backquote=0xC0; BracketLeft=0xDB; Backslash=0xDC; BracketRight=0xDD;
  Quote=0xDE
}

$pressedKeys = @{}
$pressedButtons = @{}

function Set-PointerPosition($eventData) {
  $width = [SollaRemoteInput]::GetSystemMetrics(0)
  $height = [SollaRemoteInput]::GetSystemMetrics(1)
  $x = [Math]::Round([Math]::Max(0, [Math]::Min(1, [double]$eventData.x)) * [Math]::Max(0, $width - 1))
  $y = [Math]::Round([Math]::Max(0, [Math]::Min(1, [double]$eventData.y)) * [Math]::Max(0, $height - 1))
  [void][SollaRemoteInput]::SetCursorPos($x, $y)
}

function Get-MouseFlag([string]$button, [string]$action) {
  if ($button -eq 'right') { return $(if ($action -eq 'down') { 0x0008 } else { 0x0010 }) }
  if ($button -eq 'middle') { return $(if ($action -eq 'down') { 0x0020 } else { 0x0040 }) }
  return $(if ($action -eq 'down') { 0x0002 } else { 0x0004 })
}

function Invoke-RemoteInput($eventData) {
  if ($eventData.type -eq 'pointer') {
    Set-PointerPosition $eventData
    if ($eventData.action -ne 'move') {
      [SollaRemoteInput]::Mouse((Get-MouseFlag $eventData.button $eventData.action), 0)
      if ($eventData.action -eq 'down') { $pressedButtons[$eventData.button] = $true }
      else { $pressedButtons.Remove([string]$eventData.button) }
    }
    return
  }
  if ($eventData.type -eq 'wheel') {
    Set-PointerPosition $eventData
    $vertical = [Math]::Round([Math]::Max(-2000, [Math]::Min(2000, -[double]$eventData.deltaY)))
    $horizontal = [Math]::Round([Math]::Max(-2000, [Math]::Min(2000, -[double]$eventData.deltaX)))
    if ($vertical -ne 0) { [SollaRemoteInput]::Mouse(0x0800, $vertical) }
    if ($horizontal -ne 0) { [SollaRemoteInput]::Mouse(0x1000, $horizontal) }
    return
  }
  if ($eventData.type -eq 'key') {
    $virtualKey = $keyCodes[[string]$eventData.code]
    if ($null -eq $virtualKey) { return }
    $down = $eventData.action -eq 'down'
    [SollaRemoteInput]::Key([byte]$virtualKey, $down)
    if ($down) { $pressedKeys[[string]$eventData.code] = [byte]$virtualKey }
    else { $pressedKeys.Remove([string]$eventData.code) }
  }
}

function Reset-RemoteInput {
  foreach ($virtualKey in @($pressedKeys.Values)) {
    [SollaRemoteInput]::Key([byte]$virtualKey, $false)
  }
  foreach ($button in @($pressedButtons.Keys)) {
    [SollaRemoteInput]::Mouse((Get-MouseFlag ([string]$button) 'up'), 0)
  }
  $pressedKeys.Clear()
  $pressedButtons.Clear()
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  $command = $null
  try {
    $command = $line | ConvertFrom-Json
    if ($command.kind -eq 'reset') { Reset-RemoteInput }
    else { Invoke-RemoteInput $command.input }
    [Console]::Out.WriteLine((@{ id = $command.id; ok = $true } | ConvertTo-Json -Compress))
  } catch {
    $id = if ($null -ne $command) { $command.id } else { -1 }
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
Reset-RemoteInput
`;

interface RemoteInputReply {
  readonly id: number;
  readonly ok: boolean;
  readonly error?: string;
}

interface PendingCommand {
  readonly resolve: () => void;
  readonly reject: (cause: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

let remoteInputHelperDirectory: string | null = null;

function remoteInputScriptPath(platform: "darwin" | "win32"): string {
  remoteInputHelperDirectory ??= NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "solla-remote-input-"),
  );
  const path = NodePath.join(
    remoteInputHelperDirectory,
    platform === "darwin" ? "solla-remote-input.js" : "solla-remote-input.ps1",
  );
  NodeFS.writeFileSync(
    path,
    platform === "darwin" ? MACOS_REMOTE_INPUT_SOURCE : WINDOWS_REMOTE_INPUT_SOURCE,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return path;
}

export function remoteInputCommand(platform: NodeJS.Platform): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  if (platform === "darwin") {
    return {
      command: "/usr/bin/osascript",
      args: ["-l", "JavaScript", remoteInputScriptPath("darwin")],
    };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        remoteInputScriptPath("win32"),
      ],
    };
  }
  throw new Error("Interactive remote control is currently supported on macOS and Windows hosts.");
}

export class RemoteInputController {
  private child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  private nextCommandId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private stderrTail = "";
  private readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform) {
    this.platform = platform;
  }

  send(input: DesktopRemoteControlInput): Promise<void> {
    return this.sendCommand({ kind: "input", input });
  }

  probe(): Promise<void> {
    return this.sendCommand({ kind: "reset" });
  }

  reset(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return Promise.resolve();
    return this.sendCommand({ kind: "reset" });
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await this.reset().catch(() => undefined);
    child.stdin.end();
    child.kill();
    if (this.child === child) this.child = null;
  }

  private ensureChild(): NodeChildProcess.ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null) return this.child;
    const command = remoteInputCommand(this.platform);
    const child = NodeChildProcess.spawn(command.command, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.stderrTail = "";

    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let reply: RemoteInputReply;
      try {
        reply = JSON.parse(line) as RemoteInputReply;
      } catch {
        return;
      }
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve();
      else pending.reject(new Error(reply.error?.trim() || "The host rejected remote input."));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-2_000);
    });
    const rejectPending = () => {
      if (this.child === child) this.child = null;
      const detail = this.stderrTail.trim();
      const error = new Error(
        detail
          ? `The remote-input helper stopped: ${detail}`
          : "The remote-input helper stopped unexpectedly.",
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    };
    child.once("error", rejectPending);
    child.once("exit", rejectPending);
    return child;
  }

  private sendCommand(
    command:
      | { readonly kind: "input"; readonly input: DesktopRemoteControlInput }
      | { readonly kind: "reset" },
  ): Promise<void> {
    const child = this.ensureChild();
    const id = this.nextCommandId++;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The host did not acknowledge remote input in time."));
      }, 3_000);
      this.pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (cause) => {
        if (!cause) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(cause);
      });
    });
  }
}

const remoteInputControllers = new Map<NodeJS.Platform, RemoteInputController>();

export function remoteInputControllerForPlatform(platform: NodeJS.Platform): RemoteInputController {
  const existing = remoteInputControllers.get(platform);
  if (existing) return existing;
  const controller = new RemoteInputController(platform);
  remoteInputControllers.set(platform, controller);
  return controller;
}
