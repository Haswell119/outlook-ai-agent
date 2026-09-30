"use client";

import * as React from "react";
import { FileUp, FolderUp, Loader2, Square, Upload, X } from "lucide-react";
import type { Language, MailboxImportRequest, MailboxImportResponse } from "@oao/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { readApiError, useToast } from "@/components/ui/toast";
import { formatNumber } from "@/lib/format";
import { tr, type Messages } from "@/lib/i18n";
import {
  MAIL_FILE_EXTENSIONS,
  MAX_MAIL_FILE_BYTES,
  folderOf,
  isMailFile,
  newImportId,
  planBatches,
  reasonKey,
  retryAfterSeconds,
} from "@/lib/mail-import";

interface Picked {
  file: File;
  folder?: string;
  size: number;
}

type Counts = MailboxImportResponse["counts"];
const NO_COUNTS: Counts = { files: 0, imported: 0, duplicate: 0, rejected: 0, failed: 0, analysed: 0, skippedByTriage: 0 };

interface Issue {
  name: string;
  status: string;
  reason: string;
}

/** Issues listed on screen; the counters always cover every file. */
const MAX_ISSUES = 200;
const SHOWN_ISSUES = 50;
/** Consecutive batches refused by the orchestrator before the run stops. */
const MAX_FAILED_BATCHES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `data:…;base64,XXXX` → `XXXX`, encoded natively by the browser. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number, language: Language): string {
  const fr = language === "fr";
  const number = new Intl.NumberFormat(fr ? "fr-CH" : "en-US", { maximumFractionDigits: 1 });
  if (bytes < 1024 * 1024) return `${number.format(Math.max(1, Math.round(bytes / 1024)))} ${fr ? "Ko" : "KB"}`;
  return `${number.format(bytes / 1024 / 1024)} ${fr ? "Mo" : "MB"}`;
}

/**
 * `/integrations` — import exported messages (`.eml` / `.msg`) so a deployment
 * without Microsoft Graph can be tried on a real mailbox. Files are read in the
 * browser and sent in small batches to `/api/import`; the orchestrator indexes
 * them (and, on request, analyses them) exactly like a mailbox sync.
 */
export function MailImport({
  messages,
  language,
  defaultMailbox,
  knownMailboxes,
  live,
}: {
  messages: Messages;
  language: Language;
  defaultMailbox: string;
  knownMailboxes: string[];
  /** `false` when the dashboard shows demo data: the import needs the orchestrator. */
  live: boolean;
}) {
  const t = React.useCallback(
    (key: string, vars?: Record<string, string | number>) => tr(messages, key, vars),
    [messages],
  );
  /** `{key}.one` for a single item, `{key}` otherwise. */
  const tn = (key: string, count: number, vars?: Record<string, string | number>) =>
    count === 1 ? t(`${key}.one`, vars) : t(key, { count: formatNumber(count, language), ...vars });
  const reasonText = (reason: string) => {
    const key = reasonKey(reason);
    return key ? t(key) : reason;
  };
  const { toast } = useToast();
  const [mailbox, setMailbox] = React.useState(defaultMailbox);
  const [analyze, setAnalyze] = React.useState(false);
  const [picked, setPicked] = React.useState<Picked[]>([]);
  const [ignored, setIgnored] = React.useState(0);
  const [running, setRunning] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [counts, setCounts] = React.useState<Counts | null>(null);
  const [issues, setIssues] = React.useState<Issue[]>([]);
  const [warning, setWarning] = React.useState<string | undefined>();
  const [dragging, setDragging] = React.useState(false);
  const stopRef = React.useRef(false);
  const filesInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement>(null);

  // Not in React's typings: set on the element so the picker selects a whole folder.
  React.useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
    folderInput.current?.setAttribute("directory", "");
  }, []);

  const addFiles = React.useCallback((list: FileList | null) => {
    if (!list?.length) return;
    let skipped = 0;
    const next: Picked[] = [];
    for (const file of Array.from(list)) {
      if (!isMailFile(file.name)) {
        skipped++;
        continue;
      }
      next.push({ file, folder: folderOf(file.webkitRelativePath), size: file.size });
    }
    setIgnored((n) => n + skipped);
    setPicked((current) => {
      const key = (p: Picked) => `${p.file.webkitRelativePath || p.file.name}|${p.size}|${p.file.lastModified}`;
      const seen = new Set(current.map(key));
      return [...current, ...next.filter((p) => !seen.has(key(p)))];
    });
  }, []);

  const clear = () => {
    setPicked([]);
    setIgnored(0);
    setCounts(null);
    setIssues([]);
    setWarning(undefined);
    setProgress({ done: 0, total: 0 });
  };

  const totalBytes = React.useMemo(() => picked.reduce((n, p) => n + p.size, 0), [picked]);
  const mailboxValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox.trim());

  async function run() {
    if (!picked.length || !mailboxValid) return;
    stopRef.current = false;
    setRunning(true);
    setStopping(false);
    setWarning(undefined);
    const importId = newImportId();
    const tally: Counts = { ...NO_COUNTS };
    const found: Issue[] = [];
    const note = (issue: Issue) => {
      if (found.length < MAX_ISSUES) found.push(issue);
    };
    const publish = () => {
      setCounts({ ...tally });
      setIssues([...found]);
    };

    const tooLarge = picked.filter((p) => p.size > MAX_MAIL_FILE_BYTES);
    for (const p of tooLarge) {
      tally.files++;
      tally.rejected++;
      note({ name: p.file.name, status: "rejected", reason: t("import.tooLarge") });
    }
    const batches = planBatches(picked.filter((p) => p.size <= MAX_MAIL_FILE_BYTES), { analyze });
    let done = tooLarge.length;
    setProgress({ done, total: picked.length });
    publish();

    let failedBatches = 0;
    let fatal: string | undefined;
    for (const batch of batches) {
      if (stopRef.current || fatal) break;
      const failBatch = (reason: string) => {
        for (const p of batch) {
          tally.files++;
          tally.failed++;
          note({ name: p.file.name, status: "failed", reason });
        }
      };
      let body: MailboxImportRequest;
      try {
        const files = await Promise.all(
          batch.map(async (p) => ({ name: p.file.name, folder: p.folder, contentBase64: await toBase64(p.file) })),
        );
        body = { importId, mailbox: mailbox.trim(), analyze, files };
      } catch (error) {
        failBatch(error instanceof Error ? error.message : String(error));
        done += batch.length;
        setProgress({ done, total: picked.length });
        publish();
        continue;
      }

      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetch("/api/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (error) {
          failBatch(error instanceof Error ? error.message : String(error));
          failedBatches++;
          break;
        }
        if (res.status === 429 && attempt < 5) {
          await sleep(retryAfterSeconds(res.headers.get("retry-after")) * 1000);
          continue;
        }
        if (!res.ok) {
          const err = await readApiError(res);
          if (res.status === 401 || res.status === 403 || err.code === "demo_mode") fatal = err.message;
          failBatch(err.correlationId ? `${err.message} (${err.correlationId})` : err.message);
          failedBatches++;
          break;
        }
        const data = (await res.json()) as MailboxImportResponse;
        for (const k of Object.keys(tally) as Array<keyof Counts>) tally[k] += data.counts[k];
        for (const r of data.results) {
          if (r.status === "rejected" || r.status === "failed") note({ name: r.name, status: r.status, reason: r.reason ?? "" });
          else if (r.analysed === false && r.reason) note({ name: r.name, status: "analysis", reason: r.reason });
        }
        if (data.warning) setWarning(data.warning);
        failedBatches = 0;
        break;
      }
      done += batch.length;
      setProgress({ done, total: picked.length });
      publish();
      if (failedBatches >= MAX_FAILED_BATCHES) fatal = t("import.tooManyFailures");
    }

    setRunning(false);
    setStopping(false);
    if (fatal) {
      toast({ title: t("error.title"), description: fatal, tone: "error" });
    } else {
      toast({
        title: t("import.done", { imported: tally.imported, duplicate: tally.duplicate }),
        description: tally.rejected + tally.failed > 0 ? tn("import.doneWithIssues", tally.rejected + tally.failed) : undefined,
        tone: tally.failed > 0 ? "error" : "success",
      });
    }
  }

  const disabled = !live || running;
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Card data-testid="mail-import">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-4 w-4 text-brand" />
          {t("import.title")}
        </CardTitle>
        <p className="text-xs text-[#616161]">{t("import.subtitle")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!live && (
          <p className="rounded-md border border-[#F7E4A6] bg-[#FFF9E6] px-3 py-2 text-xs text-[#8A6D00]">{t("import.demoMode")}</p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="import-mailbox">{t("import.mailbox")}</Label>
            <Input
              id="import-mailbox"
              type="email"
              list="import-known-mailboxes"
              value={mailbox}
              disabled={disabled}
              onChange={(e) => setMailbox(e.target.value)}
              aria-invalid={!mailboxValid}
            />
            <datalist id="import-known-mailboxes">
              {knownMailboxes.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <p className="text-xs text-[#616161]">{t("import.mailboxHint")}</p>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Switch id="import-analyze" checked={analyze} disabled={disabled} onCheckedChange={setAnalyze} />
              <Label htmlFor="import-analyze">{t("import.analyze")}</Label>
            </div>
            <p className="text-xs text-[#616161]">{t("import.analyzeHint")}</p>
          </div>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!disabled) addFiles(e.dataTransfer.files);
          }}
          className={`flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-3 ${dragging ? "border-brand bg-[#E8F1FB]" : "border-[#C8C6C4]"}`}
        >
          <input
            ref={filesInput}
            type="file"
            multiple
            accept={[...MAIL_FILE_EXTENSIONS, "message/rfc822", "application/vnd.ms-outlook"].join(",")}
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => filesInput.current?.click()}>
            <FileUp /> {t("import.pickFiles")}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => folderInput.current?.click()}>
            <FolderUp /> {t("import.pickFolder")}
          </Button>
          <span className="text-xs text-[#616161]">
            {picked.length ? tn("import.selected", picked.length, { size: formatSize(totalBytes, language) }) : t("import.drop")}
            {ignored > 0 && ` · ${tn("import.ignored", ignored)}`}
          </span>
          {picked.length > 0 && !running && (
            <Button type="button" variant="ghost" size="sm" onClick={clear}>
              <X /> {t("import.clear")}
            </Button>
          )}
        </div>
        <p className="text-xs text-[#616161]">{t("import.howTo")}</p>

        <div className="flex flex-wrap items-center gap-3">
          {!running ? (
            <Button type="button" disabled={disabled || !picked.length || !mailboxValid} onClick={() => void run()}>
              <Upload /> {t("import.start")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={stopping}
              onClick={() => {
                stopRef.current = true;
                setStopping(true);
              }}
            >
              {stopping ? <Loader2 className="animate-spin" /> : <Square />} {stopping ? t("import.stopping") : t("import.stop")}
            </Button>
          )}
          {progress.total > 0 && (
            <div className="flex min-w-[220px] flex-1 items-center gap-2" aria-live="polite">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#EDEBE9]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <div className="h-2 rounded-full bg-brand transition-[width]" style={{ width: `${percent}%` }} />
              </div>
              <span className="whitespace-nowrap text-xs text-[#616161]">
                {t("import.progress", { done: formatNumber(progress.done, language), total: formatNumber(progress.total, language) })}
              </span>
              {running && <Loader2 className="h-4 w-4 animate-spin text-brand" />}
            </div>
          )}
        </div>

        {counts && (
          <div className="space-y-3" data-testid="mail-import-result">
            <div className="flex flex-wrap gap-2">
              <Badge variant="low">{t("import.imported")}: {formatNumber(counts.imported, language)}</Badge>
              <Badge variant="info">{t("import.duplicate")}: {formatNumber(counts.duplicate, language)}</Badge>
              {analyze || counts.analysed > 0 ? (
                <>
                  <Badge variant="info">{t("import.analysed")}: {formatNumber(counts.analysed, language)}</Badge>
                  <Badge variant="neutral">{t("import.skippedByTriage")}: {formatNumber(counts.skippedByTriage, language)}</Badge>
                </>
              ) : null}
              <Badge variant={counts.rejected ? "medium" : "neutral"}>{t("import.rejected")}: {formatNumber(counts.rejected, language)}</Badge>
              <Badge variant={counts.failed ? "high" : "neutral"}>{t("import.failed")}: {formatNumber(counts.failed, language)}</Badge>
            </div>
            {warning && <p className="rounded-md bg-[#FFF4CE] px-3 py-2 text-xs text-[#8A6D00]">{warning}</p>}
            {issues.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-[#424242]">{t("import.issues")}</p>
                <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-[#EDEBE9] p-2 text-xs">
                  {issues.slice(0, SHOWN_ISSUES).map((issue, i) => (
                    <li key={`${issue.name}-${i}`} className="flex gap-2">
                      <Badge variant={issue.status === "failed" ? "high" : "medium"}>{t(`import.status.${issue.status}`)}</Badge>
                      <span className="min-w-0 truncate font-medium text-[#242424]" title={issue.name}>
                        {issue.name}
                      </span>
                      <span className="min-w-0 truncate text-[#616161]" title={issue.reason}>
                        {reasonText(issue.reason)}
                      </span>
                    </li>
                  ))}
                </ul>
                {issues.length > SHOWN_ISSUES && (
                  <p className="mt-1 text-xs text-[#616161]">{t("import.more", { count: issues.length - SHOWN_ISSUES })}</p>
                )}
              </div>
            )}
            {!running && counts.imported + counts.duplicate > 0 && <p className="text-xs text-[#616161]">{t("import.next")}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
