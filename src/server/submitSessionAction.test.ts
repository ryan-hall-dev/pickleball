// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeConfig,
  makeParticipants,
} from "@/engine/session/testing/fixtures";
import type { SessionConfig } from "@/engine/session";
const mocks = vi.hoisted(() => ({
  loadLog: vi.fn(),
  rpc: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./sessionLog", () => ({ loadSessionLog: mocks.loadLog }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: mocks.rpc }),
}));
import { submitSessionAction } from "./submitSessionAction";
import type { DatabaseClient } from "./sessionLog";

const sessionId = "a0000000-0000-4000-8000-000000000001";
const eventId = "b0000000-0000-4000-8000-000000000001";
// Only auth is used directly; reads go through the mocked log boundary.
const userClient = {
  auth: { getUser: mocks.getUser },
} as unknown as DatabaseClient;
function config(simple: boolean): SessionConfig {
  const participants = makeParticipants(4).map((player) => ({
    ...player,
    skill: "intermediate" as const,
    gender: "female" as const,
  }));
  return {
    ...makeConfig({ participants, courts: 1 }),
    ...(simple ? { policyVersion: "simple-social-v1" as const } : {}),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadLog.mockResolvedValue({ sessionId, status: "draft", events: [] });
  mocks.getUser.mockResolvedValue({
    data: { user: { id: "verified-actor" } },
    error: null,
  });
  mocks.rpc.mockResolvedValue({
    data: { status: "appended", seq: 1, occurred_at: "2026-11-15T10:00:00Z" },
    error: null,
  });
});
describe("start-session draft revision boundary", () => {
  it.each([true, false])(
    "forwards revision only under the simple policy: %s",
    async (simple) => {
      const sessionConfig = config(simple);
      const result = await submitSessionAction(
        userClient,
        {
          sessionId,
          eventId,
          expectedLastSeq: 0,
          expectedDraftRevision: 7,
          request: {
            kind: "action",
            action: {
              type: "SessionStarted",
              payload: {
                config: sessionConfig,
                initialAttendeeIds: sessionConfig.participants.map(
                  (player) => player.participantId,
                ),
              },
            },
          },
        },
        { now: () => Date.parse("2026-11-15T10:00:00Z") },
      );
      expect(result.ok).toBe(true);
      const [name, args] = mocks.rpc.mock.calls[0];
      expect(name).toBe("start_session");
      if (simple) expect(args.p_expected_draft_revision).toBe(7);
      else expect(args).not.toHaveProperty("p_expected_draft_revision");
    },
  );
  it.each(["DRAFT_CHANGED_ELSEWHERE", "STALE_DRAFT_ROSTER"])(
    "returns a reload conflict for %s",
    async (message) => {
      mocks.rpc.mockResolvedValue({ data: null, error: { message } });
      const sessionConfig = config(true);
      const result = await submitSessionAction(
        userClient,
        {
          sessionId,
          eventId,
          expectedLastSeq: 0,
          expectedDraftRevision: 7,
          request: {
            kind: "action",
            action: {
              type: "SessionStarted",
              payload: {
                config: sessionConfig,
                initialAttendeeIds: sessionConfig.participants.map(
                  (player) => player.participantId,
                ),
              },
            },
          },
        },
        { now: () => Date.parse("2026-11-15T10:00:00Z") },
      );
      expect(result).toEqual({ ok: false, reason: "UPDATED_BY_ANOTHER_HOST" });
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
    },
  );
});
