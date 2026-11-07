import * as Sentry from "@sentry/nextjs";
import { SHARED_SENTRY_OPTIONS } from "../sentry.shared.config";

Sentry.init(SHARED_SENTRY_OPTIONS);

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
