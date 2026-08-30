import type { PreviewRemoteEditableRegion, PreviewRemoteInputAction } from "@t3tools/contracts";

export function findRemoteEditableRegion(
  regions: ReadonlyArray<PreviewRemoteEditableRegion> | undefined,
  point: { readonly x: number; readonly y: number },
): PreviewRemoteEditableRegion | null {
  if (!regions) return null;
  // Later DOM entries tend to be painted above earlier ones. Prefer them when
  // controls overlap rather than opening a keyboard for the covered control.
  return (
    regions.findLast(
      (region) =>
        region.width > 0 &&
        region.height > 0 &&
        point.x >= region.x &&
        point.x <= region.x + region.width &&
        point.y >= region.y &&
        point.y <= region.y + region.height,
    ) ?? null
  );
}

export function focusRemoteKeyboardForPoint(input: {
  readonly keyboardTarget: Pick<HTMLInputElement, "blur" | "focus" | "inputMode"> | null;
  readonly regions: ReadonlyArray<PreviewRemoteEditableRegion> | undefined;
  readonly point: { readonly x: number; readonly y: number };
}): boolean {
  if (!input.keyboardTarget) return false;
  const region = findRemoteEditableRegion(input.regions, input.point);
  if (!region) {
    input.keyboardTarget.blur();
    return false;
  }
  input.keyboardTarget.inputMode = region.inputMode ?? "text";
  input.keyboardTarget.focus({ preventScroll: true });
  return true;
}

export function resetRemoteKeyboardTarget(
  target: Pick<HTMLInputElement, "blur" | "value"> | null,
): void {
  if (!target) return;
  target.value = "";
  target.blur();
}

export function remoteKeyboardActionForBeforeInput(input: {
  readonly inputType: string;
  readonly data: string | null;
}): PreviewRemoteInputAction | null {
  switch (input.inputType) {
    case "insertLineBreak":
    case "insertParagraph":
      return { kind: "press", key: "Enter" };
    case "deleteContentBackward":
      return { kind: "press", key: "Backspace" };
    case "deleteContentForward":
      return { kind: "press", key: "Delete" };
    default:
      return null;
  }
}

/**
 * Software keyboards do not consistently expose inserted text through
 * `beforeinput` (notably iOS Safari through a mirrored page). The subsequent
 * `input` event does carry the hidden input's resulting value, so text is read
 * there and the input is cleared after every committed edit.
 */
export function remoteKeyboardTextForInput(input: {
  readonly data: string | null;
  readonly value: string;
  readonly isComposing: boolean;
}): string | null {
  if (input.isComposing) return null;
  const text = input.value || input.data || "";
  return text === "" ? null : text.slice(0, 256);
}
