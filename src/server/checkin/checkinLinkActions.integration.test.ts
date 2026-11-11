// @vitest-environment node
// Issuing a new check-in link (M5 increment 4) against the LOCAL Supabase
// stack (`pnpm db:start`), with two socials: only the social's manager may
// issue one, the old /t/<tag> stops resolving at once (get_checkin_page
// answers inactive) while the new one works, a refused call changes nothing,
// another social's link is untouched, and every host reads (and the QR code
// encodes) only their own social's current link. Skips when the stack isn't
// running, unless REQUIRE_LOCAL_SUPABASE=1, which makes a missing stack a
// failure.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { encode, QrCodeDataType } from "uqr";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";
import { HOST_ACCESS_DENIAL_MESSAGES } from "@/server/auth/hostAccess";
import { decodeQrModules } from "@/server/testing/decodeQrModules";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import {
  CHECKIN_QR_ERROR_CORRECTION_LEVEL,
  readCheckinLink,
} from "./checkinLink";
import { reissueCheckinLink } from "./checkinLinkActions";
import { fetchCheckinPage } from "./checkinPage";

type DatabaseClient = SupabaseClient<Database>;

// Next.js resolves these itself; plain Vitest runs the actions outside a request.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
vi.mock("next/headers", () => ({
  headers: vi.fn(
    async () =>
      new Headers({
        "x-forwarded-host": "pickleball.example",
        "x-forwarded-proto": "https",
      }),
  ),
}));
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
    "Skipping checkinLinkActions integration tests: the local Supabase stack is not running (start it with `pnpm db:start`).",
  );
}

describe.skipIf(!localStack)(
  "issuing a new check-in link (local Supabase)",
  () => {
    let admin: DatabaseClient;
    const createdUserIds: string[] = [];
    const createdSocialIds: string[] = [];
    let socialAId: string;
    let socialBId: string;
    let managerA: DatabaseClient;
    let plainHostA: DatabaseClient;
    let plainHostB: DatabaseClient;
    let nonHostClient: DatabaseClient;
    let signedOutClient: DatabaseClient;

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

    async function signedInClient(
      host: { role: "manager" | "host"; socialId: string } | null,
    ): Promise<DatabaseClient> {
      const email = `integration-checkin-link-${randomUUID()}@example.test`;
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
          display_name: `Link ${host.role}`,
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
      return client;
    }

    async function checkinTagOf(socialId: string): Promise<string> {
      const { data, error } = await admin
        .from("socials")
        .select("checkin_tag")
        .eq("id", socialId)
        .single();
      if (error) throw error;
      return data.checkin_tag;
    }

    beforeAll(async () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", localStack!.apiUrl);
      vi.stubEnv(
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        localStack!.publishableKey,
      );
      vi.stubEnv("SUPABASE_SECRET_KEY", localStack!.secretKey);
      // The link's origin comes from the (mocked) request headers here.
      vi.stubEnv("PUBLIC_APP_ORIGIN", "");
      vi.spyOn(console, "error").mockImplementation(() => {});
      admin = createClient<Database>(
        localStack!.apiUrl,
        localStack!.secretKey,
        {
          auth: { persistSession: false, autoRefreshToken: false },
        },
      );
      socialAId = await createSocial("Link A");
      socialBId = await createSocial("Link B");
      managerA = await signedInClient({ role: "manager", socialId: socialAId });
      plainHostA = await signedInClient({ role: "host", socialId: socialAId });
      // Social B needs a manager too (one manager per social).
      await signedInClient({ role: "manager", socialId: socialBId });
      plainHostB = await signedInClient({ role: "host", socialId: socialBId });
      nonHostClient = await signedInClient(null);
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

    it.each([
      {
        label: "an operational host",
        denial: "NOT_A_MANAGER",
        client: () => plainHostA,
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
    ] as const)(
      "refuses $label and leaves the link working",
      async ({ denial, client }) => {
        actingClient = client();
        const tagBefore = await checkinTagOf(socialAId);
        vi.mocked(revalidatePath).mockClear();

        const result = await reissueCheckinLink();

        expect(result).toEqual({
          ok: false,
          message: HOST_ACCESS_DENIAL_MESSAGES[denial],
        });
        expect(await checkinTagOf(socialAId)).toBe(tagBefore);
        expect(revalidatePath).not.toHaveBeenCalled();
        expect((await fetchCheckinPage(tagBefore, null)).status).not.toBe(
          "inactive",
        );
      },
    );

    it("lets the manager issue a new link: the old one is inactive at once, the new one works, social B is untouched", async () => {
      actingClient = managerA;
      const oldTagA = await checkinTagOf(socialAId);
      const tagB = await checkinTagOf(socialBId);
      vi.mocked(revalidatePath).mockClear();

      const result = await reissueCheckinLink();

      expect(result).toEqual({ ok: true });
      // Every page that shows the link, its QR code or the stickers.
      expect(
        vi
          .mocked(revalidatePath)
          .mock.calls.map(([path]) => path)
          .sort(),
      ).toEqual(["/checkin-link", "/checkin-link/print", "/hosts"]);
      const newTagA = await checkinTagOf(socialAId);
      expect(newTagA).not.toBe(oldTagA);
      expect(await fetchCheckinPage(oldTagA, null)).toEqual({
        status: "inactive",
      });
      expect((await fetchCheckinPage(newTagA, null)).status).toBe(
        "no_open_session",
      );
      expect(await checkinTagOf(socialBId)).toBe(tagB);
      expect((await fetchCheckinPage(tagB, null)).status).toBe(
        "no_open_session",
      );
    });

    it("gives any host of the social its current link, and the QR code encodes exactly it", async () => {
      actingClient = plainHostA;
      const tagA = await checkinTagOf(socialAId);

      const checkinLink = await readCheckinLink(socialAId);

      expect(checkinLink).toEqual({
        link: `https://pickleball.example/t/${tagA}`,
        shortLink: `pickleball.example/t/${tagA}`,
      });
      const { data, types } = encode(checkinLink.link, {
        ecc: CHECKIN_QR_ERROR_CORRECTION_LEVEL,
        border: 0,
      });
      expect(
        decodeQrModules(data, (x, y) => types[y][x] === QrCodeDataType.Data)
          .text,
      ).toBe(checkinLink.link);
    });

    it("never gives a host another social's link (RLS)", async () => {
      actingClient = plainHostB;
      await expect(readCheckinLink(socialAId)).rejects.toThrow(
        /Reading the social's check-in tag failed/,
      );
    });
  },
);
