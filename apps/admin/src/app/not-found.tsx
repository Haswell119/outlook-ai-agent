import Link from "next/link";
import "./globals.css";

/** Root 404 (outside both route groups). */
export default function RootNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F5F5F5] px-4">
      <div className="max-w-md rounded-lg border border-[#E1DFDD] bg-white p-6 text-center">
        <h1 className="text-lg font-semibold text-[#242424]">404 — Not found</h1>
        <p className="mt-2 text-sm text-[#616161]">
          This page does not exist, or you are not allowed to see it.
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Back to the overview
        </Link>
      </div>
    </div>
  );
}
