import * as Schema from "effect/Schema";

export const JEV_FREE_MODEL = "jev-1.13-free";
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Probability = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);
const Probabilities = Schema.Record(Schema.String, Probability);

const Question = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("noul"),
    instructions: Text,
    criteria: Schema.optional(Schema.Struct({ true: Text, false: Text })),
  }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    instructions: Text,
    criteria: Schema.Record(Id, Schema.NullOr(Text)).check(
      Schema.isMinProperties(1),
      Schema.isMaxProperties(255),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    instructions: Text,
    criteria: Schema.Array(Text).check(Schema.isMinLength(2), Schema.isMaxLength(10)),
  }),
]);

/** The initial tool accepts text state and rubrics; structured state can be serialized as text. */
export const JevDecideInput = Schema.Struct({
  state: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  questions: Schema.Record(Id, Question).check(
    Schema.isMinProperties(1),
    Schema.isMaxProperties(32),
  ),
});
export type JevDecideInput = typeof JevDecideInput.Type;

const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("noul"), noul: Probability }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    confidence: Probability,
    probabilities: Probabilities,
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Number.check(Schema.isFinite()),
    confidence: Probability,
    probabilities: Probabilities,
    legend: Schema.Record(Schema.String, Schema.String),
  }),
]);

export const JevDecideResult = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, Answer),
  usage: Schema.Struct({
    input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    output_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  cost: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
});
export type JevDecideResult = typeof JevDecideResult.Type;

export class JevDecideError extends Schema.TaggedErrorClass<JevDecideError>()("JevDecideError", {
  message: Schema.String,
  status: Schema.optional(Schema.Int),
}) {}
