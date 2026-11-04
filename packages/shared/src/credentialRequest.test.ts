import { describe, expect, it } from "vite-plus/test";

import {
  CREDENTIAL_DECLINE_CHOICE,
  CREDENTIAL_REQUEST_QUESTION_ID,
  CREDENTIAL_SIGNED_IN_CHOICE,
  credentialProvidedAnswers,
  credentialRequestAnswerFromUnknown,
  isPersonOnlySignInOrigin,
  parseCredentialRequest,
} from "./credentialRequest.ts";

describe("parseCredentialRequest", () => {
  it("reads a request off an activity payload", () => {
    expect(
      parseCredentialRequest({
        requestId: "credential-request:1",
        credentialRequest: {
          origin: "https://app.example.com",
          mode: "code",
          reason: "Acme wants a code",
        },
      }),
    ).toEqual({ origin: "https://app.example.com", mode: "code", reason: "Acme wants a code" });
  });

  it("ignores payloads that are not one", () => {
    expect(parseCredentialRequest(null)).toBeNull();
    expect(parseCredentialRequest({ questions: [] })).toBeNull();
    expect(
      parseCredentialRequest({
        credentialRequest: { origin: "https://example.com", mode: "other", reason: "x" },
      }),
    ).toBeNull();
  });
});

describe("credentialRequestAnswerFromUnknown", () => {
  const answer = (value: string) => ({ [CREDENTIAL_REQUEST_QUESTION_ID]: value });

  it("reads a provided login as its id alone", () => {
    expect(
      credentialRequestAnswerFromUnknown(
        credentialProvidedAnswers({ credentialId: "id-1", saved: true }),
      ),
    ).toEqual({ status: "provided", credentialId: "id-1", saved: true });
    expect(
      credentialRequestAnswerFromUnknown(
        credentialProvidedAnswers({ credentialId: "id-2", saved: false }),
      ),
    ).toEqual({ status: "provided", credentialId: "id-2", saved: false });
  });

  it("tells the choices and a typed reply apart", () => {
    expect(credentialRequestAnswerFromUnknown(answer(CREDENTIAL_DECLINE_CHOICE))).toEqual({
      status: "declined",
    });
    expect(credentialRequestAnswerFromUnknown(answer(CREDENTIAL_SIGNED_IN_CHOICE))).toEqual({
      status: "signed_in",
    });
    expect(credentialRequestAnswerFromUnknown(answer("use the other account"))).toEqual({
      status: "feedback",
      feedback: "use the other account",
    });
    expect(credentialRequestAnswerFromUnknown({})).toEqual({ status: "declined" });
  });
});

describe("isPersonOnlySignInOrigin", () => {
  it("covers only Google's sign-in host", () => {
    expect(isPersonOnlySignInOrigin("https://accounts.google.com/signin")).toBe(true);
    expect(isPersonOnlySignInOrigin("https://mail.google.com")).toBe(false);
    expect(isPersonOnlySignInOrigin("https://accounts.google.com.example.com")).toBe(false);
    expect(isPersonOnlySignInOrigin("not a url")).toBe(false);
  });
});
