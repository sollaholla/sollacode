import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { museAuthFilePath } from "./museProtocol.ts";
import type {
  ProviderAccountAuthStatus,
  ProviderInteractiveAccountAuthCapability,
} from "./ProviderDriver.ts";

export class MuseAccountAuthError extends Data.TaggedError("MuseAccountAuthError")<{
  readonly message: string;
}> {}
const authError = (message: string) => new MuseAccountAuthError({ message });

/**
 * The account identity `muse login` writes beside the credential.
 *
 * Only the two display fields are decoded. The same file holds the bearer
 * material, which has no business leaving this module, so nothing else is
 * read and nothing read here is logged.
 */
const decodeMuseAuthFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      providers: Schema.optional(
        Schema.Struct({
          meta: Schema.optional(
            Schema.Struct({
              user_email: Schema.optional(Schema.String),
              user_full_name: Schema.optional(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
);

/**
 * Who is signed in, read from the credential file.
 *
 * Muse has no `status`/`whoami` verb - `muse --help` lists `login`, `logout`
 * and `auth set`, and nothing else reports an account - so the file is the
 * only source. Its presence is the sign-in state and its `user_email` is the
 * label, which is why the provider card can finally name the Meta account
 * instead of saying only that one exists.
 */
export const readMuseAuthStatus = Effect.fn("readMuseAuthStatus")(function* (config: {
  readonly environment: NodeJS.ProcessEnv;
  /**
   * Passed in rather than taken from context: the driver probe this serves is
   * typed with an empty requirement set, and it already holds the service
   * from its enclosing scope.
   */
  readonly fs: FileSystem.FileSystem;
}): Effect.fn.Return<ProviderAccountAuthStatus> {
  const contents = yield* config.fs
    .readFileString(museAuthFilePath(config.environment))
    .pipe(Effect.orElseSucceed(() => ""));
  if (contents.trim().length === 0) {
    return { loggedIn: false, accountLabel: null };
  }
  const parsed = yield* decodeMuseAuthFile(contents).pipe(Effect.orElseSucceed(() => null));
  const meta = parsed?.providers?.meta;
  const label = meta?.user_email?.trim() || meta?.user_full_name?.trim() || null;
  // A credential file that exists but will not parse is still a credential
  // file. Reporting signed-out there would offer a sign-in the person does
  // not need and would sign them out of a working account to do it.
  return { loggedIn: true, accountLabel: label };
});

/** Meta's device-code page, as `muse login` prints it. */
const MUSE_AUTH_URL_PATTERN = /https:\/\/[^\s]*auth\.meta\.com\/[^\s]*/i;

/**
 * Sign in to, or switch, the Meta account Muse Code uses.
 *
 * `muse login` is a device-code flow and - unusually for a CLI login - needs
 * no TTY at all: run on plain pipes it prints
 *
 *     Open this page to sign in:
 *       https://auth.meta.com/oauth/device/?code=XXXX-XXXX
 *     confirm this code matches:
 *       XXXX-XXXX
 *     Waiting for approval…
 *
 * and then blocks until the page is approved. So this needs none of the
 * pty-and-screen-scraping the Antigravity flow does: spawn it, lift the URL
 * out of the first lines, hand it to the UI, and wait for the process to
 * exit. The code is shown inside the URL the person opens, so there is
 * nothing for them to type back and `onSubmitCode` is never armed.
 */
export function makeMuseAccountAuth(config: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
}): ProviderInteractiveAccountAuthCapability {
  return {
    switchAccount: Effect.fn("MuseAccountAuth.switchAccount")(function* (input) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      if (input.wasAuthenticated) {
        // Best effort. A logout that fails must not strand the person on the
        // old account with no way forward - `muse login` overwrites the
        // credential anyway, so the switch can still succeed without it.
        const logoutCommand = yield* resolveSpawnCommand(config.binaryPath, ["logout"], {
          env: config.environment,
        }).pipe(Effect.orElseSucceed(() => null));
        if (logoutCommand !== null) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawner.spawn(
                ChildProcess.make(logoutCommand.command, logoutCommand.args, {
                  env: config.environment,
                  extendEnv: false,
                  shell: logoutCommand.shell,
                }),
              );
              yield* child.exitCode;
            }),
          ).pipe(Effect.timeout("20 seconds"), Effect.ignore);
        }
      }

      const command = yield* resolveSpawnCommand(config.binaryPath, ["login"], {
        env: config.environment,
      }).pipe(Effect.mapError(() => authError("Could not start muse login.")));

      const child = yield* spawner
        .spawn(
          ChildProcess.make(command.command, command.args, {
            env: config.environment,
            extendEnv: false,
            shell: command.shell,
          }),
        )
        .pipe(Effect.mapError(() => authError("Could not start muse login.")));
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

      const urlSeen = yield* Deferred.make<void>();
      let buffered = "";
      let announced = false;
      const scan = (chunk: string) => {
        if (announced) return;
        // Bounded: the URL is in the first lines, and an unbounded buffer on
        // a process that waits indefinitely is a slow leak.
        buffered = (buffered + chunk).slice(-8_000);
        const match = buffered.match(MUSE_AUTH_URL_PATTERN);
        if (!match) return;
        announced = true;
        input.onProgress({ authUrl: match[0] });
        Deferred.doneUnsafe(urlSeen, Effect.void);
      };

      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Effect.sync(() => scan(chunk))),
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Effect.sync(() => scan(chunk))),
        Effect.ignore,
        Effect.forkScoped,
      );

      // Surface the page as soon as it is printed. Without this the UI shows
      // a bare spinner for the whole approval, which is the part that needs
      // the person to actually do something.
      yield* Deferred.await(urlSeen).pipe(Effect.timeout("30 seconds"), Effect.ignore);

      // The wall clock for a human to open a page and approve a code. Shorter
      // than this and a phone unlock loses the sign-in.
      const exitCode = yield* child.exitCode.pipe(
        Effect.timeout("10 minutes"),
        Effect.mapError(() =>
          authError("Muse sign-in timed out before the page was approved. Try again."),
        ),
      );

      const fs = yield* FileSystem.FileSystem;
      const status = yield* readMuseAuthStatus({ environment: config.environment, fs });
      if (!status.loggedIn) {
        return yield* Effect.fail(
          authError(
            exitCode === 0
              ? "Muse reported a completed sign-in but wrote no credential."
              : "Muse sign-in did not complete. Approve the page in your browser, then try again.",
          ),
        );
      }
      return status;
    }),
  };
}
