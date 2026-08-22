// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

/**
 * Resolution for `localPath` entries in an artifact publish.
 *
 * Publishing used to accept bytes only inline, so an entire bundle had to be
 * emitted verbatim by the model in one response — which put a hard ceiling on
 * artifact size that had nothing to do with any documented limit. A 23 KB HTML
 * shell plus twelve preview images truncated mid-string and was rejected as
 * invalid base64. Reading from disk moves that cost off the model entirely and
 * makes bundle size a function of the filesystem.
 *
 * Every path is confined to one directory named on the same call. The caller
 * can usually read these files by other means anyway, so this is not the only
 * thing standing between it and the disk — but a publisher that will read any
 * absolute path it is handed is a sharp edge worth not leaving lying around,
 * and confinement keeps a mistake in path construction from quietly shipping
 * the wrong file to a URL.
 */

export type LocalPathRejection =
  | { readonly kind: "missing-local-dir" }
  | { readonly kind: "escapes-local-dir"; readonly resolved: string }
  | { readonly kind: "empty" };

export type LocalPathResolution =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false; readonly rejection: LocalPathRejection };

/**
 * Resolve one `localPath` against the publish's `localDir`.
 *
 * Relative paths resolve inside the directory; an absolute path is accepted
 * only if it already points inside it. Containment is checked on the
 * normalized result, so `..` segments cannot walk out.
 *
 * Symlinks are NOT followed here — the caller does that against the real
 * filesystem before reading, because a link's target can change between the
 * check and the read and only the reader can close that gap.
 */
export function resolveArtifactLocalPath(input: {
  readonly localPath: string;
  readonly localDir: string | undefined;
}): LocalPathResolution {
  const localPath = input.localPath.trim();
  if (localPath.length === 0) return { ok: false, rejection: { kind: "empty" } };
  const localDir = input.localDir?.trim();
  if (localDir === undefined || localDir.length === 0) {
    return { ok: false, rejection: { kind: "missing-local-dir" } };
  }

  const rootAbsolute = NodePath.resolve(localDir);
  const resolved = NodePath.resolve(rootAbsolute, localPath);
  if (!isInside(rootAbsolute, resolved)) {
    return { ok: false, rejection: { kind: "escapes-local-dir", resolved } };
  }
  return { ok: true, absolutePath: resolved };
}

/**
 * Whether `candidate` is `root` or sits beneath it.
 *
 * Compares path segments rather than string prefixes: `/tmp/artifacts-evil` is
 * not inside `/tmp/artifacts`, though it does start with it.
 */
export function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = NodePath.resolve(root);
  const normalizedCandidate = NodePath.resolve(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  const relative = NodePath.relative(normalizedRoot, normalizedCandidate);
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

/** The error text shown when a path is refused. */
export function describeLocalPathRejection(
  localPath: string,
  rejection: LocalPathRejection,
): string {
  switch (rejection.kind) {
    case "empty":
      return "localPath is empty";
    case "missing-local-dir":
      return `'${localPath}' needs localDir set on the same publish call, naming the directory to read from`;
    case "escapes-local-dir":
      return `'${localPath}' resolves to '${rejection.resolved}', outside localDir`;
  }
}

/** How many bytes one file may contribute. Matches the inline base64 ceiling. */
export const MAX_LOCAL_FILE_BYTES = 21 * 1024 * 1024;
