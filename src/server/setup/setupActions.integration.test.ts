// @vitest-environment node
// The Setup screen's draft writes and reads against the LOCAL Supabase stack
// (`pnpm db:start`):
//   * only hosts may create, edit or discard drafts and change attendance,
//     only the social manager adds courts; every host of a social works on
//     the social's one draft (co-editing), and a host of another social can
//     never see, edit, discard or change the attendance of it;
//   * create / load / update / discard a draft, the one-open-session-per-social
//     rule, adding a club court, attendance (session-only players: add,
//     remove, one name per session), saved
//     setups shared within a social, and the draft revision between co-hosts.
// Every host group gets its own test social (with its own courts where it
// needs them), so files can run in parallel. Test courts carry a unique token
// in their name. Everything deletable is removed afterwards. Skips when the
// stack isn't running, unless REQUIRE_LOCAL_SUPABASE=1.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  RECOMMENDED_ROTATION_PREFERENCES,
  type RotationPreferences,
} from "@/engine/session";
import type { Database, Json } from "@/lib/database.types";
import { HOST_ACCESS_DENIAL_MESSAGES } from "@/server/auth/hostAccess";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import {
  addClubCourt,
  addDraftParticipant,
  applySavedSetup,
  type ApplySavedSetupResult,
  type DraftAttendanceResult,
  discardSessionDraft,
  readSessionDraft,
  removeDraftParticipant,
  saveSessionDraft,
  setDraftParticipantDetails,
  saveSetup,
  startSessionDraft,
} from "./setupActions";
import {
  listActiveClubCourts,
  listSocialSavedSetups,
  readSocialOpenSession,
} from "./setupDraft";
import {
  recommendedRotationPreferences,
  type SaveSessionDraftInput,
} from "./setupRules";

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

interface TestHost {
  client: DatabaseClient;
  userId: string;
  socialId: string;
}

/** A social's test courts: doubles+singles, singles only, and a closed one. */
interface TestCourts {
  doublesCourtId: string;
  singlesOnlyCourtId: string;
  inactiveCourtId: string;
}

describe.skipIf(!localStack)("session setup drafts (local Supabase)", () => {
  let admin: DatabaseClient;
  // Bob (host) and Carol (manager) share the main social, which has the test
  // courts. Alice and her co-host Ana run another social's draft (attendance);
  // Omar manages a third social with a court named like the main one's.
  // Every social is another social to the others.
  let hostAlice: TestHost;
  let coHostAna: TestHost;
  let hostBob: TestHost;
  let managerCarol: TestHost;
  let socialId: string;
  let aliceSocialId: string;
  let otherSocialId: string;
  let otherSocialManager: TestHost;
  // The other social's court, named like the main social's doubles court.
  let otherSocialCourtId: string;
  let nonHostClient: DatabaseClient;
  let signedOutClient: DatabaseClient;
  const createdUserIds: string[] = [];
  const createdSocialIds: string[] = [];
  let doublesCourtId: string;
  let singlesOnlyCourtId: string;
  let inactiveCourtId: string;

  async function createTestSocial(name: string): Promise<string> {
    const { data, error } = await admin
      .from("socials")
      .insert({ name })
      .select("id")
      .single();
    if (error) throw error;
    createdSocialIds.push(data.id);
    return data.id;
  }

  async function createTestCourts(courtSocialId: string): Promise<TestCourts> {
    return {
      doublesCourtId: await insertCourt(
        "Doubles",
        ["doubles", "singles"],
        true,
        courtSocialId,
      ),
      singlesOnlyCourtId: await insertCourt(
        "Singles only",
        ["singles"],
        true,
        courtSocialId,
      ),
      inactiveCourtId: await insertCourt(
        "Closed",
        ["doubles"],
        false,
        courtSocialId,
      ),
    };
  }

  async function signedInUser(
    displayName: string | null,
    role: "host" | "manager" = "host",
    hostSocialId = socialId,
  ): Promise<TestHost> {
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
      const { error } = await admin.from("hosts").insert({
        user_id: userId,
        display_name: displayName,
        role,
        social_id: hostSocialId,
      });
      if (error) throw error;
    }
    const client = createClient<Database>(
      localStack!.apiUrl,
      localStack!.publishableKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
    return { client, userId, socialId: hostSocialId };
  }

  async function insertCourt(
    label: string,
    supportedFormats: ("doubles" | "singles")[],
    isActive = true,
    courtSocialId = socialId,
  ): Promise<string> {
    const { data, error } = await admin
      .from("courts")
      .insert({
        social_id: courtSocialId,
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

  /** Every session of the host's social, oldest first. */
  async function socialSessionRows(host: TestHost) {
    const { data, error } = await admin
      .from("sessions")
      .select("*")
      .eq("social_id", host.socialId)
      .order("created_at");
    if (error) throw error;
    return data;
  }

  async function openDraftFor(host: TestHost) {
    actingClient = host.client;
    const openSession = await readSocialOpenSession(host.socialId);
    if (openSession.status !== "draft") {
      throw new Error(`expected a draft, got ${openSession.status}`);
    }
    return openSession.draft;
  }

  async function draftRevisionOf(sessionId: string): Promise<number> {
    const { data, error } = await admin
      .from("sessions")
      .select("draft_revision")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) throw error;
    // An unknown session: any revision (the write is refused anyway).
    return data?.draft_revision ?? 0;
  }

  /**
   * Saves as an editor that loaded the draft just now (its current settings
   * revision). Reports success as `{ ok: true }`; the revision tests below
   * call saveSessionDraft directly.
   */
  async function saveAtCurrentRevision(input: SaveSessionDraftInput) {
    const result = await saveSessionDraft(
      input,
      await draftRevisionOf(input.sessionId),
    );
    return result.ok ? { ok: true } : result;
  }

  async function applyAtCurrentRevision(input: {
    sessionId: string;
    setupId: string;
  }) {
    return applySavedSetup({
      ...input,
      expectedDraftRevision: await draftRevisionOf(input.sessionId),
    });
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
      // Courts belong to one social: tests that save courts name them.
      courtIds: [],
      matchFormat: "doubles",
      targetMatchMinutes: 12,
      changeoverMinutes: 3,
      rotation: recommendedRotationPreferences(),
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
    socialId = await createTestSocial("Integration setup social");
    aliceSocialId = await createTestSocial("Integration setup Alice social");
    otherSocialId = await createTestSocial("Integration setup other social");
    otherSocialManager = await signedInUser(
      "Omar Other",
      "manager",
      otherSocialId,
    );
    hostAlice = await signedInUser("Alice Setup", "host", aliceSocialId);
    coHostAna = await signedInUser("Ana Cohost", "host", aliceSocialId);
    hostBob = await signedInUser("Bob Setup");
    managerCarol = await signedInUser("Carol Manager", "manager");
    nonHostClient = (await signedInUser(null)).client;
    signedOutClient = createClient<Database>(
      localStack!.apiUrl,
      localStack!.publishableKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    ({ doublesCourtId, singlesOnlyCourtId, inactiveCourtId } =
      await createTestCourts(socialId));
    otherSocialCourtId = await insertCourt(
      "Doubles",
      ["doubles", "singles"],
      true,
      otherSocialId,
    );
  });

  afterAll(async () => {
    // Test-only cleanup with the secret key; the app never deletes sessions or courts.
    await admin.from("hosts").delete().in("user_id", createdUserIds);
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
    // Then the socials, with their setups, sessions and courts.
    await deleteTestSocials(admin, createdSocialIds);
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
        ).toEqual({ ok: true, notice: null });
        const aliceDraftBefore = await socialSessionRows(hostAlice);
        const expected = {
          ok: false,
          message: HOST_ACCESS_DENIAL_MESSAGES[denial],
        };

        actingClient = client();
        expect(
          await startSessionDraft({ name: "Sneaky", ...plannedTimes(24) }),
        ).toEqual(expected);
        expect(
          await saveAtCurrentRevision(
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
          await addDraftParticipant({
            sessionId: aliceDraftBefore[0].id,
            participantId: randomUUID(),
            firstName: "Sneaky",
            lastName: "Guest",
            skillLevel: "beginner",
            gender: "male" as const,
          }),
        ).toEqual(expected);
        expect(
          await removeDraftParticipant({
            sessionId: aliceDraftBefore[0].id,
            participantId: randomUUID(),
          }),
        ).toEqual(expected);
        expect(
          await saveSetup({
            setupName: "Sneaky setup",
            draft: saveInputFor(aliceDraftBefore[0].id),
          }),
        ).toEqual(expected);
        expect(
          await applyAtCurrentRevision({
            sessionId: aliceDraftBefore[0].id,
            setupId: randomUUID(),
          }),
        ).toEqual(expected);
        expect(await readSessionDraft(aliceDraftBefore[0].id)).toEqual(
          expected,
        );
        const { count: sneakySetupCount } = await admin
          .from("saved_setups")
          .select("id", { count: "exact", head: true })
          .in("host_id", createdUserIds)
          .eq("name", "Sneaky setup");
        expect(sneakySetupCount).toBe(0);

        expect(await socialSessionRows(hostAlice)).toEqual(aliceDraftBefore);
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

    it("never lets another social's host see, edit or discard the draft", async () => {
      const aliceDraft = await openDraftFor(hostAlice);
      const before = await socialSessionRows(hostAlice);

      actingClient = hostBob.client;
      expect(
        await saveAtCurrentRevision(
          saveInputFor(aliceDraft.sessionId, { name: "Bob was here" }),
        ),
      ).toEqual({ ok: false, message: DRAFT_NOT_OPEN });
      expect(await discardSessionDraft(aliceDraft.sessionId)).toEqual({
        ok: false,
        message: DRAFT_NOT_OPEN,
      });
      expect(await readSessionDraft(aliceDraft.sessionId)).toEqual({
        ok: false,
        message: DRAFT_NOT_OPEN,
      });
      // Bob's own setup page doesn't show Alice's draft, even when asked for
      // her social (RLS reads only his own).
      expect(await readSocialOpenSession(hostBob.socialId)).toEqual({
        status: "none",
      });
      expect(await readSocialOpenSession(aliceSocialId)).toEqual({
        status: "none",
      });

      expect(await socialSessionRows(hostAlice)).toEqual(before);
    });

    it("lets a co-host of the social open, edit and re-read the same draft", async () => {
      const aliceDraft = await openDraftFor(hostAlice);
      // Starting a draft reuses the one the co-host already started, and says
      // so (Ana's typed name isn't used).
      actingClient = coHostAna.client;
      expect(
        await startSessionDraft({ name: "Ana's own", ...plannedTimes(26) }),
      ).toEqual({
        ok: true,
        notice: `A co-host already started \u201c${aliceDraft.name}\u201d. You're editing it together.`,
      });
      const anaDraft = await openDraftFor(coHostAna);
      expect(anaDraft.sessionId).toBe(aliceDraft.sessionId);
      expect(await socialSessionRows(coHostAna)).toHaveLength(1);

      actingClient = coHostAna.client;
      const saved = await saveSessionDraft(
        saveInputFor(aliceDraft.sessionId, { name: "Edited by Ana" }),
        anaDraft.draftRevision,
      );
      expect(saved).toEqual({
        ok: true,
        draftRevision: anaDraft.draftRevision + 1,
      });
      const [row] = await socialSessionRows(hostAlice);
      // Still created by Alice; edited by her co-host.
      expect(row).toMatchObject({
        host_id: hostAlice.userId,
        name: "Edited by Ana",
      });
      expect((await openDraftFor(hostAlice)).name).toBe("Edited by Ana");
    });

    it("lets a co-host who didn't start the draft discard it for every host", async () => {
      // Its own social: the shared Alice draft stays open for later tests.
      const discardSocialId = await createTestSocial(
        "Integration setup discard social",
      );
      const creatorDana = await signedInUser(
        "Dana Creator",
        "host",
        discardSocialId,
      );
      const coHostEli = await signedInUser(
        "Eli Cohost",
        "host",
        discardSocialId,
      );
      actingClient = creatorDana.client;
      expect(
        await startSessionDraft({ name: "Dana's draft", ...plannedTimes(30) }),
      ).toEqual({ ok: true, notice: null });
      const draft = await openDraftFor(coHostEli);

      actingClient = coHostEli.client;
      expect(await discardSessionDraft(draft.sessionId)).toEqual({ ok: true });

      const [row] = await socialSessionRows(creatorDana);
      expect(row).toMatchObject({
        id: draft.sessionId,
        host_id: creatorDana.userId,
        status: "cancelled",
      });
      // Gone for the creator too: no open draft, and their next save is refused.
      actingClient = creatorDana.client;
      expect(await readSocialOpenSession(discardSocialId)).toEqual({
        status: "none",
      });
      expect(
        await saveAtCurrentRevision(saveInputFor(draft.sessionId)),
      ).toEqual({ ok: false, message: DRAFT_NOT_OPEN });
    });

    it("rejects invalid input before touching the database", async () => {
      const aliceDraft = await openDraftFor(hostAlice);
      const before = await socialSessionRows(hostAlice);
      expect(
        await saveAtCurrentRevision(
          saveInputFor(aliceDraft.sessionId, {
            ...plannedTimes(48, 0),
          }),
        ),
      ).toEqual({
        ok: false,
        message: "End time must be after the start time.",
      });
      expect(
        await saveAtCurrentRevision(
          saveInputFor(aliceDraft.sessionId, { name: "" }),
        ),
      ).toEqual({ ok: false, message: "Enter a session name." });
      expect(await socialSessionRows(hostAlice)).toEqual(before);
    });
  });

  describe("draft lifecycle", () => {
    it("creates one draft with the defaults, and starting again reuses it", async () => {
      actingClient = hostBob.client;
      const times = plannedTimes(30);
      expect(await startSessionDraft({ name: "Bob social", ...times })).toEqual(
        { ok: true, notice: null },
      );
      // Their own draft again (a double click, another tab): no notice.
      expect(
        await startSessionDraft({ name: "Second try", ...plannedTimes(31) }),
      ).toEqual({ ok: true, notice: null });

      const sessions = await socialSessionRows(hostBob);
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
      // A key some later step will own.
      await admin
        .from("sessions")
        .update({
          config_snapshot: {
            courts: [],
            matchFormat: "doubles",
            targetMatchMinutes: 15,
            changeoverMinutes: 2,
            laterStep: { kept: true },
          },
        })
        .eq("id", draft.sessionId);

      actingClient = hostBob.client;
      const input = saveInputFor(draft.sessionId, {
        name: "  Bob's   Sunday social ",
        location: "",
        hostName: "Bob B.",
        courtIds: [doublesCourtId],
      });
      expect(await saveAtCurrentRevision(input)).toEqual({ ok: true });

      const [row] = await socialSessionRows(hostBob);
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
          rotation: recommendedRotationPreferences(),
          laterStep: { kept: true },
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
      const before = await socialSessionRows(hostBob);
      actingClient = hostBob.client;
      for (const courtIds of [[singlesOnlyCourtId], [inactiveCourtId]]) {
        const result = await saveAtCurrentRevision(
          saveInputFor(draft.sessionId, { courtIds, matchFormat: "doubles" }),
        );
        expect(result).toMatchObject({ ok: false });
      }
      expect(await socialSessionRows(hostBob)).toEqual(before);

      expect(
        await saveAtCurrentRevision(
          saveInputFor(draft.sessionId, {
            courtIds: [doublesCourtId, singlesOnlyCourtId],
            matchFormat: "singles",
          }),
        ),
      ).toEqual({ ok: true });
      const [row] = await socialSessionRows(hostBob);
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

    it("refuses another social's court as unavailable, even with the same name", async () => {
      const draft = await openDraftFor(hostBob);
      const before = await socialSessionRows(hostBob);
      actingClient = hostBob.client;
      const unavailable = {
        ok: false,
        message:
          "A chosen court was removed or doesn't support doubles. Reload the page.",
      };
      expect(
        await saveAtCurrentRevision(
          saveInputFor(draft.sessionId, {
            courtIds: [doublesCourtId, otherSocialCourtId],
          }),
        ),
      ).toEqual(unavailable);
      expect(await socialSessionRows(hostBob)).toEqual(before);

      expect(
        await saveSetup({
          setupName: `${RUN_TOKEN} Other court`,
          draft: saveInputFor(draft.sessionId, {
            courtIds: [otherSocialCourtId],
          }),
        }),
      ).toEqual(unavailable);
      const { count } = await admin
        .from("saved_setups")
        .select("id", { count: "exact", head: true })
        .eq("name", `${RUN_TOKEN} Other court`);
      expect(count).toBe(0);
    });

    it("round-trips the rotation as the engine's RotationPreferences, and another social's host can't write it", async () => {
      const draft = await openDraftFor(hostBob);
      const rotation = {
        objectiveOrder: [
          "noBackToBack",
          "mixPartners",
          "equalGames",
          "shortestWaits",
          "playingTime",
          "fullCourts",
        ],
        rules: {
          preventConsecutive: true,
          fewerGamesFirst: false,
          longestWaitFirst: true,
          mixPartners: true,
          minimiseRepeatOpponents: false,
          allowManualAssignments: false,
        },
      } satisfies RotationPreferences;
      actingClient = hostBob.client;
      expect(
        await saveAtCurrentRevision(
          saveInputFor(draft.sessionId, { rotation }),
        ),
      ).toEqual({ ok: true });

      // The raw snapshot holds exactly the engine's shape: a permutation of
      // all six objectives and all six rules as booleans, nothing else.
      const [row] = await socialSessionRows(hostBob);
      const storedRotation = (row.config_snapshot as Record<string, unknown>)
        .rotation as RotationPreferences;
      expect(storedRotation).toEqual(rotation);
      expect(Object.keys(storedRotation).sort()).toEqual([
        "objectiveOrder",
        "rules",
      ]);
      expect([...storedRotation.objectiveOrder].sort()).toEqual(
        [...RECOMMENDED_ROTATION_PREFERENCES.objectiveOrder].sort(),
      );
      expect(Object.keys(storedRotation.rules).sort()).toEqual(
        Object.keys(RECOMMENDED_ROTATION_PREFERENCES.rules).sort(),
      );
      expect(
        Object.values(storedRotation.rules).every(
          (isOn) => typeof isOn === "boolean",
        ),
      ).toBe(true);
      expect((await openDraftFor(hostBob)).config.rotation).toEqual(rotation);

      // Another social's host can't write it; an invalid order never reaches the database.
      actingClient = hostAlice.client;
      expect(
        await saveAtCurrentRevision(
          saveInputFor(draft.sessionId, {
            rotation: recommendedRotationPreferences(),
          }),
        ),
      ).toEqual({ ok: false, message: DRAFT_NOT_OPEN });
      actingClient = hostBob.client;
      expect(
        await saveAtCurrentRevision(
          saveInputFor(draft.sessionId, {
            rotation: {
              ...rotation,
              objectiveOrder: [
                ...rotation.objectiveOrder.slice(0, 5),
                "noBackToBack",
              ],
            },
          }),
        ),
      ).toEqual({
        ok: false,
        message: "Rank every rotation priority exactly once.",
      });
      expect((await openDraftFor(hostBob)).config.rotation).toEqual(rotation);
    });

    it("lists the draft's players with their names and levels", async () => {
      const draft = await openDraftFor(hostBob);
      const { error } = await admin.from("session_participants").insert([
        {
          session_id: draft.sessionId,
          social_id: socialId,
          first_name: "Setup",
          last_name: RUN_TOKEN,
          skill_level: "advanced",
          gender: "male" as const,
        },
        {
          session_id: draft.sessionId,
          social_id: socialId,
          first_name: "Legacy",
          last_name: RUN_TOKEN,
          // Sessions from before levels were required may have none.
          skill_level: null,
          gender: null,
        },
      ]);
      if (error) throw error;

      try {
        // Added in one statement, so in either order.
        const { participants } = await openDraftFor(hostBob);
        expect(participants).toHaveLength(2);
        expect(participants).toEqual(
          expect.arrayContaining([
            {
              participantId: expect.any(String),
              firstName: "Setup",
              lastName: RUN_TOKEN,
              skillLevel: "advanced",
              gender: "male" as const,
            },
            {
              participantId: expect.any(String),
              firstName: "Legacy",
              lastName: RUN_TOKEN,
              skillLevel: null,
              gender: null,
            },
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

      const [row] = await socialSessionRows(hostBob);
      expect(row.status).toBe("cancelled");
      expect(await readSocialOpenSession(hostBob.socialId)).toEqual({
        status: "none",
      });
      expect(
        await saveAtCurrentRevision(saveInputFor(draft.sessionId)),
      ).toEqual({
        ok: false,
        message: DRAFT_NOT_OPEN,
      });
      expect(await discardSessionDraft(draft.sessionId)).toEqual({
        ok: false,
        message: DRAFT_NOT_OPEN,
      });

      expect(
        await startSessionDraft({ name: "Fresh start", ...plannedTimes(50) }),
      ).toEqual({ ok: true, notice: null });
      const fresh = await openDraftFor(hostBob);
      expect(fresh.sessionId).not.toBe(draft.sessionId);
      expect(fresh.name).toBe("Fresh start");
    });

    it("says so when the social already has a live session", async () => {
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
          "Your social already has a live session. End it before setting up a new one.",
      });
      expect(await readSocialOpenSession(hostBob.socialId)).toEqual({
        status: "live",
        sessionId: draft.sessionId,
        name: "Fresh start",
      });
      expect(
        await saveAtCurrentRevision(saveInputFor(draft.sessionId)),
      ).toEqual({
        ok: false,
        message: DRAFT_NOT_OPEN,
      });
    });
  });

  describe("club courts", () => {
    it("lets only the social manager add a court", async () => {
      actingClient = hostAlice.client;
      expect(
        await addClubCourt({
          name: `${RUN_TOKEN} Host court`,
          supportedFormats: ["doubles"],
        }),
      ).toEqual({
        ok: false,
        message: "Only the social manager can add courts.",
      });
      const { count } = await admin
        .from("courts")
        .select("id", { count: "exact", head: true })
        .eq("name", `${RUN_TOKEN} Host court`);
      expect(count).toBe(0);
    });

    it("adds a court after the others, lists it, and refuses a duplicate name", async () => {
      actingClient = managerCarol.client;
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
        .eq("social_id", socialId)
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

    it("keeps each social's courts to itself: same names allowed, ordered and listed per social", async () => {
      const name = `${RUN_TOKEN} Court 1`;
      actingClient = managerCarol.client;
      const carolResult = await addClubCourt({
        name,
        supportedFormats: ["doubles"],
      });
      if (!carolResult.ok) throw new Error(carolResult.message);

      // The other social's manager adds a court of the same name.
      actingClient = otherSocialManager.client;
      const otherResult = await addClubCourt({
        name,
        supportedFormats: ["doubles"],
      });
      if (!otherResult.ok) throw new Error(otherResult.message);
      const { data: otherCourt, error } = await admin
        .from("courts")
        .select("social_id, sort_order")
        .eq("id", otherResult.court.id)
        .single();
      if (error) throw error;
      // After the other social's own last court, whatever Alice's social has.
      expect(otherCourt).toEqual({
        social_id: otherSocialId,
        sort_order: 900_001,
      });

      const otherListedIds = (await listActiveClubCourts()).map(
        (court) => court.id,
      );
      expect(otherListedIds.sort()).toEqual(
        [otherSocialCourtId, otherResult.court.id].sort(),
      );

      actingClient = managerCarol.client;
      const carolListedIds = (await listActiveClubCourts()).map(
        (court) => court.id,
      );
      expect(carolListedIds).toContain(carolResult.court.id);
      expect(carolListedIds).toContain(doublesCourtId);
      expect(carolListedIds).not.toContain(otherResult.court.id);
      expect(carolListedIds).not.toContain(otherSocialCourtId);
    });
  });
  describe("attendance", () => {
    it("completes legacy missing details, preserves names, and rejects stale and other-social edits", async () => {
      const draft = await openDraftFor(hostAlice);
      const participantId = randomUUID();
      const { error: insertError } = await admin
        .from("session_participants")
        .insert({
          id: participantId,
          session_id: draft.sessionId,
          social_id: hostAlice.socialId,
          first_name: "Legacy",
          last_name: RUN_TOKEN,
          gender: null,
          skill_level: null,
        });
      if (insertError) throw insertError;
      const input = {
        sessionId: draft.sessionId,
        participantId,
        gender: "female" as const,
        skillLevel: "advanced" as const,
        expectedDraftRevision: draft.draftRevision,
      };
      actingClient = hostAlice.client;
      expect(await setDraftParticipantDetails(input)).toEqual({
        ok: true,
        draftRevision: draft.draftRevision + 1,
      });
      const { data, error } = await admin
        .from("session_participants")
        .select("first_name,last_name,gender,skill_level")
        .eq("social_id", hostAlice.socialId)
        .eq("id", participantId)
        .single();
      if (error) throw error;
      expect(data).toEqual({
        first_name: "Legacy",
        last_name: RUN_TOKEN,
        gender: "female",
        skill_level: "advanced",
      });
      expect(
        await setDraftParticipantDetails({ ...input, gender: "male" }),
      ).toMatchObject({ ok: false, isConflict: true });
      actingClient = otherSocialManager.client;
      expect(
        await setDraftParticipantDetails({
          ...input,
          expectedDraftRevision: draft.draftRevision + 1,
        }),
      ).toMatchObject({ ok: false });
      actingClient = hostAlice.client;
      const reread = await readSessionDraft(draft.sessionId);
      expect(reread).toMatchObject({
        ok: true,
        draft: {
          participants: expect.arrayContaining([
            {
              participantId,
              firstName: "Legacy",
              lastName: RUN_TOKEN,
              gender: "female",
              skillLevel: "advanced",
            },
          ]),
        },
      });
      expect(
        (
          await removeDraftParticipant({
            sessionId: draft.sessionId,
            participantId,
          })
        ).ok,
      ).toBe(true);
    });

    async function attendeeRows(sessionId: string) {
      const { data, error } = await admin
        .from("session_participants")
        .select("id, first_name, last_name, skill_level, gender")
        .eq("session_id", sessionId)
        .order("created_at")
        .order("id");
      if (error) throw error;
      return data;
    }

    /** The attendee list from a successful write that read it back. */
    function listFrom(result: DraftAttendanceResult) {
      if (!result.ok) throw new Error(result.message);
      if (!result.participants) throw new Error(result.message);
      return result.participants;
    }

    it("adds players with a trimmed name and a level, idempotently, and removes them", async () => {
      const draft = await openDraftFor(hostAlice);
      actingClient = hostAlice.client;
      const kaiInput = {
        sessionId: draft.sessionId,
        participantId: randomUUID(),
        firstName: "  Kai ",
        lastName: RUN_TOKEN,
        skillLevel: "beginner" as const,
        gender: "male" as const,
      };
      const afterKai = listFrom(await addDraftParticipant(kaiInput));
      expect(afterKai).toEqual([
        {
          participantId: kaiInput.participantId,
          firstName: "Kai",
          lastName: RUN_TOKEN,
          skillLevel: "beginner",
          gender: "male" as const,
        },
      ]);
      // A retry of the same add (same id) doesn't add the player twice.
      expect(listFrom(await addDraftParticipant(kaiInput))).toEqual(afterKai);
      const afterGrace = listFrom(
        await addDraftParticipant({
          sessionId: draft.sessionId,
          participantId: randomUUID(),
          firstName: "Grace",
          lastName: RUN_TOKEN,
          skillLevel: "advanced",
          gender: "male" as const,
        }),
      );
      expect(afterGrace.map((participant) => participant.firstName)).toEqual([
        "Kai",
        "Grace",
      ]);
      // Reloading the page shows the same list.
      expect((await openDraftFor(hostAlice)).participants).toEqual(afterGrace);

      const afterRemoval = listFrom(
        await removeDraftParticipant({
          sessionId: draft.sessionId,
          participantId: kaiInput.participantId,
        }),
      );
      expect(afterRemoval.map((participant) => participant.firstName)).toEqual([
        "Grace",
      ]);
      // Removing again (already gone) counts as done.
      expect(
        await removeDraftParticipant({
          sessionId: draft.sessionId,
          participantId: kaiInput.participantId,
        }),
      ).toEqual({ ok: true, participants: afterRemoval });
    });

    it("refuses a name already in the session (case, accents and spacing ignored) with the host's message", async () => {
      const draft = await openDraftFor(hostAlice);
      const before = await attendeeRows(draft.sessionId);
      actingClient = hostAlice.client;
      expect(
        await addDraftParticipant({
          sessionId: draft.sessionId,
          participantId: randomUUID(),
          firstName: "GRÂCE",
          lastName: ` ${RUN_TOKEN.toLowerCase()} `,
          skillLevel: "beginner",
          gender: "male" as const,
        }),
      ).toEqual({
        ok: false,
        message: `Someone named GRÂCE ${RUN_TOKEN.toLowerCase()} is already in this session. Add something to tell them apart, like an initial.`,
      });
      expect(await attendeeRows(draft.sessionId)).toEqual(before);
      // A distinguishing initial makes it a different name.
      listFrom(
        await addDraftParticipant({
          sessionId: draft.sessionId,
          participantId: randomUUID(),
          firstName: "Grace",
          lastName: `${RUN_TOKEN} B`,
          skillLevel: "beginner",
          gender: "male" as const,
        }),
      );
    });

    it("never lets another social's host change the attendance, while a co-host can", async () => {
      const draft = await openDraftFor(hostAlice);
      const before = await attendeeRows(draft.sessionId);
      actingClient = hostBob.client;
      const draftNotOpen = { ok: false, message: DRAFT_NOT_OPEN };
      expect(
        await addDraftParticipant({
          sessionId: draft.sessionId,
          participantId: randomUUID(),
          firstName: "Bob's",
          lastName: "Friend",
          skillLevel: "beginner",
          gender: "male" as const,
        }),
      ).toEqual(draftNotOpen);
      // Another social's participant looks like one that's already gone.
      expect(
        await removeDraftParticipant({
          sessionId: draft.sessionId,
          participantId: before[0].id,
        }),
      ).toMatchObject({ ok: true });
      expect(await attendeeRows(draft.sessionId)).toEqual(before);

      // Alice's co-host works on the same list.
      actingClient = coHostAna.client;
      const coHostInput = {
        sessionId: draft.sessionId,
        participantId: randomUUID(),
        firstName: "Ana's",
        lastName: RUN_TOKEN,
        skillLevel: "intermediate" as const,
        gender: "male" as const,
      };
      expect(
        listFrom(await addDraftParticipant(coHostInput)).map(
          (participant) => participant.participantId,
        ),
      ).toContain(coHostInput.participantId);
      listFrom(
        await removeDraftParticipant({
          sessionId: draft.sessionId,
          participantId: coHostInput.participantId,
        }),
      );
      expect(await attendeeRows(draft.sessionId)).toEqual(before);
    });

    it("rejects invalid attendance input before touching the database", async () => {
      const draft = await openDraftFor(hostAlice);
      const before = await attendeeRows(draft.sessionId);
      actingClient = hostAlice.client;
      expect(
        await addDraftParticipant({
          sessionId: draft.sessionId,
          participantId: randomUUID(),
          firstName: "Kai",
          lastName: "   ",
          skillLevel: "beginner",
          gender: "male" as const,
        }),
      ).toEqual({ ok: false, message: "Enter a last name." });
      // A level is required for every player (Ryan, 2026-11-11).
      expect(
        await addDraftParticipant({
          sessionId: draft.sessionId,
          participantId: randomUUID(),
          firstName: "Kai",
          lastName: "Lee",
          // What a tampered or outdated page could send.
          skillLevel: "" as "beginner",
          gender: "male",
        }),
      ).toEqual({ ok: false, message: "Choose a level." });
      expect(
        await removeDraftParticipant({
          sessionId: draft.sessionId,
          participantId: "not-a-uuid",
        }),
      ).toMatchObject({ ok: false });
      expect(await attendeeRows(draft.sessionId)).toEqual(before);
    });
  });
  describe("saved setups", () => {
    // Dana and her co-host Eve share a social with its own courts.
    let hostDana: TestHost;
    let coHostEve: TestHost;
    let danaCourts: TestCourts;
    const waitsFirstRotation = {
      objectiveOrder: [
        "shortestWaits",
        "mixPartners",
        "equalGames",
        "playingTime",
        "fullCourts",
        "noBackToBack",
      ],
      rules: {
        preventConsecutive: false,
        fewerGamesFirst: true,
        longestWaitFirst: true,
        mixPartners: true,
        minimiseRepeatOpponents: true,
        allowManualAssignments: false,
      },
    } satisfies RotationPreferences;

    beforeAll(async () => {
      const danaSocialId = await createTestSocial(
        "Integration setup Dana social",
      );
      danaCourts = await createTestCourts(danaSocialId);
      hostDana = await signedInUser("Dana Setups", "host", danaSocialId);
      coHostEve = await signedInUser("Eve Setups", "host", danaSocialId);
      actingClient = hostDana.client;
      expect(
        await startSessionDraft({
          name: "Setups social",
          ...plannedTimes(72),
        }),
      ).toEqual({ ok: true, notice: null });
    });

    function appliedDraft(result: ApplySavedSetupResult) {
      if (!result.ok) throw new Error(`apply failed: ${result.message}`);
      return result;
    }

    /** The host's social's saved setups, oldest first. */
    async function savedSetupRows(host: TestHost) {
      const { data, error } = await admin
        .from("saved_setups")
        .select("id, name, config, last_used_at, host_id")
        .eq("social_id", host.socialId)
        .order("created_at");
      if (error) throw error;
      return data;
    }

    it("saves, lists, replaces and applies a setup without touching attendance", async () => {
      const draft = await openDraftFor(hostDana);
      actingClient = hostDana.client;
      const setupValues = saveInputFor(draft.sessionId, {
        location: "Riverside courts",
        ...plannedTimes(72, 90),
        courtIds: [danaCourts.doublesCourtId],
        matchFormat: "doubles",
        targetMatchMinutes: 12,
        changeoverMinutes: 3,
        rotation: waitsFirstRotation,
      });
      const saved = await saveSetup({
        setupName: "Saturday Social",
        draft: setupValues,
      });
      expect(saved).toMatchObject({
        ok: true,
        message: "Saved \u201cSaturday Social\u201d.",
        savedSetups: [
          {
            name: "Saturday Social",
            courtCount: 1,
            topObjective: "shortestWaits",
          },
        ],
      });

      // Stored without attendance or anything about the session.
      const [setupRow] = await savedSetupRows(hostDana);
      expect(setupRow.config).toEqual({
        location: "Riverside courts",
        durationMinutes: 90,
        courts: [
          {
            courtId: danaCourts.doublesCourtId,
            name: `${RUN_TOKEN} Doubles`,
            format: "doubles",
          },
        ],
        matchFormat: "doubles",
        targetMatchMinutes: 12,
        changeoverMinutes: 3,
        rotation: waitsFirstRotation,
      });

      // The same name in another case replaces it.
      expect(
        await saveSetup({ setupName: "saturday social", draft: setupValues }),
      ).toMatchObject({
        ok: true,
        message: "Replaced \u201csaturday social\u201d.",
      });
      const setupRows = await savedSetupRows(hostDana);
      expect(setupRows).toHaveLength(1);
      expect(setupRows[0].id).toBe(setupRow.id);

      // The draft moves on: other courts, format, length, rotation; a guest arrives.
      expect(
        await saveAtCurrentRevision(
          saveInputFor(draft.sessionId, {
            name: "Dana's Sunday",
            location: "",
            ...plannedTimes(96, 60),
            courtIds: [danaCourts.singlesOnlyCourtId],
            matchFormat: "singles",
            targetMatchMinutes: 20,
            changeoverMinutes: 5,
          }),
        ),
      ).toEqual({ ok: true });
      const guestResult = await addDraftParticipant({
        sessionId: draft.sessionId,
        participantId: randomUUID(),
        firstName: "Kai",
        lastName: "Guest",
        skillLevel: "beginner",
        gender: "male" as const,
      });
      expect(guestResult).toMatchObject({ ok: true });
      const beforeApply = await openDraftFor(hostDana);

      actingClient = hostDana.client;
      const applied = appliedDraft(
        await applyAtCurrentRevision({
          sessionId: draft.sessionId,
          setupId: setupRow.id,
        }),
      );
      expect(applied.notice).toBeNull();
      expect(applied.draft).toMatchObject({
        sessionId: draft.sessionId,
        name: "Dana's Sunday",
        location: "Riverside courts",
        plannedStart: beforeApply.plannedStart,
        participants: beforeApply.participants,
        config: {
          courts: [
            {
              courtId: danaCourts.doublesCourtId,
              name: `${RUN_TOKEN} Doubles`,
              format: "doubles",
            },
          ],
          matchFormat: "doubles",
          targetMatchMinutes: 12,
          changeoverMinutes: 3,
          rotation: waitsFirstRotation,
          appliedSavedSetupId: setupRow.id,
        },
      });
      expect(
        Date.parse(applied.draft.plannedEnd) -
          Date.parse(applied.draft.plannedStart),
      ).toBe(90 * 60_000);
      const [sessionRow] = await socialSessionRows(hostDana);
      expect(
        (sessionRow.config_snapshot as Record<string, unknown>).rotation,
      ).toEqual(waitsFirstRotation);
      expect(applied.savedSetups[0].setupId).toBe(setupRow.id);
      const [usedSetup] = await savedSetupRows(hostDana);
      expect(Date.parse(usedSetup.last_used_at)).toBeGreaterThanOrEqual(
        Date.parse(setupRows[0].last_used_at),
      );

      // Editing the draft afterwards never changes the saved setup.
      expect(
        await saveAtCurrentRevision(
          saveInputFor(draft.sessionId, {
            courtIds: [],
            rotation: recommendedRotationPreferences(),
          }),
        ),
      ).toEqual({ ok: true });
      expect((await savedSetupRows(hostDana))[0].config).toEqual(
        setupRow.config,
      );
    });

    it("leaves out courts that are no longer available, and says which", async () => {
      const draft = await openDraftFor(hostDana);
      const { data: insertedSetup, error } = await admin
        .from("saved_setups")
        .insert({
          social_id: hostDana.socialId,
          host_id: hostDana.userId,
          name: "Has a closed court",
          config: {
            location: null,
            durationMinutes: 120,
            courts: [
              {
                courtId: danaCourts.doublesCourtId,
                name: "Old name",
                format: "doubles",
              },
              {
                courtId: danaCourts.inactiveCourtId,
                name: "Court 5",
                format: "doubles",
              },
            ],
            matchFormat: "doubles",
            targetMatchMinutes: 15,
            changeoverMinutes: 2,
            rotation: recommendedRotationPreferences(),
          } as unknown as NonNullable<Json>,
        })
        .select("id")
        .single();
      if (error) throw error;

      actingClient = hostDana.client;
      const applied = appliedDraft(
        await applyAtCurrentRevision({
          sessionId: draft.sessionId,
          setupId: insertedSetup.id,
        }),
      );
      expect(applied.notice).toBe(
        "Court 5 is no longer available and was left out.",
      );
      // Current names come from the database.
      expect(applied.draft.config.courts).toEqual([
        {
          courtId: danaCourts.doublesCourtId,
          name: `${RUN_TOKEN} Doubles`,
          format: "doubles",
        },
      ]);
      expect(applied.draft.location).toBeNull();
    });

    it("never writes a config it couldn't read back, and lists past a malformed row", async () => {
      const draft = await openDraftFor(hostDana);
      const before = await savedSetupRows(hostDana);
      actingClient = hostDana.client;
      // 20 seconds long: valid times, but it rounds to 0 whole minutes.
      const plannedStart = new Date(Date.now() + 80 * 3_600_000);
      plannedStart.setSeconds(0, 0);
      expect(
        await saveSetup({
          setupName: "Too short",
          draft: saveInputFor(draft.sessionId, {
            plannedStart: plannedStart.toISOString(),
            plannedEnd: new Date(plannedStart.getTime() + 20_000).toISOString(),
          }),
        }),
      ).toEqual({
        ok: false,
        message:
          "This setup can't be saved: Use a whole number of minutes from 1 to 720.",
      });
      expect(await savedSetupRows(hostDana)).toEqual(before);

      const { data: badRow, error } = await admin
        .from("saved_setups")
        .insert({
          social_id: hostDana.socialId,
          host_id: hostDana.userId,
          name: "Malformed",
          config: { durationMinutes: "long" },
          last_used_at: new Date(Date.now() + 60_000).toISOString(),
        })
        .select("id")
        .single();
      if (error) throw error;
      const listed = await listSocialSavedSetups(admin, hostDana.socialId);
      expect(listed.map((setup) => setup.setupId)).not.toContain(badRow.id);
      expect(listed.length).toBe(before.length);
      expect(console.error).toHaveBeenCalledWith(
        "Skipping a saved setup with a malformed config",
        { setupId: badRow.id, socialId: hostDana.socialId },
      );
      await admin.from("saved_setups").delete().eq("id", badRow.id);
    });

    it("shares setups within the social: a co-host lists, applies and replaces them", async () => {
      const draft = await openDraftFor(coHostEve);
      const [danaSetup] = await savedSetupRows(hostDana);
      expect(danaSetup.host_id).toBe(hostDana.userId);

      actingClient = coHostEve.client;
      const listed = await listSocialSavedSetups(
        coHostEve.client,
        coHostEve.socialId,
      );
      expect(listed.map((setup) => setup.setupId)).toContain(danaSetup.id);
      const applied = appliedDraft(
        await applyAtCurrentRevision({
          sessionId: draft.sessionId,
          setupId: danaSetup.id,
        }),
      );
      expect(applied.draft.config.appliedSavedSetupId).toBe(danaSetup.id);

      // Saving under Dana's name replaces the social's setup; Eve saved it last.
      const setupCountBefore = (await savedSetupRows(hostDana)).length;
      expect(
        await saveSetup({
          setupName: danaSetup.name,
          draft: saveInputFor(draft.sessionId, { location: "Eve's courts" }),
        }),
      ).toMatchObject({
        ok: true,
        message: `Replaced \u201c${danaSetup.name}\u201d.`,
      });
      const after = await savedSetupRows(hostDana);
      expect(after).toHaveLength(setupCountBefore);
      expect(after.find((setup) => setup.id === danaSetup.id)).toMatchObject({
        host_id: coHostEve.userId,
        config: expect.objectContaining({ location: "Eve's courts" }),
      });
    });

    it("never lets another social's host see or apply the social's setups", async () => {
      const danaDraft = await openDraftFor(hostDana);
      const [danaSetup] = await savedSetupRows(hostDana);
      const danaSessionsBefore = await socialSessionRows(hostDana);
      const danaSetupsBefore = await savedSetupRows(hostDana);
      const omarSocialSetups = await savedSetupRows(otherSocialManager);

      actingClient = otherSocialManager.client;
      // RLS: nothing of Dana's social, even when asked for it.
      expect(
        await listSocialSavedSetups(
          otherSocialManager.client,
          hostDana.socialId,
        ),
      ).toEqual([]);
      const notFound = {
        ok: false,
        message: "That saved setup isn't available any more. Reload the page.",
      };
      expect(
        await applyAtCurrentRevision({
          sessionId: danaDraft.sessionId,
          setupId: danaSetup.id,
        }),
      ).toEqual(notFound);
      // Saving under the same name makes the other social's own setup.
      expect(
        await saveSetup({
          setupName: danaSetup.name,
          draft: saveInputFor(danaDraft.sessionId),
        }),
      ).toMatchObject({
        ok: true,
        message: `Saved \u201c${danaSetup.name}\u201d.`,
      });
      expect(await savedSetupRows(otherSocialManager)).toHaveLength(
        omarSocialSetups.length + 1,
      );
      expect(await socialSessionRows(hostDana)).toEqual(danaSessionsBefore);
      expect(await savedSetupRows(hostDana)).toEqual(danaSetupsBefore);
    });
  });

  describe("draft settings concurrency", () => {
    const CHANGED_ELSEWHERE = {
      ok: false,
      message:
        "Setup was changed by another host, tab or device. Reload to see the latest \u2014 your unsaved changes here will be lost.",
      isConflict: true,
    };
    // Frank and his co-host Gina share a social.
    let hostFrank: TestHost;
    let coHostGina: TestHost;

    beforeAll(async () => {
      const frankSocialId = await createTestSocial(
        "Integration setup Frank social",
      );
      hostFrank = await signedInUser("Frank Tabs", "host", frankSocialId);
      coHostGina = await signedInUser("Gina Cohost", "host", frankSocialId);
      actingClient = hostFrank.client;
      expect(
        await startSessionDraft({ name: "Two tabs", ...plannedTimes(120) }),
      ).toEqual({ ok: true, notice: null });
    });

    it("refuses a save based on a stale revision and overwrites nothing", async () => {
      const loaded = await openDraftFor(hostFrank);
      expect(loaded.draftRevision).toBe(0);
      actingClient = hostFrank.client;
      // Tab A and tab B both loaded revision 0; A saves first.
      expect(
        await saveSessionDraft(
          saveInputFor(loaded.sessionId, { name: "Tab A" }),
          loaded.draftRevision,
        ),
      ).toEqual({ ok: true, draftRevision: 1 });
      expect(
        await saveSessionDraft(
          saveInputFor(loaded.sessionId, {
            name: "Tab B",
            rotation: {
              ...recommendedRotationPreferences(),
              rules: {
                ...recommendedRotationPreferences().rules,
                mixPartners: false,
              },
            },
          }),
          loaded.draftRevision,
        ),
      ).toEqual(CHANGED_ELSEWHERE);
      const [row] = await socialSessionRows(hostFrank);
      expect(row).toMatchObject({ name: "Tab A", draft_revision: 1 });
      expect(
        (row.config_snapshot as unknown as { rotation: RotationPreferences })
          .rotation,
      ).toEqual(recommendedRotationPreferences());

      // After reloading (revision 1), tab B saves.
      const reloaded = await openDraftFor(hostFrank);
      actingClient = hostFrank.client;
      expect(
        await saveSessionDraft(
          saveInputFor(reloaded.sessionId, { name: "Tab B" }),
          reloaded.draftRevision,
        ),
      ).toEqual({ ok: true, draftRevision: 2 });
    });

    it("refuses a co-host's save based on a revision the other host already moved on", async () => {
      const frankLoaded = await openDraftFor(hostFrank);
      const ginaLoaded = await openDraftFor(coHostGina);
      expect(ginaLoaded).toEqual(frankLoaded);

      actingClient = hostFrank.client;
      expect(
        await saveSessionDraft(
          saveInputFor(frankLoaded.sessionId, { name: "Frank's edit" }),
          frankLoaded.draftRevision,
        ),
      ).toEqual({ ok: true, draftRevision: frankLoaded.draftRevision + 1 });
      actingClient = coHostGina.client;
      expect(
        await saveSessionDraft(
          saveInputFor(ginaLoaded.sessionId, { name: "Gina's edit" }),
          ginaLoaded.draftRevision,
        ),
      ).toEqual(CHANGED_ELSEWHERE);
      expect((await openDraftFor(coHostGina)).name).toBe("Frank's edit");
    });

    it("lets exactly one of two concurrent saves at one revision win", async () => {
      const loaded = await openDraftFor(hostFrank);
      // Straight to the database function, in parallel, as both co-hosts.
      const saveAs = (actor: TestHost, name: string) =>
        admin.rpc("save_session_draft", {
          p_actor_user_id: actor.userId,
          p_session_id: loaded.sessionId,
          p_expected_draft_revision: loaded.draftRevision,
          p_name: name,
          p_location: "",
          p_host_name: "Co-hosts",
          p_planned_start: loaded.plannedStart,
          p_planned_end: loaded.plannedEnd,
          p_config_patch: {},
        });
      const results = await Promise.all([
        saveAs(hostFrank, "Race Frank"),
        saveAs(coHostGina, "Race Gina"),
      ]);
      const winners = results.filter((result) => result.error === null);
      const conflicts = results.filter(
        (result) => result.error?.message === "DRAFT_CHANGED_ELSEWHERE",
      );
      expect(winners).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      const saved = await openDraftFor(hostFrank);
      expect(saved.draftRevision).toBe(loaded.draftRevision + 1);
      expect(["Race Frank", "Race Gina"]).toContain(saved.name);
    });

    it("re-reads only the social's open draft, at its current revision", async () => {
      const loaded = await openDraftFor(hostFrank);
      actingClient = hostFrank.client;
      const saved = await saveSessionDraft(
        saveInputFor(loaded.sessionId, { name: "Flushed from tab" }),
        loaded.draftRevision,
      );
      expect(saved).toEqual({
        ok: true,
        draftRevision: loaded.draftRevision + 1,
      });
      expect(await readSessionDraft(loaded.sessionId)).toEqual({
        ok: true,
        draft: {
          ...(await openDraftFor(hostFrank)),
          name: "Flushed from tab",
          draftRevision: loaded.draftRevision + 1,
        },
      });

      // A co-host re-reads the same draft; another social's host can't.
      actingClient = coHostGina.client;
      expect(await readSessionDraft(loaded.sessionId)).toMatchObject({
        ok: true,
        draft: { sessionId: loaded.sessionId, name: "Flushed from tab" },
      });
      actingClient = hostBob.client;
      expect(await readSessionDraft(loaded.sessionId)).toEqual({
        ok: false,
        message: DRAFT_NOT_OPEN,
      });
      actingClient = hostFrank.client;
      expect(await readSessionDraft(randomUUID())).toEqual({
        ok: false,
        message: DRAFT_NOT_OPEN,
      });
      expect(await readSessionDraft("not-a-uuid")).toEqual({
        ok: false,
        message: "Something went wrong. Try again in a moment.",
      });
    });

    it("doesn't bump the revision for attendance", async () => {
      const loaded = await openDraftFor(hostFrank);
      const guestParticipantId = randomUUID();
      actingClient = hostFrank.client;
      expect(
        await addDraftParticipant({
          sessionId: loaded.sessionId,
          participantId: guestParticipantId,
          firstName: "Tab",
          lastName: "Guest",
          skillLevel: "beginner",
          gender: "male" as const,
        }),
      ).toMatchObject({ ok: true });
      expect((await openDraftFor(hostFrank)).draftRevision).toBe(
        loaded.draftRevision,
      );
      actingClient = hostFrank.client;
      expect(
        await saveSessionDraft(
          saveInputFor(loaded.sessionId),
          loaded.draftRevision,
        ),
      ).toMatchObject({ ok: true });
      // Removing the guest again doesn't bump it either (and lets cleanup
      // delete the draft once it is discarded).
      expect(
        await removeDraftParticipant({
          sessionId: loaded.sessionId,
          participantId: guestParticipantId,
        }),
      ).toMatchObject({ ok: true });
      expect((await openDraftFor(hostFrank)).draftRevision).toBe(
        loaded.draftRevision + 1,
      );
    });

    it("refuses to apply a saved setup over a stale revision", async () => {
      const loaded = await openDraftFor(hostFrank);
      actingClient = hostFrank.client;
      const saved = await saveSetup({
        setupName: "Frank's setup",
        draft: saveInputFor(loaded.sessionId, { location: "Elsewhere" }),
      });
      expect(saved).toMatchObject({ ok: true });
      const [setupRow] = await admin
        .from("saved_setups")
        .select("id, last_used_at")
        .eq("host_id", hostFrank.userId)
        .then(({ data }) => data ?? []);
      const before = await socialSessionRows(hostFrank);

      expect(
        await applySavedSetup({
          sessionId: loaded.sessionId,
          setupId: setupRow.id,
          expectedDraftRevision: loaded.draftRevision - 1,
        }),
      ).toEqual(CHANGED_ELSEWHERE);
      expect(await socialSessionRows(hostFrank)).toEqual(before);
      const { data: unusedSetup } = await admin
        .from("saved_setups")
        .select("last_used_at")
        .eq("id", setupRow.id)
        .single();
      expect(unusedSetup?.last_used_at).toBe(setupRow.last_used_at);

      const applied = await applySavedSetup({
        sessionId: loaded.sessionId,
        setupId: setupRow.id,
        expectedDraftRevision: loaded.draftRevision,
      });
      expect(applied).toMatchObject({
        ok: true,
        draft: {
          location: "Elsewhere",
          draftRevision: loaded.draftRevision + 1,
        },
      });

      // A draft whose revision moved on can still be discarded.
      expect(await discardSessionDraft(loaded.sessionId)).toEqual({ ok: true });
    });
  });
});
