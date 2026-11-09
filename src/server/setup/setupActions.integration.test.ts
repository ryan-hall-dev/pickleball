// @vitest-environment node
// The Setup screen's draft writes and reads against the LOCAL Supabase stack
// (`pnpm db:start`):
//   * only hosts may create, edit or discard drafts and change attendance,
//     only admins add courts, and a host can never edit, discard or change
//     the attendance of another host's draft;
//   * create / load / update / discard a draft, the one-open-session rule,
//     adding a club court, and attendance (members, guests, Clear).
// Test courts carry a unique token in their name; test sessions belong to
// test hosts. Everything created is removed afterwards. Skips when the stack
// isn't running, unless REQUIRE_LOCAL_SUPABASE=1.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";
import { HOST_ACCESS_DENIAL_MESSAGES } from "@/server/auth/hostAccess";
import {
  addClubCourt,
  addDraftGuest,
  type DraftAttendanceResult,
  discardSessionDraft,
  removeDraftGuest,
  saveSessionDraft,
  setDraftMemberAttendance,
  startSessionDraft,
} from "./setupActions";
import { listActiveClubCourts, readHostOpenSession } from "./setupDraft";
import type { SaveSessionDraftInput } from "./setupRules";

type DatabaseClient = SupabaseClient<Database>;

// Next.js resolves these itself; plain Vitest runs the actions outside a request.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
// The actions and reads act as whoever `actingClient` is signed in as.
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
    "Skipping setup integration tests: the local Supabase stack is not running (start it with `pnpm db:start`).",
  );
}

const RUN_TOKEN = `Zqsetup${randomUUID().slice(0, 8)}`;
const DRAFT_NOT_OPEN =
  "This draft is no longer open (it was discarded or started). Reload the page.";

function plannedTimes(hoursFromNow: number, durationMinutes = 120) {
  const plannedStart = new Date(Date.now() + hoursFromNow * 3_600_000);
  plannedStart.setSeconds(0, 0);
  return {
    plannedStart: plannedStart.toISOString(),
    plannedEnd: new Date(
      plannedStart.getTime() + durationMinutes * 60_000,
    ).toISOString(),
  };
}

describe.skipIf(!localStack)("session setup drafts (local Supabase)", () => {
  let admin: DatabaseClient;
  let hostAlice: { client: DatabaseClient; userId: string };
  let hostBob: { client: DatabaseClient; userId: string };
  let adminCarol: { client: DatabaseClient; userId: string };
  let nonHostClient: DatabaseClient;
  let signedOutClient: DatabaseClient;
  const createdUserIds: string[] = [];
  const createdMemberIds: string[] = [];
  let doublesCourtId: string;
  let singlesOnlyCourtId: string;
  let inactiveCourtId: string;

  async function signedInUser(
    displayName: string | null,
    role: "host" | "admin" = "host",
  ): Promise<{ client: DatabaseClient; userId: string }> {
    const email = `integration-setup-${randomUUID()}@example.test`;
    const password = `pw-${randomUUID()}`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    const userId = created.data.user.id;
    createdUserIds.push(userId);
    if (displayName) {
      const { error } = await admin
        .from("hosts")
        .insert({ user_id: userId, display_name: displayName, role });
      if (error) throw error;
    }
    const client = createClient<Database>(
      localStack!.apiUrl,
      localStack!.publishableKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
    return { client, userId };
  }

  async function insertCourt(
    label: string,
    supportedFormats: ("doubles" | "singles")[],
    isActive = true,
  ): Promise<string> {
    const { data, error } = await admin
      .from("courts")
      .insert({
        name: `${RUN_TOKEN} ${label}`,
        supported_formats: supportedFormats,
        is_active: isActive,
        sort_order: 900_000,
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async function openSessionRows(hostUserId: string) {
    const { data, error } = await admin
      .from("sessions")
      .select("*")
      .eq("host_id", hostUserId)
      .order("created_at");
    if (error) throw error;
    return data;
  }

  async function openDraftFor(host: {
    client: DatabaseClient;
    userId: string;
  }) {
    actingClient = host.client;
    const openSession = await readHostOpenSession(host.userId);
    if (openSession.status !== "draft") {
      throw new Error(`expected a draft, got ${openSession.status}`);
    }
    return openSession.draft;
  }

  function saveInputFor(
    sessionId: string,
    overrides: Partial<SaveSessionDraftInput> = {},
  ): SaveSessionDraftInput {
    return {
      sessionId,
      name: "Integration social",
      location: "Riverside courts",
      hostName: "Alice A.",
      ...plannedTimes(48, 90),
      courtIds: [doublesCourtId],
      matchFormat: "doubles",
      targetMatchMinutes: 12,
      changeoverMinutes: 3,
      ...overrides,
    };
  }

  beforeAll(async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", localStack!.apiUrl);
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      localStack!.publishableKey,
    );
    vi.stubEnv("SUPABASE_SECRET_KEY", localStack!.secretKey);
    vi.spyOn(console, "error").mockImplementation(() => {});
    admin = createClient<Database>(localStack!.apiUrl, localStack!.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    hostAlice = await signedInUser("Alice Setup");
    hostBob = await signedInUser("Bob Setup");
    adminCarol = await signedInUser("Carol Admin", "admin");
    nonHostClient = (await signedInUser(null)).client;
    signedOutClient = createClient<Database>(
      localStack!.apiUrl,
      localStack!.publishableKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    doublesCourtId = await insertCourt("Doubles", ["doubles", "singles"]);
    singlesOnlyCourtId = await insertCourt("Singles only", ["singles"]);
    inactiveCourtId = await insertCourt("Closed", ["doubles"], false);
  });

  afterAll(async () => {
    // Test-only cleanup with the secret key; the app never deletes sessions or courts.
    const hostIds = createdUserIds;
    const { data: sessions } = await admin
      .from("sessions")
      .select("id, status")
      .in("host_id", hostIds);
    const sessionIds = (sessions ?? []).map((session) => session.id);
    const draftIds = (sessions ?? [])
      .filter((session) => session.status === "draft")
      .map((session) => session.id);
    if (draftIds.length > 0) {
      // Attendees first (they reference the session and members); the
      // database only allows that while a session is a draft.
      await admin
        .from("session_participants")
        .delete()
        .in("session_id", draftIds);
    }
    if (sessionIds.length > 0) {
      await admin.from("sessions").delete().in("id", sessionIds);
    }
    if (createdMemberIds.length > 0) {
      await admin.from("members").delete().in("id", createdMemberIds);
    }
    await admin.from("courts").delete().like("name", `${RUN_TOKEN}%`);
    await admin.from("hosts").delete().in("user_id", hostIds);
    for (const userId of hostIds) {
      await admin.auth.admin.deleteUser(userId);
    }
    vi.unstubAllEnvs();
  });

  describe("authorisation", () => {
    const refusedCallers = [
      {
        label: "a signed-in non-host",
        denial: "NOT_A_HOST",
        client: () => nonHostClient,
      },
      {
        label: "a signed-out visitor",
        denial: "SIGNED_OUT",
        client: () => signedOutClient,
      },
    ] as const;

    it.each(refusedCallers)(
      "refuses every setup write for $label and changes nothing",
      async ({ denial, client }) => {
        actingClient = hostAlice.client;
        expect(
          await startSessionDraft({
            name: "Alice social",
            ...plannedTimes(24),
          }),
        ).toEqual({ ok: true });
        const aliceDraftBefore = await openSessionRows(hostAlice.userId);
        const expected = {
          ok: false,
          message: HOST_ACCESS_DENIAL_MESSAGES[denial],
        };

        actingClient = client();
        expect(
          await startSessionDraft({ name: "Sneaky", ...plannedTimes(24) }),
        ).toEqual(expected);
        expect(
          await saveSessionDraft(
            saveInputFor(aliceDraftBefore[0].id, { name: "Hijacked" }),
          ),
        ).toEqual(expected);
        expect(await discardSessionDraft(aliceDraftBefore[0].id)).toEqual(
          expected,
        );
        expect(
          await addClubCourt({
            name: `${RUN_TOKEN} Sneaky`,
            supportedFormats: ["doubles"],
          }),
        ).toEqual(expected);
        expect(
          await setDraftMemberAttendance({
            sessionId: aliceDraftBefore[0].id,
            memberIds: [],
            attending: true,
          }),
        ).toEqual(expected);
        expect(
          await addDraftGuest({
            sessionId: aliceDraftBefore[0].id,
            participantId: randomUUID(),
            firstName: "Sneaky",
            lastName: "Guest",
            skillLevel: "",
          }),
        ).toEqual(expected);
        expect(
          await removeDraftGuest({
            sessionId: aliceDraftBefore[0].id,
            participantId: randomUUID(),
          }),
        ).toEqual(expected);

        expect(await openSessionRows(hostAlice.userId)).toEqual(
          aliceDraftBefore,
        );
        const { count: attendeeCount } = await admin
          .from("session_participants")
          .select("id", { count: "exact", head: true })
          .eq("session_id", aliceDraftBefore[0].id);
        expect(attendeeCount).toBe(0);
        const { count } = await admin
          .from("courts")
          .select("id", { count: "exact", head: true })
          .eq("name", `${RUN_TOKEN} Sneaky`);
        expect(count).toBe(0);
      },
    );

    it("never lets a host edit or discard another host's draft", async () => {
      const aliceDraft = await openDraftFor(hostAlice);
      const before = await openSessionRows(hostAlice.userId);

      actingClient = hostBob.client;
      expect(
        await saveSessionDraft(
          saveInputFor(aliceDraft.sessionId, { name: "Bob was here" }),
        ),
      ).toEqual({ ok: false, message: DRAFT_NOT_OPEN });
      expect(await discardSessionDraft(aliceDraft.sessionId)).toEqual({
        ok: false,
        message: DRAFT_NOT_OPEN,
      });
      // Bob's own setup page doesn't show Alice's draft.
      expect(await readHostOpenSession(hostBob.userId)).toEqual({
        status: "none",
      });

      expect(await openSessionRows(hostAlice.userId)).toEqual(before);
    });

    it("rejects invalid input before touching the database", async () => {
      const aliceDraft = await openDraftFor(hostAlice);
      const before = await openSessionRows(hostAlice.userId);
      expect(
        await saveSessionDraft(
          saveInputFor(aliceDraft.sessionId, {
            ...plannedTimes(48, 0),
          }),
        ),
      ).toEqual({
        ok: false,
        message: "End time must be after the start time.",
      });
      expect(
        await saveSessionDraft(
          saveInputFor(aliceDraft.sessionId, { name: "" }),
        ),
      ).toEqual({ ok: false, message: "Enter a session name." });
      expect(await openSessionRows(hostAlice.userId)).toEqual(before);
    });
  });

  describe("draft lifecycle", () => {
    it("creates one draft with the defaults, and starting again reuses it", async () => {
      actingClient = hostBob.client;
      const times = plannedTimes(30);
      expect(await startSessionDraft({ name: "Bob social", ...times })).toEqual(
        { ok: true },
      );
      expect(
        await startSessionDraft({ name: "Second try", ...plannedTimes(31) }),
      ).toEqual({ ok: true });

      const sessions = await openSessionRows(hostBob.userId);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        name: "Bob social",
        host_name: "Bob Setup",
        status: "draft",
        location: null,
        config_snapshot: {
          courts: [],
          matchFormat: "doubles",
          targetMatchMinutes: 15,
          changeoverMinutes: 2,
        },
      });
      expect(Date.parse(sessions[0].planned_start)).toBe(
        Date.parse(times.plannedStart),
      );

      const draft = await openDraftFor(hostBob);
      expect(draft).toMatchObject({
        sessionId: sessions[0].id,
        name: "Bob social",
        participants: [],
      });
    });

    it("saves details and courts, snapshots court names from the database and keeps other steps' config", async () => {
      const draft = await openDraftFor(hostBob);
      // A key another setup step (rotation) will own.
      await admin
        .from("sessions")
        .update({
          config_snapshot: {
            courts: [],
            matchFormat: "doubles",
            targetMatchMinutes: 15,
            changeoverMinutes: 2,
            rotation: { objectiveOrder: ["equalGames"] },
          },
        })
        .eq("id", draft.sessionId);

      actingClient = hostBob.client;
      const input = saveInputFor(draft.sessionId, {
        name: "  Bob's   Sunday social ",
        location: "",
        hostName: "Bob B.",
      });
      expect(await saveSessionDraft(input)).toEqual({ ok: true });

      const [row] = await openSessionRows(hostBob.userId);
      expect(row).toMatchObject({
        name: "Bob's Sunday social",
        location: null,
        host_name: "Bob B.",
        status: "draft",
        config_snapshot: {
          courts: [
            {
              courtId: doublesCourtId,
              name: `${RUN_TOKEN} Doubles`,
              format: "doubles",
            },
          ],
          matchFormat: "doubles",
          targetMatchMinutes: 12,
          changeoverMinutes: 3,
          rotation: { objectiveOrder: ["equalGames"] },
        },
      });
      expect(Date.parse(row.planned_end) - Date.parse(row.planned_start)).toBe(
        90 * 60_000,
      );

      // Reloading shows what was saved.
      const reloaded = await openDraftFor(hostBob);
      expect(reloaded.config.courts.map((court) => court.courtId)).toEqual([
        doublesCourtId,
      ]);
      expect(reloaded.hostName).toBe("Bob B.");
    });

    it("refuses courts that are inactive or don't support the format", async () => {
      const draft = await openDraftFor(hostBob);
      const before = await openSessionRows(hostBob.userId);
      actingClient = hostBob.client;
      for (const courtIds of [[singlesOnlyCourtId], [inactiveCourtId]]) {
        const result = await saveSessionDraft(
          saveInputFor(draft.sessionId, { courtIds, matchFormat: "doubles" }),
        );
        expect(result).toMatchObject({ ok: false });
      }
      expect(await openSessionRows(hostBob.userId)).toEqual(before);

      expect(
        await saveSessionDraft(
          saveInputFor(draft.sessionId, {
            courtIds: [doublesCourtId, singlesOnlyCourtId],
            matchFormat: "singles",
          }),
        ),
      ).toEqual({ ok: true });
      const [row] = await openSessionRows(hostBob.userId);
      expect(row.config_snapshot).toMatchObject({
        matchFormat: "singles",
        courts: [
          expect.objectContaining({
            courtId: doublesCourtId,
            format: "singles",
          }),
          expect.objectContaining({
            courtId: singlesOnlyCourtId,
            format: "singles",
          }),
        ],
      });
    });

    it("lists the draft's attending members and guests", async () => {
      const draft = await openDraftFor(hostBob);
      const { data: member, error: memberError } = await admin
        .from("members")
        .insert({ first_name: "Setup", last_name: RUN_TOKEN })
        .select("id")
        .single();
      if (memberError) throw memberError;
      createdMemberIds.push(member.id);
      const { error } = await admin.from("session_participants").insert([
        {
          session_id: draft.sessionId,
          member_id: member.id,
          // A multi-row insert sends every column, so set it explicitly.
          is_guest: false,
          first_name: "Setup",
          last_name: RUN_TOKEN,
        },
        {
          session_id: draft.sessionId,
          is_guest: true,
          first_name: "Guest",
          last_name: RUN_TOKEN,
        },
      ]);
      if (error) throw error;

      try {
        // Added in one statement, so in either order.
        const { participants } = await openDraftFor(hostBob);
        expect(participants).toHaveLength(2);
        expect(participants).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              memberId: member.id,
              isGuest: false,
              isMemberActive: true,
            }),
            expect.objectContaining({
              memberId: null,
              isGuest: true,
              isMemberActive: null,
            }),
          ]),
        );
      } finally {
        // Participants can only be removed while the session is a draft, and
        // the next test discards it.
        await admin
          .from("session_participants")
          .delete()
          .eq("session_id", draft.sessionId);
      }
    });

    it("discards the draft; it can't be saved afterwards and a new one can start", async () => {
      const draft = await openDraftFor(hostBob);
      actingClient = hostBob.client;
      expect(await discardSessionDraft(draft.sessionId)).toEqual({ ok: true });

      const [row] = await openSessionRows(hostBob.userId);
      expect(row.status).toBe("cancelled");
      expect(await readHostOpenSession(hostBob.userId)).toEqual({
        status: "none",
      });
      expect(await saveSessionDraft(saveInputFor(draft.sessionId))).toEqual({
        ok: false,
        message: DRAFT_NOT_OPEN,
      });
      expect(await discardSessionDraft(draft.sessionId)).toEqual({
        ok: false,
        message: DRAFT_NOT_OPEN,
      });

      expect(
        await startSessionDraft({ name: "Fresh start", ...plannedTimes(50) }),
      ).toEqual({ ok: true });
      const fresh = await openDraftFor(hostBob);
      expect(fresh.sessionId).not.toBe(draft.sessionId);
      expect(fresh.name).toBe("Fresh start");
    });

    it("says so when the host already has a live session", async () => {
      const draft = await openDraftFor(hostBob);
      // Make it live directly (the real start is M6).
      const { error } = await admin
        .from("sessions")
        .update({ status: "live", started_at: new Date().toISOString() })
        .eq("id", draft.sessionId);
      if (error) throw error;

      actingClient = hostBob.client;
      expect(
        await startSessionDraft({ name: "Another", ...plannedTimes(60) }),
      ).toEqual({
        ok: false,
        message:
          "You already have a live session. End it before setting up a new one.",
      });
      expect(await readHostOpenSession(hostBob.userId)).toEqual({
        status: "live",
        sessionId: draft.sessionId,
        name: "Fresh start",
      });
      expect(await saveSessionDraft(saveInputFor(draft.sessionId))).toEqual({
        ok: false,
        message: DRAFT_NOT_OPEN,
      });
    });
  });

  describe("club courts", () => {
    it("lets only admins add a court", async () => {
      actingClient = hostAlice.client;
      expect(
        await addClubCourt({
          name: `${RUN_TOKEN} Host court`,
          supportedFormats: ["doubles"],
        }),
      ).toEqual({
        ok: false,
        message: "Only admins can add courts to the club.",
      });
      const { count } = await admin
        .from("courts")
        .select("id", { count: "exact", head: true })
        .eq("name", `${RUN_TOKEN} Host court`);
      expect(count).toBe(0);
    });

    it("adds a court after the others, lists it, and refuses a duplicate name", async () => {
      actingClient = adminCarol.client;
      const name = `${RUN_TOKEN} New court`;
      const result = await addClubCourt({
        name: `  ${name} `,
        supportedFormats: ["singles"],
      });
      expect(result).toMatchObject({
        ok: true,
        court: { name, supportedFormats: ["singles"] },
      });

      const { data: rows } = await admin
        .from("courts")
        .select("name, sort_order")
        .order("sort_order", { ascending: false })
        .limit(1);
      expect(rows?.[0]?.name).toBe(name);

      const listed = await listActiveClubCourts();
      expect(listed.map((court) => court.name)).toContain(name);
      expect(listed.map((court) => court.id)).not.toContain(inactiveCourtId);

      expect(
        await addClubCourt({ name, supportedFormats: ["doubles"] }),
      ).toEqual({
        ok: false,
        message: `A court called ${name} already exists. Choose another name.`,
      });
      // The same name in another case is the same court.
      const shoutedName = name.toUpperCase();
      expect(
        await addClubCourt({
          name: shoutedName,
          supportedFormats: ["doubles"],
        }),
      ).toEqual({
        ok: false,
        message: `A court called ${shoutedName} already exists. Choose another name.`,
      });
      expect(
        await addClubCourt({ name: `${RUN_TOKEN} x`, supportedFormats: [] }),
      ).toEqual({ ok: false, message: "Choose at least one format." });
    });
  });
  describe("attendance", () => {
    let graceId: string;
    let kofiId: string;
    let inactiveMemberId: string;

    async function insertMember(
      firstName: string,
      isActive = true,
    ): Promise<string> {
      const { data, error } = await admin
        .from("members")
        .insert({
          first_name: firstName,
          last_name: RUN_TOKEN,
          skill_level: "intermediate",
          is_active: isActive,
        })
        .select("id")
        .single();
      if (error) throw error;
      createdMemberIds.push(data.id);
      return data.id;
    }

    async function attendeeRows(sessionId: string) {
      const { data, error } = await admin
        .from("session_participants")
        .select("id, member_id, is_guest, first_name, last_name, skill_level")
        .eq("session_id", sessionId)
        .order("created_at")
        .order("id");
      if (error) throw error;
      return data;
    }

    async function testMemberCount(): Promise<number> {
      const { count, error } = await admin
        .from("members")
        .select("id", { count: "exact", head: true })
        .eq("last_name", RUN_TOKEN);
      if (error) throw error;
      return count ?? 0;
    }

    /** The attendee list from a successful write that read it back. */
    function listFrom(result: DraftAttendanceResult) {
      if (!result.ok) throw new Error(result.message);
      if (!result.participants) throw new Error(result.message);
      return result.participants;
    }

    beforeAll(async () => {
      graceId = await insertMember("Grace");
      kofiId = await insertMember("Kofi");
      inactiveMemberId = await insertMember("Ina", false);
    });

    it("marks active members as attending with a name snapshot, idempotently", async () => {
      const draft = await openDraftFor(hostAlice);
      actingClient = hostAlice.client;
      const participants = listFrom(
        await setDraftMemberAttendance({
          sessionId: draft.sessionId,
          memberIds: [graceId, kofiId, inactiveMemberId],
          attending: true,
        }),
      );
      expect(
        participants.map((participant) => participant.memberId).sort(),
      ).toEqual([graceId, kofiId].sort());
      expect(participants[0]).toMatchObject({
        isGuest: false,
        lastName: RUN_TOKEN,
        skillLevel: "intermediate",
        isMemberActive: true,
      });
      const rowsAfterFirst = await attendeeRows(draft.sessionId);

      // Again (another tab, a retry): nothing changes.
      expect(
        await setDraftMemberAttendance({
          sessionId: draft.sessionId,
          memberIds: [graceId],
          attending: true,
        }),
      ).toMatchObject({ ok: true });
      expect(await attendeeRows(draft.sessionId)).toEqual(rowsAfterFirst);
      // Reloading the page shows the same list.
      expect((await openDraftFor(hostAlice)).participants).toEqual(
        participants,
      );
    });

    it("adds guests without touching the members directory, and removes them", async () => {
      const draft = await openDraftFor(hostAlice);
      const membersBefore = await testMemberCount();
      actingClient = hostAlice.client;
      const firstGuestInput = {
        sessionId: draft.sessionId,
        participantId: randomUUID(),
        firstName: "  Kai ",
        lastName: RUN_TOKEN,
        skillLevel: "",
      };
      listFrom(await addDraftGuest(firstGuestInput));
      // A retry of the same add (same id) doesn't add the guest twice.
      listFrom(await addDraftGuest(firstGuestInput));
      // A second guest with the same name is fine.
      const afterSecondGuest = listFrom(
        await addDraftGuest({
          sessionId: draft.sessionId,
          participantId: randomUUID(),
          firstName: "Kai",
          lastName: RUN_TOKEN,
          skillLevel: "beginner",
        }),
      );
      const guests = afterSecondGuest.filter(
        (participant) => participant.isGuest,
      );
      expect(guests).toEqual([
        expect.objectContaining({
          participantId: firstGuestInput.participantId,
          memberId: null,
          firstName: "Kai",
          skillLevel: null,
        }),
        expect.objectContaining({ firstName: "Kai", skillLevel: "beginner" }),
      ]);
      expect(await testMemberCount()).toBe(membersBefore);

      const removed = listFrom(
        await removeDraftGuest({
          sessionId: draft.sessionId,
          participantId: guests[0].participantId,
        }),
      );
      expect(
        removed.map((participant) => participant.participantId),
      ).not.toContain(guests[0].participantId);
      // The members are still attending; removing again is fine.
      expect(
        removed.filter((participant) => !participant.isGuest),
      ).toHaveLength(2);
      expect(
        await removeDraftGuest({
          sessionId: draft.sessionId,
          participantId: guests[0].participantId,
        }),
      ).toMatchObject({ ok: true });
      // A member's row is never removed as a guest.
      const graceRow = removed.find(
        (participant) => participant.memberId === graceId,
      )!;
      await removeDraftGuest({
        sessionId: draft.sessionId,
        participantId: graceRow.participantId,
      });
      expect(
        (await attendeeRows(draft.sessionId)).map((row) => row.id),
      ).toContain(graceRow.participantId);
    });

    it("keeps a deactivated member attending until removed", async () => {
      await admin.from("members").update({ is_active: false }).eq("id", kofiId);
      try {
        const draft = await openDraftFor(hostAlice);
        expect(
          draft.participants.find(
            (participant) => participant.memberId === kofiId,
          ),
        ).toMatchObject({ isMemberActive: false });

        actingClient = hostAlice.client;
        const afterRemoval = listFrom(
          await setDraftMemberAttendance({
            sessionId: draft.sessionId,
            memberIds: [kofiId],
            attending: false,
          }),
        );
        expect(
          afterRemoval.find((participant) => participant.memberId === kofiId),
        ).toBeUndefined();
        expect(
          (await attendeeRows(draft.sessionId)).find(
            (row) => row.member_id === kofiId,
          ),
        ).toBeUndefined();
        // While deactivated, they can't be added back.
        listFrom(
          await setDraftMemberAttendance({
            sessionId: draft.sessionId,
            memberIds: [kofiId],
            attending: true,
          }),
        );
        expect(
          (await attendeeRows(draft.sessionId)).find(
            (row) => row.member_id === kofiId,
          ),
        ).toBeUndefined();
      } finally {
        await admin
          .from("members")
          .update({ is_active: true })
          .eq("id", kofiId);
      }
    });

    it("never changes another host's draft attendance", async () => {
      const draft = await openDraftFor(hostAlice);
      const before = await attendeeRows(draft.sessionId);
      actingClient = hostBob.client;
      const draftNotOpen = { ok: false, message: DRAFT_NOT_OPEN };
      expect(
        await setDraftMemberAttendance({
          sessionId: draft.sessionId,
          memberIds: [graceId, kofiId],
          attending: false,
        }),
      ).toEqual(draftNotOpen);
      expect(
        await addDraftGuest({
          sessionId: draft.sessionId,
          participantId: randomUUID(),
          firstName: "Bob's",
          lastName: "Friend",
          skillLevel: "",
        }),
      ).toEqual(draftNotOpen);
      const guestId = before.find((row) => row.is_guest)!.id;
      expect(
        await removeDraftGuest({
          sessionId: draft.sessionId,
          participantId: guestId,
        }),
      ).toEqual(draftNotOpen);
      expect(await attendeeRows(draft.sessionId)).toEqual(before);
    });

    it("rejects invalid attendance input before touching the database", async () => {
      const draft = await openDraftFor(hostAlice);
      const before = await attendeeRows(draft.sessionId);
      actingClient = hostAlice.client;
      expect(
        await addDraftGuest({
          sessionId: draft.sessionId,
          participantId: randomUUID(),
          firstName: "Kai",
          lastName: "   ",
          skillLevel: "",
        }),
      ).toEqual({ ok: false, message: "Enter a last name." });
      expect(
        await setDraftMemberAttendance({
          sessionId: draft.sessionId,
          memberIds: ["not-a-uuid"],
          attending: true,
        }),
      ).toMatchObject({ ok: false });
      expect(await attendeeRows(draft.sessionId)).toEqual(before);
    });

    it("Clear removes every attending member and keeps the guests", async () => {
      const draft = await openDraftFor(hostAlice);
      const attendingIds = draft.participants.flatMap((participant) =>
        participant.isGuest || !participant.memberId
          ? []
          : [participant.memberId],
      );
      actingClient = hostAlice.client;
      const cleared = listFrom(
        await setDraftMemberAttendance({
          sessionId: draft.sessionId,
          memberIds: attendingIds,
          attending: false,
        }),
      );
      expect(cleared).toEqual([
        expect.objectContaining({ isGuest: true, firstName: "Kai" }),
      ]);
    });
  });
});
