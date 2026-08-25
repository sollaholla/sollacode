import { create } from "zustand";

export interface BrowserSurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserSurfacePresentation {
  readonly rect: BrowserSurfaceRect | null;
  readonly visible: boolean;
  /** True only for the browser tab selected in the visible sidebar. */
  readonly audible: boolean;
  /** False while the owner presents the surface as a non-clickable thumbnail. */
  readonly interactive: boolean;
  readonly content: BrowserSurfaceContentPresentation | null;
  readonly fittedSourceContent: BrowserSurfaceContentPresentation | null;
  readonly fitSourceContent: boolean;
  readonly cornerRadius: number;
  readonly updatedAt: number;
  readonly owner: symbol | null;
}

export interface BrowserSurfaceContentPresentation {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

interface BrowserSurfaceStoreState {
  readonly byTabId: Record<string, BrowserSurfacePresentation>;
  readonly claim: (tabId: string, owner: symbol, fitSourceContent: boolean) => void;
  readonly present: (
    tabId: string,
    owner: symbol,
    rect: BrowserSurfaceRect,
    visible: boolean,
    cornerRadius: number,
    interactive: boolean,
    audible: boolean,
  ) => void;
  readonly presentContent: (tabId: string, content: BrowserSurfaceContentPresentation) => void;
  readonly release: (tabId: string, owner: symbol) => void;
}

export interface BrowserSurfaceLease {
  readonly present: (
    rect: BrowserSurfaceRect,
    visible: boolean,
    cornerRadius?: number,
    interactive?: boolean,
    audible?: boolean,
  ) => boolean;
  readonly release: () => void;
}

interface BrowserSurfaceLeasePresentation {
  readonly rect: BrowserSurfaceRect;
  readonly visible: boolean;
  readonly cornerRadius: number;
  readonly interactive: boolean;
  readonly audible: boolean;
}

interface BrowserSurfaceLeaseCandidate {
  readonly owner: symbol;
  readonly fitSourceContent: boolean;
  readonly order: number;
  presentation: BrowserSurfaceLeasePresentation | null;
}

const browserSurfaceLeaseCandidates = new Map<string, BrowserSurfaceLeaseCandidate[]>();
let browserSurfaceLeaseOrder = 0;

const browserSurfacePresentationPriority = (
  presentation: BrowserSurfaceLeasePresentation | null,
): number => {
  if (!presentation) return 0;
  if (!presentation.visible) return 1;
  // The sidebar is the only interactive presentation. A transient floating
  // thumbnail must never move an already-visible guest offscreen.
  return presentation.interactive ? 3 : 2;
};

const preferredBrowserSurfaceCandidate = (tabId: string): BrowserSurfaceLeaseCandidate | null => {
  const candidates = browserSurfaceLeaseCandidates.get(tabId) ?? [];
  return (
    candidates.toSorted((left, right) => {
      const priority =
        browserSurfacePresentationPriority(right.presentation) -
        browserSurfacePresentationPriority(left.presentation);
      return priority !== 0 ? priority : right.order - left.order;
    })[0] ?? null
  );
};

const applyPreferredBrowserSurfaceCandidate = (
  tabId: string,
  releasingOwner?: symbol,
): symbol | null => {
  const preferred = preferredBrowserSurfaceCandidate(tabId);
  const store = useBrowserSurfaceStore.getState();
  if (!preferred) {
    if (releasingOwner) store.release(tabId, releasingOwner);
    return null;
  }
  store.claim(tabId, preferred.owner, preferred.fitSourceContent);
  if (preferred.presentation) {
    const { rect, visible, cornerRadius, interactive, audible } = preferred.presentation;
    store.present(tabId, preferred.owner, rect, visible, cornerRadius, interactive, audible);
  }
  return preferred.owner;
};

export function resolveBrowserSurfacePanelRect(
  byTabId: Readonly<Record<string, BrowserSurfacePresentation>>,
  tabId: string,
): BrowserSurfaceRect | null {
  const current = byTabId[tabId];
  return current?.rect ?? null;
}

const rectEquals = (left: BrowserSurfaceRect | null, right: BrowserSurfaceRect): boolean =>
  left !== null &&
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.height === right.height;

export const useBrowserSurfaceStore = create<BrowserSurfaceStoreState>()((set) => ({
  byTabId: {},
  claim: (tabId, owner, fitSourceContent) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner === owner) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: {
            rect: current?.rect ?? null,
            visible: false,
            // A new surface owner must opt into audio. This prevents a selected
            // sidebar tab from lending its audio state to a mini-player owner.
            audible: false,
            interactive: current?.interactive ?? true,
            content: current?.content ?? null,
            fittedSourceContent: fitSourceContent ? (current?.content ?? null) : null,
            fitSourceContent,
            cornerRadius: current?.cornerRadius ?? 0,
            updatedAt: Date.now(),
            owner,
          },
        },
      };
    }),
  present: (tabId, owner, rect, visible, cornerRadius, interactive, audible) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner !== owner) return state;
      if (
        current &&
        current.visible === visible &&
        current.audible === audible &&
        current.cornerRadius === cornerRadius &&
        current.interactive === interactive &&
        rectEquals(current.rect, rect)
      ) {
        return state;
      }
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: {
            ...current,
            rect,
            visible,
            audible,
            cornerRadius,
            interactive,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  presentContent: (tabId, content) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (!current) {
        return {
          byTabId: {
            ...state.byTabId,
            [tabId]: {
              rect: null,
              visible: false,
              audible: false,
              interactive: true,
              content,
              fittedSourceContent: null,
              fitSourceContent: false,
              cornerRadius: 0,
              updatedAt: Date.now(),
              owner: null,
            },
          },
        };
      }
      const previous = current.content;
      if (
        previous &&
        previous.x === content.x &&
        previous.y === content.y &&
        previous.width === content.width &&
        previous.height === content.height &&
        previous.scale === content.scale &&
        previous.scrollLeft === content.scrollLeft &&
        previous.scrollTop === content.scrollTop
      ) {
        return state;
      }
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: {
            ...current,
            content,
            fittedSourceContent:
              current.fitSourceContent && current.fittedSourceContent === null
                ? content
                : current.fittedSourceContent,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  release: (tabId, owner) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner !== owner) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: {
            ...current,
            visible: false,
            audible: false,
            // Reset rather than inherit: the mini player presents
            // non-interactively, and a stale `false` carried into the next
            // owner's first frame would leave the right panel unclickable.
            interactive: true,
            fittedSourceContent: null,
            fitSourceContent: false,
            updatedAt: Date.now(),
            owner: null,
          },
        },
      };
    }),
}));

export function acquireBrowserSurface(
  tabId: string,
  fitSourceContent = false,
): BrowserSurfaceLease {
  const owner = Symbol(`browser-surface:${tabId}`);
  const candidate: BrowserSurfaceLeaseCandidate = {
    owner,
    fitSourceContent,
    order: ++browserSurfaceLeaseOrder,
    presentation: null,
  };
  let released = false;
  const candidates = browserSurfaceLeaseCandidates.get(tabId) ?? [];
  browserSurfaceLeaseCandidates.set(tabId, [...candidates, candidate]);
  applyPreferredBrowserSurfaceCandidate(tabId);

  return {
    present: (rect, visible, cornerRadius = 0, interactive = true, audible = false) => {
      if (released) return false;
      candidate.presentation = { rect, visible, cornerRadius, interactive, audible };
      return applyPreferredBrowserSurfaceCandidate(tabId) === owner;
    },
    release: () => {
      if (released) return;
      released = true;
      const remaining = (browserSurfaceLeaseCandidates.get(tabId) ?? []).filter(
        (entry) => entry.owner !== owner,
      );
      if (remaining.length > 0) browserSurfaceLeaseCandidates.set(tabId, remaining);
      else browserSurfaceLeaseCandidates.delete(tabId);
      applyPreferredBrowserSurfaceCandidate(tabId, owner);
    },
  };
}
