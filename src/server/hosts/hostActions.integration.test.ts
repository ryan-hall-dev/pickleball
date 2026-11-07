// @vitest-environment node
// Authorisation of the host-management server actions against the LOCAL
// Supabase stack (`pnpm db:start`): only admins may invite or remove hosts, and
// a refused call changes nothing. Skips when the stack isn't running, unless
// REQUIRE_LOCAL_SUPABASE=1, which makes a missing stack a failure.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";
import { HOST_ACCESS_DENIAL_MESSAGES } from "@/server/auth/hostAccess";
import { inviteHost, removeHost } from "./hostActions";
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

describe.skipIf(!localStack)(
  "host actions authorisation (local Supabase)",
  () => {
    let admin: DatabaseClient;
    const createdUserIds: string[] = [];
    let adminUserId: string;
    let adminClient: DatabaseClient;
    let plainHostUserId: string;
    let plainHostClient: DatabaseClient;
    let nonHostClient: DatabaseClient;
    let signedOutClient: DatabaseClient;

    async function signedInUser(
      hostRole: "admin" | "host" | null,
    ): Promise<{ userId: string; client: DatabaseClient }> {
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
      if (hostRole) {
        const { error } = await admin.from("hosts").insert({
          user_id: userId,
          display_name: `Authz ${hostRole}`,
          role: hostRole,
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
      return { userId, client };
    }

    async function hostsSnapshot() {
      const { data, error } = await admin
        .from("hosts")
        .select("user_id, display_name, role, checkin_tag")
        .order("user_id");
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
      ({ userId: adminUserId, client: adminClient } =
        await signedInUser("admin"));
      ({ userId: plainHostUserId, client: plainHostClient } =
        await signedInUser("host"));
      ({ client: nonHostClient } = await signedInUser(null));
      signedOutClient = createClient<Database>(
        localStack!.apiUrl,
        localStack!.publishableKey,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
    });

    afterAll(async () => {
      // Hosts rows first, so the last-admin guard never sees a lone admin go.
      await admin.from("hosts").delete().in("user_id", createdUserIds);
      for (const userId of createdUserIds) {
        await admin.auth.admin.deleteUser(userId);
      }
      vi.unstubAllEnvs();
    });

    const refusedCallers = [
      {
        label: "a plain host",
        denial: "NOT_AN_ADMIN",
        client: () => plainHostClient,
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
      },
    );

    it.each(refusedCallers)(
      "refuses a removal from $label and removes nothing",
      async ({ denial, client }) => {
        actingClient = client();
        const hostsBefore = await hostsSnapshot();

        const result = await removeHost(
          { status: "idle" },
          removeForm(adminUserId),
        );

        expect(result).toEqual({
          status: "error",
          message: HOST_ACCESS_DENIAL_MESSAGES[denial],
        });
        expect(await hostsSnapshot()).toEqual(hostsBefore);
        expect(await authUserExists((_, id) => id === adminUserId)).toBe(true);
      },
    );

    it("refuses to let an admin remove themselves", async () => {
      actingClient = adminClient;
      const hostsBefore = await hostsSnapshot();

      const result = await removeHost(
        { status: "idle" },
        removeForm(adminUserId),
      );

      expect(result).toEqual({
        status: "error",
        message: HOST_REMOVAL_DENIAL_MESSAGES.CANNOT_REMOVE_SELF,
      });
      expect(await hostsSnapshot()).toEqual(hostsBefore);
    });

    it("lets an admin invite and remove a host (control case)", async () => {
      actingClient = adminClient;
      const inviteeEmail = `integration-invitee-${randomUUID()}@example.test`;
      const inviteeName = `Invited ${randomUUID().slice(0, 8)}`;

      const invited = await inviteHost(
        { status: "idle" },
        inviteForm(inviteeEmail, inviteeName),
      );
      expect(invited.status).toBe("success");
      const { data: inviteeRow } = await admin
        .from("hosts")
        .select("user_id, role, checkin_tag")
        .eq("display_name", inviteeName)
        .single();
      expect(inviteeRow).toMatchObject({ role: "host" });
      expect(inviteeRow!.checkin_tag).toMatch(/^[a-z0-9_-]{16,64}$/);

      const removed = await removeHost(
        { status: "idle" },
        removeForm(inviteeRow!.user_id),
      );
      expect(removed).toEqual({ status: "idle" });
      expect(await authUserExists((email) => email === inviteeEmail)).toBe(
        false,
      );
      // The plain host is untouched throughout.
      expect(await authUserExists((_, id) => id === plainHostUserId)).toBe(
        true,
      );
    });
  },
);
