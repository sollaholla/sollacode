// @effect-diagnostics nodeBuiltinImport:off - The never-remember list is a real file.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  PreviewAccountPrompt,
  PreviewAccountSession,
  PreviewCredentialSummary,
} from "@t3tools/contracts";

import {
  BrowserSignInPrompts,
  isPersonOnlySignInOrigin,
  type SignInPromptDependencies,
} from "./browserSignInPrompts.ts";

const SITE = "https://app.example.com";
const GOOGLE = "https://accounts.google.com";

let directory: string;
let clock: number;
let prompts: ReadonlyArray<PreviewAccountPrompt>;
let saved: Array<{ summary: PreviewCredentialSummary; secret: string }>;
let liveElsewhere: PreviewAccountSession | null;
let hasLive: boolean;
let kind: "project" | "agent";
let saveCredential: ReturnType<typeof vi.fn>;
let fillForPerson: ReturnType<typeof vi.fn>;
let linkAccount: ReturnType<typeof vi.fn>;

function summary(overrides: Partial<PreviewCredentialSummary>): PreviewCredentialSummary {
  return {
    id: "credential-1",
    label: "example.com",
    origin: SITE,
    username: "me@example.com",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  } as PreviewCredentialSummary;
}

function makePrompts(): BrowserSignInPrompts {
  let sequence = 0;
  const dependencies: SignInPromptDependencies = {
    listCredentials: async () => saved.map((entry) => entry.summary),
    listCredentialsForOrigin: async (origin) =>
      saved.filter((entry) => entry.summary.origin === origin).map((entry) => entry.summary),
    readSecret: async (id) => saved.find((entry) => entry.summary.id === id)?.secret ?? null,
    saveCredential: saveCredential as unknown as SignInPromptDependencies["saveCredential"],
    setPrompts: (_tabId, next) => {
      prompts = next;
    },
    fillForPerson: fillForPerson as unknown as SignInPromptDependencies["fillForPerson"],
    profileKindOf: () => kind,
    hasLiveAccount: () => hasLive,
    findLiveElsewhere: () => liveElsewhere,
    linkAccount: linkAccount as unknown as SignInPromptDependencies["linkAccount"],
    newestLiveIdentity: () => "resolved@example.com",
    neverListPath: NodePath.join(directory, "never.json"),
    newId: () => `prompt-${++sequence}`,
    nowMs: () => clock,
    onFailure: () => undefined,
  };
  return new BrowserSignInPrompts(dependencies);
}

const page = (origin: string, hasPasswordField: boolean) => ({
  webContentsId: 1,
  tabId: "tab",
  directory: "profile",
  origin,
  hasPasswordField,
});

const attempt = (overrides: { origin?: string; username?: string; password?: string } = {}) => ({
  webContentsId: 1,
  tabId: "tab",
  directory: "profile",
  origin: overrides.origin ?? SITE,
  username: overrides.username ?? "me@example.com",
  password: overrides.password ?? "hunter2",
});

beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sign-in-prompts-"));
  clock = 1_000;
  prompts = [];
  saved = [];
  liveElsewhere = null;
  hasLive = false;
  kind = "project";
  saveCredential = vi.fn(async () => undefined);
  fillForPerson = vi.fn(async () => undefined);
  linkAccount = vi.fn(async () => undefined);
});

afterEach(() => {
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("remember this?", () => {
  it("asks once the password box is gone, and never puts the password in the question", async () => {
    const subject = makePrompts();
    subject.noteAttempt(attempt());
    await subject.notePage(page(SITE, false));
    expect(prompts).toEqual([
      { id: "prompt-1", kind: "remember", origin: SITE, username: "me@example.com", update: false },
    ]);
    expect(JSON.stringify(prompts)).not.toContain("hunter2");
  });

  it("does not ask while the page still wants a password, as after a wrong one", async () => {
    const subject = makePrompts();
    subject.noteAttempt(attempt());
    await subject.notePage(page(SITE, true));
    expect(prompts).toEqual([]);
  });

  it("saves on yes, and only then", async () => {
    const subject = makePrompts();
    subject.noteAttempt(attempt());
    await subject.notePage(page(SITE, false));
    expect(saveCredential).not.toHaveBeenCalled();
    await subject.answer("prompt-1", "accept");
    expect(saveCredential).toHaveBeenCalledWith({
      label: "app.example.com",
      origin: SITE,
      username: "me@example.com",
      secret: "hunter2",
    });
    expect(prompts).toEqual([]);
  });

  it("drops the password on just this once", async () => {
    const subject = makePrompts();
    subject.noteAttempt(attempt());
    await subject.notePage(page(SITE, false));
    await subject.answer("prompt-1", "dismiss");
    await subject.answer("prompt-1", "accept");
    expect(saveCredential).not.toHaveBeenCalled();
  });

  it("stays quiet about a login already saved with this password", async () => {
    saved = [{ summary: summary({}), secret: "hunter2" }];
    const subject = makePrompts();
    subject.noteAttempt(attempt());
    await subject.notePage(page(SITE, false));
    expect(prompts).toEqual([]);
  });

  it("offers to update a saved login whose password changed", async () => {
    saved = [{ summary: summary({}), secret: "old-password" }];
    const subject = makePrompts();
    subject.noteAttempt(attempt());
    await subject.notePage(page(SITE, false));
    expect(prompts).toMatchObject([{ kind: "remember", update: true }]);
    await subject.answer("prompt-1", "accept");
    expect(saveCredential).toHaveBeenCalledWith(
      expect.objectContaining({ id: "credential-1", secret: "hunter2" }),
    );
  });

  it("remembers never for a site, across a restart", async () => {
    const subject = makePrompts();
    subject.noteAttempt(attempt());
    await subject.notePage(page(SITE, false));
    await subject.answer("prompt-1", "never-for-site");

    const restarted = makePrompts();
    restarted.noteAttempt(attempt());
    await restarted.notePage(page(SITE, false));
    expect(prompts).toEqual([]);
  });

  it("carries the name from an earlier step on the same site", async () => {
    const subject = makePrompts();
    subject.noteUsername(1, "https://login.example.com", "typed@example.com");
    subject.noteAttempt(attempt({ username: "" }));
    await subject.notePage(page(SITE, false));
    expect(prompts).toMatchObject([{ username: "typed@example.com" }]);
  });

  it("does not take a name from another site", async () => {
    const subject = makePrompts();
    subject.noteUsername(1, "https://other.test", "elsewhere@example.com");
    subject.noteAttempt(attempt({ username: "" }));
    await subject.notePage(page(SITE, false));
    expect(prompts).toEqual([]);
  });

  it("waits for Google's 2FA, then asks after leaving the sign-in host", async () => {
    const subject = makePrompts();
    subject.noteAttempt(attempt({ origin: GOOGLE }));
    await subject.notePage(page(GOOGLE, false));
    expect(prompts).toEqual([]);
    await subject.notePage(page("https://myaccount.google.com", false));
    expect(prompts).toMatchObject([{ kind: "remember", origin: GOOGLE }]);
  });

  it("gives up on a sign-in that never finished, so its password is not kept", async () => {
    const subject = makePrompts();
    subject.noteAttempt(attempt());
    clock += 6 * 60_000;
    await subject.notePage(page(SITE, false));
    expect(prompts).toEqual([]);
  });

  it("drops a question and its password when the tab closes", async () => {
    const subject = makePrompts();
    subject.noteAttempt(attempt());
    await subject.notePage(page(SITE, false));
    subject.forgetTab("tab");
    await subject.answer("prompt-1", "accept");
    expect(saveCredential).not.toHaveBeenCalled();
  });
});

describe("use an account from another project", () => {
  const elsewhere: PreviewAccountSession = {
    provider: "google",
    identity: "work@example.com",
    live: true,
    directory: "other-profile",
    owner: { environmentId: "env", kind: "project", ownerId: "project-b" },
    linked: false,
  };

  it("offers it on the provider's sign-in page and links on yes", async () => {
    liveElsewhere = elsewhere;
    const subject = makePrompts();
    await subject.notePage(page(GOOGLE, false));
    expect(prompts).toMatchObject([
      { kind: "use-account", provider: "google", identity: "work@example.com" },
    ]);
    await subject.answer("prompt-1", "accept");
    expect(linkAccount).toHaveBeenCalledWith("google", "other-profile", "profile");
  });

  it("does not offer it when already signed in here", async () => {
    liveElsewhere = elsewhere;
    hasLive = true;
    const subject = makePrompts();
    await subject.notePage(page(GOOGLE, false));
    expect(prompts).toEqual([]);
  });

  it("does not offer a person's account to an agent's profile", async () => {
    liveElsewhere = elsewhere;
    kind = "agent";
    const subject = makePrompts();
    await subject.notePage(page(GOOGLE, false));
    expect(prompts).toEqual([]);
  });

  it("does not raise it on the provider's ordinary pages", async () => {
    liveElsewhere = elsewhere;
    const subject = makePrompts();
    await subject.notePage(page("https://mail.google.com", false));
    expect(prompts).toEqual([]);
  });
});

describe("fill a saved password", () => {
  it("offers it on a password page and fills only on yes", async () => {
    saved = [{ summary: summary({}), secret: "hunter2" }];
    const subject = makePrompts();
    await subject.notePage(page(SITE, true));
    expect(prompts).toMatchObject([{ kind: "fill-saved", username: "me@example.com" }]);
    expect(fillForPerson).not.toHaveBeenCalled();
    await subject.answer("prompt-1", "accept");
    expect(fillForPerson).toHaveBeenCalledWith("tab", "hunter2");
  });

  it("does not offer a PIN as a password", async () => {
    saved = [{ summary: summary({ kind: "code" }), secret: "1234" }];
    const subject = makePrompts();
    await subject.notePage(page(SITE, true));
    expect(prompts).toEqual([]);
  });

  it("does not repeat the offer each time the page reports", async () => {
    saved = [{ summary: summary({}), secret: "hunter2" }];
    const subject = makePrompts();
    await subject.notePage(page(SITE, true));
    await subject.notePage(page(SITE, true));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.id).toBe("prompt-1");
  });
});

describe("isPersonOnlySignInOrigin", () => {
  it("covers Google's sign-in host and nothing else", () => {
    expect(isPersonOnlySignInOrigin(GOOGLE)).toBe(true);
    expect(isPersonOnlySignInOrigin("https://mail.google.com")).toBe(false);
    expect(isPersonOnlySignInOrigin(SITE)).toBe(false);
    expect(isPersonOnlySignInOrigin("not a url")).toBe(false);
  });
});
