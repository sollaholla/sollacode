import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeProviderSlashCommand,
  findLeadingProviderSlashCommand,
} from "./providerSlashCommands";

const COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "compact", description: "Clear history but keep a summary in context" },
  { name: "review", input: { hint: "<focus>" } },
  { name: "frontend:design" },
  { name: "plan", description: "A provider command that shares Solla's name" },
];

describe("findLeadingProviderSlashCommand", () => {
  it("finds a known command that opens the message, alone or with text after it", () => {
    expect(findLeadingProviderSlashCommand("/compact", COMMANDS)).toMatchObject({
      command: { name: "compact" },
      start: 0,
      end: 8,
    });
    expect(
      findLeadingProviderSlashCommand("/review focus on the auth flow", COMMANDS),
    ).toMatchObject({ command: { name: "review" }, start: 0, end: 7 });
    expect(findLeadingProviderSlashCommand("  /compact\nthen continue", COMMANDS)).toMatchObject({
      start: 2,
      end: 10,
    });
    expect(findLeadingProviderSlashCommand("/frontend:design", COMMANDS)?.command.name).toBe(
      "frontend:design",
    );
  });

  it("ignores a command the provider only receives as text", () => {
    // A provider runs a command only when the message starts with it.
    expect(findLeadingProviderSlashCommand("please /compact now", COMMANDS)).toBeNull();
    expect(findLeadingProviderSlashCommand("hello\n/compact", COMMANDS)).toBeNull();
    expect(findLeadingProviderSlashCommand("/compacting", COMMANDS)).toBeNull();
    expect(findLeadingProviderSlashCommand("/unknown thing", COMMANDS)).toBeNull();
    expect(findLeadingProviderSlashCommand("/usr/bin/env", COMMANDS)).toBeNull();
    expect(findLeadingProviderSlashCommand("/compact", [])).toBeNull();
  });

  it("never marks a command Solla handles itself", () => {
    expect(findLeadingProviderSlashCommand("/plan", COMMANDS)).toBeNull();
  });

  it("describes a command in the provider's words, with a fallback", () => {
    expect(describeProviderSlashCommand(COMMANDS[0]!)).toBe(
      "Clear history but keep a summary in context",
    );
    expect(describeProviderSlashCommand(COMMANDS[1]!)).toBe("Runs a command in the provider.");
  });
});
