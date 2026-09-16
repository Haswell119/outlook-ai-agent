"use client";

import { Download } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * The CSV is produced by the route handler at /api/audit/export, which proxies
 * the orchestrator (or the mock store) server-side — the browser never sees the
 * admin token.
 */
export function ExportButton({ label }: { label: string }) {
  const searchParams = useSearchParams();
  const href = `/api/audit/export?${searchParams.toString()}`;
  return (
    <Button variant="outline" size="sm" className="h-9" asChild>
      <a href={href} download>
        <Download className="h-4 w-4 text-[#616161]" />
        {label}
      </a>
    </Button>
  );
}
