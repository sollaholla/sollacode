import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import {
  DEFAULT_GIT_INIT_INSTRUCTIONS,
  buildGitInitPrompt,
  canRunAssistedGitInit,
  canRunPlainGitInit,
} from "./gitInitPrompt.ts";

describe("gitInitPrompt", () => {
  it("names the target directory so the repo lands in the right place", () => {
    const prompt = buildGitInitPrompt({
      cwd: "/Users/me/projects/thing",
      instructions: DEFAULT_GIT_INIT_INSTRUCTIONS,
      alreadyInitialized: false,
    });
    NodeAssert.ok(prompt.includes("/Users/me/projects/thing"));
    NodeAssert.ok(prompt.startsWith("Initialize a Git repository at"));
  });

  it("tells the provider when the repo already exists", () => {
    const prompt = buildGitInitPrompt({
      cwd: "/tmp/thing",
      instructions: "do the thing",
      alreadyInitialized: true,
    });
    NodeAssert.ok(prompt.includes("has just been initialized"));
    NodeAssert.ok(!prompt.includes("Initialize a Git repository at"));
    NodeAssert.ok(prompt.endsWith("do the thing"));
  });

  it("trims the instructions without dropping their content", () => {
    const prompt = buildGitInitPrompt({
      cwd: "/tmp/thing",
      instructions: "   write a gitignore   ",
      alreadyInitialized: false,
    });
    NodeAssert.ok(prompt.endsWith("write a gitignore"));
  });

  it("keeps the default instructions specific to the project", () => {
    // A generic template is the failure mode this prompt exists to prevent.
    NodeAssert.ok(DEFAULT_GIT_INIT_INSTRUCTIONS.includes(".gitignore"));
    NodeAssert.ok(DEFAULT_GIT_INIT_INSTRUCTIONS.includes("every folder inside it"));
    NodeAssert.ok(DEFAULT_GIT_INIT_INSTRUCTIONS.includes("not paste a generic template"));
  });

  it("blocks the assisted run without a directory, instructions, or while busy", () => {
    const base = { cwd: "/tmp/thing", instructions: "do it", busy: false };
    NodeAssert.equal(canRunAssistedGitInit(base), true);
    NodeAssert.equal(canRunAssistedGitInit({ ...base, cwd: null }), false);
    NodeAssert.equal(canRunAssistedGitInit({ ...base, cwd: "" }), false);
    NodeAssert.equal(canRunAssistedGitInit({ ...base, instructions: "   " }), false);
    NodeAssert.equal(canRunAssistedGitInit({ ...base, busy: true }), false);
  });

  it("lets the plain run proceed with the instructions cleared", () => {
    NodeAssert.equal(canRunPlainGitInit({ cwd: "/tmp/thing", busy: false }), true);
    NodeAssert.equal(canRunPlainGitInit({ cwd: null, busy: false }), false);
    NodeAssert.equal(canRunPlainGitInit({ cwd: "/tmp/thing", busy: true }), false);
  });
});
