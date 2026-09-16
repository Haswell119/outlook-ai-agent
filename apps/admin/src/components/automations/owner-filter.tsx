"use client";

import { Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQueryParams } from "@/lib/use-query-params";
import { tr, type Messages } from "@/lib/i18n";

/** `?all=true` (default, admin view) or `?user=<id>` for one owner's routines. */
export function OwnerFilter({
  users,
  messages,
}: {
  users: Array<{ value: string; label: string }>;
  messages: Messages;
}) {
  const { get, setMany } = useQueryParams();
  const current = get("user") || "all";

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
      <Users className="h-4 w-4 text-[#616161]" aria-hidden="true" />
      <Label htmlFor="automation-owner" className="whitespace-nowrap">
        {tr(messages, "automations.filterUser")}
      </Label>
      <Select
        value={current}
        onValueChange={(value) =>
          setMany({ user: value === "all" ? undefined : value, all: value === "all" ? "true" : undefined })
        }
      >
        <SelectTrigger id="automation-owner" className="h-9 w-full min-w-0 sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{tr(messages, "automations.allUsers")}</SelectItem>
          {users.map((u) => (
            <SelectItem key={u.value} value={u.value}>
              {u.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
