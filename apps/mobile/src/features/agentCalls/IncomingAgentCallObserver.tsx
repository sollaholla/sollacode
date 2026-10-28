import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { AgentCall, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { vmAgentEnvironment } from "../../state/vmAgents";
import {
  agentCallKey,
  presentedIncomingCalls,
  selectIncomingCallToPresent,
} from "./agentCallModel";
import { useAppActive } from "./useAppActive";

type ReportCalls = (environmentId: EnvironmentId, calls: ReadonlyArray<AgentCall> | null) => void;

function EnvironmentCallsWatcher(props: {
  readonly environmentId: EnvironmentId;
  readonly report: ReportCalls;
}) {
  const { environmentId, report } = props;
  const callsAtom = useMemo(
    () => vmAgentEnvironment.calls({ environmentId, input: {} }),
    [environmentId],
  );
  const snapshot = Option.getOrNull(AsyncResult.value(useAtomValue(callsAtom)));
  const calls = snapshot?.calls ?? null;
  useEffect(() => {
    report(environmentId, calls);
  }, [calls, environmentId, report]);
  useEffect(() => () => report(environmentId, null), [environmentId, report]);
  return null;
}

/**
 * Puts an agent's call on screen while the app is open.
 *
 * Watches the call stream of every connected host and, when an agent rings the
 * person, presents the call screen, which buzzes and shows Answer and Decline.
 * The phone app has no native push, so nothing rings while it is in the
 * background or locked; the Home Screen web app's push notification covers
 * that. A call that is still ringing when the app comes back to the
 * foreground, or when an open call screen or orchestrator voice view closes,
 * is presented then. Mounted once, in the root stack layout.
 */
export function IncomingAgentCallObserver(props: { readonly voiceScreenOpen: boolean }) {
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const appActive = useAppActive();
  const [callsByEnvironment, setCallsByEnvironment] = useState<
    ReadonlyMap<EnvironmentId, ReadonlyArray<AgentCall>>
  >(() => new Map());

  const report = useCallback<ReportCalls>((environmentId, calls) => {
    setCallsByEnvironment((current) => {
      if (calls === null ? !current.has(environmentId) : current.get(environmentId) === calls) {
        return current;
      }
      const next = new Map(current);
      if (calls === null) next.delete(environmentId);
      else next.set(environmentId, calls);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!appActive || props.voiceScreenOpen) return;
    const nowMs = Date.now();
    for (const [environmentId, calls] of callsByEnvironment) {
      const call = selectIncomingCallToPresent({
        environmentId,
        calls,
        alreadyPresented: presentedIncomingCalls.has,
        nowMs,
      });
      if (call === null) continue;
      presentedIncomingCalls.add(agentCallKey(environmentId, call.callId));
      navigation.navigate("AgentCall", {
        environmentId: String(environmentId),
        callId: String(call.callId),
      });
      return;
    }
  }, [appActive, callsByEnvironment, navigation, props.voiceScreenOpen]);

  return (
    <>
      {environments.map((environment) => (
        <EnvironmentCallsWatcher
          key={environment.environmentId}
          environmentId={environment.environmentId}
          report={report}
        />
      ))}
    </>
  );
}
