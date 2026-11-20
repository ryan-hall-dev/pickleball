import { translateEngineError, translateMessage } from "@/i18n/messages";
import type { Messages } from "@/i18n/messages";
import type { LiveWriteResult } from "@/server/live/liveTypes";

/** A failed write's words in the chosen language (engine codes by code). */
export type ShownFailure = Pick<
  Extract<LiveWriteResult, { ok: false }>,
  "message" | "engineErrorCode"
>;

export function failureText(
  response: ShownFailure,
  messages: Messages,
): string {
  return response.engineErrorCode
    ? translateEngineError(
        { code: response.engineErrorCode, message: response.message },
        messages,
      )
    : translateMessage(response.message, messages);
}
