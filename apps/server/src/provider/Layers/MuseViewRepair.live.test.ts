// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { makeMuseAdapter } from "./MuseAdapter.ts";

/**
 * Real MSP item frames with transport loss, without a model request. The proxy
 * substitutes userShell for turn/start and supplies only its admission id;
 * Muse itself executes printf and stores/serves the item lifecycle and output.
 */
describe.skipIf(process.env["T3_LIVE_MUSE_VIEW"] !== "1")("Muse real view repair", () => {
  it.live("recovers a real hidden shell result through the owning host page", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-muse-real-view-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const proxy = NodePath.join(dir, "proxy");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          proxy,
          `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const child = spawn(process.env.MUSE_REAL_BINARY, ['serve', '--disable-sandbox'], { stdio: ['pipe','pipe','inherit'] });
let turnRequest = null;
let turnId = null;
const log = value => fs.appendFileSync(process.env.MUSE_PROXY_LOG, JSON.stringify(value)+'\\n');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line); log({direction:'request',method:m.method});
 if (m.method === 'initialize') m.params.capabilities.requestedCapabilities.push('userShell');
 if (m.method === 'turn/start') {
  turnRequest = m.id; turnId = m.params.commandId;
  m.method = 'session/userShell';
  m.params = {commandId:turnId,sessionId:m.params.sessionId,commandText:'printf SOLLA_REAL_VIEW_REPAIR'};
 }
 child.stdin.write(JSON.stringify(m)+'\\n');
});
readline.createInterface({input:child.stdout}).on('line', line => {
 const m = JSON.parse(line);
 if (m.id === turnRequest && m.result) m.result = {...m.result,turnId,startedNewTurn:true,disposition:'started'};
 if (m.method?.startsWith('item/') && turnId) {log({direction:'dropped',method:m.method});return;}
 if (m.result?.events) log({direction:'page',methods:m.result.events.map(e=>e.method)});
 send(m);
});
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM',stop); process.on('SIGINT',stop); process.stdin.on('end',stop);
child.on('exit',code=>process.exit(code || 0));
`,
          { mode: 0o755 },
        ),
      );
      const log = NodePath.join(dir, "proxy.jsonl");
      const adapter = yield* makeMuseAdapter({
        instanceId: ProviderInstanceId.make("real-view-probe"),
        binaryPath: proxy,
        cwd: dir,
        environment: {
          ...process.env,
          MUSE_REAL_BINARY: NodePath.join(NodeOS.homedir(), ".local/bin/muse"),
          MUSE_PROXY_LOG: log,
        },
        turnHealth: {
          checkIntervalMs: 20,
          thresholds: {
            reconcileMs: 100,
            modelSilenceMs: 10_000,
            toolSilenceMs: 10_000,
            retryBudgetMs: 10_000,
          },
        },
      });
      const result = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          if (event.type === "item.completed" && event.payload.itemType === "command_execution")
            return Deferred.succeed(result, event);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      const threadId = ThreadId.make("real-muse-view-repair");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({
        threadId,
        input: "proxy replaces this with printf, never a model turn",
      });
      const recovered = yield* Deferred.await(result);
      expect(recovered.type).toBe("item.completed");
      if (recovered.type === "item.completed")
        expect(recovered.payload).toMatchObject({
          status: "completed",
          detail: "SOLLA_REAL_VIEW_REPAIR",
        });
      const records = (yield* Effect.promise(() => NodeFSP.readFile(log, "utf8")))
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { direction: string; method?: string; methods?: string[] },
        );
      expect(
        records.some(
          (record) => record.direction === "dropped" && record.method === "item/completed",
        ),
      ).toBe(true);
      expect(
        records.some(
          (record) => record.direction === "page" && record.methods?.includes("item/completed"),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
