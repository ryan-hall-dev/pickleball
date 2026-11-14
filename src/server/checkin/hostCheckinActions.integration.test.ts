// @vitest-environment node
// The host pending check-in tray's server actions against the LOCAL Supabase
// stack (`pnpm db:start`), after session-only participants (20261112090000):
// the list shows only the host's own social's open session's pending
// requests, oldest first, flagging names already in the session (case,
// accents and spacing ignored); approve adds the participant from the
// request and returns it; a name already in the session is refused and the
// request stays pending, including when two approvals of same-named
// requests race; reject is idempotent; a second host deciding the same
// request is told another host decided first; another social's host can
// neither list nor decide anything here. Requests are inserted with the secret key as a phone
// would leave them (submit_checkin is covered by checkinActions tests).
// Skips when the stack isn't running, unless REQUIRE_LOCAL_SUPABASE=1.
// Everything deletable is removed afterwards.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";
import type { SkillLevel } from "@/server/skillLevels";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import {
  approveCheckin,
  listPendingCheckins,
  rejectCheckin,
} from "./hostCheckinActions";
import type { PendingCheckinRequest } from "./hostCheckinResults";

type DatabaseClient = SupabaseClient<Database>;

// Next.js resolves these itself; plain Vitest runs the actions outside a request.
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
// The actions act as whoever `actingClient` is signed in as.
let actingClient: DatabaseClient;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => actingClient),
}));

interface LocalStack {
  apiUrl: string;
  publishableKey: string;
  secretKey: string;
}

function findLocalStack(): LocalStack | null {
  try {
    const output = execFileSync(
      "node_modules/.bin/supabase",
      ["status", "-o", "json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 20_000,
      },
    );
    const status = JSON.parse(output.slice(output.indexOf("{"))) as Record<
      string,
      string
    >;
    const apiUrl = status.API_URL;
    if (
      !apiUrl ||
      !["127.0.0.1", "localhost"].includes(new URL(apiUrl).hostname)
    ) {
      return null;
    }
    return {
      apiUrl,
      publishableKey: status.PUBLISHABLE_KEY,
      secretKey: status.SECRET_KEY,
    };
  } catch {
    return null;
  }
}

const localStack = findLocalStack();
if (!localStack && process.env.REQUIRE_LOCAL_SUPABASE === "1") {
  throw new Error(
    "REQUIRE_LOCAL_SUPABASE=1 but the local Supabase stack is not reachable (`pnpm exec supabase status` failed).",
  );
}
if (!localStack) {
  console.warn(
    "Skipping host check-in integration tests: the local Supabase stack is not running (start it with `pnpm db:start`).",
  );
}

function randomSha256Hex(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

interface TestHost {
  client: DatabaseClient;
  userId: string;
}

interface TestSocial {
  socialId: string;
  sessionId: string;
}

describe.skipIf(!localStack)(
  "host check-in tray actions (local Supabase)",
  () => {
    let admin: DatabaseClient;
    const createdUserIds: string[] = [];
    const createdSocialIds: string[] = [];
    // Alice (manager) and Ana (host) run Riverside; Omar manages another social.
    let managerAlice: TestHost;
    let hostAna: TestHost;
    let otherManagerOmar: TestHost;
    let riverside: TestSocial;
    let otherSocial: TestSocial;
    let minutesAgo = 60;

    async function signedInHost(
      displayName: string,
      role: "host" | "manager",
      socialId: string,
    ): Promise<TestHost> {
      const email = `integration-tray-${randomUUID()}@example.test`;
      const password = `pw-${randomUUID()}`;
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created.error) throw created.error;
      const userId = created.data.user.id;
      createdUserIds.push(userId);
      const { error } = await admin.from("hosts").insert({
        user_id: userId,
        display_name: displayName,
        role,
        social_id: socialId,
      });
      if (error) throw error;
      const client = createClient<Database>(
        localStack!.apiUrl,
        localStack!.publishableKey,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      const signIn = await client.auth.signInWithPassword({ email, password });
      if (signIn.error) throw signIn.error;
      return { client, userId };
    }

    async function createSocialWithDraft(
      name: string,
      managerName: string,
    ): Promise<TestSocial & { manager: TestHost }> {
      const { data: social, error } = await admin
        .from("socials")
        .insert({ name })
        .select("id")
        .single();
      if (error) throw error;
      createdSocialIds.push(social.id);
      const manager = await signedInHost(managerName, "manager", social.id);
      const plannedStart = new Date(Date.now() + 30 * 60_000);
      const { data: session, error: sessionError } = await admin
        .from("sessions")
        .insert({
          social_id: social.id,
          host_id: manager.userId,
          name: `${name} session`,
          host_name: managerName,
          planned_start: plannedStart.toISOString(),
          planned_end: new Date(
            plannedStart.getTime() + 120 * 60_000,
          ).toISOString(),
          config_snapshot: {},
        })
        .select("id")
        .single();
      if (sessionError) throw sessionError;
      return { socialId: social.id, sessionId: session.id, manager };
    }

    /** A pending request as a phone leaves it, each a minute newer than the last. */
    async function insertRequest(
      social: TestSocial,
      request: { firstName: string; lastName: string; skillLevel: SkillLevel },
    ): Promise<{ checkinRequestId: string }> {
      minutesAgo -= 1;
      const { data, error } = await admin
        .from("checkin_requests")
        .insert({
          social_id: social.socialId,
          session_id: social.sessionId,
          first_name: request.firstName,
          last_name: request.lastName,
          skill_level: request.skillLevel,
          device_token_hash: randomSha256Hex(),
          ip_hash: randomSha256Hex(),
          created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        })
        .select("id")
        .single();
      if (error) throw error;
      return { checkinRequestId: data.id };
    }

    async function addDraftPlayer(
      firstName: string,
      lastName: string,
      skillLevel: SkillLevel,
    ) {
      const { error } = await admin.rpc("add_draft_participant", {
        p_actor_user_id: managerAlice.userId,
        p_session_id: riverside.sessionId,
        p_session_participant_id: randomUUID(),
        p_first_name: firstName,
        p_last_name: lastName,
        p_skill_level: skillLevel,
      });
      if (error) throw error;
    }

    async function requestRow(checkinRequestId: string) {
      const { data, error } = await admin
        .from("checkin_requests")
        .select("status, decided_by, session_participant_id")
        .eq("id", checkinRequestId)
        .single();
      if (error) throw error;
      return data;
    }

    async function attendeeCount(social: TestSocial): Promise<number> {
      const { count, error } = await admin
        .from("session_participants")
        .select("id", { count: "exact", head: true })
        .eq("session_id", social.sessionId);
      if (error) throw error;
      return count ?? 0;
    }

    async function listAs(host: TestHost): Promise<PendingCheckinRequest[]> {
      actingClient = host.client;
      const result = await listPendingCheckins();
      if (!result.ok) throw new Error("listing pending check-ins failed");
      return result.requests;
    }

    function requestFor(
      requests: readonly PendingCheckinRequest[],
      checkinRequestId: string,
    ): PendingCheckinRequest | undefined {
      return requests.find(
        (request) => request.checkinRequestId === checkinRequestId,
      );
    }

    // Riverside's players and requests, set up once.
    let peterRequest: { checkinRequestId: string };
    let newPlayerRequest: { checkinRequestId: string };
    let likeAttendingRequest: { checkinRequestId: string };
    let likeHostAddedRequest: { checkinRequestId: string };
    let rejectedRequestId: string;
    let otherSocialRequestId: string;

    beforeAll(async () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", localStack!.apiUrl);
      vi.stubEnv(
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        localStack!.publishableKey,
      );
      vi.stubEnv("SUPABASE_SECRET_KEY", localStack!.secretKey);
      vi.spyOn(console, "error").mockImplementation(() => {});
      admin = createClient<Database>(
        localStack!.apiUrl,
        localStack!.secretKey,
        {
          auth: { persistSession: false, autoRefreshToken: false },
        },
      );

      const riversideWithManager = await createSocialWithDraft(
        "Integration tray Riverside",
        "Alice Tray",
      );
      riverside = riversideWithManager;
      managerAlice = riversideWithManager.manager;
      hostAna = await signedInHost("Ana Tray", "host", riverside.socialId);
      const otherWithManager = await createSocialWithDraft(
        "Integration tray other",
        "Omar Tray",
      );
      otherSocial = otherWithManager;
      otherManagerOmar = otherWithManager.manager;

      // Grace Kim and Kai Moreno are already playing (added by a host).
      await addDraftPlayer("Grace", "Kim", "beginner");
      await addDraftPlayer("Kai", "Moreno", "beginner");

      peterRequest = await insertRequest(riverside, {
        firstName: "Peter",
        lastName: "Lindqvist",
        skillLevel: "intermediate",
      });
      newPlayerRequest = await insertRequest(riverside, {
        firstName: "Zoe",
        lastName: "Park",
        skillLevel: "advanced",
      });
      likeAttendingRequest = await insertRequest(riverside, {
        firstName: "GRACE",
        lastName: "kim",
        skillLevel: "beginner",
      });
      likeHostAddedRequest = await insertRequest(riverside, {
        firstName: "Kái",
        lastName: "moreno",
        skillLevel: "intermediate",
      });
      rejectedRequestId = (
        await insertRequest(riverside, {
          firstName: "Old",
          lastName: "Rejected",
          skillLevel: "beginner",
        })
      ).checkinRequestId;
      const { error: rejectError } = await admin.rpc("reject_checkin", {
        p_actor_user_id: managerAlice.userId,
        p_checkin_request_id: rejectedRequestId,
      });
      if (rejectError) throw rejectError;
      otherSocialRequestId = (
        await insertRequest(otherSocial, {
          firstName: "Olga",
          lastName: "Other",
          skillLevel: "beginner",
        })
      ).checkinRequestId;
    });

    afterAll(async () => {
      // Test-only cleanup with the secret key; the app never deletes these.
      await admin.from("hosts").delete().in("user_id", createdUserIds);
      for (const userId of createdUserIds) {
        await admin.auth.admin.deleteUser(userId);
      }
      await deleteTestSocials(admin, createdSocialIds);
      vi.unstubAllEnvs();
    });

    // Order matters below: the list is checked before any decision.
    it("lists only the social's open session's pending requests, oldest first, flagging names already in the session", async () => {
      const requests = await listAs(hostAna);
      expect(requests.map((request) => request.checkinRequestId)).toEqual([
        peterRequest.checkinRequestId,
        newPlayerRequest.checkinRequestId,
        likeAttendingRequest.checkinRequestId,
        likeHostAddedRequest.checkinRequestId,
      ]);
      expect(requestFor(requests, peterRequest.checkinRequestId)).toEqual({
        checkinRequestId: peterRequest.checkinRequestId,
        createdAt: expect.any(String),
        firstName: "Peter",
        lastName: "Lindqvist",
        skillLevel: "intermediate",
        isNameAlreadyInSession: false,
      });
      expect(
        requestFor(requests, newPlayerRequest.checkinRequestId)
          ?.isNameAlreadyInSession,
      ).toBe(false);
      // Case and accents folded.
      expect(
        requestFor(requests, likeAttendingRequest.checkinRequestId)
          ?.isNameAlreadyInSession,
      ).toBe(true);
      expect(
        requestFor(requests, likeHostAddedRequest.checkinRequestId)
          ?.isNameAlreadyInSession,
      ).toBe(true);
      expect(requestFor(requests, rejectedRequestId)).toBeUndefined();
      expect(requestFor(requests, otherSocialRequestId)).toBeUndefined();
    });

    it("lets another social's host neither see nor decide this social's requests", async () => {
      const omarSees = await listAs(otherManagerOmar);
      expect(omarSees.map((request) => request.checkinRequestId)).toEqual([
        otherSocialRequestId,
      ]);
      actingClient = otherManagerOmar.client;
      const attendeesBefore = await attendeeCount(riverside);
      expect(await approveCheckin(peterRequest.checkinRequestId)).toEqual({
        kind: "already_decided",
      });
      expect(await rejectCheckin(peterRequest.checkinRequestId)).toEqual({
        kind: "already_decided",
      });
      expect((await requestRow(peterRequest.checkinRequestId)).status).toBe(
        "pending",
      );
      expect(await attendeeCount(riverside)).toBe(attendeesBefore);
    });

    it("refuses to approve a name already in the session and leaves the request pending", async () => {
      actingClient = hostAna.client;
      const attendeesBefore = await attendeeCount(riverside);
      expect(
        await approveCheckin(likeAttendingRequest.checkinRequestId),
      ).toEqual({ kind: "name_already_in_session" });
      expect(await requestRow(likeAttendingRequest.checkinRequestId)).toEqual({
        status: "pending",
        decided_by: null,
        session_participant_id: null,
      });
      expect(await attendeeCount(riverside)).toBe(attendeesBefore);
    });

    it("approves a request: the participant is made from its name and level and returned", async () => {
      actingClient = hostAna.client;
      const result = await approveCheckin(peterRequest.checkinRequestId);
      if (result.kind !== "approved" || !result.participant) {
        throw new Error(`expected an approval, got ${JSON.stringify(result)}`);
      }
      expect(result.participant).toEqual({
        participantId: expect.any(String),
        firstName: "Peter",
        lastName: "Lindqvist",
        skillLevel: "intermediate",
      });
      expect(await requestRow(peterRequest.checkinRequestId)).toEqual({
        status: "approved",
        decided_by: hostAna.userId,
        session_participant_id: result.participant.participantId,
      });
    });

    it("tells the second host that another host decided first, and the same host that it's done", async () => {
      actingClient = managerAlice.client;
      expect(await approveCheckin(peterRequest.checkinRequestId)).toEqual({
        kind: "already_decided",
      });
      expect(await rejectCheckin(peterRequest.checkinRequestId)).toEqual({
        kind: "already_decided",
      });
      // Ana's own retry after a lost answer: the same attendee again.
      actingClient = hostAna.client;
      const retried = await approveCheckin(peterRequest.checkinRequestId);
      expect(retried).toMatchObject({
        kind: "approved",
        participant: { firstName: "Peter", lastName: "Lindqvist" },
      });
    });

    it("approves a request once when two approvals of it race", async () => {
      actingClient = hostAna.client;
      const attendeesBefore = await attendeeCount(riverside);
      const results = await Promise.all([
        approveCheckin(newPlayerRequest.checkinRequestId),
        approveCheckin(newPlayerRequest.checkinRequestId),
      ]);
      expect(results.map((result) => result.kind)).toEqual([
        "approved",
        "approved",
      ]);
      expect(await attendeeCount(riverside)).toBe(attendeesBefore + 1);
      expect((await requestRow(newPlayerRequest.checkinRequestId)).status).toBe(
        "approved",
      );
      expect(results[0]).toMatchObject({
        participant: { firstName: "Zoe", lastName: "Park" },
      });
    });

    it("adds exactly one player when approvals of two same-named requests race", async () => {
      const firstTwin = await insertRequest(riverside, {
        firstName: "Pat",
        lastName: "Twin",
        skillLevel: "beginner",
      });
      const secondTwin = await insertRequest(riverside, {
        firstName: "PAT",
        lastName: "twin",
        skillLevel: "advanced",
      });
      // Two concurrent database transactions (the session lock serialises
      // them; the unique name index is the backstop).
      actingClient = hostAna.client;
      const results = await Promise.all([
        approveCheckin(firstTwin.checkinRequestId),
        approveCheckin(secondTwin.checkinRequestId),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual([
        "approved",
        "name_already_in_session",
      ]);
      const { data: twins, error } = await admin
        .from("session_participants")
        .select("id")
        .eq("session_id", riverside.sessionId)
        .ilike("first_name", "pat")
        .ilike("last_name", "twin");
      if (error) throw error;
      expect(twins).toHaveLength(1);
      const statuses = [
        (await requestRow(firstTwin.checkinRequestId)).status,
        (await requestRow(secondTwin.checkinRequestId)).status,
      ].sort();
      expect(statuses).toEqual(["approved", "pending"]);
    });

    it("adds one participant when a host-add races approval of the same normalised name", async () => {
      const { checkinRequestId } = await insertRequest(riverside, {
        firstName: "Renée",
        lastName: "Race Person",
        skillLevel: "beginner",
      });
      const participantIds = [randomUUID(), randomUUID()];
      const results = await Promise.all([
        admin.rpc("add_draft_participant", {
          p_actor_user_id: managerAlice.userId,
          p_session_id: riverside.sessionId,
          p_session_participant_id: participantIds[0],
          p_first_name: "RENEE",
          p_last_name: " race   person ",
          p_skill_level: "advanced",
        }),
        admin.rpc("approve_checkin", {
          p_actor_user_id: hostAna.userId,
          p_checkin_request_id: checkinRequestId,
          p_session_participant_id: participantIds[1],
        }),
      ]);
      expect(results.filter((result) => !result.error)).toHaveLength(1);
      expect(
        results
          .filter((result) => result.error)
          .map((result) => result.error?.message),
      ).toEqual(["NAME_ALREADY_IN_SESSION"]);
      const { data, error } = await admin
        .from("session_participants")
        .select("id")
        .eq("session_id", riverside.sessionId)
        .in("id", participantIds);
      if (error) throw error;
      expect(data).toHaveLength(1);
      expect(await requestRow(checkinRequestId)).toMatchObject({
        status: results[1].error ? "pending" : "approved",
        session_participant_id: results[1].error ? null : participantIds[1],
      });
    });

    it("rejects (idempotent) and the request leaves the list", async () => {
      actingClient = managerAlice.client;
      const { checkinRequestId } = likeAttendingRequest;
      expect(await rejectCheckin(checkinRequestId)).toEqual({
        kind: "rejected",
      });
      expect(await rejectCheckin(checkinRequestId)).toEqual({
        kind: "rejected",
      });
      expect(await requestRow(checkinRequestId)).toMatchObject({
        status: "rejected",
        decided_by: managerAlice.userId,
      });
      const remaining = await listAs(managerAlice);
      expect(
        remaining.some(
          (request) => request.checkinRequestId === checkinRequestId,
        ),
      ).toBe(false);
      expect(
        remaining.some(
          (request) =>
            request.checkinRequestId === likeHostAddedRequest.checkinRequestId,
        ),
      ).toBe(true);
    });

    it("tells the second host to reject a request that another host decided first", async () => {
      const twiceRejected = await insertRequest(riverside, {
        firstName: "Twice",
        lastName: "Rejected",
        skillLevel: "beginner",
      });
      actingClient = managerAlice.client;
      expect(await rejectCheckin(twiceRejected.checkinRequestId)).toEqual({
        kind: "rejected",
      });
      actingClient = hostAna.client;
      expect(await rejectCheckin(twiceRejected.checkinRequestId)).toEqual({
        kind: "already_decided",
      });
      expect(await requestRow(twiceRejected.checkinRequestId)).toMatchObject({
        status: "rejected",
        decided_by: managerAlice.userId,
      });
    });

    it("answers a malformed request id as a failure without calling the database", async () => {
      actingClient = hostAna.client;
      expect(await approveCheckin("not-a-uuid")).toEqual({ kind: "failed" });
      expect(await rejectCheckin(42)).toEqual({ kind: "failed" });
    });

    it("refuses every action to a signed-out visitor", async () => {
      actingClient = createClient<Database>(
        localStack!.apiUrl,
        localStack!.publishableKey,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      expect(await listPendingCheckins()).toEqual({ ok: false });
      expect(
        await approveCheckin(likeHostAddedRequest.checkinRequestId),
      ).toEqual({ kind: "failed" });
      expect(
        (await requestRow(likeHostAddedRequest.checkinRequestId)).status,
      ).toBe("pending");
    });
  },
);
