import { z } from "zod";

/** Mirrors the `person_name` domain: trimmed, 1-50 characters, no control characters. */
export const PERSON_NAME_MAX_LENGTH = 50;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function personNameSchema(emptyMessage: string) {
  return (
    z
      .string()
      // Collapsing runs of spaces (tabs, newlines) keeps "Anne  Marie" and
      // "Anne Marie" the same person for search and duplicate checks.
      .transform((name) => name.replace(/\s+/g, " ").trim())
      .pipe(
        z
          .string()
          .min(1, { error: emptyMessage })
          .max(PERSON_NAME_MAX_LENGTH, {
            error: `Use at most ${PERSON_NAME_MAX_LENGTH} characters.`,
          })
          .refine((name) => !CONTROL_CHARACTERS.test(name), {
            error: "Remove special characters.",
          }),
      )
  );
}
