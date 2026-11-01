import {
  AssetAttachmentNotFoundError,
  AssetResource,
  EnvironmentId,
  WS_METHODS,
  type AssetCreateUrlInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

const ASSET_URL_REFRESH_INTERVAL_MS = 30 * 60_000;
const ASSET_URL_STALE_TIME_MS = 5 * 60_000;
const ASSET_URL_IDLE_TTL_MS = 60 * 60_000;

export class InvalidAssetCollectionKeyError extends Schema.TaggedErrorClass<InvalidAssetCollectionKeyError>()(
  "InvalidAssetCollectionKeyError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid asset collection atom key: ${JSON.stringify(this.key)}.`;
  }
}

const decodeAssetCollectionKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.Array(AssetResource)]),
);

export function parseAssetCollectionKey(
  key: string,
): readonly [EnvironmentId, ReadonlyArray<AssetResource>] {
  try {
    return decodeAssetCollectionKey(JSON.parse(key));
  } catch (cause) {
    throw new InvalidAssetCollectionKeyError({ key, cause });
  }
}

/**
 * The same image as a small JPEG, for a thumbnail tile: the server sends the
 * original when it can't make one. Plain string work, since React Native's
 * `URL` has no writable search params.
 */
export function assetThumbnailUrl(url: string): string {
  const hashAt = url.indexOf("#");
  const base = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  if (/[?&]thumbnail=1(?:&|$)/u.test(base)) return url;
  return `${base}${base.includes("?") ? "&" : "?"}thumbnail=1${hash}`;
}

export function resolveAssetUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    // Asset links are host-relative ("/api/assets/…"). An environment reached
    // through another host's relay lives under a path prefix, which a plain
    // URL resolve would drop.
    const base = new URL(httpBaseUrl);
    const prefix = base.pathname.replace(/\/+$/u, "");
    if (prefix.length > 0 && relativeUrl.startsWith("/") && !relativeUrl.startsWith("//")) {
      return new URL(`${prefix}${relativeUrl}`, base.origin).toString();
    }
    return new URL(relativeUrl, httpBaseUrl).toString();
  } catch {
    return null;
  }
}

const MISSING_ATTACHMENT_MEMORY_LIMIT = 4_096;

/**
 * Attachments the host has said it no longer has. A deleted file never comes back
 * under its id, so an open client asking again every half hour only fills the host's
 * logs. It takes two answers, because a forked chat's copy can land just after the
 * first request for it.
 */
export function createMissingAttachmentMemory(limit = MISSING_ATTACHMENT_MEMORY_LIMIT) {
  const notFoundCounts = new Map<string, number>();
  return {
    isMissing: (attachmentId: string) => (notFoundCounts.get(attachmentId) ?? 0) >= 2,
    recordNotFound: (attachmentId: string) => {
      if (!notFoundCounts.has(attachmentId) && notFoundCounts.size >= limit) {
        const oldest = notFoundCounts.keys().next();
        if (!oldest.done) notFoundCounts.delete(oldest.value);
      }
      notFoundCounts.set(attachmentId, (notFoundCounts.get(attachmentId) ?? 0) + 1);
    },
    recordFound: (attachmentId: string) => {
      notFoundCounts.delete(attachmentId);
    },
  };
}

export function createAssetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const missingAttachments = createMissingAttachmentMemory();
  const createUrl = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:assets:create-url",
    staleTimeMs: ASSET_URL_STALE_TIME_MS,
    idleTtlMs: ASSET_URL_IDLE_TTL_MS,
    refreshIntervalMs: ASSET_URL_REFRESH_INTERVAL_MS,
    execute: (input: AssetCreateUrlInput) => {
      const { resource } = input;
      const attachmentId = resource._tag === "attachment" ? resource.attachmentId : null;
      if (attachmentId === null) return request(WS_METHODS.assetsCreateUrl, input);
      if (missingAttachments.isMissing(attachmentId)) {
        return Effect.fail(new AssetAttachmentNotFoundError({ resource }));
      }
      return request(WS_METHODS.assetsCreateUrl, input).pipe(
        Effect.tap(() => Effect.sync(() => missingAttachments.recordFound(attachmentId))),
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (error._tag === "AssetAttachmentNotFoundError") {
              missingAttachments.recordNotFound(attachmentId);
            }
          }),
        ),
      );
    },
  });
  const createUrlsFamily = Atom.family((key: string) => {
    const [environmentId, resources] = parseAssetCollectionKey(key);
    return Atom.make((get) =>
      resources.map((resource) =>
        get(
          createUrl({
            environmentId,
            input: { resource },
          }),
        ),
      ),
    ).pipe(
      Atom.setIdleTTL(ASSET_URL_IDLE_TTL_MS),
      Atom.withLabel(`environment-data:assets:create-urls:${key}`),
    );
  });

  return {
    createUrl,
    createUrls: (target: {
      readonly environmentId: EnvironmentId;
      readonly resources: ReadonlyArray<AssetResource>;
    }) => createUrlsFamily(JSON.stringify([target.environmentId, target.resources])),
  };
}
