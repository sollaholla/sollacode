import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProviderUsageDetails,
  providerUsageAccount,
  type ProviderUsageAccount,
} from "./ProviderUsageBar";

const provider = (auth: ServerProvider["auth"]): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth,
  checkedAt: "2026-09-10T13:04:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

describe("providerUsageAccount", () => {
  it("names the signed-in account", () => {
    expect(
      providerUsageAccount(
        provider({ status: "authenticated", email: "person@example.com", type: "Google account" }),
      ),
    ).toEqual({ email: "person@example.com", label: null, type: "Google account" });
  });

  it("drops a label that only repeats the email", () => {
    // The settings card makes the same call: one fact twice is not two facts.
    expect(
      providerUsageAccount(
        provider({
          status: "authenticated",
          email: "person@example.com",
          label: "person@example.com",
        }),
      ),
    ).toEqual({ email: "person@example.com", label: null, type: null });
  });

  it("keeps a label that says something the email does not", () => {
    expect(
      providerUsageAccount(
        provider({ status: "authenticated", email: "person@example.com", label: "Work plan" }),
      ),
    ).toEqual({ email: "person@example.com", label: "Work plan", type: null });
  });

  it("returns nothing when the provider is not authenticated", () => {
    // A blurred placeholder over an empty string reads as hidden information
    // that does not exist.
    expect(providerUsageAccount(provider({ status: "unauthenticated" }))).toBeNull();
    expect(providerUsageAccount(provider({ status: "unknown" }))).toBeNull();
  });

  it("returns nothing when an authenticated provider reports no identity", () => {
    expect(providerUsageAccount(provider({ status: "authenticated" }))).toBeNull();
  });
});

describe("ProviderUsageDetails account line", () => {
  const markup = (account: ProviderUsageAccount | null) =>
    renderToStaticMarkup(
      <ProviderUsageDetails
        name="Codex"
        state="available"
        windows={[]}
        reportedAt="2026-09-10T13:04:00.000Z"
        account={account}
      />,
    );

  it("never puts the raw account in the DOM before it is revealed", () => {
    // Blurring in CSS still ships the address to anyone who opens devtools or
    // reads a screen recording frame by frame. The redacted control renders a
    // stand-in string instead, so the real one is not there to find.
    const rendered = markup({ email: "person@example.com", label: null, type: "Google account" });
    expect(rendered).not.toContain("person@example.com");
    expect(rendered).toContain("blur-[2px]");
    expect(rendered).toContain("Google account");
    expect(rendered).toContain("Codex account");
  });

  it("renders no account row when there is no account to name", () => {
    expect(markup(null)).not.toContain("blur-[2px]");
  });

  it("shows a credential kind on its own when that is all the provider reports", () => {
    const rendered = markup({ email: null, label: null, type: "DeepSeek API key" });
    expect(rendered).toContain("DeepSeek API key");
    expect(rendered).not.toContain("· DeepSeek API key");
  });
});
