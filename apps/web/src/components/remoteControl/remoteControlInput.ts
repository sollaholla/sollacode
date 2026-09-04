import type { RemoteControlPlatform, RemoteControlPointerButton } from "@t3tools/contracts";

export type RemoteControlSurfaceInputKind =
  | "pointer-down"
  | "pointer-move"
  | "pointer-up"
  | "wheel"
  | "key";

/**
 * Global app shortcuts must yield while the remote surface owns keyboard
 * input. Those listeners are registered before the viewer opens, so relying
 * on `defaultPrevented` alone lets the app consume a chord before the later
 * remote-control listener can forward it.
 */
export function isRemoteControlInputCaptured(
  root: Pick<ParentNode, "querySelector"> = document,
): boolean {
  return root.querySelector('[data-remote-input-capture="active"]') !== null;
}

export function shouldForwardRemoteSurfaceInput(input: {
  readonly capabilityGranted: boolean;
  readonly inputCaptured: boolean;
  readonly kind: RemoteControlSurfaceInputKind;
  readonly hasActivePointerPress?: boolean;
  /**
   * The viewer is moving its own picture around. Panning and dragging on the
   * remote machine are the same gesture, so while the view is being adjusted
   * nothing may reach the host - not even a pointer-down, which otherwise
   * forwards unconditionally to let a click take focus.
   */
  readonly viewAdjusting?: boolean;
}): boolean {
  if (input.viewAdjusting === true) return false;
  if (!input.capabilityGranted) return false;
  if (input.kind === "pointer-down") return true;
  if (input.kind === "pointer-up" && input.hasActivePointerPress) return true;
  return input.inputCaptured;
}

export function requestPointerLockIfSupported(
  target: {
    readonly requestPointerLock?: (() => void | Promise<void>) | undefined;
  } | null,
): void {
  if (!target || typeof target.requestPointerLock !== "function") return;
  try {
    void Promise.resolve(target.requestPointerLock()).catch(() => undefined);
  } catch {
    // Pointer lock is optional. Touch browsers such as iPhone Safari omit it,
    // and desktop browsers may still refuse it without a qualifying gesture.
  }
}

export function shouldForwardEscapeOnPointerUnlock(input: {
  readonly wasLocked: boolean;
  readonly isLocked: boolean;
  readonly programmatic: boolean;
  readonly inputCaptured: boolean;
  readonly keyboardGranted: boolean;
  readonly documentVisible: boolean;
  readonly documentFocused: boolean;
}): boolean {
  return (
    input.wasLocked &&
    !input.isLocked &&
    !input.programmatic &&
    input.inputCaptured &&
    input.keyboardGranted &&
    input.documentVisible &&
    input.documentFocused
  );
}

export function controllerPlatform(userAgent: string): RemoteControlPlatform {
  const normalized = userAgent.toLowerCase();
  if (normalized.includes("mac") || normalized.includes("iphone") || normalized.includes("ipad")) {
    return "macos";
  }
  if (normalized.includes("win")) return "windows";
  if (normalized.includes("linux") || normalized.includes("android")) return "linux";
  return "unknown";
}

export function normalizeRemoteControlKeyCode(
  code: string,
  platform: RemoteControlPlatform,
): string {
  if (platform === "macos" && (code === "MetaLeft" || code === "MetaRight")) {
    return code === "MetaLeft" ? "PrimaryLeft" : "PrimaryRight";
  }
  if (platform !== "macos" && (code === "ControlLeft" || code === "ControlRight")) {
    return code === "ControlLeft" ? "PrimaryLeft" : "PrimaryRight";
  }
  return code;
}

/**
 * CSS cursor keywords the host shape channel is allowed to drive. The wire
 * value goes straight into a style attribute, so anything outside this list —
 * a newer host's shape, a corrupted value — degrades to the arrow.
 */
const REMOTE_CURSOR_KEYWORDS: ReadonlySet<string> = new Set([
  "default",
  "text",
  "pointer",
  "crosshair",
  "wait",
  "progress",
  "help",
  "move",
  "not-allowed",
  "none",
  "ew-resize",
  "ns-resize",
  "nesw-resize",
  "nwse-resize",
  "col-resize",
  "row-resize",
  "grab",
  "grabbing",
  "alias",
  "copy",
  "context-menu",
  "vertical-text",
]);

/**
 * The local cursor to show over the remote surface. Mirrors the host cursor
 * only while input is captured with pointer rights — an uncaptured surface is
 * not forwarding motion, so the host shape describes somebody else's pointer.
 */
export function remoteSurfaceCursorStyle(input: {
  readonly shape: string;
  readonly inputCaptured: boolean;
  readonly pointerGranted: boolean;
}): string {
  if (!input.pointerGranted || !input.inputCaptured) return "default";
  return REMOTE_CURSOR_KEYWORDS.has(input.shape) ? input.shape : "default";
}

export function remotePointerButton(button: number): RemoteControlPointerButton {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

/**
 * The rectangle the picture actually occupies inside an `object-contain`
 * media element. With the element stretched to fill its pane (so the stream
 * scales UP in fullscreen), the element rect includes the letterbox bars —
 * normalizing pointer coordinates against it would skew every click. This
 * reproduces object-contain's math to exclude the bars; unknown intrinsic
 * dimensions fall back to the element rect unchanged.
 */
export function objectContainContentRect(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  intrinsic: { readonly width: number; readonly height: number },
): Pick<DOMRect, "left" | "top" | "width" | "height"> {
  if (intrinsic.width <= 0 || intrinsic.height <= 0 || rect.width <= 0 || rect.height <= 0) {
    return rect;
  }
  const scale = Math.min(rect.width / intrinsic.width, rect.height / intrinsic.height);
  const width = intrinsic.width * scale;
  const height = intrinsic.height * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  };
}

export function normalizedRemotePoint(input: {
  readonly clientX: number;
  readonly clientY: number;
  readonly rect: Pick<DOMRect, "left" | "top" | "width" | "height">;
}): { readonly x: number; readonly y: number } {
  const { rect } = input;
  const x = rect.width > 0 ? (input.clientX - rect.left) / rect.width : 0;
  const y = rect.height > 0 ? (input.clientY - rect.top) / rect.height : 0;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  };
}
