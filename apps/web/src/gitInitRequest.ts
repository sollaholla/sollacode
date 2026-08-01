import type { ProviderInstanceId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * A queued request to have a provider set up a freshly created repository.
 *
 * The button that starts this lives in the chat header, while the code that can
 * actually send a turn lives in the chat view, so the request is handed over
 * through a store rather than a prop chain threaded through every layout.
 */
export interface GitInitRequest {
  readonly prompt: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

interface GitInitRequestState {
  readonly request: GitInitRequest | null;
  readonly setRequest: (request: GitInitRequest) => void;
  readonly clearRequest: () => void;
}

export const useGitInitRequestStore = create<GitInitRequestState>((set) => ({
  request: null,
  setRequest: (request) => set({ request }),
  clearRequest: () => set({ request: null }),
}));

/**
 * Whether the queued request is ready to send.
 *
 * Selecting the provider and sending the turn cannot happen in one pass: the
 * send reads the composer's live send context, which still holds the previous
 * selection until React has re-rendered with the new one. So the request waits
 * here until the composer actually reports the provider it was given.
 */
export function isGitInitRequestReady(input: {
  readonly request: GitInitRequest | null;
  readonly activeInstanceId: ProviderInstanceId | null;
  readonly activeModel: string | null;
}): boolean {
  if (input.request === null) return false;
  return (
    input.request.instanceId === input.activeInstanceId && input.request.model === input.activeModel
  );
}
