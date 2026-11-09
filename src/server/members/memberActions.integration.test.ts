// @vitest-environment node
// The Members directory against the LOCAL Supabase stack (`pnpm db:start`):
//   * only hosts may add, edit, deactivate or reactivate members, and a
//     refused call changes nothing;
//   * listing, search, filters and paging are correct for 0, 5, 30, 300 and
//     1,200 members (past the Data API's 1,000-row page);
//   * a host only reads and changes their own social's members: another
//     social's member is invisible and answered like a missing one, and its
//     namesakes never trigger the duplicate-name warning.
// Test members carry a unique token in their last name and every query
// searches for it, so other data in the database doesn't interfere. Skips when
// the stack isn't running, unless REQUIRE_LOCAL_SUPABASE=1.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";
import { HOST_ACCESS_DENIAL_MESSAGES } from "@/server/auth/hostAccess";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import { createMember, setMemberActive, updateMember } from "./memberActions";
import {
  countMembersByStatus,
  getMember,
  listMembers,
} from "./memberDirectory";
import {
  DEFAULT_MEMBER_DIRECTORY_QUERY,
  MEMBER_DIRECTORY_PAGE_SIZE,
  SKILL_LEVELS,
  type MemberDirectoryQuery,
  type SkillLevel,
} from "./memberSearch";
import { CONFIRM_DUPLICATE_NAME_FIELD } from "./memberRules";

type DatabaseClient = SupabaseClient<Database>;

// Next.js resolves these itself; plain Vitest runs the actions outside a request.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
class RedirectSignal extends Error {
  constructor(readonly location: string) {
    super(`redirect to ${location}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((location: string) => {
    throw new RedirectSignal(location);
  }),
}));
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
    "Skipping members integration tests: the local Supabase stack is not running (start it with `pnpm db:start`).",
  );
}

/** A letters-only token, unique per run, that no real name contains. */
function uniqueNameToken(label: string): string {
  const letters = randomUUID()
    .replace(/[^a-f]/g, "")
    .slice(0, 10)
    .padEnd(10, "q");
  return `Zq${label}${letters}`;
}

function memberForm(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [name, value] of Object.entries(fields)) formData.set(name, value);
  return formData;
}

/** Runs an action that redirects on success; returns the redirect target. */
async function expectRedirect(action: Promise<unknown>): Promise<string> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof RedirectSignal)) {
    throw new Error(
      `expected a redirect, got ${JSON.stringify(error ?? (await action))}`,
    );
  }
  return error.location;
}

describe.skipIf(!localStack)("members directory (local Supabase)", () => {
  let admin: DatabaseClient;
  let hostClient: DatabaseClient;
  let nonHostClient: DatabaseClient;
  let signedOutClient: DatabaseClient;
  const createdUserIds: string[] = [];
  // The hosts' own social, and another social whose members they never see.
  let socialId: string;
  let otherSocialId: string;

  async function signedInUser(isHost: boolean): Promise<DatabaseClient> {
    const email = `integration-members-${randomUUID()}@example.test`;
    const password = `pw-${randomUUID()}`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    createdUserIds.push(created.data.user.id);
    if (isHost) {
      const { error } = await admin.from("hosts").insert({
        user_id: created.data.user.id,
        display_name: "Members Host",
        role: "host",
        social_id: socialId,
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
    return client;
  }

  /** Inserts `count` members whose last name holds `token`, in batches. */
  async function insertTestMembers(
    token: string,
    count: number,
    memberAt: (index: number) => {
      firstName?: string;
      skillLevel?: SkillLevel | null;
      isActive?: boolean;
    } = () => ({}),
    memberSocialId = socialId,
  ) {
    const rows = Array.from({ length: count }, (_, index) => {
      const overrides = memberAt(index);
      return {
        social_id: memberSocialId,
        first_name:
          overrides.firstName ?? `Member${String(index).padStart(4, "0")}`,
        last_name: token,
        skill_level:
          overrides.skillLevel === undefined
            ? SKILL_LEVELS[index % SKILL_LEVELS.length]
            : overrides.skillLevel,
        is_active: overrides.isActive ?? true,
      };
    });
    for (let start = 0; start < rows.length; start += 500) {
      const { error } = await admin
        .from("members")
        .insert(rows.slice(start, start + 500));
      if (error) throw error;
    }
  }

  /** Every member whose last name holds `token` (read past the 1,000-row cap). */
  async function membersSnapshot(token: string) {
    const rows = [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await admin
        .from("members")
        .select(
          "id, social_id, first_name, last_name, skill_level, is_active, updated_at",
        )
        .ilike("last_name", `%${token}%`)
        .order("id")
        .range(start, start + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }

  function queryFor(
    searchText: string,
    overrides: Partial<MemberDirectoryQuery> = {},
  ): MemberDirectoryQuery {
    return { ...DEFAULT_MEMBER_DIRECTORY_QUERY, searchText, ...overrides };
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
    const { data: social, error: socialError } = await admin
      .from("socials")
      .insert({ name: "Integration members social" })
      .select("id")
      .single();
    if (socialError) throw socialError;
    socialId = social.id;
    const { data: otherSocial, error: otherSocialError } = await admin
      .from("socials")
      .insert({ name: "Integration members other social" })
      .select("id")
      .single();
    if (otherSocialError) throw otherSocialError;
    otherSocialId = otherSocial.id;
    hostClient = await signedInUser(true);
    nonHostClient = await signedInUser(false);
    signedOutClient = createClient<Database>(
      localStack!.apiUrl,
      localStack!.publishableKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  });

  afterAll(async () => {
    await admin.from("hosts").delete().in("user_id", createdUserIds);
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
    // Both socials, with every member the tests added.
    await deleteTestSocials(
      admin,
      [socialId, otherSocialId].filter((id) => id !== undefined),
    );
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

    let existingMemberId: string;
    const authzToken = uniqueNameToken("Authz");

    beforeAll(async () => {
      await insertTestMembers(authzToken, 1);
      existingMemberId = (await membersSnapshot(authzToken))[0].id;
    });

    it.each(refusedCallers)(
      "refuses to add a member for $label and creates nothing",
      async ({ denial, client }) => {
        actingClient = client();
        const before = await membersSnapshot(authzToken);

        const result = await createMember(
          { status: "idle" },
          memberForm({
            firstName: "Should",
            lastName: `Not Exist ${authzToken}`,
            skillLevel: "",
          }),
        );

        expect(result).toMatchObject({
          status: "error",
          message: HOST_ACCESS_DENIAL_MESSAGES[denial],
        });
        expect(await membersSnapshot(authzToken)).toEqual(before);
      },
    );

    it.each(refusedCallers)(
      "refuses to edit a member for $label and changes nothing",
      async ({ denial, client }) => {
        actingClient = client();
        const before = await membersSnapshot(authzToken);

        const result = await updateMember(
          { status: "idle" },
          memberForm({
            memberId: existingMemberId,
            firstName: "Hijacked",
            lastName: authzToken,
            skillLevel: "advanced",
          }),
        );

        expect(result).toMatchObject({
          status: "error",
          message: HOST_ACCESS_DENIAL_MESSAGES[denial],
        });
        expect(await membersSnapshot(authzToken)).toEqual(before);
      },
    );

    it.each(refusedCallers)(
      "refuses to deactivate a member for $label and changes nothing",
      async ({ denial, client }) => {
        actingClient = client();
        const before = await membersSnapshot(authzToken);

        const result = await setMemberActive(
          { status: "idle" },
          memberForm({ memberId: existingMemberId, isActive: "false" }),
        );

        expect(result).toEqual({
          status: "error",
          message: HOST_ACCESS_DENIAL_MESSAGES[denial],
        });
        expect(await membersSnapshot(authzToken)).toEqual(before);
      },
    );

    it("shows a signed-in non-host no members at all (RLS)", async () => {
      actingClient = nonHostClient;
      expect(await listMembers(queryFor(authzToken))).toEqual({
        members: [],
        matchingMemberCount: 0,
      });
      expect(await getMember(existingMemberId)).toBeNull();
      expect(await countMembersByStatus()).toEqual({
        activeMemberCount: 0,
        deactivatedMemberCount: 0,
      });
    });

    it("refuses a signed-out visitor any read (no grant for anon)", async () => {
      actingClient = signedOutClient;
      await expect(listMembers(queryFor(authzToken))).rejects.toThrow(
        /permission denied/,
      );
      await expect(getMember(existingMemberId)).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe("a host manages members", () => {
    it("adds, warns about a duplicate name, edits, deactivates and reactivates", async () => {
      actingClient = hostClient;
      const token = uniqueNameToken("Flow");

      // Validation errors come back per field, and nothing is written.
      const invalid = await createMember(
        { status: "idle" },
        memberForm({ firstName: " ", lastName: token, skillLevel: "pro" }),
      );
      expect(invalid).toMatchObject({
        status: "error",
        fieldErrors: {
          firstName: "Enter a first name.",
          skillLevel: "Choose a skill level from the list.",
        },
        submittedValues: { firstName: " ", lastName: token, skillLevel: "pro" },
      });
      expect(await membersSnapshot(token)).toHaveLength(0);

      const location = await expectRedirect(
        createMember(
          { status: "idle" },
          memberForm({
            firstName: "  Élodie ",
            lastName: token,
            skillLevel: "",
          }),
        ),
      );
      const [created] = await membersSnapshot(token);
      expect(location).toBe(`/members?saved=${created.id}`);
      expect(created).toMatchObject({
        first_name: "Élodie",
        last_name: token,
        skill_level: null,
        is_active: true,
      });

      // Same name, any case: a warning, nothing saved...
      const duplicate = await createMember(
        { status: "idle" },
        memberForm({
          firstName: "élodie",
          lastName: token.toUpperCase(),
          skillLevel: "beginner",
        }),
      );
      expect(duplicate).toMatchObject({
        status: "duplicate_name",
        duplicateNameKey: `elodie ${token.toLowerCase()}`,
      });
      expect(await membersSnapshot(token)).toHaveLength(1);
      // ...until the host confirms it's a different person, for this name.
      if (duplicate.status !== "duplicate_name") throw new Error("unreachable");
      await expectRedirect(
        createMember(
          { status: "idle" },
          memberForm({
            firstName: "élodie",
            lastName: token.toUpperCase(),
            skillLevel: "beginner",
            [CONFIRM_DUPLICATE_NAME_FIELD]: duplicate.duplicateNameKey,
          }),
        ),
      );
      expect(await membersSnapshot(token)).toHaveLength(2);

      // Editing only the skill of a namesake doesn't warn again.
      await expectRedirect(
        updateMember(
          { status: "idle" },
          memberForm({
            memberId: created.id,
            firstName: "Élodie",
            lastName: token,
            skillLevel: "advanced",
          }),
        ),
      );
      expect(await getMember(created.id)).toMatchObject({
        skillLevel: "advanced",
      });

      // Search is accent- and case-insensitive.
      const accentFree = await listMembers(queryFor(`elodie ${token}`));
      expect(accentFree.matchingMemberCount).toBe(2);

      // Deactivate: gone from the active list, shown under deactivated.
      expect(
        await setMemberActive(
          { status: "idle" },
          memberForm({ memberId: created.id, isActive: "false" }),
        ),
      ).toEqual({ status: "idle" });
      expect(
        (await listMembers(queryFor(token))).members.map(({ id }) => id),
      ).not.toContain(created.id);
      expect(
        (
          await listMembers(queryFor(token, { status: "deactivated" }))
        ).members.map(({ id }) => id),
      ).toEqual([created.id]);
      // An inactive namesake doesn't count as a duplicate.
      await expectRedirect(
        updateMember(
          { status: "idle" },
          memberForm({
            memberId: created.id,
            firstName: "Elodie",
            lastName: token,
            skillLevel: "advanced",
          }),
        ),
      );

      // Reactivate.
      expect(
        await setMemberActive(
          { status: "idle" },
          memberForm({ memberId: created.id, isActive: "true" }),
        ),
      ).toEqual({ status: "idle" });
      expect(await getMember(created.id)).toMatchObject({ isActive: true });
    });

    it("spots duplicates ignoring case, accents and spacing, treats * literally, and binds 'Save anyway' to the warned name", async () => {
      actingClient = hostClient;
      const token = uniqueNameToken("Dup");
      const add = (firstName: string, lastName: string, confirmKey = "") =>
        createMember(
          { status: "idle" },
          memberForm({
            firstName,
            lastName,
            skillLevel: "",
            ...(confirmKey && { [CONFIRM_DUPLICATE_NAME_FIELD]: confirmKey }),
          }),
        );

      await expectRedirect(add("Zoë", `Núñez ${token}`));
      // Same person written without accents, in another case, extra spaces.
      const accentFree = await add("ZOE", `nunez   ${token}`);
      expect(accentFree).toMatchObject({ status: "duplicate_name" });

      // "*" is an ordinary character: only the exact name is a duplicate.
      await expectRedirect(add("Ja*ne", token));
      expect(await add("ja*ne", token)).toMatchObject({
        status: "duplicate_name",
      });
      await expectRedirect(add("Jaxne", token));

      // A stale confirmation (old "yes" value, or another warned name) doesn't
      // skip the check for a different name.
      expect(await add("Zoe", `Nunez ${token}`, "yes")).toMatchObject({
        status: "duplicate_name",
      });
      if (accentFree.status !== "duplicate_name")
        throw new Error("unreachable");
      expect(
        await add("Ja*ne", token, accentFree.duplicateNameKey),
      ).toMatchObject({ status: "duplicate_name" });
      expect(await membersSnapshot(token)).toHaveLength(3);

      // Renaming someone onto an existing name warns; the warned key confirms it.
      const [jaxne] = (await membersSnapshot(token)).filter(
        (member) => member.first_name === "Jaxne",
      );
      const rename = await updateMember(
        { status: "idle" },
        memberForm({
          memberId: jaxne.id,
          firstName: "Zoe",
          lastName: `Nunez ${token}`,
          skillLevel: "",
        }),
      );
      expect(rename).toMatchObject({ status: "duplicate_name" });
      if (rename.status !== "duplicate_name") throw new Error("unreachable");
      await expectRedirect(
        updateMember(
          { status: "idle" },
          memberForm({
            memberId: jaxne.id,
            firstName: "Zoe",
            lastName: `Nunez ${token}`,
            skillLevel: "",
            [CONFIRM_DUPLICATE_NAME_FIELD]: rename.duplicateNameKey,
          }),
        ),
      );
    });

    it("finds a stored name containing * by searching for it", async () => {
      actingClient = hostClient;
      const token = uniqueNameToken("Star");
      await insertTestMembers(token, 3, (index) => ({
        firstName: ["Ja*ne", "Jane", "Jxne"][index],
      }));

      const starSearch = await listMembers(queryFor(`ja*ne ${token}`));
      expect(starSearch.members.map(({ firstName }) => firstName)).toEqual([
        "Ja*ne",
      ]);
      // "*" stands for one character: never a run of them like "%".
      expect(
        (await listMembers(queryFor(`j*ne ${token}`))).members.map(
          ({ firstName }) => firstName,
        ),
      ).toEqual(["Jane", "Jxne"]);
    });

    it("refuses a missing or malformed member id without writing", async () => {
      actingClient = hostClient;
      for (const memberId of [randomUUID(), "not-a-uuid"]) {
        expect(
          await updateMember(
            { status: "idle" },
            memberForm({
              memberId,
              firstName: "Ghost",
              lastName: "Member",
              skillLevel: "",
            }),
          ),
        ).toMatchObject({
          status: "error",
          message: "This member no longer exists. Go back to Members.",
        });
        expect(
          await setMemberActive(
            { status: "idle" },
            memberForm({ memberId, isActive: "false" }),
          ),
        ).toEqual({
          status: "error",
          message: "This member no longer exists. Go back to Members.",
        });
      }
    });
  });

  describe("another social's members", () => {
    const otherToken = uniqueNameToken("Other");
    let otherMemberId: string;

    beforeAll(async () => {
      await insertTestMembers(
        otherToken,
        1,
        () => ({ firstName: "Omari" }),
        otherSocialId,
      );
      otherMemberId = (await membersSnapshot(otherToken))[0].id;
    });

    it("are invisible to the host (RLS)", async () => {
      actingClient = hostClient;
      expect(await listMembers(queryFor(otherToken))).toEqual({
        members: [],
        matchingMemberCount: 0,
      });
      expect(
        await listMembers(queryFor(otherToken, { status: "deactivated" })),
      ).toEqual({ members: [], matchingMemberCount: 0 });
      expect(await getMember(otherMemberId)).toBeNull();
    });

    it("can't be edited, deactivated or reactivated: answered like a missing member", async () => {
      actingClient = hostClient;
      const before = await membersSnapshot(otherToken);
      const memberNotFound =
        "This member no longer exists. Go back to Members.";

      expect(
        await updateMember(
          { status: "idle" },
          memberForm({
            memberId: otherMemberId,
            firstName: "Hijacked",
            lastName: otherToken,
            skillLevel: "advanced",
          }),
        ),
      ).toMatchObject({ status: "error", message: memberNotFound });
      for (const isActive of ["false", "true"]) {
        expect(
          await setMemberActive(
            { status: "idle" },
            memberForm({ memberId: otherMemberId, isActive }),
          ),
        ).toEqual({ status: "error", message: memberNotFound });
      }
      expect(await membersSnapshot(otherToken)).toEqual(before);
    });

    it("never trigger the duplicate-name warning, and new members join the host's social", async () => {
      actingClient = hostClient;
      // Adding a namesake of the other social's Omari: no warning.
      const location = await expectRedirect(
        createMember(
          { status: "idle" },
          memberForm({
            firstName: "Omari",
            lastName: otherToken,
            skillLevel: "",
          }),
        ),
      );
      const rows = await membersSnapshot(otherToken);
      expect(rows).toHaveLength(2);
      const created = rows.find((row) => row.id !== otherMemberId)!;
      expect(location).toBe(`/members?saved=${created.id}`);
      expect(created.social_id).toBe(socialId);
      expect(rows.find((row) => row.id === otherMemberId)?.social_id).toBe(
        otherSocialId,
      );

      // Renaming one of ours onto a name only the other social has: no warning.
      await insertTestMembers(
        otherToken,
        1,
        () => ({ firstName: "Priya" }),
        otherSocialId,
      );
      await insertTestMembers(otherToken, 1, () => ({ firstName: "Rena" }));
      const rena = (await membersSnapshot(otherToken)).find(
        (row) => row.first_name === "Rena",
      )!;
      await expectRedirect(
        updateMember(
          { status: "idle" },
          memberForm({
            memberId: rena.id,
            firstName: "Priya",
            lastName: otherToken,
            skillLevel: "",
          }),
        ),
      );
    });
  });

  describe("listing, search and paging", () => {
    it("returns nothing for a search with 0 matching members", async () => {
      actingClient = hostClient;
      const token = uniqueNameToken("Zero");
      expect(await listMembers(queryFor(token))).toEqual({
        members: [],
        matchingMemberCount: 0,
      });
      // A huge page number is harmless.
      expect(
        await listMembers(queryFor(token, { pageCount: 999_999 })),
      ).toEqual({ members: [], matchingMemberCount: 0 });
    });

    it.each([5, 30, 300, 1_200])(
      "lists, filters and pages %i members correctly",
      { timeout: 60_000 },
      async (memberCount) => {
        actingClient = hostClient;
        const token = uniqueNameToken(`N${memberCount}`);
        // Every 10th member is deactivated; levels rotate, every 7th has none.
        await insertTestMembers(token, memberCount, (index) => ({
          isActive: index % 10 !== 9,
          skillLevel:
            index % 7 === 6 ? null : SKILL_LEVELS[index % SKILL_LEVELS.length],
        }));
        const all = await membersSnapshot(token);
        expect(all).toHaveLength(memberCount);
        const active = all.filter((member) => member.is_active);
        const deactivatedCount = memberCount - active.length;

        // First page: at most one page, total count is the full match.
        const firstPage = await listMembers(queryFor(token));
        expect(firstPage.matchingMemberCount).toBe(active.length);
        expect(firstPage.members).toHaveLength(
          Math.min(active.length, MEMBER_DIRECTORY_PAGE_SIZE),
        );

        // "Show more" until everything is shown: every active member exactly once, in name order.
        const pagesNeeded = Math.ceil(
          active.length / MEMBER_DIRECTORY_PAGE_SIZE,
        );
        const everything = await listMembers(
          queryFor(token, { pageCount: pagesNeeded }),
        );
        expect(everything.members).toHaveLength(active.length);
        expect(new Set(everything.members.map(({ id }) => id))).toEqual(
          new Set(active.map(({ id }) => id)),
        );
        const shownFirstNames = everything.members.map(
          ({ firstName }) => firstName,
        );
        expect(shownFirstNames).toEqual([...shownFirstNames].sort());
        // Each window starts with the previous one (stable order across pages).
        expect(everything.members.slice(0, firstPage.members.length)).toEqual(
          firstPage.members,
        );
        // Asking for more pages than exist returns the same, no more.
        expect(
          await listMembers(queryFor(token, { pageCount: pagesNeeded + 5 })),
        ).toEqual(everything);

        // Skill filter.
        for (const skillLevel of SKILL_LEVELS) {
          const filtered = await listMembers(
            queryFor(token, { skillLevel, pageCount: pagesNeeded }),
          );
          const expectedCount = active.filter(
            (member) => member.skill_level === skillLevel,
          ).length;
          expect(filtered.matchingMemberCount).toBe(expectedCount);
          expect(filtered.members).toHaveLength(expectedCount);
          expect(
            filtered.members.every(
              (member) => member.skillLevel === skillLevel,
            ),
          ).toBe(true);
        }

        // Status filter.
        const deactivated = await listMembers(
          queryFor(token, { status: "deactivated", pageCount: pagesNeeded }),
        );
        expect(deactivated.matchingMemberCount).toBe(deactivatedCount);
        expect(deactivated.members.every((member) => !member.isActive)).toBe(
          true,
        );

        // Search narrows on first + last name; wildcards in the text are literal.
        const oneMember = await listMembers(
          queryFor(`${active[0].first_name.toLowerCase()} ${token}`),
        );
        expect(oneMember.members.map(({ id }) => id)).toEqual([active[0].id]);
        for (const wildcard of ["%", "_", "*", "\\"]) {
          expect(
            (await listMembers(queryFor(`${token}${wildcard}`)))
              .matchingMemberCount,
          ).toBe(0);
        }
        expect(
          (await listMembers(queryFor(`member0 ${token}`))).matchingMemberCount,
        ).toBe(0); // "member0 <token>" isn't a substring of "Member0000 <token>"
        expect(
          (await listMembers(queryFor(token.slice(2).toUpperCase())))
            .matchingMemberCount,
        ).toBe(active.length);
      },
    );
  });
});
