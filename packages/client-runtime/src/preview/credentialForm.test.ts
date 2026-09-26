import type { PreviewCredentialSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  credentialErrorMessage,
  credentialKindOf,
  credentialOriginFromInput,
  credentialSaveInput,
  initialCredentialDraft,
  sortCredentials,
  upsertCredential,
} from "./credentialForm.ts";

const saved: PreviewCredentialSummary = {
  id: "cred-1",
  label: "Work GitHub",
  origin: "https://github.com",
  username: "me@example.com",
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
};

describe("credentialForm", () => {
  it("reads what people type as the site's origin", () => {
    expect(credentialOriginFromInput("github.com")).toBe("https://github.com");
    expect(credentialOriginFromInput(" https://accounts.example.com/login?x=1 ")).toBe(
      "https://accounts.example.com",
    );
    expect(credentialOriginFromInput("http://localhost:5173/app")).toBe("http://localhost:5173");
    expect(credentialOriginFromInput("")).toBeNull();
    expect(credentialOriginFromInput("about:blank")).toBeNull();
    expect(credentialOriginFromInput("file:///etc/passwd")).toBeNull();
  });

  it("requires a password to add but not to edit", () => {
    const add = { kind: "add" } as const;
    const draft = initialCredentialDraft(add);
    expect(draft.kind).toBe("password");
    expect(
      credentialSaveInput(add, { ...draft, label: " Work ", origin: "github.com" }),
    ).toBeNull();
    expect(
      credentialSaveInput(add, {
        ...draft,
        label: " Work ",
        origin: "github.com",
        username: "  ",
        secret: "hunter2",
      }),
    ).toEqual({
      label: "Work",
      origin: "https://github.com",
      kind: "password",
      secret: "hunter2",
    });
    expect(credentialSaveInput(add, { ...draft, origin: "github.com", secret: "x" })).toBeNull();
    expect(
      credentialSaveInput(add, { ...draft, label: "Work", origin: "not a url", secret: "x" }),
    ).toBeNull();

    const edit = { kind: "edit", credential: saved } as const;
    const editDraft = initialCredentialDraft(edit);
    expect(editDraft.secret).toBe("");
    // A blank password on edit is omitted entirely, which keeps the saved one.
    expect(credentialSaveInput(edit, { ...editDraft, label: "Home GitHub" })).toEqual({
      id: saved.id,
      label: "Home GitHub",
      origin: "https://github.com",
      kind: "password",
      username: "me@example.com",
    });
    expect(credentialSaveInput(edit, { ...editDraft, secret: "new" })?.secret).toBe("new");
  });

  it("saves a PIN or code without a username and keeps its secret on edit", () => {
    const add = { kind: "add" } as const;
    expect(
      credentialSaveInput(add, {
        kind: "code",
        label: "Rent PIN",
        origin: "https://pay.example.com",
        username: "left over from the password form",
        secret: "4821",
      }),
    ).toEqual({
      label: "Rent PIN",
      origin: "https://pay.example.com",
      kind: "code",
      secret: "4821",
    });

    // Entries saved before kinds existed are passwords, and can become a PIN.
    expect(credentialKindOf(saved)).toBe("password");
    const edit = { kind: "edit", credential: saved } as const;
    expect(credentialSaveInput(edit, { ...initialCredentialDraft(edit), kind: "code" })).toEqual({
      id: saved.id,
      label: "Work GitHub",
      origin: "https://github.com",
      kind: "code",
    });
    const pin = { ...saved, kind: "code" as const, username: undefined };
    expect(initialCredentialDraft({ kind: "edit", credential: pin }).kind).toBe("code");
  });

  it("prefills the tab's site when adding from the preview", () => {
    expect(initialCredentialDraft({ kind: "add", origin: "https://example.com" }).origin).toBe(
      "https://example.com",
    );
  });

  it("groups by site and replaces edited entries in place", () => {
    const other = { ...saved, id: "cred-2", origin: "https://a.com" };
    expect(sortCredentials([saved, other]).map((item) => item.id)).toEqual(["cred-2", "cred-1"]);
    const renamed = { ...saved, label: "Renamed" };
    expect(upsertCredential([saved, other], renamed)).toEqual([other, renamed]);
  });

  it("drops Electron's IPC prefix from error messages", () => {
    expect(
      credentialErrorMessage(
        new Error(
          "Error invoking remote method 'desktop:preview-credential-save': BrowserCredentialOriginError: Saved passwords require HTTPS.",
        ),
        "fallback",
      ),
    ).toBe("Saved passwords require HTTPS.");
    expect(credentialErrorMessage("nope", "fallback")).toBe("fallback");
  });
});
