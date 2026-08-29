import { isLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/preview";

interface PreviewUrlPresentationInput {
  readonly url: string;
  readonly environmentLabel: string;
  readonly environmentHttpBaseUrl: string;
}

export function formatPreviewUrl(input: PreviewUrlPresentationInput): string | null {
  try {
    const url = new URL(input.url);
    const environmentUrl = new URL(input.environmentHttpBaseUrl);
    if (url.origin === environmentUrl.origin && url.pathname.startsWith("/api/assets/")) {
      const encodedFileName = url.pathname.split("/").at(-1);
      if (!encodedFileName) {
        return null;
      }
      const fileName = decodeURIComponent(encodedFileName);
      if (!fileName || fileName === "." || fileName === "..") {
        return null;
      }
      return `${input.environmentLabel} · ${fileName}`;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    // A dev server is reached at the environment's own network address, because
    // that is the only address a viewer on another machine can dial. But that
    // address names the machine hosting the site, not the site — showing it
    // tells the person their tailnet IP when what they wanted to know is which
    // server they are looking at. The address they asked for says that, and
    // from the environment's side it is the same server.
    if (
      url.hostname === environmentUrl.hostname &&
      url.port !== environmentUrl.port &&
      isPrivateNetworkHost(url.hostname) &&
      !isLoopbackHost(url.hostname)
    ) {
      return url.port ? `localhost:${url.port}` : "localhost";
    }

    return url.host;
  } catch {
    return null;
  }
}
