// @vitest-environment node
// The host pending check-in tray's server actions against the LOCAL Supabase
// stack (`pnpm db:start`): the list shows only the host's own social's open
// session's pending requests, oldest first, with the already-attending and
// possible-duplicate (D-D: a member or a host-added guest) flags; approve adds
// a member for a first-timer, links the phone and returns the attendee;
// approving an attending member is refused with no phone link; close and
// reject (both idempotent); a second host deciding the same request is told
// another host decided first; another social's host can neither list nor
// decide anything here. Requests are inserted with the secret key as a phone
// would leave them (submit_checkin is covered by checkinActions tests).
// Skips when the stack isn't running, unless REQUIRE_LOCAL_SUPABASE=1.
// Everything deletable is removed afterwards.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";
import type { SkillLevel } from "@/server/members/memberSearch";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import {
  approveCheckin,
  closeCheckinAlreadyCheckedIn,
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

    async function insertMember(
      social: TestSocial,
      firstName: string,
      lastName: string,
      skillLevel: SkillLevel | null,
    ): Promise<string> {
      const { data, error } = await admin
        .from("members")
        .insert({
          social_id: social.socialId,
          first_name: firstName,
          last_name: lastName,
          skill_level: skillLevel,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    }

    /** A pending request as a phone leaves it, each a minute newer than the last. */
    async function insertRequest(
      social: TestSocial,
      request: {
        memberId?: string;
        firstName: string;
        lastName: string;
        skillLevel: SkillLevel | null;
      },
    ): Promise<{ checkinRequestId: string; deviceTokenHash: string }> {
      minutesAgo -= 1;
      const deviceTokenHash = randomSha256Hex();
      const { data, error } = await admin
        .from("checkin_requests")
        .insert({
          social_id: social.socialId,
          session_id: social.sessionId,
          member_id: request.memberId ?? null,
          first_name: request.firstName,
          last_name: request.lastName,
          skill_level: request.skillLevel,
          device_token_hash: deviceTokenHash,
          ip_hash: randomSha256Hex(),
          created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        })
        .select("id")
        .single();
      if (error) throw error;
      return { checkinRequestId: data.id, deviceTokenHash };
    }

    async function requestRow(checkinRequestId: string) {
      const { data, error } = await admin
        .from("checkin_requests")
        .select("status, decided_by, member_id, session_participant_id")
        .eq("id", checkinRequestId)
        .single();
      if (error) throw error;
      return data;
    }

    async function phoneLinks(social: TestSocial, deviceTokenHash: string) {
      const { data, error } = await admin
        .from("member_devices")
        .select("member_id")
        .eq("social_id", social.socialId)
        .eq("token_hash", deviceTokenHash);
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

    // Riverside's members and attendees, set up once.
    let graceMemberId: string;
    let peterMemberId: string;
    let graceRequest: { checkinRequestId: string; deviceTokenHash: string };
    let peterRequest: { checkinRequestId: string; deviceTokenHash: string };
    let newPlayerRequest: { checkinRequestId: string; deviceTokenHash: string };
    let likeAttendingMemberRequest: { checkinRequestId: string };
    let likeHostAddedGuestRequest: { checkinRequestId: string };
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

      graceMemberId = await insertMember(riverside, "Grace", "Kim", "beginner");
      peterMemberId = await insertMember(
        riverside,
        "Peter",
        "Lindqvist",
        "advanced",
      );
      // Grace is attending already; a host added the guest "Kai Moreno".
      const { error: attendanceError } = await admin.rpc(
        "set_draft_member_attendance",
        {
          p_actor_user_id: managerAlice.userId,
          p_session_id: riverside.sessionId,
          p_member_ids: [graceMemberId],
          p_attending: true,
        },
      );
      if (attendanceError) throw attendanceError;
      const { error: guestError } = await admin.rpc("add_draft_guest", {
        p_actor_user_id: managerAlice.userId,
        p_session_id: riverside.sessionId,
        p_session_participant_id: randomUUID(),
        p_first_name: "Kai",
        p_last_name: "Moreno",
        p_skill_level: "beginner",
      });
      if (guestError) throw guestError;

      graceRequest = await insertRequest(riverside, {
        memberId: graceMemberId,
        firstName: "Grace",
        lastName: "Kim",
        skillLevel: null,
      });
      peterRequest = await insertRequest(riverside, {
        memberId: peterMemberId,
        firstName: "Peter",
        lastName: "Lindqvist",
        skillLevel: "intermediate",
      });
      newPlayerRequest = await insertRequest(riverside, {
        firstName: "Zoe",
        lastName: "Park",
        skillLevel: "advanced",
      });
      likeAttendingMemberRequest = await insertRequest(riverside, {
        firstName: "GRACE",
        lastName: "kim",
        skillLevel: "beginner",
      });
      likeHostAddedGuestRequest = await insertRequest(riverside, {
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
    it("lists only the social's open session's pending requests, oldest first, with their flags", async () => {
      const requests = await listAs(hostAna);
      expect(requests.map((request) => request.checkinRequestId)).toEqual([
        graceRequest.checkinRequestId,
        peterRequest.checkinRequestId,
        newPlayerRequest.checkinRequestId,
        likeAttendingMemberRequest.checkinRequestId,
        likeHostAddedGuestRequest.checkinRequestId,
      ]);
      expect(requestFor(requests, graceRequest.checkinRequestId)).toMatchObject(
        {
          memberId: graceMemberId,
          requestedSkillLevel: null,
          savedSkillLevel: "beginner",
          isAlreadyAttending: true,
          isPossibleDuplicate: false,
        },
      );
      expect(requestFor(requests, peterRequest.checkinRequestId)).toMatchObject(
        {
          requestedSkillLevel: "intermediate",
          savedSkillLevel: "advanced",
          isAlreadyAttending: false,
          isPossibleDuplicate: false,
        },
      );
      expect(
        requestFor(requests, newPlayerRequest.checkinRequestId),
      ).toMatchObject({
        memberId: null,
        savedSkillLevel: null,
        isPossibleDuplicate: false,
      });
      // D-D: named like an attending member, and like a host-added guest
      // (case and accents folded).
      expect(
        requestFor(requests, likeAttendingMemberRequest.checkinRequestId)
          ?.isPossibleDuplicate,
      ).toBe(true);
      expect(
        requestFor(requests, likeHostAddedGuestRequest.checkinRequestId)
          ?.isPossibleDuplicate,
      ).toBe(true);
      expect(requestFor(requests, rejectedRequestId)).toBeUndefined();
      expect(requestFor(requests, otherSocialRequestId)).toBeUndefined();
    });

    it("creates no member record for the duplicate check", async () => {
      const { count, error } = await admin
        .from("members")
        .select("id", { count: "exact", head: true })
        .eq("social_id", riverside.socialId);
      if (error) throw error;
      expect(count).toBe(2);
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
      expect(
        await closeCheckinAlreadyCheckedIn(graceRequest.checkinRequestId),
      ).toEqual({ kind: "already_decided" });
      expect((await requestRow(peterRequest.checkinRequestId)).status).toBe(
        "pending",
      );
      expect((await requestRow(graceRequest.checkinRequestId)).status).toBe(
        "pending",
      );
      expect(await attendeeCount(riverside)).toBe(attendeesBefore);
    });

    it("refuses to approve a member already attending, and links no phone", async () => {
      actingClient = hostAna.client;
      expect(await approveCheckin(graceRequest.checkinRequestId)).toEqual({
        kind: "already_in_session",
      });
      expect((await requestRow(graceRequest.checkinRequestId)).status).toBe(
        "pending",
      );
      expect(await phoneLinks(riverside, graceRequest.deviceTokenHash)).toEqual(
        [],
      );
    });

    it("closes an already-attending request (idempotent) and links no phone", async () => {
      actingClient = hostAna.client;
      expect(
        await closeCheckinAlreadyCheckedIn(graceRequest.checkinRequestId),
      ).toEqual({ kind: "closed" });
      expect(
        await closeCheckinAlreadyCheckedIn(graceRequest.checkinRequestId),
      ).toEqual({ kind: "closed" });
      expect(await requestRow(graceRequest.checkinRequestId)).toMatchObject({
        status: "already_checked_in",
        decided_by: hostAna.userId,
      });
      expect(await phoneLinks(riverside, graceRequest.deviceTokenHash)).toEqual(
        [],
      );
    });

    it("refuses to close a request whose member isn't attending", async () => {
      actingClient = hostAna.client;
      expect(
        await closeCheckinAlreadyCheckedIn(peterRequest.checkinRequestId),
      ).toEqual({ kind: "not_already_in_session" });
      expect((await requestRow(peterRequest.checkinRequestId)).status).toBe(
        "pending",
      );
    });

    it("approves a member: attendee returned, chosen level saved, phone linked", async () => {
      actingClient = hostAna.client;
      const result = await approveCheckin(peterRequest.checkinRequestId);
      if (result.kind !== "approved" || !result.participant) {
        throw new Error(`expected an approval, got ${JSON.stringify(result)}`);
      }
      expect(result.participant).toMatchObject({
        memberId: peterMemberId,
        isGuest: false,
        firstName: "Peter",
        lastName: "Lindqvist",
        skillLevel: "intermediate",
        isMemberActive: true,
      });
      expect(await requestRow(peterRequest.checkinRequestId)).toMatchObject({
        status: "approved",
        decided_by: hostAna.userId,
        session_participant_id: result.participant.participantId,
      });
      expect(await phoneLinks(riverside, peterRequest.deviceTokenHash)).toEqual(
        [{ member_id: peterMemberId }],
      );
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
        participant: { memberId: peterMemberId },
      });
    });

    it("approves a new player once when two approvals race: a member is made and the phone linked", async () => {
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
      const request = await requestRow(newPlayerRequest.checkinRequestId);
      expect(request.status).toBe("approved");
      const { data: member, error } = await admin
        .from("members")
        .select("first_name, last_name, skill_level")
        .eq("id", request.member_id!)
        .single();
      if (error) throw error;
      expect(member).toEqual({
        first_name: "Zoe",
        last_name: "Park",
        skill_level: "advanced",
      });
      expect(
        await phoneLinks(riverside, newPlayerRequest.deviceTokenHash),
      ).toEqual([{ member_id: request.member_id }]);
      expect(results[0]).toMatchObject({
        participant: { memberId: request.member_id, isGuest: false },
      });
    });

    it("rejects (idempotent) and the request leaves the list", async () => {
      actingClient = managerAlice.client;
      const { checkinRequestId } = likeAttendingMemberRequest;
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
      expect(remaining.map((request) => request.checkinRequestId)).toEqual([
        likeHostAddedGuestRequest.checkinRequestId,
      ]);
    });

    it("tells the second host to reject or close a request that another host decided first", async () => {
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
      // Grace's request was closed by Ana earlier.
      actingClient = managerAlice.client;
      expect(
        await closeCheckinAlreadyCheckedIn(graceRequest.checkinRequestId),
      ).toEqual({ kind: "already_decided" });
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
        await approveCheckin(likeHostAddedGuestRequest.checkinRequestId),
      ).toEqual({ kind: "failed" });
      expect(
        (await requestRow(likeHostAddedGuestRequest.checkinRequestId)).status,
      ).toBe("pending");
    });
  },
);
