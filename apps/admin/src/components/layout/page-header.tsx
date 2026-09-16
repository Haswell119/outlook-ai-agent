import type { ReactNode } from "react";

export function PageHeader({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E8F1FB] text-brand">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-[#242424]">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-[#616161]">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
