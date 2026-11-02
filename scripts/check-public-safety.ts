// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A short script run from git hooks, before anything is installed in CI.
/**
 * This repository is public, and agents working in it read real project names,
 * machine names and paths all day. This keeps those from landing here.
 *
 *   --staged    what is about to be committed (pre-commit hook)
 *   --pre-push  every outgoing commit: added lines, paths, message and author
 *   --tree      every tracked file (CI and the release gate)
 *   --hash <t>  prints the entry for a new word to add to public-safety-terms.ts
 *
 * Three sources of words: hashes in `public-safety-terms.ts`, so that the list
 * does not publish what it protects; on a person's machine, its user name and
 * the folder names of the projects in its Solla Code data, so a new project is
 * covered the day it is added; and patterns for tailnet addresses, real email
 * addresses and credentials.
 *
 * A generic word that a local project happens to be named after can be allowed
 * with PUBLIC_SAFETY_ALLOW="word,word". Images are not read.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { PUBLIC_SAFETY_TERM_HASHES } from "./public-safety-terms.ts";

const HASH_SALT = "solla-public-safety-v1";
const MAX_WORDS_IN_TERM = 5;
const MIN_LOCAL_TERM_LENGTH = 5;
const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;
const EMAIL_DOMAINS_ALLOWED = new Set([
  "anthropic.com",
  "example.com",
  "example.net",
  "example.org",
  "github.com",
  "users.noreply.github.com",
]);
/** Service and placeholder users, which name no one. */
const EMAIL_LOCAL_PARTS_ALLOWED = new Set([
  "deploy",
  "git",
  "gitlab",
  "me",
  "no-reply",
  "noreply",
  "test",
  "user",
]);
/** Folder names too common to mean anything, and this project's own. */
const LOCAL_WORDS_IGNORED = new Set([
  "admin",
  "code",
  "desktop",
  "documents",
  "projects",
  "solla",
  "t3code",
  "t3fork",
  "users",
]);

const ATTRIBUTION_TRAILER = /^(?:co-authored-by|signed-off-by|reviewed-by|reported-by):/iu;
const TAILNET_ADDRESS = /\.tail[0-9a-f]{6}\.ts\.net/iu;
const EMAIL_ADDRESS = /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/giu;
const CREDENTIALS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a GitHub token", /\b(?:ghp|gho|ghs)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/u],
  ["an API key", /\bsk-(?:ant|proj|live)-[A-Za-z0-9_-]{16,}/u],
  ["a Slack token", /\bxox[abps]-[0-9A-Za-z-]{10,}/u],
  ["an AWS key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["a Stripe account", /\bacct_1[A-Za-z0-9]{15,}\b/u],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
];

const hashesByTerm = new Map<string, string>();

/** Cached: the same few thousand words make up nearly every line of a codebase. */
export const hashTerm = (term: string): string => {
  const known = hashesByTerm.get(term);
  if (known !== undefined) return known;
  const hash = NodeCrypto.createHash("sha256")
    .update(`${HASH_SALT}:${normalizeTerm(term)}`)
    .digest("hex")
    .slice(0, 20);
  hashesByTerm.set(term, hash);
  return hash;
};

export const normalizeTerm = (term: string): string =>
  term.toLowerCase().replace(/[^a-z0-9]+/gu, "");

/**
 * Every way a line could spell a term: each identifier as written, and runs of
 * neighbouring words joined, so "Some Project", "some-project", "SomeProject"
 * and "someProjectTests" all offer "someproject".
 */
export function termCandidates(line: string): ReadonlySet<string> {
  const candidates = new Set<string>();
  const words: Array<string> = [];
  for (const token of line.match(/[A-Za-z0-9]+/gu) ?? []) {
    candidates.add(token.toLowerCase());
    words.push(
      ...(token.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+[a-z]*/gu) ?? [token]).map((word) =>
        word.toLowerCase(),
      ),
    );
  }
  for (let start = 0; start < words.length; start += 1) {
    let joined = "";
    for (let size = 0; size < MAX_WORDS_IN_TERM && start + size < words.length; size += 1) {
      joined += words[start + size];
      candidates.add(joined);
    }
  }
  return candidates;
}

export interface SafetyRules {
  readonly termHashes: ReadonlySet<string>;
  readonly localTerms: ReadonlySet<string>;
  /** Credentials and email addresses: for new text, since old fixtures may hold fakes. */
  readonly checkNewTextPatterns: boolean;
}

/** Remote URLs, URL logins and package patches share an address's shape. */
function looksLikeRealEmail(match: RegExpMatchArray, line: string): boolean {
  const address = match[0].toLowerCase();
  const domain = match[1]?.toLowerCase() ?? "";
  const localPart = address.slice(0, address.indexOf("@"));
  const before = line[(match.index ?? 0) - 1];
  if (
    EMAIL_DOMAINS_ALLOWED.has(domain) ||
    /\.(?:example\.[a-z]+|test|patch|local)$/u.test(domain)
  ) {
    return false;
  }
  return !EMAIL_LOCAL_PARTS_ALLOWED.has(localPart) && before !== ":" && before !== "/";
}

/** Why a line must not be published, or null. Never includes the line itself. */
export function findProblem(line: string, rules: SafetyRules): string | null {
  if (TAILNET_ADDRESS.test(line)) return "a real tailnet address";
  if (rules.checkNewTextPatterns) {
    for (const [name, pattern] of CREDENTIALS) {
      if (pattern.test(line)) return name;
    }
    for (const match of line.matchAll(EMAIL_ADDRESS)) {
      if (looksLikeRealEmail(match, line)) return "a real email address";
    }
  }
  for (const candidate of termCandidates(line)) {
    if (rules.localTerms.has(candidate)) return "a name from this computer";
    if (rules.termHashes.has(hashTerm(candidate))) return "a name on the private list";
  }
  return null;
}

const git = (...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Each added line of a unified diff, with the file it went into. */
export function addedLines(
  diff: string,
): ReadonlyArray<{ readonly file: string; readonly text: string }> {
  const added: Array<{ file: string; text: string }> = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.replace(/^\+\+\+ (?:b\/)?/u, "");
      added.push({ file, text: file });
    } else if (line.startsWith("+")) {
      added.push({ file, text: line.slice(1) });
    }
  }
  return added;
}

/** A computer's own names. Nothing here is written anywhere; CI has none. */
function readLocalTerms(): ReadonlySet<string> {
  const terms = new Set<string>();
  const allowed = new Set(
    (process.env.PUBLIC_SAFETY_ALLOW ?? "").split(",").map(normalizeTerm).filter(Boolean),
  );
  const add = (name: string) => {
    const term = normalizeTerm(name);
    if (
      term.length >= MIN_LOCAL_TERM_LENGTH &&
      !LOCAL_WORDS_IGNORED.has(term) &&
      !allowed.has(term)
    ) {
      terms.add(term);
    }
  };
  if (process.env.CI) return terms;
  add(NodeOS.userInfo().username);
  const database = NodePath.join(NodeOS.homedir(), ".solla-code", "userdata", "state.sqlite");
  if (!NodeFS.existsSync(database)) return terms;
  try {
    const connection = new NodeSqlite.DatabaseSync(database, { readOnly: true });
    try {
      const rows = connection
        .prepare("SELECT workspace_root AS root FROM projection_projects")
        .all();
      for (const { root } of rows) {
        // App plumbing, not a person's project.
        if (
          typeof root !== "string" ||
          root.includes(".solla-code") ||
          root.endsWith(NodePath.basename(process.cwd()))
        ) {
          continue;
        }
        add(root.split(/[\\/]/u).pop() ?? "");
      }
    } finally {
      connection.close();
    }
  } catch {
    // The hash list and patterns still apply.
  }
  return terms;
}

function scanCommit(commit: string, rules: SafetyRules, problems: Array<string>): void {
  const short = commit.slice(0, 10);
  // A contributor's address is theirs to publish, so names and hashes are all
  // that apply to authors and trailers: an address only stands out in prose.
  const details = git("log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", commit);
  details.split("\n").forEach((line, index) => {
    const attribution = index < 2 || ATTRIBUTION_TRAILER.test(line);
    const problem = findProblem(
      line,
      attribution ? { ...rules, checkNewTextPatterns: false } : rules,
    );
    if (problem !== null) problems.push(`${short} message or author: ${problem}`);
  });
  const diff = git(
    "log",
    "-1",
    "-p",
    "-m",
    "--first-parent",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--format=",
    commit,
  );
  for (const { file, text } of addedLines(diff)) {
    const problem = findProblem(text, rules);
    if (problem !== null) problems.push(`${short} ${file}: ${problem}`);
  }
}

function readPushedCommits(): ReadonlyArray<string> {
  const commits = new Set<string>();
  for (const line of NodeFS.readFileSync(0, "utf8").split("\n")) {
    const local = line.trim().split(/\s+/u)[1];
    if (!local || /^0+$/u.test(local)) continue;
    // A tag or branch ref is judged by its commits; anything on a remote is already public.
    for (const commit of git("rev-list", local, "--not", "--remotes").split("\n")) {
      if (commit) commits.add(commit);
    }
  }
  return [...commits];
}

function scanTree(rules: SafetyRules, problems: Array<string>): void {
  for (const file of git("ls-files", "-z").split("\0")) {
    // Other projects' code, vendored for reference.
    if (!file || file.startsWith(".repos/")) continue;
    const pathProblem = findProblem(file, rules);
    if (pathProblem !== null) problems.push(`${file}: ${pathProblem}`);
    let stats: NodeFS.Stats;
    try {
      stats = NodeFS.lstatSync(file);
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.size > MAX_SCANNED_FILE_BYTES) continue;
    const content = NodeFS.readFileSync(file);
    if (content.includes(0)) continue;
    content
      .toString("utf8")
      .split("\n")
      .forEach((line, index) => {
        const problem = findProblem(line, rules);
        if (problem !== null) problems.push(`${file}:${index + 1}: ${problem}`);
      });
  }
}

function main(): void {
  const [mode, argument] = process.argv.slice(2);
  if (mode === "--hash" && argument) {
    console.log(`  "${hashTerm(argument)}",`);
    return;
  }
  const baseRules = {
    termHashes: new Set(PUBLIC_SAFETY_TERM_HASHES),
    localTerms: readLocalTerms(),
  };
  const problems: Array<string> = [];
  if (mode === "--staged") {
    const diff = git(
      "diff",
      "--cached",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--diff-filter=ACMR",
    );
    for (const { file, text } of addedLines(diff)) {
      const problem = findProblem(text, { ...baseRules, checkNewTextPatterns: true });
      if (problem !== null) problems.push(`${file}: ${problem}`);
    }
  } else if (mode === "--pre-push") {
    for (const commit of readPushedCommits()) {
      scanCommit(commit, { ...baseRules, checkNewTextPatterns: true }, problems);
    }
  } else if (mode === "--tree") {
    scanTree({ ...baseRules, checkNewTextPatterns: false }, problems);
  } else {
    console.error("Usage: check-public-safety.ts --staged | --pre-push | --tree | --hash <word>");
    process.exitCode = 2;
    return;
  }
  if (problems.length === 0) return;
  console.error("This repository is public, and this would publish something private:\n");
  for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
  if (problems.length > 40) console.error(`  ...and ${problems.length - 40} more`);
  console.error(
    "\nUse a made-up name instead: `Studio Mac`, `/Users/me`, `work@example.com`. To see a line, search the file; it is not printed here so that CI logs stay clean.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === import.meta.filename) main();
