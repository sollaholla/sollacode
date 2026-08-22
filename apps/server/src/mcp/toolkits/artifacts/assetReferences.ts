/**
 * Finds asset paths a published bundle points at but does not contain.
 *
 * Publishing is all-or-nothing per revision: whatever is in `files` is the
 * whole artifact, and anything else it asks the browser for 404s. An agent
 * that writes `<img src="img/hero.webp">` and then uploads only the HTML gets
 * a successful publish, a valid URL, and a page of broken images — with
 * nothing in the response hinting at why, which reads from the outside like
 * the host failing to serve assets rather than the bundle never having had
 * them.
 *
 * Catching it here turns that into an error at the point of the mistake, while
 * the agent still has the images in hand.
 */

/** Extensions worth checking. Deliberately media and fonts. */
const ASSET_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "avif",
  "bmp",
  "ico",
  "svg",
  "mp4",
  "webm",
  "mov",
  "mp3",
  "wav",
  "ogg",
  "woff",
  "woff2",
  "ttf",
  "otf",
] as const;

/**
 * A quoted string or `url(...)` operand that names one of those extensions.
 *
 * Scanning string literals rather than only `src=`/`href=` attributes is
 * deliberate: bundles routinely keep their asset paths in a JS array and build
 * the markup at runtime, so an attribute-only scan misses exactly the case
 * that prompted this.
 */
const REFERENCE_PATTERN = new RegExp(
  String.raw`["'\(]\s*([^"'\(\)\s<>]+\.(?:${ASSET_EXTENSIONS.join("|")}))\s*["'\)]`,
  "giu",
);

/** Schemes and shapes that are not this bundle's problem. */
const EXTERNAL_PREFIXES = ["http:", "https:", "//", "data:", "blob:", "file:", "#", "mailto:"];

/**
 * Whether a reference is a plain static path.
 *
 * A reference assembled at runtime — a template hole, a concatenation, an
 * escape — cannot be resolved by reading the source, so treating it as missing
 * would reject bundles that are perfectly fine. Only literal paths are judged.
 */
function isStaticReference(reference: string): boolean {
  if (reference.length === 0 || reference.length > 512) return false;
  if (/[${}+\\`]/u.test(reference)) return false;
  return !EXTERNAL_PREFIXES.some((prefix) => reference.toLowerCase().startsWith(prefix));
}

/** Strips the `./` and `/` prefixes so a reference compares against a path. */
export function normalizeArtifactPath(value: string): string {
  let path = value.trim().split("?")[0]?.split("#")[0] ?? "";
  while (path.startsWith("./")) path = path.slice(2);
  while (path.startsWith("/")) path = path.slice(1);
  return path;
}

/** Text formats whose contents can name another file. */
function isScannable(file: { readonly path: string; readonly contentType: string }): boolean {
  const contentType = file.contentType.toLowerCase();
  if (contentType.startsWith("text/")) return true;
  if (/^application\/(x-)?(javascript|ecmascript|json|xml)\b/u.test(contentType)) return true;
  if (contentType.startsWith("image/svg")) return true;
  return /\.(html?|css|m?js|jsx|tsx?|json|svg|xml)$/iu.test(file.path);
}

export interface ArtifactBundleFile {
  readonly path: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/**
 * Asset paths referenced by the bundle's text files but absent from it.
 *
 * Sorted and de-duplicated, capped so a generated bundle cannot turn one
 * mistake into an unreadable error.
 */
export function findMissingAssetReferences(
  files: readonly ArtifactBundleFile[],
  limit = 12,
): readonly string[] {
  const present = new Set(files.map((file) => normalizeArtifactPath(file.path)));
  const missing = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (const file of files) {
    if (!isScannable(file)) continue;
    const source = decoder.decode(file.bytes);
    for (const match of source.matchAll(REFERENCE_PATTERN)) {
      const raw = match[1];
      if (raw === undefined || !isStaticReference(raw)) continue;
      const normalized = normalizeArtifactPath(raw);
      // A bare filename with no directory is ambiguous enough to leave alone:
      // it is as likely to be a label or a key as a path.
      if (normalized.length === 0 || present.has(normalized)) continue;
      missing.add(normalized);
    }
  }
  return [...missing].sort().slice(0, limit);
}

/** The error text shown to whoever tried to publish. */
export function describeMissingAssetReferences(missing: readonly string[]): string {
  return [
    `references ${missing.length === 1 ? "a file" : "files"} it does not include: `,
    missing.join(", "),
    ". A revision is served from exactly the files it publishes, so these would 404. ",
    "Either add them to `files` (binary assets go in `dataBase64`), or inline them ",
    "as `data:` URIs and drop the paths.",
  ].join("");
}
