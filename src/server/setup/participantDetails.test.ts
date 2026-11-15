// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/currentHost", () => ({
  authorizeCurrentHost: mocks.authorize,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: mocks.rpc }),
}));
import { setDraftParticipantDetails } from "./setupActions";

const input = {
  sessionId: "a0000000-0000-4000-8000-000000000001",
  participantId: "b0000000-0000-4000-8000-000000000001",
  gender: "female" as const,
  skillLevel: "advanced" as const,
  expectedDraftRevision: 7,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({
    ok: true,
    host: { userId: "actor", socialId: "social", role: "host" },
  });
  mocks.rpc.mockReturnValue({
    abortSignal: async () => ({
      data: { status: "saved", draftRevision: 8 },
      error: null,
    }),
  });
});

describe("complete historical draft participant details", () => {
  it("verifies host access before touching the write client", async () => {
    mocks.authorize.mockResolvedValue({ ok: false, reason: "SIGNED_OUT" });
    expect(await setDraftParticipantDetails(input)).toMatchObject({
      ok: false,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("sends only explicit details and the expected revision with the verified actor", async () => {
    expect(await setDraftParticipantDetails(input)).toEqual({
      ok: true,
      draftRevision: 8,
    });
    expect(mocks.authorize).toHaveBeenCalledWith("host");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "set_draft_participant_details",
      {
        p_actor_user_id: "actor",
        p_session_id: input.sessionId,
        p_participant_id: input.participantId,
        p_gender: "female",
        p_skill_level: "advanced",
        p_expected_draft_revision: 7,
      },
    );
  });
  it.each([
    { gender: undefined },
    { gender: null },
    { gender: "" },
    { skillLevel: null },
    { expectedDraftRevision: -1 },
  ])(
    "refuses missing/invalid details without guessing: %j",
    async (invalid) => {
      const result = await setDraftParticipantDetails({
        ...input,
        ...invalid,
      } as typeof input);
      expect(result.ok).toBe(false);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("reports a co-host revision conflict without retrying or claiming persistence", async () => {
    mocks.rpc.mockReturnValue({
      abortSignal: async () => ({
        data: null,
        error: { message: "DRAFT_CHANGED_ELSEWHERE" },
      }),
    });
    expect(await setDraftParticipantDetails(input)).toMatchObject({
      ok: false,
      isConflict: true,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("reports a failed network write", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.rpc.mockReturnValue({
      abortSignal: async () => {
        throw new Error("offline");
      },
    });
    expect(await setDraftParticipantDetails(input)).toMatchObject({
      ok: false,
    });
    log.mockRestore();
  });
});
