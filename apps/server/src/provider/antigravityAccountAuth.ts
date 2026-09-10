import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { spawnAndCollect } from "./providerSnapshot.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { PtyAdapter } from "../terminal/PtyAdapter.ts";
import { parseAntigravityAccountUsage } from "./antigravityUsage.ts";
import type {
  ProviderAccountAuthStatus,
  ProviderInteractiveAccountAuthCapability,
} from "./ProviderDriver.ts";

const decodeOnboarding = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      onboardingComplete: Schema.optional(Schema.Boolean),
      consumerOnboardingComplete: Schema.optional(Schema.Boolean),
      enterpriseOnboardingComplete: Schema.optional(Schema.Boolean),
    }),
  ),
);

export class AntigravityAccountAuthError extends Data.TaggedError("AntigravityAccountAuthError")<{
  readonly message: string;
}> {}
const authError = (message: string) => new AntigravityAccountAuthError({ message });

/** /usage is a native, non-generating command. A model listing alone is not auth proof. */
export function parseAntigravityAuthStatus(
  stdout: string,
  diagnostics: string,
): ProviderAccountAuthStatus {
  const loggedIn = parseAntigravityAccountUsage(stdout) !== null;
  const accountLabel = loggedIn
    ? (diagnostics.match(/OAuth: authenticated successfully as ([^\s<>]+@[^\s<>]+)/)?.[1] ?? null)
    : null;
  return { loggedIn, accountLabel };
}

/** Keep native diagnostics in a disposable file and expose only verified account identity. */
export const readAntigravityAuthStatus = Effect.fn("readAntigravityAuthStatus")(function* (config: {
  binaryPath: string;
  environment: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "solla-agy-status-" });
      const logPath = path.join(directory, "native.log");
      const command = yield* resolveSpawnCommand(
        config.binaryPath,
        ["--print", "/usage", "--print-timeout", "10s", "--log-file", logPath],
        { env: config.environment },
      );
      const result = yield* spawnAndCollect(
        config.binaryPath,
        ChildProcess.make(command.command, command.args, {
          env: config.environment,
          extendEnv: false,
          shell: command.shell,
          cwd: directory,
          forceKillAfter: "2 seconds",
        }),
      ).pipe(Effect.timeout("15 seconds"));
      const diagnostics = yield* fs.readFileString(logPath).pipe(Effect.orElseSucceed(() => ""));
      const stdout = result.code === 0 ? result.stdout : "";
      const status = parseAntigravityAuthStatus(stdout, diagnostics);
      const accountUsage = parseAntigravityAccountUsage(stdout);
      return {
        ...status,
        ...(accountUsage !== null ? { accountUsage } : {}),
        unauthenticated: /authentication required|not signed in/i.test(
          result.stdout + result.stderr,
        ),
      };
    }),
  );
});

export function antigravityAuthScreen(output: string) {
  // OSC 8 carries the full href even when the terminal abbreviates its visible label.
  // A PTY chunk can end anywhere in that href; only its terminator proves it is complete.
  const hyperlinks = Array.from(
    // eslint-disable-next-line no-control-regex
    output.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g),
    (match) => match[1] ?? "",
  );
  const text = output
    // Native terminal output contains ANSI escape/control sequences.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    // Discard an unfinished OSC frame so its partial href cannot become a plain-text URL.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x1b)?$/, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  // Only OAuth URLs qualify. Documentation and legal links never trigger login completion.
  const plainUrls = Array.from(
    // Plain links must also have a delivered delimiter, rather than merely ending this chunk.
    // eslint-disable-next-line no-control-regex
    text.matchAll(/https:\/\/[^\s<>"'\x00-\x1f]+(?=[\s<>"'\x00-\x1f])/g),
    (match) => match[0],
  );
  const url =
    [...hyperlinks, ...plainUrls].find(
      (candidate) =>
        candidate.startsWith("https://") &&
        /oauth|authorize|auth\//i.test(candidate) &&
        URL.canParse(candidate),
    ) ?? null;
  return {
    url,
    waitingForCode:
      /Enter\s+the\s+authorization\s+code:|paste\s+the\s+authorization\s+code\s+below:|copy\s+the\s+code\s+displayed\s+in\s+the\s+browser\s+and\s+paste\s+it\s+below:/i.test(
        text,
      ),
    authenticated: /Authentication successful!/i.test(text),
    ready: /\? for shortcuts/.test(text),
    oauthChoice: /Google OAuth/.test(text) && !url,
    apiKeyMode: /Gemini API Key Mode/.test(text),
    failed: /Authentication failed|Invalid authorization code/i.test(text),
    needsSetup: /Terms of Service & Data Use|Here's the change:[\s\S]*\[Next\]/.test(text),
  };
}

/** A private, scoped PTY carries AGY's native OAuth flow; its output is never logged. */
export function makeAntigravityAccountAuth(config: {
  binaryPath: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
}): ProviderInteractiveAccountAuthCapability {
  return {
    switchAccount: Effect.fn("AntigravityAccountAuth.switchAccount")(function* (input) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pty = yield* PtyAdapter;
      const home = config.environment.HOME ?? config.environment.USERPROFILE;
      if (home) {
        const onboarding = yield* fs
          .readFileString(path.join(home, ".gemini", "antigravity-cli", "cache", "onboarding.json"))
          .pipe(Effect.orElseSucceed(() => "{}"));
        const state = yield* decodeOnboarding(onboarding).pipe(
          Effect.mapError(() => authError("Could not read Antigravity CLI setup status.")),
        );
        const ready =
          state.onboardingComplete ||
          state.consumerOnboardingComplete ||
          state.enterpriseOnboardingComplete;
        if (!ready)
          return yield* Effect.fail(
            authError(
              "Antigravity CLI needs its one-time setup. Run agy in a host terminal, review its terms and data-sharing choices, then retry Switch user. Your current account has not been signed out.",
            ),
          );
      }
      // The supported SSH flow prints a URL and accepts a code, including from remote phones.
      const environment = {
        ...config.environment,
        SSH_CONNECTION: config.environment.SSH_CONNECTION || "solla-account-switch",
        TERM: "xterm-256color",
      };
      const command = yield* resolveSpawnCommand(config.binaryPath, [], { env: environment });
      const authDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "solla-agy-auth-" });
      const child = yield* pty.spawn({
        shell: command.command,
        args: [...command.args],
        cwd: authDirectory,
        env: environment,
        cols: 2000,
        rows: 50,
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            child.kill();
          } catch {
            /* Already exited. */
          }
        }),
      );
      const done = yield* Deferred.make<void, Error>();
      let output = "";
      let sawAuthUrl = false;
      let sawCodePrompt = false;
      let submitted = false;
      let logoutSent = false;
      let finished = false;
      let trustedAuthDirectory = false;
      let selectedOAuth = false;
      const complete = (error?: Error) => {
        if (finished) return;
        finished = true;
        Deferred.doneUnsafe(done, error ? Effect.fail(error) : Effect.void);
      };
      const disposeData = child.onData((data) => {
        output = (output + data).slice(-32_000);
        const screen = antigravityAuthScreen(output);
        if (finished) return;
        if (
          !trustedAuthDirectory &&
          output.includes("Do you trust the contents of this project?")
        ) {
          trustedAuthDirectory = true;
          // This process sees only the empty, disposable auth directory, never a user workspace.
          child.write("\r");
          output = "";
          return;
        }
        if (screen.apiKeyMode) {
          complete(
            authError(
              "AGY is configured for a Gemini API key, which has no account to switch. Remove modelProvider from the CLI settings to use Google account sign-in.",
            ),
          );
          return;
        }
        if (screen.needsSetup) {
          complete(
            authError("Complete Antigravity CLI setup in a host terminal, then retry Switch user."),
          );
          return;
        }
        if (screen.oauthChoice && !selectedOAuth) {
          selectedOAuth = true;
          output = "";
          // Google OAuth is the native first authentication choice after /logout.
          child.write("\r");
          return;
        }
        if (screen.ready && !sawAuthUrl && !logoutSent) {
          // Initial -i prompts bypass AGY's local slash-command dispatcher. Type the native
          // command only after the actual prompt is ready, with no agent/model turn involved.
          logoutSent = true;
          output = "";
          child.write("/logout\r");
          return;
        }
        if (screen.failed) {
          complete(
            authError("Antigravity rejected sign-in. Retry Switch user to request a fresh code."),
          );
          return;
        }
        if (screen.url && !sawAuthUrl) {
          sawAuthUrl = true;
          input.onProgress({ authUrl: screen.url, waitingForCode: screen.waitingForCode });
        }
        if (screen.waitingForCode && !sawCodePrompt) {
          sawCodePrompt = true;
          input.onProgress({ waitingForCode: true });
        }
        if (sawAuthUrl && (screen.authenticated || (submitted && screen.ready))) complete();
      });
      const disposeExit = child.onExit(({ exitCode }) =>
        complete(
          authError(
            exitCode === 0
              ? "Antigravity login closed before authentication was confirmed."
              : "Antigravity login ended unexpectedly. Retry Switch user.",
          ),
        ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          disposeData();
          disposeExit();
          output = "";
        }),
      );
      input.onSubmitCode((code) =>
        Effect.try({
          try: () => {
            if (!sawCodePrompt || finished || submitted)
              throw authError("Antigravity is not waiting for an authentication code.");
            submitted = true;
            // Never retain or publish the code or the PTY's echoed output.
            output = "";
            child.write(`${code}\r`);
          },
          catch: () => authError("Could not send the authentication code to Antigravity."),
        }),
      );
      // Native auth emits a completion receipt. We never infer success from a timer or model listing.
      yield* Deferred.await(done).pipe(
        Effect.timeout("10 minutes"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            authError(
              "Antigravity sign-in did not complete. Retry Switch user or finish signing in in a host terminal.",
            ),
          ),
        ),
      );
      const status = yield* readAntigravityAuthStatus(config).pipe(
        Effect.mapError(() =>
          authError(
            "Could not verify the new Antigravity account. Refresh provider status after checking the CLI sign-in.",
          ),
        ),
      );
      if (!status.loggedIn)
        return yield* authError(
          "Antigravity did not confirm an authenticated account after login.",
        );
      return status;
    }),
  };
}
