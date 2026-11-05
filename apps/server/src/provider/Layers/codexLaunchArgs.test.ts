import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  CODEX_APP_SERVER_CONFIG_ARGS,
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      [
        "app-server",
        ...CODEX_APP_SERVER_CONFIG_ARGS,
        "--config",
        'model="gpt-6.1-sol"',
        "--strict-config",
      ],
    );
  });

  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), [
      "app-server",
      ...CODEX_APP_SERVER_CONFIG_ARGS,
    ]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      ...CODEX_APP_SERVER_CONFIG_ARGS,
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("CODEX_APP_SERVER_CONFIG_ARGS", () => {
  it("turns on Codex's question card outside Plan mode, without its warning", () => {
    NodeAssert.deepStrictEqual(CODEX_APP_SERVER_CONFIG_ARGS, [
      "-c",
      "features.default_mode_request_user_input=true",
      "-c",
      "suppress_unstable_features_warning=true",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
  });

  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
