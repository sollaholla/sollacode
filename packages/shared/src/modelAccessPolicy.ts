import type { ModelAccessPolicy, ModelSelection } from "@t3tools/contracts";

export function modelAccessPolicyAllows(
  policy: ModelAccessPolicy | undefined,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): boolean {
  if (!policy || policy.mode === "all") return true;
  const listed = policy.models.some(
    (entry) => entry.instanceId === selection.instanceId && entry.model === selection.model,
  );
  return policy.mode === "allow" ? listed : !listed;
}

export function modelAccessPoliciesAllow(
  policies: ReadonlyArray<ModelAccessPolicy>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): boolean {
  return policies.every((policy) => modelAccessPolicyAllows(policy, selection));
}

/** Shared ancestry walk; missing ancestors and cycles fail closed when rules exist. */
export function threadModelPolicyChain(input: {
  threadId: string;
  policies: Readonly<Record<string, ModelAccessPolicy>>;
  getParent: (id: string) => string | null | undefined;
}): { policies: ReadonlyArray<ModelAccessPolicy>; complete: boolean } {
  const policies: ModelAccessPolicy[] = [];
  const seen = new Set<string>();
  let id: string | null = input.threadId;
  while (id !== null) {
    if (seen.has(id) || seen.size >= 64) return { policies, complete: false };
    seen.add(id);
    const policy = input.policies[id];
    if (policy) policies.push(policy);
    const parent = input.getParent(id);
    if (parent === undefined) return { policies, complete: false };
    id = parent;
  }
  return { policies, complete: true };
}
