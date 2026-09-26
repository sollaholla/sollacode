import { create } from "zustand";

import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

/**
 * A pending "sign this provider in" request, handed from wherever it was asked
 * for to whichever thread view can actually open a terminal.
 *
 * Provider sign-in is a browser OAuth flow owned by each CLI: the app cannot
 * complete it, but it can run the command instead of printing it and asking
 * the person to open a terminal and type it themselves. The only surface that
 * can run it is a thread's terminal pane, and the provider settings screen is
 * a route of its own with no thread mounted - so the request is parked here
 * and serviced by the thread view once one is on screen.
 *
 * Deliberately not persisted. A sign-in the person walked away from should not
 * spring a terminal on them at next launch.
 */
export interface ProviderSignInRequest {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind | string;
  /** Display name, for the pane's own status text. */
  readonly displayName: string;
  /**
   * Whether this provider can sign in through the in-app account-switch flow.
   * When it can, that is used and `command` is never run - the flow shows the
   * provider's own sign-in page in the UI instead of a terminal.
   */
  readonly supportsAccountSwitch: boolean;
  /** Fallback for providers with no in-app flow, e.g. `muse login`. */
  readonly command: string;
  /** Distinguishes a fresh ask from a repeat of one already serviced. */
  readonly requestedAt: number;
}

interface ProviderSignInRequestState {
  readonly pending: ProviderSignInRequest | null;
  readonly request: (input: Omit<ProviderSignInRequest, "requestedAt">) => void;
  /**
   * Take the pending request when it matches, clearing it.
   *
   * Conditional because the two ways of servicing a request live in different
   * components: the in-app account switch is owned by the chat view, the
   * terminal fallback by the terminal panel. An unconditional take would let
   * whichever mounted first swallow a request it cannot service.
   */
  readonly consumeIf: (
    predicate: (request: ProviderSignInRequest) => boolean,
  ) => ProviderSignInRequest | null;
  readonly clear: () => void;
}

export const useProviderSignInRequestStore = create<ProviderSignInRequestState>((set, get) => ({
  pending: null,
  request: (input) => {
    set({ pending: { ...input, requestedAt: Date.now() } });
  },
  consumeIf: (predicate) => {
    const { pending } = get();
    if (pending === null || !predicate(pending)) return null;
    set({ pending: null });
    return pending;
  },
  clear: () => {
    set({ pending: null });
  },
}));
