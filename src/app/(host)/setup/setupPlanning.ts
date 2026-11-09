// Pure helpers for the Setup screen: local date/time maths, form validation,
// capacity numbers and the games estimate copy. No React here, so it's unit
// tested directly.
//
// Time zone: there is no club time zone setting yet, so the host's browser
// time zone is used. The form edits a local date and local start/end times;
// they are stored as timestamptz (ISO instants) and shown back in the
// browser's own time zone.
//
// Overnight sessions: an end time at or before the start time is on the next
// day (e.g. 23:00 to 01:00). The 12-hour maximum in setupRules keeps that
// unambiguous.
import {
  fillableSeats,
  PLAYERS_PER_MATCH,
  type CourtFormat,
  type GamesEstimate,
} from "@/engine";
import type { SessionDraft } from "@/server/setup/setupDraft";
import {
  saveSessionDraftInputSchema,
  type SaveSessionDraftInput,
} from "@/server/setup/setupRules";

export const DURATION_PRESET_MINUTES = [60, 90, 120, 150] as const;
export const DEFAULT_SESSION_DURATION_MINUTES = 120;

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** "2026-11-07" in the browser's time zone (the value of <input type="date">). */
export function toLocalDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

/** "18:00" in the browser's time zone (the value of <input type="time">). */
export function toLocalTimeInputValue(date: Date): string {
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/**
 * The local instant for a date input and a time input (plus `dayOffset` days),
 * or null when either is incomplete.
 *
 * Daylight saving: a wall-clock time that doesn't exist (inside the
 * spring-forward gap, e.g. 02:30) is moved forward by the gap, and a time that
 * happens twice (the autumn overlap) resolves to one of the two instants, as
 * JavaScript's Date does. Durations are real elapsed minutes, so a session
 * spanning the change shows 60 minutes more or less than its wall-clock span.
 */
export function localDateTime(
  dateValue: string,
  timeValue: string,
  dayOffset = 0,
): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!dateMatch || !timeMatch) return null;
  const [year, month, day] = dateMatch.slice(1).map(Number);
  const [hours, minutes] = timeMatch.slice(1).map(Number);
  if (hours > 23 || minutes > 59) return null;
  const calendarDay = new Date(year, month - 1, day);
  // Rejects dates that roll over, e.g. 2026-02-31.
  if (calendarDay.getDate() !== day || calendarDay.getMonth() !== month - 1) {
    return null;
  }
  return new Date(year, month - 1, day + dayOffset, hours, minutes);
}

/**
 * The planned start and end for the form's date and times. An end at or
 * before the start is on the next day (an overnight session).
 */
export function plannedTimesFromForm(
  form: Pick<SetupForm, "date" | "startTime" | "endTime">,
): {
  plannedStart: Date | null;
  plannedEnd: Date | null;
  isEndNextDay: boolean;
} {
  const plannedStart = localDateTime(form.date, form.startTime);
  const sameDayEnd = localDateTime(form.date, form.endTime);
  if (!plannedStart || !sameDayEnd || sameDayEnd > plannedStart) {
    return { plannedStart, plannedEnd: sameDayEnd, isEndNextDay: false };
  }
  return {
    plannedStart,
    plannedEnd: localDateTime(form.date, form.endTime, 1),
    isEndNextDay: true,
  };
}

/** "18:00" + 120 → "20:00"; wraps past midnight ("23:00" + 120 → "01:00", read as the next day). */
export function addMinutesToTimeValue(
  timeValue: string,
  minutes: number,
): string {
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!timeMatch) return timeValue;
  const totalMinutes =
    (((Number(timeMatch[1]) * 60 + Number(timeMatch[2]) + minutes) %
      MINUTES_PER_DAY) +
      MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  return `${twoDigits(Math.floor(totalMinutes / 60))}:${twoDigits(totalMinutes % 60)}`;
}

/** Whole minutes from start to end (DST changes count as real elapsed time). */
export function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / MS_PER_MINUTE);
}

/** What the Session details and Courts cards edit. Numbers stay as typed until validated. */
export interface SetupForm {
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  hostName: string;
  targetMatchMinutes: string;
  changeoverMinutes: string;
  selectedCourtIds: string[];
  matchFormat: CourtFormat;
}

export type SetupFormField =
  | "name"
  | "date"
  | "startTime"
  | "endTime"
  | "location"
  | "hostName"
  | "targetMatchMinutes"
  | "changeoverMinutes"
  | "courts";

export type SetupFormErrors = Partial<Record<SetupFormField, string>>;

export function setupFormFromDraft(
  draft: SessionDraft,
  activeCourtIds: ReadonlySet<string>,
): SetupForm {
  const plannedStart = new Date(draft.plannedStart);
  const plannedEnd = new Date(draft.plannedEnd);
  return {
    name: draft.name,
    date: toLocalDateInputValue(plannedStart),
    startTime: toLocalTimeInputValue(plannedStart),
    endTime: toLocalTimeInputValue(plannedEnd),
    location: draft.location ?? "",
    hostName: draft.hostName,
    targetMatchMinutes: String(draft.config.targetMatchMinutes),
    changeoverMinutes: String(draft.config.changeoverMinutes),
    // A court deactivated since it was chosen drops out (and the next save removes it).
    selectedCourtIds: draft.config.courts
      .map((court) => court.courtId)
      .filter((courtId) => activeCourtIds.has(courtId)),
    matchFormat: draft.config.matchFormat,
  };
}

function wholeNumberOrNaN(text: string): number {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

const SCHEMA_PATH_TO_FIELD: Record<string, SetupFormField> = {
  name: "name",
  location: "location",
  hostName: "hostName",
  plannedStart: "startTime",
  plannedEnd: "endTime",
  courtIds: "courts",
  targetMatchMinutes: "targetMatchMinutes",
  changeoverMinutes: "changeoverMinutes",
};

export interface SetupFormValidation {
  fieldErrors: SetupFormErrors;
  /** The save payload, or null while any field is invalid. */
  saveInput: SaveSessionDraftInput | null;
  /** Planned length in minutes, or null when the times are incomplete. */
  durationMinutes: number | null;
  plannedStart: Date | null;
  plannedEnd: Date | null;
  /** The end time is on the day after the date (overnight). */
  isEndNextDay: boolean;
}

/** Validates the form with the same schema the server uses. */
export function validateSetupForm(
  form: SetupForm,
  sessionId: string,
): SetupFormValidation {
  const fieldErrors: SetupFormErrors = {};
  const { plannedStart, plannedEnd, isEndNextDay } = plannedTimesFromForm(form);
  if (!localDateTime(form.date, "00:00")) fieldErrors.date = "Choose a date.";
  else {
    if (!plannedStart) fieldErrors.startTime = "Enter a start time.";
    if (!plannedEnd) fieldErrors.endTime = "Enter an end time.";
  }

  const candidateInput: SaveSessionDraftInput = {
    sessionId,
    name: form.name,
    location: form.location,
    hostName: form.hostName,
    plannedStart: (plannedStart ?? new Date(0)).toISOString(),
    plannedEnd: (plannedEnd ?? new Date(0)).toISOString(),
    courtIds: form.selectedCourtIds,
    matchFormat: form.matchFormat,
    targetMatchMinutes: wholeNumberOrNaN(form.targetMatchMinutes),
    changeoverMinutes: wholeNumberOrNaN(form.changeoverMinutes),
  };
  const parsed = saveSessionDraftInputSchema.safeParse(candidateInput);
  if (!parsed.success) {
    const areTimesIncomplete = !plannedStart || !plannedEnd;
    for (const issue of parsed.error.issues) {
      const field = SCHEMA_PATH_TO_FIELD[String(issue.path[0])];
      if (!field || fieldErrors[field]) continue;
      // Incomplete times already have their own message above.
      if (
        areTimesIncomplete &&
        (field === "startTime" || field === "endTime")
      ) {
        continue;
      }
      fieldErrors[field] = issue.message;
    }
  }

  const hasErrors = Object.keys(fieldErrors).length > 0;
  return {
    fieldErrors,
    saveInput: hasErrors ? null : candidateInput,
    durationMinutes:
      plannedStart && plannedEnd
        ? minutesBetween(plannedStart, plannedEnd)
        : null,
    plannedStart,
    plannedEnd,
    isEndNextDay,
  };
}

export interface CourtCapacity {
  /** k: players per match in the chosen format. */
  playersPerCourt: number;
  /** courts × k. */
  seatsOnCourts: number;
  /** Seats that can actually be filled by the attending players at the start. */
  onCourtAtStart: number;
  waitingAtStart: number;
}

export function courtCapacity(
  courtCount: number,
  matchFormat: CourtFormat,
  attendingPlayerCount: number,
): CourtCapacity {
  const playersPerCourt = PLAYERS_PER_MATCH[matchFormat];
  const onCourtAtStart = fillableSeats(
    Array.from({ length: courtCount }, () => matchFormat),
    attendingPlayerCount,
  );
  return {
    playersPerCourt,
    seatsOnCourts: courtCount * playersPerCourt,
    onCourtAtStart,
    waitingAtStart: attendingPlayerCount - onCourtAtStart,
  };
}

export interface GamesEstimateCopy {
  /** "info" = the lime estimate box; "attention" = the orange warning. */
  tone: "info" | "attention";
  /** Plain text before the emphasised part (or the whole message). */
  lead: string;
  /** Bold part, e.g. "3–4 games per player"; the sentence then ends with ".". */
  emphasis: string | null;
}

export function estimateSentence(copy: GamesEstimateCopy): string {
  return copy.emphasis ? `${copy.lead}${copy.emphasis}.` : copy.lead;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

/** Plan §5.8 copy, e.g. "About 7 rounds fit in 120 min, so expect 3–4 games per player." */
export function describeGamesEstimate(
  estimate: GamesEstimate,
  context: {
    durationMinutes: number;
    targetMatchMinutes: number;
    changeoverMinutes: number;
    attendingPlayerCount: number;
  },
): GamesEstimateCopy {
  switch (estimate.kind) {
    case "noCourts":
      return {
        tone: "attention",
        lead: "Choose at least one court to see how many games fit.",
        emphasis: null,
      };
    case "notEnoughPlayers":
      return {
        tone: "attention",
        lead: `Not enough players: a court needs ${estimate.playersNeeded} and ${context.attendingPlayerCount} ${plural(
          context.attendingPlayerCount,
          "is",
          "are",
        )} attending.`,
        emphasis: null,
      };
    case "fewerThanOneRound":
      return {
        tone: "attention",
        lead: `Fewer than one full round: a ${context.targetMatchMinutes}-minute match plus ${context.changeoverMinutes}-minute changeover doesn't fit in ${context.durationMinutes} min.`,
        emphasis: null,
      };
    case "estimate": {
      const { rounds, lowGamesPerPlayer, highGamesPerPlayer } = estimate;
      const gamesRange =
        lowGamesPerPlayer === highGamesPerPlayer
          ? `${lowGamesPerPlayer}`
          : `${lowGamesPerPlayer}–${highGamesPerPlayer}`;
      return {
        tone: "info",
        lead: `About ${rounds} ${plural(rounds, "round fits", "rounds fit")} in ${context.durationMinutes} min, so expect `,
        emphasis: `${gamesRange} ${plural(highGamesPerPlayer, "game", "games")} per player`,
      };
    }
  }
}

/** Defaults for "Start a new session": the next full hour, for two hours. */
export function defaultNewDraftTimes(now: Date): {
  name: string;
  plannedStart: string;
  plannedEnd: string;
} {
  const plannedStart = new Date(now);
  plannedStart.setMinutes(0, 0, 0);
  plannedStart.setHours(plannedStart.getHours() + 1);
  const plannedEnd = new Date(
    plannedStart.getTime() + DEFAULT_SESSION_DURATION_MINUTES * MS_PER_MINUTE,
  );
  const weekday = plannedStart.toLocaleDateString("en-GB", { weekday: "long" });
  return {
    name: `${weekday} social`,
    plannedStart: plannedStart.toISOString(),
    plannedEnd: plannedEnd.toISOString(),
  };
}

/** "Sat 7 Nov · 18:00 – 20:00" in the browser's time zone. */
export function formatSessionWhen(
  plannedStart: Date,
  plannedEnd: Date,
): string {
  const day = plannedStart.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${day} · ${toLocalTimeInputValue(plannedStart)} – ${toLocalTimeInputValue(plannedEnd)}`;
}
