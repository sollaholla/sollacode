import { isPublicWebPreviewUrl } from "@t3tools/shared/preview";
import { EnvironmentId, ThreadArtifactId, ThreadId } from "@t3tools/contracts";

/** Read a portable artifact route without navigating to another copy of the app. */
export function resolveThreadArtifactLink(url: string, knownEnvironmentIds: Iterable<string>) {
  try {
    // This base only parses root-relative routes; content uses the registered host.
    const parsed = new URL(url, "https://artifact-link.invalid");
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
    if (!url.startsWith("/") && !/^https?:\/\//i.test(url)) return null;
    const segments = parsed.pathname.split("/");
    if (segments.length !== 3 || parsed.searchParams.getAll("artifact").length !== 1) return null;
    const environmentId = decodeURIComponent(segments[1]!);
    const threadId = decodeURIComponent(segments[2]!);
    const artifactId = parsed.searchParams.get("artifact")!;
    if (
      [environmentId, threadId, artifactId].some(
        (id) =>
          id.length === 0 ||
          id.length > 128 ||
          id.trim() !== id ||
          [...id].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ),
      )
    )
      return null;
    // Stable host identity works across LAN, loopback and tunnel aliases. Unknown
    // environments keep ordinary link behavior; a link never registers a host.
    if (![...knownEnvironmentIds].includes(environmentId)) return null;
    return {
      environmentId: EnvironmentId.make(environmentId),
      threadId: ThreadId.make(threadId),
      artifactId: ThreadArtifactId.make(artifactId),
    };
  } catch {
    return null;
  }
}

/** Host-network links must be loaded by the environment, not a remote viewer's device. */
export function shouldOpenUrlInHostPreview(url: string, isRemoteClient: boolean): boolean {
  if (!isRemoteClient) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") && !isPublicWebPreviewUrl(url)
    );
  } catch {
    return false;
  }
}

/** A failed host open stays a failure; opening the same URL locally cannot recover it. */
export async function openThreadUrl(input: {
  readonly url: string;
  readonly isRemoteClient: boolean;
  readonly openInPreview: (url: string) => Promise<void>;
  readonly openExternally: (url: string) => Promise<void>;
}): Promise<void> {
  if (shouldOpenUrlInHostPreview(input.url, input.isRemoteClient)) {
    await input.openInPreview(input.url);
  } else {
    await input.openExternally(input.url);
  }
}
