import { httpHeaderRedactionLayer } from "@t3tools/shared/httpObservability";
import { makeLocalFileTracer, makeTraceSink } from "@t3tools/shared/observability";
import type { EffectTraceRecord } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import * as OtlpExporter from "effect/unstable/observability/OtlpExporter";
import * as OtlpMetrics from "effect/unstable/observability/OtlpMetrics";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";

import * as ServerConfig from "../../config.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import { ServerLoggerLive } from "../../serverLogger.ts";
import * as BrowserTraceCollector from "../BrowserTraceCollector.ts";

const otlpSerializationLayer = OtlpSerialization.layerJson;

/**
 * Spans that fire per streamed message, per projected event, or per running
 * turn each second. Measured on a live install they were ~88% of the trace
 * file (about 100 KB/s while three turns streamed), which cut the retained
 * window to minutes. A failed or slow one is still written.
 */
const HIGH_FREQUENCY_LOCAL_SPANS = new Set([
  "sql.execute",
  // Claude adapter, once per SDK message.
  "handleSdkMessage",
  "handleStreamEvent",
  "handleSystemMessage",
  "ensureThreadId",
  "updateResumeCursor",
  // Ingestion and projection, once per runtime or domain event.
  "resolveThreadShell",
  "decideOrchestrationCommand",
  "processAssistantMessageSent",
  "runAttachmentSideEffects",
  "wakeDeliveryStateWaiters",
  "ProjectionLiveBuffer.offer",
  "ProjectionLiveBuffer.offerWithState",
  "applyProjectsProjection",
  "applyThreadsProjection",
  "applyThreadSessionsProjection",
  "applyThreadTurnsProjection",
  "applyThreadMessagesProjection",
  "applyThreadProposedPlansProjection",
  "applyThreadActivitiesProjection",
  "applyPendingApprovalsProjection",
  "applyThreadWorkProjection",
  // Settings reads and the usage guard's per-second check of each running turn.
  "ServerSecretStore.get",
  "ServerSettings.overlayOrchestratorKeyPresence",
  "ProviderUsageGuard.decide",
  "ProviderUsageGuard.readInstance",
  "ProviderUsageGuard.overrideActive",
]);

export function shouldPersistServerEffectSpan(
  record: Pick<EffectTraceRecord, "durationMs" | "exit" | "name">,
): boolean {
  return (
    record.exit._tag !== "Success" ||
    record.durationMs >= 100 ||
    record.name.startsWith("server.startup") ||
    !HIGH_FREQUENCY_LOCAL_SPANS.has(record.name)
  );
}

export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const attribution = yield* ResourceAttribution.ResourceAttribution;

    const traceReferencesLayer = Layer.mergeAll(
      Layer.succeed(Tracer.MinimumTraceLevel, config.traceMinLevel),
      Layer.succeed(References.TracerTimingEnabled, config.traceTimingEnabled),
      httpHeaderRedactionLayer,
    );

    const tracerLayer = Layer.unwrap(
      Effect.gen(function* () {
        const sink = yield* makeTraceSink({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          onFlush: (stats) =>
            attribution.record({
              component: "server-trace",
              operation: "append",
              logicalWriteBytes: stats.logicalWriteBytes,
              count: stats.count,
              durationMs: stats.durationMs,
            }),
        });
        const delegate =
          config.otlpTracesUrl === undefined
            ? undefined
            : yield* OtlpTracer.make({
                url: config.otlpTracesUrl,
                exportInterval: `${config.otlpExportIntervalMs} millis`,
                resource: {
                  serviceName: config.otlpServiceName,
                  attributes: {
                    "service.runtime": "t3-server",
                    "service.mode": config.mode,
                  },
                },
              });

        const tracer = yield* makeLocalFileTracer({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          sink,
          shouldPersist: shouldPersistServerEffectSpan,
          ...(delegate ? { delegate } : {}),
        });

        return Layer.mergeAll(
          Layer.succeed(Tracer.Tracer, tracer),
          BrowserTraceCollector.layer(sink),
        );
      }),
    ).pipe(Layer.provide(OtlpExporter.layerFlusher), Layer.provideMerge(otlpSerializationLayer));

    const metricsLayer =
      config.otlpMetricsUrl === undefined
        ? Layer.empty
        : OtlpMetrics.layer({
            url: config.otlpMetricsUrl,
            exportInterval: `${config.otlpExportIntervalMs} millis`,
            resource: {
              serviceName: config.otlpServiceName,
              attributes: {
                "service.runtime": "t3-server",
                "service.mode": config.mode,
              },
            },
          }).pipe(Layer.provideMerge(otlpSerializationLayer));

    return Layer.mergeAll(ServerLoggerLive, traceReferencesLayer, tracerLayer, metricsLayer);
  }),
);
