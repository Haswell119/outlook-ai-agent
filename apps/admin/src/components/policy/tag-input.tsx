"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";

export function TagInput({
  id,
  values,
  onChange,
  placeholder,
  removeLabel,
}: {
  id: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  removeLabel: string;
}) {
  const [draft, setDraft] = React.useState("");

  const commit = () => {
    const value = draft.trim();
    if (!value) return;
    if (!values.includes(value)) onChange([...values, value]);
    setDraft("");
  };

  return (
    <div className="rounded-md border border-input bg-white p-2">
      {values.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li
              key={value}
              className="inline-flex items-center gap-1 rounded-full bg-[#E8F1FB] py-0.5 pl-2.5 pr-1 text-xs font-medium text-[#0E5FA6]"
            >
              <span className="max-w-[220px] truncate">{value}</span>
              <button
                type="button"
                aria-label={`${removeLabel} ${value}`}
                onClick={() => onChange(values.filter((v) => v !== value))}
                className="rounded-full p-0.5 hover:bg-[#0F6CBD]/15"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={placeholder}
        className="h-8 border-0 px-1 shadow-none focus-visible:ring-0"
      />
    </div>
  );
}
