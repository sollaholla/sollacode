import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  assetThumbnailUrl,
  holdArtifactUrl,
  createAssetEnvironmentAtoms,
  createMissingAttachmentMemory,
  InvalidAssetCollectionKeyError,
  parseAssetCollectionKey,
} from "./assets.ts";

describe("asset thumbnail URLs", () => {
  it("asks for the small copy alongside any revision, keeping the fragment", () => {
    expect(assetThumbnailUrl("https://host/api/assets/t/a.png")).toBe(
      "https://host/api/assets/t/a.png?thumbnail=1",
    );
    expect(assetThumbnailUrl("https://host/api/assets/t/a.png?solla_revision=r1#x")).toBe(
      "https://host/api/assets/t/a.png?solla_revision=r1&thumbnail=1#x",
    );
    expect(assetThumbnailUrl("https://host/a.png?thumbnail=1")).toBe(
      "https://host/a.png?thumbnail=1",
    );
  });
});

describe("asset collection keys", () => {
  it("preserves malformed JSON and its native cause", () => {
    const key = "not-json";
    let error: unknown;

    try {
      parseAssetCollectionKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(InvalidAssetCollectionKeyError);
    expect(error).toMatchObject({ key, cause: expect.any(SyntaxError) });
  });

  it("rejects invalid asset collection shapes", () => {
    const key = JSON.stringify(["environment-1", [{ _tag: "unknown" }]]);

    expect(() => parseAssetCollectionKey(key)).toThrowError(InvalidAssetCollectionKeyError);
  });
});

describe("createAssetEnvironmentAtoms", () => {
  it("keys asset URL queries by environment and resource", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const originalTarget = {
      environmentId,
      input: {
        resource: {
          _tag: "project-favicon" as const,
          cwd: "/repo/original",
        },
      },
    };

    expect(assets.createUrl(originalTarget)).toBe(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/original",
          },
        },
      }),
    );
    expect(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/next",
          },
        },
      }),
    ).not.toBe(assets.createUrl(originalTarget));
    expect(
      assets.createUrl({
        environmentId: EnvironmentId.make("environment-2"),
        input: originalTarget.input,
      }),
    ).not.toBe(assets.createUrl(originalTarget));
  });

  it("keys collections while preserving independent resource queries", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const resources = [
      { _tag: "attachment" as const, attachmentId: "attachment-1" },
      { _tag: "attachment" as const, attachmentId: "attachment-2" },
    ];

    expect(assets.createUrls({ environmentId, resources })).toBe(
      assets.createUrls({
        environmentId,
        resources: resources.map((resource) => ({ ...resource })),
      }),
    );
    expect(
      assets.createUrls({
        environmentId,
        resources: [...resources].toReversed(),
      }),
    ).not.toBe(assets.createUrls({ environmentId, resources }));
  });
});

describe("createMissingAttachmentMemory", () => {
  it("stops asking only after the host has twice said an attachment is gone", () => {
    const memory = createMissingAttachmentMemory();
    expect(memory.isMissing("a")).toBe(false);
    memory.recordNotFound("a");
    expect(memory.isMissing("a")).toBe(false);
    memory.recordNotFound("a");
    expect(memory.isMissing("a")).toBe(true);
    expect(memory.isMissing("b")).toBe(false);
  });

  it("forgets a not-found once the attachment turns up", () => {
    const memory = createMissingAttachmentMemory();
    memory.recordNotFound("a");
    memory.recordFound("a");
    memory.recordNotFound("a");
    expect(memory.isMissing("a")).toBe(false);
  });

  it("stays bounded, dropping the oldest entry", () => {
    const memory = createMissingAttachmentMemory(2);
    for (const id of ["a", "a", "b", "b", "c", "c"]) memory.recordNotFound(id);
    expect(memory.isMissing("a")).toBe(false);
    expect(memory.isMissing("b")).toBe(true);
    expect(memory.isMissing("c")).toBe(true);
  });
});

describe("holdArtifactUrl", () => {
  const link = (url: string, expiresAt: number, scope = "revision-1") => ({
    url,
    expiresAt,
    scope,
  });
  const hour = 60 * 60_000;

  it("keeps an open page on its first link when a new one is signed", () => {
    const first = link("first", 12 * hour);
    expect(holdArtifactUrl(first, link("second", 13 * hour), hour)).toBe(first);
  });

  it("moves on just before the link expires, so the page can't lose its files", () => {
    const first = link("first", hour);
    const second = link("second", 2 * hour);
    expect(holdArtifactUrl(first, second, hour - 60_000)).toBe(second);
  });

  it("takes the new link for another revision or connection", () => {
    const next = link("second", 13 * hour, "revision-2");
    expect(holdArtifactUrl(link("first", 12 * hour), next, hour)).toBe(next);
  });

  it("takes the first link there is", () => {
    const first = link("first", hour);
    expect(holdArtifactUrl(null, first, 0)).toBe(first);
  });
});
