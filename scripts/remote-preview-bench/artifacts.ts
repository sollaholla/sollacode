/** Keep raw evidence for each network condition instead of overwriting an earlier run. */
export function sceneSampleLabel(input: {
  readonly scene: string;
  readonly mode: string;
  readonly viewer: string;
  readonly condition: "loopback" | "slow";
}): string {
  return `${input.condition}-${input.scene}-${input.mode}-${input.viewer}`;
}
