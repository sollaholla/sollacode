import * as Schema from "effect/Schema";

export const ArtifactManifestFile = Schema.Struct({
  path: Schema.String,
  contentType: Schema.String,
  byteLength: Schema.Int,
});

export const ArtifactManifest = Schema.Struct({
  version: Schema.Literal(1),
  entryPath: Schema.String,
  files: Schema.Array(ArtifactManifestFile),
});
export type ArtifactManifest = typeof ArtifactManifest.Type;

export const ArtifactManifestJson = Schema.fromJsonString(ArtifactManifest);
export const decodeArtifactManifest = Schema.decodeUnknownOption(ArtifactManifestJson);
export const encodeArtifactManifest = Schema.encodeSync(ArtifactManifestJson);

const startsWithBytes = (
  bytes: Uint8Array,
  signature: ReadonlyArray<number>,
  offset = 0,
): boolean => signature.every((value, index) => bytes[offset + index] === value);

export function deriveArtifactMimeType(path: string, bytes: Uint8Array): string | null {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".html":
    case ".htm":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".svg":
      return "image/svg+xml";
    case ".woff":
      return startsWithBytes(bytes, [0x77, 0x4f, 0x46, 0x46]) ? "font/woff" : null;
    case ".woff2":
      return startsWithBytes(bytes, [0x77, 0x4f, 0x46, 0x32]) ? "font/woff2" : null;
    case ".ttf":
      return startsWithBytes(bytes, [0x00, 0x01, 0x00, 0x00]) ? "font/ttf" : null;
    case ".pdf":
      return startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) ? "application/pdf" : null;
    case ".png":
      return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ? "image/png"
        : null;
    case ".jpg":
    case ".jpeg":
      return startsWithBytes(bytes, [0xff, 0xd8, 0xff]) ? "image/jpeg" : null;
    case ".gif":
      return startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38]) ? "image/gif" : null;
    case ".webp":
      return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
        ? "image/webp"
        : null;
    case ".avif":
      return startsWithBytes(bytes, [0x66, 0x74, 0x79, 0x70], 4) &&
        (startsWithBytes(bytes, [0x61, 0x76, 0x69, 0x66], 8) ||
          startsWithBytes(bytes, [0x61, 0x76, 0x69, 0x73], 8))
        ? "image/avif"
        : null;
    case ".ico":
      return startsWithBytes(bytes, [0x00, 0x00, 0x01, 0x00]) ? "image/vnd.microsoft.icon" : null;
    default:
      return null;
  }
}
