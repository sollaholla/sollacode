import type { OrchestrationProposedPlan } from "@t3tools/contracts";
import { proposedPlanTitle } from "@t3tools/shared/proposedPlans";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MarkdownDocument } from "../files/FileMarkdownPreview";

export interface PendingPlanCardProps {
  readonly plan: OrchestrationProposedPlan;
  readonly isImplementing: boolean;
  readonly implementDisabled: boolean;
  /** Plan mode: a typed reply refines the plan. Otherwise it is sent as given. */
  readonly repliesRefine: boolean;
  readonly onImplement: () => void;
  /** Stops waiting on the plan without sending the agent anything. */
  readonly onClose: () => void;
}

/**
 * The plan this thread is waiting on, named and readable on the phone, with
 * the same Implement the web composer offers. Without it a phone showed
 * "Plan Ready" with no way to see or approve the plan.
 */
export function PendingPlanCard(props: PendingPlanCardProps) {
  const [expanded, setExpanded] = useState(false);
  const title = proposedPlanTitle(props.plan.planMarkdown) ?? "Proposed plan";
  // Opaque for the same reason as PendingApprovalCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-violet-700 dark:text-violet-300">
        {props.isImplementing ? "Starting implementation…" : "Plan ready"}
      </Text>
      <Text
        className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50"
        numberOfLines={2}
      >
        {title}
      </Text>
      {expanded ? (
        <ScrollView className="max-h-80" nestedScrollEnabled>
          <MarkdownDocument markdown={props.plan.planMarkdown} />
        </ScrollView>
      ) : null}
      <Text className="font-sans text-sm leading-normal text-neutral-600 dark:text-neutral-400">
        {props.repliesRefine
          ? "Implement it, or reply below to refine it."
          : "Implement it, or reply below with instructions for it."}
      </Text>
      <View className="flex-row flex-wrap gap-2.5">
        <Pressable
          accessibilityRole="button"
          className="min-h-11 items-center justify-center rounded-[14px] bg-violet-600 px-3.5 py-3"
          disabled={props.isImplementing || props.implementDisabled}
          onPress={props.onImplement}
        >
          <Text className="font-t3-extrabold text-sm text-white">Implement</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          className="min-h-11 items-center justify-center rounded-[14px] bg-neutral-200 px-3.5 py-3 dark:bg-neutral-800"
          onPress={() => setExpanded((value) => !value)}
        >
          <Text className="font-t3-bold text-sm text-neutral-950 dark:text-neutral-50">
            {expanded ? "Hide plan" : "Read plan"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Stops waiting on this plan without sending anything"
          className="min-h-11 items-center justify-center rounded-[14px] px-3.5 py-3"
          disabled={props.isImplementing}
          onPress={props.onClose}
        >
          <Text className="font-t3-bold text-sm text-neutral-600 dark:text-neutral-400">
            Close plan
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Where a plan closed on this phone was, with the way back. */
export function ClosedPlanNotice(props: {
  readonly plan: OrchestrationProposedPlan;
  readonly onReopen: () => void;
}) {
  const title = proposedPlanTitle(props.plan.planMarkdown) ?? "Proposed plan";
  return (
    <View className="flex-row items-center gap-3 rounded-[20px] border border-neutral-200 bg-neutral-100 px-4 py-2 dark:border-white/6 dark:bg-neutral-900">
      <Text
        className="flex-1 font-sans text-sm text-neutral-600 dark:text-neutral-400"
        numberOfLines={1}
      >
        Closed “{title}”
      </Text>
      <Pressable
        accessibilityRole="button"
        className="min-h-11 items-center justify-center rounded-[14px] px-3 py-2"
        onPress={props.onReopen}
      >
        <Text className="font-t3-bold text-sm text-violet-700 dark:text-violet-300">Reopen</Text>
      </Pressable>
    </View>
  );
}
