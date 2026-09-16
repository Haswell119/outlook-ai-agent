"use client";

import * as React from "react";
import { FlaskConical, ShieldAlert } from "lucide-react";
import type { Policy } from "@oao/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  evaluatePolicyPreview,
  parseRecipients,
  type PolicyFinding,
} from "@/lib/policy-preview";
import { tr, type Messages } from "@/lib/i18n";

const FINDING_LABEL: Record<PolicyFinding["kind"], string> = {
  sensitive: "policy.finding.sensitive",
  confidential: "policy.finding.confidential",
  external: "policy.finding.external",
  large_distribution: "policy.finding.largeDistribution",
};

/**
 * "Which rules would fire?" panel. Runs `evaluatePolicyPreview` on the policy
 * currently being edited, entirely in the browser — clearly labelled a preview,
 * because the authoritative verdict is the orchestrator's Compliance Guardian.
 */
export function PolicyTestPanel({
  policy,
  messages,
}: {
  policy: Policy;
  messages: Messages;
}) {
  const t = (k: string, vars?: Record<string, string | number>) => tr(messages, k, vars);
  const [text, setText] = React.useState("");
  const [recipients, setRecipients] = React.useState("");
  const [findings, setFindings] = React.useState<PolicyFinding[] | null>(null);

  const run = () => {
    setFindings(
      evaluatePolicyPreview(policy, { text, recipients: parseRecipients(recipients) }),
    );
  };

  return (
    <Card className="min-w-0" data-testid="policy-test-panel">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-brand" aria-hidden="true" />
          {t("policy.test")}
        </CardTitle>
        <Badge variant="info">{t("policy.previewBadge")}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-[#616161]">{t("policy.testHint")}</p>

        <div className="grid gap-3 xl:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="policy-test-text">{t("policy.testText")}</Label>
            <Textarea
              id="policy-test-text"
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("policy.testTextPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="policy-test-recipients">{t("policy.testRecipients")}</Label>
            <Textarea
              id="policy-test-recipients"
              rows={5}
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder={t("policy.testRecipientsPlaceholder")}
            />
          </div>
        </div>

        <Button variant="outline" size="sm" onClick={run} data-testid="policy-test-run">
          <FlaskConical className="h-4 w-4" aria-hidden="true" />
          {t("policy.testRun")}
        </Button>

        {findings !== null && (
          <div aria-live="polite" data-testid="policy-test-results">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
              {t("policy.testFindings")} ({findings.length})
            </p>
            {findings.length === 0 ? (
              <p className="rounded-md bg-[#DFF6DD] px-3 py-2 text-sm text-[#0B5A0B]">
                {t("policy.testNoFindings")}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {findings.map((f, i) => (
                  <li
                    key={`${f.kind}-${f.rule}-${i}`}
                    className="flex items-start justify-between gap-3 rounded-md bg-[#FAF9F8] px-2.5 py-2"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-[#242424]">
                        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-[#8A6D00]" aria-hidden="true" />
                        {t(FINDING_LABEL[f.kind])} · {f.rule}
                      </span>
                      <span className="block text-xs text-[#616161]">
                        {f.kind === "external" || f.kind === "large_distribution"
                          ? `${f.count} ${t("policy.testExternal")}`
                          : t("policy.testMatches", { count: f.count })}
                        {f.samples.length > 0 && (
                          <span className="ml-1 font-mono">
                            {f.samples.slice(0, 3).join(" · ")}
                          </span>
                        )}
                      </span>
                    </span>
                    <Badge variant={f.severity}>{t(`risk.${f.severity}`)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
