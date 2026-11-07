"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import "./globals.css";

export default function GlobalError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center p-6 font-sans">
        <title>Something went wrong · Pickleball Social Manager</title>
        <main className="w-full max-w-md rounded-card border border-card-border bg-card p-8">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="mt-2 text-muted">
            The error has been reported. Try again, or reload the page.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            className="mt-6 min-h-11 rounded-full bg-lime px-6 font-semibold text-bg"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
