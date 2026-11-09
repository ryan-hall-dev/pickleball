// @vitest-environment node
import { describe, expect, it } from "vitest";
import { estimateGames } from "@/engine";
import type { SessionDraft } from "@/server/setup/setupDraft";
import {
  addMinutesToTimeValue,
  courtCapacity,
  defaultNewDraftTimes,
  describeGamesEstimate,
  estimateSentence,
  formatSessionWhen,
  localDateTime,
  minutesBetween,
  setupFormFromDraft,
  toLocalDateInputValue,
  toLocalTimeInputValue,
  validateSetupForm,
  type SetupForm,
} from "./setupPlanning";

const SESSION_ID = "d0000000-0000-4000-8000-000000000001";
const COURT_1 = "c0000000-0000-4000-8000-000000000001";
const COURT_2 = "c0000000-0000-4000-8000-000000000002";

const validForm: SetupForm = {
  name: "Saturday social",
  date: "2026-11-07",
  startTime: "18:00",
  endTime: "20:00",
  location: "Riverside courts",
  hostName: "Ryan H.",
  targetMatchMinutes: "15",
  changeoverMinutes: "2",
  selectedCourtIds: [COURT_1, COURT_2],
  matchFormat: "doubles",
};

describe("local date and time inputs", () => {
  it("round-trips a local date and time through the input values", () => {
    const date = localDateTime("2026-11-07", "18:05");
    expect(date).toEqual(new Date(2026, 10, 7, 18, 5));
    expect(toLocalDateInputValue(date!)).toBe("2026-11-07");
    expect(toLocalTimeInputValue(date!)).toBe("18:05");
  });

  it("adds days for an overnight end", () => {
    expect(localDateTime("2026-11-30", "01:00", 1)).toEqual(
      new Date(2026, 11, 1, 1, 0),
    );
    expect(localDateTime("2026-02-31", "01:00", 1)).toBeNull();
  });

  it("rejects incomplete or impossible values", () => {
    expect(localDateTime("", "18:00")).toBeNull();
    expect(localDateTime("2026-11-07", "")).toBeNull();
    expect(localDateTime("2026-02-31", "18:00")).toBeNull();
    expect(localDateTime("2026-11-07", "24:00")).toBeNull();
    expect(localDateTime("2026-11-07", "18:60")).toBeNull();
  });

  it("adds minutes to a time, wrapping past midnight", () => {
    expect(addMinutesToTimeValue("18:00", 120)).toBe("20:00");
    expect(addMinutesToTimeValue("18:30", 90)).toBe("20:00");
    expect(addMinutesToTimeValue("23:00", 90)).toBe("00:30");
    expect(addMinutesToTimeValue("23:00", 120)).toBe("01:00");
    expect(addMinutesToTimeValue("", 90)).toBe("");
  });

  it("counts whole minutes between two instants", () => {
    expect(
      minutesBetween(
        new Date(2026, 10, 7, 18, 0),
        new Date(2026, 10, 7, 20, 30),
      ),
    ).toBe(150);
  });

  it("defaults a new draft to the next full hour for two hours, named after the weekday", () => {
    const defaults = defaultNewDraftTimes(new Date(2026, 10, 7, 17, 42));
    expect(new Date(defaults.plannedStart)).toEqual(
      new Date(2026, 10, 7, 18, 0),
    );
    expect(new Date(defaults.plannedEnd)).toEqual(new Date(2026, 10, 7, 20, 0));
    expect(defaults.name).toBe("Saturday social");
  });

  it("formats the summary's When line", () => {
    expect(
      formatSessionWhen(
        new Date(2026, 10, 7, 18, 0),
        new Date(2026, 10, 7, 20, 0),
      ),
    ).toBe("Sat 7 Nov · 18:00 – 20:00");
  });
});

describe("setupFormFromDraft", () => {
  const draft: SessionDraft = {
    sessionId: SESSION_ID,
    name: "Saturday social",
    location: null,
    hostName: "Ryan H.",
    plannedStart: new Date(2026, 10, 7, 18, 0).toISOString(),
    plannedEnd: new Date(2026, 10, 7, 20, 0).toISOString(),
    config: {
      courts: [
        { courtId: COURT_1, name: "Court 1", format: "doubles" },
        { courtId: COURT_2, name: "Court 2", format: "doubles" },
      ],
      matchFormat: "doubles",
      targetMatchMinutes: 15,
      changeoverMinutes: 2,
    },
    participants: [],
  };

  it("shows the draft in local time and drops courts that are no longer active", () => {
    expect(setupFormFromDraft(draft, new Set([COURT_1]))).toEqual({
      ...validForm,
      name: "Saturday social",
      location: "",
      selectedCourtIds: [COURT_1],
    });
  });
});

describe("validateSetupForm", () => {
  it("accepts a valid form and builds the save payload with ISO instants", () => {
    const validation = validateSetupForm(validForm, SESSION_ID);
    expect(validation.fieldErrors).toEqual({});
    expect(validation.durationMinutes).toBe(120);
    expect(validation.saveInput).toEqual({
      sessionId: SESSION_ID,
      name: "Saturday social",
      location: "Riverside courts",
      hostName: "Ryan H.",
      plannedStart: new Date(2026, 10, 7, 18, 0).toISOString(),
      plannedEnd: new Date(2026, 10, 7, 20, 0).toISOString(),
      courtIds: [COURT_1, COURT_2],
      matchFormat: "doubles",
      targetMatchMinutes: 15,
      changeoverMinutes: 2,
    });
  });

  it("allows no courts and an empty location while drafting", () => {
    const validation = validateSetupForm(
      { ...validForm, selectedCourtIds: [], location: "  " },
      SESSION_ID,
    );
    expect(validation.fieldErrors).toEqual({});
    expect(validation.saveInput).not.toBeNull();
  });

  it("requires a session name and a host name", () => {
    const validation = validateSetupForm(
      { ...validForm, name: "   ", hostName: "" },
      SESSION_ID,
    );
    expect(validation.fieldErrors).toEqual({
      name: "Enter a session name.",
      hostName: "Enter the host's name.",
    });
    expect(validation.saveInput).toBeNull();
  });

  it("keeps a normal daytime session on the same day", () => {
    const validation = validateSetupForm(
      { ...validForm, startTime: "10:00", endTime: "12:30" },
      SESSION_ID,
    );
    expect(validation.isEndNextDay).toBe(false);
    expect(validation.durationMinutes).toBe(150);
    expect(validation.saveInput?.plannedEnd).toBe(
      new Date(2026, 10, 7, 12, 30).toISOString(),
    );
  });

  it("reads an end at or before the start as the next day (overnight)", () => {
    const validation = validateSetupForm(
      { ...validForm, startTime: "23:00", endTime: "01:00" },
      SESSION_ID,
    );
    expect(validation.fieldErrors).toEqual({});
    expect(validation.isEndNextDay).toBe(true);
    expect(validation.durationMinutes).toBe(120);
    expect(validation.saveInput).toMatchObject({
      plannedStart: new Date(2026, 10, 7, 23, 0).toISOString(),
      plannedEnd: new Date(2026, 10, 8, 1, 0).toISOString(),
    });
    // Midnight exactly is the next day too.
    expect(
      validateSetupForm(
        { ...validForm, startTime: "22:00", endTime: "00:00" },
        SESSION_ID,
      ).saveInput?.plannedEnd,
    ).toBe(new Date(2026, 10, 8, 0, 0).toISOString());
  });

  it("rejects sessions longer than 12 hours (including an equal start and end)", () => {
    for (const endTime of ["18:00", "17:30", "06:01"]) {
      const validation = validateSetupForm(
        { ...validForm, endTime },
        SESSION_ID,
      );
      expect(validation.fieldErrors).toEqual({
        endTime: "A session can last at most 12 hours.",
      });
      expect(validation.saveInput).toBeNull();
    }
    expect(
      validateSetupForm({ ...validForm, endTime: "06:00" }, SESSION_ID)
        .durationMinutes,
    ).toBe(720);
    expect(
      validateSetupForm({ ...validForm, endTime: "06:00" }, SESSION_ID)
        .fieldErrors,
    ).toEqual({});
  });

  it("loads drafts created late in the evening as valid (21:00 and 22:00 defaults)", () => {
    for (const createdAt of [
      new Date(2026, 10, 7, 20, 15), // 21:00-23:00
      new Date(2026, 10, 7, 21, 15), // 22:00-00:00 (next day)
      new Date(2026, 10, 7, 23, 15), // 00:00-02:00 on the 8th
    ]) {
      const defaults = defaultNewDraftTimes(createdAt);
      const form = setupFormFromDraft(
        {
          sessionId: SESSION_ID,
          name: defaults.name,
          location: null,
          hostName: "Ryan H.",
          plannedStart: defaults.plannedStart,
          plannedEnd: defaults.plannedEnd,
          config: {
            courts: [],
            matchFormat: "doubles",
            targetMatchMinutes: 15,
            changeoverMinutes: 2,
          },
          participants: [],
        },
        new Set(),
      );
      const validation = validateSetupForm(form, SESSION_ID);
      expect(validation.fieldErrors, createdAt.toString()).toEqual({});
      expect(validation.durationMinutes).toBe(120);
      expect(validation.saveInput).toMatchObject({
        plannedStart: defaults.plannedStart,
        plannedEnd: defaults.plannedEnd,
      });
    }
  });

  it("asks for missing date and times without a misleading order error", () => {
    expect(
      validateSetupForm({ ...validForm, date: "" }, SESSION_ID).fieldErrors,
    ).toEqual({ date: "Choose a date." });
    expect(
      validateSetupForm(
        { ...validForm, startTime: "", endTime: "" },
        SESSION_ID,
      ).fieldErrors,
    ).toEqual({
      startTime: "Enter a start time.",
      endTime: "Enter an end time.",
    });
    expect(
      validateSetupForm({ ...validForm, endTime: "" }, SESSION_ID)
        .durationMinutes,
    ).toBeNull();
  });

  it("validates match and changeover minutes as whole numbers in range", () => {
    expect(
      validateSetupForm(
        { ...validForm, targetMatchMinutes: "0", changeoverMinutes: "61" },
        SESSION_ID,
      ).fieldErrors,
    ).toEqual({
      targetMatchMinutes: "Use a whole number of minutes from 1 to 180.",
      changeoverMinutes: "Use a whole number of minutes from 0 to 60.",
    });
    expect(
      validateSetupForm(
        { ...validForm, targetMatchMinutes: "12.5", changeoverMinutes: "" },
        SESSION_ID,
      ).fieldErrors,
    ).toEqual({
      targetMatchMinutes: "Use a whole number of minutes from 1 to 180.",
      changeoverMinutes: "Use a whole number of minutes from 0 to 60.",
    });
    expect(
      validateSetupForm({ ...validForm, changeoverMinutes: "0" }, SESSION_ID)
        .saveInput?.changeoverMinutes,
    ).toBe(0);
  });

  it("rejects an over-long session name", () => {
    expect(
      validateSetupForm({ ...validForm, name: "x".repeat(81) }, SESSION_ID)
        .fieldErrors,
    ).toEqual({ name: "Use at most 80 characters." });
  });
});

describe("courtCapacity", () => {
  it("multiplies courts by players per court and fills seats from the attendees", () => {
    expect(courtCapacity(4, "doubles", 30)).toEqual({
      playersPerCourt: 4,
      seatsOnCourts: 16,
      onCourtAtStart: 16,
      waitingAtStart: 14,
    });
    expect(courtCapacity(3, "singles", 5)).toEqual({
      playersPerCourt: 2,
      seatsOnCourts: 6,
      onCourtAtStart: 4,
      waitingAtStart: 1,
    });
  });

  it("only fills whole courts, and shows zeros with no players or no courts", () => {
    expect(courtCapacity(2, "doubles", 6)).toMatchObject({
      onCourtAtStart: 4,
      waitingAtStart: 2,
    });
    expect(courtCapacity(4, "doubles", 0)).toMatchObject({
      seatsOnCourts: 16,
      onCourtAtStart: 0,
      waitingAtStart: 0,
    });
    expect(courtCapacity(0, "doubles", 9)).toMatchObject({
      seatsOnCourts: 0,
      onCourtAtStart: 0,
      waitingAtStart: 9,
    });
  });

  it("has no attendance limit", () => {
    expect(courtCapacity(10, "doubles", 1000)).toMatchObject({
      onCourtAtStart: 40,
      waitingAtStart: 960,
    });
  });
});

describe("describeGamesEstimate", () => {
  const defaultTiming = {
    durationMinutes: 120,
    targetMatchMinutes: 15,
    changeoverMinutes: 2,
  };
  function sentenceFor(
    courtCount: number,
    attendingPlayerCount: number,
    timing = defaultTiming,
  ): string {
    const estimate = estimateGames({
      ...timing,
      courtFormats: Array.from(
        { length: courtCount },
        () => "doubles" as const,
      ),
      playerCount: attendingPlayerCount,
    });
    return estimateSentence(
      describeGamesEstimate(estimate, { ...timing, attendingPlayerCount }),
    );
  }

  it("says how many rounds fit and the games range per player", () => {
    expect(sentenceFor(2, 15)).toBe(
      "About 7 rounds fit in 120 min, so expect 3–4 games per player.",
    );
    expect(sentenceFor(4, 30, { ...defaultTiming, durationMinutes: 153 })).toBe(
      "About 9 rounds fit in 153 min, so expect 4–5 games per player.",
    );
  });

  it("uses a single number when the estimate is exact, and singular words", () => {
    expect(sentenceFor(1, 4)).toBe(
      "About 7 rounds fit in 120 min, so expect 7 games per player.",
    );
    expect(sentenceFor(1, 4, { ...defaultTiming, durationMinutes: 20 })).toBe(
      "About 1 round fits in 20 min, so expect 1 game per player.",
    );
  });

  it("marks the estimate as info with the range emphasised", () => {
    const copy = describeGamesEstimate(
      estimateGames({
        ...defaultTiming,
        courtFormats: ["doubles", "doubles"],
        playerCount: 15,
      }),
      { ...defaultTiming, attendingPlayerCount: 15 },
    );
    expect(copy).toEqual({
      tone: "info",
      lead: "About 7 rounds fit in 120 min, so expect ",
      emphasis: "3–4 games per player",
    });
  });

  it("covers the edge cases as attention messages", () => {
    expect(sentenceFor(0, 10)).toBe(
      "Choose at least one court to see how many games fit.",
    );
    expect(sentenceFor(2, 0)).toBe(
      "Not enough players: a court needs 4 and 0 are attending.",
    );
    expect(sentenceFor(2, 1)).toBe(
      "Not enough players: a court needs 4 and 1 is attending.",
    );
    expect(sentenceFor(2, 8, { ...defaultTiming, durationMinutes: 10 })).toBe(
      "Fewer than one full round: a 15-minute match plus 2-minute changeover doesn't fit in 10 min.",
    );
  });
});
