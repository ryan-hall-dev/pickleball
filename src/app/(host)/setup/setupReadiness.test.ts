// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  setupReadiness,
  unfinishedGuestFormMessage,
  type SetupReadinessInput,
} from "./setupReadiness";
import { EMPTY_GUEST_FORM } from "./whosPlaying";

const readyInput: SetupReadinessInput = {
  fieldErrors: {},
  selectedCourtCount: 2,
  matchFormat: "doubles",
  attendingPlayerCount: 10,
  guestForm: EMPTY_GUEST_FORM,
  isDraftSaved: true,
};

function stepStates(input: Partial<SetupReadinessInput>) {
  return Object.fromEntries(
    setupReadiness({ ...readyInput, ...input }).steps.map((step) => [
      step.key,
      step.state,
    ]),
  );
}

describe("setupReadiness", () => {
  it("is ready when every step is done", () => {
    const readiness = setupReadiness(readyInput);
    expect(readiness.isReadyToStart).toBe(true);
    expect(readiness.steps.map((step) => [step.label, step.state])).toEqual([
      ["Details", "done"],
      ["Courts", "done"],
      ["Players", "done"],
      ["Rotation", "done"],
      ["Review & start", "ready"],
    ]);
    expect(readiness.checklist).toEqual([
      { isDone: true, text: "Session details complete" },
      { isDone: true, text: "Enough players for all 2 courts" },
    ]);
  });

  it("with no members attending, Players hasn't started and START stays off", () => {
    const readiness = setupReadiness({
      ...readyInput,
      attendingPlayerCount: 0,
    });
    expect(readiness.isReadyToStart).toBe(false);
    expect(stepStates({ attendingPlayerCount: 0 })).toMatchObject({
      players: "notStarted",
      review: "notStarted",
    });
    expect(readiness.checklist).toContainEqual({
      isDone: false,
      text: "0 players attending: a doubles court needs 4",
    });
  });

  it("needs 4 players for doubles: 3 is one to fix", () => {
    const readiness = setupReadiness({
      ...readyInput,
      attendingPlayerCount: 3,
    });
    expect(readiness.isReadyToStart).toBe(false);
    expect(readiness.steps[2]).toEqual({
      key: "players",
      label: "Players",
      state: "attention",
      issueCount: 1,
    });
    expect(readiness.checklist).toContainEqual({
      isDone: false,
      text: "3 players attending: a doubles court needs 4",
    });
  });

  it("needs only 2 for singles", () => {
    const readiness = setupReadiness({
      ...readyInput,
      matchFormat: "singles",
      selectedCourtCount: 1,
      attendingPlayerCount: 2,
    });
    expect(readiness.isReadyToStart).toBe(true);
    expect(readiness.checklist).toContainEqual({
      isDone: true,
      text: "Enough players for the court",
    });
    expect(
      setupReadiness({
        ...readyInput,
        matchFormat: "singles",
        attendingPlayerCount: 1,
      }).isReadyToStart,
    ).toBe(false);
  });

  it("can start with fewer players than seats, and says how many courts they fill", () => {
    const readiness = setupReadiness({
      ...readyInput,
      selectedCourtCount: 4,
      attendingPlayerCount: 9,
    });
    expect(readiness.isReadyToStart).toBe(true);
    expect(readiness.checklist).toContainEqual({
      isDone: true,
      text: "9 players attending, enough for 2 of 4 courts",
    });
  });

  it("blocks on an unfinished guest entry and names what's missing", () => {
    const guestForm = { firstName: "Kai", lastName: "", skillLevel: "" };
    const readiness = setupReadiness({ ...readyInput, guestForm });
    expect(readiness.isReadyToStart).toBe(false);
    expect(readiness.steps[2]).toMatchObject({
      state: "attention",
      issueCount: 1,
    });
    expect(readiness.checklist).toContainEqual({
      isDone: false,
      text: "Guest form has an unfinished entry: add Kai's last name or clear it",
    });
    // With too few players too, both count.
    expect(
      setupReadiness({ ...readyInput, guestForm, attendingPlayerCount: 0 })
        .steps[2],
    ).toMatchObject({ state: "attention", issueCount: 2 });
  });

  it("words other unfinished guest entries generically", () => {
    expect(
      unfinishedGuestFormMessage({
        firstName: "",
        lastName: "Lee",
        skillLevel: "",
      }),
    ).toBe("Guest form has an unfinished entry: add the guest or clear it");
    expect(
      unfinishedGuestFormMessage({
        firstName: "",
        lastName: "",
        skillLevel: "beginner",
      }),
    ).toBe("Guest form has an unfinished entry: add the guest or clear it");
    expect(
      setupReadiness({
        ...readyInput,
        guestForm: { firstName: "  ", lastName: "", skillLevel: "" },
      }).isReadyToStart,
    ).toBe(true);
  });

  it("asks for a court when none is chosen", () => {
    const readiness = setupReadiness({ ...readyInput, selectedCourtCount: 0 });
    expect(readiness.isReadyToStart).toBe(false);
    expect(stepStates({ selectedCourtCount: 0 }).courts).toBe("notStarted");
    expect(readiness.checklist).toContainEqual({
      isDone: false,
      text: "Add at least one court",
    });
    expect(readiness.checklist).toContainEqual({
      isDone: true,
      text: "10 players attending",
    });
  });

  it("counts invalid details and court errors as things to fix", () => {
    const readiness = setupReadiness({
      ...readyInput,
      fieldErrors: {
        name: "Enter a session name.",
        endTime: "A session can last at most 12 hours.",
      },
    });
    expect(readiness.isReadyToStart).toBe(false);
    expect(readiness.steps[0]).toMatchObject({
      state: "attention",
      issueCount: 2,
    });
    expect(readiness.checklist[0]).toEqual({
      isDone: false,
      text: "Session details: 2 fields to fix",
    });
    expect(
      stepStates({ fieldErrors: { courts: "A court is listed twice." } })
        .courts,
    ).toBe("attention");
  });

  it("only enables START once the complete setup is saved", () => {
    const unsaved = setupReadiness({ ...readyInput, isDraftSaved: false });
    expect(unsaved.isSetupComplete).toBe(true);
    expect(unsaved.isReadyToStart).toBe(false);
    expect(unsaved.steps.at(-1)?.state).toBe("ready");
    expect(
      setupReadiness({ ...readyInput, attendingPlayerCount: 0 })
        .isSetupComplete,
    ).toBe(false);
  });

  it("a brand-new draft: details done, the rest not started", () => {
    expect(
      stepStates({
        selectedCourtCount: 0,
        attendingPlayerCount: 0,
      }),
    ).toEqual({
      details: "done",
      courts: "notStarted",
      players: "notStarted",
      rotation: "done",
      review: "notStarted",
    });
  });
});
