import type { init } from "@sentry/nextjs";

// Shared by the server, edge and browser Sentry configs.
export const SHARED_SENTRY_OPTIONS = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Production only: dev and test errors stay local.
  enabled: process.env.NODE_ENV === "production",
  tracesSampleRate: 0.1,
  // Player names and host emails are personal data: keep them out of Sentry events.
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpBodies: [],
    urlQueryParams: false,
    databaseQueryData: false,
  },
} satisfies Parameters<typeof init>[0];
