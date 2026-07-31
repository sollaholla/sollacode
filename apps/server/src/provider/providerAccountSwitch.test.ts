import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import { expect } from "vite-plus/test";

import { providerAccountSwitchInternals } from "./providerAccountSwitch.ts";

describe("provider account switch", () => {
  it("extracts a provider authentication URL from streamed console output", () => {
    expect(
      providerAccountSwitchInternals.extractAuthUrl(
        "Complete login in your browser:\nhttps://auth.openai.com/oauth/authorize?state=abc\n",
      ),
    ).toBe("https://auth.openai.com/oauth/authorize?state=abc");
  });

  it("falls back to a local login URL and trims console punctuation", () => {
    expect(
      providerAccountSwitchInternals.extractAuthUrl(
        "If the browser did not open, visit http://localhost:1455/login).",
      ),
    ).toBe("http://localhost:1455/login");
  });

  it("detects Claude Code's browser authentication-code prompt", () => {
    expect(
      providerAccountSwitchInternals.hasManualAuthCodePrompt(
        "\u001b[2mPaste the authentication code from your browser here:\u001b[0m",
      ),
    ).toBe(true);
    expect(
      providerAccountSwitchInternals.hasManualAuthCodePrompt("Paste code here if prompted >"),
    ).toBe(true);
  });

  it("does not mistake OAuth URL parameters for a manual code prompt", () => {
    expect(
      providerAccountSwitchInternals.hasManualAuthCodePrompt(
        "Opening https://claude.ai/oauth/authorize?code_challenge=abc123 in your browser.",
      ),
    ).toBe(false);
  });

  it.effect("writes the pasted code and one submit newline to the provider process", () =>
    Effect.gen(function* () {
      const chunks: Uint8Array[] = [];
      const stdin = Sink.forEach((chunk: Uint8Array) =>
        Effect.sync(() => {
          chunks.push(chunk);
        }),
      );

      yield* providerAccountSwitchInternals.writeAuthCodeToStdin("browser-code#state", stdin);

      expect(chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")).toBe(
        "browser-code#state\n",
      );
    }),
  );
});
