// @vitest-environment node
// The Hosts page's server actions against the LOCAL Supabase stack
// (`pnpm db:start`), with two socials: only a social manager may invite or
// remove hosts or rename the social, only within their own social, and a
// refused call changes nothing. Skips when the stack isn't running, unless
// REQUIRE_LOCAL_SUPABASE=1, which makes a missing stack a failure.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";
import { HOST_ACCESS_DENIAL_MESSAGES } from "@/server/auth/hostAccess";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import { updateSocialName } from "@/server/socials/socialActions";
import { inviteHost, removeHost } from "./hostActions";
import { listHosts } from "./hostDirectory";
import { HOST_REMOVAL_DENIAL_MESSAGES } from "./hostRules";

type DatabaseClient = SupabaseClient<Database>;

// Next.js resolves these itself; plain Vitest runs the actions outside a request.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
    "Skipping hostActions integration tests: the local Supabase stack is not running (start it with `pnpm db:start`).",
  );
}

function inviteForm(email: string, displayName: string): FormData {
  const formData = new FormData();
  formData.set("email", email);
  formData.set("displayName", displayName);
  return formData;
}

function removeForm(hostUserId: string): FormData {
  const formData = new FormData();
  formData.set("hostUserId", hostUserId);
  return formData;
}

function socialNameForm(socialName: string): FormData {
  const formData = new FormData();
  formData.set("socialName", socialName);
  return formData;
}

describe.skipIf(!localStack)(
  "host and social actions authorisation (local Supabase)",
  () => {
    let admin: DatabaseClient;
    const createdUserIds: string[] = [];
    const createdSocialIds: string[] = [];
    let socialAId: string;
    let socialBId: string;
    let managerA: SignedInUser;
    let secondManagerA: SignedInUser;
    let plainHostA: SignedInUser;
    let managerB: SignedInUser;
    let plainHostB: SignedInUser & { email: string };
    let nonHostClient: DatabaseClient;
    let signedOutClient: DatabaseClient;

    interface SignedInUser {
      userId: string;
      client: DatabaseClient;
    }

    async function createSocial(label: string): Promise<string> {
      const { data, error } = await admin
        .from("socials")
        .insert({ name: `Integration ${label} ${randomUUID().slice(0, 8)}` })
        .select("id")
        .single();
      if (error) throw error;
      createdSocialIds.push(data.id);
      return data.id;
    }

    async function signedInUser(
      host: { role: "manager" | "host"; socialId: string } | null,
    ): Promise<SignedInUser & { email: string }> {
      const email = `integration-hosts-${randomUUID()}@example.test`;
      const password = `pw-${randomUUID()}`;
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created.error) throw created.error;
      const userId = created.data.user.id;
      createdUserIds.push(userId);
      if (host) {
        const { error } = await admin.from("hosts").insert({
          user_id: userId,
          display_name: `Authz ${host.role}`,
          role: host.role,
          social_id: host.socialId,
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
      return { userId, client, email };
    }

    // Scoped to this file's users: other integration files run in parallel
    // against the same database and add or remove their own hosts.
    async function hostsSnapshot() {
      const { data, error } = await admin
        .from("hosts")
        .select("user_id, display_name, role, social_id")
        .in("user_id", createdUserIds)
        .order("user_id");
      if (error) throw error;
      return data;
    }

    async function socialNames() {
      const { data, error } = await admin
        .from("socials")
        .select("id, name")
        .in("id", createdSocialIds)
        .order("id");
      if (error) throw error;
      return data;
    }

    async function authUserExists(
      predicate: (email: string, id: string) => boolean,
    ) {
      const { data, error } = await admin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      if (error) throw error;
      return data.users.some((user) => predicate(user.email ?? "", user.id));
    }

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
      socialAId = await createSocial("Social A");
      socialBId = await createSocial("Social B");
      managerA = await signedInUser({ role: "manager", socialId: socialAId });
      secondManagerA = await signedInUser({
        role: "manager",
        socialId: socialAId,
      });
      plainHostA = await signedInUser({ role: "host", socialId: socialAId });
      managerB = await signedInUser({ role: "manager", socialId: socialBId });
      plainHostB = await signedInUser({ role: "host", socialId: socialBId });
      ({ client: nonHostClient } = await signedInUser(null));
      signedOutClient = createClient<Database>(
        localStack!.apiUrl,
        localStack!.publishableKey,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
    });

    afterAll(async () => {
      // All hosts rows in one statement: emptying a social passes the
      // last-manager guard, removing its managers one by one would not.
      await admin.from("hosts").delete().in("user_id", createdUserIds);
      for (const userId of createdUserIds) {
        await admin.auth.admin.deleteUser(userId);
      }
      await deleteTestSocials(admin, createdSocialIds);
      vi.unstubAllEnvs();
    });

    const refusedCallers = [
      {
        label: "a plain host",
        denial: "NOT_A_MANAGER",
        client: () => plainHostA.client,
      },
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
      "refuses an invite from $label and creates nothing",
      async ({ denial, client }) => {
        actingClient = client();
        const inviteeEmail = `integration-invitee-${randomUUID()}@example.test`;
        const hostsBefore = await hostsSnapshot();

        const result = await inviteHost(
          { status: "idle" },
          inviteForm(inviteeEmail, "Should Not Exist"),
        );

        expect(result).toMatchObject({
          status: "error",
          message: HOST_ACCESS_DENIAL_MESSAGES[denial],
        });
        expect(await hostsSnapshot()).toEqual(hostsBefore);
        expect(await authUserExists((email) => email === inviteeEmail)).toBe(
          false,
        );
        const { count, error } = await admin
          .from("hosts")
          .select("user_id", { count: "exact", head: true })
          .eq("display_name", "Should Not Exist");
        if (error) throw error;
        expect(count).toBe(0);
      },
    );

    it.each(refusedCallers)(
      "refuses a removal from $label and removes nothing",
      async ({ denial, client }) => {
        actingClient = client();
        const hostsBefore = await hostsSnapshot();

        const result = await removeHost(
          { status: "idle" },
          removeForm(plainHostA.userId),
        );

        expect(result).toEqual({
          status: "error",
          message: HOST_ACCESS_DENIAL_MESSAGES[denial],
        });
        expect(await hostsSnapshot()).toEqual(hostsBefore);
        expect(await authUserExists((_, id) => id === plainHostA.userId)).toBe(
          true,
        );
      },
    );

    it("refuses to let a manager remove themselves", async () => {
      actingClient = managerA.client;
      const hostsBefore = await hostsSnapshot();

      const result = await removeHost(
        { status: "idle" },
        removeForm(managerA.userId),
      );

      expect(result).toEqual({
        status: "error",
        message: HOST_REMOVAL_DENIAL_MESSAGES.CANNOT_REMOVE_SELF,
      });
      expect(await hostsSnapshot()).toEqual(hostsBefore);
    });

    it("refuses to let a manager remove another manager of their social", async () => {
      actingClient = managerA.client;
      const hostsBefore = await hostsSnapshot();

      const result = await removeHost(
        { status: "idle" },
        removeForm(secondManagerA.userId),
      );

      expect(result).toEqual({
        status: "error",
        message: HOST_REMOVAL_DENIAL_MESSAGES.CANNOT_REMOVE_MANAGER,
      });
      expect(await hostsSnapshot()).toEqual(hostsBefore);
      expect(
        await authUserExists((_, id) => id === secondManagerA.userId),
      ).toBe(true);
    });

    it("treats another social's host as not found and leaves them untouched", async () => {
      actingClient = managerA.client;
      const hostsBefore = await hostsSnapshot();

      const result = await removeHost(
        { status: "idle" },
        removeForm(plainHostB.userId),
      );

      expect(result).toEqual({
        status: "error",
        message: HOST_REMOVAL_DENIAL_MESSAGES.HOST_NOT_FOUND,
      });
      expect(await hostsSnapshot()).toEqual(hostsBefore);
      expect(await authUserExists((_, id) => id === plainHostB.userId)).toBe(
        true,
      );
    });

    it("refuses to delete the login of a social's only manager while the social has a host", async () => {
      // Through GoTrue (supabase_auth_admin): the cascade to `hosts` runs the
      // deferred, security-definer last-manager guard at commit.
      const hostsBefore = await hostsSnapshot();

      const { error } = await admin.auth.admin.deleteUser(managerB.userId);

      expect(error).not.toBeNull();
      expect(await hostsSnapshot()).toEqual(hostsBefore);
      expect(await authUserExists((_, id) => id === managerB.userId)).toBe(
        true,
      );
    });

    it("lists only the caller's own social's hosts, managers first", async () => {
      actingClient = managerA.client;
      const listedForA = await listHosts();
      expect(listedForA.map((host) => host.userId).sort()).toEqual(
        [managerA.userId, secondManagerA.userId, plainHostA.userId].sort(),
      );
      expect(listedForA.map((host) => host.role)).toEqual([
        "manager",
        "manager",
        "host",
      ]);

      actingClient = plainHostB.client;
      expect((await listHosts()).map((host) => host.userId).sort()).toEqual(
        [managerB.userId, plainHostB.userId].sort(),
      );
    });

    it("refuses to invite another social's host with a neutral message", async () => {
      actingClient = managerA.client;
      const hostsBefore = await hostsSnapshot();

      const result = await inviteHost(
        { status: "idle" },
        inviteForm(plainHostB.email, "Poached Host"),
      );

      expect(result).toMatchObject({
        status: "error",
        message: "That email can't be invited here. Use a different email.",
      });
      expect(await hostsSnapshot()).toEqual(hostsBefore);
    });

    it("tells a manager when the invitee already hosts their social", async () => {
      actingClient = managerA.client;
      const { data: plainHostAUser } = await admin.auth.admin.getUserById(
        plainHostA.userId,
      );

      const result = await inviteHost(
        { status: "idle" },
        inviteForm(plainHostAUser.user!.email!, "Again"),
      );

      expect(result).toMatchObject({
        status: "error",
        message: "That person is already a host.",
      });
    });

    it("lets a manager invite a host into their own social and remove them (control case)", async () => {
      actingClient = managerA.client;
      const inviteeEmail = `integration-invitee-${randomUUID()}@example.test`;
      const inviteeName = `Invited ${randomUUID().slice(0, 8)}`;

      const invited = await inviteHost(
        { status: "idle" },
        inviteForm(inviteeEmail, inviteeName),
      );
      expect(invited.status).toBe("success");
      const { data: inviteeRow } = await admin
        .from("hosts")
        .select("user_id, role, social_id")
        .eq("display_name", inviteeName)
        .single();
      expect(inviteeRow).toMatchObject({ role: "host", social_id: socialAId });
      createdUserIds.push(inviteeRow!.user_id);

      // Social B's manager can't see or remove A's new host.
      actingClient = managerB.client;
      expect(
        (await listHosts()).some((host) => host.userId === inviteeRow!.user_id),
      ).toBe(false);
      expect(
        await removeHost({ status: "idle" }, removeForm(inviteeRow!.user_id)),
      ).toEqual({
        status: "error",
        message: HOST_REMOVAL_DENIAL_MESSAGES.HOST_NOT_FOUND,
      });

      actingClient = managerA.client;
      const removed = await removeHost(
        { status: "idle" },
        removeForm(inviteeRow!.user_id),
      );
      expect(removed).toEqual({ status: "idle" });
      expect(await authUserExists((email) => email === inviteeEmail)).toBe(
        false,
      );
      // The plain host is untouched throughout.
      expect(await authUserExists((_, id) => id === plainHostA.userId)).toBe(
        true,
      );
    });

    describe("updateSocialName", () => {
      it.each(refusedCallers)(
        "refuses a rename from $label and renames nothing",
        async ({ denial, client }) => {
          actingClient = client();
          const namesBefore = await socialNames();

          const result = await updateSocialName(
            { status: "idle" },
            socialNameForm("Should Not Stick"),
          );

          expect(result).toMatchObject({
            status: "error",
            message: HOST_ACCESS_DENIAL_MESSAGES[denial],
          });
          expect(await socialNames()).toEqual(namesBefore);
        },
      );

      it("refuses an invalid name", async () => {
        actingClient = managerA.client;
        const namesBefore = await socialNames();

        const result = await updateSocialName(
          { status: "idle" },
          socialNameForm("   "),
        );

        expect(result).toMatchObject({
          status: "error",
          fieldError: "Enter the social's name.",
        });
        expect(await socialNames()).toEqual(namesBefore);
      });

      it("renames only the manager's own social", async () => {
        actingClient = managerA.client;
        const socialBNameBefore = (await socialNames()).find(
          (social) => social.id === socialBId,
        )!.name;
        const newName = `Renamed A ${randomUUID().slice(0, 8)}`;

        const result = await updateSocialName(
          { status: "idle" },
          socialNameForm(`  ${newName}  `),
        );

        expect(result).toEqual({
          status: "success",
          message: `The social is now ${newName}.`,
        });
        const namesAfter = await socialNames();
        expect(namesAfter.find((social) => social.id === socialAId)!.name).toBe(
          newName,
        );
        expect(namesAfter.find((social) => social.id === socialBId)!.name).toBe(
          socialBNameBefore,
        );
      });
    });
  },
);
