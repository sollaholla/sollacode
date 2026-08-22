/**
 * Turning "open YouTube" into a URL, without letting speech reach the system.
 *
 * The orchestrator is talked to hands-free, and the obvious thing to ask of
 * something you are talking to is to put something on a screen — a video, a
 * repository, a map. It could not: every tool it had pointed inward at threads.
 *
 * The dangerous version of this feature is a tool that takes whatever the model
 * produces and hands it to the operating system. A transcriber that mishears a
 * product name will equally happily mishear a command, and "run that" is not a
 * mistake anyone can take back. So nothing here launches an application, runs a
 * command, or touches a file. The only capability is a web address, opened in
 * the browser the user already trusts — the same `shell.openExternal` path a
 * clicked link takes, which is allow-listed to http and https at the Electron
 * boundary and cannot express anything else.
 *
 * Sites are named, not typed. A catalog means the model never has to invent a
 * hostname, an invented hostname can never be opened, and — because names
 * arrive through a transcriber — "open you tube" resolves the same as
 * "YouTube". Anything not in the catalog goes to a search, which is what a
 * person means by "look up" anyway.
 */

import { soundsLike } from "./phonetics";
import { normalizeReference } from "./threadRouting";

export interface WebTarget {
  readonly id: string;
  /** How the user says it. First entry is how it is said back to them. */
  readonly names: ReadonlyArray<string>;
  readonly home: string;
  /**
   * Where a search goes, with `%s` for the encoded query. Absent when the site
   * has no search worth pointing at, in which case a query opens the home page
   * and the user is told the query was not used.
   */
  readonly search?: string;
}

/**
 * Deliberately short, and only sites where a URL means the same thing to
 * everyone. Nothing here needs an account to be useful, and nothing here
 * performs an action by being opened — a URL that changes something is not a
 * destination, it is a command with a different spelling.
 */
export const WEB_TARGETS: ReadonlyArray<WebTarget> = [
  {
    id: "youtube",
    names: ["YouTube", "you tube"],
    home: "https://www.youtube.com/",
    search: "https://www.youtube.com/results?search_query=%s",
  },
  {
    id: "google",
    names: ["Google"],
    home: "https://www.google.com/",
    search: "https://www.google.com/search?q=%s",
  },
  {
    id: "maps",
    names: ["Google Maps", "Maps"],
    home: "https://www.google.com/maps",
    search: "https://www.google.com/maps/search/%s",
  },
  {
    id: "github",
    names: ["GitHub"],
    home: "https://github.com/",
    search: "https://github.com/search?q=%s",
  },
  {
    id: "wikipedia",
    names: ["Wikipedia"],
    home: "https://en.wikipedia.org/",
    search: "https://en.wikipedia.org/w/index.php?search=%s",
  },
  {
    id: "stackoverflow",
    names: ["Stack Overflow"],
    home: "https://stackoverflow.com/",
    search: "https://stackoverflow.com/search?q=%s",
  },
  {
    id: "npm",
    names: ["npm", "npm registry"],
    home: "https://www.npmjs.com/",
    search: "https://www.npmjs.com/search?q=%s",
  },
  {
    id: "mdn",
    names: ["MDN", "MDN web docs"],
    home: "https://developer.mozilla.org/",
    search: "https://developer.mozilla.org/en-US/search?q=%s",
  },
  {
    id: "spotify",
    names: ["Spotify"],
    home: "https://open.spotify.com/",
    search: "https://open.spotify.com/search/%s",
  },
  {
    id: "gmail",
    names: ["Gmail", "Google Mail"],
    home: "https://mail.google.com/",
  },
  {
    id: "calendar",
    names: ["Google Calendar", "Calendar"],
    home: "https://calendar.google.com/",
  },
  {
    id: "drive",
    names: ["Google Drive", "Drive"],
    home: "https://drive.google.com/",
  },
];

export type WebTargetResolution =
  | { readonly kind: "resolved"; readonly target: WebTarget; readonly url: string }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<WebTarget> }
  | { readonly kind: "not-found"; readonly known: ReadonlyArray<string> };

/**
 * Finds the site the user named, and the address to open.
 *
 * Matched exactly first, then by sound — "you tube", "u tube" and "YouTube" are
 * one request said three ways, and only one of them is spelled the way the site
 * is. Ambiguity is reported rather than guessed at: opening the wrong thing is
 * cheap to undo but reads as not having been listened to.
 */
export function resolveWebTarget(
  spoken: string,
  query?: string,
  targets: ReadonlyArray<WebTarget> = WEB_TARGETS,
): WebTargetResolution {
  const trimmed = spoken.trim();
  const known = targets.map((target) => target.names[0] ?? target.id);
  if (trimmed.length === 0) return { kind: "not-found", known };

  const normalized = normalizeReference(trimmed);
  const exact = targets.filter((target) =>
    target.names.some((name) => normalizeReference(name) === normalized),
  );
  const matched =
    exact.length > 0
      ? exact
      : targets.filter((target) => target.names.some((name) => soundsLike(trimmed, name)));

  const first = matched[0];
  if (first === undefined) return { kind: "not-found", known };
  if (matched.length > 1) return { kind: "ambiguous", candidates: matched };
  return { kind: "resolved", target: first, url: urlFor(first, query) };
}

/**
 * The address for a target, with a query folded in where the site supports one.
 *
 * `encodeURIComponent` rather than a looser escape: the query is transcribed
 * speech, so it can contain anything, and the one thing it must never do is
 * change the shape of the URL it lands in.
 */
export function urlFor(target: WebTarget, query?: string): string {
  const trimmed = query?.trim() ?? "";
  if (trimmed.length === 0 || target.search === undefined) return target.home;
  return target.search.replace("%s", encodeURIComponent(trimmed));
}

/**
 * Whether a site can act on a spoken query, as opposed to only opening.
 *
 * Used to tell the user their words were dropped rather than silently opening a
 * home page and letting them wonder why nothing was searched.
 */
export function supportsQuery(target: WebTarget): boolean {
  return target.search !== undefined;
}
