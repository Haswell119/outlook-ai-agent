import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Language } from "@oao/shared";
import type { Config } from "../config.js";
import { languageFromAcceptHeader } from "../domain/language.js";
import { AppError } from "../errors.js";
import type { RequestContext } from "../services/context.js";

/** Validate a body with a shared zod schema → 400 validation_error on failure. */
export function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw AppError.validation("Request validation failed", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

/** Query strings are strings: coerce the numeric keys the shared schemas expect. */
export function coerceQuery(query: Record<string, unknown>, numericKeys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const k of numericKeys) if (typeof out[k] === "string" && out[k] !== "" && !Number.isNaN(Number(out[k]))) out[k] = Number(out[k]);
  for (const k of Object.keys(out)) if (out[k] === "") delete out[k];
  return out;
}

export function requestContext(req: FastifyRequest, cfg: Config, explicit?: Language): RequestContext {
  const language = explicit ?? languageFromAcceptHeader(req.headers["accept-language"], cfg.DEFAULT_LANGUAGE);
  return { user: req.user, language, correlationId: req.id };
}
