/**
 * Whether this device is on an agent call.
 *
 * One microphone per device: the orchestrator's voice session checks this
 * before it opens its own, so the keybinding, the floating bubble and the
 * awaited-work wake cannot start it in the middle of a call. Starting a call
 * stops the orchestrator the other way round.
 */
let live = false;

export function isAgentCallLive(): boolean {
  return live;
}

export function setAgentCallLive(next: boolean): void {
  live = next;
}
