import type { AuditQuery, ApprovalStatus, AuditEventType, RiskLevel } from "@oao/shared";
import {
  ApprovalStatusSchema,
  AuditEventTypeSchema,
  RiskLevelSchema,
} from "@oao/shared";

/**
 * Reference period of the mock-up (docs/mockups.md §G). Used as the default
 * window so the dashboard always renders a populated week.
 */
export const DEFAULT_PERIOD: { from: string; to: string } = {
  from: "2025-05-12T00:00:00.000Z",
  to: "2025-05-18T23:59:59.000Z",
};

export type SearchParamsInput = Record<string, string | string[] | undefined>;

export interface ResolvedQuery extends Partial<AuditQuery> {
  from: string;
  to: string;
  preset: "last7" | "last30" | "custom";
}

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** `YYYY-MM-DD` → ISO bounds of that UTC day. */
export function dayStart(day: string): string {
  return `${day}T00:00:00.000Z`;
}
export function dayEnd(day: string): string {
  return `${day}T23:59:59.999Z`;
}

export function toDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Turns Next.js `searchParams` into a validated `AuditQuery`.
 * The reference period of the mock-up (12–18 May 2025) is the default so the
 * dashboard always shows data, live or mocked.
 */
export function resolveQuery(params: SearchParamsInput): ResolvedQuery {
  const preset = (one(params.range) ?? "last7") as ResolvedQuery["preset"];
  let from = DEFAULT_PERIOD.from;
  let to = DEFAULT_PERIOD.to;

  if (preset === "last30") {
    from = dayStart(toDay(new Date(Date.parse(DEFAULT_PERIOD.to) - 29 * 86400000).toISOString()));
  } else if (preset === "custom") {
    const f = one(params.from);
    const t = one(params.to);
    if (f) from = dayStart(f);
    if (t) to = dayEnd(t);
  }

  const typeRaw = one(params.type);
  const riskRaw = one(params.risk);
  const approvalRaw = one(params.approval);
  const pageRaw = Number(one(params.page) ?? "1");
  const pageSizeRaw = Number(one(params.pageSize) ?? "25");

  const type = AuditEventTypeSchema.safeParse(typeRaw);
  const risk = RiskLevelSchema.safeParse(riskRaw);
  const approval = ApprovalStatusSchema.safeParse(approvalRaw);

  const query: ResolvedQuery = {
    preset,
    from,
    to,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
    pageSize: [10, 25, 50, 100].includes(pageSizeRaw) ? pageSizeRaw : 25,
  };
  const userId = one(params.user);
  if (userId) query.userId = userId;
  if (type.success) query.type = type.data as AuditEventType;
  if (risk.success) query.riskLevel = risk.data as RiskLevel;
  if (approval.success) query.approvalStatus = approval.data as ApprovalStatus;
  const search = one(params.q);
  if (search) query.search = search;
  return query;
}

export const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high"];
export const APPROVAL_STATUSES: ApprovalStatus[] = [
  "auto_approved",
  "approved",
  "rejected",
  "escalated",
  "pending",
  "n/a",
];
