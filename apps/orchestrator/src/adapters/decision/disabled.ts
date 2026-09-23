import { DecisionProviderError, type DecisionProvider, type DecisionProviderHealth } from "../../ports/decision.js";

/**
 * `DECISION_PROVIDER=disabled` (the default): the historic behaviour. Nothing
 * calls it — `EmailDecisionService` short-circuits before — but wiring a real
 * object instead of `undefined` keeps every consumer free of null checks and
 * makes a wrong call loud instead of silent.
 */
export class DisabledDecisionProvider implements DecisionProvider {
  readonly name = "disabled";

  async evaluate(): Promise<never> {
    throw new DecisionProviderError("disabled", "no decision provider configured (DECISION_PROVIDER=disabled)");
  }

  async healthCheck(): Promise<DecisionProviderHealth> {
    return { status: "disabled", detail: "DECISION_PROVIDER=disabled — historic behaviour, no structured decisions" };
  }
}
