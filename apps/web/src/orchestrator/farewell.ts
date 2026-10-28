/**
 * Spoken goodbyes, for voice sessions that cannot hang up by tool call
 * (GPT-Live with client delegation has no tools). A session ends once the
 * person says goodbye and the assistant answers with one: either alone is not
 * enough, so "bye for now, but first check the deploy" never cuts a call off.
 */

/** How much of the end of an utterance is searched: the goodbye closes it. */
const TAIL_CHARS = 90;

const PERSON_GOODBYE =
  /\b(?:good-?bye|bye(?:[- ]bye)?|see (?:you|ya)|talk (?:to you )?(?:later|soon|tomorrow)|catch you later|that'?s (?:all|it)(?: for (?:now|today))?|i'?m (?:all )?(?:done|good)(?: for (?:now|today))?|hang up|end (?:the|this) call|gotta go|got to go|have a good (?:one|day|night|evening|weekend)|good ?night)\b/iu;

const ASSISTANT_GOODBYE =
  /\b(?:good-?bye|bye(?:[- ]bye)?|talk (?:to you )?(?:soon|later|tomorrow)|take care|have a (?:good|great|nice) (?:one|day|night|evening|weekend)|catch you later|see you|good ?night|hanging up)\b/iu;

const tail = (text: string) => text.trim().slice(-TAIL_CHARS);

/** Whether the person's last words were a goodbye or a request to hang up. */
export function isPersonGoodbye(text: string): boolean {
  return PERSON_GOODBYE.test(tail(text));
}

/** Whether the assistant closed its turn with a goodbye. */
export function isAssistantGoodbye(text: string): boolean {
  return ASSISTANT_GOODBYE.test(tail(text));
}
