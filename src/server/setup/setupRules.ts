import { z } from "zod";
import {
  RECOMMENDED_ROTATION_PREFERENCES,
  type CourtConfig,
  type CourtFormat,
  type RotationObjective,
  type RotationPreferences,
  type RotationRules,
} from "@/engine/session";
import { genderSchema, personNameSchema } from "@/server/participantRules";
import { SKILL_LEVELS } from "@/server/skillLevels";
import { en } from "@/i18n/messages/en";

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

/** Mirrors the `short_label` domain (social, session, host and court names). */
export const SHORT_LABEL_MAX_LENGTH = 80;
/** Mirrors the `sessions.location` check. */
export const LOCATION_MAX_LENGTH = 120;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function shortLabelSchema(emptyMessage: string) {
  return z
    .string()
    .transform(collapseSpaces)
    .pipe(
      z
        .string()
        .min(1, { error: emptyMessage })
        .max(SHORT_LABEL_MAX_LENGTH, {
          error: en.validation.nameTooLong(SHORT_LABEL_MAX_LENGTH),
        })
        .refine((label) => !CONTROL_CHARACTERS.test(label), {
          error: en.validation.nameHasControlCharacters,
        }),
    );
}

function wholeMinutesSchema(range: { min: number; max: number }) {
  const message = en.validation.wholeMinutes(range.min, range.max);
  return z
    .number({ error: message })
    .int({ error: message })
    .min(range.min, { error: message })
    .max(range.max, { error: message });
}

const courtFormatSchema = z.enum(COURT_FORMATS);

/** Every rotation objective the engine knows (plan §5.3). */
export const ROTATION_OBJECTIVES = [
  "equalGames",
  "shortestWaits",
  "playingTime",
  "fullCourts",
  "noBackToBack",
  "mixPartners",
] as const satisfies readonly RotationObjective[];

const ROTATION_RULE_KEYS = [
  "preventConsecutive",
  "fewerGamesFirst",
  "longestWaitFirst",
  "mixPartners",
  "minimiseRepeatOpponents",
  "allowManualAssignments",
] as const satisfies readonly (keyof RotationRules)[];

/** A fresh, mutable copy of the engine's recommended rotation. */
export function recommendedRotationPreferences(): RotationPreferences {
  return {
    objectiveOrder: [...RECOMMENDED_ROTATION_PREFERENCES.objectiveOrder],
    rules: { ...RECOMMENDED_ROTATION_PREFERENCES.rules },
  };
}

/**
 * The host's rotation, exactly the engine's `RotationPreferences`: every
 * objective ranked once, and all six rules on or off.
 */
export const rotationPreferencesSchema = z.object({
  objectiveOrder: z
    .array(z.enum(ROTATION_OBJECTIVES))
    .refine(
      (objectiveOrder) =>
        objectiveOrder.length === ROTATION_OBJECTIVES.length &&
        new Set(objectiveOrder).size === ROTATION_OBJECTIVES.length,
      { error: "Rank every rotation priority exactly once." },
    ),
  rules: z.object(
    Object.fromEntries(
      ROTATION_RULE_KEYS.map((ruleKey) => [ruleKey, z.boolean()]),
    ) as Record<(typeof ROTATION_RULE_KEYS)[number], z.ZodBoolean>,
  ),
}) satisfies z.ZodType<RotationPreferences>;

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

/** Optional: an empty location is stored as null. */
const locationSchema = z
  .string()
  .transform(collapseSpaces)
  .pipe(
    z
      .string()
      .max(LOCATION_MAX_LENGTH, {
        error: en.validation.nameTooLong(LOCATION_MAX_LENGTH),
      })
      .refine((location) => !CONTROL_CHARACTERS.test(location), {
        error: en.validation.nameHasControlCharacters,
      }),
  )
  .transform((location) => (location === "" ? null : location));

/** What the Setup screen saves into a draft (sessions columns + its config). */
export const saveSessionDraftInputSchema = z
  .object({
    sessionId: z.uuid(),
    name: shortLabelSchema(en.validation.sessionNameRequired),
    location: locationSchema,
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
    rotation: rotationPreferencesSchema,
  })
  .superRefine(checkPlannedTimes);

export type SaveSessionDraftInput = z.input<typeof saveSessionDraftInputSchema>;
export type ValidSessionDraft = z.output<typeof saveSessionDraftInputSchema>;

/** Short Setup saves session-local courts; planned times remain draft placeholders. */
export const saveSimpleSessionDraftInputSchema = z.object({
  sessionId: z.uuid(),
  name: shortLabelSchema(en.validation.sessionNameRequired),
  courtCount: z
    .number({ error: en.validation.courtCountRange(1, 1000) })
    .int({ error: en.validation.courtCountRange(1, 1000) })
    .min(1, { error: en.validation.courtCountRange(1, 1000) })
    .max(1000, { error: en.validation.courtCountRange(1, 1000) }),
  durationMinutes: wholeMinutesSchema({
    min: 1,
    max: MAX_SESSION_DURATION_MINUTES,
  }),
});

export type SaveSimpleSessionDraftInput = z.input<
  typeof saveSimpleSessionDraftInputSchema
>;

/** A new draft: the browser picks the default times (it knows the host's time zone). */
export const startSessionDraftInputSchema = z
  .object({
    name: shortLabelSchema(en.validation.sessionNameRequired),
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

/**
 * A player the host adds to the draft (session-only participants): first
 * name, last name, gender and level, all required. The database also refuses a name
 * already in the session (NAME_ALREADY_IN_SESSION).
 */
export const draftParticipantInputSchema = z.object({
  firstName: personNameSchema(en.validation.hostFirstNameRequired),
  lastName: personNameSchema(en.validation.hostLastNameRequired),
  skillLevel: z.enum(SKILL_LEVELS, { error: en.validation.hostLevelRequired }),
  gender: genderSchema,
});

export type DraftParticipantInput = z.output<
  typeof draftParticipantInputSchema
>;

export const addDraftParticipantInputSchema =
  draftParticipantInputSchema.extend({
    sessionId: z.uuid(),
    // Chosen by the browser so a retried add can't add the player twice.
    participantId: z.uuid(),
  });

export type AddDraftParticipantInput = z.input<
  typeof addDraftParticipantInputSchema
>;

export const removeDraftParticipantInputSchema = z.object({
  sessionId: z.uuid(),
  participantId: z.uuid(),
});

export type RemoveDraftParticipantInput = z.input<
  typeof removeDraftParticipantInputSchema
>;

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
  rotation: RotationPreferences;
  /** The saved setup last applied to this draft (hides the reuse banner), or null. */
  appliedSavedSetupId: string | null;
}

export const DEFAULT_SESSION_DRAFT_CONFIG: Readonly<SessionDraftConfig> = {
  courts: [],
  matchFormat: "doubles",
  targetMatchMinutes: DEFAULT_TARGET_MATCH_MINUTES,
  changeoverMinutes: DEFAULT_CHANGEOVER_MINUTES,
  rotation: RECOMMENDED_ROTATION_PREFERENCES,
  appliedSavedSetupId: null,
};

const courtConfigSchema = z.object({
  courtId: z.uuid(),
  name: z.string(),
  format: courtFormatSchema,
});

const sessionDraftConfigSchema = z.object({
  courts: z.array(courtConfigSchema).default([]),
  matchFormat: courtFormatSchema.default(
    DEFAULT_SESSION_DRAFT_CONFIG.matchFormat,
  ),
  targetMatchMinutes: wholeMinutesSchema(TARGET_MATCH_MINUTES_RANGE).default(
    DEFAULT_TARGET_MATCH_MINUTES,
  ),
  changeoverMinutes: wholeMinutesSchema(CHANGEOVER_MINUTES_RANGE).default(
    DEFAULT_CHANGEOVER_MINUTES,
  ),
  // Drafts saved before the Rotation card (M4.4) have none: the recommended one.
  rotation: rotationPreferencesSchema.default(recommendedRotationPreferences),
  appliedSavedSetupId: z.uuid().nullable().default(null),
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
    return {
      ...DEFAULT_SESSION_DRAFT_CONFIG,
      rotation: recommendedRotationPreferences(),
    };
  }
  const parsed = sessionDraftConfigSchema.safeParse(configSnapshot);
  if (!parsed.success) {
    throw new Error(
      `The draft's config snapshot is malformed: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * A saved setup's config (`saved_setups.config`): a host's reusable defaults.
 * Never attendance or anything about a session (the database refuses other
 * keys too).
 */
export interface SavedSetupConfig {
  location: string | null;
  durationMinutes: number;
  courts: CourtConfig[];
  matchFormat: CourtFormat;
  targetMatchMinutes: number;
  changeoverMinutes: number;
  rotation: RotationPreferences;
}

const savedSetupConfigSchema = z.strictObject({
  location: z.string().max(LOCATION_MAX_LENGTH).nullable(),
  durationMinutes: wholeMinutesSchema({
    min: 1,
    max: MAX_SESSION_DURATION_MINUTES,
  }),
  courts: z.array(courtConfigSchema),
  matchFormat: courtFormatSchema,
  targetMatchMinutes: wholeMinutesSchema(TARGET_MATCH_MINUTES_RANGE),
  changeoverMinutes: wholeMinutesSchema(CHANGEOVER_MINUTES_RANGE),
  rotation: rotationPreferencesSchema,
}) satisfies z.ZodType<SavedSetupConfig>;

/** Checks a saved setup's config without throwing (before writing one, or to skip a bad row). */
export function safeParseSavedSetupConfig(config: unknown) {
  return savedSetupConfigSchema.safeParse(config);
}

/** Reads a saved setup's config; one this app didn't write is a bug, so it fails loudly. */
export function parseSavedSetupConfig(config: unknown): SavedSetupConfig {
  const parsed = savedSetupConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      `A saved setup's config is malformed: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** "Save this setup": the setup's name plus the editor's current (valid) draft values. */
export const saveSetupInputSchema = z.object({
  setupName: shortLabelSchema("Name this setup."),
  draft: saveSessionDraftInputSchema,
});

export type SaveSetupInput = z.input<typeof saveSetupInputSchema>;

export const applySavedSetupInputSchema = z.object({
  sessionId: z.uuid(),
  setupId: z.uuid(),
  /** The draft settings revision the editor shows (optimistic concurrency). */
  expectedDraftRevision: z.number().int().min(0),
});

export type ApplySavedSetupInput = z.input<typeof applySavedSetupInputSchema>;

/** Shown when "Start a new session" opens the draft a co-host already started. */
export function coHostDraftNotice(draftName: string): string {
  return en.serverMessages.setup.coHostDraft(draftName);
}

/** After applying a saved setup: "Court 5 is no longer available and was left out." */
export function courtsLeftOutNotice(
  courtNames: readonly string[],
): string | null {
  if (courtNames.length === 0) return null;
  if (courtNames.length === 1) {
    return `${courtNames[0]} is no longer available and was left out.`;
  }
  const listed = `${courtNames.slice(0, -1).join(", ")} and ${courtNames.at(-1)}`;
  return `${listed} are no longer available and were left out.`;
}

export const setDraftParticipantDetailsInputSchema = z.object({
  sessionId: z.uuid(),
  participantId: z.uuid(),
  gender: genderSchema,
  skillLevel: z.enum(SKILL_LEVELS, { error: en.validation.hostLevelRequired }),
  expectedDraftRevision: z.number().int().nonnegative(),
});
export type SetDraftParticipantDetailsInput = z.input<
  typeof setDraftParticipantDetailsInputSchema
>;
