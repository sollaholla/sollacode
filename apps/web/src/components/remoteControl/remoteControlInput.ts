import type { RemoteControlPlatform, RemoteControlPointerButton } from "@t3tools/contracts";

export type RemoteControlSurfaceInputKind =
  | "pointer-down"
  | "pointer-move"
  | "pointer-up"
  | "wheel"
  | "key";

export function shouldForwardRemoteSurfaceInput(input: {
  readonly capabilityGranted: boolean;
  readonly inputCaptured: boolean;
  readonly kind: RemoteControlSurfaceInputKind;
  readonly hasActivePointerPress?: boolean;
}): boolean {
  if (!input.capabilityGranted) return false;
  if (input.kind === "pointer-down") return true;
  if (input.kind === "pointer-up" && input.hasActivePointerPress) return true;
  return input.inputCaptured;
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

export function remotePointerButton(button: number): RemoteControlPointerButton {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
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
