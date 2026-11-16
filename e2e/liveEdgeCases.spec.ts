import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import {
  RECOMMENDED_ROTATION_PREFERENCES,
  replay,
  type SessionConfig,
  type SessionEvent,
  type SessionEventPayloads,
  type SessionEventType,
} from "../src/engine/session";
import type { Json } from "../src/lib/database.types";
import {
  adminClient,
  deleteCreatedLogins,
  findUserIdByEmail,
  signInAsNewManager,
  useRandomClientIp,
} from "./support/localHostSession";

test.afterAll(deleteCreatedLogins);
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useRandomClientIp(page);
});

/** Historical fixtures append only to a new session; every event must replay. */
async function liveFixture(
  page: Page,
  options: {
    ageMinutes?: number;
    durationMinutes?: number;
    courts?: number;
    players?: number;
  } = {},
) {
  const { email, socialId } = await signInAsNewManager(page, "live-edge");
  const actorId = (await findUserIdByEmail(email))!;
  const sessionId = randomUUID();
  const startedAt = Date.now() - (options.ageMinutes ?? 1) * 60_000;
  const config: SessionConfig = {
    policyVersion: "simple-social-v1",
    courts: Array.from({ length: options.courts ?? 1 }, (_, index) => ({
      courtId: randomUUID(),
      name: `Court ${index + 1}`,
      format: "doubles",
    })),
    participants: Array.from({ length: options.players ?? 5 }, (_, index) => ({
      participantId: randomUUID(),
      firstName: `Edge${index + 1}`,
      lastName: "Player",
      gender: "male",
      skill: "intermediate",
    })),
    targetMatchMinutes: 15,
    changeoverMinutes: 2,
    plannedDurationMinutes: options.durationMinutes ?? 75,
    rotation: RECOMMENDED_ROTATION_PREFERENCES,
  };
  const ids = config.participants.map((player) => player.participantId);
  const events: SessionEvent[] = [];
  const append = <T extends SessionEventType>(
    type: T,
    payload: SessionEventPayloads[T],
    at: number,
  ) => {
    events.push({
      type,
      payload,
      at,
      actorId,
      eventId: randomUUID(),
      seq: events.length + 1,
    } as SessionEvent);
  };
  append(
    "SessionStarted",
    { config, initialAttendeeIds: ids, initialMatches: [] },
    startedAt,
  );
  return {
    sessionId,
    socialId,
    actorId,
    startedAt,
    config,
    ids,
    events,
    append,
    async persist() {
      const result = replay(events);
      if (!result.ok)
        throw new Error(`Invalid fixture: ${result.error.message}`);
      const session = await adminClient.from("sessions").insert({
        id: sessionId,
        social_id: socialId,
        host_id: actorId,
        host_name: "Edge host",
        name: "Edge session",
        status: "live",
        started_at: new Date(startedAt).toISOString(),
        planned_start: new Date(startedAt).toISOString(),
        planned_end: new Date(
          startedAt + config.plannedDurationMinutes * 60_000,
        ).toISOString(),
        config_snapshot: config as unknown as Json,
        last_seq: events.length,
      });
      if (session.error) throw session.error;
      const players = await adminClient.from("session_participants").insert(
        config.participants.map((player) => ({
          id: player.participantId,
          session_id: sessionId,
          social_id: socialId,
          first_name: player.firstName,
          last_name: player.lastName,
          gender: player.gender,
          skill_level: player.skill,
        })),
      );
      if (players.error) throw players.error;
      const log = events.map((event) => ({
        session_id: sessionId,
        event_id: event.eventId,
        seq: event.seq,
        type: event.type,
        payload: event.payload as unknown as NonNullable<Json>,
        occurred_at: new Date(event.at).toISOString(),
        actor_user_id: actorId,
      }));
      // The public service role cannot INSERT logs. Only this validated, new
      // local fixture uses the DB owner; runtime RPC clock checks stay intact.
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          "supabase_db_pickleball",
          "psql",
          "-U",
          "supabase_admin",
          "-d",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-v",
          `fixtureEvents=${JSON.stringify(log)}`,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["pipe", "pipe", "pipe"],
          input: `insert into public.session_events
          (session_id, event_id, seq, type, payload, occurred_at, actor_user_id)
          select session_id, event_id, seq, type, payload, occurred_at, actor_user_id
          from jsonb_to_recordset(:'fixtureEvents'::jsonb) as fixture(
            session_id uuid, event_id uuid, seq integer,
            type public.session_event_type, payload jsonb,
            occurred_at timestamptz, actor_user_id uuid);`,
        },
      );
    },
    async readEvents() {
      const { data, error } = await adminClient
        .from("session_events")
        .select("event_id, seq, type, payload, occurred_at, actor_user_id")
        .eq("session_id", sessionId)
        .order("seq");
      if (error) throw error;
      return data;
    },
  };
}

function court(page: Page, number = 1) {
  return page.getByRole("article", { name: `Court ${number}`, exact: true });
}
function waiting(page: Page) {
  return page.getByRole("region", { name: /^Waiting/ });
}

test("a committed start with a lost response retries the same action exactly once", async ({
  page,
  context,
}) => {
  const fixture = await liveFixture(page, { players: 4 });
  fixture.append(
    "NextGroupCalled",
    {
      courtId: fixture.config.courts[0].courtId,
      teamA: fixture.ids.slice(0, 2),
      teamB: fixture.ids.slice(2, 4),
    },
    fixture.startedAt + 1,
  );
  await fixture.persist();
  await page.goto("/live");
  let loseResponse = true;
  const startRequests: string[] = [];
  let committedEventId: string | undefined;
  await page.route("**/live", async (route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    if (
      request.method() !== "POST" ||
      !request.headers()["next-action"] ||
      !body.includes('"kind":"start"')
    ) {
      await route.continue();
      return;
    }
    startRequests.push(body);
    if (!loseResponse) {
      await route.continue();
      return;
    }
    loseResponse = false;
    await route.fetch(); // Execute the real write; lose only its successful answer.
    const committed = (await fixture.readEvents()).filter(
      (event) => event.type === "MatchStarted",
    );
    expect(committed).toHaveLength(1);
    committedEventId = committed[0].event_id;
    await route.abort("failed");
  });
  await court(page).getByRole("button", { name: "Start these four" }).click();
  const retry = page.getByRole("button", { name: "Retry last action" });
  await expect(retry).toBeEnabled({ timeout: 20_000 });
  await expect(
    court(page).getByRole("button", { name: "Game finished" }),
  ).toBeDisabled();
  await context.setOffline(true);
  try {
    await retry.click();
    await expect(retry).toBeEnabled();
    await expect(
      court(page).getByRole("button", { name: "Game finished" }),
    ).toBeDisabled();
    expect(
      (await fixture.readEvents()).filter(
        (event) => event.type === "MatchStarted",
      ),
    ).toHaveLength(1);
  } finally {
    await context.setOffline(false);
  }
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(
    court(page).getByRole("button", { name: "Game finished" }),
  ).toBeEnabled();
  expect(startRequests.length).toBeGreaterThanOrEqual(2);
  for (const request of startRequests)
    expect(request).toContain(committedEventId);
  expect(
    (await fixture.readEvents()).filter(
      (event) => event.type === "MatchStarted",
    ),
  ).toHaveLength(1);
  await court(page).getByRole("button", { name: "Game finished" }).click();
  await expect(
    waiting(page).getByRole("button", { name: /^Rest / }),
  ).toHaveCount(4);
  const { data: matches, error } = await adminClient
    .from("matches")
    .select("id,status")
    .eq("session_id", fixture.sessionId);
  if (error) throw error;
  expect(matches).toHaveLength(1);
  expect(matches![0].status).toBe("completed");
});

test("ten-minute rest expires while no host page is open, preserving earned waiting", async ({
  page,
  context,
}) => {
  const fixture = await liveFixture(page, { ageMinutes: 16, players: 4 });
  await page.close();
  fixture.append(
    "PlayerSkipped",
    {
      participantId: fixture.ids[0],
      returnsAt: fixture.startedAt + 15 * 60_000,
    },
    fixture.startedAt + 5 * 60_000,
  );
  await fixture.persist();
  const reopened = await context.newPage();
  await reopened.goto("/live");
  const row = waiting(reopened)
    .getByRole("listitem")
    .filter({
      has: reopened.getByRole("button", {
        name: "Rest Edge1 Player",
        exact: true,
      }),
    });
  await expect(row).toBeVisible();
  await expect(row.getByText(/^[67] min$/, { exact: true })).toBeVisible();
  await expect(
    waiting(reopened).getByRole("button", { name: /^Ready now/ }),
  ).toHaveCount(0);
  expect((await fixture.readEvents()).map((event) => event.type)).toEqual([
    "SessionStarted",
    "PlayerSkipped",
  ]);
});

for (const absence of ["rest", "leave"] as const) {
  test(`a called player who ${absence === "rest" ? "rests" : "leaves"} needs an explicit replacement`, async ({
    page,
  }) => {
    const fixture = await liveFixture(page);
    fixture.append(
      "NextGroupCalled",
      {
        courtId: fixture.config.courts[0].courtId,
        teamA: fixture.ids.slice(0, 2),
        teamB: fixture.ids.slice(2, 4),
      },
      fixture.startedAt + 1,
    );
    await fixture.persist();
    await page.goto("/live");
    await waiting(page)
      .getByRole("button", {
        name:
          absence === "rest"
            ? "Rest Edge1 Player"
            : "Mark Edge1 Player as left",
        exact: true,
      })
      .click();
    const next = court(page).getByRole("region", {
      name: "Up next for Court 1",
    });
    await expect(
      next.getByText("Replacement needed", { exact: true }),
    ).toBeVisible();
    await expect(
      next.getByRole("button", { name: "Start these four" }),
    ).toBeDisabled();
    for (const number of [2, 3, 4])
      await expect(
        next.getByText(`Edge${number} Player`, { exact: true }),
      ).toBeVisible();
    await expect(next.getByText("Edge5 Player", { exact: true })).toHaveCount(
      0,
    );
    await next.getByRole("button", { name: "Change players" }).click();
    await next.getByLabel("Team A · Player 1").selectOption(fixture.ids[4]);
    await next.getByRole("button", { name: "Confirm changed group" }).click();
    await expect(
      next.getByText("Replacement needed", { exact: true }),
    ).toHaveCount(0);
    await next.getByRole("button", { name: "Start these four" }).click();
    await expect(
      court(page).getByRole("button", { name: "Game finished" }),
    ).toBeEnabled();
    const events = await fixture.readEvents();
    const changed = events.find(
      (event) => event.type === "NextGroupChanged",
    )!.payload;
    expect(changed).toMatchObject({
      calledEventId: fixture.events[1].eventId,
      teamA: [fixture.ids[4], fixture.ids[1]],
      teamB: fixture.ids.slice(2, 4),
    });
    expect(events.map((event) => event.type)).toEqual([
      "SessionStarted",
      "NextGroupCalled",
      absence === "rest" ? "PlayerSkipped" : "PlayerLeft",
      "NextGroupChanged",
      "MatchStarted",
    ]);
  });
}

test("the deadline blocks called starts and new calls but lets active games finish before End", async ({
  page,
}) => {
  const fixture = await liveFixture(page, {
    ageMinutes: 20,
    durationMinutes: 15,
    courts: 2,
    players: 8,
  });
  fixture.append(
    "MatchStarted",
    {
      courtId: fixture.config.courts[0].courtId,
      matchId: randomUUID(),
      teamA: fixture.ids.slice(0, 2),
      teamB: fixture.ids.slice(2, 4),
    },
    fixture.startedAt + 1,
  );
  fixture.append(
    "NextGroupCalled",
    {
      courtId: fixture.config.courts[1].courtId,
      teamA: fixture.ids.slice(4, 6),
      teamB: fixture.ids.slice(6, 8),
    },
    fixture.startedAt + 2,
  );
  await fixture.persist();
  await page.goto("/live");
  await expect(
    page.getByText("Session time is up", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start these four" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Prepare next four|Call these four/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "End session", exact: true }),
  ).toBeDisabled();
  await court(page).getByRole("button", { name: "Game finished" }).click();
  await expect(
    page.getByRole("button", { name: "End session", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await page
    .getByRole("dialog", { name: "End this session?" })
    .getByRole("button", { name: "End session", exact: true })
    .click();
  await expect(page.getByText("Session ended", { exact: true })).toBeVisible();
  const events = await fixture.readEvents();
  expect(events.map((event) => event.type)).toEqual([
    "SessionStarted",
    "MatchStarted",
    "NextGroupCalled",
    "MatchCompleted",
    "SessionEnded",
  ]);
  const ended = replay(
    events.map(
      (event) =>
        ({
          type: event.type,
          payload: event.payload,
          seq: event.seq,
          eventId: event.event_id,
          actorId: event.actor_user_id,
          at: Date.parse(event.occurred_at),
        }) as SessionEvent,
    ),
  );
  expect(
    ended.ok &&
      Object.values(ended.state.courts).every(
        (item) => item.nextGroup === null,
      ),
  ).toBe(true);
});
