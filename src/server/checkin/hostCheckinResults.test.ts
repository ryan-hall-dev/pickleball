// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  approvedCheckinFromRpc,
  hostCheckinRefusalFromError,
  pendingCheckinRequestsFromRpc,
  wasRejectedBeforeFromRpc,
} from "./hostCheckinResults";

const REQUEST_ID = "a0000000-0000-4000-8000-000000000001";
const PARTICIPANT_ID = "e0000000-0000-4000-8000-000000000001";

describe("pendingCheckinRequestsFromRpc", () => {
  it("maps the tray rows with the name-clash flag", () => {
    expect(
      pendingCheckinRequestsFromRpc([
        {
          id: REQUEST_ID,
          created_at: "2026-11-07T18:00:00+00:00",
          first_name: "Grace",
          last_name: "Kim",
          skill_level: "beginner",
          is_name_already_in_session: true,
        },
      ]),
    ).toEqual([
      {
        checkinRequestId: REQUEST_ID,
        createdAt: "2026-11-07T18:00:00+00:00",
        firstName: "Grace",
        lastName: "Kim",
        skillLevel: "beginner",
        isNameAlreadyInSession: true,
      },
    ]);
  });

  it("fails fast on an unexpected shape", () => {
    expect(() =>
      pendingCheckinRequestsFromRpc([{ id: REQUEST_ID, created_at: "soon" }]),
    ).toThrow();
    expect(() =>
      pendingCheckinRequestsFromRpc([
        {
          id: REQUEST_ID,
          created_at: "2026-11-07T18:00:00+00:00",
          first_name: "Grace",
          last_name: "Kim",
          // Every request has a level since 20261112090000.
          skill_level: null,
          is_name_already_in_session: false,
        },
      ]),
    ).toThrow();
  });
});

describe("approvedCheckinFromRpc", () => {
  it("reads a fresh approval and an earlier one", () => {
    expect(
      approvedCheckinFromRpc({
        status: "approved",
        session_participant_id: PARTICIPANT_ID,
        event: null,
      }),
    ).toEqual({ participantId: PARTICIPANT_ID, wasApprovedBefore: false });
    expect(
      approvedCheckinFromRpc({
        status: "already_approved",
        session_participant_id: PARTICIPANT_ID,
      }),
    ).toEqual({ participantId: PARTICIPANT_ID, wasApprovedBefore: true });
  });
});

describe("reject answers", () => {
  it("tells a fresh decision from an earlier one", () => {
    expect(wasRejectedBeforeFromRpc({ status: "rejected" })).toBe(false);
    expect(wasRejectedBeforeFromRpc({ status: "already_rejected" })).toBe(true);
  });

  it("fails fast on an unexpected status", () => {
    expect(() => wasRejectedBeforeFromRpc({ status: "closed" })).toThrow();
    expect(() => wasRejectedBeforeFromRpc({})).toThrow();
  });
});

describe("hostCheckinRefusalFromError", () => {
  it.each([
    ["NAME_ALREADY_IN_SESSION", "name_already_in_session"],
    ["CHECKIN_REQUEST_NOT_PENDING", "already_decided"],
    ["CHECKIN_REQUEST_NOT_FOUND", "already_decided"],
    ["ALREADY_IN_SESSION", null],
    ["SESSION_CLOSED", null],
    ["EVENT_REQUIRED", null],
    ["NOT_A_HOST", null],
  ])("%s → %s", (message, refusal) => {
    expect(hostCheckinRefusalFromError({ message })).toBe(refusal);
  });
});
