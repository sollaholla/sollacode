const DYNAMIC_IMPORT_RECOVERY_STORAGE_PREFIX = "solla:dynamic-import-recovery:v1";

export const DYNAMIC_IMPORT_RECOVERY_QUERY_KEY = "solla_chunk_retry";
export const DYNAMIC_IMPORT_RECOVERY_COOLDOWN_MS = 2 * 60 * 1_000;

const DYNAMIC_IMPORT_FAILURE_PATTERNS = [
  /Importing a module script failed/iu,
  /Failed to fetch dynamically imported module/iu,
  /error loading (?:a )?dynamically imported module/iu,
  /Failed to load module script/iu,
  /(?:ChunkLoadError|Loading (?:CSS )?chunk \S+ failed)/iu,
  /Unable to preload CSS/iu,
];

interface DynamicImportRecoveryStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

interface DynamicImportRecoveryLocation {
  readonly href: string;
  readonly pathname: string;
  readonly reload: () => void;
  readonly replace: (url: string) => void;
}

export type DynamicImportRecoveryResult =
  | "ignored"
  | "already-attempted"
  | "storage-unavailable"
  | "reloading";

function searchableErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}\n${error.message}`;
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error !== "object" || error === null) {
    return "";
  }

  const record = error as Record<string, unknown>;
  return [record.name, record.message].filter((value) => typeof value === "string").join("\n");
}

export function isDynamicImportFailure(error: unknown): boolean {
  const text = searchableErrorText(error);
  return DYNAMIC_IMPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function dynamicImportRecoveryStorageKey(input: {
  readonly appVersion: string;
  readonly pathname: string;
}): string {
  return `${DYNAMIC_IMPORT_RECOVERY_STORAGE_PREFIX}:${encodeURIComponent(input.appVersion)}:${encodeURIComponent(input.pathname)}`;
}

export function buildDynamicImportRecoveryUrl(href: string, now: number): string {
  const url = new URL(href);
  url.searchParams.set(DYNAMIC_IMPORT_RECOVERY_QUERY_KEY, now.toString());
  return url.toString();
}

export function hasDynamicImportRecoveryQuery(href: string): boolean {
  try {
    return new URL(href).searchParams.has(DYNAMIC_IMPORT_RECOVERY_QUERY_KEY);
  } catch {
    return false;
  }
}

export function stripDynamicImportRecoveryQuery(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has(DYNAMIC_IMPORT_RECOVERY_QUERY_KEY)) {
    return null;
  }

  url.searchParams.delete(DYNAMIC_IMPORT_RECOVERY_QUERY_KEY);
  return url.toString();
}

export function dynamicImportRecoveryCleanupUrlAfterNavigation(input: {
  readonly href: string;
  readonly initialPathname: string;
  readonly currentPathname: string;
}): string | null {
  // The recovered document must retain its URL marker while the initial route
  // and nested lazy modules settle. Clearing it on the root shell's first
  // mount lets the same failed import trigger an unbounded reload loop when
  // sessionStorage is unavailable. A later pathname change is a causal user
  // navigation and is the first safe cleanup boundary.
  if (input.currentPathname === input.initialPathname) return null;
  return stripDynamicImportRecoveryQuery(input.href);
}

function replaceWithFreshAppShell(location: DynamicImportRecoveryLocation, now: number): boolean {
  try {
    location.replace(buildDynamicImportRecoveryUrl(location.href, now));
    return true;
  } catch {
    return false;
  }
}

export function reloadWithFreshAppShell(
  location: DynamicImportRecoveryLocation,
  now: number,
): void {
  if (!replaceWithFreshAppShell(location, now)) location.reload();
}

export function shouldAutoRecoverDynamicImportFailure(input: {
  readonly dynamicImportFailure: boolean;
  readonly desktopBridgeAvailable: boolean;
}): boolean {
  return input.dynamicImportFailure && !input.desktopBridgeAvailable;
}

export function attemptDynamicImportRecovery(input: {
  readonly appVersion: string;
  readonly error: unknown;
  readonly getStorage: () => DynamicImportRecoveryStorage;
  readonly location: DynamicImportRecoveryLocation;
  readonly now: number;
}): DynamicImportRecoveryResult {
  if (!isDynamicImportFailure(input.error)) {
    return "ignored";
  }

  // The URL marker survives a document reload even when sessionStorage does
  // not. Treat it as the fallback one-shot guard before consulting storage.
  if (hasDynamicImportRecoveryQuery(input.location.href)) {
    return "already-attempted";
  }

  const storageKey = dynamicImportRecoveryStorageKey({
    appVersion: input.appVersion,
    pathname: input.location.pathname,
  });

  try {
    const storage = input.getStorage();
    const storedAttemptedAt = storage.getItem(storageKey);
    const attemptedAt =
      storedAttemptedAt !== null && /^\d+$/u.test(storedAttemptedAt)
        ? Number(storedAttemptedAt)
        : Number.NaN;
    if (
      Number.isFinite(attemptedAt) &&
      Math.abs(input.now - attemptedAt) < DYNAMIC_IMPORT_RECOVERY_COOLDOWN_MS
    ) {
      return "already-attempted";
    }
    storage.setItem(storageKey, input.now.toString());
  } catch {
    // A query marker is durable across the reload. If it cannot be attached,
    // stay on the recoverable error surface rather than risk a plain loop.
    return replaceWithFreshAppShell(input.location, input.now)
      ? "reloading"
      : "storage-unavailable";
  }

  reloadWithFreshAppShell(input.location, input.now);
  return "reloading";
}
