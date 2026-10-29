import {
  OPENAI_LIVE_VOICES,
  XAI_REALTIME_VOICES,
  type EnvironmentId,
  type VmAgent,
} from "@t3tools/contracts";
import {
  AGENT_CALL_VOICE_DETAILS,
  agentCallVoice,
  automaticAgentCallVoice,
  isAgentCallVoice,
  type AgentCallVoice,
} from "@t3tools/shared/agentCallVoice";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { useAtomCommand } from "../../state/use-atom-command";
import { vmAgentEnvironment } from "../../state/vmAgents";

const AUTOMATIC = "automatic";

/**
 * The agent screen's **Call voice** row: the voice the agent speaks with on
 * calls, from its next call, chosen from a native menu. Automatic follows the
 * agent's character, the same rule the web picker and the host use; a Grok
 * voice puts the agent's calls on Grok Voice.
 */
export function AgentVoiceRow(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
}) {
  const { agent } = props;
  const setVoice = useAtomCommand(vmAgentEnvironment.setVoice, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const chosen = isAgentCallVoice(agent.voice) ? agent.voice : null;
  const current = AGENT_CALL_VOICE_DETAILS[agentCallVoice(agent)];
  const voiceAction = (voice: AgentCallVoice) => ({
    id: voice,
    title: AGENT_CALL_VOICE_DETAILS[voice].label,
    subtitle: AGENT_CALL_VOICE_DETAILS[voice].detail,
    state: chosen === voice ? ("on" as const) : ("off" as const),
  });
  const actions = [
    {
      id: AUTOMATIC,
      title: "Automatic",
      subtitle: `${AGENT_CALL_VOICE_DETAILS[automaticAgentCallVoice(agent)].label}, from its look`,
      state: chosen === null ? ("on" as const) : ("off" as const),
    },
    {
      id: "gpt-live",
      title: "GPT-Live",
      subactions: OPENAI_LIVE_VOICES.map(voiceAction),
    },
    {
      id: "grok",
      title: "Grok Voice",
      subactions: XAI_REALTIME_VOICES.map(voiceAction),
    },
  ];
  return (
    <View className="min-w-0 gap-1">
      <ControlPillMenu
        actions={actions}
        title={`${agent.name} speaks with`}
        onPressAction={({ nativeEvent }) => {
          const voice = isAgentCallVoice(nativeEvent.event) ? nativeEvent.event : null;
          if (voice === chosen) return;
          setError(null);
          void setVoice({
            environmentId: props.environmentId,
            input: { vmAgentId: agent.vmAgentId, voice },
          }).then((result) => {
            if (result._tag === "Failure") setError("The voice could not be changed.");
          });
        }}
      >
        <Pressable
          accessibilityLabel={`Call voice: ${current.label}`}
          accessibilityRole="button"
          className="min-h-11 min-w-0 flex-row items-center gap-3 rounded-xl border border-border px-4"
        >
          <SymbolView name="waveform" size={17} tintColor="#737373" />
          <Text className="min-w-0 flex-1 font-t3-bold text-foreground">Call voice</Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {current.label}
          </Text>
          <SymbolView name="chevron.up.chevron.down" size={13} tintColor="#737373" />
        </Pressable>
      </ControlPillMenu>
      {error !== null ? (
        <Text className="text-sm text-red-600 dark:text-red-300">{error}</Text>
      ) : null}
    </View>
  );
}
