import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

export const THIN_PORTRAIT_MOBILE_MEDIA_QUERY =
  "(max-width: 639px) and (orientation: portrait) and (pointer: coarse)";

export function shouldOpenImageReferenceInFullScreen(input: {
  readonly isThinPortraitMobile: boolean;
  readonly filePath: string;
  readonly workspaceRelativePath: string | null;
  readonly hasThreadContext: boolean;
  readonly hasImageViewer: boolean;
}): boolean {
  return (
    input.isThinPortraitMobile &&
    isWorkspaceImagePreviewPath(input.filePath) &&
    input.workspaceRelativePath !== null &&
    input.hasThreadContext &&
    input.hasImageViewer
  );
}
