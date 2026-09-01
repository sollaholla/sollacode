/**
 * Caps for text inside a tool activity's `rawOutput`, shared by the write
 * path (decider), the snapshot read path, and the stored-payload compactor.
 *
 * `rawOutput` is the raw provider tool result. No client renders it — the web
 * timeline derives one 84-character line from it and mobile/client-runtime
 * never read the field — yet it dominated storage: measured 2026-08-30 on the
 * live 13 GB database, 8.3k tool rows over 64 KB accounted for ~3 GB of
 * projection_thread_activities, and the same payloads are stored a second
 * time inside `thread.activity-appended` events (4.5 GB). Every stored copy
 * survives forever, which is what grew the database 2 GB → 13 GB in a week.
 *
 * The walk is recursive rather than keyed on known fields because the shape
 * varies per tool: a ReadFile result carries the whole file under
 * `rawOutput.FileContent.content`, and capping only known keys once missed
 * 2.4 MB of exactly that. Only `rawOutput` subtrees are touched — `content`
 * and every other payload field are rendered by clients and stay whole.
 */

/**
 * Per-string cap applied when an activity is STORED. Deliberately far above
 * the 2 KB snapshot display cap: it keeps real diagnostic value while
 * removing the multi-megabyte blobs that were the leak.
 */
export const STORED_TOOL_RAW_OUTPUT_MAX_CHARS = 16_384;

/**
 * Deep enough for the nesting real tool results use, bounded so a cyclic or
 * pathological payload cannot walk forever.
 */
const MAX_DEPTH = 8;

const trimValue = (
  value: unknown,
  maxChars: number,
  depth: number,
): { value: unknown; changed: boolean } => {
  if (typeof value === "string") {
    return value.length > maxChars
      ? { value: value.slice(0, maxChars), changed: true }
      : { value, changed: false };
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const result = trimValue(entry, maxChars, depth + 1);
      if (result.changed) changed = true;
      return result.value;
    });
    return changed ? { value: next, changed: true } : { value, changed: false };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const result = trimValue(entry, maxChars, depth + 1);
    if (result.changed) changed = true;
    next[key] = result.value;
  }
  return changed ? { value: next, changed: true } : { value, changed: false };
};

/**
 * Caps every string inside the payload subtrees that carry raw tool output,
 * leaving the rest untouched. Returns `changed: false` (and the original
 * reference) when nothing exceeded the cap, so callers can skip rewrites.
 *
 * Two subtrees qualify:
 * - `data.rawOutput` — the raw provider result (object shapes are walked, a
 *   bare string is capped directly).
 * - `data.item.result` — an MCP call's stored result. Measured 2026-08-30 on
 *   the live database, single Preview MCP results (page snapshots, element
 *   dumps) reached 5 MB per row and dominated the oversized-row population
 *   while `rawOutput` was empty. The only reader is the expanded work-log
 *   row's raw JSON dump; `item.arguments` and the rest of the item stay
 *   whole.
 */
export function trimToolRawOutputInPayload(
  payload: unknown,
  maxChars: number,
): { payload: unknown; changed: boolean } {
  if (payload === null || typeof payload !== "object") return { payload, changed: false };
  const data = (payload as { readonly data?: unknown }).data;
  if (data === null || typeof data !== "object" || data === undefined) {
    return { payload, changed: false };
  }

  let nextData = data as Record<string, unknown>;
  let changed = false;

  const rawOutput = (data as { readonly rawOutput?: unknown }).rawOutput;
  if (rawOutput !== null && rawOutput !== undefined) {
    const trimmed = trimValue(rawOutput, maxChars, 0);
    if (trimmed.changed) {
      nextData = { ...nextData, rawOutput: trimmed.value };
      changed = true;
    }
  }

  const item = (data as { readonly item?: unknown }).item;
  if (item !== null && typeof item === "object") {
    // `result` and `aggregatedOutput` are separate fields, and capping only the
    // first left the larger one uncapped. Measured 2026-09-01 on the live
    // database, after the one-time sweep had already reclaimed 3.7 GB: of the
    // 40 largest activity rows, `aggregatedOutput` was the ONLY string over the
    // cap in any of them — 40 MB across those rows alone, 284 MB across every
    // row above 100 KB. A cap that misses the field doing the growing is a cap
    // in name only, and the backlog rebuilds behind it.
    for (const field of ["result", "aggregatedOutput"] as const) {
      const current = (nextData.item ?? item) as Record<string, unknown>;
      const value = current[field];
      if (value === null || value === undefined) continue;
      const trimmed = trimValue(value, maxChars, 0);
      if (trimmed.changed) {
        nextData = { ...nextData, item: { ...current, [field]: trimmed.value } };
        changed = true;
      }
    }
  }

  if (!changed) return { payload, changed: false };
  return {
    payload: { ...(payload as Record<string, unknown>), data: nextData },
    changed: true,
  };
}

/**
 * The `toolCallId` carried by a tool activity's payload, or null when the
 * payload has no usable one. Shared by snapshot superseded-frame dropping and
 * the projector's storage-side superseded-frame delete.
 */
export function toolCallIdOfToolActivityPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const data = (payload as { readonly data?: unknown }).data;
  if (data === null || data === undefined || typeof data !== "object") return null;
  const id = (data as { readonly toolCallId?: unknown }).toolCallId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Storage form of the cap for a whole activity: the identical activity when
 * nothing changed, otherwise a copy whose oversized `rawOutput` strings are
 * capped at {@link STORED_TOOL_RAW_OUTPUT_MAX_CHARS}.
 */
export function trimActivityToolRawOutputForStorage<A extends { readonly payload: unknown }>(
  activity: A,
): A {
  const trimmed = trimToolRawOutputInPayload(activity.payload, STORED_TOOL_RAW_OUTPUT_MAX_CHARS);
  return trimmed.changed ? { ...activity, payload: trimmed.payload } : activity;
}
