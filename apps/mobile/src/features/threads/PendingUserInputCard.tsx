import type { ApprovalRequestId } from "@t3tools/contracts";
import { ACTION_APPROVAL_CHOICE, isActionApprovalQuestion } from "@t3tools/shared/actionApproval";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { PendingUserInput, PendingUserInputDraftAnswer } from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly pendingUserInput: PendingUserInput;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly onSelectOption: (
    requestId: ApprovalRequestId,
    questionId: string,
    label: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: (answersOverride?: Record<string, string>) => Promise<unknown>;
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const hasActionApproval = props.pendingUserInput.questions.some(isActionApprovalQuestion);
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;
  // The surface is opaque on purpose: the card floats over the thread feed
  // with no blur behind it, so a translucent background renders the questions
  // on top of whatever message happens to sit underneath.
  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
        {isResponding ? "Resolving response…" : "User input needed"}
      </Text>
      <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">
        {hasActionApproval ? "Review the proposed action" : "Fill in the pending answers"}
      </Text>
      {props.pendingUserInput.questions.map((question) => {
        const draft = props.drafts[question.id];
        const isActionApproval = isActionApprovalQuestion(question);
        return (
          <View key={question.id} className="gap-2 pt-1">
            <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-neutral-500 dark:text-neutral-500">
              {isActionApproval ? "Action approval" : question.header}
            </Text>
            {isActionApproval ? (
              <ScrollView className="max-h-64 rounded-2xl border border-neutral-200 bg-white p-3 dark:border-white/8 dark:bg-neutral-950/70">
                <Text className="font-mono text-sm leading-relaxed text-neutral-950 dark:text-neutral-50">
                  {question.question}
                </Text>
              </ScrollView>
            ) : (
              <Text className="font-sans text-base leading-snug text-neutral-950 dark:text-neutral-50">
                {question.question}
              </Text>
            )}
            <View className="flex-row flex-wrap gap-2.5">
              {question.options.map((option) => {
                const selected =
                  draft?.selectedOptionLabel === option.label && !draft.customAnswer?.trim().length;
                return (
                  <Pressable
                    key={option.label}
                    disabled={isResponding}
                    className={cn(
                      "min-h-11 justify-center rounded-full border px-3 py-2.5 ",
                      selected
                        ? "border-blue-300/50 bg-blue-50 dark:border-blue-400/28 dark:bg-blue-400/14"
                        : "border-neutral-200 bg-white dark:border-white/6 dark:bg-neutral-950/70",
                    )}
                    onPress={() => {
                      props.onSelectOption(
                        props.pendingUserInput.requestId,
                        question.id,
                        option.label,
                      );
                      if (isActionApproval && option.label === ACTION_APPROVAL_CHOICE) {
                        void props.onSubmit({ [question.id]: option.label });
                      }
                    }}
                  >
                    <Text
                      className={cn(
                        "font-t3-bold text-sm",
                        selected
                          ? "text-sky-700 dark:text-sky-300"
                          : "text-neutral-600 dark:text-neutral-300",
                      )}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              editable={!isResponding}
              value={draft?.customAnswer ?? ""}
              onChangeText={(value) =>
                props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
              }
              placeholder={
                isActionApproval ? "Type corrections for the agent" : "Or type a custom answer"
              }
              className="min-h-[54px] rounded-2xl border border-neutral-200 bg-white px-3.5 py-3 font-sans text-base text-neutral-950 dark:border-white/8 dark:bg-neutral-950/70 dark:text-neutral-50"
            />
          </View>
        );
      })}
      <Pressable
        className={cn(
          "min-h-11 items-center justify-center rounded-2xl px-4 py-3.5",
          props.answers ? "bg-blue-500" : "bg-neutral-200 dark:bg-neutral-700/60",
        )}
        disabled={props.answers === null || isResponding}
        onPress={() => void props.onSubmit()}
      >
        <Text className="font-t3-extrabold text-sm text-white">
          {isResponding ? "Resolving…" : hasActionApproval ? "Request changes" : "Submit answers"}
        </Text>
      </Pressable>
    </View>
  );
}
