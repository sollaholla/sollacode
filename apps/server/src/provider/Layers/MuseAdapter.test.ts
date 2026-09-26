// @effect-diagnostics nodeBuiltinImport:off
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { makeMuseAdapter } from "./MuseAdapter.ts";

const threadId = ThreadId.make("muse-test-thread");
const instanceId = ProviderInstanceId.make("muse-test-instance");

/**
 * A stand-in `muse serve` that speaks MSP.
 *
 * It enforces the rules the real binary enforces and that nothing in the
 * schema states: the client name must be a machine identifier, every
 * `commandId` must be a UUIDv7, and no command is answered until the client
 * has sent the `initialized` notification. A regression on any of those would
 * otherwise only show up against the real CLI.
 */
async function fixture() {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-muse-test-"));
  const binaryPath = NodePath.join(dir, "muse");
  const recordPath = NodePath.join(dir, "calls.jsonl");
  await NodeFSP.writeFile(
    binaryPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const record = (value) => fs.appendFileSync(process.env.MUSE_TEST_CALLS, JSON.stringify(value) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let initialized = false;
let gapPageValue = [];
let ownsSession = false;
let pendingApprovalTurnId = null;
let ignoreInterrupt = false;
let durableTurn = process.env.MUSE_TEST_DURABLE_TURN;
let paginatedTurn = null;
let pageNumber = 0;
let raceMode = null;
let racePageNumber = 0;
const sharedPage = process.env.MUSE_TEST_CALLS + '.page';
Object.defineProperty(globalThis, 'gapPage', {
 get: () => gapPageValue,
 set: value => { gapPageValue = value; fs.writeFileSync(sharedPage, JSON.stringify({events:value, raceMode})); }
});
const durableEvents = () => [
 {method:'item/started',params:{sessionId:SESSION,viewCursor:'v:10',item:{itemId:'durable-tool',turnId:durableTurn,kind:'toolCall',tool:'bash',args:'{}',status:'inProgress',revision:1}}},
 {method:'item/completed',params:{sessionId:SESSION,viewCursor:'v:20',item:{itemId:'durable-tool',turnId:durableTurn,kind:'toolCall',tool:'bash',visibleOutput:'Durable tool',status:'completed',revision:2}}},
 {method:'item/completed',params:{sessionId:SESSION,viewCursor:'v:30',item:{itemId:'durable-answer',turnId:durableTurn,recordedAt:'2026-09-13T20:00:00.000000Z',kind:'agentMessage',text:'Durable answer',status:'completed',revision:1}}},
 {method:'session/tokenUsage',params:{sessionId:SESSION,viewCursor:'v:40',turnId:durableTurn,modelId:'muse-spark-1.3-contributor',promptTokens:1000000,usage:{outputTokens:0}}},
 {method:'turn/completed',params:{sessionId:SESSION,viewCursor:'v:50',turnId:durableTurn,terminal:'completed'}},
];
const SESSION = '01a08e93-71a6-7370-9242-de67bd5e466a';
// A session the host still has on disk; every other cursor is stale.
const RESUMABLE = '01a08e93-2222-7222-8222-222222222222';
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    record({ method: message.method, params: message.params, hostArgs: process.argv.slice(2), hostPid: process.pid });
    if (message.method === 'initialized') { initialized = true; continue; }
    if (message.method === 'initialize') {
      if (!/^[a-z0-9_]+$/.test(message.params.clientInfo.name)) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'clientInfo.name must be a machine identifier', data: { kind: 'invalidParams' } } });
        continue;
      }
      send({ jsonrpc: '2.0', id: message.id, result: { schema: { version: 1, fingerprint: 'sha256:test' }, serverInfo: { name: 'muse', version: '1.1.1' }, museHome: '/tmp/muse', platformOs: 'macos', platformFamily: 'unix', experimentalApi: false, grantedCapabilities: process.env.MUSE_TEST_NO_SESSION_MCP ? [] : ["sessionMcp"], userAgent: 'muse-test' } });
      continue;
    }
    if (!initialized) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Not initialized', data: { kind: 'notInitialized' } } });
      continue;
    }
    if (message.params && message.params.commandId && !UUID_V7.test(message.params.commandId)) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'expected UUIDv7', data: { kind: 'invalidParams' } } });
      continue;
    }
    if (message.method === 'session/resume') {
      ownsSession = true;
      if (message.params.sessionId !== RESUMABLE && !(durableTurn && message.params.sessionId === SESSION)) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown session', data: { kind: 'sessionNotFound' } } });
        continue;
      }
      record({ method: 'session/resume:served', params: { history: message.params.history } });
      if (durableTurn) {
        send({jsonrpc:'2.0',id:message.id,result:{session:{sessionId:SESSION,status:'idle',activeTurnId:null},viewCursor:'v:50',history:{mode:'none'}}});continue;
      }
      send({ jsonrpc: '2.0', id: message.id, result: { session: { sessionId: RESUMABLE, status: 'idle', activeTurnId: null }, viewCursor: 'v:40', pendingRequests: [], history: { mode: 'snapshot', items: null, snapshot: { schemaVersion: 1, viewCursor: 'v:40', state: { activeTurn: null, items: [], queuedTurns: [], pendingApprovals: [], pendingUserInputs: [], turnCount: 3, tokenUsage: { promptTokens: 400000, outputTokens: 9000, totalTokens: 409000 }, contextUsage: { pressure: 'normal', usedTokens: 120000, windowTokens: 272000 } } } } } });
      continue;
    }
    if (message.method === 'session/start') {
      ownsSession = true;
      send({ jsonrpc: '2.0', id: message.id, result: { session: { sessionId: SESSION, status: 'idle', activeTurnId: null }, viewCursor: 'v:0' } });
      continue;
    }
    if (message.method === 'view/subscribe') {
      if (process.env.MUSE_TEST_SUBSCRIBE_ERROR) {
        const detail = process.env.MUSE_TEST_SUBSCRIBE_ERROR === 'sidecar' ? 'internal error: view/subscribe: session ' + message.params.sessionId + ' is loaded without a live view attachment (no materialized sidecar), so it cannot be live-tailed; use view/page for point-in-time reads' : process.env.MUSE_TEST_SUBSCRIBE_ERROR === 'anchor' ? 'notFound: unknown cursor anchor' : 'authorization denied';
        send({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:detail}});continue;
      }
      send({ jsonrpc: '2.0', id: message.id, result: { viewCursor: message.params.after || 'v:0' } });
      // Replay the same durable page to prove repairs do not duplicate events.
      if (process.env.MUSE_TEST_REPLAY_PAGE) for (const event of gapPage) send({ jsonrpc: '2.0', ...event });
      continue;
    }
    if (message.method === 'model/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { models: [
        { modelId: 'muse-spark-1.3-contributor', displayLabel: 'Muse Spark 1.3', contextLimit: 272000, outputLimit: 32000, providerId: 'meta', profileId: null, description: null, releaseDate: null, isActive: false, isDefault: true, cost: { input: '1.00', output: '5.00', cachedInput: '0.10', currency: 'USD' } },
        { modelId: 'muse-free', displayLabel: 'Muse Free', contextLimit: 128000, outputLimit: 8000, providerId: 'meta', profileId: null, description: null, releaseDate: null, isActive: false, isDefault: false, cost: null },
      ] } });
      continue;
    }
    if (message.method === 'view/page') {
      if (process.env.MUSE_TEST_STORED_REPAIR) {
        const head = message.params.cursor ? Number(message.params.cursor.slice(2)) - 1 : 6200;
        const first = Math.max(1, head - message.params.limit + 1);
        const events = Array.from({length: head-first+1},(_,i)=>{
          const n=first+i;
          if(n===5800 || n===6100) return {method:'item/completed',params:{sessionId:SESSION,viewCursor:'v:'+n,item:{itemId:'stored-'+n,turnId:'stored-turn',recordedAt:n===5800?'2026-09-13T19:59:00.000Z':'2026-09-13T20:00:00.000Z',kind:'agentMessage',status:'completed',text:n===5800?'Saved progress':'Saved final'}}};
          if(n===6150) return {method:'item/completed',params:{sessionId:SESSION,viewCursor:'v:'+n,item:{itemId:'incomplete-tail',turnId:'stored-turn',kind:'agentMessage',status:'failed',reason:'incomplete',text:'Do not deliver'}}};
          if(n===6160) return {method:'item/completed',params:{sessionId:SESSION,viewCursor:'v:'+n,item:{itemId:'unscoped',kind:'agentMessage',status:'completed',text:'Do not guess turn'}}};
          return {method:'session/tokenUsage',params:{sessionId:SESSION,viewCursor:'v:'+n,turnId:'stored-turn',usage:{outputTokens:1}}};
        });
        send({jsonrpc:'2.0',id:message.id,result:{events,nextCursor:first>1?'v:'+first:null}});continue;
      }

      if (ownsSession && process.env.MUSE_TEST_FROZEN_OWNER) {
        send({jsonrpc:'2.0',id:message.id,result:{events:[],nextCursor:null}});continue;
      }
      if (!ownsSession && fs.existsSync(sharedPage)) {
        const shared = JSON.parse(fs.readFileSync(sharedPage, 'utf8'));
        gapPageValue = shared.events; raceMode = shared.raceMode;
      }
      if (raceMode === 'final page failure') {
        send({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'page read unavailable'}});continue;
      }
      if (raceMode && message.params.direction !== 'backward') {
        racePageNumber += 1;
        if (raceMode === 'mutable item tail' && racePageNumber === 1) {
          send({jsonrpc:'2.0',id:message.id,result:{events:[
            {method:'item/completed',params:{sessionId:SESSION,viewCursor:'v:1559',item:{itemId:'real-failure',turnId:gapPage[0].params.item.turnId,kind:'toolCall',tool:'bash',status:'failed',failureReason:'command failed',visibleOutput:'exit 1'}}},
            ...['reminderChild','toolCall'].map((kind,i)=>({method:'item/completed',params:{sessionId:SESSION,viewCursor:'v:'+ (1560+i),item:{itemId:'synthetic-'+i,turnId:gapPage[0].params.item.turnId,kind,status:'failed',reason:'incomplete',revision:2}}})),
          ],nextCursor:'v:1561'}});continue;
        }
        if (raceMode === 'terminal during page' && racePageNumber === 1) {
          send({jsonrpc:'2.0',method:'turn/completed',params:gapPage[2].params});
          send({jsonrpc:'2.0',id:message.id,result:{events:[{method:'turn/completed',params:{...gapPage[2].params,viewCursor:'v:2',terminal:'failed',reason:'incomplete',error:null}}],nextCursor:null}});continue;
        }
        const pos = gapPage.findIndex(event=>event.params.viewCursor===message.params.cursor);
        send({jsonrpc:'2.0',id:message.id,result:{events:pos<0?gapPage:gapPage.slice(pos+1),nextCursor:null}});continue;
      }
      if (paginatedTurn) {
        pageNumber += 1;
        const cursor = 'page-' + pageNumber;
        const event = pageNumber <= 20 ? {method:'session/nameChanged',params:{sessionId:SESSION,viewCursor:cursor,name:'history'}} : {method:'turn/completed',params:{sessionId:SESSION,viewCursor:cursor,turnId:paginatedTurn,terminal:'completed'}};
        send({jsonrpc:'2.0',id:message.id,result:{events:[event],nextCursor:pageNumber<=20?cursor:null}});continue;
      }
      if (durableTurn) {
        const all = durableEvents();
        const pos = all.findIndex(e=>e.params.viewCursor===message.params.cursor);
        const events = pos < 0 ? all : all.slice(pos+1);
        send({jsonrpc:'2.0',id:message.id,result:{events,nextCursor:null}});continue;
      }
      // A resumed session's durable records: two priced completions up to the
      // resume head v:40, then one that arrives live after it.
      const page = gapPage.length > 0 ? gapPage : message.params.sessionId === RESUMABLE ? [
        { method: 'session/tokenUsage', params: { sessionId: RESUMABLE, viewCursor: 'v:10', sourceRange: {}, turnId: 't1', modelId: 'muse-spark-1.3-contributor', promptTokens: 1000000, totalTokens: 1000000, cumulative: {}, usage: { inputTokens: 1000000, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 } } },
        { method: 'session/tokenUsage', params: { sessionId: RESUMABLE, viewCursor: 'v:40', sourceRange: {}, turnId: 't2', modelId: 'muse-spark-1.3-contributor', promptTokens: 0, totalTokens: 200000, cumulative: {}, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 200000, reasoningTokens: 0 } } },
        { method: 'session/tokenUsage', params: { sessionId: RESUMABLE, viewCursor: 'v:41', sourceRange: {}, turnId: 't3', modelId: 'muse-spark-1.3-contributor', promptTokens: 1000000, totalTokens: 1000000, cumulative: {}, usage: { inputTokens: 1000000, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 } } },
      ] : gapPage;
      send({ jsonrpc: '2.0', id: message.id, result: { events: page, nextCursor: null } });
      continue;
    }
    if (message.method === 'turn/start') {
      const turnId = message.params.commandId;
      const prompt = (message.params.input.find((part) => part.type === 'text') || {}).text || '';
      const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
      if (prompt === 'crash host') process.exit(17);
      if (prompt === 'broken protocol') { send({jsonrpc:'2.0',id:message.id,result:{turnId,status:'accepted',startedNewTurn:true,disposition:'started'}}); setTimeout(()=>process.stdout.write('invalid protocol frame\\n'),20); setInterval(()=>{},1000); continue; }
      if (prompt === 'queue me') {
        send({ jsonrpc: '2.0', id: message.id, result: { commandId: turnId, status: 'accepted', turnId, startedNewTurn: false, disposition: 'queued' } });
        notify('turn/unqueued', { sessionId: SESSION, commandId: turnId, turnId, sourceRange: {}, viewCursor: 'v:7' });
        continue;
      }
      send({ jsonrpc: '2.0', id: message.id, result: { commandId: turnId, status: 'accepted', turnId, startedNewTurn: true, disposition: 'started' } });
      if (prompt === 'paginated recovery') { paginatedTurn=turnId; continue; }
      if (prompt === 'durable output') {
        durableTurn = turnId;
        for (const event of durableEvents()) notify(event.method,event.params);
        continue;
      }
      if (prompt === 'mutable item tail' || prompt === 'terminal before final page' || prompt === 'usage before terminal' || prompt === 'terminal during page' || prompt === 'final page failure') {
        raceMode=prompt;
        const sessionId = message.params.sessionId;
        gapPage = [
          {method:'item/completed',params:{sessionId,viewCursor:'v:2',item:{itemId:'race-final',turnId,kind:'agentMessage',text:'The authoritative final answer.',status:'completed',revision:1}}},
          {method:'session/tokenUsage',params:{sessionId,viewCursor:'v:3',turnId,modelId:'muse-spark-1.3-contributor',promptTokens:1000000,usage:{outputTokens:0}}},
          {method:'turn/completed',params:{sessionId,viewCursor:'v:4',turnId,terminal:'completed'}},
        ];
        if (prompt === 'mutable item tail') {
          gapPage = gapPage.map((event,i)=>({...event,params:{...event.params,viewCursor:'v:'+(1560+i)}}));
          notify('item/completed',{sessionId,viewCursor:'v:1560',item:{itemId:'synthetic-push',turnId,kind:'reminderChild',status:'failed',reason:'incomplete'}});
        }
        if (prompt === 'usage before terminal') notify('session/tokenUsage',gapPage[1].params);
        if (prompt !== 'terminal during page') notify('turn/completed',gapPage[2].params);
        continue;
      }
      if (prompt === 'silent completed') {
        const sessionId = message.params.sessionId;
        gapPage = [
          { method: 'item/completed', params: { sessionId, viewCursor: 'v:2', item: { itemId: 'recovered-thought', turnId, kind: 'reasoning', summary: ['Recovered live work'], status: 'completed', revision: 1 } } },
          { method: 'session/tokenUsage', params: { sessionId, viewCursor: 'v:3', turnId, modelId: 'muse-spark-1.3-contributor', promptTokens: 1000000, usage: { outputTokens: 0 } } },
          { method: 'turn/completed', params: { sessionId, viewCursor: 'v:4', turnId, terminal: 'completed' } },
        ];
        continue;
      }
      if (prompt === 'silent never' || prompt === 'synthetic incomplete') {
        ignoreInterrupt = true;
        if (prompt === 'synthetic incomplete') gapPage = [
          { method: 'turn/completed', params: { sessionId: SESSION, viewCursor: 'v:4', turnId, terminal: 'failed', reason: 'incomplete' } },
        ];
        continue;
      }
      if (prompt === 'credit exhausted') {
        notify('turn/completed', { sessionId: SESSION, viewCursor: 'v:4', turnId, terminal: 'failed', error: { kind: 'modelError', message: 'Insufficient credits', retryable: false } });
        continue;
      }
      if (prompt === 'stream answer') {
        notify('item/started', { sessionId: SESSION, viewCursor: 'v:1', item: { itemId: 'answer', turnId, kind: 'agentMessage', text: '', status: 'inProgress', revision: 1 } });
        notify('item/delta', { sessionId: SESSION, viewCursor: 'v:2', itemId: 'answer', delta: 'Live ' });
        notify('item/completed', { sessionId: SESSION, viewCursor: 'v:3', item: { itemId: 'answer', turnId, kind: 'agentMessage', text: 'Live answer', status: 'completed', revision: 2 } });
        notify('turn/completed', { sessionId: SESSION, viewCursor: 'v:4', turnId, terminal: 'completed' });
        continue;
      }
      if (prompt === 'stream thoughts') {
        notify('item/started', { sessionId: SESSION, viewCursor: 'v:1', item: { itemId: 'thought', turnId, kind: 'reasoning', summary: [], status: 'inProgress', revision: 1 } });
        notify('item/delta', { sessionId: SESSION, viewCursor: 'v:2', itemId: 'thought', field: 'summary.0', delta: 'Visible while thinking' });
        notify('turn/completed', { sessionId: SESSION, viewCursor: 'v:3', turnId, terminal: 'completed' });
        continue;
      }
      if (prompt === 'needs approval') {
        pendingApprovalTurnId = turnId;
        notify('turn/started', { sessionId: SESSION, turnId, viewCursor: 'v:1' });
        notify('approval/requested', { sessionId: SESSION, viewCursor: 'v:2', sourceRange: {}, approvalId: 'appr-1', currentRequirementId: { approvalId: 'appr-1', sourceIndex: 3 }, itemId: 'tool-1', toolCallId: 'call-1', toolName: 'bash', rawArgs: '{"command":"rm -rf build"}', taskId: 'task-1', turnId, judgeEscalated: false, protectedWrite: false, subject: { kind: 'shell' }, availableChoices: [
          { choiceId: 'allow-once', decision: 'approved', label: 'Allow once', scope: 'once' },
          { choiceId: 'allow-session', decision: 'approvedForSession', label: 'Allow for session', scope: 'session' },
          { choiceId: 'deny', decision: 'denied', label: 'Deny', scope: 'once' },
        ] });
        continue;
      }
      if (prompt === 'keep running') {
        // A turn that never ends on its own, for steering into.
        notify('turn/started', { sessionId: SESSION, turnId, viewCursor: 'v:1' });
        continue;
      }
      if (prompt === 'retry please') {
        notify('turn/started', { sessionId: SESSION, turnId, viewCursor: 'v:1' });
        notify('turn/retryScheduled', { sessionId: SESSION, turnId, attempt: 1, maxAttempts: 3, nextAttempt: 2, reason: 'upstream overloaded', retryDelayMs: 1500, sourceRange: {}, viewCursor: 'v:2' });
        notify('turn/completed', { sessionId: SESSION, viewCursor: 'v:3', sourceRange: {}, turnId, terminal: 'completed' });
        continue;
      }
      if (prompt === 'drop events') {
        // Push delivery loses v:2..v:4 -- the tool call AND the terminal. The
        // gap notice names the hole; v:9 is the next event proven delivered.
        gapPage = [
          { method: 'item/started', params: { sessionId: SESSION, viewCursor: 'v:2', item: { itemId: 'g1', kind: 'toolCall', status: 'inProgress', revision: 1, tool: 'shell', commandText: 'ls', turnId } } },
          { method: 'item/completed', params: { sessionId: SESSION, viewCursor: 'v:3', sourceRange: {}, item: { itemId: 'g1', kind: 'toolCall', status: 'completed', revision: 2, tool: 'shell', commandText: 'ls', visibleOutput: 'ok', turnId } } },
          { method: 'turn/completed', params: { sessionId: SESSION, viewCursor: 'v:4', sourceRange: {}, turnId, terminal: 'completed' } },
          { method: 'session/tokenUsage', params: { sessionId: SESSION, viewCursor: 'v:9', sourceRange: {}, turnId, promptTokens: 10, totalTokens: 12, cumulative: { promptTokens: 10, outputTokens: 2, totalTokens: 12 }, usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2, reasoningTokens: 0 } } },
        ];
        notify('turn/started', { sessionId: SESSION, turnId, viewCursor: 'v:1' });
        notify('view/gap', { sessionId: SESSION, after: 'v:1', next: 'v:9' });
        notify('session/tokenUsage', { sessionId: SESSION, viewCursor: 'v:9', sourceRange: {}, turnId, promptTokens: 10, totalTokens: 12, cumulative: { promptTokens: 10, outputTokens: 2, totalTokens: 12 }, usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2, reasoningTokens: 0 } });
        continue;
      }
      notify('turn/started', { sessionId: SESSION, turnId, viewCursor: 'v:1' });
      notify('item/started', { sessionId: SESSION, viewCursor: 'v:2', item: { itemId: 'r1', kind: 'reasoning', status: 'inProgress', revision: 1, summary: ['First I read the file.'] } });
      notify('item/completed', { sessionId: SESSION, viewCursor: 'v:3', sourceRange: {}, item: { itemId: 'r1', kind: 'reasoning', status: 'completed', revision: 2, summary: ['First I read the file.', 'Then I patch it.'], turnId } });
      notify('item/started', { sessionId: SESSION, viewCursor: 'v:4', item: { itemId: 'c1', kind: 'toolCall', status: 'inProgress', revision: 1, tool: 'shell', commandText: 'git status', turnId } });
      notify('item/completed', { sessionId: SESSION, viewCursor: 'v:5', sourceRange: {}, item: { itemId: 'c1', kind: 'toolCall', status: 'completed', revision: 2, tool: 'shell', commandText: 'git status', visibleOutput: 'clean', turnId } });
      notify('session/tokenUsage', { sessionId: SESSION, viewCursor: 'v:5a', sourceRange: {}, turnId, modelId: 'muse-spark-1.3-contributor', promptTokens: 97200, totalTokens: 98000, cumulative: { promptTokens: 150000, outputTokens: 2000, totalTokens: 152000 }, usage: { inputTokens: 1200, cachedTokens: 96000, cacheReadTokens: 96000, outputTokens: 800, reasoningTokens: 500 } });
      notify('session/contextUsage', { sessionId: SESSION, viewCursor: 'v:5b', sourceRange: {}, pressure: 'normal', usedTokens: 98000, windowTokens: 272000 });
      notify('turn/completed', { sessionId: SESSION, viewCursor: 'v:6', sourceRange: {}, turnId, terminal: 'completed' });
      continue;
    }
    if (message.method === 'session/setApprovalMode') {
      if (process.env.MUSE_TEST_REJECT_APPROVAL) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Requested approval mode is unavailable' } });
        continue;
      }
      send({ jsonrpc: '2.0', id: message.id, result: { commandId: message.params.commandId, applyOutcome: 'applied' } });
      continue;
    }
    if (message.method === 'approval/decide') {
      send({ jsonrpc: '2.0', id: message.id, result: { commandId: message.params.commandId, status: 'accepted' } });
      send({ jsonrpc: '2.0', method: 'approval/resolved', params: { sessionId: SESSION, approvalId: message.params.approvalId, viewCursor: 'v:12', sourceRange: {}, resolution: { decision: message.params.choiceId === 'allow-once' ? 'approved' : 'denied', resolvedBy: 'user', viewCursor: 'v:12' } } });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: SESSION, viewCursor: 'v:13', sourceRange: {}, turnId: pendingApprovalTurnId, terminal: 'completed' } });
      continue;
    }
    if (message.method === 'turn/steer') {
      const steerText = (message.params.input.find((part) => part.type === 'text') || {}).text || '';
      send({ jsonrpc: '2.0', id: message.id, result: { commandId: message.params.commandId, status: 'accepted', turnId: message.params.expectedTurnId } });
      if (steerText === 'steer into the drain') {
        // What the real host did on 2026-09-12: admitted the steer while the
        // finished answer was winding down, then closed the turn without
        // ever folding the input in -- and said nothing about it.
        send({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: SESSION, viewCursor: 'v:8', sourceRange: {}, turnId: message.params.expectedTurnId, terminal: 'completed' } });
        continue;
      }
      send({ jsonrpc: '2.0', method: 'item/completed', params: { sessionId: SESSION, viewCursor: 'v:7', sourceRange: {}, item: { itemId: 'u2', kind: 'userMessage', status: 'completed', revision: 1, text: steerText, steered: true, commandId: message.params.commandId, turnId: message.params.expectedTurnId } } });
      continue;
    }
    if (message.method === 'turn/interrupt') {
      if (ignoreInterrupt) { send({ jsonrpc: '2.0', id: message.id, result: { status: 'accepted' } }); continue; }
      send({ jsonrpc: '2.0', id: message.id, result: { commandId: message.params.commandId, status: 'accepted' } });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: SESSION, viewCursor: 'v:9', sourceRange: {}, turnId: message.params.turnId, terminal: 'cancelled' } });
      continue;
    }
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found', data: { kind: 'methodNotFound' } } });
  }
});
`,
    { mode: 0o755 },
  );
  return {
    dir,
    binaryPath,
    recordPath,
    environment: { ...process.env, MUSE_TEST_CALLS: recordPath } satisfies NodeJS.ProcessEnv,
    cleanup: () => NodeFSP.rm(dir, { recursive: true, force: true }),
  };
}

const setup = Effect.fn("MuseTest.setup")(function* (options?: {
  readonly providerId?: string;
  readonly noSessionMcp?: boolean;
  readonly rejectApproval?: boolean;
  readonly fastHealth?: boolean;
  readonly immediateHealthStop?: boolean;
  readonly replayPage?: boolean;
  readonly durableTurnId?: string;
  readonly subscribeError?: "sidecar" | "auth" | "anchor";
  readonly slowReconcile?: boolean;
  readonly frozenOwner?: boolean;
  readonly storedRepair?: boolean;
}) {
  const f = yield* Effect.acquireRelease(
    Effect.promise(() => fixture()),
    (value) => Effect.promise(value.cleanup),
  );
  const adapter = yield* makeMuseAdapter({
    instanceId,
    binaryPath: f.binaryPath,
    cwd: f.dir,
    environment: {
      ...f.environment,
      ...(options?.storedRepair ? { MUSE_TEST_STORED_REPAIR: "1" } : {}),
      ...(options?.frozenOwner ? { MUSE_TEST_FROZEN_OWNER: "1" } : {}),
      ...(options?.subscribeError ? { MUSE_TEST_SUBSCRIBE_ERROR: options.subscribeError } : {}),
      ...(options?.noSessionMcp ? { MUSE_TEST_NO_SESSION_MCP: "1" } : {}),
      ...(options?.rejectApproval ? { MUSE_TEST_REJECT_APPROVAL: "1" } : {}),
      ...(options?.replayPage ? { MUSE_TEST_REPLAY_PAGE: "1" } : {}),
      ...(options?.durableTurnId ? { MUSE_TEST_DURABLE_TURN: options.durableTurnId } : {}),
    },
    ...(options?.providerId === undefined ? {} : { providerId: options.providerId }),
    ...(options?.fastHealth
      ? {
          turnHealth: {
            checkIntervalMs: 5,
            finalDeliveryTimeoutMs: 40,
            thresholds: {
              reconcileMs: options?.slowReconcile ? 60_000 : 15,
              modelSilenceMs: options?.immediateHealthStop ? 0 : 80,
              toolSilenceMs: 1000,
              retryBudgetMs: 80,
            },
          },
        }
      : {}),
  });
  return { ...f, adapter };
});

const observe = Effect.fn("MuseTest.observe")(function* (adapter: {
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}) {
  const events: ProviderRuntimeEvent[] = [];
  const completed = yield* Deferred.make<void>();
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.completed" || event.type === "turn.aborted") {
          yield* Deferred.succeed(completed, undefined);
        }
      }),
    ),
    Effect.forkScoped,
  );
  return { events, completed };
});

async function readCalls(recordPath: string) {
  const raw = await NodeFSP.readFile(recordPath, "utf8").catch(() => "");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          method: string;
          params?: Record<string, unknown>;
          hostArgs?: string[];
          hostPid?: number;
        },
    );
}

describe("MuseAdapter", () => {
  it.live(
    "reports a bounded final-delivery failure instead of silently completing when pages fail",
    () =>
      Effect.gen(function* () {
        const f = yield* setup({ subscribeError: "sidecar", fastHealth: true });
        const { events, completed } = yield* observe(f.adapter);
        yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
        yield* f.adapter.sendTurn({ threadId, input: "final page failure" });
        yield* Deferred.await(completed);
        expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
          state: "failed",
          errorMessage: expect.stringContaining("final reply could not be verified"),
        });
        expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(yield* f.adapter.hasSession(threadId)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const race of [
    "terminal before final page",
    "usage before terminal",
    "terminal during page",
  ])
    it.live(`delivers the authoritative final before ${race} overtakes page-only output`, () =>
      Effect.gen(function* () {
        const f = yield* setup({ subscribeError: "sidecar", fastHealth: true });
        const { events, completed } = yield* observe(f.adapter);
        yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
        yield* f.adapter.sendTurn({ threadId, input: race });
        yield* Deferred.await(completed);
        const finalIndex = events.findIndex(
          (event) =>
            event.type === "item.completed" &&
            event.payload.itemType === "assistant_message" &&
            event.payload.detail === "The authoritative final answer.",
        );
        const terminalIndex = events.findIndex((event) => event.type === "turn.completed");
        expect(finalIndex).toBeGreaterThanOrEqual(0);
        expect(finalIndex).toBeLessThan(terminalIndex);
        expect(events.filter((event) => event.type === "thread.token-usage.updated")).toHaveLength(
          1,
        );
        expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

  it.live(
    "polls a resumed session without a sidecar and does not retry its unsupported subscription",
    () =>
      Effect.gen(function* () {
        const f = yield* setup({
          fastHealth: true,
          slowReconcile: true,
          subscribeError: "sidecar",
        });
        const { events, completed } = yield* observe(f.adapter);
        yield* f.adapter.startSession({
          threadId,
          runtimeMode: "auto",
          resumeCursor: "01a08e93-2222-7222-8222-222222222222",
        });
        yield* f.adapter.sendTurn({ threadId, input: "silent completed" });
        yield* Deferred.await(completed);
        const calls = yield* Effect.promise(() => readCalls(f.recordPath));
        expect(calls.filter((call) => call.method === "view/subscribe")).toHaveLength(1);
        expect(calls.some((call) => call.method === "turn/start")).toBe(true);
        expect(calls.some((call) => call.method === "turn/interrupt")).toBe(false);
        expect(
          events.filter(
            (event) =>
              event.type === "runtime.warning" && event.payload.message.includes("five seconds"),
          ),
        ).toHaveLength(0);
        expect(
          events.some(
            (event) =>
              event.type === "item.updated" && event.payload.detail === "Recovered live work",
          ),
        ).toBe(true);
        expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
          state: "completed",
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "reads only durable assistant snapshots from the stored tail without resuming a session",
    () =>
      Effect.gen(function* () {
        const f = yield* setup({ storedRepair: true });
        const events: ProviderRuntimeEvent[] = [];
        const received = yield* Deferred.make<void>();
        yield* f.adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (events.length === 2) yield* Deferred.succeed(received, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        const count = yield* f.adapter.replayStoredTranscript!({
          threadId,
          sessionId: "01a08e93-71a6-7370-9242-de67bd5e466a",
        });
        yield* Deferred.await(received);
        expect(count).toBe(2);
        expect(
          events.map((event) => [event.type, event.itemId, event.turnId, event.historicalReplay]),
        ).toEqual([
          ["item.completed", "stored-5800", "stored-turn", true],
          ["item.completed", "stored-6100", "stored-turn", true],
        ]);
        expect(events[1]?.eventId).toBe(
          `muse:${instanceId}:${threadId}:v:6100:item.completed:stored-6100`,
        );
        expect(events.map((event) => event.createdAt)).toEqual([
          "2026-09-13T19:59:00.000Z",
          "2026-09-13T20:00:00.000Z",
        ]);
        expect(yield* f.adapter.listSessions()).toEqual([]);
        expect(yield* f.adapter.hasSession(threadId)).toBe(false);
        const calls = yield* Effect.promise(() => readCalls(f.recordPath));
        expect([...new Set(calls.map((call) => call.method))]).toEqual([
          "initialize",
          "initialized",
          "view/page",
        ]);
        const pages = calls.filter((call) => call.method === "view/page");
        expect(pages).toHaveLength(20);
        expect(pages[0]?.params).toMatchObject({ direction: "backward", limit: 200 });
        expect(pages[0]?.params?.["cursor"]).toBeUndefined();
        expect(pages[19]?.params?.["cursor"]).toBe("v:2401");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rewinds an unversioned saved anchor once without starting a model turn", () =>
    Effect.gen(function* () {
      const f = yield* setup({ durableTurnId: "old-completed-turn" });
      const { events } = yield* observe(f.adapter);
      const session = yield* f.adapter.startSession({
        threadId,
        runtimeMode: "auto",
        resumeCursor: { sessionId: "01a08e93-71a6-7370-9242-de67bd5e466a", viewCursor: "v:50" },
      });
      expect(session.resumeCursor).toMatchObject({
        sessionId: "01a08e93-71a6-7370-9242-de67bd5e466a",
        deliveryCursorVersion: 1,
        viewCursor: null,
      });
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      expect(calls.find((call) => call.method === "view/page")?.params?.["cursor"]).toBeUndefined();
      expect(
        calls.some((call) => call.method === "turn/start" || call.method === "session/start"),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === "item.completed" &&
            event.payload.itemType === "assistant_message" &&
            event.payload.detail === "Durable answer" &&
            event.historicalReplay === true,
        ),
      ).toBe(true);
      expect(
        events.find((event) => event.type === "item.completed" && event.itemId === "durable-answer")
          ?.createdAt,
      ).toBe("2026-09-13T20:00:00.000Z");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the anchor before mutable incomplete item tails and preserves real failures", () =>
    Effect.gen(function* () {
      const f = yield* setup({ subscribeError: "sidecar", fastHealth: true });
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "mutable item tail" });
      yield* Deferred.await(completed);
      expect(
        events.find(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "assistant_message",
        )?.payload,
      ).toMatchObject({ detail: "The authoritative final answer." });
      expect(
        events.some((event) => event.type === "item.completed" && event.itemId === "real-failure"),
      ).toBe(true);
      expect(events.some((event) => event.itemId?.startsWith("synthetic-"))).toBe(false);
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      expect(
        calls.some((call) => call.method === "view/page" && call.params?.["cursor"] === "v:1559"),
      ).toBe(true);
      expect(
        calls.some((call) => call.method === "view/page" && call.params?.["cursor"] === "v:1561"),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "reads page-only output from a host that never owns the session when the owner view is frozen",
    () =>
      Effect.gen(function* () {
        const f = yield* setup({ subscribeError: "sidecar", frozenOwner: true, fastHealth: true });
        const { events, completed } = yield* observe(f.adapter);
        yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
        yield* f.adapter.sendTurn({ threadId, input: "terminal before final page" });
        yield* Deferred.await(completed);
        expect(
          events.find(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "assistant_message",
          )?.payload,
        ).toMatchObject({ detail: "The authoritative final answer." });
        expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
          state: "completed",
        });
        const calls = yield* Effect.promise(() => readCalls(f.recordPath));
        const owner = calls.find((call) => call.method === "turn/start")?.hostPid;
        const readers = calls.filter(
          (call) => call.method === "view/page" && call.hostPid !== owner,
        );
        expect(readers.length).toBeGreaterThan(0);
        for (const reader of readers)
          expect(
            calls.some(
              (call) =>
                call.hostPid === reader.hostPid &&
                ["session/start", "session/resume", "turn/start"].includes(call.method),
            ),
          ).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "keeps the default page-only monitor alive after session admission returns",
    () =>
      Effect.gen(function* () {
        const f = yield* setup({ subscribeError: "sidecar" });
        const { events, completed } = yield* observe(f.adapter);
        yield* f.adapter
          .startSession({
            threadId,
            runtimeMode: "auto",
            resumeCursor: "01a08e93-2222-7222-8222-222222222222",
          })
          .pipe(Effect.scoped);
        yield* f.adapter.sendTurn({ threadId, input: "silent completed" });
        yield* Deferred.await(completed);
        expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
          state: "completed",
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live("recovers a stale live anchor through pages without warning spam", () =>
    Effect.gen(function* () {
      const f = yield* setup({ subscribeError: "anchor", fastHealth: true });
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "terminal before final page" });
      yield* Deferred.await(completed);
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        state: "completed",
      });
      expect(events.filter((event) => event.type === "runtime.warning")).toHaveLength(0);
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      expect(calls.filter((call) => call.method === "view/subscribe")).toHaveLength(1);
      expect(calls.some((call) => call.method === "view/page")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not classify subscription authorization errors as page-only support", () =>
    Effect.gen(function* () {
      const f = yield* setup({ subscribeError: "auth" });
      const result = yield* f.adapter
        .startSession({ threadId, runtimeMode: "auto" })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      expect(calls.some((call) => call.method === "turn/start")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("continues a capped repair before applying a no-progress stop", () =>
    Effect.gen(function* () {
      const f = yield* setup({ fastHealth: true, immediateHealthStop: true });
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "paginated recovery" });
      yield* Deferred.await(completed);
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        state: "completed",
      });
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      expect(
        calls.some((call) => call.method === "view/page" && call.params?.["cursor"] === "page-20"),
      ).toBe(true);
      expect(calls.some((call) => call.method === "turn/interrupt")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "stops an owned live host when its protocol reader fails and receipts the turn failure",
    () =>
      Effect.gen(function* () {
        const f = yield* setup();
        const { events, completed } = yield* observe(f.adapter);
        yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
        yield* f.adapter.sendTurn({ threadId, input: "broken protocol" });
        yield* Deferred.await(completed);
        const calls = yield* Effect.promise(() => readCalls(f.recordPath));
        const pid = calls.find((call) => call.method === "turn/start")?.hostPid;
        expect(pid).toBeTypeOf("number");
        if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
        expect(yield* f.adapter.hasSession(threadId)).toBe(false);
        expect(events.some((event) => event.type === "runtime.error")).toBe(true);
        expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
          state: "failed",
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "replays a saved pre-turn cursor as stable snapshots without duplicating deltas or spend",
    () =>
      Effect.gen(function* () {
        const first = yield* setup();
        const before = yield* observe(first.adapter);
        yield* first.adapter.startSession({ threadId, runtimeMode: "auto" });
        const turn = yield* first.adapter.sendTurn({ threadId, input: "durable output" });
        yield* Deferred.await(before.completed);
        expect(turn.resumeCursor).toMatchObject({
          sessionId: "01a08e93-71a6-7370-9242-de67bd5e466a",
          viewCursor: "v:0",
        });
        const recovered = yield* setup({ durableTurnId: turn.turnId });
        const after = yield* observe(recovered.adapter);
        const session = yield* recovered.adapter.startSession({
          threadId,
          runtimeMode: "auto",
          resumeCursor: turn.resumeCursor,
        });
        expect(session.status).toBe("ready");
        const calls = yield* Effect.promise(() => readCalls(recovered.recordPath));
        expect(calls.find((call) => call.method === "view/page")?.params?.["cursor"]).toBe("v:0");
        const oldTool = before.events.find(
          (event) => event.type === "item.started" && event.itemId === "durable-tool",
        );
        const newTool = after.events.find(
          (event) => event.type === "item.started" && event.itemId === "durable-tool",
        );
        expect(newTool?.eventId).toBe(oldTool?.eventId);
        expect(after.events.filter((event) => event.type === "content.delta")).toHaveLength(0);
        expect(
          after.events.some(
            (event) =>
              event.type === "item.completed" &&
              event.payload.itemType === "assistant_message" &&
              event.payload.detail === "Durable answer",
          ),
        ).toBe(true);
        expect(after.events.filter((event) => event.type === "turn.completed")).toHaveLength(0);
        const spend = after.events
          .filter((event) => event.type === "account.rate-limits.updated")
          .map(
            (event) =>
              (event.payload.rateLimits as { sessionSpend?: string } | undefined)?.sessionSpend,
          );
        expect(spend.length).toBeGreaterThan(0);
        expect(spend.every((value) => value === "1.000000")).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("re-attaches a resumed view after registering its session context", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.adapter.startSession({
        threadId,
        runtimeMode: "auto",
        resumeCursor: {
          sessionId: "01a08e93-2222-7222-8222-222222222222",
          viewCursor: "v:40",
          deliveryCursorVersion: 1,
        },
      });
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      expect(calls.find((call) => call.method === "view/subscribe")?.params).toMatchObject({
        after: "v:41",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("repairs silently lost push delivery and deduplicates replayed spend", () =>
    Effect.gen(function* () {
      const f = yield* setup({ fastHealth: true, replayPage: true });
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "silent completed" });
      yield* Deferred.await(completed);
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      expect(calls.some((call) => call.method === "view/page")).toBe(true);
      expect(
        events.filter(
          (event) =>
            event.type === "item.updated" && event.payload.detail === "Recovered live work",
        ),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === "thread.token-usage.updated")).toHaveLength(1);
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        state: "completed",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const input of ["silent never", "synthetic incomplete"]) {
    it.live(`stops ${input} after repair and an interrupt that never settles`, () =>
      Effect.gen(function* () {
        const f = yield* setup({ fastHealth: true });
        const { events, completed } = yield* observe(f.adapter);
        yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
        yield* f.adapter.sendTurn({ threadId, input });
        yield* Deferred.await(completed);
        expect(yield* f.adapter.hasSession(threadId)).toBe(false);
        const terminal = events.find((event) => event.type === "turn.completed");
        expect(terminal?.payload).toMatchObject({
          state: "failed",
          errorMessage: expect.stringContaining("stopped reporting progress"),
        });
        const calls = yield* Effect.promise(() => readCalls(f.recordPath));
        expect(calls.some((call) => call.method === "turn/interrupt")).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.live("streams assistant text and repairs its final suffix without duplicating it", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "stream answer" });
      yield* Deferred.await(completed);
      const deltas = events
        .filter((event) => event.type === "content.delta")
        .map((event) => event.payload.delta);
      expect(deltas).toEqual(["Live ", "answer"]);
      expect(deltas.join("")).toBe("Live answer");
      const completion = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      expect(completion?.type === "item.completed" ? completion.payload.detail : undefined).toBe(
        "Live answer",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("shows reasoning deltas before a turn reaches its terminal", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "stream thoughts" });
      yield* Deferred.await(completed);
      const thought = events.findIndex(
        (event) =>
          event.type === "item.updated" && event.payload.detail === "Visible while thinking",
      );
      expect(thought).toBeGreaterThanOrEqual(0);
      expect(thought).toBeLessThan(events.findIndex((event) => event.type === "turn.completed"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ends a credit failure with the provider error instead of leaving Working", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "credit exhausted" });
      yield* Deferred.await(completed);
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        state: "failed",
        errorMessage: "Insufficient credits",
      });
      expect((yield* f.adapter.listSessions())[0]?.status).toBe("ready");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const resumeCursor of [
    undefined,
    "01a08e93-2222-7222-8222-222222222222",
    "missing-session",
  ]) {
    it.live(`honors full access at process launch for ${resumeCursor ?? "fresh"} sessions`, () =>
      Effect.gen(function* () {
        const f = yield* setup();
        yield* f.adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          ...(resumeCursor ? { resumeCursor } : {}),
        });
        const calls = yield* Effect.promise(() => readCalls(f.recordPath));
        expect(calls.find((call) => call.method === "initialize")?.hostArgs).toContain(
          "--disable-sandbox",
        );
        expect(
          calls.find((call) => call.method === "session/setApprovalMode")?.params?.["mode"],
        ).toBe("allowAll");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
  it.live("isolates full-access and constrained threads on different hosts", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const constrainedThread = ThreadId.make("constrained-thread");
      yield* f.adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* f.adapter.startSession({
        threadId: constrainedThread,
        runtimeMode: "approval-required",
      });
      const starts = (yield* Effect.promise(() => readCalls(f.recordPath))).filter(
        (call) => call.method === "session/start",
      );
      expect(starts).toHaveLength(2);
      expect(starts[0]?.hostPid).not.toBe(starts[1]?.hostPid);
      expect(starts[0]?.hostArgs).toContain("--disable-sandbox");
      expect(starts[1]?.hostArgs).not.toContain("--disable-sandbox");
      expect(yield* f.adapter.hasSession(threadId)).toBe(true);
      expect(yield* f.adapter.hasSession(constrainedThread)).toBe(true);
      yield* f.adapter.stopSession(constrainedThread);
      expect(yield* f.adapter.hasSession(threadId)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("restarts the host and revokes allowAll when a thread leaves full access", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* f.adapter.startSession({ threadId, runtimeMode: "approval-required" });
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      const handshakes = calls.filter((call) => call.method === "initialize");
      expect(handshakes).toHaveLength(2);
      expect(handshakes[0]?.hostPid).not.toBe(handshakes[1]?.hostPid);
      expect(handshakes[1]?.hostArgs).not.toContain("--disable-sandbox");
      expect(
        calls
          .filter((call) => call.method === "session/setApprovalMode")
          .map((call) => call.params?.["mode"]),
      ).toEqual(["allowAll", "promptUnmatched"]);
      expect((yield* f.adapter.listSessions())[0]?.runtimeMode).toBe("approval-required");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live(
    "reports a dead host and reopens the same-mode thread instead of returning stale readiness",
    () =>
      Effect.gen(function* () {
        const f = yield* setup();
        const exited = yield* Deferred.make<void>();
        yield* f.adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            event.type === "session.exited" && event.payload.exitKind === "error"
              ? Deferred.succeed(exited, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* f.adapter.startSession({ threadId, runtimeMode: "full-access" });
        const sent = yield* f.adapter
          .sendTurn({ threadId, input: "crash host" })
          .pipe(Effect.result);
        expect(sent._tag).toBe("Failure");
        expect(yield* f.adapter.hasSession(threadId)).toBe(false);
        yield* Deferred.await(exited);
        const reopened = yield* f.adapter.startSession({ threadId, runtimeMode: "full-access" });
        expect(reopened.status).toBe("ready");
        expect(yield* f.adapter.hasSession(threadId)).toBe(true);
        const calls = yield* Effect.promise(() => readCalls(f.recordPath));
        const handshakes = calls.filter((call) => call.method === "initialize");
        expect(handshakes).toHaveLength(2);
        expect(handshakes[0]?.hostPid).not.toBe(handshakes[1]?.hostPid);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("stops the catalog host as well as thread hosts", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.adapter.listModels();
      const first = (yield* Effect.promise(() => readCalls(f.recordPath))).find(
        (call) => call.method === "initialize",
      );
      yield* f.adapter.stopAll();
      expect(() => process.kill(first!.hostPid!, 0)).toThrow();
      yield* f.adapter.listModels();
      const handshakes = (yield* Effect.promise(() => readCalls(f.recordPath))).filter(
        (call) => call.method === "initialize",
      );
      expect(handshakes).toHaveLength(2);
      expect(handshakes[0]?.hostPid).not.toBe(handshakes[1]?.hostPid);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("fails session setup when Muse rejects the requested approval policy", () =>
    Effect.gen(function* () {
      const f = yield* setup({ rejectApproval: true });
      const result = yield* f.adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* f.adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const resumeCursor of [
    undefined,
    "01a08e93-2222-7222-8222-222222222222",
    "missing-session",
  ]) {
    it.live(`injects thread-scoped host MCP for ${resumeCursor ?? "fresh"} sessions`, () =>
      Effect.gen(function* () {
        const f = yield* setup();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            McpProviderSession.setMcpProviderSession({
              environmentId: EnvironmentId.make("test-env"),
              threadId,
              providerInstanceId: instanceId,
              providerSessionId: "test-session",
              endpoint: "http://127.0.0.1:12345/mcp",
              authorizationHeader: "Bearer thread-scoped-test",
            }),
          ),
          () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
        );
        yield* f.adapter.startSession({
          threadId,
          runtimeMode: "auto",
          ...(resumeCursor ? { resumeCursor } : {}),
        });
        const calls = yield* Effect.promise(() => readCalls(f.recordPath));
        expect(calls[0]?.params?.["capabilities"]).toMatchObject({
          requestedCapabilities: ["sessionMcp"],
        });
        const sessionCalls = calls.filter((call) =>
          ["session/start", "session/resume"].includes(call.method),
        );
        expect(sessionCalls.length).toBeGreaterThan(0);
        for (const call of sessionCalls)
          expect(call.params?.["config"]).toEqual({
            mcpServers: {
              "t3-code": {
                transport: "streamableHttp",
                url: "http://127.0.0.1:12345/mcp",
                headers: { Authorization: "Bearer thread-scoped-test" },
                mode: "required",
              },
            },
          });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  for (const hasBridge of [false, true]) {
    it.live(
      `handles missing native MCP with host bridge ${hasBridge ? "available" : "missing"}`,
      () =>
        Effect.gen(function* () {
          const f = yield* setup({ noSessionMcp: true });
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              McpProviderSession.setMcpProviderSession({
                environmentId: EnvironmentId.make("test-env"),
                threadId,
                providerInstanceId: instanceId,
                providerSessionId: "test-session",
                endpoint: "http://127.0.0.1:12345/mcp",
                authorizationHeader: "Bearer thread-scoped-test",
                ...(hasBridge ? { shellBridgeInstructions: "Use the prepared host client" } : {}),
              }),
            ),
            () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
          );
          const result = yield* f.adapter
            .startSession({ threadId, runtimeMode: "auto" })
            .pipe(Effect.result);
          expect(result._tag).toBe(hasBridge ? "Success" : "Failure");
          const calls = yield* Effect.promise(() => readCalls(f.recordPath));
          const sessionCalls = calls.filter((call) => call.method === "session/start");
          expect(sessionCalls).toHaveLength(hasBridge ? 1 : 0);
          if (hasBridge) expect(sessionCalls[0]?.params?.["config"]).toBeUndefined();
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.live("completes the two-step handshake before any command", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      const methods = calls.map((call) => call.method);
      // Without the `initialized` notification every later call fails
      // `notInitialized`, so the session start below could not have succeeded.
      expect(methods.slice(0, 3)).toEqual(["initialize", "initialized", "session/start"]);
      const clientInfo = (calls[0]?.params as { clientInfo?: { name?: string } } | undefined)
        ?.clientInfo;
      expect(clientInfo?.name).toMatch(/^[a-z0-9_]+$/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("streams a thought and a tool call, then completes the turn", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "hello" });
      yield* Deferred.await(completed);

      const reasoning = events.filter(
        (event) => event.type === "item.updated" && event.payload.itemType === "reasoning",
      );
      expect(reasoning.length).toBeGreaterThan(0);
      const thought = reasoning.at(-1)?.payload as { detail?: string; title?: string };
      // Untitled on purpose: a titled reasoning row is a bridge narrating its
      // own state and stays inline, while an untitled one is drawn as the
      // model's own thought between the tool calls it narrates.
      expect(thought.title).toBeUndefined();
      expect(thought.detail).toBe("First I read the file.\n\nThen I patch it.");

      const toolStarted = events.find(
        (event) => event.type === "item.started" && event.payload.itemType === "command_execution",
      );
      expect(toolStarted?.payload).toMatchObject({ detail: "git status" });
      expect(events.some((event) => event.type === "turn.completed")).toBe(true);

      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      const start = calls.find((call) => call.method === "turn/start");
      // A second message must never silently discard the running turn.
      expect(start?.params?.["ifBusy"]).toBe("queue");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  /**
   * Muse reported a context figure that was missing everything the prompt
   * cache held and had no window behind it, so the meter every other provider
   * fills in sat empty or wrong. MSP answers both: `promptTokens`/`totalTokens`
   * are counted once by the host (the raw counters beside them are explicitly
   * not summable, #8803), and `session/contextUsage` carries the occupancy with
   * the window size it was measured against.
   */
  it.live("reports counted-once context occupancy against the window MSP gives", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "hello" });
      yield* Deferred.await(completed);

      const usageEvents = events.filter((event) => event.type === "thread.token-usage.updated");
      expect(usageEvents.length).toBeGreaterThan(0);
      for (const event of usageEvents) {
        // The old arithmetic: inputTokens + outputTokens, which drops the
        // 96,000 tokens the provider served from cache.
        expect(event.payload.usage.usedTokens).not.toBe(2000);
      }
      const latest = usageEvents.at(-1)?.payload.usage;
      expect(latest?.usedTokens).toBe(98000);
      // Without the window there is no percentage to draw.
      expect(latest?.maxTokens).toBe(272000);

      const perCompletion = usageEvents[0]?.payload.usage;
      expect(perCompletion?.usedTokens).toBe(98000);
      expect(perCompletion?.totalProcessedTokens).toBe(152000);
      expect(perCompletion?.lastCachedInputTokens).toBe(96000);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  /**
   * Continuing a thread whose stored cursor the host has already discarded.
   * The resume fails and the adapter opens a fresh session instead of refusing
   * the thread -- but that replacement has to be the same session the ordinary
   * path would open. It dropped `providerId`, so a workspace pinned to `echo`
   * came back on the real `meta` provider, which is the one substitution that
   * costs money rather than merely looking different.
   */
  it.live("keeps the configured startup provider when a stale cursor forces a fresh session", () =>
    Effect.gen(function* () {
      const f = yield* setup({ providerId: "echo" });
      yield* f.adapter.startSession({
        threadId,
        runtimeMode: "auto",
        resumeCursor: "01a08e93-0000-7000-8000-000000000000",
      });

      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      // The resume was attempted and refused by the host.
      expect(calls.some((call) => call.method === "session/resume")).toBe(true);
      const start = calls.find((call) => call.method === "session/start");
      expect(start?.params?.["providerId"]).toBe("echo");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  /**
   * A reopened Muse thread showed an empty context meter until a new turn
   * ran, because Muse only reports occupancy from inside a turn. The resume
   * snapshot folds the same triple, so a reopened thread can show it at once.
   */
  it.live("fills a reopened session's context meter before any new turn runs", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events } = yield* observe(f.adapter);
      yield* f.adapter.startSession({
        threadId,
        runtimeMode: "auto",
        resumeCursor: {
          sessionId: "01a08e93-2222-7222-8222-222222222222",
          viewCursor: "v:40",
          deliveryCursorVersion: 1,
        },
      });
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      // Asked for the snapshot rather than the item log.
      expect(calls.find((call) => call.method === "session/resume")?.params?.["history"]).toBe(
        "snapshot",
      );
      // The startup replay delivers the newly visible v:41 completion and
      // backfill adds the two dollars preceding the saved v:40 anchor.
      yield* Effect.gen(function* () {
        while (
          !events.some(
            (event) =>
              event.type === "account.rate-limits.updated" &&
              typeof event.payload.rateLimits === "object" &&
              event.payload.rateLimits !== null &&
              "sessionSpend" in event.payload.rateLimits &&
              event.payload.rateLimits.sessionSpend === "3.000000",
          )
        ) {
          yield* Effect.sleep("10 millis");
        }
      }).pipe(Effect.timeout("5 seconds"));
      const spend = events.findLast((event) => event.type === "account.rate-limits.updated");
      expect(spend?.payload.rateLimits).toMatchObject({
        source: "muse-spend",
        currency: "USD",
        sessionSpend: "3.000000",
        unpricedCompletions: 0,
      });
      const meter = events.find((event) => event.type === "thread.token-usage.updated");
      expect(meter?.payload.usage).toMatchObject({ usedTokens: 120000, maxTokens: 272000 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  /**
   * The usage strip wants what the account is charged, not token counts.
   * Muse serves no balance anywhere, but it serves prices in the catalog and
   * counted-once tokens per completion, so spend is computable -- the same
   * arithmetic as the TUI's `/cost`.
   */
  it.live("reports the session's spend from catalog prices", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "hello" });
      yield* Deferred.await(completed);
      const spend = events.find((event) => event.type === "account.rate-limits.updated");
      // 1,200 uncached prompt at $1/M + 96,000 cached at $0.10/M + 800 output
      // at $5/M = $0.0148.
      expect(spend?.payload.rateLimits).toMatchObject({
        source: "muse-spend",
        currency: "USD",
        sessionSpend: "0.014800",
        unpricedCompletions: 0,
      });
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      expect(calls.some((call) => call.method === "model/list")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("joins a mid-turn message to the running turn instead of queueing it", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      const turn = yield* f.adapter.sendTurn({ threadId, input: "keep running" });
      const messageId = MessageId.make("steered-message");
      yield* f.adapter.sendTurn({
        threadId,
        messageId,
        input: "actually, do this instead",
        liveSteerTarget: { providerInstanceId: instanceId, activeTurnId: turn.turnId },
      });
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      const steer = calls.find((call) => call.method === "turn/steer");
      expect(steer).toBeDefined();
      // expectedTurnId closes the race where the turn ends between the
      // caller's read and this call, so input cannot leak into the next turn.
      expect(steer?.params?.["expectedTurnId"]).toBe(turn.turnId);
      // The receipt is the user message appearing inside the turn, and it is
      // attributed to the turn the steer joined.
      const receipt = events.find(
        (event) => event.type === "message.delivered" && event.payload.messageId === messageId,
      );
      expect(receipt?.turnId).toBe(turn.turnId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("switches a hands-off session to allow-all so tool calls never wait on a prompt", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.adapter.startSession({ threadId, runtimeMode: "full-access" });
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      const mode = calls.find((call) => call.method === "session/setApprovalMode");
      expect(mode?.params?.["mode"]).toBe("allowAll");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("relays a tool approval to the orchestrator and answers it with the host's choice", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "approval-required" });
      const turn = yield* f.adapter.sendTurn({ threadId, input: "needs approval" });
      yield* Effect.sleep("200 millis");
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      // A prompting mode keeps the host's own policy; only hands-off modes
      // are switched to allow-all.
      expect(
        calls.find((call) => call.method === "session/setApprovalMode")?.params?.["mode"],
      ).toBe("promptUnmatched");
      const opened = events.find((event) => event.type === "request.opened");
      expect(opened?.payload).toMatchObject({ requestType: "command_execution_approval" });
      expect(opened?.requestId).toBe("appr-1");

      yield* f.adapter.respondToRequest(threadId, ApprovalRequestId.make("appr-1"), "accept");
      yield* Deferred.await(completed);
      const decided = (yield* Effect.promise(() => readCalls(f.recordPath))).find(
        (call) => call.method === "approval/decide",
      );
      expect(decided?.params).toMatchObject({
        approvalId: "appr-1",
        choiceId: "allow-once",
        requirementId: { approvalId: "appr-1", sourceIndex: 3 },
      });
      const resolved = events.find((event) => event.type === "request.resolved");
      expect(resolved?.payload).toMatchObject({
        requestType: "command_execution_approval",
        decision: "approved",
      });
      expect(
        events.some((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails a steer the host admitted but closed the turn on, with no receipt", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      const turn = yield* f.adapter.sendTurn({ threadId, input: "keep running" });
      const messageId = MessageId.make("dropped-message");
      const outcome = yield* f.adapter
        .sendTurn({
          threadId,
          messageId,
          input: "steer into the drain",
          liveSteerTarget: { providerInstanceId: instanceId, activeTurnId: turn.turnId },
        })
        .pipe(Effect.flip);
      // The ack said "accepted"; only the turn's terminal told the truth. A
      // failed send is what the reactor turns into a fresh turn at the
      // boundary -- a receipt here would have marked the message delivered
      // and left the user with no answer, as on 2026-09-12.
      expect(outcome.detail).toContain("closed the turn before taking the steered message");
      expect(
        events.some(
          (event) => event.type === "message.delivered" && event.payload.messageId === messageId,
        ),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === "turn.completed" &&
            event.turnId === turn.turnId &&
            event.payload.state === "completed",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("sends a UUIDv7 command id, which the host requires", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      const start = calls.find((call) => call.method === "session/start");
      expect(start?.params?.["commandId"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports an interrupt as an outcome rather than a failed turn", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      const turn = yield* f.adapter.sendTurn({ threadId, input: "long job" });
      yield* f.adapter.interruptTurn(threadId, TurnId.make(turn.turnId));
      yield* Deferred.await(completed);
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      expect(calls.some((call) => call.method === "turn/interrupt")).toBe(true);
      // A failed turn is re-dispatched by the reactor moments later, so an
      // interrupt the user asked for must not be reported as one.
      expect(
        events.some((event) => event.type === "turn.completed" && event.payload.state === "failed"),
      ).toBe(false);
      // ...but it must be reported as a COMPLETED turn. `turn.aborted` closes
      // nothing in the orchestrator, so emitting only that left the session
      // running with this turn active: the "stopped mid turn" of 2026-09-12.
      expect(
        events.some(
          (event) => event.type === "turn.completed" && event.payload.state === "interrupted",
        ),
      ).toBe(true);
      expect(events.some((event) => event.type === "turn.aborted")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ends a reclaimed queued turn instead of waiting for a start that never comes", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      const turn = yield* f.adapter.sendTurn({ threadId, input: "queue me" });
      // No turn/started or turn/completed will ever name this turn.
      yield* Deferred.await(completed);
      const terminal = events.find(
        (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
      );
      expect(terminal?.payload).toMatchObject({ state: "failed" });
      expect((terminal?.payload as { errorMessage?: string }).errorMessage).toContain("reclaimed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fills a delivery gap from the view so a dropped terminal still ends the turn", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "drop events" });
      // Resolves only if the terminal that push delivery dropped is recovered.
      yield* Deferred.await(completed);
      const calls = yield* Effect.promise(() => readCalls(f.recordPath));
      const page = calls.find((call) => call.method === "view/page");
      expect(page?.params?.["cursor"]).toBe("v:1");
      // The dropped tool call is spliced in ahead of the terminal.
      const kinds = events.map((event) => event.type);
      expect(kinds.indexOf("item.started")).toBeGreaterThanOrEqual(0);
      expect(kinds.indexOf("item.started")).toBeLessThan(kinds.lastIndexOf("turn.completed"));
      expect(events.some((event) => event.type === "turn.completed")).toBe(true);
      // v:9 was delivered live and held during the fill; the page's copy of it
      // is excluded, so it is processed exactly once.
      expect(events.filter((event) => event.type === "thread.token-usage.updated")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("shows a scheduled retry instead of dead air", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { events, completed } = yield* observe(f.adapter);
      yield* f.adapter.startSession({ threadId, runtimeMode: "auto" });
      yield* f.adapter.sendTurn({ threadId, input: "retry please" });
      yield* Deferred.await(completed);
      const retry = events.find((event) => event.type === "session.state.changed");
      expect(retry?.payload).toMatchObject({ state: "running" });
      // The same reason string every other provider uses, so the orchestrator
      // shows its retrying phase rather than a silent running one.
      expect((retry?.payload as { reason?: string }).reason).toBe(
        "provider_overloaded:retrying;attempt=1;max=3;delay_ms=1500",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
