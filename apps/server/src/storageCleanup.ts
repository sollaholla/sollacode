export const STORAGE_CLEANUP_PROJECT_TITLE = "Storage cleanup";
export const STORAGE_CLEANUP_THREAD_TITLE = "Free up storage space";
export const STORAGE_CLEANUP_PROMPT =
  "Help me free storage space on the host machine this thread runs on. Inspect current disk usage first, then clear only confirmed disposable caches, obsolete installers or build outputs, and temporary files that are not in use. " +
  "Keep my login cookies, signed-in sessions, saved credentials, browser profile data, personal files, source code, uncommitted work, active processes, and live Solla Code databases. Never delete whole browser profiles; use supported cache-only cleanup where possible. " +
  "Check that each cleanup target is safe and inactive before deleting it. Ask me before removing anything whose purpose or ownership is unclear. Do not modify project code. Report what was removed, how much space was recovered, and the remaining free space.";
