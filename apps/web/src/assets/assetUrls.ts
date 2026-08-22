import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

const DESKTOP_REMOTE_ASSET_PROXY_PATH = "/__solla/remote-asset";
const DESKTOP_REMOTE_ARTIFACT_PROXY_PATH = "/__solla/remote-artifact";
const DESKTOP_RENDERER_PROTOCOLS = new Set(["sollacode:", "t3code-dev:"]);

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function resolveDisplayAssetUrl(
  httpBaseUrl: string,
  relativeUrl: string,
  rendererHref: string | null = typeof window === "undefined" ? null : window.location.href,
): string | null {
  const assetUrl = resolveAssetUrl(httpBaseUrl, relativeUrl);
  if (assetUrl === null || rendererHref === null) return assetUrl;

  try {
    const rendererUrl = new URL(rendererHref);
    if (!DESKTOP_RENDERER_PROTOCOLS.has(rendererUrl.protocol)) return assetUrl;

    const proxyUrl = new URL(DESKTOP_REMOTE_ASSET_PROXY_PATH, rendererUrl);
    proxyUrl.searchParams.set("url", assetUrl);
    return proxyUrl.toString();
  } catch {
    return assetUrl;
  }
}

/**
 * Give an artifact bundle a path-shaped desktop URL so its relative CSS,
 * scripts, fonts, and images stay inside the same signed revision capability.
 * The ordinary single-file proxy uses a query parameter, which cannot act as
 * a base URL for sibling files.
 */
export function resolveDisplayArtifactUrl(
  httpBaseUrl: string,
  relativeUrl: string,
  rendererHref: string | null = typeof window === "undefined" ? null : window.location.href,
): string | null {
  const assetUrl = resolveAssetUrl(httpBaseUrl, relativeUrl);
  if (assetUrl === null || rendererHref === null) return assetUrl;

  try {
    const rendererUrl = new URL(rendererHref);
    if (!DESKTOP_RENDERER_PROTOCOLS.has(rendererUrl.protocol)) return assetUrl;

    const target = new URL(assetUrl);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.username.length > 0 ||
      target.password.length > 0
    ) {
      return assetUrl;
    }
    const assetPrefix = "/api/assets/";
    if (!target.pathname.startsWith(assetPrefix)) return assetUrl;
    const assetSuffix = target.pathname.slice(assetPrefix.length);
    const separatorIndex = assetSuffix.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === assetSuffix.length - 1) return assetUrl;

    const token = assetSuffix.slice(0, separatorIndex);
    if (!/^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/u.test(token)) return assetUrl;
    const bundleRoot = new URL(`${assetPrefix}${token}/`, target.origin).toString();
    const entryPath = assetSuffix.slice(separatorIndex + 1);
    const proxyUrl = new URL(
      `${DESKTOP_REMOTE_ARTIFACT_PROXY_PATH}/${encodeBase64Url(bundleRoot)}/${entryPath}`,
      rendererUrl,
    );
    proxyUrl.search = target.search;
    return proxyUrl.toString();
  } catch {
    return assetUrl;
  }
}

export function withAssetRevision(url: string, revision: string): string {
  const normalizedRevision = revision.trim();
  if (normalizedRevision.length === 0) return url;
  try {
    const revised = new URL(url);
    revised.searchParams.set("solla_revision", normalizedRevision);
    return revised.toString();
  } catch {
    return url;
  }
}

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure" }
  | { readonly _tag: "Success"; readonly url: string };

export function useAssetUrlState(
  environmentId: EnvironmentId,
  resource: AssetResource,
  display: "single" | "artifact" = "single",
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    assetEnvironment.createUrl({
      environmentId,
      input: { resource },
    }),
  );
  if (result._tag === "Failure") {
    return { _tag: "Failure" };
  }
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return { _tag: "Loading" };
  }
  const url =
    display === "artifact"
      ? resolveDisplayArtifactUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
      : resolveDisplayAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);
  return url === null ? { _tag: "Failure" } : { _tag: "Success", url };
}

export function useAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  const result = useAssetUrlState(environmentId, resource);
  if (result._tag !== "Success") {
    return null;
  }
  return result.url;
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources,
    }),
  );
  return useMemo(
    () =>
      preparedConnection._tag === "None"
        ? resources.map(() => null)
        : results.map((result) =>
            AsyncResult.isSuccess(result)
              ? resolveDisplayAssetUrl(
                  preparedConnection.value.httpBaseUrl,
                  result.value.relativeUrl,
                )
              : null,
          ),
    [preparedConnection, resources, results],
  );
}
