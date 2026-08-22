/**
 * Whether this process has been told to exit.
 *
 * A provider stream that dies because the app is quitting is not a provider
 * failure, and the difference is invisible from the stream itself: the pipe
 * breaks the same way whether the CLI crashed or the user asked for a restart.
 * Every adapter that wants to tell those apart has the same problem, and the
 * flag each of them already keeps (`stoppingAll` and its equivalents) is set by
 * the teardown path — which loses the race, because the socket dies first.
 *
 * Reported as a red "Runtime error" on every app update: the installer quits
 * the app mid-turn, and the turn it interrupted blamed the agent for it.
 *
 * A signal handler is early enough to win that race, and passive enough to be
 * safe: it only sets a flag. Node stops exiting by default once a `SIGINT` or
 * `SIGTERM` listener exists, so this would be a hazard in a process with no
 * other handler — `NodeRuntime.runMain` installs its own for graceful shutdown,
 * which is what the flag is describing in the first place.
 */

const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

let shuttingDown = false;

export function isProcessShuttingDown(): boolean {
  return shuttingDown;
}

/** For paths that know a shutdown is starting without waiting for a signal. */
export function markProcessShuttingDown(): void {
  shuttingDown = true;
}

/** Test-only: nothing resets a real process, but a suite runs many of them. */
export function resetProcessShutdownForTesting(): void {
  shuttingDown = false;
}

/**
 * Starts watching for termination signals. Returns a function that stops.
 *
 * Idempotent per call site rather than globally: each caller removes exactly
 * the listener it added, so a layer that is built and torn down repeatedly —
 * every test suite that constructs an adapter — cannot leak them.
 */
export function watchProcessShutdown(): () => void {
  const onSignal = () => {
    shuttingDown = true;
  };
  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, onSignal);
  }
  return () => {
    for (const signal of TERMINATION_SIGNALS) {
      process.off(signal, onSignal);
    }
  };
}
