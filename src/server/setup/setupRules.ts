import { z } from "zod";
import type { CourtConfig, CourtFormat } from "@/engine/session";
import { memberInputSchema } from "@/server/members/memberRules";

// Validation and the draft config shape for the Setup screen (plan §4, §7 M4).
// Shared by the server actions and the client form, so both apply the same
// rules. No server-only imports here.

export const COURT_FORMATS = [
  "doubles",
  "singles",
] as const satisfies readonly CourtFormat[];

/** Plan §8.5: estimates use target match minutes (default 15) + changeover (default 2). */
export const DEFAULT_TARGET_MATCH_MINUTES = 15;
export const DEFAULT_CHANGEOVER_MINUTES = 2;
export const TARGET_MATCH_MINUTES_RANGE = { min: 1, max: 180 } as const;
export const CHANGEOVER_MINUTES_RANGE = { min: 0, max: 60 } as const;

/** Mirrors the `short_label` domain (session, host and court names). */
export const SHORT_LABEL_MAX_LENGTH = 80;
/** Mirrors the `sessions.location` check. */
export const LOCATION_MAX_LENGTH = 120;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function shortLabelSchema(emptyMessage: string) {
  return z
    .string()
    .transform(collapseSpaces)
    .pipe(
      z
        .string()
        .min(1, { error: emptyMessage })
        .max(SHORT_LABEL_MAX_LENGTH, {
          error: `Use at most ${SHORT_LABEL_MAX_LENGTH} characters.`,
        })
        .refine((label) => !CONTROL_CHARACTERS.test(label), {
          error: "Remove special characters.",
        }),
    );
}

function wholeMinutesSchema(range: { min: number; max: number }) {
  const message = `Use a whole number of minutes from ${range.min} to ${range.max}.`;
  return z
    .number({ error: message })
    .int({ error: message })
    .min(range.min, { error: message })
    .max(range.max, { error: message });
}

const courtFormatSchema = z.enum(COURT_FORMATS);

/**
 * Longest planned session. Matches the plan's rule that sessions still live
 * 12 h after their planned end are auto-ended; a social never runs this long.
 */
export const MAX_SESSION_DURATION_MINUTES = 12 * 60;

/** The end comes after the start (overnight is fine) and within 12 hours. */
function checkPlannedTimes(
  input: { plannedStart: string; plannedEnd: string },
  context: z.RefinementCtx,
) {
  const durationMs =
    Date.parse(input.plannedEnd) - Date.parse(input.plannedStart);
  if (!(durationMs > 0)) {
    context.addIssue({
      code: "custom",
      path: ["plannedEnd"],
      message: "End time must be after the start time.",
    });
  } else if (durationMs > MAX_SESSION_DURATION_MINUTES * 60_000) {
    context.addIssue({
      code: "custom",
      path: ["plannedEnd"],
      message: "A session can last at most 12 hours.",
    });
  }
}

/** What the Setup screen saves into a draft (sessions columns + its config). */
export const saveSessionDraftInputSchema = z
  .object({
    sessionId: z.uuid(),
    name: shortLabelSchema("Enter a session name."),
    // Optional: an empty location is stored as null.
    location: z
      .string()
      .transform(collapseSpaces)
      .pipe(
        z
          .string()
          .max(LOCATION_MAX_LENGTH, {
            error: `Use at most ${LOCATION_MAX_LENGTH} characters.`,
          })
          .refine((location) => !CONTROL_CHARACTERS.test(location), {
            error: "Remove special characters.",
          }),
      )
      .transform((location) => (location === "" ? null : location)),
    hostName: shortLabelSchema("Enter the host's name."),
    plannedStart: z.iso.datetime({ offset: true }),
    plannedEnd: z.iso.datetime({ offset: true }),
    courtIds: z
      .array(z.uuid())
      .refine((courtIds) => new Set(courtIds).size === courtIds.length, {
        error: "A court is listed twice.",
      }),
    matchFormat: courtFormatSchema,
    targetMatchMinutes: wholeMinutesSchema(TARGET_MATCH_MINUTES_RANGE),
    changeoverMinutes: wholeMinutesSchema(CHANGEOVER_MINUTES_RANGE),
  })
  .superRefine(checkPlannedTimes);

export type SaveSessionDraftInput = z.input<typeof saveSessionDraftInputSchema>;
export type ValidSessionDraft = z.output<typeof saveSessionDraftInputSchema>;

/** A new draft: the browser picks the default times (it knows the host's time zone). */
export const startSessionDraftInputSchema = z
  .object({
    name: shortLabelSchema("Enter a session name."),
    plannedStart: z.iso.datetime({ offset: true }),
    plannedEnd: z.iso.datetime({ offset: true }),
  })
  .superRefine(checkPlannedTimes);

export type StartSessionDraftInput = z.input<
  typeof startSessionDraftInputSchema
>;

/** A new club court ("Add court" on the Courts card). */
export const addClubCourtInputSchema = z.object({
  name: shortLabelSchema("Enter a court name."),
  supportedFormats: z
    .array(courtFormatSchema)
    .min(1, { error: "Choose at least one format." })
    .refine((formats) => new Set(formats).size === formats.length, {
      error: "A format is listed twice.",
    }),
});

export type AddClubCourtInput = z.input<typeof addClubCourtInputSchema>;

/** "Who's playing?": mark members as attending or not (Select all, Clear, one row). */
export const setDraftMemberAttendanceInputSchema = z.object({
  sessionId: z.uuid(),
  // No size limit: any number of members can attend.
  memberIds: z.array(z.uuid()),
  attending: z.boolean(),
});

export type SetDraftMemberAttendanceInput = z.input<
  typeof setDraftMemberAttendanceInputSchema
>;

/**
 * "Quick add a guest": the same name and skill rules as a member (first and
 * last name required, skill optional, "" = not set).
 */
export const addDraftGuestInputSchema = memberInputSchema.extend({
  sessionId: z.uuid(),
  // Chosen by the browser so a retried add can't add the guest twice.
  participantId: z.uuid(),
});

export type AddDraftGuestInput = z.input<typeof addDraftGuestInputSchema>;

export const removeDraftGuestInputSchema = z.object({
  sessionId: z.uuid(),
  participantId: z.uuid(),
});

export type RemoveDraftGuestInput = z.input<typeof removeDraftGuestInputSchema>;

/**
 * The part of `sessions.config_snapshot` the Setup screen owns while the
 * session is a draft. Courts use the engine's `CourtConfig` shape, the same as
 * the SessionStarted config that replaces the snapshot at the start.
 */
export interface SessionDraftConfig {
  courts: CourtConfig[];
  matchFormat: CourtFormat;
  targetMatchMinutes: number;
  changeoverMinutes: number;
}

export const DEFAULT_SESSION_DRAFT_CONFIG: SessionDraftConfig = {
  courts: [],
  matchFormat: "doubles",
  targetMatchMinutes: DEFAULT_TARGET_MATCH_MINUTES,
  changeoverMinutes: DEFAULT_CHANGEOVER_MINUTES,
};

const sessionDraftConfigSchema = z.object({
  courts: z
    .array(
      z.object({
        courtId: z.uuid(),
        name: z.string(),
        format: courtFormatSchema,
      }),
    )
    .default([]),
  matchFormat: courtFormatSchema.default(
    DEFAULT_SESSION_DRAFT_CONFIG.matchFormat,
  ),
  targetMatchMinutes: wholeMinutesSchema(TARGET_MATCH_MINUTES_RANGE).default(
    DEFAULT_TARGET_MATCH_MINUTES,
  ),
  changeoverMinutes: wholeMinutesSchema(CHANGEOVER_MINUTES_RANGE).default(
    DEFAULT_CHANGEOVER_MINUTES,
  ),
});

/**
 * Reads a draft's config snapshot. A draft created elsewhere (e.g. the seed
 * script) may have none yet, which means the defaults. A malformed snapshot is
 * a bug, so it fails loudly instead of being silently replaced.
 */
export function parseSessionDraftConfig(
  configSnapshot: unknown,
): SessionDraftConfig {
  if (configSnapshot === null || configSnapshot === undefined) {
    return DEFAULT_SESSION_DRAFT_CONFIG;
  }
  const parsed = sessionDraftConfigSchema.safeParse(configSnapshot);
  if (!parsed.success) {
    throw new Error(
      `The draft's config snapshot is malformed: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
