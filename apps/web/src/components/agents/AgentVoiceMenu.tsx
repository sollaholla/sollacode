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
import { AudioLinesIcon } from "lucide-react";

import { useAtomCommand } from "../../state/use-atom-command";
import { vmAgentEnvironment } from "../../state/vmAgents";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";

/** The radio value for "give it the voice its character picks". */
const AUTOMATIC = "automatic";

/**
 * The agent menu's **Call voice** submenu: the voice the agent speaks with on
 * calls, from its next call. Automatic follows its character, so each agent
 * sounds different without anyone choosing. A Grok voice puts the agent's
 * calls on Grok Voice.
 */
export function AgentVoiceMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
}) {
  const setVoice = useAtomCommand(vmAgentEnvironment.setVoice);
  const { agent } = props;
  const chosen = isAgentCallVoice(agent.voice) ? agent.voice : null;
  const automatic = AGENT_CALL_VOICE_DETAILS[automaticAgentCallVoice(agent)].label;
  return (
    <MenuSub>
      <MenuSubTrigger>
        <AudioLinesIcon />
        <span className="min-w-0 flex-1 truncate">Call voice</span>
        <span className="text-xs text-muted-foreground">
          {AGENT_CALL_VOICE_DETAILS[agentCallVoice(agent)].label}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup className="max-h-[min(28rem,var(--available-height))] w-64 overflow-y-auto">
        {/* Base UI throws (error #31) for a label outside its group. */}
        <MenuGroup>
          <MenuGroupLabel>{agent.name} speaks with</MenuGroupLabel>
          <MenuRadioGroup
            value={chosen ?? AUTOMATIC}
            onValueChange={(value) => {
              const voice = isAgentCallVoice(value) ? value : null;
              if (voice === chosen) return;
              void setVoice({
                environmentId: props.environmentId,
                input: { vmAgentId: agent.vmAgentId, voice },
              });
            }}
          >
            <MenuRadioItem value={AUTOMATIC}>
              <span className="block">Automatic</span>
              <span className="block text-xs text-muted-foreground">
                {automatic}, from its look
              </span>
            </MenuRadioItem>
            <MenuGroupLabel>GPT-Live</MenuGroupLabel>
            {OPENAI_LIVE_VOICES.map((voice) => (
              <VoiceItem key={voice} voice={voice} />
            ))}
            <MenuGroupLabel>Grok Voice</MenuGroupLabel>
            {XAI_REALTIME_VOICES.map((voice) => (
              <VoiceItem key={voice} voice={voice} />
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}

function VoiceItem(props: { readonly voice: AgentCallVoice }) {
  const details = AGENT_CALL_VOICE_DETAILS[props.voice];
  return (
    <MenuRadioItem value={props.voice}>
      <span className="block">{details.label}</span>
      <span className="block text-xs text-muted-foreground">{details.detail}</span>
    </MenuRadioItem>
  );
}
