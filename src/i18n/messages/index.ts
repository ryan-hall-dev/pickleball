import type { SessionErrorCode } from "@/engine/session/errors";
import type { Locale } from "../locales";
import { en, type Messages } from "./en";
import { vi } from "./vi";

export type { Messages };

export const MESSAGES: Record<Locale, Messages> = { en, vi };

type MessageFunction = (...values: string[]) => string;
type MessageTree = { [key: string]: string | MessageFunction | MessageTree };

/** Marks the i-th inserted value while building a function's pattern. */
const valueMarker = (index: number) => `\u0000${index}\u0000`;

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Use at most 50 characters." → /^Use at most (.+?) characters\.$/ */
function patternOf(messageFunction: MessageFunction): RegExp {
  const markers = Array.from({ length: messageFunction.length }, (_, index) =>
    valueMarker(index),
  );
  let pattern = escapeForRegExp(messageFunction(...markers));
  for (const marker of markers) pattern = pattern.replace(marker, "(.+?)");
  return new RegExp(`^${pattern}$`, "s");
}

interface MessageEntry {
  english: string | MessageFunction;
  target: (messages: Messages) => string | MessageFunction;
}

function entriesOf(
  tree: MessageTree,
  pick: (messages: Messages) => MessageTree,
): MessageEntry[] {
  return Object.entries(tree).flatMap(([key, english]) => {
    const target = (messages: Messages) => pick(messages)[key];
    return typeof english === "object"
      ? entriesOf(english, (messages) => target(messages) as MessageTree)
      : [{ english, target: target as MessageEntry["target"] }];
  });
}

// Shared input rules and host server actions produce these English messages.
// Their functions take numbers too; matched values arrive as text, which
// they only insert.
const asTree = (tree: object) => tree as unknown as MessageTree;
const TRANSLATABLE: MessageEntry[] = [
  ...entriesOf(asTree(en.validation), (m) => asTree(m.validation)),
  ...entriesOf(asTree(en.serverMessages), (m) => asTree(m.serverMessages)),
];
const EXACT = TRANSLATABLE.filter((entry) => typeof entry.english === "string");
const PATTERNS = TRANSLATABLE.filter(
  (entry) => typeof entry.english === "function",
).map((entry) => ({
  ...entry,
  pattern: patternOf(entry.english as MessageFunction),
}));

/**
 * Shows a message from the input rules or a host server action (always
 * English) in the chosen language. Inserted names and numbers are kept;
 * anything unknown stays as it is.
 */
export function translateMessage(
  englishMessage: string,
  messages: Messages,
): string {
  if (messages === en) return englishMessage;
  for (const entry of EXACT) {
    if (entry.english === englishMessage)
      return entry.target(messages) as string;
  }
  for (const entry of PATTERNS) {
    const match = entry.pattern.exec(englishMessage);
    if (match)
      return (entry.target(messages) as MessageFunction)(...match.slice(1));
  }
  return englishMessage;
}

/** Kept for the check-in form: field errors are messages like any other. */
export const translateValidationMessage = translateMessage;

/**
 * An engine rejection in the chosen language: English keeps the engine's own
 * detailed message, other languages a plain sentence for its code.
 */
export function translateEngineError(
  error: { code: SessionErrorCode; message: string },
  messages: Messages,
): string {
  return messages === en ? error.message : messages.engineErrors[error.code];
}
