import type { PreviewSessionSnapshot } from "@t3tools/contracts";

interface PreviewAutomationSessionIndex {
  readonly snapshot: PreviewSessionSnapshot | null;
  readonly sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  readonly hostedSessions?: Readonly<Record<string, PreviewSessionSnapshot>>;
}

export interface PreviewAutomationDomainTab {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
}

export type PreviewAutomationClosePlan =
  | {
      readonly outcome: "already-closed";
      readonly activeTabId: string | null;
    }
  | {
      readonly outcome: "close";
      readonly snapshot: PreviewSessionSnapshot;
      readonly previousSessionCount: number;
    };

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname.startsWith("127.") ||
  hostname === "[::1]";

export function previewAutomationDomainKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const normalizedHostname = parsed.hostname
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
    return isLoopbackHostname(normalizedHostname) && parsed.port
      ? `${normalizedHostname}:${parsed.port}`
      : normalizedHostname;
  } catch {
    return null;
  }
}

export function findPreviewAutomationDomainTabs(
  state: PreviewAutomationSessionIndex,
  requestedUrl: string,
): readonly PreviewAutomationDomainTab[] {
  const requestedDomain = previewAutomationDomainKey(requestedUrl);
  if (!requestedDomain) return [];
  const knownSessions = { ...state.hostedSessions, ...state.sessions };
  return Object.values(knownSessions)
    .flatMap((session): PreviewAutomationDomainTab[] => {
      if (session.navStatus._tag === "Idle") return [];
      if (previewAutomationDomainKey(session.navStatus.url) !== requestedDomain) return [];
      return [
        {
          tabId: session.tabId,
          url: session.navStatus.url,
          title: session.navStatus.title,
          loading: session.navStatus._tag === "Loading",
        },
      ];
    })
    .toSorted((left, right) => left.tabId.localeCompare(right.tabId));
}

export function needsPreviewAutomationSessionSync(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
): boolean {
  return (
    Object.keys(state.sessions).length === 0 ||
    requestedTabId === undefined ||
    state.sessions[requestedTabId] === undefined
  );
}

export function resolvePreviewAutomationTarget(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | null,
): { readonly tabId: string | null; readonly snapshot: PreviewSessionSnapshot | null } {
  const snapshot = requestedTabId
    ? (state.sessions[requestedTabId] ?? state.hostedSessions?.[requestedTabId] ?? null)
    : state.snapshot;
  return { tabId: snapshot?.tabId ?? null, snapshot };
}

/** Resolve a close only after the caller has reconciled an authoritative list. */
export function resolvePreviewAutomationClosePlan(
  state: PreviewAutomationSessionIndex,
  tabId: string,
): PreviewAutomationClosePlan {
  const snapshot = state.sessions[tabId];
  return snapshot
    ? {
        outcome: "close",
        snapshot,
        previousSessionCount: Object.keys(state.sessions).length,
      }
    : { outcome: "already-closed", activeTabId: state.snapshot?.tabId ?? null };
}

export function resolvePreviewAutomationOpenTab(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
  reuseExistingTab: boolean,
  retainedTabId?: string | undefined,
  visibleTabId?: string | undefined,
): string | null {
  if (!reuseExistingTab) return null;
  if (requestedTabId !== undefined) {
    return (
      state.sessions[requestedTabId]?.tabId ?? state.hostedSessions?.[requestedTabId]?.tabId ?? null
    );
  }
  if (
    visibleTabId !== undefined &&
    (state.sessions[visibleTabId] !== undefined ||
      state.hostedSessions?.[visibleTabId] !== undefined)
  ) {
    return visibleTabId;
  }
  return (
    state.snapshot?.tabId ??
    (retainedTabId ? (state.hostedSessions?.[retainedTabId]?.tabId ?? null) : null)
  );
}
