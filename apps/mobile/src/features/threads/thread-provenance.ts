import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type ThreadProvenance = Pick<
  EnvironmentThreadShell,
  "id" | "createdByThreadId" | "browserProfileThreadId"
>;

export function threadProvenanceAccessibilityLabel(thread: ThreadProvenance): string | null {
  const labels: string[] = [];
  if (thread.createdByThreadId != null) labels.push("Created by an agent");
  if (thread.browserProfileThreadId != null) labels.push("Uses a shared agent browser profile");
  return labels.length > 0 ? labels.join(", ") : null;
}
