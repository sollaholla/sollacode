import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";

export const composerFocusRequestsAtom = Atom.make<Record<string, number>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:composer:focus-requests"),
);

export function requestComposerFocus(threadKey: string): void {
  const current = appAtomRegistry.get(composerFocusRequestsAtom);
  appAtomRegistry.set(composerFocusRequestsAtom, {
    ...current,
    [threadKey]: (current[threadKey] ?? 0) + 1,
  });
}

export function consumeComposerFocusRequest(threadKey: string, version: number): void {
  const current = appAtomRegistry.get(composerFocusRequestsAtom);
  if (current[threadKey] !== version) return;
  const next = { ...current };
  delete next[threadKey];
  appAtomRegistry.set(composerFocusRequestsAtom, next);
}
