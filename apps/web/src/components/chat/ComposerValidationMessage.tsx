/** Visible alongside the editor whenever sending requires a correction. */
export function ComposerValidationMessage({
  id,
  reason,
  promptTooLong,
}: {
  id: string;
  reason: string | null;
  promptTooLong: boolean;
}) {
  if (!reason) return null;
  return (
    <p id={id} role="status" className="mb-2 px-1 text-xs leading-relaxed text-muted-foreground">
      {reason}
      {promptTooLong ? ". Shorten your message or split it into smaller messages." : null}
    </p>
  );
}
