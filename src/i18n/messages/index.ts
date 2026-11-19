import type { Locale } from "../locales";
import { en, type Messages } from "./en";
import { vi } from "./vi";

export type { Messages };

export const MESSAGES: Record<Locale, Messages> = { en, vi };

type ValidationKey = keyof Messages["validation"];

function englishValidationText(key: ValidationKey): string | null {
  const value = en.validation[key];
  return typeof value === "string" ? value : null;
}

/**
 * Input rules produce English messages (`en.validation`, shared with the
 * server). Shows one in the chosen language; anything unknown stays as is.
 */
export function translateValidationMessage(
  englishMessage: string,
  messages: Messages,
): string {
  for (const key of Object.keys(en.validation) as ValidationKey[]) {
    if (englishValidationText(key) === englishMessage) {
      return messages.validation[key] as string;
    }
  }
  const tooLong = /^Use at most (\d+) characters\.$/.exec(englishMessage);
  if (tooLong) return messages.validation.nameTooLong(Number(tooLong[1]));
  return englishMessage;
}
