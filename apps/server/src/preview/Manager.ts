/**
 * In-memory PreviewManager implementation.
 *
 * Sessions are keyed by `(threadId, tabId)`; a single thread can host
 * multiple tabs (browser-style). `open` always creates a new tab, while
 * closing the final tab replaces it with a fresh blank tab so an established
 * thread never loses its browser surface entirely.
 *
 * Events are published via Effect's `PubSub`, so subscriber failures are
 * isolated from the publishing call (a closed WS subscriber queue cannot
 * fail an in-progress `navigate()`).
 */
import {
  type PreviewCloseInput,
  type PreviewCloseResult,
  type PreviewEvent,
  type PreviewError,
  PreviewInvalidUrlError,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewNavigateInput,
  type PreviewOpenInput,
  type PreviewRefreshInput,
  type PreviewReportStatusInput,
  type PreviewResizeInput,
  FILL_PREVIEW_VIEWPORT,
  PreviewSessionLookupError,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { isPreviewUrlNormalizationError, normalizePreviewUrl } from "@t3tools/shared/preview";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { PreviewSessionStore } from "../persistence/Services/PreviewSessions.ts";

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly open: (input: PreviewOpenInput) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly navigate: (
      input: PreviewNavigateInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly reportStatus: (input: PreviewReportStatusInput) => Effect.Effect<void, PreviewError>;
    readonly resize: (
      input: PreviewResizeInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly refresh: (input: PreviewRefreshInput) => Effect.Effect<void, PreviewError>;
    readonly close: (
      input: PreviewCloseInput,
    ) => Effect.Effect<PreviewCloseResult | undefined, PreviewError>;
    readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;
    readonly events: Stream.Stream<PreviewEvent>;
    readonly subscribeEvents: Effect.Effect<PubSub.Subscription<PreviewEvent>, never, Scope.Scope>;
  }
>()("t3/preview/Manager/PreviewManager") {}

interface PreviewSessionState {
  readonly threadId: string;
  readonly tabId: string;
  readonly snapshot: PreviewSessionSnapshot;
}

interface ManagerState {
  /** All sessions across every thread, keyed by `${threadId}\u0000${tabId}`. */
  readonly sessions: ReadonlyMap<string, PreviewSessionState>;
  /** Global monotonic revision establishing list/event ordering. */
  readonly revision: number;
}

const initialState: ManagerState = { sessions: new Map(), revision: 0 };

type PreviewEventDraft = PreviewEvent extends infer Event
  ? Event extends { readonly revision: number }
    ? Omit<Event, "revision" | "serverEpoch">
    : never
  : never;

const compositeKey = (threadId: string, tabId: string): string => `${threadId}\u0000${tabId}`;

const sessionsForThread = (
  state: ManagerState,
  threadId: string,
): ReadonlyArray<PreviewSessionState> => {
  const out: PreviewSessionState[] = [];
  for (const session of state.sessions.values()) {
    if (session.threadId === threadId) out.push(session);
  }
  return out;
};

// A tab identity is also a cleanup capability. Never derive it from the live
// set: otherwise closing tab_2 and opening again can reuse tab_2, allowing a
// delayed close for the old page to destroy the unrelated replacement.
const createPreviewTabId = (): string => `tab_${NodeCrypto.randomUUID()}`;

const normalizeUrl = (rawUrl: string): Effect.Effect<string, PreviewInvalidUrlError> =>
  Effect.try({
    try: () => normalizePreviewUrl(rawUrl),
    catch: (cause) => {
      if (isPreviewUrlNormalizationError(cause)) {
        return new PreviewInvalidUrlError({
          inputLength: cause.inputLength,
          reason: cause.reason,
          protocol: cause.protocol,
          cause,
        });
      }

      return new PreviewInvalidUrlError({
        inputLength: rawUrl.length,
        reason: "unexpected",
        cause,
      });
    },
  });

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const buildLoadingSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly updatedAt: string;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId,
  tabId: input.tabId,
  navStatus: { _tag: "Loading", url: input.url, title: input.title },
  canGoBack: false,
  canGoForward: false,
  viewport: FILL_PREVIEW_VIEWPORT,
  updatedAt: input.updatedAt,
});

const buildIdleSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly updatedAt: string;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId,
  tabId: input.tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  viewport: FILL_PREVIEW_VIEWPORT,
  updatedAt: input.updatedAt,
});

export const make = Effect.gen(function* PreviewManagerMake() {
  const serverEpoch = NodeCrypto.randomUUID();
  const sessionStore = yield* PreviewSessionStore;
  // Rehydrate tabs persisted by the previous process so a restart does not
  // silently drop every open tab (clients keep their browser surfaces across
  // restarts and would otherwise render dead webviews). Restored snapshots,
  // including blank Idle tabs, keep their stored state; the renderer
  // re-attaches and reloads pages that have a URL.
  const restoredSessions = yield* sessionStore
    .listAll()
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("preview.session-restore-failed", { cause }).pipe(Effect.as([])),
      ),
    );
  const restoredState: ManagerState = {
    sessions: new Map(
      restoredSessions.map((session) => [
        compositeKey(session.threadId, session.tabId),
        {
          threadId: session.threadId,
          tabId: session.tabId,
          snapshot: session.snapshot,
        } satisfies PreviewSessionState,
      ]),
    ),
    revision: 0,
  };
  const stateRef = yield* SynchronizedRef.make<ManagerState>(restoredState);

  const listResultForState = (state: ManagerState, threadId: string) => ({
    sessions: sessionsForThread(state, threadId)
      .map((session) => session.snapshot)
      .toSorted((left, right) => left.updatedAt.localeCompare(right.updatedAt)),
    serverEpoch,
    revision: state.revision,
  });
  const closeResultForState = (
    state: ManagerState,
    threadId: string,
    closedTabIds: ReadonlyArray<string>,
  ): PreviewCloseResult => ({
    ...listResultForState(state, threadId),
    closedTabIds,
  });

  // Durability is best-effort decoration: a persistence hiccup may never fail
  // the live operation that triggered it.
  const persistSnapshot = (snapshot: PreviewSessionSnapshot) =>
    sessionStore
      .upsert({
        threadId: snapshot.threadId,
        tabId: snapshot.tabId,
        snapshot,
        updatedAt: snapshot.updatedAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("preview.session-persist-failed", { cause }),
        ),
      );
  const unpersistSession = (threadId: string, tabId: string) =>
    sessionStore
      .deleteSession({ threadId, tabId })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("preview.session-unpersist-failed", { cause }),
        ),
      );
  // Unbounded PubSub is fine here — events are tiny and we don't want to
  // block publishers if a subscriber is slow. WS clients backpressure on
  // their own queues downstream.
  const eventsPubSub = yield* PubSub.unbounded<PreviewEvent>();
  const events: Stream.Stream<PreviewEvent> = Stream.fromPubSub(eventsPubSub);

  /**
   * Atomic read-modify-write over the session for `(threadId, tabId)`. The
   * mutator runs under the SynchronizedRef so concurrent writers cannot
   * interleave. Lookup failures travel through the modify result so both
   * branches yield the same `[A, S]` shape `modifyEffect` requires.
   *
   * The event is published INSIDE the lock so observers see events in the
   * same order as the underlying state transitions. Publishing an unbounded
   * PubSub is non-blocking, so this is cheap.
   */
  const mutateExistingSession = <R, E>(
    threadId: string,
    tabId: string,
    mutator: (session: PreviewSessionState) => Effect.Effect<
      {
        next: PreviewSessionState;
        emit: PreviewEventDraft | null;
        persist: boolean;
        result: R;
      },
      E
    >,
  ): Effect.Effect<R, E | PreviewSessionLookupError> => {
    type ModifyResult =
      | { kind: "fail"; error: PreviewSessionLookupError }
      | { kind: "ok"; result: R };

    return SynchronizedRef.modifyEffect(stateRef, (state) => {
      const session = state.sessions.get(compositeKey(threadId, tabId));
      if (!session) {
        return Effect.succeed([
          { kind: "fail", error: new PreviewSessionLookupError({ threadId, tabId }) },
          state,
        ] as readonly [ModifyResult, ManagerState]);
      }
      return mutator(session).pipe(
        Effect.flatMap(
          Effect.fn("PreviewManager.commitMutation")(function* ({ next, emit, persist, result }) {
            const revision = emit ? state.revision + 1 : state.revision;
            // Persistence shares the state mutation's ordering boundary. If a
            // delayed status write escapes this lock, it can land after close
            // deletes the row and resurrect that tab on the next restart.
            if (persist) {
              yield* persistSnapshot(next.snapshot);
            }
            if (emit) {
              yield* PubSub.publish(eventsPubSub, {
                ...emit,
                revision,
                serverEpoch,
              } as PreviewEvent);
            }
            const sessions = new Map(state.sessions);
            sessions.set(compositeKey(threadId, tabId), next);
            return [{ kind: "ok", result } as ModifyResult, { sessions, revision }] as readonly [
              ModifyResult,
              ManagerState,
            ];
          }),
        ),
      );
    }).pipe(
      Effect.flatMap((modify) =>
        modify.kind === "fail" ? Effect.fail(modify.error) : Effect.succeed(modify.result),
      ),
    );
  };

  const open: PreviewManager["Service"]["open"] = Effect.fn("PreviewManager.open")(
    function* (input) {
      const updatedAt = yield* currentIsoTimestamp;
      const url = input.url ? yield* normalizeUrl(input.url) : null;
      // Allocate a non-reused identity inside the ordered mutation. A
      // process-global counter here once reset on every server restart and
      // handed out "tab_1" again, silently replacing sessions rehydrated from
      // SQLite.
      const snapshot = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.gen(function* () {
          const tabId = createPreviewTabId();
          const snapshot = url
            ? buildLoadingSnapshot({ threadId: input.threadId, tabId, url, title: "", updatedAt })
            : buildIdleSnapshot({ threadId: input.threadId, tabId, updatedAt });
          const revision = state.revision + 1;
          const sessions = new Map(state.sessions);
          sessions.set(compositeKey(input.threadId, tabId), {
            threadId: input.threadId,
            tabId,
            snapshot,
          });
          yield* persistSnapshot(snapshot);
          yield* PubSub.publish(eventsPubSub, {
            type: "opened",
            threadId: input.threadId,
            tabId,
            createdAt: snapshot.updatedAt,
            serverEpoch,
            revision,
            snapshot,
          });
          return [snapshot, { sessions, revision }] as const;
        }),
      );
      return snapshot;
    },
  );

  const navigate: PreviewManager["Service"]["navigate"] = Effect.fn("PreviewManager.navigate")(
    function* (input) {
      const url = yield* normalizeUrl(input.url);
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.navigateSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const previousTitle =
            session.snapshot.navStatus._tag === "Idle" ? "" : session.snapshot.navStatus.title;
          const resolvedTitle = input.resolvedTitle ?? previousTitle;
          const snapshot: PreviewSessionSnapshot = {
            threadId: session.threadId,
            tabId: session.tabId,
            navStatus: { _tag: "Success", url, title: resolvedTitle },
            canGoBack: session.snapshot.canGoBack,
            canGoForward: session.snapshot.canGoForward,
            viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
            updatedAt,
          };
          return {
            next: { ...session, snapshot },
            emit: {
              type: "navigated",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            persist: true,
            result: snapshot,
          };
        }),
      );
    },
  );

  const reportStatus: PreviewManager["Service"]["reportStatus"] = Effect.fn(
    "PreviewManager.reportStatus",
  )(function* (input) {
    yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.reportSessionStatus")(function* (session) {
        const updatedAt = yield* currentIsoTimestamp;
        const snapshot: PreviewSessionSnapshot = {
          threadId: session.threadId,
          tabId: session.tabId,
          navStatus: input.navStatus,
          canGoBack: input.canGoBack,
          canGoForward: input.canGoForward,
          viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
          updatedAt,
        };
        const emit: PreviewEventDraft =
          input.navStatus._tag === "LoadFailed"
            ? {
                type: "failed",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                url: input.navStatus.url,
                title: input.navStatus.title,
                code: input.navStatus.code,
                description: input.navStatus.description,
              }
            : {
                type: "navigated",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                snapshot,
              };
        return {
          next: { ...session, snapshot },
          emit,
          persist: snapshot.navStatus._tag === "Success",
          result: snapshot,
        };
      }),
    ).pipe(Effect.asVoid);
  });

  const resize: PreviewManager["Service"]["resize"] = Effect.fn("PreviewManager.resize")(
    function* (input) {
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.resizeSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const snapshot: PreviewSessionSnapshot = {
            ...session.snapshot,
            viewport: input.viewport,
            updatedAt,
          };
          return {
            next: { ...session, snapshot },
            emit: {
              type: "resized",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            persist: true,
            result: snapshot,
          };
        }),
      );
    },
  );

  const refresh: PreviewManager["Service"]["refresh"] = Effect.fn("PreviewManager.refresh")(
    function* (input) {
      // Verify the session exists; the desktop bridge handles the actual reload
      // and will report progress back via `reportStatus`. No event emitted.
      yield* mutateExistingSession(input.threadId, input.tabId, (session) =>
        Effect.succeed({ next: session, emit: null, persist: false, result: undefined as void }),
      );
    },
  );

  const close: PreviewManager["Service"]["close"] = Effect.fn("PreviewManager.close")(
    function* (input) {
      const createdAt = yield* currentIsoTimestamp;
      return yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
        const eventsToEmit: PreviewEvent[] = [];
        const sessions = new Map(state.sessions);
        const targets = input.tabId
          ? [state.sessions.get(compositeKey(input.threadId, input.tabId))].filter(
              (entry): entry is PreviewSessionState => entry !== undefined,
            )
          : sessionsForThread(state, input.threadId);
        if (targets.length === 0) {
          if (input.tabId) {
            return Effect.fail(
              new PreviewSessionLookupError({ threadId: input.threadId, tabId: input.tabId }),
            );
          }
          return Effect.succeed([closeResultForState(state, input.threadId, []), state] as const);
        }

        let revision = state.revision;
        for (const target of targets) {
          revision += 1;
          sessions.delete(compositeKey(target.threadId, target.tabId));
          eventsToEmit.push({
            type: "closed",
            threadId: target.threadId,
            tabId: target.tabId,
            createdAt,
            serverEpoch,
            revision,
          });
        }

        let replacement: PreviewSessionSnapshot | null = null;
        const threadStillHasTab = Array.from(sessions.values()).some(
          (session) => session.threadId === input.threadId,
        );
        if (!threadStillHasTab) {
          // Allocate from the pre-close state so the replacement can never
          // reuse the identity of the tab that was just closed.
          const tabId = createPreviewTabId();
          replacement = buildIdleSnapshot({
            threadId: input.threadId,
            tabId,
            updatedAt: createdAt,
          });
          sessions.set(compositeKey(input.threadId, tabId), {
            threadId: input.threadId,
            tabId,
            snapshot: replacement,
          });
          revision += 1;
          eventsToEmit.push({
            type: "opened",
            threadId: input.threadId,
            tabId,
            createdAt,
            serverEpoch,
            revision,
            snapshot: replacement,
          });
        }

        return Effect.gen(function* () {
          // Persist close in the same serialized order as the live state.
          // Besides keeping the blank-tab invariant durable, this prevents a
          // concurrent older status write or close from re-inserting a row we
          // have already removed.
          if (replacement) {
            yield* persistSnapshot(replacement);
          }
          yield* Effect.forEach(
            targets,
            (target) => unpersistSession(target.threadId, target.tabId),
            { discard: true },
          );
          yield* Effect.forEach(eventsToEmit, (event) => PubSub.publish(eventsPubSub, event), {
            discard: true,
          });
          const nextState = { sessions, revision };
          return [
            closeResultForState(
              nextState,
              input.threadId,
              targets.map((target) => target.tabId),
            ),
            nextState,
          ] as const;
        });
      });
    },
  );

  const list: PreviewManager["Service"]["list"] = Effect.fn("PreviewManager.list")(
    function* (input) {
      return yield* SynchronizedRef.get(stateRef).pipe(
        Effect.map((state): PreviewListResult => listResultForState(state, input.threadId)),
      );
    },
  );

  return PreviewManager.of({
    open,
    navigate,
    reportStatus,
    resize,
    refresh,
    close,
    list,
    events,
    subscribeEvents: PubSub.subscribe(eventsPubSub),
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
