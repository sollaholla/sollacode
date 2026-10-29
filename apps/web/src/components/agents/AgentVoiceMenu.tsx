import { OPENAI_LIVE_VOICES, type EnvironmentId, type VmAgent } from "@t3tools/contracts";
import {
  AGENT_CALL_VOICE_DETAILS,
  agentCallVoice,
  automaticAgentCallVoice,
  isAgentCallVoice,
} from "@t3tools/shared/agentCallVoice";
import { AudioLinesIcon } from "lucide-react";

import { useAtomCommand } from "../../state/use-atom-command";
import { vmAgentEnvironment } from "../../state/vmAgents";
import {
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
 * sounds different without anyone choosing.
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
            <span className="block text-xs text-muted-foreground">{automatic}, from its look</span>
          </MenuRadioItem>
          {OPENAI_LIVE_VOICES.map((voice) => (
            <MenuRadioItem key={voice} value={voice}>
              <span className="block">{AGENT_CALL_VOICE_DETAILS[voice].label}</span>
              <span className="block text-xs text-muted-foreground">
                {AGENT_CALL_VOICE_DETAILS[voice].detail}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
