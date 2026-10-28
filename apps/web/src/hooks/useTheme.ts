import type { DesktopBridge } from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { resolveDiffThemeName } from "../lib/diffRendering";
import {
  colorThemePaint,
  findColorTheme,
  type ColorThemeDefinition,
  type NamedColorThemeId,
  type ThemeChoice,
} from "../theme/colorThemes";

const ThemePreference = Schema.Literals(["light", "dark", "system"]);
type Theme = typeof ThemePreference.Type;
type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
  /** A named color theme overrides the Solla palette; null means Solla. */
  colorTheme: NamedColorThemeId | null;
};

type DesktopThemeBridge = Pick<DesktopBridge, "setTheme">;

const STORAGE_KEY = "t3code:theme";
/** The named color theme, if any. The light/dark mode above keeps the theme's
 * kind, so a build that predates named themes still opens in the right mode. */
const COLOR_THEME_STORAGE_KEY = "t3code:color-theme";
/** Everything index.html needs to paint a named theme before the app loads. */
const COLOR_THEME_PAINT_STORAGE_KEY = "t3code:color-theme-paint";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: "system",
  systemDark: false,
  colorTheme: null,
};
const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

export class ThemeStorageError extends Schema.TaggedErrorClass<ThemeStorageError>()(
  "ThemeStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    storageKey: Schema.String,
    theme: Schema.optional(ThemePreference),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`;
  }
}

export const isThemeStorageError = Schema.is(ThemeStorageError);

export class DesktopThemeSyncError extends Schema.TaggedErrorClass<DesktopThemeSyncError>()(
  "DesktopThemeSyncError",
  {
    theme: ThemePreference,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sync the ${this.theme} theme to the desktop shell.`;
  }
}

export const isDesktopThemeSyncError = Schema.is(DesktopThemeSyncError);

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: Theme | null = null;
let lastAppliedTheme: ThemeSnapshot | null = null;
let appliedColorTheme: ColorThemeDefinition | null = null;
let appliedColorThemeVariables: readonly string[] = [];
let themeStorageReadFailure: ThemeStorageError | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

function getSystemDark() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

export function readThemePreference(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT.theme;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: STORAGE_KEY,
      cause,
    });
  }
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return DEFAULT_THEME_SNAPSHOT.theme;
}

export function writeThemePreference(theme: Theme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
    themeStorageReadFailure = null;
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: STORAGE_KEY,
      theme,
      cause,
    });
  }
}

/** The stored named color theme, or null for Solla's own palette. */
export function readColorThemeId(): NamedColorThemeId | null {
  // A failed storage read latches until a storage event, like the mode does.
  if (typeof window === "undefined" || themeStorageReadFailure !== null) return null;
  try {
    const theme = findColorTheme(window.localStorage.getItem(COLOR_THEME_STORAGE_KEY));
    return theme ? (theme.id as NamedColorThemeId) : null;
  } catch {
    // An unreadable store already falls back to Solla through getStored().
    return null;
  }
}

function writeColorTheme(theme: ColorThemeDefinition | null): void {
  if (typeof window === "undefined") return;
  try {
    if (theme) {
      window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, theme.id);
      window.localStorage.setItem(
        COLOR_THEME_PAINT_STORAGE_KEY,
        JSON.stringify(colorThemePaint(theme)),
      );
    } else {
      window.localStorage.removeItem(COLOR_THEME_STORAGE_KEY);
      window.localStorage.removeItem(COLOR_THEME_PAINT_STORAGE_KEY);
    }
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: COLOR_THEME_STORAGE_KEY,
      cause,
    });
  }
}

/** Maps the stored mode and named theme onto the one value pickers show. */
export function themeChoiceFromState(theme: Theme, colorTheme: string | null): ThemeChoice {
  const named = findColorTheme(colorTheme);
  if (named) return named.id as NamedColorThemeId;
  return theme === "system" ? "system" : theme === "dark" ? "solla-dark" : "solla-light";
}

/** The named theme currently painted, for code that is not a React component. */
export function getActiveColorTheme(): ColorThemeDefinition | null {
  return appliedColorTheme;
}

function applyColorThemeVariables(theme: ColorThemeDefinition | null) {
  const root = document.documentElement;
  // Solla's own palette with nothing applied and nothing pre-painted: there
  // is nothing to remove. (Test documents may lack `dataset`.)
  const prePainted = typeof root.dataset === "object" ? root.dataset.colorTheme : undefined;
  if (!theme && appliedColorTheme === null && prePainted === undefined) return;
  // The pre-paint script in index.html may already have set a theme's
  // variables before this module knew about them — including a theme this
  // build no longer has, whose names only the cached paint still lists.
  const previous =
    appliedColorThemeVariables.length > 0
      ? appliedColorThemeVariables
      : Object.keys(colorThemePaintFor(prePainted)?.variables ?? readCachedPaintVariables() ?? {});
  for (const name of previous) root.style.removeProperty(name);
  if (!theme) {
    delete root.dataset.colorTheme;
    appliedColorTheme = null;
    appliedColorThemeVariables = [];
    return;
  }
  const { variables } = colorThemePaint(theme);
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  root.dataset.colorTheme = theme.id;
  appliedColorTheme = theme;
  appliedColorThemeVariables = Object.keys(variables);
  refreshColorThemePaintCache(theme);
}

function readCachedPaintVariables(): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(COLOR_THEME_PAINT_STORAGE_KEY);
    const paint: unknown = raw ? JSON.parse(raw) : null;
    if (typeof paint !== "object" || paint === null || !("variables" in paint)) return null;
    const { variables } = paint;
    return typeof variables === "object" && variables !== null
      ? (variables as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Keeps the pre-paint cache in step when a release retunes a theme's palette. */
function refreshColorThemePaintCache(theme: ColorThemeDefinition) {
  try {
    const paint = JSON.stringify(colorThemePaint(theme));
    if (window.localStorage.getItem(COLOR_THEME_PAINT_STORAGE_KEY) !== paint) {
      window.localStorage.setItem(COLOR_THEME_PAINT_STORAGE_KEY, paint);
    }
  } catch {
    // The cache only saves a flash on the next launch.
  }
}

function colorThemePaintFor(id: string | undefined) {
  const theme = findColorTheme(id);
  return theme ? colorThemePaint(theme) : null;
}

function getStored(): Theme {
  if (themeStorageReadFailure !== null) {
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
  try {
    return readThemePreference();
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "read",
          storageKey: STORAGE_KEY,
          cause,
        });
    themeStorageReadFailure = error;
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
}

function applyTheme(theme: Theme, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const colorTheme = readColorThemeId();
  const named = findColorTheme(colorTheme);
  const systemDark = theme === "system" && !named ? getSystemDark() : false;
  if (
    lastAppliedTheme?.theme === theme &&
    lastAppliedTheme.systemDark === systemDark &&
    lastAppliedTheme.colorTheme === colorTheme
  ) {
    syncDesktopTheme(theme);
    return;
  }

  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  const isDark = named
    ? named.kind === "dark"
    : theme === "dark" || (theme === "system" && systemDark);
  document.documentElement.classList.toggle("dark", isDark);
  applyColorThemeVariables(named);
  lastAppliedTheme = { theme, systemDark, colorTheme };
  syncBrowserChromeTheme();
  syncDesktopTheme(theme);
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

export async function syncDesktopThemePreference(
  bridge: DesktopThemeBridge,
  theme: Theme,
): Promise<void> {
  try {
    await bridge.setTheme(theme);
  } catch (cause) {
    throw new DesktopThemeSyncError({ theme, cause });
  }
}

export function syncDesktopTheme(theme: Theme) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.setTheme !== "function" || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void syncDesktopThemePreference(bridge, theme).catch((cause: unknown) => {
    const error = isDesktopThemeSyncError(cause)
      ? cause
      : new DesktopThemeSyncError({ theme, cause });
    console.error(error.message, {
      theme: error.theme,
      ...safeErrorLogAttributes(error),
    });
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

// Apply immediately on module load to prevent flash
if (typeof document !== "undefined" && typeof window !== "undefined") {
  applyTheme(getStored());
}

function getSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT;
  const theme = getStored();
  const colorTheme = readColorThemeId();
  const systemDark = theme === "system" && !colorTheme ? getSystemDark() : false;

  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.colorTheme === colorTheme
  ) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark, colorTheme };
  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);

  // Listen for system preference changes
  const mq = typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null;
  const handleChange = () => {
    if (getStored() === "system" && !readColorThemeId()) applyTheme("system", true);
    emitChange();
  };
  mq?.addEventListener("change", handleChange);

  // Listen for storage changes from other tabs
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === COLOR_THEME_STORAGE_KEY) {
      themeStorageReadFailure = null;
      applyTheme(getStored(), true);
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    mq?.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const theme = snapshot.theme;
  const colorTheme = findColorTheme(snapshot.colorTheme);
  const choice = themeChoiceFromState(theme, snapshot.colorTheme);

  const resolvedTheme: "light" | "dark" = colorTheme
    ? colorTheme.kind
    : theme === "system"
      ? snapshot.systemDark
        ? "dark"
        : "light"
      : theme;

  /** Picks Solla's System/Light/Dark or one named color theme. */
  const setChoice = useCallback((next: ThemeChoice) => {
    if (typeof window === "undefined") return;
    const named = findColorTheme(next);
    const mode: Theme = named
      ? named.kind
      : next === "system"
        ? "system"
        : next === "solla-dark"
          ? "dark"
          : "light";
    try {
      writeThemePreference(mode);
      writeColorTheme(named);
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({ operation: "write", storageKey: STORAGE_KEY, cause });
      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        ...safeErrorLogAttributes(error),
      });
      return;
    }
    applyTheme(mode, true);
    emitChange();
  }, []);

  /** Sets Solla's light/dark mode and leaves any named color theme. */
  const setTheme = useCallback((next: Theme) => {
    if (typeof window === "undefined") return;
    try {
      writeThemePreference(next);
      writeColorTheme(null);
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({
            operation: "write",
            storageKey: STORAGE_KEY,
            theme: next,
            cause,
          });
      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        theme: next,
        ...safeErrorLogAttributes(error),
      });
      return;
    }
    applyTheme(next, true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [theme, snapshot.colorTheme]);

  /** Shiki theme for code blocks, diffs and search results. */
  const diffThemeName = resolveDiffThemeName(resolvedTheme, colorTheme);

  return {
    theme,
    setTheme,
    resolvedTheme,
    choice,
    setChoice,
    colorTheme,
    diffThemeName,
  } as const;
}
