// v3 contains bounded history. Reject older rows before decoding their potentially
// unbounded message and activity arrays.
export const THREAD_CACHE_SCHEMA_VERSION = 3;

// Recent 100-message/200-activity windows measured below 625k characters. Allow
// room for plans, checkpoints and retained lifecycle rows while bounding decode.
export const THREAD_CACHE_MAX_CHARS = 4 * 1024 * 1024;

export function isCurrentThreadCachePayload(raw: string): boolean {
  return (
    raw.length <= THREAD_CACHE_MAX_CHARS &&
    raw.startsWith(`{"schemaVersion":${THREAD_CACHE_SCHEMA_VERSION},`)
  );
}
