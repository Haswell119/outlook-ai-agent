"use client";

import * as React from "react";
import { CalendarDays, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useQueryParams } from "@/lib/use-query-params";
import { cn } from "@/lib/utils";

export function DateRangeControl({
  label,
  preset,
  from,
  to,
  messages,
}: {
  label: string;
  preset: "last7" | "last30" | "custom";
  /** `YYYY-MM-DD` */
  from: string;
  to: string;
  messages: Record<string, string>;
}) {
  const { setMany, pending } = useQueryParams();
  const [open, setOpen] = React.useState(false);
  const [customFrom, setCustomFrom] = React.useState(from);
  const [customTo, setCustomTo] = React.useState(to);
  const t = (k: string) => messages[k] ?? k;

  const presets: Array<{ id: "last7" | "last30"; label: string }> = [
    { id: "last7", label: t("range.last7") },
    { id: "last30", label: t("range.last30") },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9" disabled={pending}>
          <CalendarDays className="h-4 w-4 text-[#616161]" />
          <span className="max-w-[190px] truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <div className="space-y-1">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setMany({ range: p.id, from: undefined, to: undefined });
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-[#F3F2F1]",
                preset === p.id && "font-semibold text-brand",
              )}
            >
              {p.label}
              {preset === p.id && <Check className="h-4 w-4" />}
            </button>
          ))}
        </div>
        <Separator className="my-3" />
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#616161]">
          {t("range.custom")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="range-from">{t("range.from")}</Label>
            <Input
              id="range-from"
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="range-to">{t("range.to")}</Label>
            <Input
              id="range-to"
              type="date"
              value={customTo}
              min={customFrom}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        </div>
        <Button
          size="sm"
          className="mt-3 w-full"
          onClick={() => {
            setMany({ range: "custom", from: customFrom, to: customTo });
            setOpen(false);
          }}
        >
          {t("range.apply")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
