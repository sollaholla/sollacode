import { parseSettingsUpdatePrompt } from "@t3tools/shared/settingsPrompt";

interface SettingsMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
  readonly turnId?: string | null | undefined;
  readonly senderThreadId?: string | null | undefined;
}

interface SettingsReceipt {
  readonly id: string;
  readonly kind?: string | undefined;
  readonly createdAt: string;
  readonly turnId?: string | null | undefined;
}

/** Match applied settings to their original prompt, preserving unrelated provider transitions. */
export function resolveSettingsUpdates(
  messages: ReadonlyArray<SettingsMessage>,
  activities: ReadonlyArray<SettingsReceipt>,
) {
  const updates = new Map<string, { description: string; completed: boolean }>();
  const byTime = new Map<number, SettingsMessage[]>();
  const byTurn = new Map<string, SettingsMessage[]>();
  for (const message of messages) {
    if (message.role !== "user" || message.senderThreadId) continue;
    const parsed = parseSettingsUpdatePrompt(message.text);
    if (parsed === null) continue;
    updates.set(message.id, { ...parsed, completed: false });
    const time = Date.parse(message.createdAt);
    if (Number.isFinite(time)) byTime.set(time, [...(byTime.get(time) ?? []), message]);
    if (message.turnId) {
      byTurn.set(message.turnId, [...(byTurn.get(message.turnId) ?? []), message]);
    }
  }

  const matchedActivityIds = new Set<string>();
  for (const activity of activities) {
    if (
      activity.kind !== "thread.settings.applied" &&
      activity.kind !== "provider.handoff.completed"
    ) {
      continue;
    }
    // The reactor stamps these receipts with the originating command's time,
    // even when provider startup takes longer or the message was queued.
    const sameTime = byTime.get(Date.parse(activity.createdAt)) ?? [];
    const candidates =
      sameTime.length > 0 ? sameTime : activity.turnId ? (byTurn.get(activity.turnId) ?? []) : [];
    if (candidates.length !== 1) continue;
    const message = candidates[0]!;
    if (message.turnId && activity.turnId && message.turnId !== activity.turnId) continue;
    const update = updates.get(message.id)!;
    updates.set(message.id, { ...update, completed: true });
    matchedActivityIds.add(activity.id);
  }
  return { updates, matchedActivityIds };
}
