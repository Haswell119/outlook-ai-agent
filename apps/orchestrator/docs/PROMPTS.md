# Prompts — Outlook AI Orchestrator

All prompts live in `src/domain/prompts/` (pure builders, no I/O). Each builder returns an
`LlmRequest` (`messages`, `json: true`, `useCase`, `language`) and has a matching **lenient zod
schema** in `schemas.ts` for the raw model JSON. Services then enrich the raw JSON into the
public contracts of `@oao/shared`.

Pipeline for every structured call (`services/llm-helpers.ts` → `LlmProvider.completeJson`):

1. Ask the model for JSON (`LLM_JSON_MODE`: `response_format` → `{type:"json_object"}`,
   `prompt` → instruction only, `auto` → `response_format` first, falls back to `prompt` on HTTP 400).
2. Clean the answer: strip `<think>…</think>` (Qwen3), strip markdown fences, take the first
   balanced `{…}`, tolerate trailing commas.
3. Validate with zod. On failure → **one repair call** ("Fix this JSON to match the schema…").
4. Still invalid / model down → **heuristic degraded result** (`domain/heuristics/email.ts`),
   `confidence ≤ 0.3`, risk `ai_output_unreliable`, plus an `error` audit event.

The audit row stores SHA-256 hashes of prompt and response (raw text only when `AUDIT_STORE_CONTENT=true`).

## Common system prompt (`format.ts` → `SYSTEM_BASE`)

> You are the Outlook AI Orchestrator, an assistant for a Swiss wealth-management firm (Longbow Finance).
> You never send emails, never delete anything and never invent facts… Write every human-readable
> field in {French|English}. Return ONLY a single JSON object matching the requested schema.

Emails are rendered by `formatEmail()` in a stable, greppable block (`### EMAIL … ### END EMAIL`,
`Subject:`, `From:`, `To:`, `Date:`, `Attachments:`, `Body:`), threads by `formatThread()`
(`### MESSAGE n` … oldest first, max 25 messages, 6 000 chars of body per message). The mock provider
parses this format back, so the field labels must stay stable.

## 1. Email analysis — `analysis.ts` (`useCase: email_analysis`)

Input: one `EmailContext` (+ earlier thread messages as context when `includeThread` and Graph are enabled).
Output (`EmailAnalysisLlmSchema`):

```json
{ "language": "fr|en", "summary": "2-3 sentences", "decisions": [], "pendingTasks": [],
  "risks": [{"code","title","description","severity"}],
  "suggestedActions": [{"type": "<ActionType>", "title", "description", "parameters": {}}],
  "quickReplies": ["max 3"], "classification": {"category","confidence"}, "confidence": 0.9 }
```

Rules given to the model: max 5 actions, only allowed action types (unknown types are dropped by the
schema, never fail the whole answer), never suggest sending or deleting. The service adds the phishing
screening (`domain/compliance/phishing.ts`) and rule-based actions (escalate on phishing, flag when attachments).

## 2. Thread synthesis — `thread.ts` (`useCase: thread_synthesis`)

Input: a `ThreadContext`. Output (`ThreadSynthesisLlmSchema`): `executiveSummary`, `missingDocuments`
(name / requestedOn / requestedFrom), `decisions`, `openTasks` (owner, priority, dueDate, done, exactly one
`critical`), `deadlines` (`atRisk`), `risks`, `recommendedActions`, `recommendedNextStep` (with an action), `confidence`.

## 3. Draft reply — `draft.ts` (`useCase: draft_reply`)

Input: email (+ optional thread), `intent` (accept / decline / acknowledge / follow_up / request_info / custom —
each has a one-line guide in `INTENT_GUIDE`), `tone` (formal / neutral / friendly), free-text `instructions`,
target language, the user's display name. Output: `{subject, body (plain text), language, confidence}`.
The draft is **never sent**: the add-in opens it with `displayReplyForm`.

## 4. Chat with citations — `chat.ts` (`useCase: chat_answer`)

Input: the question, the last 10 turns of the session, the retrieved sources numbered `[1]..[n]`
(`### SOURCES` block: subject | from | date | emailId + excerpt) and, when provided, the currently opened
email (always source `[1]`). Output (`ChatAnswerLlmSchema`):

```json
{ "headline": "Client approval detected", "answer": "… cites [1] [2] …",
  "sourceIds": [1, 2], "evidenceSourceId": 1, "quote": "verbatim sentence", "confidence": 0.8 }
```

The service maps `sourceIds` (plus any inline `[n]`) to `SearchSource`s, builds `evidence` from the quoted
source (falls back to the best matching excerpt when the quote is not found verbatim) and instructs the
model to say honestly when the sources do not contain the answer (`sourceIds: []`).

## 5. Classification — `classification.ts` (`useCase: classification`)

"Classify the email into exactly one of these categories: A | B | C." → `{category, confidence, reasons[]}`.
Used for auto-categorisation; the mock maps keyword rules (mandate / invoice / compliance / reporting / meeting / legal / newsletter).

## 6. Compliance content analysis — `compliance.ts` (`useCase: compliance_content`)

Input: the outgoing draft (subject, recipients, body, attachment names + extracted text) and the list of
external recipients. Output: `{sensitive: bool, explanation, categories[], confidence}`. Only called when the
draft has external recipients or attachments. A `sensitive: true` answer becomes a **high**
`sensitive_client_information` issue (regex matches from `Policy.sensitiveDataPatterns` take precedence).

## Language

`domain/language.ts` detects FR/EN with a stop-word ratio (+ accented characters). The answer language is
`language` in the request, else `Accept-Language`, else `DEFAULT_LANGUAGE`. Prompts always name the
target language explicitly.

## Mock provider (`adapters/llm/mock.ts`, `LLM_PROVIDER=mock`)

Deterministic keyword heuristics (approval / request / deadline / urgent / attachment / confidential /
mandate / missing document / meeting / dates) over the same prompt blocks. It produces schema-valid JSON for
all six use cases, so the whole system — and the test-suite — runs without a GPU.
