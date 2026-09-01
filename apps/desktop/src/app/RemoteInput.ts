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
// Carbon is where IsSecureEventInputEnabled lives. It is not present on every
// runtime this script can land on, and a failed top-level import would take the
// whole helper down, so the capability is treated as optional.
var hasCarbon = false;
try {
  ObjC.import("Carbon");
  hasCarbon = true;
} catch (error) {
  hasCarbon = false;
}
// NSScreen is AppKit, not Foundation. Without this import $.NSScreen is
// undefined and every pointer event dies on "undefined is not an object",
// which the viewer then reports as a capture problem. Guarded like Carbon so a
// runtime without AppKit degrades instead of taking the helper down.
var hasAppKit = false;
try {
  ObjC.import("AppKit");
  hasAppKit = true;
} catch (error) {
  hasAppKit = false;
}

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

// Synthetic CGEvents do not inherit modifier state from earlier synthetic
// modifier key events the way physical keyboards do: every event carries its
// own flags word, and an empty one means "no modifiers held". Without stamping
// flags, Cmd+C arrives as a bare C and shift-click as a plain click.
var MODIFIER_KINDS = {
  ShiftLeft: "shift", ShiftRight: "shift",
  ControlLeft: "control", ControlRight: "control",
  AltLeft: "alt", AltRight: "alt",
  MetaLeft: "command", MetaRight: "command",
  PrimaryLeft: "command", PrimaryRight: "command"
};

function heldModifierFlags() {
  var flags = 0;
  Object.keys(pressedKeys).forEach(function (codeName) {
    var kind = MODIFIER_KINDS[codeName];
    if (kind === "shift") flags |= $.kCGEventFlagMaskShift;
    else if (kind === "control") flags |= $.kCGEventFlagMaskControl;
    else if (kind === "alt") flags |= $.kCGEventFlagMaskAlternate;
    else if (kind === "command") flags |= $.kCGEventFlagMaskCommand;
  });
  return flags;
}

function writeReply(value) {
  var text = JSON.stringify(value) + "\n";
  var data = $(text).dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

// The union of every display, or the main display alone when AppKit is
// missing. CGDisplayBounds is ApplicationServices, which is always imported,
// so the fallback still puts the pointer somewhere sane on one monitor.
function virtualDesktopBounds() {
  if (hasAppKit && $.NSScreen !== undefined && $.NSScreen.screens !== undefined) {
    return $.NSScreen.screens.js.reduce(function (acc, screen) {
      var frame = screen.frame;
      return {
        minX: Math.min(acc.minX, frame.origin.x),
        minY: Math.min(acc.minY, frame.origin.y),
        maxX: Math.max(acc.maxX, frame.origin.x + frame.size.width),
        maxY: Math.max(acc.maxY, frame.origin.y + frame.size.height)
      };
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  }
  var main = $.CGDisplayBounds($.CGMainDisplayID());
  return {
    minX: main.origin.x,
    minY: main.origin.y,
    maxX: main.origin.x + main.size.width,
    maxY: main.origin.y + main.size.height
  };
}

function displayPoint(input) {
  // Coordinates arrive normalized across the whole virtual desktop, and
  // CGEventPost addresses that same global space, so scale by the union of all
  // displays rather than the main one — otherwise secondary monitors are
  // unreachable.
  var bounds = virtualDesktopBounds();
  var width = Math.max(1, bounds.maxX - bounds.minX);
  var height = Math.max(1, bounds.maxY - bounds.minY);
  lastPoint = $.CGPointMake(
    Math.round(bounds.minX + Math.max(0, Math.min(1, input.x)) * (width - 1)),
    Math.round(bounds.minY + Math.max(0, Math.min(1, input.y)) * (height - 1))
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
  // Shift-click, Cmd-click, Ctrl-click: pointer events carry modifiers too.
  $.CGEventSetFlags(event, heldModifierFlags());
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
  $.CGEventSetFlags(event, heldModifierFlags());
  $.CGEventPost($.kCGHIDEventTap, event);
}

function postKey(input) {
  var code = keyCodes[input.code];
  if (code === undefined) return;
  var isDown = input.action === "down";
  // Update held state first so a modifier's own down edge carries its flag and
  // its up edge does not — matching what a physical keyboard produces.
  if (isDown) pressedKeys[input.code] = code;
  else delete pressedKeys[input.code];
  var event = $.CGEventCreateKeyboardEvent(null, code, isDown);
  $.CGEventSetFlags(event, heldModifierFlags());
  $.CGEventPost($.kCGHIDEventTap, event);
}

var systemEventsApp = null;

// Literal text from touch keyboards. System Events types with the active
// layout, which is exactly the behaviour a code table cannot give.
function postText(input) {
  if (systemEventsApp === null) {
    systemEventsApp = Application("System Events");
  }
  systemEventsApp.keystroke(input.text);
}

function resetInput() {
  Object.keys(pressedKeys).forEach(function(codeName) {
    var event = $.CGEventCreateKeyboardEvent(null, pressedKeys[codeName], false);
    $.CGEventSetFlags(event, 0);
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

/**
 * Whether some app has taken the cursor.
 *
 * A hidden cursor is the observable signal that an app switched to relative
 * mouse-look: games hide the pointer and read deltas. There is no public API
 * for "is the pointer captured", but CGCursorIsVisible tracks the hide/show
 * that always accompanies it.
 */
function cursorLocked() {
  try {
    return !$.CGCursorIsVisible();
  } catch (error) {
    return false;
  }
}

/**
 * The current global cursor as a CSS cursor keyword, best-effort.
 *
 * AppKit's named cursors are shared instances, so an identity comparison
 * against currentSystemCursor recognises the standard shapes. Apps that set a
 * custom cursor image (and macOS versions where currentSystemCursor answers
 * nil) report "default" — that is a graceful miss, not an error.
 */
function cursorShape() {
  try {
    if (cursorLocked()) return "none";
    var current = $.NSCursor.currentSystemCursor;
    if (!current || (current.isNil && current.isNil())) return "default";
    var named = [
      ["text", $.NSCursor.IBeamCursor],
      ["pointer", $.NSCursor.pointingHandCursor],
      ["crosshair", $.NSCursor.crosshairCursor],
      ["ew-resize", $.NSCursor.resizeLeftRightCursor],
      ["ns-resize", $.NSCursor.resizeUpDownCursor],
      ["grab", $.NSCursor.openHandCursor],
      ["grabbing", $.NSCursor.closedHandCursor],
      ["not-allowed", $.NSCursor.operationNotAllowedCursor],
      ["vertical-text", $.NSCursor.IBeamCursorForVerticalLayout],
      ["copy", $.NSCursor.dragCopyCursor],
      ["alias", $.NSCursor.dragLinkCursor],
      ["context-menu", $.NSCursor.contextualMenuCursor]
    ];
    for (var index = 0; index < named.length; index += 1) {
      var candidate = named[index][1];
      if (candidate && current.isEqual(candidate)) return named[index][0];
    }
    return "default";
  } catch (error) {
    return "default";
  }
}

/**
 * Why injected input would go nowhere right now, or null when it will land.
 *
 * macOS has no secure desktop, but it has the same idea in a narrower form:
 * a password field or an authorization prompt turns on secure event input,
 * and the window server then drops synthetic key events outright. Reporting it
 * is what keeps a session from looking dead while someone is being asked for
 * their password.
 */
function blockReason() {
  if (!hasCarbon) return null;
  try {
    return $.IsSecureEventInputEnabled() ? "secure-input" : null;
  } catch (error) {
    return null;
  }
}

var wasBlocked = false;

function applyCommand(command) {
  if (command.kind === "reset") {
    resetInput();
    wasBlocked = false;
    return null;
  }
  if (command.kind === "cursor") {
    // The lock poll doubles as the recovery detector, so it reports the block
    // state too — otherwise an idle session never learns that input came back.
    return { locked: cursorLocked(), blocked: blockReason(), cursor: cursorShape() };
  }
  var blocked = blockReason();
  if (blocked !== null) {
    wasBlocked = true;
    return { blocked: blocked };
  }
  if (wasBlocked) {
    // Keys held when secure input took over are still down, and their key-ups
    // were swallowed; release everything before resuming.
    resetInput();
    wasBlocked = false;
  }
  var input = command.input;
  if (input.type === "pointer") postPointer(input);
  else if (input.type === "wheel") postWheel(input);
  else if (input.type === "key") postKey(input);
  else if (input.type === "text") postText(input);
  return null;
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
        var result = applyCommand(command);
        var reply = { id: command.id, ok: true };
        if (result && typeof result.locked === "boolean") reply.locked = result.locked;
        if (result && typeof result.blocked === "string") reply.blocked = result.blocked;
        if (result && typeof result.cursor === "string") reply.cursor = result.cursor;
        writeReply(reply);
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
  private const uint INPUT_MOUSE = 0;
  private const uint INPUT_KEYBOARD = 1;
  private const uint MOUSEEVENTF_MOVE = 0x0001;
  private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  // Without VIRTUALDESK, absolute coordinates address the primary monitor only,
  // so input aimed at any secondary display lands on the primary one.
  private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
  private const uint KEYEVENTF_KEYUP = 0x0002;
  // Games are the reason these two exist here.
  //
  // A virtual-key SendInput is enough for Win32 windows, which read WM_KEYDOWN,
  // but DirectInput and Raw Input read the *scan code* off the keyboard packet.
  // Injecting with scanCode = 0 leaves that field empty, so a game sees a key
  // that never physically went down: taps sometimes register, holds never do —
  // exactly the reported "WASD doesn't work while held".
  private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  private const uint KEYEVENTF_SCANCODE = 0x0008;
  private const uint MAPVK_VK_TO_VSC = 0;

  [StructLayout(LayoutKind.Sequential)]
  private struct INPUT {
    public uint type;
    public InputUnion data;
  }

  [StructLayout(LayoutKind.Explicit)]
  private struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct KEYBDINPUT {
    public ushort virtualKey;
    public ushort scanCode;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

  [DllImport("user32.dll")]
  private static extern uint MapVirtualKey(uint code, uint mapType);

  [StructLayout(LayoutKind.Sequential)]
  private struct POINT { public int x; public int y; }

  [StructLayout(LayoutKind.Sequential)]
  private struct CURSORINFO {
    public int cbSize;
    public int flags;
    public IntPtr hCursor;
    public POINT screenPos;
  }

  [DllImport("user32.dll")]
  private static extern bool GetCursorInfo(ref CURSORINFO info);

  private const int CURSOR_SHOWING = 0x0001;

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool CloseDesktop(IntPtr desktop);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool GetUserObjectInformationW(
    IntPtr handle, int index, System.Text.StringBuilder info, uint byteCount, out uint bytesNeeded);

  private const int UOI_NAME = 2;
  private const uint DESKTOP_READOBJECTS = 0x0001;

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  private const uint PROCESS_QUERY_INFORMATION = 0x0400;
  private const int ERROR_ACCESS_DENIED = 5;

  /**
   * Name of the desktop currently receiving input, or null when we are not
   * even allowed to ask.
   *
   * Windows runs UAC consent, the lock screen, and Ctrl+Alt+Del on a separate
   * "secure desktop" that ordinary processes cannot open, enumerate, capture,
   * or type into. That isolation is the entire point of the feature, so being
   * refused here is not an error — it is the answer.
   */
  private static string InputDesktopName() {
    var desktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
    if (desktop == IntPtr.Zero) return null;
    try {
      var buffer = new System.Text.StringBuilder(256);
      uint needed;
      if (!GetUserObjectInformationW(desktop, UOI_NAME, buffer, (uint)(buffer.Capacity * 2), out needed)) {
        return null;
      }
      return buffer.ToString();
    } finally {
      CloseDesktop(desktop);
    }
  }

  private static bool hasCheckedElevation = false;
  private static int lastElevationCheckTick = 0;
  private static bool lastElevationResult = false;

  /**
   * Whether the foreground window belongs to a process we cannot touch.
   *
   * UIPI silently discards input sent from a lower integrity level to a higher
   * one — SendInput still reports success, so there is no failure to observe.
   * The proxy used here is that opening the owning process for query access is
   * refused, which is true of an elevated window and false of an ordinary one.
   * It is a heuristic (a protected-process window answers the same way), so it
   * only ever shapes the message shown to the user; it never decides whether a
   * session lives. Rate-limited because it runs on the input path.
   */
  private static bool ForegroundOutranksUs() {
    var now = Environment.TickCount;
    if (hasCheckedElevation && unchecked(now - lastElevationCheckTick) < 500) {
      return lastElevationResult;
    }
    hasCheckedElevation = true;
    lastElevationCheckTick = now;
    lastElevationResult = false;

    var window = GetForegroundWindow();
    if (window == IntPtr.Zero) return false;
    uint processId;
    GetWindowThreadProcessId(window, out processId);
    if (processId == 0) return false;
    var handle = OpenProcess(PROCESS_QUERY_INFORMATION, false, processId);
    if (handle != IntPtr.Zero) {
      CloseHandle(handle);
      return false;
    }
    lastElevationResult = Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED;
    return lastElevationResult;
  }

  /**
   * Why injected input would go nowhere right now, or null when it will land.
   *
   * Checked before every event rather than inferred from a failure, because
   * the secure-desktop case produces no failure at all: SendInput happily
   * succeeds against our own desktop while the user is looking at another one.
   * Without this the events vanish and the session looks broken for no
   * visible reason.
   */
  public static string BlockReason() {
    var desktop = InputDesktopName();
    if (desktop == null) return "secure-desktop";
    if (!string.Equals(desktop, "Default", StringComparison.OrdinalIgnoreCase)) {
      return "secure-desktop";
    }
    if (ForegroundOutranksUs()) return "elevated-window";
    return null;
  }

  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoA")]
  private static extern bool SystemParametersInfo(uint action, uint param, int[] data, uint winIni);

  private const uint SPI_GETMOUSE = 0x0003;
  private const uint SPI_SETMOUSE = 0x0004;
  private static int[] savedMouseAcceleration = null;

  /**
   * Suspend "Enhance pointer precision" while the pointer is captive.
   *
   * Windows applies its acceleration curve to injected relative motion, and the
   * curve is savage at both ends. Measured on this host with the default
   * settings (thresholds 6/10, accel on): a 1px delta is swallowed entirely, a
   * 2px delta is swallowed entirely, and a 120px delta is delivered as 302px —
   * a 2.5x amplification. Fine aim becomes impossible and every flick overshoots,
   * which is the "fling" that makes shooters unplayable. Disabled, the same
   * sweep is 1:1 at every magnitude.
   *
   * The winIni argument is deliberately 0: without SPIF_UPDATEINIFILE the change is
   * runtime-only, so even a hard kill of this helper cannot outlive the session
   * — the user's saved preference is untouched on disk and returns at next
   * logon.
   */
  private static void SetRelativePointerMode(bool relative) {
    if (relative) {
      if (savedMouseAcceleration != null) return;
      var current = new int[3];
      if (!SystemParametersInfo(SPI_GETMOUSE, 0, current, 0)) return;
      savedMouseAcceleration = current;
      SystemParametersInfo(SPI_SETMOUSE, 0, new int[3] { 0, 0, 0 }, 0);
      return;
    }
    if (savedMouseAcceleration == null) return;
    SystemParametersInfo(SPI_SETMOUSE, 0, savedMouseAcceleration, 0);
    savedMouseAcceleration = null;
  }

  /** Restore the user's pointer settings; safe to call when already restored. */
  public static void RestorePointerMode() {
    SetRelativePointerMode(false);
  }

  /**
   * Whether some app has taken the cursor.
   *
   * Windows exposes no "is the pointer captured" query, but a hidden cursor is
   * the signal that always accompanies it: a game entering mouse-look hides
   * the pointer and switches to reading raw deltas. CURSOR_SHOWING clearing is
   * that transition, and it is what the controller mirrors into pointer lock.
   */
  public static bool CursorLocked() {
    var info = new CURSORINFO();
    info.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref info)) return false;
    return (info.flags & CURSOR_SHOWING) == 0;
  }

  [DllImport("user32.dll")]
  private static extern IntPtr LoadCursor(IntPtr instance, int cursorName);

  private static System.Collections.Generic.Dictionary<IntPtr, string> knownCursors;

  private static void RegisterCursor(int id, string shape) {
    var handle = LoadCursor(IntPtr.Zero, id);
    if (handle != IntPtr.Zero && !knownCursors.ContainsKey(handle)) knownCursors[handle] = shape;
  }

  /**
   * The current global cursor as a CSS cursor keyword.
   *
   * The standard IDC_* cursors are shared system handles, so the handle that
   * GetCursorInfo reports can be compared against LoadCursor(NULL, IDC_*)
   * directly. Custom application cursors have private handles and report
   * "default" — matching their look is not possible from the outside.
   */
  public static string CursorShape() {
    if (knownCursors == null) {
      knownCursors = new System.Collections.Generic.Dictionary<IntPtr, string>();
      RegisterCursor(32512, "default");     // IDC_ARROW
      RegisterCursor(32513, "text");        // IDC_IBEAM
      RegisterCursor(32514, "wait");        // IDC_WAIT
      RegisterCursor(32515, "crosshair");   // IDC_CROSS
      RegisterCursor(32516, "default");     // IDC_UPARROW
      RegisterCursor(32642, "nwse-resize"); // IDC_SIZENWSE
      RegisterCursor(32643, "nesw-resize"); // IDC_SIZENESW
      RegisterCursor(32644, "ew-resize");   // IDC_SIZEWE
      RegisterCursor(32645, "ns-resize");   // IDC_SIZENS
      RegisterCursor(32646, "move");        // IDC_SIZEALL
      RegisterCursor(32648, "not-allowed"); // IDC_NO
      RegisterCursor(32649, "pointer");     // IDC_HAND
      RegisterCursor(32650, "progress");    // IDC_APPSTARTING
      RegisterCursor(32651, "help");        // IDC_HELP
    }
    var info = new CURSORINFO();
    info.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref info)) return "default";
    if ((info.flags & CURSOR_SHOWING) == 0) return "none";
    string shape;
    return knownCursors.TryGetValue(info.hCursor, out shape) ? shape : "default";
  }

  /**
   * Extended-scan-code keys. These share a scan code with a numpad key and are
   * only told apart by the E0 prefix, so omitting the flag turns Arrow keys
   * into numpad digits and right-hand modifiers into their left twins.
   */
  private static bool IsExtendedKey(ushort virtualKey) {
    switch (virtualKey) {
      case 0x21: // PageUp
      case 0x22: // PageDown
      case 0x23: // End
      case 0x24: // Home
      case 0x25: // ArrowLeft
      case 0x26: // ArrowUp
      case 0x27: // ArrowRight
      case 0x28: // ArrowDown
      case 0x2C: // PrintScreen
      case 0x2D: // Insert
      case 0x2E: // Delete
      case 0x5B: // MetaLeft
      case 0x5C: // MetaRight
      case 0x6F: // NumpadDivide
      case 0x90: // NumLock
      case 0xA3: // ControlRight
      case 0xA5: // AltRight — also AltGr, which layouts read as Ctrl+Alt
        return true;
      default:
        return false;
    }
  }

  private static void SendChecked(INPUT input, string description) {
    var sent = SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    if (sent == 1) return;
    var code = Marshal.GetLastWin32Error();
    // A refusal means something outranked us between the pre-flight check and
    // this call — a UAC prompt opening is the usual race. That is a condition
    // to wait out, not a fault, so it is raised as its own type and the driver
    // loop reports it as blocked rather than failing the session.
    if (code == ERROR_ACCESS_DENIED) {
      throw new UnauthorizedAccessException("Windows blocked remote " + description + ".");
    }
    var suffix = code == 0 ? "" : " Windows error " + code + ".";
    throw new InvalidOperationException(
      "Windows rejected remote " + description +
      ". Make sure Solla Code is running in the signed-in desktop session and at the same " +
      "privilege level as the app being controlled." + suffix);
  }

  public static void Pointer(double normalizedX, double normalizedY, uint flags, int data) {
    // An absolute move means the cursor is free again, so the user's own
    // acceleration preference must come back. No-op when already restored.
    SetRelativePointerMode(false);
    var input = new INPUT {
      type = INPUT_MOUSE,
      data = new InputUnion {
        mouse = new MOUSEINPUT {
          dx = (int)Math.Round(Math.Max(0, Math.Min(1, normalizedX)) * 65535),
          dy = (int)Math.Round(Math.Max(0, Math.Min(1, normalizedY)) * 65535),
          mouseData = unchecked((uint)data),
          flags = flags | MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
          time = 0,
          extraInfo = UIntPtr.Zero
        }
      }
    };
    SendChecked(input, "pointer input");
  }

  /**
   * Relative motion, used while the remote app holds the pointer captive.
   *
   * An absolute warp is the wrong primitive for a game in mouse-look: the game
   * reads the delta between successive cursor positions, so a warp across the
   * screen reads as one enormous flick and the view spins. Sending the delta
   * itself keeps the magnitude the controller intended, and omitting
   * MOUSEEVENTF_ABSOLUTE keeps Windows from re-anchoring the cursor.
   */
  public static void MoveRelative(int dx, int dy) {
    // Entering relative motion is the signal that the pointer is captive.
    SetRelativePointerMode(true);
    if (dx == 0 && dy == 0) return;
    var input = new INPUT {
      type = INPUT_MOUSE,
      data = new InputUnion {
        mouse = new MOUSEINPUT {
          dx = dx,
          dy = dy,
          mouseData = 0,
          flags = MOUSEEVENTF_MOVE,
          time = 0,
          extraInfo = UIntPtr.Zero
        }
      }
    };
    SendChecked(input, "relative pointer input");
  }

  public static void Mouse(uint flags, int data) {
    var input = new INPUT {
      type = INPUT_MOUSE,
      data = new InputUnion {
        mouse = new MOUSEINPUT {
          dx = 0,
          dy = 0,
          mouseData = unchecked((uint)data),
          flags = flags,
          time = 0,
          extraInfo = UIntPtr.Zero
        }
      }
    };
    SendChecked(input, "mouse input");
  }

  private const uint KEYEVENTF_UNICODE = 0x0004;

  /**
   * Literal text injection, one UTF-16 unit per down/up pair. KEYEVENTF_UNICODE
   * bypasses the virtual-key layer entirely, so it types correctly on every
   * keyboard layout — which is why touch keyboards send text instead of codes.
   */
  public static void Text(string text) {
    foreach (var unit in text) {
      var down = new INPUT {
        type = INPUT_KEYBOARD,
        data = new InputUnion {
          keyboard = new KEYBDINPUT {
            virtualKey = 0,
            scanCode = unit,
            flags = KEYEVENTF_UNICODE,
            time = 0,
            extraInfo = UIntPtr.Zero
          }
        }
      };
      var up = new INPUT {
        type = INPUT_KEYBOARD,
        data = new InputUnion {
          keyboard = new KEYBDINPUT {
            virtualKey = 0,
            scanCode = unit,
            flags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
            time = 0,
            extraInfo = UIntPtr.Zero
          }
        }
      };
      SendChecked(down, "text input");
      SendChecked(up, "text input");
    }
  }

  public static void Key(ushort virtualKey, bool down) {
    var scanCode = (ushort)MapVirtualKey(virtualKey, MAPVK_VK_TO_VSC);
    var flags = down ? 0u : KEYEVENTF_KEYUP;
    if (scanCode != 0) {
      // Carry the scan code so DirectInput/Raw Input games see a real key. The
      // virtual key stays populated: Windows still derives WM_KEYDOWN from it
      // for ordinary windows, so desktop apps are unaffected.
      flags |= KEYEVENTF_SCANCODE;
      if (IsExtendedKey(virtualKey)) flags |= KEYEVENTF_EXTENDEDKEY;
    }
    var input = new INPUT {
      type = INPUT_KEYBOARD,
      data = new InputUnion {
        keyboard = new KEYBDINPUT {
          virtualKey = virtualKey,
          scanCode = scanCode,
          flags = flags,
          time = 0,
          extraInfo = UIntPtr.Zero
        }
      }
    };
    SendChecked(input, "keyboard input");
  }
}
'@

$keyCodes = @{
  Backspace=0x08; Tab=0x09; Enter=0x0D;
  # Side-specific virtual keys, not the ambiguous VK_SHIFT/CONTROL/MENU. Input
  # is injected by scan code so DirectInput games see a real key, and the scan
  # code is derived from the virtual key — so the generic form silently turns
  # every right-hand modifier into its left twin, and AltGr stops working on
  # layouts that need it.
  ShiftLeft=0xA0; ShiftRight=0xA1;
  ControlLeft=0xA2; ControlRight=0xA3; AltLeft=0xA4; AltRight=0xA5;
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
  PrimaryLeft=0xA2; PrimaryRight=0xA3; Numpad0=0x60; Numpad1=0x61;
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
  [SollaRemoteInput]::Pointer([double]$eventData.x, [double]$eventData.y, 0, 0)
}

function Get-MouseFlag([string]$button, [string]$action) {
  if ($button -eq 'right') { return $(if ($action -eq 'down') { 0x0008 } else { 0x0010 }) }
  if ($button -eq 'middle') { return $(if ($action -eq 'down') { 0x0020 } else { 0x0040 }) }
  return $(if ($action -eq 'down') { 0x0002 } else { 0x0004 })
}

function Invoke-RemoteInput($eventData) {
  if ($eventData.type -eq 'pointer') {
    $flag = if ($eventData.action -eq 'move') {
      0
    } else {
      Get-MouseFlag $eventData.button $eventData.action
    }
    # Relative motion when the controller is in pointer lock. Button events
    # still ride the relative path so a click never warps the aim point: with
    # the cursor captive, x/y describe a position the game does not use.
    $hasDelta = ($null -ne $eventData.dx) -or ($null -ne $eventData.dy)
    if ($hasDelta) {
      $dx = 0
      $dy = 0
      if ($null -ne $eventData.dx) { $dx = [int][Math]::Round([double]$eventData.dx) }
      if ($null -ne $eventData.dy) { $dy = [int][Math]::Round([double]$eventData.dy) }
      [SollaRemoteInput]::MoveRelative($dx, $dy)
      if ($flag -ne 0) { [SollaRemoteInput]::Mouse([uint32]$flag, 0) }
      if ($eventData.action -ne 'move') {
        if ($eventData.action -eq 'down') { $pressedButtons[$eventData.button] = $true }
        else { $pressedButtons.Remove([string]$eventData.button) }
      }
      return
    }
    [SollaRemoteInput]::Pointer(
      [double]$eventData.x,
      [double]$eventData.y,
      [uint32]$flag,
      0
    )
    if ($eventData.action -ne 'move') {
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
    [SollaRemoteInput]::Key([uint16]$virtualKey, $down)
    if ($down) { $pressedKeys[[string]$eventData.code] = [uint16]$virtualKey }
    else { $pressedKeys.Remove([string]$eventData.code) }
    return
  }
  if ($eventData.type -eq 'text') {
    [SollaRemoteInput]::Text([string]$eventData.text)
  }
}

function Reset-RemoteInput {
  foreach ($virtualKey in @($pressedKeys.Values)) {
    [SollaRemoteInput]::Key([uint16]$virtualKey, $false)
  }
  foreach ($button in @($pressedButtons.Keys)) {
    [SollaRemoteInput]::Mouse((Get-MouseFlag ([string]$button) 'up'), 0)
  }
  $pressedKeys.Clear()
  $pressedButtons.Clear()
  [SollaRemoteInput]::RestorePointerMode()
}

# True while the host desktop is unreachable, so the first event that gets
# through again knows it has to clean up after the outage.
$script:wasBlocked = $false

function Resume-AfterBlock {
  if (-not $script:wasBlocked) { return }
  # Anything held when input was taken away is still physically down over
  # there, and the controller sent its key-ups into the void meanwhile. Release
  # everything before resuming so the desktop does not come back with a stuck
  # modifier.
  Reset-RemoteInput
  $script:wasBlocked = $false
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  $command = $null
  try {
    $command = $line | ConvertFrom-Json
    if ($command.kind -eq 'reset') {
      Reset-RemoteInput
      $script:wasBlocked = $false
      [Console]::Out.WriteLine((@{ id = $command.id; ok = $true } | ConvertTo-Json -Compress))
      continue
    }
    if ($command.kind -eq 'cursor') {
      # The lock poll doubles as the recovery detector: it keeps running while
      # the desktop is unreachable, so the session learns that input came back
      # even if nobody is typing.
      $blocked = [SollaRemoteInput]::BlockReason()
      $locked = [SollaRemoteInput]::CursorLocked()
      $reply = @{ id = $command.id; ok = $true; locked = $locked }
      $reply.cursor = [SollaRemoteInput]::CursorShape()
      if ($null -ne $blocked) { $reply.blocked = $blocked }
      [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress))
      continue
    }

    $blocked = [SollaRemoteInput]::BlockReason()
    if ($null -ne $blocked) {
      # Injecting now would post the event to our own desktop, which nobody is
      # looking at. Drop it and report the condition; this is not a failure.
      $script:wasBlocked = $true
      [Console]::Out.WriteLine((@{ id = $command.id; ok = $true; blocked = $blocked } | ConvertTo-Json -Compress))
      continue
    }
    Resume-AfterBlock
    Invoke-RemoteInput $command.input
    [Console]::Out.WriteLine((@{ id = $command.id; ok = $true } | ConvertTo-Json -Compress))
  } catch [System.UnauthorizedAccessException] {
    $script:wasBlocked = $true
    $id = if ($null -ne $command) { $command.id } else { -1 }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; blocked = 'elevated-window' } | ConvertTo-Json -Compress))
  } catch {
    $id = if ($null -ne $command) { $command.id } else { -1 }
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
Reset-RemoteInput
`;

/**
 * A host condition that suspends input without breaking anything.
 *
 * Mirrors `RemoteControlHostStatusReason` in the contracts package. Kept as a
 * plain union here because the helper protocol is process-local and must stay
 * readable from the platform scripts that produce these strings.
 */
export type RemoteInputBlockReason = "secure-desktop" | "elevated-window" | "secure-input";

const REMOTE_INPUT_BLOCK_REASONS: ReadonlySet<string> = new Set<RemoteInputBlockReason>([
  "secure-desktop",
  "elevated-window",
  "secure-input",
]);

function asBlockReason(value: unknown): RemoteInputBlockReason | undefined {
  return typeof value === "string" && REMOTE_INPUT_BLOCK_REASONS.has(value)
    ? (value as RemoteInputBlockReason)
    : undefined;
}

export interface RemoteInputSendResult {
  /** False when the OS is currently refusing input; the event was dropped. */
  readonly delivered: boolean;
  readonly blocked?: RemoteInputBlockReason;
}

export interface RemoteInputHostState {
  readonly locked: boolean;
  readonly blocked?: RemoteInputBlockReason;
  /** Host cursor as a CSS cursor keyword ("default", "text", "none", …). */
  readonly cursor?: string;
}

interface RemoteInputReply {
  readonly id: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly locked?: boolean;
  readonly blocked?: string;
  readonly cursor?: string;
}

/** Helper output crosses a process boundary; accept only cursor keywords. */
const CURSOR_SHAPE_PATTERN = /^[a-z][a-z-]{0,31}$/;

function asCursorShape(value: unknown): string | undefined {
  return typeof value === "string" && CURSOR_SHAPE_PATTERN.test(value) ? value : undefined;
}

interface PendingCommand {
  readonly resolve: (reply: RemoteInputReply) => void;
  readonly reject: (cause: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

let remoteInputHelperDirectory: string | null = null;

export function remoteInputScriptSource(platform: "darwin" | "win32"): string {
  return platform === "darwin" ? MACOS_REMOTE_INPUT_SOURCE : WINDOWS_REMOTE_INPUT_SOURCE;
}

function remoteInputScriptPath(platform: "darwin" | "win32"): string {
  remoteInputHelperDirectory ??= NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "solla-remote-input-"),
  );
  const path = NodePath.join(
    remoteInputHelperDirectory,
    platform === "darwin" ? "solla-remote-input.js" : "solla-remote-input.ps1",
  );
  NodeFS.writeFileSync(path, remoteInputScriptSource(platform), {
    encoding: "utf8",
    mode: 0o600,
  });
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

  /**
   * Injects one event, reporting rather than throwing when the OS is refusing
   * input.
   *
   * A UAC prompt, the lock screen, or an elevated foreground window all make
   * injection impossible for as long as they are up, and all of them clear on
   * their own. Surfacing that as a value keeps callers from mistaking a normal,
   * self-healing condition for a broken session.
   */
  async send(input: DesktopRemoteControlInput["input"]): Promise<RemoteInputSendResult> {
    const reply = await this.sendCommand({ kind: "input", input });
    const blocked = asBlockReason(reply.blocked);
    return blocked ? { delivered: false, blocked } : { delivered: true };
  }

  async probe(): Promise<void> {
    await this.sendCommand({ kind: "reset" });
  }

  async reset(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return;
    await this.sendCommand({ kind: "reset" });
  }

  /**
   * Whether the host's cursor is currently captured by some app.
   *
   * Rides the already-running helper rather than spawning anything: the
   * controller polls this while a session is live, and a per-poll process
   * launch would cost more than the frame it is attached to.
   */
  async readPointerLock(): Promise<boolean> {
    return (await this.readHostState()).locked;
  }

  /**
   * Cursor capture and input availability in one round trip.
   *
   * The poll that already runs for pointer lock is also the only thing still
   * talking to the host while input is blocked, so it carries the recovery
   * signal — an idle session would otherwise never notice the UAC prompt being
   * dismissed.
   */
  async readHostState(): Promise<RemoteInputHostState> {
    const reply = await this.sendCommand({ kind: "cursor" });
    const blocked = asBlockReason(reply.blocked);
    const cursor = asCursorShape(reply.cursor);
    return {
      locked: reply.locked === true,
      ...(blocked ? { blocked } : {}),
      ...(cursor ? { cursor } : {}),
    };
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
      if (reply.ok) pending.resolve(reply);
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
      | { readonly kind: "input"; readonly input: DesktopRemoteControlInput["input"] }
      | { readonly kind: "reset" }
      | { readonly kind: "cursor" },
  ): Promise<RemoteInputReply> {
    const child = this.ensureChild();
    const id = this.nextCommandId++;
    return new Promise<RemoteInputReply>((resolve, reject) => {
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
