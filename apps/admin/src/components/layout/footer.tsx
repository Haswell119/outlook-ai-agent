export function AppFooter({
  tenantName,
  lastUpdated,
  messages,
}: {
  tenantName: string;
  lastUpdated: string;
  messages: Record<string, string>;
}) {
  const t = (key: string) => messages[key] ?? key;
  return (
    <footer className="mt-8 flex flex-col gap-1 border-t border-[#E1DFDD] pt-4 text-xs text-[#616161] lg:flex-row lg:items-center lg:justify-between">
      <span>{t("footer.copyright").replace("{tenant}", tenantName)}</span>
      <span className="lg:text-center">{t("footer.policy")}</span>
      <span>
        {t("footer.lastUpdated")}: {lastUpdated}
      </span>
    </footer>
  );
}
