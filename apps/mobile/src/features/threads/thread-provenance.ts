import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type ThreadProvenance = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdByThreadId"
>;

/** Row accessibility text; `creatorLabel` comes from `useThreadCreatorLabel`. */
export function threadProvenanceAccessibilityLabel(
  thread: ThreadProvenance,
  creatorLabel: string | null,
): string | null {
  return thread.createdByThreadId == null ? null : creatorLabel;
}
