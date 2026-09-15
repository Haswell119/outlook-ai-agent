"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { ActionTypeSchema, PolicySchema, type Policy, type RiskLevel } from "@oao/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TagInput } from "./tag-input";
import { formatDateTime } from "@/lib/format";
import type { Language } from "@oao/shared";

const ACTION_TYPES = ActionTypeSchema.options;
const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high"];

export function PolicyForm({
  policy,
  messages,
  language,
}: {
  policy: Policy;
  messages: Record<string, string>;
  language: Language;
}) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<Policy>(policy);
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [errors, setErrors] = React.useState<string[]>([]);
  const t = (k: string) => messages[k] ?? k;

  const patch = <K extends keyof Policy>(key: K, value: Policy[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    setErrors([]);
    const parsed = PolicySchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`));
      return;
    }
    // Sanity-check every sensitive-data pattern compiles before it reaches the engine.
    const badPatterns = parsed.data.sensitiveDataPatterns
      .filter((p) => {
        try {
          new RegExp(p.pattern);
          return false;
        } catch {
          return true;
        }
      })
      .map((p) => `${p.name}: invalid regular expression`);
    if (badPatterns.length > 0) {
      setErrors(badPatterns);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? `Save failed (${res.status})`);
      }
      const next = (await res.json()) as Policy;
      setDraft(next);
      setSaved(true);
      router.refresh();
    } catch (e) {
      setErrors([e instanceof Error ? e.message : "Save failed"]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("policy.internalDomains")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <TagInput
              id="internal-domains"
              values={draft.internalDomains}
              onChange={(v) => patch("internalDomains", v)}
              placeholder={t("policy.addTag")}
              removeLabel={t("policy.remove")}
            />
            <div>
              <Label htmlFor="required-labels" className="mb-1.5 block">
                {t("policy.requiredLabels")}
              </Label>
              <TagInput
                id="required-labels"
                values={draft.requiredClassificationLabels}
                onChange={(v) => patch("requiredClassificationLabels", v)}
                placeholder={t("policy.addTag")}
                removeLabel={t("policy.remove")}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("policy.confidentialPatterns")}</CardTitle>
          </CardHeader>
          <CardContent>
            <TagInput
              id="confidential-patterns"
              values={draft.confidentialPatterns}
              onChange={(v) => patch("confidentialPatterns", v)}
              placeholder={t("policy.addTag")}
              removeLabel={t("policy.remove")}
            />
          </CardContent>
        </Card>
      </div>

      <Card className="min-w-0">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>{t("policy.sensitivePatterns")}</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              patch("sensitiveDataPatterns", [
                ...draft.sensitiveDataPatterns,
                { name: "", pattern: "", severity: "medium" },
              ])
            }
          >
            <Plus className="h-4 w-4" /> {t("policy.addPattern")}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="min-w-[160px]">{t("policy.patternName")}</TableHead>
                <TableHead className="min-w-[280px]">{t("policy.patternRegex")}</TableHead>
                <TableHead className="min-w-[140px]">{t("policy.patternSeverity")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {draft.sensitiveDataPatterns.map((p, index) => (
                <TableRow key={`${index}-${p.name}`}>
                  <TableCell>
                    <Input
                      aria-label={`${t("policy.patternName")} ${index + 1}`}
                      value={p.name}
                      onChange={(e) => {
                        const next = [...draft.sensitiveDataPatterns];
                        next[index] = { ...p, name: e.target.value };
                        patch("sensitiveDataPatterns", next);
                      }}
                      className="h-8"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`${t("policy.patternRegex")} ${index + 1}`}
                      value={p.pattern}
                      onChange={(e) => {
                        const next = [...draft.sensitiveDataPatterns];
                        next[index] = { ...p, pattern: e.target.value };
                        patch("sensitiveDataPatterns", next);
                      }}
                      className="h-8 font-mono text-xs"
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      value={p.severity}
                      onValueChange={(value) => {
                        const next = [...draft.sensitiveDataPatterns];
                        next[index] = { ...p, severity: value as RiskLevel };
                        patch("sensitiveDataPatterns", next);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RISK_LEVELS.map((r) => (
                          <SelectItem key={r} value={r}>
                            {t(`risk.${r}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${t("policy.remove")} ${index + 1}`}
                      onClick={() =>
                        patch(
                          "sensitiveDataPatterns",
                          draft.sensitiveDataPatterns.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4 text-[#C4314B]" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("policy.thresholds")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="large-distribution" className="mb-1.5 block">
                {t("policy.largeDistribution")}
              </Label>
              <Input
                id="large-distribution"
                type="number"
                min={1}
                max={1000}
                value={draft.largeDistributionThreshold}
                onChange={(e) => patch("largeDistributionThreshold", Number(e.target.value))}
                className="w-32"
              />
            </div>
            <div>
              <Label htmlFor="approval-from" className="mb-1.5 block">
                {t("policy.approvalRequiredFrom")}
              </Label>
              <Select
                value={draft.approvalRequiredFrom}
                onValueChange={(v) => patch("approvalRequiredFrom", v as RiskLevel)}
              >
                <SelectTrigger id="approval-from" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RISK_LEVELS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`risk.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-start gap-3 rounded-md border border-[#E1DFDD] p-3">
              <Switch
                id="block-high-risk"
                checked={draft.blockOnHighRisk}
                onCheckedChange={(checked) => patch("blockOnHighRisk", checked)}
              />
              <Label htmlFor="block-high-risk" className="normal-case tracking-normal text-[#242424]">
                {t("policy.blockOnHighRisk")}
              </Label>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("policy.complianceApprovalFor")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 sm:grid-cols-2">
              {ACTION_TYPES.map((type) => {
                const checked = draft.complianceApprovalFor.includes(type);
                return (
                  <li key={type} className="flex items-center gap-2">
                    <Checkbox
                      id={`caf-${type}`}
                      checked={checked}
                      onCheckedChange={(value) =>
                        patch(
                          "complianceApprovalFor",
                          value
                            ? [...draft.complianceApprovalFor, type]
                            : draft.complianceApprovalFor.filter((a) => a !== type),
                        )
                      }
                    />
                    <Label htmlFor={`caf-${type}`} className="normal-case tracking-normal text-[#242424]">
                      {type.replace(/_/g, " ")}
                    </Label>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </div>

      {errors.length > 0 && (
        <ul className="rounded-md border border-[#C4314B]/30 bg-[#FDE7E9] p-3 text-xs text-[#C4314B]">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t("policy.save")}
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#107C10]">
            <CheckCircle2 className="h-4 w-4" /> {t("policy.saved")}
          </span>
        )}
        <span className="text-xs text-[#616161]">
          {t("policy.updatedBy")}: {draft.updatedBy ?? "—"}
          {draft.updatedAt && ` · ${t("policy.updatedAt")}: ${formatDateTime(draft.updatedAt, language)}`}
        </span>
      </div>
    </div>
  );
}
