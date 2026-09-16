/**
 * Minimal, dependency-free RFC-4180 CSV serialisation used by the audit export
 * route handler.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Guard against CSV/formula injection in spreadsheet apps.
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/["\n\r,;]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  const cols = columns ?? Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const header = cols.map(escapeCsvCell).join(",");
  const body = rows.map((row) => cols.map((c) => escapeCsvCell(row[c])).join(","));
  return [header, ...body].join("\r\n");
}

export const AUDIT_CSV_COLUMNS = [
  "id",
  "timestamp",
  "userEmail",
  "userName",
  "type",
  "source",
  "counterpart",
  "riskLevel",
  "approvalStatus",
  "approvedBy",
  "confidence",
  "model",
  "latencyMs",
  "correlationId",
] as const;

export interface AuditCsvRowInput {
  id: string;
  timestamp: string;
  user: { email: string; displayName?: string };
  type: string;
  source?: { label: string; counterpart?: string };
  riskLevel?: string;
  approvalStatus: string;
  approvedBy?: string;
  confidence?: number;
  model?: string;
  latencyMs?: number;
  correlationId?: string;
}

export function auditEventsToCsv(events: AuditCsvRowInput[]): string {
  return toCsv(
    events.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      userEmail: e.user.email,
      userName: e.user.displayName ?? "",
      type: e.type,
      source: e.source?.label ?? "",
      counterpart: e.source?.counterpart ?? "",
      riskLevel: e.riskLevel ?? "",
      approvalStatus: e.approvalStatus,
      approvedBy: e.approvedBy ?? "",
      confidence: e.confidence !== undefined ? e.confidence.toFixed(2) : "",
      model: e.model ?? "",
      latencyMs: e.latencyMs ?? "",
      correlationId: e.correlationId ?? "",
    })),
    [...AUDIT_CSV_COLUMNS],
  );
}
