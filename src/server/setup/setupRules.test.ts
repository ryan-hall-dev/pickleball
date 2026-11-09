// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  addClubCourtInputSchema,
  DEFAULT_SESSION_DRAFT_CONFIG,
  parseSessionDraftConfig,
  saveSessionDraftInputSchema,
  startSessionDraftInputSchema,
} from "./setupRules";

const COURT_ID = "c0000000-0000-4000-8000-000000000001";
const validDraft = {
  sessionId: "d0000000-0000-4000-8000-000000000001",
  name: "  Saturday   social ",
  location: "",
  hostName: "Ryan H.",
  plannedStart: "2026-11-07T18:00:00.000Z",
  plannedEnd: "2026-11-07T20:00:00.000Z",
  courtIds: [COURT_ID],
  matchFormat: "doubles",
  targetMatchMinutes: 15,
  changeoverMinutes: 2,
};

describe("saveSessionDraftInputSchema", () => {
  it("tidies names and stores an empty location as null", () => {
    const parsed = saveSessionDraftInputSchema.parse(validDraft);
    expect(parsed.name).toBe("Saturday social");
    expect(parsed.location).toBeNull();
  });

  it("rejects an end at or before the start", () => {
    const result = saveSessionDraftInputSchema.safeParse({
      ...validDraft,
      plannedEnd: validDraft.plannedStart,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["plannedEnd"],
      message: "End time must be after the start time.",
    });
  });

  it("allows overnight sessions up to 12 hours", () => {
    expect(
      saveSessionDraftInputSchema.safeParse({
        ...validDraft,
        plannedStart: "2026-11-07T23:00:00.000Z",
        plannedEnd: "2026-11-08T11:00:00.000Z",
      }).success,
    ).toBe(true);
    const tooLong = saveSessionDraftInputSchema.safeParse({
      ...validDraft,
      plannedStart: "2026-11-07T23:00:00.000Z",
      plannedEnd: "2026-11-08T11:01:00.000Z",
    });
    expect(tooLong.error?.issues[0]).toMatchObject({
      path: ["plannedEnd"],
      message: "A session can last at most 12 hours.",
    });
  });

  it("rejects duplicate courts, unknown formats, control characters and bad ids", () => {
    for (const badInput of [
      { courtIds: [COURT_ID, COURT_ID] },
      { matchFormat: "triples" },
      { name: "Bad\u0007name" },
      { sessionId: "not-a-uuid" },
      { plannedStart: "tomorrow" },
      { targetMatchMinutes: 0 },
      { changeoverMinutes: 1.5 },
    ]) {
      expect(
        saveSessionDraftInputSchema.safeParse({ ...validDraft, ...badInput })
          .success,
        JSON.stringify(badInput),
      ).toBe(false);
    }
  });

  it("has no limit on how many courts a session uses", () => {
    const manyCourtIds = Array.from(
      { length: 60 },
      (_, index) =>
        `c0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(
      saveSessionDraftInputSchema.safeParse({
        ...validDraft,
        courtIds: manyCourtIds,
      }).success,
    ).toBe(true);
  });
});

describe("startSessionDraftInputSchema", () => {
  it("needs a name and an end after the start", () => {
    expect(
      startSessionDraftInputSchema.safeParse({
        name: "Saturday social",
        plannedStart: validDraft.plannedStart,
        plannedEnd: validDraft.plannedEnd,
      }).success,
    ).toBe(true);
    expect(
      startSessionDraftInputSchema.safeParse({
        name: " ",
        plannedStart: validDraft.plannedStart,
        plannedEnd: validDraft.plannedEnd,
      }).success,
    ).toBe(false);
    expect(
      startSessionDraftInputSchema.safeParse({
        name: "Saturday social",
        plannedStart: validDraft.plannedEnd,
        plannedEnd: validDraft.plannedStart,
      }).success,
    ).toBe(false);
  });
});

describe("addClubCourtInputSchema", () => {
  it("needs a name and at least one distinct format", () => {
    expect(
      addClubCourtInputSchema.parse({
        name: " Court 5 ",
        supportedFormats: ["doubles"],
      }),
    ).toEqual({ name: "Court 5", supportedFormats: ["doubles"] });
    expect(
      addClubCourtInputSchema.safeParse({
        name: "Court 5",
        supportedFormats: [],
      }).error?.issues[0]?.message,
    ).toBe("Choose at least one format.");
    expect(
      addClubCourtInputSchema.safeParse({
        name: "Court 5",
        supportedFormats: ["singles", "singles"],
      }).success,
    ).toBe(false);
    expect(
      addClubCourtInputSchema.safeParse({
        name: "",
        supportedFormats: ["singles"],
      }).error?.issues[0]?.message,
    ).toBe("Enter a court name.");
  });
});

describe("parseSessionDraftConfig", () => {
  it("uses the defaults for a draft without a snapshot", () => {
    expect(parseSessionDraftConfig(null)).toEqual(DEFAULT_SESSION_DRAFT_CONFIG);
    expect(parseSessionDraftConfig({})).toEqual(DEFAULT_SESSION_DRAFT_CONFIG);
    expect(DEFAULT_SESSION_DRAFT_CONFIG).toEqual({
      courts: [],
      matchFormat: "doubles",
      targetMatchMinutes: 15,
      changeoverMinutes: 2,
    });
  });

  it("reads a saved config and ignores keys other steps own", () => {
    expect(
      parseSessionDraftConfig({
        courts: [{ courtId: COURT_ID, name: "Court 1", format: "singles" }],
        matchFormat: "singles",
        targetMatchMinutes: 12,
        changeoverMinutes: 3,
        rotation: { objectiveOrder: [] },
      }),
    ).toEqual({
      courts: [{ courtId: COURT_ID, name: "Court 1", format: "singles" }],
      matchFormat: "singles",
      targetMatchMinutes: 12,
      changeoverMinutes: 3,
    });
  });

  it("fails loudly on a malformed snapshot", () => {
    expect(() => parseSessionDraftConfig({ courts: "Court 1" })).toThrow(
      /malformed/,
    );
  });
});
