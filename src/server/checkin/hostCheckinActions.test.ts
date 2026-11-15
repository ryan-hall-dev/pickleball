// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfig, TestSession } from "@/engine/session/testing/fixtures";
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  scope: vi.fn(),
  loadLog: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/currentHost", () => ({
  authorizeCurrentHost: mocks.authorize,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: mocks.rpc, from: mocks.from }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));
vi.mock("@/server/sessionLog", () => ({ loadSessionLog: mocks.loadLog }));
import { approveCheckin } from "./hostCheckinActions";

const requestId = "a0000000-0000-4000-8000-000000000001";
const participantId = "b0000000-0000-4000-8000-000000000001";
const metadata = {
  eventId: "c0000000-0000-4000-8000-000000000001",
  expectedLastSeq: 1,
};
let request: {
  session_id: string;
  first_name: string;
  last_name: string;
  skill_level: "beginner";
  gender: string | null;
  status: string;
};
let sessionStatus: string;
beforeEach(() => {
  vi.clearAllMocks();
  request = {
    session_id: "session",
    first_name: "Test",
    last_name: "Player",
    skill_level: "beginner",
    gender: null,
    status: "pending",
  };
  sessionStatus = "draft";
  mocks.authorize.mockResolvedValue({
    ok: true,
    host: { userId: "actor", socialId: "social" },
  });
  mocks.from.mockImplementation((table) => {
    const result = () => ({
      data:
        table === "checkin_requests"
          ? request
          : table === "sessions"
            ? { status: sessionStatus }
            : {
                id: participantId,
                first_name: "Test",
                last_name: "Player",
                skill_level: "beginner",
                gender: "female",
              },
      error: null,
    });
    const builder = {
      select: () => builder,
      eq: (...args: unknown[]) => {
        mocks.scope(...args);
        return builder;
      },
      abortSignal: () => builder,
      maybeSingle: async () => result(),
      single: async () => result(),
    };
    return builder;
  });
  mocks.rpc.mockReturnValue({
    abortSignal: async () => ({
      data: { status: "approved", session_participant_id: participantId },
      error: null,
    }),
  });
});
describe("host approval details and live prevalidation", () => {
  it("requires host authorization and never writes as an unverified caller", async () => {
    mocks.authorize.mockResolvedValue({ ok: false, reason: "SIGNED_OUT" });
    expect(await approveCheckin(requestId, "female")).toEqual({
      kind: "failed",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("passes the host's explicit legacy selection and scopes all privileged reads", async () => {
    expect(await approveCheckin(requestId, "female")).toMatchObject({
      kind: "approved",
      participant: { gender: "female" },
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "approve_checkin",
      expect.objectContaining({ p_actor_user_id: "actor", p_gender: "female" }),
    );
    expect(
      mocks.scope.mock.calls.filter(([key]) => key === "social_id"),
    ).toHaveLength(3);
    expect(mocks.scope).toHaveBeenCalledWith("social_id", "social");
  });
  it("does not invent an override for an existing gender", async () => {
    request.gender = "male";
    await approveCheckin(requestId);
    expect(mocks.rpc.mock.calls[0][1]).not.toHaveProperty("p_gender");
  });
  it("refuses a live approval without event metadata", async () => {
    sessionStatus = "live";
    expect(await approveCheckin(requestId, "female")).toEqual({
      kind: "failed",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("refuses a stale live sequence before writing", async () => {
    sessionStatus = "live";
    mocks.loadLog.mockResolvedValue({ events: [] });
    expect(await approveCheckin(requestId, "female", metadata)).toEqual({
      kind: "failed",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("validates a live join before forwarding bounded event metadata", async () => {
    sessionStatus = "live";
    const session = new TestSession();
    const config = {
      ...makeConfig(),
      policyVersion: "simple-social-v1" as const,
    };
    config.participants = config.participants.map((player) => ({
      ...player,
      skill: "beginner",
      gender: "female",
    }));
    session.apply("SessionStarted", {
      config,
      initialAttendeeIds: config.participants.map(
        (player) => player.participantId,
      ),
    });
    mocks.loadLog.mockResolvedValue({ events: session.events });
    const now = vi.spyOn(Date, "now").mockReturnValue(session.now);
    try {
      expect(await approveCheckin(requestId, "female", metadata)).toMatchObject(
        { kind: "approved" },
      );
      expect(mocks.rpc).toHaveBeenCalledWith(
        "approve_checkin",
        expect.objectContaining({
          p_event_id: metadata.eventId,
          p_expected_last_seq: 1,
          p_occurred_at: new Date(session.now).toISOString(),
        }),
      );
    } finally {
      now.mockRestore();
    }
  });
});
