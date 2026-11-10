// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  approvedCheckinFromRpc,
  hostCheckinRefusalFromError,
  pendingCheckinRequestsFromRpc,
  wasClosedBeforeFromRpc,
  wasRejectedBeforeFromRpc,
} from "./hostCheckinResults";

const REQUEST_ID = "a0000000-0000-4000-8000-000000000001";
const MEMBER_ID = "b0000000-0000-4000-8000-000000000001";
const PARTICIPANT_ID = "e0000000-0000-4000-8000-000000000001";

describe("pendingCheckinRequestsFromRpc", () => {
  it("maps the tray rows, keeping nullable levels and members", () => {
    expect(
      pendingCheckinRequestsFromRpc([
        {
          id: REQUEST_ID,
          created_at: "2026-11-07T18:00:00+00:00",
          member_id: MEMBER_ID,
          first_name: "Grace",
          last_name: "Kim",
          skill_level: null,
          saved_skill_level: "beginner",
          is_already_attending: true,
          is_possible_duplicate: false,
        },
      ]),
    ).toEqual([
      {
        checkinRequestId: REQUEST_ID,
        createdAt: "2026-11-07T18:00:00+00:00",
        memberId: MEMBER_ID,
        firstName: "Grace",
        lastName: "Kim",
        requestedSkillLevel: null,
        savedSkillLevel: "beginner",
        isAlreadyAttending: true,
        isPossibleDuplicate: false,
      },
    ]);
  });

  it("fails fast on an unexpected shape", () => {
    expect(() =>
      pendingCheckinRequestsFromRpc([{ id: REQUEST_ID, created_at: "soon" }]),
    ).toThrow();
  });
});

describe("approvedCheckinFromRpc", () => {
  it("reads a fresh approval and an earlier one", () => {
    expect(
      approvedCheckinFromRpc({
        status: "approved",
        member_id: MEMBER_ID,
        session_participant_id: PARTICIPANT_ID,
        event: null,
      }),
    ).toEqual({ participantId: PARTICIPANT_ID, wasApprovedBefore: false });
    expect(
      approvedCheckinFromRpc({
        status: "already_approved",
        member_id: MEMBER_ID,
        session_participant_id: PARTICIPANT_ID,
      }),
    ).toEqual({ participantId: PARTICIPANT_ID, wasApprovedBefore: true });
  });
});

describe("reject and close answers", () => {
  it("tells a fresh decision from an earlier one", () => {
    expect(wasRejectedBeforeFromRpc({ status: "rejected" })).toBe(false);
    expect(wasRejectedBeforeFromRpc({ status: "already_rejected" })).toBe(true);
    expect(wasClosedBeforeFromRpc({ status: "closed" })).toBe(false);
    expect(wasClosedBeforeFromRpc({ status: "already_closed" })).toBe(true);
  });

  it("fails fast on an unexpected status", () => {
    expect(() => wasRejectedBeforeFromRpc({ status: "closed" })).toThrow();
    expect(() => wasClosedBeforeFromRpc({})).toThrow();
  });
});

describe("hostCheckinRefusalFromError", () => {
  it.each([
    ["ALREADY_IN_SESSION", "already_in_session"],
    ["NOT_ALREADY_IN_SESSION", "not_already_in_session"],
    ["CHECKIN_REQUEST_NOT_PENDING", "already_decided"],
    ["CHECKIN_REQUEST_NOT_FOUND", "already_decided"],
    ["SESSION_CLOSED", null],
    ["EVENT_REQUIRED", null],
    ["NOT_A_HOST", null],
  ])("%s → %s", (message, refusal) => {
    expect(hostCheckinRefusalFromError({ message })).toBe(refusal);
  });
});
