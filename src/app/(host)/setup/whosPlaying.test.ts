// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import {
  applyAttendanceChange,
  pruneFailuresTouchedBy,
  validateParticipantForm,
  type AttendanceFailure,
} from "./whosPlaying";

const kai: DraftParticipant = {
  participantId: "p-kai",
  firstName: "Kai",
  lastName: "Lee",
  skillLevel: "intermediate",
};
const grace: DraftParticipant = {
  participantId: "p-grace",
  firstName: "Grace",
  lastName: "Kim",
  skillLevel: "advanced",
};

describe("applyAttendanceChange", () => {
  it("adds a player at the end of the list", () => {
    const after = applyAttendanceChange([kai], {
      kind: "addParticipant",
      participantId: "pending-1",
      participant: {
        firstName: "Ben",
        lastName: "Ode",
        skillLevel: "beginner",
      },
    });
    expect(after).toEqual([
      kai,
      {
        participantId: "pending-1",
        firstName: "Ben",
        lastName: "Ode",
        skillLevel: "beginner",
      },
    ]);
  });

  it("removes any player by participant id", () => {
    expect(
      applyAttendanceChange([kai, grace], {
        kind: "removeParticipant",
        participantId: "p-grace",
      }),
    ).toEqual([kai]);
  });

  it("leaves the list alone when the player is already gone", () => {
    expect(
      applyAttendanceChange([kai], {
        kind: "removeParticipant",
        participantId: "p-gone",
      }),
    ).toEqual([kai]);
  });
});

describe("validateParticipantForm", () => {
  it("accepts first name, last name and level, tidying spaces", () => {
    expect(
      validateParticipantForm({
        firstName: "  Kai ",
        lastName: "Lee   Jr",
        skillLevel: "advanced",
      }),
    ).toEqual({
      ok: true,
      participant: {
        firstName: "Kai",
        lastName: "Lee Jr",
        skillLevel: "advanced",
      },
    });
  });

  it("requires both names and a level", () => {
    expect(
      validateParticipantForm({ firstName: " ", lastName: "", skillLevel: "" }),
    ).toEqual({
      ok: false,
      fieldErrors: {
        firstName: "Enter a first name.",
        lastName: "Enter a last name.",
        skillLevel: "Choose a level.",
      },
    });
  });

  it("refuses names that are too long and unknown levels", () => {
    expect(
      validateParticipantForm({
        firstName: "K".repeat(51),
        lastName: "Lee",
        skillLevel: "pro",
      }),
    ).toEqual({
      ok: false,
      fieldErrors: {
        firstName: "Use at most 50 characters.",
        skillLevel: "Choose a level.",
      },
    });
  });
});

describe("pruneFailuresTouchedBy", () => {
  const failed = (
    change: AttendanceFailure["change"],
    description: string,
  ): AttendanceFailure => ({ change, description, message: "Offline" });
  const addKai = failed(
    {
      kind: "addParticipant",
      participantId: "p-kai",
      participant: {
        firstName: "Kai",
        lastName: "Lee",
        skillLevel: "beginner",
      },
    },
    "Adding Kai Lee",
  );
  const removeGrace = failed(
    { kind: "removeParticipant", participantId: "p-grace" },
    "Removing Grace Kim",
  );

  it("keeps failures the later change doesn't touch", () => {
    expect(
      pruneFailuresTouchedBy([addKai, removeGrace], {
        kind: "removeParticipant",
        participantId: "p-other",
      }),
    ).toEqual([addKai, removeGrace]);
  });

  it("drops a failure about the player a later change touches", () => {
    expect(
      pruneFailuresTouchedBy([addKai, removeGrace], {
        kind: "removeParticipant",
        participantId: "p-kai",
      }),
    ).toEqual([removeGrace]);
  });
});
