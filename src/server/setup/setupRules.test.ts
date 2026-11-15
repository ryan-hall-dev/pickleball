// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveScoringWeights } from "@/engine/schedule";
import { RECOMMENDED_ROTATION_PREFERENCES } from "@/engine/session";
import {
  fixtureParticipantId,
  TestSession,
} from "@/engine/session/testing/fixtures";
import {
  addClubCourtInputSchema,
  courtsLeftOutNotice,
  DEFAULT_SESSION_DRAFT_CONFIG,
  parseSavedSetupConfig,
  saveSetupInputSchema,
  parseSessionDraftConfig,
  recommendedRotationPreferences,
  rotationPreferencesSchema,
  saveSessionDraftInputSchema,
  saveSimpleSessionDraftInputSchema,
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
  rotation: recommendedRotationPreferences(),
};

describe("saveSimpleSessionDraftInputSchema", () => {
  const input = {
    sessionId: validDraft.sessionId,
    name: validDraft.name,
    courtCount: 2,
    durationMinutes: 90,
  };

  it("normalises the name and accepts the technical bounds", () => {
    expect(saveSimpleSessionDraftInputSchema.parse(input).name).toBe(
      "Saturday social",
    );
    for (const courtCount of [1, 1000]) {
      for (const durationMinutes of [1, 720]) {
        expect(
          saveSimpleSessionDraftInputSchema.safeParse({
            ...input,
            courtCount,
            durationMinutes,
          }).success,
        ).toBe(true);
      }
    }
  });

  it.each([
    { sessionId: "invalid" },
    { name: " " },
    { name: "Bad\u0007name" },
    { courtCount: 0 },
    { courtCount: 1001 },
    { courtCount: 1.5 },
    { courtCount: Infinity },
    { durationMinutes: 0 },
    { durationMinutes: 721 },
    { durationMinutes: 1.5 },
  ])("rejects invalid short Setup input %j", (override) => {
    expect(
      saveSimpleSessionDraftInputSchema.safeParse({ ...input, ...override })
        .success,
    ).toBe(false);
  });
});

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

describe("rotationPreferencesSchema", () => {
  const recommended = recommendedRotationPreferences();

  it("accepts any order of all six objectives", () => {
    const reversed = {
      ...recommended,
      objectiveOrder: [...recommended.objectiveOrder].reverse(),
    };
    expect(rotationPreferencesSchema.parse(reversed)).toEqual(reversed);
  });

  it.each([
    [
      "a duplicate",
      [
        "equalGames",
        "equalGames",
        "playingTime",
        "fullCourts",
        "noBackToBack",
        "mixPartners",
      ],
    ],
    [
      "a missing objective",
      [
        "equalGames",
        "shortestWaits",
        "playingTime",
        "fullCourts",
        "noBackToBack",
      ],
    ],
    [
      "an unknown objective",
      [
        "equalGames",
        "shortestWaits",
        "playingTime",
        "fullCourts",
        "noBackToBack",
        "fastestGames",
      ],
    ],
    ["no objectives", []],
  ])("rejects an order with %s", (_label, objectiveOrder) => {
    expect(
      rotationPreferencesSchema.safeParse({ ...recommended, objectiveOrder })
        .success,
    ).toBe(false);
  });

  it("requires every rule as a boolean", () => {
    const fiveRules = Object.fromEntries(
      Object.entries(recommended.rules).filter(
        ([ruleKey]) => ruleKey !== "allowManualAssignments",
      ),
    );
    expect(
      rotationPreferencesSchema.safeParse({ ...recommended, rules: fiveRules })
        .success,
    ).toBe(false);
    expect(
      rotationPreferencesSchema.safeParse({
        ...recommended,
        rules: { ...recommended.rules, mixPartners: "yes" },
      }).success,
    ).toBe(false);
  });

  it("is required when saving a draft", () => {
    const withoutRotation = Object.fromEntries(
      Object.entries(validDraft).filter(([key]) => key !== "rotation"),
    );
    expect(saveSessionDraftInputSchema.safeParse(withoutRotation).success).toBe(
      false,
    );
  });

  it("recommends the engine's calibrated defaults, as a copy", () => {
    expect(recommended).toEqual(RECOMMENDED_ROTATION_PREFERENCES);
    recommended.objectiveOrder.reverse();
    expect(recommendedRotationPreferences()).toEqual(
      RECOMMENDED_ROTATION_PREFERENCES,
    );
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
      rotation: RECOMMENDED_ROTATION_PREFERENCES,
      appliedSavedSetupId: null,
    });
  });

  it("gives a draft saved before the Rotation card the recommended rotation", () => {
    const parsed = parseSessionDraftConfig({
      courts: [],
      matchFormat: "doubles",
      targetMatchMinutes: 15,
      changeoverMinutes: 2,
    });
    expect(parsed.rotation).toEqual(RECOMMENDED_ROTATION_PREFERENCES);
    // A copy: editing it can't change the shared defaults.
    parsed.rotation.objectiveOrder.reverse();
    expect(parseSessionDraftConfig({}).rotation).toEqual(
      RECOMMENDED_ROTATION_PREFERENCES,
    );
  });

  it("reads a saved config and ignores keys other steps own", () => {
    const rotation = {
      objectiveOrder: [
        "mixPartners",
        "equalGames",
        "shortestWaits",
        "playingTime",
        "fullCourts",
        "noBackToBack",
      ],
      rules: { ...RECOMMENDED_ROTATION_PREFERENCES.rules, mixPartners: false },
    };
    expect(
      parseSessionDraftConfig({
        courts: [{ courtId: COURT_ID, name: "Court 1", format: "singles" }],
        matchFormat: "singles",
        targetMatchMinutes: 12,
        changeoverMinutes: 3,
        rotation,
        appliedSavedSetupId: null,
        someLaterStep: { anything: true },
      }),
    ).toEqual({
      courts: [{ courtId: COURT_ID, name: "Court 1", format: "singles" }],
      matchFormat: "singles",
      targetMatchMinutes: 12,
      changeoverMinutes: 3,
      rotation,
      appliedSavedSetupId: null,
    });
  });

  it("fails loudly on a malformed snapshot", () => {
    expect(() => parseSessionDraftConfig({ courts: "Court 1" })).toThrow(
      /malformed/,
    );
    expect(() =>
      parseSessionDraftConfig({ rotation: { objectiveOrder: [] } }),
    ).toThrow(/malformed/);
  });
});

// The draft's rotation is what M6 copies into the SessionStarted config, so
// it must feed the engine unchanged (Ryan, 2026-11-09).
describe("a saved draft rotation feeds the engine unchanged", () => {
  function draftRotation(rotation: unknown) {
    return parseSessionDraftConfig({
      courts: [],
      matchFormat: "doubles",
      targetMatchMinutes: 15,
      changeoverMinutes: 2,
      rotation,
    }).rotation;
  }
  const recommendedWeights = resolveScoringWeights(
    draftRotation(recommendedRotationPreferences()),
  );

  it("gives the recommended weights for the recommended rotation", () => {
    expect(recommendedWeights).toEqual(
      resolveScoringWeights(RECOMMENDED_ROTATION_PREFERENCES),
    );
  });

  it("changes the weights when the host reorders the priorities", () => {
    const waitsFirst = draftRotation({
      ...recommendedRotationPreferences(),
      objectiveOrder: [
        "shortestWaits",
        "equalGames",
        "playingTime",
        "fullCourts",
        "noBackToBack",
        "mixPartners",
      ],
    });
    const weights = resolveScoringWeights(waitsFirst);
    expect(weights.currentWait).toBeGreaterThan(recommendedWeights.currentWait);
    expect(weights.fairShare).toBeLessThan(recommendedWeights.fairShare);
  });

  it("switches scoring terms off with the rules", () => {
    const rulesOff = draftRotation({
      ...recommendedRotationPreferences(),
      rules: {
        ...recommendedRotationPreferences().rules,
        preventConsecutive: false,
        mixPartners: false,
      },
    });
    const weights = resolveScoringWeights(rulesOff);
    expect(recommendedWeights.consecutive).toBeGreaterThan(0);
    expect(recommendedWeights.repeatPartner).toBeGreaterThan(0);
    expect(weights.consecutive).toBe(0);
    expect(weights.repeatPartner).toBe(0);
  });

  it("refuses host locks when manual assignments are off (not a scoring term)", () => {
    const manualOff = draftRotation({
      ...recommendedRotationPreferences(),
      rules: {
        ...recommendedRotationPreferences().rules,
        allowManualAssignments: false,
      },
    });
    expect(resolveScoringWeights(manualOff)).toEqual(recommendedWeights);

    const locked = TestSession.start({ courts: 1 }).tryApply("PlayerLocked", {
      participantId: fixtureParticipantId(1),
    });
    expect(locked.ok).toBe(true);
    const refused = TestSession.start({
      courts: 1,
      rotation: manualOff,
    }).tryApply("PlayerLocked", { participantId: fixtureParticipantId(1) });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "MANUAL_ASSIGNMENTS_OFF" },
    });
  });
});

describe("saved setups", () => {
  const savedConfig = {
    location: "Riverside",
    durationMinutes: 90,
    courts: [{ courtId: COURT_ID, name: "Court 1", format: "doubles" }],
    matchFormat: "doubles",
    targetMatchMinutes: 15,
    changeoverMinutes: 2,
    rotation: recommendedRotationPreferences(),
  };

  it("reads a saved setup's config", () => {
    expect(parseSavedSetupConfig(savedConfig)).toEqual(savedConfig);
    expect(parseSavedSetupConfig({ ...savedConfig, location: null })).toEqual({
      ...savedConfig,
      location: null,
    });
  });

  it("fails loudly on a config holding anything else, such as attendance", () => {
    expect(() =>
      parseSavedSetupConfig({ ...savedConfig, participants: [] }),
    ).toThrow(/malformed/);
    expect(() =>
      parseSavedSetupConfig({ ...savedConfig, durationMinutes: 721 }),
    ).toThrow(/malformed/);
    const { rotation: _rotation, ...withoutRotation } = savedConfig;
    void _rotation;
    expect(() => parseSavedSetupConfig(withoutRotation)).toThrow(/malformed/);
  });

  it("requires a setup name and a valid draft to save", () => {
    expect(
      saveSetupInputSchema.parse({
        setupName: "  Saturday  Social ",
        draft: validDraft,
      }).setupName,
    ).toBe("Saturday Social");
    expect(
      saveSetupInputSchema.safeParse({ setupName: " ", draft: validDraft })
        .error?.issues[0]?.message,
    ).toBe("Name this setup.");
    expect(
      saveSetupInputSchema.safeParse({
        setupName: "Saturday Social",
        draft: { ...validDraft, plannedEnd: validDraft.plannedStart },
      }).success,
    ).toBe(false);
  });

  it("names the courts an applied setup had to leave out", () => {
    expect(courtsLeftOutNotice([])).toBeNull();
    expect(courtsLeftOutNotice(["Court 5"])).toBe(
      "Court 5 is no longer available and was left out.",
    );
    expect(courtsLeftOutNotice(["Court 4", "Court 5", "Court 6"])).toBe(
      "Court 4, Court 5 and Court 6 are no longer available and were left out.",
    );
  });
});
