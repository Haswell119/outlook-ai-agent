"use client";

import "./globals.css";

/** Last-resort boundary: replaces the whole document, so it ships its own shell. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-[#F5F5F5] px-4">
        <div className="max-w-md rounded-lg border border-[#C4314B]/30 bg-white p-6">
          <h1 className="text-lg font-semibold text-[#242424]">Something went wrong</h1>
          <p className="mt-2 break-words font-mono text-xs text-[#616161]">{error.message}</p>
          {error.digest && (
            <p className="mt-1 break-all font-mono text-xs text-[#616161]">
              Correlation id: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            className="mt-4 rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white"
          >
            Retry
          </button>
        </div>
      </body>
    </html>
  );
}
