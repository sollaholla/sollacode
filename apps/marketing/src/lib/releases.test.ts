import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchLatestRelease, RELEASES_URL } from "./releases";

const release = {
  tag_name: "v0.1.1",
  html_url: `${RELEASES_URL}/tag/v0.1.1`,
  assets: [
    {
      name: "Solla-Code-0.1.1-arm64.dmg",
      browser_download_url: `${RELEASES_URL}/download/v0.1.1/Solla-Code-0.1.1-arm64.dmg`,
    },
  ],
};

function setup(cached: string | null = null) {
  const storage = { getItem: vi.fn(() => cached), setItem: vi.fn() };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => release });
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("fetch", fetch);
  return { storage, fetch };
}

afterEach(() => vi.unstubAllGlobals());

describe("Solla release lookup", () => {
  it("requests the fork and recovers from a corrupted cache", async () => {
    const { fetch } = setup("not json");
    expect(await fetchLatestRelease()).toEqual(release);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/sollaholla/sollacode/releases/latest",
    );
  });

  it("uses valid cached fork data without fetching again", async () => {
    const { fetch } = setup(JSON.stringify(release));
    expect(await fetchLatestRelease()).toEqual(release);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores upstream release data in storage", async () => {
    const { fetch } = setup(
      JSON.stringify({
        ...release,
        html_url: "https://github.com/pingdotgg/t3code/releases/tag/v0.1.1",
      }),
    );
    expect(await fetchLatestRelease()).toEqual(release);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("still returns a release when storage access is denied", async () => {
    const { storage } = setup();
    storage.getItem.mockImplementation(() => {
      throw new Error("denied");
    });
    storage.setItem.mockImplementation(() => {
      throw new Error("full");
    });
    expect(await fetchLatestRelease()).toEqual(release);
  });

  it("rejects HTTP failures rather than displaying them as release data", async () => {
    const { fetch } = setup();
    fetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchLatestRelease()).rejects.toThrow("404");
  });

  it("rejects malformed or foreign download assets", async () => {
    const { fetch } = setup();
    for (const data of [
      null,
      { ...release, assets: [null] },
      {
        ...release,
        assets: [
          {
            name: "installer",
            browser_download_url: "https://github.com/pingdotgg/t3code/releases/download/v1/t3.exe",
          },
        ],
      },
    ]) {
      fetch.mockResolvedValue({ ok: true, json: async () => data });
      await expect(fetchLatestRelease()).rejects.toThrow("invalid data");
    }
  });
});
