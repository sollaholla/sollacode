import { useAtomValue } from "@effect/atom-react";
import {
  createAssetEnvironmentAtoms,
  holdArtifactUrl,
  resolveAssetUrl,
  type HeldArtifactUrl,
} from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePreparedConnection } from "./session";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_ASSET_URL_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-asset-url:empty"),
);

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
):
  | { _tag: "Loading" }
  | { _tag: "Failure" }
  | { _tag: "Success"; url: string; expiresAt: number; baseUrl: string } {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  if (result._tag === "Failure") return { _tag: "Failure" };
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return { _tag: "Loading" };
  }
  const url = resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);
  return url === null
    ? { _tag: "Failure" }
    : {
        _tag: "Success",
        url,
        expiresAt: result.value.expiresAt,
        baseUrl: preparedConnection.value.httpBaseUrl,
      };
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const result = useAssetUrlState(environmentId, resource);
  return result._tag === "Success" ? result.url : null;
}

/**
 * The link an open artifact page keeps, see `holdArtifactUrl`: a re-signed link
 * or a dropped socket must not reload the page and stop its video. `revisionKey`
 * names what is on screen.
 */
export function useHeldArtifactUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revisionKey: string,
): string | null {
  const content = useAssetUrlState(environmentId, resource);
  const [held, setHeld] = useState<(HeldArtifactUrl & { revisionKey: string }) | null>(null);
  const next = content._tag === "Success" ? content : null;
  const nextUrl = next?.url ?? null;
  const nextExpiresAt = next?.expiresAt ?? 0;
  const nextBaseUrl = next?.baseUrl ?? null;
  useEffect(() => {
    if (nextUrl === null) return;
    const candidate = {
      url: nextUrl,
      expiresAt: nextExpiresAt,
      scope: `${revisionKey}\u0000${nextBaseUrl}`,
      revisionKey,
    };
    setHeld((current) => {
      const kept = holdArtifactUrl(current, candidate, Date.now());
      return kept === current ? current : candidate;
    });
  }, [nextBaseUrl, nextExpiresAt, nextUrl, revisionKey]);
  if (held !== null && held.revisionKey === revisionKey) return held.url;
  return nextUrl;
}
