import type { PreviewAccountEvent, PreviewAccountSession } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ACCOUNT_EVENT_CAUSE_ACCOUNTS_PAGE,
  ACCOUNT_EVENT_CAUSE_LINKED,
  accountEventSentence,
  accountSignInUrl,
  isUnexpectedSignOut,
  summarizeAccounts,
} from "./accountSummary.ts";

const session = (overrides: Partial<PreviewAccountSession>): PreviewAccountSession => ({
  provider: "google",
  identity: "work@example.com",
  live: true,
  directory: "profile-a",
  owner: { environmentId: "env", kind: "project", ownerId: "project-a" },
  linked: false,
  ...overrides,
});

const event = (overrides: Partial<PreviewAccountEvent>): PreviewAccountEvent => ({
  at: "2026-11-01T00:00:00.000Z",
  provider: "google",
  reason: "signed-out",
  identity: "work@example.com",
  directory: "profile-a",
  owner: { environmentId: "env", kind: "project", ownerId: "project-a" },
  ...overrides,
});

describe("summarizeAccounts", () => {
  it("collects one account's profiles and calls it live if any profile is", () => {
    const [account] = summarizeAccounts([
      session({ directory: "a", live: false }),
      session({ directory: "b", live: true }),
    ]);
    expect(account?.live).toBe(true);
    expect(account?.profiles.map((profile) => profile.directory)).toEqual(["a", "b"]);
  });

  it("puts live accounts first, then sorts by name", () => {
    expect(
      summarizeAccounts([
        session({ identity: "old@example.com", live: false }),
        session({ identity: "zed@example.com" }),
        session({ identity: "amy@example.com" }),
      ]).map((account) => account.identity),
    ).toEqual(["amy@example.com", "zed@example.com", "old@example.com"]);
  });

  it("keeps the same name on two providers apart", () => {
    expect(
      summarizeAccounts([session({ provider: "google" }), session({ provider: "github" })]),
    ).toHaveLength(2);
  });
});

describe("accountSignInUrl", () => {
  it("takes Google's chooser straight to the account", () => {
    expect(accountSignInUrl("google", "a+b@example.com")).toBe(
      "https://accounts.google.com/AccountChooser?Email=a%2Bb%40example.com",
    );
    expect(accountSignInUrl("google", null)).toBe("https://accounts.google.com/");
  });
});

describe("isUnexpectedSignOut", () => {
  it("is quiet about a sign-in, the person's own sign-out, and a linked one", () => {
    expect(isUnexpectedSignOut(event({ reason: "signed-in" }))).toBe(false);
    expect(isUnexpectedSignOut(event({ cookieCause: ACCOUNT_EVENT_CAUSE_ACCOUNTS_PAGE }))).toBe(
      false,
    );
    expect(isUnexpectedSignOut(event({ cookieCause: ACCOUNT_EVENT_CAUSE_LINKED }))).toBe(false);
  });

  it("speaks up when the site or the browser did it", () => {
    expect(isUnexpectedSignOut(event({ cookieCause: "explicit" }))).toBe(true);
    expect(isUnexpectedSignOut(event({ reason: "session-ended" }))).toBe(true);
  });
});

describe("accountEventSentence", () => {
  const label = () => "t3-fork";

  it("says who ended it and where", () => {
    expect(accountEventSentence(event({ reason: "session-ended" }), label)).toBe(
      "Google ended the session for work@example.com in t3-fork.",
    );
    expect(accountEventSentence(event({ cookieCause: "expired" }), label)).toBe(
      "work@example.com expired in t3-fork.",
    );
    expect(accountEventSentence(event({ cookieCause: "explicit" }), label)).toBe(
      "Google signed out work@example.com in t3-fork.",
    );
  });

  it("names an account the site does not identify by its provider", () => {
    expect(
      accountEventSentence(
        event({ provider: "apple", identity: null, reason: "signed-in", owner: null }),
        label,
      ),
    ).toBe("Signed in to your Apple account.");
  });
});
