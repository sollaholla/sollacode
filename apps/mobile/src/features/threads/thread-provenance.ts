import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type ThreadProvenance = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdByThreadId" | "browserProfileThreadId"
>;

/** Row accessibility text; `creatorLabel` comes from `useThreadCreatorLabel`. */
export function threadProvenanceAccessibilityLabel(
  thread: ThreadProvenance,
  creatorLabel: string | null,
): string | null {
  const labels: string[] = [];
  if (creatorLabel !== null) labels.push(creatorLabel);
  if (thread.browserProfileThreadId != null) labels.push("Uses a shared browser profile");
  return labels.length > 0 ? labels.join(", ") : null;
}
