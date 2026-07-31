import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

export const THIN_PORTRAIT_MOBILE_MEDIA_QUERY =
  "(max-width: 639px) and (orientation: portrait) and (pointer: coarse)";

export type ImageReferenceEnvironmentKind = "primary" | "desktop-local" | "remote" | "unknown";

export function resolveImageReferenceAssetPath(input: {
  readonly filePath: string;
  readonly workspaceRelativePath: string | null;
  readonly isRemoteThread: boolean;
  readonly hasSourceMessage: boolean;
}): string | null {
  if (input.workspaceRelativePath !== null) {
    return input.workspaceRelativePath;
  }
  return input.isRemoteThread && input.hasSourceMessage ? input.filePath : null;
}

export function isRemoteImageReferenceContext(input: {
  readonly hasThreadContext: boolean;
  readonly isDesktopRuntime: boolean;
  readonly environmentKind: ImageReferenceEnvironmentKind;
  readonly differsFromPrimaryEnvironment: boolean;
}): boolean {
  if (!input.hasThreadContext) return false;
  if (!input.isDesktopRuntime) return true;
  if (input.environmentKind === "remote") return true;
  return input.differsFromPrimaryEnvironment && input.environmentKind !== "desktop-local";
}

export function shouldOpenImageReferenceInFullScreen(input: {
  readonly isThinPortraitMobile: boolean;
  readonly isRemoteThread: boolean;
  readonly filePath: string;
  readonly assetPath: string | null;
  readonly hasThreadContext: boolean;
  readonly hasImageViewer: boolean;
}): boolean {
  return (
    (input.isThinPortraitMobile || input.isRemoteThread) &&
    isWorkspaceImagePreviewPath(input.filePath) &&
    input.assetPath !== null &&
    input.hasThreadContext &&
    input.hasImageViewer
  );
}
