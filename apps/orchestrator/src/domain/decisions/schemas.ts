import { z } from "zod";

/**
 * Validation of the *internal* decision request, and the limits every
 * question must respect. Adapters validate against this before anything
 * leaves the process; the builders in this folder produce requests that pass.
 */

/**
 * Hard ceiling on the options of one question. The engine renders every
 * option into a fixed token budget shared with the instructions (Laya:
 * `head_max_len` = 192 tokens on the English checkpoint, 256 on the
 * multilingual one); past ~15 options each label keeps only a few tokens and
 * accuracy collapses. A larger label set needs one more hierarchy level —
 * which is exactly why folders are asked per business area.
 */
export const MAX_DECISION_OPTIONS = 15;

/** Minimum options of a `choice` question (a single option is not a decision). */
export const MIN_DECISION_OPTIONS = 2;

/** Option ids: stable, language-independent, lower-case — safe as metric labels and cache-key material. */
export const OPTION_ID_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/** Question ids. */
export const QUESTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

/** Checkpoint names (`english`, `multilingual`, `convaiinnovations/laya-multilingual`, …). */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** Upper bound on one option description sent to the engine (the taxonomy is stricter, see taxonomy.ts). */
export const MAX_CRITERION_CHARS = 400;

/** Upper bound on the serialised state: the builder stays far below; this only catches a wrong object being passed. */
export const MAX_STATE_JSON_CHARS = 32_000;

export const DecisionChoiceQuestionSchema = z
  .object({
    type: z.literal("choice"),
    instructions: z.string().trim().min(1).max(1_000),
    criteria: z
      .record(z.string().regex(OPTION_ID_PATTERN, "option ids must match ^[a-z][a-z0-9_]{0,47}$"), z.string().trim().min(1).max(MAX_CRITERION_CHARS))
      .refine((c) => Object.keys(c).length >= MIN_DECISION_OPTIONS, `a choice question needs at least ${MIN_DECISION_OPTIONS} options`)
      .refine((c) => Object.keys(c).length <= MAX_DECISION_OPTIONS, `a choice question accepts at most ${MAX_DECISION_OPTIONS} options`),
  })
  .strict();

/** Every primitive enabled in v1 (`choice` only). */
export const DecisionQuestionSchema = DecisionChoiceQuestionSchema;

export const DecisionProviderRequestSchema = z
  .object({
    state: z.record(z.string(), z.unknown()).refine((s) => {
      try {
        return JSON.stringify(s).length <= MAX_STATE_JSON_CHARS;
      } catch {
        return false; // circular / BigInt: not serialisable, never sent
      }
    }, `state must be JSON-serialisable and at most ${MAX_STATE_JSON_CHARS} characters once serialised`),
    questions: z
      .record(z.string().regex(QUESTION_ID_PATTERN, "question ids must match ^[A-Za-z][A-Za-z0-9_]{0,47}$"), DecisionQuestionSchema)
      .refine((q) => Object.keys(q).length > 0, "at least one question is required"),
    model: z.string().regex(MODEL_NAME_PATTERN, "invalid model name").optional(),
  })
  .strict();
