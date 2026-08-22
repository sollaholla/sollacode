import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalLayoutStreamEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";
import * as PtyAdapter from "./PtyAdapter.ts";
import {
  encodeAgentCliResumeState,
  parseAgentCliResumeState,
  resumeStateFilePath,
} from "./agentCliResume.ts";
import { encodeTerminalLaunchContext, launchContextFilePath } from "./launchContext.ts";

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  writeFailure: unknown | undefined;
  resizeFailure: unknown | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  killed = false;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    if (this.writeFailure !== undefined) {
      throw this.writeFailure;
    }
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.resizeFailure !== undefined) {
      throw this.resizeFailure;
    }
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private readonly mode: "sync" | "async";
  private nextPid = 9000;

  constructor(mode: "sync" | "async" = "sync") {
    this.mode = mode;
  }

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtyAdapter.PtySpawnError({
          adapter: "fake",
          shell: input.shell,
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "fake",
            shell: input.shell,
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = 800,
): Effect.Effect<void, WaitForConditionError | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for condition" })),
        onSome: () => Effect.void,
      }),
    ),
  );

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

const historyLogPath = (logsDir: string, threadId = "thread-1") =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => join(logsDir, `terminal_${Encoding.encodeBase64Url(threadId)}.log`)),
  );

const multiTerminalHistoryLogPath = (
  logsDir: string,
  threadId = "thread-1",
  terminalId = DEFAULT_TERMINAL_ID,
) =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => {
      const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
      return join(
        logsDir,
        terminalId === DEFAULT_TERMINAL_ID
          ? `${threadPart}.log`
          : `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`,
      );
    }),
  );

interface CreateManagerOptions {
  /** Boot over an existing directory (e.g. pre-seeded launch/resume files). */
  logsDir?: string;
  historyByteLimit?: number;
  pendingProcessEventByteLimit?: number;
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: (terminalPid: number) => Effect.Effect<{
    readonly hasRunningSubprocess: boolean;
    readonly childCommand: string | null;
    readonly processIds: ReadonlyArray<number>;
  }>;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  resolveAgentCliSessionId?: (input: {
    readonly command: string;
    readonly processIds: ReadonlyArray<number>;
    readonly processArgs: string | null;
  }) => Effect.Effect<string | null>;
  ptyAdapter?: FakePtyAdapter;
  issueTerminalAgentMcpCredential?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<McpProviderSessionConfig | null>;
  revokeTerminalAgentMcpCredential?: (providerSessionId: string) => Effect.Effect<void>;
  touchTerminalAgentMcpCredential?: (providerSessionId: string) => Effect.Effect<void>;
}

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManager.TerminalManager["Service"];
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ProcessRunner.ProcessRunner
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-terminal-" });
      const logsDir = options.logsDir ?? join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        historyLineLimit,
        ...(options.historyByteLimit !== undefined
          ? { historyByteLimit: options.historyByteLimit }
          : {}),
        ...(options.pendingProcessEventByteLimit !== undefined
          ? { pendingProcessEventByteLimit: options.pendingProcessEventByteLimit }
          : {}),
        ptyAdapter,
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.subprocessInspector !== undefined
          ? { subprocessInspector: options.subprocessInspector }
          : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.resolveAgentCliSessionId !== undefined
          ? { resolveAgentCliSessionId: options.resolveAgentCliSessionId }
          : {}),
        ...(options.issueTerminalAgentMcpCredential !== undefined
          ? { issueTerminalAgentMcpCredential: options.issueTerminalAgentMcpCredential }
          : {}),
        ...(options.revokeTerminalAgentMcpCredential !== undefined
          ? { revokeTerminalAgentMcpCredential: options.revokeTerminalAgentMcpCredential }
          : {}),
        ...(options.touchTerminalAgentMcpCredential !== undefined
          ? { touchTerminalAgentMcpCredential: options.touchTerminalAgentMcpCredential }
          : {}),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        join,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

const withHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcessPlatform, platform);

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("TerminalManager", (it) => {
  it.effect("derives every terminal subtree from one POSIX process snapshot", () =>
    Effect.sync(() => {
      const rows = TerminalManager.parsePosixProcessSnapshot(`
        100 1 /bin/zsh /bin/zsh
        101 100 /usr/bin/node node wrapper.js
        102 101 /opt/homebrew/bin/claude claude --resume session-1
        200 1 /bin/zsh /bin/zsh
        201 200 /usr/bin/vim vim README.md
      `);

      expect(TerminalManager.inspectPosixSubprocessFromRows(100, rows)).toEqual({
        hasRunningSubprocess: true,
        childCommand: "claude",
        processIds: [100, 101, 102],
        processArgs: "claude --resume session-1",
      });
      expect(TerminalManager.inspectPosixSubprocessFromRows(200, rows)).toEqual({
        hasRunningSubprocess: true,
        childCommand: "vim",
        processIds: [200, 201],
        processArgs: "vim README.md",
      });
      expect(TerminalManager.inspectPosixSubprocessFromRows(300, rows)).toEqual({
        hasRunningSubprocess: false,
        childCommand: null,
        processIds: [],
      });
    }),
  );

  it.effect("spawns lazily and reuses running terminal per thread", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const [first, second] = yield* Effect.all(
        [manager.open(openInput()), manager.open(openInput())],
        { concurrency: "unbounded" },
      );
      const third = yield* manager.open(openInput());

      assert.equal(first.threadId, "thread-1");
      assert.equal(first.terminalId, DEFAULT_TERMINAL_ID);
      assert.equal(second.threadId, "thread-1");
      assert.equal(third.threadId, "thread-1");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("lists known sessions without spawning, and reads history in place", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      expect(yield* manager.list({})).toEqual([]);

      yield* manager.open(openInput());
      ptyAdapter.processes[0]?.emitData("hello from the pane");
      yield* waitFor(
        manager
          .read({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID })
          .pipe(Effect.map((snapshot) => snapshot.history.includes("hello from the pane"))),
        "2500 millis",
      );

      const listed = yield* manager.list({});
      expect(listed).toHaveLength(1);
      expect(listed[0]?.threadId).toBe("thread-1");
      expect(listed[0]?.terminalId).toBe(DEFAULT_TERMINAL_ID);
      expect(listed[0]?.status).toBe("running");

      const snapshot = yield* manager.read({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
      });
      expect(snapshot.history).toContain("hello from the pane");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);

      expect(yield* manager.list({ threadId: "thread-other" })).toEqual([]);
    }),
  );

  it.effect("fails a read of a terminal that was never opened", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      const error = yield* Effect.flip(
        manager.read({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID }),
      );
      expect(error._tag).toBe("TerminalSessionLookupError");
    }),
  );

  it.effect("attaches to running sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();

      yield* manager.open(openInput());
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 100,
          rows: 40,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.threadId, "thread-1");
      assert.equal(snapshot.snapshot.terminalId, DEFAULT_TERMINAL_ID);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes[0]?.resizeCalls).toEqual([]);
    }),
  );

  it.effect("does not let an attaching viewer resize a running PTY", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 132, rows: 40 }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 40,
          rows: 12,
        },
        () => Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      expect(process.resizeCalls).toEqual([]);
    }),
  );

  it.effect("keeps attach streams live when a terminal id is closed and reopened", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.open(openInput());

      const events = yield* Ref.get(attachEvents);
      expect(events.map((event) => event.type)).toEqual(["snapshot", "closed", "snapshot"]);
      expect(
        events.filter((event) => event.type === "snapshot").map((event) => event.snapshot.status),
      ).toEqual(["running", "running"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("attaches to exited sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        openInput({
          env: {
            T3CODE_WORKTREE_PATH: "/tmp/should-not-restart",
          },
          worktreePath: "/tmp/should-not-restart",
        }),
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "exited");
      assert.equal(snapshot.snapshot.worktreePath, null);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("restarts inactive sessions from attach only when requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          ...openInput({
            env: {
              T3CODE_WORKTREE_PATH: "/tmp/restart-requested",
            },
            worktreePath: "/tmp/restart-requested",
          }),
          restartIfNotRunning: true,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "running");
      assert.equal(snapshot.snapshot.worktreePath, "/tmp/restart-requested");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  const makeDirectory = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.makeDirectory(filePath, { recursive: true }),
    );

  const chmod = (filePath: string, mode: number) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.chmod(filePath, mode));

  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );

  it.effect("reports a missing cwd without an artificial cause", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "missing-cwd");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotFoundError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("reports a cwd that is not a directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "cwd-file");
      yield* writeFileString(cwd, "not a directory");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotDirectoryError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves non-notFound cwd stat failures", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;

      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const blockedRoot = path.join(baseDir, "blocked-root");
      const blockedCwd = path.join(blockedRoot, "cwd");
      yield* makeDirectory(blockedCwd);
      yield* chmod(blockedRoot, 0o000);

      const error = yield* Effect.flip(manager.open(openInput({ cwd: blockedCwd }))).pipe(
        Effect.ensuring(chmod(blockedRoot, 0o755).pipe(Effect.ignore)),
      );

      expect(error).toMatchObject({
        _tag: "TerminalCwdStatError",
        cwd: blockedCwd,
        cause: {
          _tag: "PlatformError",
        },
      });
    }),
  );

  it.effect("supports asynchronous PTY spawn effects", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes).toHaveLength(1);
    }),
  );

  it.effect("forwards write and resize to active pty process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "ls\n",
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.writes).toEqual(["ls\n"]);
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("drops degenerate resize requests from mid-animation layouts", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      // A pane mid-split fits a 1–2 column grid; applying it makes ConPTY
      // rewrap and re-emit its whole buffer one character per line.
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 2,
        rows: 30,
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 2,
      });

      expect(process.resizeCalls).toEqual([]);
    }),
  );

  it.effect("publishes refreshed metadata with the new grid on resize", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput());

      const metadataEvents: TerminalMetadataStreamEvent[] = [];
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Effect.sync(() => {
          metadataEvents.push(event);
        }),
      );

      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 121,
        rows: 31,
      });
      unsubscribe();

      // Passive viewers adopt the PTY grid from these summaries; a resize
      // must therefore push one even though it has no TerminalEvent.
      const gridUpsert = metadataEvents.find(
        (event) =>
          event.type === "upsert" && event.terminal.cols === 121 && event.terminal.rows === 31,
      );
      expect(gridUpsert).toBeDefined();
    }),
  );

  it.effect("ignores resize from a non-owner client while the owner is active", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ clientId: "machine-a" }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      // Two machines viewing the same terminal must not ping-pong the PTY
      // between their pane grids; the opener owns the geometry.
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 80,
        rows: 20,
        clientId: "machine-b",
      });
      expect(process.resizeCalls).toEqual([]);

      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 132,
        rows: 40,
        clientId: "machine-a",
      });
      expect(process.resizeCalls).toEqual([{ cols: 132, rows: 40 }]);

      // Old clients that send no clientId cannot stomp an owned grid either.
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 70,
        rows: 18,
      });
      expect(process.resizeCalls).toEqual([{ cols: 132, rows: 40 }]);
    }),
  );

  it.effect("typing transfers geometry ownership to the writing client", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ clientId: "machine-a" }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const metadataEvents: TerminalMetadataStreamEvent[] = [];
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Effect.sync(() => {
          metadataEvents.push(event);
        }),
      );

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "ls\n",
        clientId: "machine-b",
      });
      unsubscribe();

      // The transfer is broadcast so the old owner starts mirroring.
      const transferUpsert = metadataEvents.find(
        (event) => event.type === "upsert" && event.terminal.geometryOwner === "machine-b",
      );
      expect(transferUpsert).toBeDefined();

      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 90,
        rows: 22,
        clientId: "machine-a",
      });
      expect(process.resizeCalls).toEqual([]);

      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 90,
        rows: 22,
        clientId: "machine-b",
      });
      expect(process.resizeCalls).toEqual([{ cols: 90, rows: 22 }]);
    }),
  );

  it.effect("re-opening by another client does not resize an owned running grid", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ clientId: "machine-a" }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const reopened = yield* manager.open(
        openInput({ clientId: "machine-b", cols: 80, rows: 20 }),
      );

      expect(process.resizeCalls).toEqual([]);
      assert.equal(reopened.cols, 100);
      assert.equal(reopened.rows, 24);
    }),
  );

  it.effect("does not resurrect an explicitly closed terminal on attach", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
      });

      // A pane that outlived the close on another machine attaches with a
      // cwd; recreating the session would resurrect the closed terminal and
      // permanently diverge pane layouts between machines.
      const failure = yield* Effect.flip(manager.attachStream(openInput(), () => Effect.void));
      assert.equal(failure._tag, "TerminalSessionLookupError");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);

      // An explicit open is user intent and revives the terminal id.
      const snapshot = yield* manager.open(openInput());
      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("stores, broadcasts, and persists thread pane layouts", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { manager, baseDir } = yield* createManager();
      const logsDir = path.join(baseDir, "userdata", "logs", "terminals");

      const empty = yield* manager.getLayout({ threadId: "thread-1" });
      expect(empty.layout).toBeNull();

      const layoutEvents: TerminalLayoutStreamEvent[] = [];
      const unsubscribe = yield* manager.subscribeLayouts((event) =>
        Effect.sync(() => {
          layoutEvents.push(event);
        }),
      );
      expect(layoutEvents).toEqual([{ type: "snapshot", layouts: [] }]);

      const groups = [
        {
          id: "group-term-1",
          terminalIds: ["term-1", "term-2"],
          layout: {
            kind: "split" as const,
            direction: "horizontal" as const,
            children: [
              { kind: "terminal" as const, terminalId: "term-1" },
              { kind: "terminal" as const, terminalId: "term-2" },
            ],
          },
        },
      ];
      const first = yield* manager.setLayout({ threadId: "thread-1", groups });
      expect(first.revision).toBe(1);
      const second = yield* manager.setLayout({
        threadId: "thread-1",
        groups,
        baseRevision: first.revision,
      });
      expect(second.revision).toBe(2);
      unsubscribe();

      expect(
        layoutEvents
          .filter((event) => event.type === "layout")
          .map((event) => event.layout.revision),
      ).toEqual([1, 2]);

      const read = yield* manager.getLayout({ threadId: "thread-1" });
      expect(read.layout?.revision).toBe(2);
      expect(read.layout?.groups).toEqual(groups);

      // A new manager over the same logs directory reloads the document.
      const restarted = yield* createManager(5, { logsDir });
      const restored = yield* restarted.manager.getLayout({ threadId: "thread-1" });
      expect(restored.layout?.revision).toBe(2);
      expect(restored.layout?.groups).toEqual(groups);
    }),
  );

  it.effect("repairs stale layout membership from the restartable session inventory", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      yield* manager.setLayout({
        threadId: "thread-1",
        groups: [
          {
            id: "group-main",
            terminalIds: ["term-1", "term-3"],
            layout: {
              kind: "split",
              direction: "horizontal",
              children: [
                { kind: "terminal", terminalId: "term-1" },
                { kind: "terminal", terminalId: "term-3" },
              ],
            },
          },
        ],
      });
      yield* manager.open(openInput({ terminalId: "term-1" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      // This is the observed broken state: the layout still names a removed
      // terminal while the restart records contain its replacement.
      expect((yield* manager.getLayout({ threadId: "thread-1" })).layout?.groups).toEqual([
        expect.objectContaining({ terminalIds: ["term-1", "term-3"] }),
        expect.objectContaining({ terminalIds: ["term-2"] }),
      ]);

      const restarted = yield* createManager(5, { logsDir });
      yield* restarted.manager.list({ threadId: "thread-1" });
      const repaired = yield* restarted.manager.getLayout({ threadId: "thread-1" });
      expect(repaired.layout?.groups).toEqual([
        expect.objectContaining({ terminalIds: ["term-1"] }),
        expect.objectContaining({ terminalIds: ["term-2"] }),
      ]);
    }),
  );

  it.effect("persists terminal opens and closes into the layout document", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "term-1" }));
      yield* manager.open(openInput({ terminalId: "term-3" }));
      yield* manager.setLayout({
        threadId: "thread-1",
        groups: [
          {
            id: "group-main",
            terminalIds: ["term-1", "term-3"],
            layout: {
              kind: "split",
              direction: "horizontal",
              children: [
                { kind: "terminal", terminalId: "term-1" },
                { kind: "terminal", terminalId: "term-3" },
              ],
            },
          },
        ],
      });

      yield* manager.close({ threadId: "thread-1", terminalId: "term-3" });
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const current = yield* manager.getLayout({ threadId: "thread-1" });
      expect(current.layout?.groups).toEqual([
        expect.objectContaining({ terminalIds: ["term-1"] }),
        expect.objectContaining({ terminalIds: ["term-2"] }),
      ]);

      const restarted = yield* createManager(5, { logsDir });
      yield* restarted.manager.list({ threadId: "thread-1" });
      const restored = yield* restarted.manager.getLayout({ threadId: "thread-1" });
      expect(restored.layout?.groups).toEqual(current.layout?.groups);
    }),
  );

  it.effect("preserves structured context and causes for PTY I/O failures", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const writeCause = new Error("PTY input handle is unavailable");
      process.writeFailure = writeCause;
      const writeError = yield* Effect.flip(
        manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "secret input that must not be attached to the error",
        }),
      );

      expect(writeError).toMatchObject({
        _tag: "TerminalWriteError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
      });
      expect(writeError.cause).toBe(writeCause);
      expect(writeError).not.toHaveProperty("data");

      const resizeCause = new Error("PTY resize handle is unavailable");
      process.resizeFailure = resizeCause;
      const resizeError = yield* Effect.flip(
        manager.resize({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 132,
          rows: 40,
        }),
      );

      expect(resizeError).toMatchObject({
        _tag: "TerminalResizeError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
        cols: 132,
        rows: 40,
      });
      expect(resizeError.cause).toBe(resizeCause);

      process.resizeFailure = undefined;
      yield* manager.open(openInput({ cols: 132, rows: 40 }));
      expect(process.resizeCalls).toEqual([{ cols: 132, rows: 40 }]);
    }),
  );

  it.effect("ignores delayed resize requests after a terminal closes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.resizeCalls).toEqual([]);
    }),
  );

  it.effect("resizes running terminal on open when a different size is requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const reopened = yield* manager.open(openInput({ cols: 120, rows: 30 }));

      assert.equal(reopened.status, "running");
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("supports multiple terminals per thread independently", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      yield* manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
      yield* manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

      expect(first.writes).toEqual(["pwd\n"]);
      expect(second.writes).toEqual(["ls\n"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("clears transcript and emits cleared event", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );

      const events = yield* getEvents;
      expect(events.some((event) => event.type === "cleared")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "cleared" &&
            event.threadId === "thread-1" &&
            event.terminalId === DEFAULT_TERMINAL_ID,
        ),
      ).toBe(true);
    }),
  );

  it.effect("restarts terminal with empty transcript and respawns pty", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      firstProcess.emitData("before restart\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      const snapshot = yield* manager.restart(restartInput());
      assert.equal(snapshot.history, "");
      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );
    }),
  );

  it.effect("restarts a running session when open is called with a different cwd", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const originalCwd = path.join(baseDir, "original");
      const differentCwd = path.join(baseDir, "different");
      yield* makeDirectory(originalCwd);
      yield* makeDirectory(differentCwd);

      yield* manager.open(openInput({ cwd: originalCwd }));
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;

      firstProcess.emitData("before reopen\n");
      const logPath = yield* historyLogPath(logsDir);
      yield* waitFor(pathExists(logPath));

      const reopened = yield* manager.open(openInput({ cwd: differentCwd }));

      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      assert.equal(firstProcess.killed, true);
      assert.equal(reopened.cwd, differentCwd);
      assert.equal(reopened.history, "");
      yield* waitFor(Effect.map(readFileString(logPath), (text) => text === ""));
    }),
  );

  it.effect("propagates explicit worktree metadata through snapshots and lifecycle events", () =>
    Effect.gen(function* () {
      const { manager, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const firstWorktreePath = path.join(baseDir, "worktrees", "feature-a");
      const secondWorktreePath = path.join(baseDir, "worktrees", "feature-b");
      yield* makeDirectory(firstWorktreePath);
      yield* makeDirectory(secondWorktreePath);
      const startedSnapshot = yield* manager.open(
        openInput({
          cwd: firstWorktreePath,
          worktreePath: firstWorktreePath,
        }),
      );
      const restartedSnapshot = yield* manager.restart(
        restartInput({
          cwd: secondWorktreePath,
          worktreePath: secondWorktreePath,
        }),
      );

      assert.equal(startedSnapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedSnapshot.worktreePath, secondWorktreePath);

      const events = yield* getEvents;
      const startedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
      );
      const restartedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "restarted" }> =>
          event.type === "restarted",
      );

      assert.equal(startedEvent?.snapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedEvent?.snapshot.worktreePath, secondWorktreePath);
    }),
  );

  it.effect("preserves worktree metadata when reopening an exited session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const worktreePath = path.join(baseDir, "worktrees", "feature-a");
      yield* makeDirectory(worktreePath);

      yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );

      const reopenedSnapshot = yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      assert.equal(reopenedSnapshot.worktreePath, worktreePath);

      const events = yield* getEvents;
      const reopenedEvent = events
        .toReversed()
        .find(
          (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
        );

      assert.equal(reopenedEvent?.snapshot.worktreePath, worktreePath);
    }),
  );

  it.effect("emits exited event and reopens with clean transcript after exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("old data\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      const reopened = yield* manager.open(openInput());

      assert.equal(reopened.history, "");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
        ),
      ).toBe("");
    }),
  );

  it.effect("ignores trailing writes after terminal exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\r",
      });
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect("emits subprocess activity events when child-process state changes", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
      } = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      const { manager, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      expect((yield* getEvents).some((event) => event.type === "activity")).toBe(false);

      inspect = { hasRunningSubprocess: true, childCommand: "vim", processIds: [100, 101] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      inspect = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === false &&
              event.label === "Terminal 1",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("does not mark an idle agent TUI as working", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
      } = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      inspect = { hasRunningSubprocess: true, childCommand: "claude", processIds: [100] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "claude",
          ),
        ),
        "1200 millis",
      );
      expect((yield* manager.list({}))[0]?.working).toBe(false);

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("Reading src/foo.ts\nesc to interrupt\n");
      yield* waitFor(
        manager
          .list({})
          .pipe(Effect.map((terminals) => terminals.some((terminal) => terminal.working === true))),
        "2500 millis",
      );
    }),
  );

  it.effect(
    "persists agent CLI resume metadata while grok is running and clears it when idle",
    () =>
      Effect.gen(function* () {
        let inspect: {
          readonly hasRunningSubprocess: boolean;
          readonly childCommand: string | null;
          readonly processIds: ReadonlyArray<number>;
        } = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
        const { manager, logsDir, getEvents } = yield* createManager(5, {
          subprocessInspector: () => Effect.succeed(inspect),
          subprocessPollIntervalMs: 20,
          resolveAgentCliSessionId: () => Effect.succeed("sess-1"),
        });
        const path = yield* Path.Path;
        const resumePath = resumeStateFilePath(
          yield* historyLogPath(logsDir).pipe(Effect.provideService(Path.Path, path)),
        );

        yield* manager.open(openInput());
        inspect = { hasRunningSubprocess: true, childCommand: "grok", processIds: [100] };
        yield* waitFor(
          Effect.map(getEvents, (events) =>
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "grok",
            ),
          ),
          "1200 millis",
        );
        yield* waitFor(
          readFileString(resumePath).pipe(
            Effect.map((raw) => {
              const state = parseAgentCliResumeState(raw);
              return state?.resumeOnRestore === true && state.sessionId === "sess-1";
            }),
            Effect.orElseSucceed(() => false),
          ),
          "1200 millis",
        );

        inspect = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
        yield* waitFor(
          readFileString(resumePath).pipe(
            Effect.map((raw) => parseAgentCliResumeState(raw)?.resumeOnRestore === false),
            Effect.orElseSucceed(() => false),
          ),
          "1200 millis",
        );
      }),
  );

  it.effect("does not persist resume metadata for a non-agent subprocess", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
      } = { hasRunningSubprocess: true, childCommand: "vim", processIds: [100] };
      const { manager, logsDir, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });
      const path = yield* Path.Path;
      const resumePath = resumeStateFilePath(
        yield* historyLogPath(logsDir).pipe(Effect.provideService(Path.Path, path)),
      );

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.label === "vim"),
        ),
        "1200 millis",
      );
      yield* Effect.sleep("80 millis");
      expect(yield* pathExists(resumePath)).toBe(false);
    }),
  );

  it.effect("restores persisted sessions at boot and types the CLI resume", () =>
    Effect.gen(function* () {
      const fs = yield* Effect.service(FileSystem.FileSystem);
      const path = yield* Path.Path;
      // Seed the directory the way a dying server leaves it: history, a
      // launch context (session was still running), and a resume mark.
      const preparedDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-terminal-boot-" });
      const logsDir = path.join(preparedDir, "terminals");
      yield* makeDirectory(logsDir);
      const logPath = yield* historyLogPath(logsDir).pipe(Effect.provideService(Path.Path, path));
      yield* writeFileString(logPath, "old shell output\n");
      yield* writeFileString(
        launchContextFilePath(logPath),
        encodeTerminalLaunchContext(
          {
            threadId: "thread-1",
            terminalId: DEFAULT_TERMINAL_ID,
            cwd: process.cwd(),
            worktreePath: null,
            runtimeEnv: null,
            cols: 100,
            rows: 24,
          },
          "2026-08-20T00:00:00.000Z",
        ),
      );
      yield* writeFileString(
        resumeStateFilePath(logPath),
        encodeAgentCliResumeState(
          { command: "grok", sessionId: "sess-9", resumeOnRestore: true },
          "2026-08-20T00:00:00.000Z",
        ),
      );

      const { manager, ptyAdapter } = yield* createManager(5, { logsDir });
      yield* waitFor(
        Effect.sync(() => ptyAdapter.processes.length === 1),
        "2500 millis",
      );
      const listed = yield* manager.list({});
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.threadId, "thread-1");
      assert.equal(listed[0]?.status, "running");

      const spawned = ptyAdapter.processes[0];
      expect(spawned).toBeDefined();
      if (!spawned) return;
      spawned.emitData("% ");
      yield* waitFor(
        Effect.sync(() => spawned.writes.some((chunk) => chunk.includes("grok --resume sess-9"))),
        "2500 millis",
      );
    }),
  );

  it.effect("restores every persisted pane before any client attaches", () =>
    Effect.gen(function* () {
      const fs = yield* Effect.service(FileSystem.FileSystem);
      const path = yield* Path.Path;
      const preparedDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-terminal-background-boot-",
      });
      const logsDir = path.join(preparedDir, "terminals");
      yield* makeDirectory(logsDir);

      const persisted = [
        { threadId: "thread-background-a", terminalId: DEFAULT_TERMINAL_ID },
        { threadId: "thread-background-a", terminalId: "term-2" },
        { threadId: "thread-background-b", terminalId: DEFAULT_TERMINAL_ID },
      ] as const;
      yield* Effect.forEach(
        persisted,
        ({ threadId, terminalId }) =>
          multiTerminalHistoryLogPath(logsDir, threadId, terminalId).pipe(
            Effect.provideService(Path.Path, path),
            Effect.flatMap((logPath) =>
              writeFileString(
                launchContextFilePath(logPath),
                encodeTerminalLaunchContext(
                  {
                    threadId,
                    terminalId,
                    cwd: process.cwd(),
                    worktreePath: null,
                    runtimeEnv: null,
                    cols: 100,
                    rows: 24,
                  },
                  "2026-08-20T00:00:00.000Z",
                ),
              ),
            ),
          ),
        { discard: true },
      );

      const { manager, ptyAdapter } = yield* createManager(5, { logsDir });
      const restored = yield* manager.list({});

      expect(ptyAdapter.spawnInputs).toHaveLength(3);
      expect(
        restored
          .map(({ threadId, terminalId, status }) => ({ threadId, terminalId, status }))
          .toSorted((left, right) =>
            `${left.threadId}:${left.terminalId}`.localeCompare(
              `${right.threadId}:${right.terminalId}`,
            ),
          ),
      ).toEqual([
        {
          threadId: "thread-background-a",
          terminalId: DEFAULT_TERMINAL_ID,
          status: "running",
        },
        { threadId: "thread-background-a", terminalId: "term-2", status: "running" },
        {
          threadId: "thread-background-b",
          terminalId: DEFAULT_TERMINAL_ID,
          status: "running",
        },
      ]);
    }),
  );

  it.effect("drops the launch context when the shell exits on its own", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      const path = yield* Path.Path;
      const logPath = yield* historyLogPath(logsDir).pipe(Effect.provideService(Path.Path, path));
      const launchPath = launchContextFilePath(logPath);

      yield* manager.open(openInput());
      yield* waitFor(pathExists(launchPath), "2500 millis");

      const spawned = ptyAdapter.processes[0];
      expect(spawned).toBeDefined();
      if (!spawned) return;
      spawned.emitExit({ exitCode: 0, signal: 0 });
      yield* waitFor(pathExists(launchPath).pipe(Effect.map((exists) => !exists)), "2500 millis");
    }),
  );

  it.effect("relaunches a persisted grok CLI with --resume <session id> after a cold start", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      const path = yield* Path.Path;
      const logPath = yield* historyLogPath(logsDir).pipe(Effect.provideService(Path.Path, path));
      const resumePath = resumeStateFilePath(logPath);
      yield* writeFileString(logPath, "garbled tui frame >\n");
      yield* writeFileString(
        resumePath,
        encodeAgentCliResumeState(
          { command: "grok", sessionId: "sess-1", resumeOnRestore: true },
          "2026-08-19T00:00:00.000Z",
        ),
      );

      const opened = yield* manager.open(openInput());
      expect(opened.history).toBe("");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("% ");

      yield* waitFor(
        Effect.sync(() => process.writes.some((chunk) => chunk.includes("grok --resume sess-1"))),
        "2500 millis",
      );
      expect(parseAgentCliResumeState(yield* readFileString(resumePath))).toEqual({
        command: "grok",
        sessionId: "sess-1",
        resumeOnRestore: false,
      });
    }),
  );

  it.effect("still types the resume command when a shell helper is the only child", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(5, {
        subprocessInspector: () =>
          Effect.succeed({
            hasRunningSubprocess: true,
            childCommand: "gitstatusd",
            processIds: [100],
          }),
        subprocessPollIntervalMs: 20,
      });
      const path = yield* Path.Path;
      const resumePath = resumeStateFilePath(
        yield* historyLogPath(logsDir).pipe(Effect.provideService(Path.Path, path)),
      );
      yield* writeFileString(
        resumePath,
        encodeAgentCliResumeState(
          { command: "claude", sessionId: "claude-sess", resumeOnRestore: true },
          "2026-08-19T00:00:00.000Z",
        ),
      );

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("% ");

      yield* waitFor(
        Effect.sync(() =>
          process.writes.some((chunk) => chunk.includes("claude --resume claude-sess")),
        ),
        "2500 millis",
      );
    }),
  );

  it.effect("does not relaunch an agent CLI when no session id was captured", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      const path = yield* Path.Path;
      const logPath = yield* historyLogPath(logsDir).pipe(Effect.provideService(Path.Path, path));
      const resumePath = resumeStateFilePath(logPath);
      yield* writeFileString(logPath, "garbled tui frame\n");
      yield* writeFileString(
        resumePath,
        encodeAgentCliResumeState(
          { command: "grok", sessionId: null, resumeOnRestore: true },
          "2026-08-19T00:00:00.000Z",
        ),
      );

      const opened = yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      assert.equal(opened.history, "");
      yield* Effect.sleep("700 millis");
      expect(process.writes).toEqual([]);
      expect(parseAgentCliResumeState(yield* readFileString(resumePath))?.resumeOnRestore).toBe(
        false,
      );
    }),
  );

  it.effect("does not invoke subprocess polling until a terminal session is running", () =>
    Effect.gen(function* () {
      let checks = 0;
      const { manager } = yield* createManager(5, {
        subprocessInspector: () => {
          checks += 1;
          return Effect.succeed({
            hasRunningSubprocess: false,
            childCommand: null,
            processIds: [],
          });
        },
        subprocessPollIntervalMs: 20,
      });

      yield* Effect.sleep("80 millis");
      assert.equal(checks, 0);

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.sync(() => checks > 0),
        "1200 millis",
      );
    }),
  );

  it.effect("caps persisted history to configured line limit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\nline2\nline3\nline4\n");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
      expect(nonEmptyLines).toEqual([
        "[Earlier terminal output truncated]",
        "line2",
        "line3",
        "line4",
      ]);
    }),
  );

  it.effect("caps persisted history by UTF-8 bytes with an explicit truncation marker", () =>
    Effect.gen(function* () {
      const historyByteLimit = 96;
      const { manager, ptyAdapter } = yield* createManager(5_000, { historyByteLimit });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData(`${"old-output-".repeat(20)}${"🙂".repeat(30)}tail\n`);
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history).toContain("[Earlier terminal output truncated]");
      expect(reopened.history).toContain("tail\n");
      expect(new TextEncoder().encode(reopened.history).byteLength).toBeLessThanOrEqual(
        historyByteLimit,
      );
    }),
  );

  it.effect("strips replay-unsafe terminal query and reply sequences from persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[32mok\u001b[0m ");
      process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
      process.emitData("\u001b]11;?\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(
        reopened.history,
        "prompt \u001b[32mok\u001b[0m \u001b]11;rgb:ffff/ffff/ffff\u0007done\n",
      );
    }),
  );

  it.effect(
    "preserves clear and style control sequences while dropping chunk-split query traffic",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before clear\n");
        process.emitData("\u001b[H\u001b[2J");
        process.emitData("prompt ");
        process.emitData("\u001b]11;");
        process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
        process.emitData("R\u001b[36mdone\u001b[0m\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(
          reopened.history,
          "before clear\n\u001b[H\u001b[2Jprompt \u001b]11;rgb:ffff/ffff/ffff\u0007\u001b[36mdone\u001b[0m\n",
        );
      }),
  );

  it.effect("does not leak final bytes from ESC sequences with intermediate bytes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b(B");
      process.emitData("after\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before \u001b(Bafter\n");
    }),
  );

  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(reopened.history, "before \u001b(Bafter\n");
      }),
  );

  it.effect("deletes history file when close(deleteHistory=true)", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("bye\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("closes all terminals for a thread when close omits terminalId", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));
      const defaultProcess = ptyAdapter.processes[0];
      const sidecarProcess = ptyAdapter.processes[1];
      expect(defaultProcess).toBeDefined();
      expect(sidecarProcess).toBeDefined();
      if (!defaultProcess || !sidecarProcess) return;

      defaultProcess.emitData("default\n");
      sidecarProcess.emitData("sidecar\n");
      const path = yield* Path.Path;
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });

      assert.equal(defaultProcess.killed, true);
      assert.equal(sidecarProcess.killed, true);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("escalates terminal shutdown to SIGKILL when process does not exit in time", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeFiber = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeFiber);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("publishes closed events when terminals are explicitly closed", () =>
    Effect.gen(function* () {
      const { manager, getEvents } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));

      yield* manager.close({ threadId: "thread-1" });

      const closedEvents = (yield* getEvents).filter(
        (event): event is Extract<TerminalEvent, { type: "closed" }> => event.type === "closed",
      );
      expect(closedEvents.map((event) => event.terminalId).sort()).toEqual(["default", "sidecar"]);
    }),
  );

  it.effect("evicts oldest inactive terminal sessions when retention limit is exceeded", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager(5, {
        maxRetainedInactiveSessions: 1,
      });

      yield* manager.open(openInput({ threadId: "thread-1" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      first.emitData("first-history\n");
      second.emitData("second-history\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir, "thread-1").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      first.emitExit({ exitCode: 0, signal: 0 });
      yield* Effect.sleep(Duration.millis(5));
      second.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) => events.filter((event) => event.type === "exited").length === 2,
        ),
      );

      const reopenedSecond = yield* manager.open(openInput({ threadId: "thread-2" }));
      const reopenedFirst = yield* manager.open(openInput({ threadId: "thread-1" }));

      assert.equal(reopenedFirst.history, "first-history\n");
      assert.equal(reopenedSecond.history, "");
    }),
  );

  it.effect("migrates legacy transcript filenames to terminal-scoped history path on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const path = yield* Path.Path;
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = yield* historyLogPath(logsDir);
      yield* writeFileString(legacyPath, "legacy-line\n");

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.history, "legacy-line\n");
      expect(yield* pathExists(nextPath)).toBe(true);
      expect(yield* readFileString(nextPath)).toBe("legacy-line\n");
      expect(yield* pathExists(legacyPath)).toBe(false);
    }),
  );

  it.effect("tail-loads and bounds oversized legacy history during migration", () =>
    Effect.gen(function* () {
      const historyByteLimit = 128;
      const { manager, logsDir } = yield* createManager(5_000, { historyByteLimit });
      const path = yield* Path.Path;
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = yield* historyLogPath(logsDir);
      yield* writeFileString(
        legacyPath,
        `${"discarded legacy output\n".repeat(2_048)}${"🙂".repeat(16)}retained-tail\n`,
      );

      const snapshot = yield* manager.open(openInput());

      expect(snapshot.history).toContain("[Earlier terminal output truncated]");
      expect(snapshot.history).toContain("retained-tail\n");
      expect(new TextEncoder().encode(snapshot.history).byteLength).toBeLessThanOrEqual(
        historyByteLimit,
      );
      expect(
        new TextEncoder().encode(yield* readFileString(nextPath)).byteLength,
      ).toBeLessThanOrEqual(historyByteLimit);
      expect(yield* pathExists(legacyPath)).toBe(false);
    }),
  );

  it.effect("retries with fallback shells when preferred shell spawn fails", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const missingShell =
        platform === "win32" ? "C:\\definitely\\missing-shell.exe" : "/definitely/missing-shell -l";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => missingShell,
      });
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe(
        platform === "win32" ? missingShell : "/definitely/missing-shell",
      );

      if (platform === "win32") {
        expect(
          ptyAdapter.spawnInputs.some(
            (input) =>
              input.shell === "pwsh.exe" ||
              input.shell === "powershell.exe" ||
              input.shell === "cmd.exe",
          ),
        ).toBe(true);
      } else {
        expect(
          ptyAdapter.spawnInputs
            .slice(1)
            .some((input) => input.shell !== "/definitely/missing-shell"),
        ).toBe(true);
      }
    }),
  );

  it.effect("prefers PowerShell over ComSpec for Windows terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(withHostPlatform("win32")));

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs[0]).toEqual(
        expect.objectContaining({
          shell: "pwsh.exe",
          args: ["-NoLogo"],
        }),
      );
    }),
  );

  it.effect("falls back to built-in PowerShell by absolute path on Windows", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "C:\\missing\\custom-shell.exe",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(withHostPlatform("win32")));
      ptyAdapter.spawnFailures.push(
        new Error("spawn custom-shell.exe ENOENT"),
        new Error("spawn pwsh.exe ENOENT"),
      );

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "C:\\missing\\custom-shell.exe",
        "pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]);
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(["-NoLogo"]);
      expect(ptyAdapter.spawnInputs[2]?.args).toEqual(["-NoLogo"]);
    }),
  );

  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PORT: "5173",
          T3CODE_PORT: "3773",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.T3CODE_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      // Arbitrary host env vars must pass through — terminals inherit the
      // user's environment apart from the explicit blocklist.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect(
    "injects thread-scoped Codex, Claude, and Grok awareness without persisting secrets",
    () =>
      Effect.gen(function* () {
        const revoked: string[] = [];
        const touched: string[] = [];
        const { manager, ptyAdapter, logsDir } = yield* createManager(5, {
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
          subprocessInspector: () =>
            Effect.succeed({
              hasRunningSubprocess: false,
              childCommand: null,
              processIds: [],
            }),
          subprocessPollIntervalMs: 20,
          issueTerminalAgentMcpCredential: ({ threadId }) =>
            Effect.succeed({
              environmentId: EnvironmentId.make("environment-terminal-test"),
              threadId: ThreadId.make(threadId),
              providerSessionId: "terminal-provider-session",
              providerInstanceId: ProviderInstanceId.make("solla-terminal-agent"),
              endpoint: "http://127.0.0.1:3773/mcp",
              authorizationHeader: "Bearer terminal-secret-token",
            }),
          revokeTerminalAgentMcpCredential: (providerSessionId) =>
            Effect.sync(() => {
              revoked.push(providerSessionId);
            }),
          touchTerminalAgentMcpCredential: (providerSessionId) =>
            Effect.sync(() => {
              touched.push(providerSessionId);
            }),
        });
        const path = yield* Path.Path;

        yield* manager.open(
          openInput({
            terminalId: "term-aware",
            env: { SOLLA_TERMINAL_MCP_BEARER_TOKEN: "client-spoofed-token" },
          }),
        );
        const spawnInput = ptyAdapter.spawnInputs[0];
        expect(spawnInput).toBeDefined();
        if (!spawnInput) return;

        const launcherDirectory = path.join(logsDir, ".agent-launchers");
        expect(spawnInput.env.PATH).toBe(`${launcherDirectory}:/usr/local/bin:/usr/bin:/bin`);
        expect(spawnInput.env.SOLLA_TERMINAL_MCP_ENDPOINT).toBe("http://127.0.0.1:3773/mcp");
        expect(spawnInput.env.SOLLA_TERMINAL_MCP_BEARER_TOKEN).toBe("terminal-secret-token");
        expect(spawnInput.env.SOLLA_TERMINAL_AGENT_CONTEXT).toContain(
          "thread thread-1 and terminal term-aware",
        );
        expect(spawnInput.env.GROK_CONFIG_PATH).toBe(
          path.join(launcherDirectory, "grok-config.toml"),
        );

        for (const provider of ["codex", "claude", "grok"]) {
          const launcher = yield* readFileString(path.join(launcherDirectory, provider));
          expect(launcher).not.toContain("terminal-secret-token");
        }
        const logPath = yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "term-aware").pipe(
          Effect.provideService(Path.Path, path),
        );
        const persistedLaunchContext = yield* readFileString(launchContextFilePath(logPath));
        expect(persistedLaunchContext).not.toContain("terminal-secret-token");
        expect(persistedLaunchContext).not.toContain("client-spoofed-token");
        expect(persistedLaunchContext).not.toContain("SOLLA_TERMINAL_MCP");

        yield* waitFor(
          Effect.sync(() => touched.includes("terminal-provider-session")),
          "1200 millis",
        );

        yield* manager.close({ threadId: "thread-1", terminalId: "term-aware" });
        expect(revoked).toEqual(["terminal-provider-session"]);
      }),
  );

  it.effect("strips AppImage runtime env from terminal sessions", () =>
    Effect.gen(function* () {
      const appDir = "/tmp/.mount_T3Codeabc123";
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          APPIMAGE: "/home/user/T3-Code.AppImage",
          APPDIR: appDir,
          ARGV0: "/home/user/T3-Code.AppImage",
          OWD: "/home/user/project",
          PATH: `${appDir}/usr/bin:${appDir}:/usr/local/bin:/usr/bin:/bin`,
          LD_LIBRARY_PATH: `${appDir}/usr/lib:/home/user/.local/lib`,
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      // AppImage runtime markers must never reach the PTY — tools inside the
      // terminal otherwise resolve against the AppImage mount (e.g. PHP_BINARY
      // reporting the AppImage path instead of the real binary).
      expect(spawnInput.env.APPIMAGE).toBeUndefined();
      expect(spawnInput.env.APPDIR).toBeUndefined();
      expect(spawnInput.env.ARGV0).toBeUndefined();
      expect(spawnInput.env.OWD).toBeUndefined();
      // PATH/LD_LIBRARY_PATH keep the user's real entries but drop the AppImage
      // mount segments that the runtime prepended.
      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      // Unrelated host vars still pass through untouched.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("leaves the environment untouched when not launched from an AppImage", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LD_LIBRARY_PATH: "/home/user/.local/lib",
          // Without APPIMAGE/APPDIR set, OWD is an ordinary variable and must
          // not be stripped — only an AppImage launch gives it special meaning.
          OWD: "/home/user/keep-this",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      expect(spawnInput.env.OWD).toBe("/home/user/keep-this");
    }),
  );

  it.effect("defaults CLAUDE_CODE_NO_FLICKER without clobbering a user value", () =>
    Effect.gen(function* () {
      // Claude Code's fullscreen renderer repaints in place instead of
      // appending frames to scrollback; terminals default it on.
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      });
      yield* manager.open(openInput());
      expect(ptyAdapter.spawnInputs[0]?.env.CLAUDE_CODE_NO_FLICKER).toBe("1");
      expect(ptyAdapter.spawnInputs[0]?.env.COLORTERM).toBe("truecolor");
      expect(ptyAdapter.spawnInputs[0]?.env.COLORFGBG).toBe("15;0");

      const { manager: optOutManager, ptyAdapter: optOutAdapter } = yield* createManager(5, {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", CLAUDE_CODE_NO_FLICKER: "0" },
      });
      yield* optOutManager.open(openInput());
      expect(optOutAdapter.spawnInputs[0]?.env.CLAUDE_CODE_NO_FLICKER).toBe("0");
    }),
  );

  it.effect("does not inherit macOS Terminal session restore into the PTY", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          TERM_SESSION_ID: "A82E6EC8-77C5-402B-8E26-44CA06B1E0F1",
        },
      });
      yield* manager.open(openInput());
      expect(ptyAdapter.spawnInputs[0]?.env.TERM_SESSION_ID).toBeUndefined();
      expect(ptyAdapter.spawnInputs[0]?.env.SHELL_SESSIONS_DISABLE).toBe("1");
    }),
  );

  it.effect("injects runtime env overrides into spawned terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(
        openInput({
          env: {
            T3CODE_PROJECT_ROOT: "/repo",
            T3CODE_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      assert.equal(spawnInput.env.T3CODE_PROJECT_ROOT, "/repo");
      assert.equal(spawnInput.env.T3CODE_WORKTREE_PATH, "/repo/worktree-a");
      assert.equal(spawnInput.env.CUSTOM_FLAG, "1");
    }),
  );

  it.effect("starts zsh with prompt spacer disabled to avoid `%` end markers", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);
    }),
  );

  it.effect("bridges PTY callbacks back into Effect-managed event streaming", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from callback\n");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "hello from callback\n"),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("pushes PTY callbacks to direct event subscribers", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(subscriberEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from subscriber\n");

      yield* waitFor(
        Effect.map(Ref.get(subscriberEvents), (events) =>
          events.some(
            (event) => event.type === "output" && event.data === "hello from subscriber\n",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("byte-bounds output queued behind a slow subscriber and reports truncation", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5_000, {
        pendingProcessEventByteLimit: 128,
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const subscriberEntered = yield* Deferred.make<void>();
      const releaseSubscriber = yield* Deferred.make<void>();
      let shouldBlock = true;
      const unsubscribe = yield* manager.subscribe((event) => {
        if (event.type !== "output" || !shouldBlock) return Effect.void;
        shouldBlock = false;
        return Deferred.succeed(subscriberEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSubscriber)),
        );
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("blocking-output\n");
      yield* Deferred.await(subscriberEntered);
      for (let index = 0; index < 40; index += 1) {
        process.emitData(`queued-${index.toString().padStart(2, "0")}-${"x".repeat(12)}\n`);
      }
      yield* Deferred.succeed(releaseSubscriber, undefined);

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data.includes("queued-39-")),
        ),
        "1200 millis",
      );

      const emittedOutput = (yield* getEvents)
        .filter(
          (event): event is Extract<TerminalEvent, { type: "output" }> => event.type === "output",
        )
        .map((event) => event.data)
        .join("");
      expect(emittedOutput).toContain("Terminal output truncated because the consumer fell behind");
      expect(emittedOutput).toContain("queued-39-");
      expect(emittedOutput).not.toContain("queued-00-");
    }),
  );

  it.effect("subscribes terminal metadata with an initial snapshot and live deltas", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const metadataEvents = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(metadataEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const initialEvents = yield* Ref.get(metadataEvents);
      expect(initialEvents[0]).toMatchObject({
        type: "snapshot",
        terminals: [
          {
            threadId: "existing-thread",
            terminalId: DEFAULT_TERMINAL_ID,
          },
        ],
      });

      yield* manager.open(openInput({ threadId: "new-thread" }));

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "upsert" &&
              event.terminal.threadId === "new-thread" &&
              event.terminal.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );

      yield* manager.close({ threadId: "new-thread", terminalId: DEFAULT_TERMINAL_ID });

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "remove" &&
              event.threadId === "new-thread" &&
              event.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("removes terminal metadata subscriptions when initial delivery fails", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const leakedLiveEvents = yield* Ref.make(0);
      const exit = yield* Effect.exit(
        manager.subscribeMetadata((event) =>
          event.type === "snapshot"
            ? Effect.die("snapshot listener failed")
            : Ref.update(leakedLiveEvents, (count) => count + 1),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      yield* manager.open(openInput({ threadId: "new-thread" }));
      expect(yield* Ref.get(leakedLiveEvents)).toBe(0);
    }),
  );

  it.effect(
    "streams attach snapshots followed by live events without duplicate start snapshots",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, {
          ptyAdapter: new FakePtyAdapter("async"),
        });
        const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
        const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
          Ref.update(attachEvents, (events) => [...events, event]),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        expect(yield* Ref.get(attachEvents)).toMatchObject([
          {
            type: "snapshot",
            snapshot: {
              threadId: "thread-1",
              terminalId: DEFAULT_TERMINAL_ID,
            },
          },
        ]);

        process.emitData("hello from attach\n");

        yield* waitFor(
          Effect.map(Ref.get(attachEvents), (events) =>
            events.some((event) => event.type === "output" && event.data === "hello from attach\n"),
          ),
          "1200 millis",
        );

        const events = yield* Ref.get(attachEvents);
        expect(events.filter((event) => event.type === "snapshot")).toHaveLength(1);
      }),
  );

  it.effect("buffers attach output delivered during the initial snapshot callback", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      yield* manager.open(openInput());

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Effect.gen(function* () {
          yield* Ref.update(attachEvents, (events) => [...events, event]);
          if (event.type === "snapshot") {
            yield* Effect.sync(() => process.emitData("during snapshot\n"));
            yield* Effect.yieldNow;
          }
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* waitFor(
        Effect.map(Ref.get(attachEvents), (events) =>
          events.some((event) => event.type === "output" && event.data === "during snapshot\n"),
        ),
        "1200 millis",
      );

      expect(yield* Ref.get(attachEvents)).toMatchObject([
        { type: "snapshot" },
        { type: "output", data: "during snapshot\n" },
      ]);
    }),
  );

  it.effect("preserves queued PTY output ordering through exit callbacks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      process.emitData("second\n");
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const relevant = events.filter(
            (event) => event.type === "output" || event.type === "exited",
          );
          return relevant.length >= 3;
        }),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "first\n", sequence: 2 }),
        expect.objectContaining({ type: "output", data: "second\n", sequence: 3 }),
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0, sequence: 4 }),
      ]);

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      expect(snapshot.snapshot.sequence).toBe(4);
    }),
  );

  it.effect("scoped runtime shutdown stops active terminals cleanly", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10,
        subprocessInspector: () =>
          Effect.succeed({
            hasRunningSubprocess: false,
            childCommand: null,
            processIds: [],
          }),
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeScope = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeScope);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("captures a newly started agent CLI during shutdown", () =>
    Effect.gen(function* () {
      const fs = yield* Effect.service(FileSystem.FileSystem);
      const path = yield* Path.Path;
      const preparedDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-terminal-shutdown-resume-",
      });
      const logsDir = path.join(preparedDir, "terminals");
      yield* makeDirectory(logsDir);
      const logPath = yield* historyLogPath(logsDir).pipe(Effect.provideService(Path.Path, path));
      const resumePath = resumeStateFilePath(logPath);
      const firstPollStarted = yield* Deferred.make<void>();
      const holdFirstPoll = yield* Deferred.make<void>();
      let inspectCalls = 0;

      const scope = yield* Scope.make("sequential");
      const { manager } = yield* createManager(5, {
        logsDir,
        processKillGraceMs: 1,
        subprocessPollIntervalMs: 1,
        subprocessInspector: () =>
          Effect.gen(function* () {
            inspectCalls += 1;
            if (inspectCalls === 1) {
              yield* Deferred.succeed(firstPollStarted, undefined);
              yield* Deferred.await(holdFirstPoll);
              return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
            }
            return {
              hasRunningSubprocess: true,
              childCommand: "grok",
              processIds: [100, 101],
              processArgs: "grok --resume sess-shutdown",
            };
          }),
        resolveAgentCliSessionId: () => Effect.succeed("sess-shutdown"),
      }).pipe(Effect.provideService(Scope.Scope, scope));

      yield* manager.open(openInput());
      yield* Deferred.await(firstPollStarted).pipe(Effect.timeout("2 seconds"));

      // Close while the ordinary poll is deliberately still in flight. The
      // shutdown pass must independently capture the CLI and its session ID.
      yield* Scope.close(scope, Exit.void);

      expect(inspectCalls).toBeGreaterThanOrEqual(2);
      expect(parseAgentCliResumeState(yield* readFileString(resumePath))).toEqual({
        command: "grok",
        sessionId: "sess-shutdown",
        resumeOnRestore: true,
      });
    }),
  );
});
