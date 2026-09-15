import type { z } from "zod";
import type { EmailContext, Language } from "@oao/shared";
import type { EmbeddingProvider, LlmCompletion, LlmProvider, LlmRequest, LlmUseCase } from "../../ports/llm.js";
import { LlmError } from "../../errors.js";
import { analyzeHeuristically, classify, extractSignals } from "../../domain/heuristics/email.js";
import { detectLanguage } from "../../domain/language.js";
import { tokenize, truncate } from "../../util/text.js";
import { tryParse } from "./openai-compatible.js";

/**
 * Deterministic LLM used for demo (`LLM_PROVIDER=mock`) and tests.
 * It parses the structured prompt blocks produced by `domain/prompts/format.ts`
 * and answers with keyword heuristics, always producing schema-valid JSON.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock-heuristic-v1";
  /** Test hook: when set, the next completion returns this raw text instead. */
  nextRawResponse: string | undefined;
  /** Test hook: when true every call throws (simulates the model being down). */
  failing = false;
  calls = 0;

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    this.calls++;
    if (this.failing) throw new LlmError("network", "mock provider is configured to fail");
    if (this.nextRawResponse !== undefined) {
      const raw = this.nextRawResponse;
      this.nextRawResponse = undefined;
      return { text: raw, model: this.model };
    }
    const lang = req.language ?? "en";
    const user = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const text = JSON.stringify(answer(req.useCase ?? "generic", user, lang), null, 0);
    return { text, model: this.model, usage: { promptTokens: Math.ceil(user.length / 4), completionTokens: Math.ceil(text.length / 4) } };
  }

  async completeJson<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: LlmRequest): Promise<{ data: T; model: string; repaired: boolean; raw: string }> {
    const first = await this.complete(req);
    const parsed = tryParse(schema, first.text);
    if (parsed.ok) return { data: parsed.data, model: first.model, repaired: false, raw: first.text };
    // One repair round, like the real provider: the mock regenerates deterministically.
    const second = await this.complete({ ...req, messages: [...req.messages, { role: "user", content: "Fix this JSON to match the schema." }] });
    const reparsed = tryParse(schema, second.text);
    if (reparsed.ok) return { data: reparsed.data, model: second.model, repaired: true, raw: second.text };
    throw new LlmError("output", `mock output did not match schema: ${reparsed.error}`);
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: !this.failing, detail: "mock provider" };
  }
}

/** Hashed bag-of-words embedding: deterministic, cheap, decent lexical similarity. */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = "mock-hash-embedding";
  constructor(readonly dimensions = 256) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dimensions).fill(0);
      for (const tok of tokenize(t)) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
        const idx = Math.abs(h) % this.dimensions;
        v[idx] = (v[idx] ?? 0) + 1;
      }
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Prompt block parsing                                                */
/* ------------------------------------------------------------------ */

const field = (block: string, name: string): string => {
  const m = new RegExp(`^${name}:\\s*(.*)$`, "m").exec(block);
  return m?.[1]?.trim() ?? "";
};

const parseAddress = (s: string): { name?: string; address: string } | undefined => {
  if (!s || s === "(unknown)") return undefined;
  const m = /^(.*?)\s*<([^>]+)>$/.exec(s);
  return m ? { name: m[1]?.trim() || undefined, address: m[2]!.trim() } : { address: s.trim() };
};

export function parseEmailBlock(block: string): EmailContext {
  const bodyMatch = /^Body:\n([\s\S]*?)(?:\n(?:Attachment text \(|### END))/m.exec(block + "\n### END");
  const attachments = field(block, "Attachments");
  return {
    id: field(block, "Id") || "unknown",
    subject: field(block, "Subject"),
    from: parseAddress(field(block, "From")),
    to: field(block, "To")
      .split(",")
      .map((s) => parseAddress(s.trim()))
      .filter((a): a is { address: string } => Boolean(a) && a!.address !== "(none)"),
    cc: [],
    bcc: [],
    receivedAt: field(block, "Date") || undefined,
    body: (bodyMatch?.[1] ?? "").trim(),
    attachments: attachments && attachments !== "(none)" ? attachments.split(",").map((n) => ({ name: n.trim() })) : [],
    categories: [],
    sensitivityLabel: field(block, "Label") || undefined,
  };
}

function parseEmails(prompt: string): EmailContext[] {
  const blocks = prompt.match(/### (?:EMAIL|MESSAGE \d+)\n[\s\S]*?### END (?:EMAIL|MESSAGE \d+)/g) ?? [];
  return blocks.map(parseEmailBlock);
}

function parseSources(prompt: string): Array<{ id: number; subject: string; from: string; date: string; text: string }> {
  const section = /### SOURCES\n([\s\S]*?)### END SOURCES/.exec(prompt)?.[1] ?? "";
  const out: Array<{ id: number; subject: string; from: string; date: string; text: string }> = [];
  const re = /\[(\d+)\] Subject: (.*?) \| From: (.*?) \| Date: (.*?) \| EmailId: .*\n([\s\S]*?)(?=\n\n\[\d+\] Subject:|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section))) out.push({ id: Number(m[1]), subject: m[2] ?? "", from: m[3] ?? "", date: m[4] ?? "", text: m[5] ?? "" });
  return out;
}

/* ------------------------------------------------------------------ */
/* Use-case answers                                                    */
/* ------------------------------------------------------------------ */

function answer(useCase: LlmUseCase, prompt: string, lang: Language): unknown {
  switch (useCase) {
    case "email_analysis":
      return emailAnalysis(prompt, lang);
    case "thread_synthesis":
      return threadSynthesis(prompt, lang);
    case "draft_reply":
      return draftReply(prompt, lang);
    case "chat_answer":
      return chatAnswer(prompt, lang);
    case "classification":
      return classification(prompt, lang);
    case "compliance_content":
      return complianceContent(prompt, lang);
    default:
      return { answer: lang === "fr" ? "Réponse simulée." : "Simulated answer.", confidence: 0.5 };
  }
}

function emailAnalysis(prompt: string, lang: Language) {
  const emails = parseEmails(prompt);
  const email = emails.find((e) => /### EMAIL/.test(prompt)) ? parseEmailBlock(/### EMAIL\n[\s\S]*?### END EMAIL/.exec(prompt)?.[0] ?? "") : emails[emails.length - 1];
  if (!email) return { language: lang, summary: lang === "fr" ? "Email vide." : "Empty email.", decisions: [], pendingTasks: [], risks: [], suggestedActions: [], quickReplies: [], confidence: 0.4 };
  const h = analyzeHeuristically(email, lang, 0.9);
  const conf = Math.min(0.95, 0.78 + Math.min(h.signals.keyPhrases.length, 4) * 0.04);
  return { ...h, signals: undefined, confidence: Number(conf.toFixed(2)) };
}

function threadSynthesis(prompt: string, lang: Language) {
  const fr = lang === "fr";
  const messages = parseEmails(prompt);
  const subject = /### THREAD "(.*?)"/.exec(prompt)?.[1] ?? messages[0]?.subject ?? "";
  const all = messages.map((m) => `${m.subject}\n${m.body}`).join("\n");
  const signals = extractSignals({ subject, body: all, attachments: messages.flatMap((m) => m.attachments) });
  const participants = Array.from(new Set(messages.map((m) => m.from?.name || m.from?.address).filter(Boolean))) as string[];
  const last = messages[messages.length - 1];
  const missingDocuments: Array<{ name: string; requestedOn?: string; requestedFrom?: string }> = [];
  const missingMsg = messages.find((m) => /signed|signé|mandate|mandat|kyc|passport|passeport|document/i.test(m.body) && /missing|outstanding|still|not yet|toujours pas|manquant|en attente|pending|reste/i.test(m.body));
  if (missingMsg) {
    const name = /(signed [\w\s]+?(?:mandate|agreement|form)|account mandate|mandat de gestion signé|mandat signé|kyc [\w\s]*form|passport copy|copie du passeport|[\w\s]+ signé)/i.exec(missingMsg.body)?.[1]?.trim();
    missingDocuments.push({ name: name ? name.charAt(0).toUpperCase() + name.slice(1) : fr ? "Document en attente" : "Outstanding document", requestedOn: missingMsg.receivedAt?.slice(0, 10), requestedFrom: missingMsg.to[0]?.name ?? missingMsg.to[0]?.address });
  }
  const openTasks = [];
  if (missingDocuments.length) openTasks.push({ title: fr ? `Obtenir ${missingDocuments[0]!.name}` : `Obtain ${missingDocuments[0]!.name}`, owner: last?.to[0]?.name ?? participants[0], priority: "high", critical: true, done: false });
  if (/kyc/i.test(all)) openTasks.push({ title: fr ? "Finaliser la validation KYC" : "Complete KYC validation", owner: fr ? "Équipe Compliance" : "Compliance Team", priority: "medium", done: /kyc.{0,60}(complete|validated|done|terminé|validé)/i.test(all), critical: false });
  if (/legal|juridique|sign-off|signature/i.test(all)) openTasks.push({ title: fr ? "Validation finale du service juridique" : "Legal final sign-off", owner: fr ? "Service juridique" : "Legal Team", priority: "medium", done: false, critical: false });
  if (signals.request && !openTasks.length) openTasks.push({ title: fr ? `Répondre à la dernière demande de ${last?.from?.name ?? "l'expéditeur"}` : `Answer the latest request from ${last?.from?.name ?? "the sender"}`, priority: "medium", done: false, critical: true });
  const deadlines = signals.dates.slice(0, 2).map((d, i) => ({ title: i === 0 ? (fr ? `Date cible : ${d}` : `Target date: ${d}`) : d, date: d, atRisk: i === 0 && missingDocuments.length > 0, description: i === 0 && missingDocuments.length ? (fr ? "Risque de retard si le document manquant n'est pas reçu." : "Risk of delay if the missing document is not received.") : undefined }));
  const risks = [];
  if (missingDocuments.length) risks.push({ code: "missing_document", title: fr ? "Document manquant bloquant" : "Blocking missing document", severity: "high" });
  if (deadlines.length) risks.push({ code: "deadline_at_risk", title: fr ? "Échéance proche" : "Approaching deadline", severity: "medium" });
  if (signals.confidential) risks.push({ code: "confidential_content", title: fr ? "Contenu confidentiel" : "Confidential content", severity: "medium" });
  const decisions = messages.filter((m) => /approv|confirm|agree|validé|accord|green light/i.test(m.body)).map((m) => (fr ? `${m.from?.name ?? m.from?.address}: approbation/confirmation dans « ${m.subject} »` : `${m.from?.name ?? m.from?.address}: approval/confirmation in "${m.subject}"`)).slice(0, 4);
  const nextAction = missingDocuments.length
    ? { type: "draft_reply", title: fr ? "Rédiger la relance" : "Draft follow-up email", description: fr ? `Demander ${missingDocuments[0]!.name}.` : `Request the ${missingDocuments[0]!.name}.`, parameters: { intent: "follow_up" } }
    : { type: "draft_reply", title: fr ? "Rédiger une réponse" : "Draft a reply", description: fr ? "Répondre au dernier message." : "Reply to the latest message.", parameters: { intent: "acknowledge" } };
  const recommendedActions = [
    nextAction,
    { type: "create_task", title: fr ? "Créer une tâche" : "Create task", description: fr ? "Ajouter à votre liste de tâches" : "Add to your task list", parameters: { title: openTasks[0]?.title ?? subject } },
    { type: "create_reminder", title: fr ? "Définir un rappel" : "Set reminder", description: fr ? "Pour le suivi du document" : "For document follow-up", parameters: { title: `${fr ? "Suivi" : "Follow-up"}: ${subject}`, dueDate: deadlines[0]?.date } },
    { type: "notify", title: fr ? "Partager la synthèse" : "Share summary", description: fr ? "Copier ou envoyer la synthèse" : "Copy summary or send", parameters: {} },
  ];
  const summary = fr
    ? `Cette conversation (${messages.length} messages, ${participants.slice(0, 3).join(", ")}) porte sur « ${subject} ». ${missingDocuments.length ? `La plupart des éléments ont été fournis mais ${missingDocuments[0]!.name} reste en attente. ` : ""}${deadlines[0] ? `La date cible (${deadlines[0].date}) approche.` : "Aucune échéance explicite n'est mentionnée."}`
    : `This conversation (${messages.length} messages between ${participants.slice(0, 3).join(", ")}) covers "${subject}". ${missingDocuments.length ? `Most required items have been provided, but ${missingDocuments[0]!.name} is still outstanding. ` : ""}${deadlines[0] ? `The target date (${deadlines[0].date}) is approaching.` : "No explicit deadline is mentioned."}`;
  return {
    language: lang,
    executiveSummary: summary,
    missingDocuments,
    decisions,
    openTasks,
    deadlines,
    risks,
    recommendedActions,
    recommendedNextStep: { title: nextAction.title, description: nextAction.description, action: nextAction },
    confidence: Number(Math.min(0.94, 0.7 + messages.length * 0.03).toFixed(2)),
  };
}

function draftReply(prompt: string, lang: Language) {
  const fr = lang === "fr";
  const email = parseEmails(prompt)[0];
  const intent = /Intent: (\w+)/.exec(prompt)?.[1] ?? "custom";
  const tone = /Tone: (\w+)/.exec(prompt)?.[1] ?? "formal";
  const instructions = /User instructions: (.*)/.exec(prompt)?.[1];
  const onBehalf = /on behalf of (.*?)\./.exec(prompt)?.[1];
  const senderName = email?.from?.name?.split(" ")[0] ?? "";
  const subject = email?.subject ? (/^(re|tr|fw|fwd)\s*:/i.test(email.subject) ? email.subject : `${fr ? "RE" : "Re"}: ${email.subject}`) : fr ? "RE: votre message" : "Re: your message";
  const s = email ? extractSignals(email) : undefined;
  const greeting = fr ? (tone === "friendly" ? `Bonjour ${senderName},` : `Bonjour ${senderName || "Madame, Monsieur"},`) : tone === "friendly" ? `Hi ${senderName},` : `Dear ${senderName || "Sir or Madam"},`;
  const closing = fr ? (tone === "friendly" ? "Bien à vous," : "Meilleures salutations,") : tone === "friendly" ? "Best," : "Kind regards,";
  const body: Record<string, string> = fr
    ? {
        accept: `Merci pour votre message concernant « ${email?.subject ?? ""} ». Nous confirmons notre accord et procéderons comme proposé.${s?.dates[0] ? ` Nous respecterons la date du ${s.dates[0]}.` : ""}`,
        decline: `Merci pour votre message concernant « ${email?.subject ?? ""} ». Après examen, nous ne sommes malheureusement pas en mesure de donner suite à cette demande en l'état. Nous restons à disposition pour envisager une alternative.`,
        acknowledge: `Nous accusons réception de votre message concernant « ${email?.subject ?? ""} »${s?.attachment ? " ainsi que des documents joints" : ""}. Nous l'examinons et reviendrons vers vous dans les meilleurs délais.`,
        follow_up: `Je me permets de revenir vers vous au sujet de « ${email?.subject ?? ""} ». ${s?.missingDocument ? "Nous sommes toujours dans l'attente de l'élément mentionné. " : ""}Pourriez-vous nous indiquer où en est ce point${s?.dates[0] ? ` avant le ${s.dates[0]}` : " dans les prochains jours"} ?`,
        request_info: `Merci pour votre message concernant « ${email?.subject ?? ""} ». Afin de poursuivre, pourriez-vous nous transmettre les informations et documents complémentaires nécessaires ? Nous restons à disposition pour toute question.`,
        custom: `Merci pour votre message concernant « ${email?.subject ?? ""} ». ${instructions ?? "Nous l'avons bien pris en compte et reviendrons vers vous rapidement."}`,
      }
    : {
        accept: `Thank you for your message regarding "${email?.subject ?? ""}". We confirm our agreement and will proceed as proposed.${s?.dates[0] ? ` We will meet the ${s.dates[0]} date.` : ""}`,
        decline: `Thank you for your message regarding "${email?.subject ?? ""}". After review, we are unfortunately not in a position to proceed with this request as it stands. We remain available to discuss an alternative.`,
        acknowledge: `We acknowledge receipt of your message regarding "${email?.subject ?? ""}"${s?.attachment ? " and the attached documents" : ""}. We are reviewing it and will come back to you shortly.`,
        follow_up: `I am following up on "${email?.subject ?? ""}". ${s?.missingDocument ? "We are still waiting for the outstanding item mentioned. " : ""}Could you let us know the status${s?.dates[0] ? ` before ${s.dates[0]}` : " in the coming days"}?`,
        request_info: `Thank you for your message regarding "${email?.subject ?? ""}". In order to proceed, could you please send us the additional information and documents required? We remain available for any question.`,
        custom: `Thank you for your message regarding "${email?.subject ?? ""}". ${instructions ?? "We have taken note of it and will revert shortly."}`,
      };
  const text = `${greeting}\n\n${body[intent] ?? body.custom}\n\n${closing}\n${onBehalf && onBehalf !== "the recipient" ? onBehalf : ""}`.trim();
  return { subject, body: text, language: lang, confidence: 0.86 };
}

function chatAnswer(prompt: string, lang: Language) {
  const fr = lang === "fr";
  const question = /Question: (.*)/.exec(prompt)?.[1] ?? "";
  const sources = parseSources(prompt);
  if (!sources.length) {
    return { answer: fr ? "Je n'ai trouvé aucun email correspondant dans votre boîte indexée. Essayez d'autres mots-clés ou indexez davantage d'emails." : "I could not find any matching email in your indexed mailbox. Try other keywords or index more emails.", sourceIds: [], confidence: 0.3 };
  }
  const qTerms = new Set(tokenize(question).filter((t) => t.length > 3));
  const scored = sources
    .map((s) => {
      const toks = tokenize(`${s.subject} ${s.text}`);
      const overlap = toks.filter((t) => qTerms.has(t)).length;
      return { s, score: overlap / Math.max(1, qTerms.size) + (sources.indexOf(s) === 0 ? 0.1 : 0) };
    })
    .sort((a, b) => b.score - a.score);
  const used = scored.slice(0, 3).map((x) => x.s);
  const top = used[0]!;
  const sentence = top.text
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 20)
    .sort((a, b) => tokenize(b).filter((t) => qTerms.has(t)).length - tokenize(a).filter((t) => qTerms.has(t)).length)[0];
  const approval = /approv|confirm|accord|valid/i.test(question) && /approv|confirm|accord|valid/i.test(top.text);
  const headline = approval ? (fr ? "Approbation du client détectée" : "Client approval detected") : fr ? `${used.length} email(s) pertinent(s) trouvé(s)` : `${used.length} relevant email(s) found`;
  const cites = used.slice(1).map((u) => `[${u.id}]`).join(" ");
  const answer = fr
    ? `J'ai trouvé ${sources.length} email(s) susceptibles de répondre à votre question. Le plus pertinent est « ${top.subject} » de ${top.from} (${top.date}) [${top.id}]. ${sentence ? `Extrait : « ${truncate(sentence, 240)} » [${top.id}]. ` : ""}${used.length > 1 ? `Voir aussi ${cites}.` : ""}`
    : `I found ${sources.length} email(s) that may answer your question. The most relevant is "${top.subject}" from ${top.from} (${top.date}) [${top.id}]. ${sentence ? `Excerpt: "${truncate(sentence, 240)}" [${top.id}]. ` : ""}${used.length > 1 ? `See also ${cites}.` : ""}`;
  return { headline, answer: answer.trim(), sourceIds: used.map((u) => u.id), evidenceSourceId: top.id, quote: sentence ? truncate(sentence, 300) : undefined, confidence: Number(Math.min(0.95, 0.55 + (scored[0]?.score ?? 0) * 0.4).toFixed(2)) };
}

function classification(prompt: string, lang: Language) {
  const email = parseEmails(prompt)[0];
  const allowed = /exactly one of these categories: (.*?)\./.exec(prompt)?.[1]?.split("|").map((s) => s.trim()) ?? [];
  const c = email ? classify(email, lang) : { category: allowed[0] ?? "General", confidence: 0.5 };
  const match = allowed.find((a) => a.toLowerCase() === c.category.toLowerCase()) ?? allowed.find((a) => c.category.toLowerCase().includes(a.toLowerCase().split(" ")[0] ?? "")) ?? allowed[0] ?? c.category;
  return { category: match, confidence: c.confidence, reasons: [lang === "fr" ? "Mots-clés détectés dans l'objet et le corps" : "Keywords detected in subject and body"] };
}

function complianceContent(prompt: string, lang: Language) {
  const fr = lang === "fr";
  const draft = /### DRAFT\n([\s\S]*?)### END DRAFT/.exec(prompt)?.[1] ?? "";
  const lower = draft.toLowerCase();
  const categories: string[] = [];
  if (/portfolio|portefeuille|performance|holdings|positions|aum|valuation|valorisation|return|rendement/.test(lower)) categories.push("portfolio data");
  if (/iban|account number|numéro de compte|compte n|swift/.test(lower)) categories.push("account identifiers");
  if (/password|mot de passe|credentials|identifiants/.test(lower)) categories.push("credentials");
  if (/passport|passeport|date of birth|date de naissance|avs|social security/.test(lower)) categories.push("personal data");
  if (/confidential|confidentiel|internal only|strictly|strictement/.test(lower)) categories.push("confidential marking");
  if (/client|mandate|mandat|kyc/.test(lower) && /\d{3,}/.test(lower)) categories.push("client identity");
  const sensitive = categories.length > 0;
  const language = detectLanguage(draft, lang);
  const explanation = sensitive
    ? fr || language === "fr"
      ? `Le contenu semble contenir des informations sensibles (${categories.join(", ")}).`
      : `The content appears to contain sensitive information (${categories.join(", ")}).`
    : fr
      ? "Aucune information client sensible détectée dans le contenu."
      : "No sensitive client information detected in the content.";
  return { sensitive, explanation, categories, confidence: sensitive ? 0.82 : 0.7 };
}
