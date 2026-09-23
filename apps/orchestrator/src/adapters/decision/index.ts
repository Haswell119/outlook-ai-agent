import type { Config } from "../../config.js";
import type { Metrics } from "../../metrics.js";
import type { DecisionProvider } from "../../ports/decision.js";
import { DisabledDecisionProvider } from "./disabled.js";
import { LayaHttpDecisionProvider } from "./laya-http.js";
import { MockDecisionProvider } from "./mock.js";
import { ResilientDecisionProvider } from "./resilient.js";

export { DisabledDecisionProvider } from "./disabled.js";
export { LayaHttpDecisionProvider, LayaChoiceAnswerSchema, LayaHealthSchema, LayaResponseSchema, type LayaHttpOptions } from "./laya-http.js";
export { MockDecisionProvider, type MockDecisionOptions } from "./mock.js";
export { ResilientDecisionProvider, type DecisionCallSample, type DecisionProviderStats, type ResilienceOptions } from "./resilient.js";

export interface DecisionProviderDeps {
  logger?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void; debug: (obj: unknown, msg?: string) => void };
  metrics?: Metrics;
  fetchImpl?: typeof fetch;
}

export interface CreatedDecisionProvider {
  /** What the services call. */
  provider: DecisionProvider;
  /** The resilience wrapper (circuit + concurrency), absent for `disabled` or when bypassed. */
  resilient?: ResilientDecisionProvider;
}

/**
 * Composition-root helper, explicit per `DECISION_PROVIDER` — no module-level
 * singleton:
 *  - `disabled` → `DisabledDecisionProvider` (never called);
 *  - `mock`     → `MockDecisionProvider` behind the resilience wrapper;
 *  - `laya`     → `LayaHttpDecisionProvider` behind the resilience wrapper.
 * `base` replaces the inner provider (tests); `skipResilience` returns it bare.
 */
export function createDecisionProvider(cfg: Config, deps: DecisionProviderDeps = {}, base?: DecisionProvider, skipResilience = false): CreatedDecisionProvider {
  if (cfg.DECISION_PROVIDER === "disabled") return { provider: new DisabledDecisionProvider() };
  const inner =
    base ??
    (cfg.DECISION_PROVIDER === "mock"
      ? new MockDecisionProvider()
      : new LayaHttpDecisionProvider({ baseUrl: cfg.LAYA_BASE_URL, apiKey: cfg.LAYA_API_KEY, timeoutMs: cfg.LAYA_TIMEOUT_MS, maxResponseBytes: cfg.LAYA_MAX_RESPONSE_BYTES, logger: deps.logger, fetchImpl: deps.fetchImpl }));
  if (skipResilience) return { provider: inner };
  const resilient: ResilientDecisionProvider = new ResilientDecisionProvider(inner, {
    concurrency: cfg.LAYA_CONCURRENCY,
    queueTimeoutMs: cfg.LAYA_TIMEOUT_MS,
    circuitFailureThreshold: cfg.LAYA_CIRCUIT_FAILURE_THRESHOLD,
    circuitCooldownMs: cfg.LAYA_CIRCUIT_COOLDOWN_MS,
    logger: deps.logger,
    onCall: (sample) => {
      deps.metrics?.observeLayaCall(sample);
      deps.metrics?.setLayaCircuit(resilient.circuitState);
    },
  });
  return { provider: resilient, resilient };
}
