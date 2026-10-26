// @effect-diagnostics nodeBuiltinImport:off - Verifies the standalone helper's actual temporary file permissions.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { AuthAccessTokenType, PreviewTabId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { bootstrapPreviewIntegration } from "./integration-bootstrap.ts";

const input = {
  baseUrl: "http://127.0.0.1:13773",
  pairingUrl: "http://127.0.0.1:5733/pair#token=agent-only-token",
  threadId: "fixture-thread",
};
const descriptor = {
  environmentId: "fixture-environment",
  label: "Isolated fixture",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "test",
  capabilities: {},
};

describe("preview integration bootstrap", () => {
  it("exchanges its agent token and keeps the bearer private while creating a real tab", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(descriptor))
      .mockResolvedValueOnce(
        Response.json({
          access_token: "private-bearer",
          issued_token_type: AuthAccessTokenType,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read orchestration:operate",
        }),
      );
    const tab: PreviewSessionSnapshot = {
      threadId: input.threadId,
      tabId: PreviewTabId.make("fixture-tab"),
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-26T00:00:00.000Z",
    };
    const openTab = vi.fn(async () => tab);
    const result = await bootstrapPreviewIntegration(input, { fetch: request, openTab });
    try {
      expect(request.mock.calls.map(([url]) => String(url))).toEqual([
        "http://127.0.0.1:13773/.well-known/t3/environment",
        "http://127.0.0.1:13773/oauth/token",
      ]);
      expect(request.mock.calls[1]![1]).toMatchObject({ method: "POST", redirect: "error" });
      const body = new URLSearchParams(String(request.mock.calls[1]![1]?.body));
      expect(body.get("subject_token")).toBe("agent-only-token");
      expect(body.has("scope")).toBe(false);
      expect(openTab).toHaveBeenCalledWith(input.baseUrl, "private-bearer", input.threadId);
      expect(NodeFS.readFileSync(result.bearerFile, "utf8")).toBe("private-bearer");
      expect(NodeFS.statSync(result.bearerFile).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(result)).not.toMatch(/private-bearer|agent-only-token/);
      expect(result).toMatchObject({ environmentId: "fixture-environment", tabId: "fixture-tab" });
    } finally {
      NodeFS.rmSync(NodePath.dirname(result.bearerFile), { recursive: true });
    }
  });

  it("does not consume pairing when descriptor discovery fails", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    const openTab = vi.fn();
    await expect(bootstrapPreviewIntegration(input, { fetch: request, openTab })).rejects.toThrow(
      "pairing was not attempted",
    );
    expect(request).toHaveBeenCalledOnce();
    expect(openTab).not.toHaveBeenCalled();
  });

  it.each([
    { baseUrl: "http://127.0.0.1:3773" },
    { baseUrl: "https://example.com" },
    { pairingUrl: "http://127.0.0.1:3773/pair#token=agent-only-token" },
  ])("rejects live or remote targets before making a request: %j", async (override) => {
    const request = vi.fn<typeof fetch>();
    await expect(
      bootstrapPreviewIntegration({ ...input, ...override }, { fetch: request }),
    ).rejects.toThrow("isolated loopback");
    expect(request).not.toHaveBeenCalled();
  });
});
