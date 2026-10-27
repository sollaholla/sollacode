import { getPairingTokenFromUrl } from "../../pairingUrl";

/** Accept a copied link without sending its secret to a different host. */
export function parsePairingCredential(value: string, currentUrl: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Paste a connection link or pairing code to continue.");
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed;

  let link: URL;
  try {
    link = new URL(trimmed);
  } catch {
    throw new Error("This connection link is incomplete. Copy a new link from your computer.");
  }
  if (!(["http:", "https:"] as ReadonlyArray<string>).includes(link.protocol)) {
    throw new Error("Use an http or https connection link from Solla Code.");
  }
  if (link.origin !== new URL(currentUrl).origin) {
    throw new Error(
      "This link is for another computer. Open the full link in your browser to connect to that computer.",
    );
  }
  const token = getPairingTokenFromUrl(link);
  if (!token)
    throw new Error(
      "This link has no pairing code. Create a new connection link on your computer.",
    );
  return token;
}
