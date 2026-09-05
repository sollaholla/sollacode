import { GITHUB_REPOSITORY, GITHUB_REPOSITORY_URL } from "./site";

export const RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;

const API_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;
const CACHE_KEY = "solla-code-latest-release";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

function isRelease(value: unknown): value is Release {
  if (typeof value !== "object" || value === null) return false;
  if (!("tag_name" in value) || typeof value.tag_name !== "string") return false;
  if (!("html_url" in value) || typeof value.html_url !== "string") return false;
  if (!value.html_url.startsWith(`${RELEASES_URL}/tag/`)) return false;
  return (
    "assets" in value &&
    Array.isArray(value.assets) &&
    value.assets.every(
      (asset: unknown) =>
        typeof asset === "object" &&
        asset !== null &&
        "name" in asset &&
        typeof asset.name === "string" &&
        "browser_download_url" in asset &&
        typeof asset.browser_download_url === "string" &&
        asset.browser_download_url.startsWith(`${RELEASES_URL}/download/`),
    )
  );
}

export async function fetchLatestRelease(): Promise<Release> {
  // Storage can be unavailable or contain obsolete data; neither should prevent
  // the download page from requesting the current fork release.
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      const parsed: unknown = JSON.parse(cached);
      if (isRelease(parsed)) return parsed;
    }
  } catch {
    // Continue without the optional cache.
  }

  const response = await fetch(API_URL);
  if (!response.ok) throw new Error(`Release lookup failed (${response.status}).`);
  const data: unknown = await response.json();
  if (!isRelease(data)) throw new Error("Release lookup returned invalid data.");

  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // The fetched release remains usable when storage is disabled or full.
  }
  return data;
}
