import { Skeleton } from "@/components/ui/skeleton";

export default function PublicLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-3">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-40 rounded-lg" />
    </div>
  );
}
