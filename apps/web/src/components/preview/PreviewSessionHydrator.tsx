"use client";

import type { ScopedThreadRef } from "@t3tools/contracts";

import { usePreviewSession } from "./usePreviewSession";

/** Keeps preview list and event synchronization alive without depending on a tab surface. */
export function PreviewSessionHydrator({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(threadRef);
  return null;
}
