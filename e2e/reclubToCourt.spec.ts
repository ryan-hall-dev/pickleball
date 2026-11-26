// The whole social (docs/plans/reclub-to-court-v1.md, Phase 4) at 390 px
// against the LOCAL Supabase stack, a host and a separate browser per guest:
// import, walk-in, no-phone check-in, friend pair, confirmation, a rest that
// the app refills, a no-phone confirmation, two courts that call their own
// next group and finish out of order, host and player starts, and a score
// added after the next game has begun on the same court.
import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type Browser,
  type Page,
  type Locator,
} from "@playwright/test";
import {
  calledSeats,
  replay,
  type SessionEvent,
  type SessionState,
} from "../src/engine/session";
import {
  adminClient,
  deleteCreatedLogins,
  signInAsNewManager,
  useRandomClientIp,
} from "./support/localHostSession";

test.use({ viewport: { width: 390, height: 844 } });
test.afterAll(async () => {
  await deleteCreatedLogins();
});

const POLL_TIMEOUT_MS = 20_000;
/** Listed players with a phone. All men, so any four make a valid game. */
const PHONE_NAMES = [
  "An Vo",
  "Bao Truong",
  "Chi Lam",
  "Duy Ha",
  "Giang Phan",
  "Hieu Dao",
  "Khoa Mai",
  "Lan Dinh",
  "Minh Anh",
  "Oanh Le",
];
const NO_PHONE_NAME = "Phuc Ngo";
const ABSENT_NAME = "Quang Le";
const WALK_IN = { first: "Emma", last: "Reid" };

async function newPhone(browser: Browser, checkinTag: string): Promise<Page> {
  const octets = randomUUID().replace(/-/g, "").slice(0, 6).match(/../g)!;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: {
      "x-forwarded-for": `10.${octets.map((hex) => parseInt(hex, 16)).join(".")}`,
    },
  });
  const phone = await context.newPage();
  await phone.goto(`/t/${checkinTag}`);
  return phone;
}

async function pickDetails(page: Page | Locator) {
  await page.getByRole("button", { name: "Male", exact: true }).click();
  await page.getByRole("button", { name: "Intermediate" }).click();
}

async function readState(sessionId: string): Promise<SessionState> {
  const { data, error } = await adminClient
    .from("session_events")
    .select("seq, event_id, type, payload, occurred_at, actor_user_id")
    .eq("session_id", sessionId)
    .order("seq");
  if (error) throw error;
  const result = replay(
    data.map(
      (row) =>
        ({
          seq: row.seq,
          eventId: row.event_id,
          type: row.type,
          payload: row.payload,
          at: Date.parse(row.occurred_at),
          actorId: row.actor_user_id ?? "other",
        }) as SessionEvent,
    ),
  );
  if (!result.ok) throw new Error(`replay failed: ${result.error.message}`);
  return result.state;
}

test("a whole social: arrivals, two courts turning over out of order, and a late score", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one phone-width run");
  test.setTimeout(300_000);
  await useRandomClientIp(page);
  const { socialId } = await signInAsNewManager(page, "reclub-to-court");

  // 1. Draft with two courts; the host pastes the Reclub list.
  await page.getByRole("button", { name: "Start a new session" }).click();
  await page.getByLabel("Session name").fill("Whole social");
  await page.getByLabel("Court count").fill("2");
  await page.getByLabel("Session duration (minutes)").fill("150");
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Saved");
  const { data: social, error } = await adminClient
    .from("socials")
    .select("checkin_tag")
    .eq("id", socialId)
    .single();
  if (error) throw error;
  const listed = [...PHONE_NAMES, NO_PHONE_NAME, ABSENT_NAME];
  await page.goto("/arrivals");
  await page.getByLabel("Reclub list").fill(listed.join("\n"));
  await page.getByRole("button", { name: "Check names" }).click();
  await page
    .getByRole("button", { name: `Add ${listed.length} players` })
    .click();
  await expect(page.getByText(`Added ${listed.length} players.`)).toBeVisible();

  // 2. Listed players claim their names; one walk-in asks to join.
  const phones = new Map<string, Page>();
  for (const name of PHONE_NAMES) {
    const phone = await newPhone(browser, social.checkin_tag);
    await phone.getByLabel("Your name").fill(name.split(" ")[0]);
    await phone.getByRole("button", { name }).click();
    await pickDetails(phone);
    await phone.getByRole("button", { name: "I'm here" }).click();
    await expect(
      phone.getByRole("heading", { name: `You're in, ${name.split(" ")[0]}` }),
    ).toBeVisible();
    phones.set(name, phone);
  }
  const walkInPhone = await newPhone(browser, social.checkin_tag);
  await walkInPhone.getByRole("button", { name: "My name isn't here" }).click();
  await walkInPhone
    .getByRole("textbox", { name: "First name" })
    .fill(WALK_IN.first);
  await walkInPhone
    .getByRole("textbox", { name: "Last name" })
    .fill(WALK_IN.last);
  await pickDetails(walkInPhone);
  await walkInPhone
    .getByRole("button", { name: "Check in", exact: true })
    .click();
  await expect(
    walkInPhone.getByRole("heading", {
      name: "Waiting for the host to approve",
    }),
  ).toBeVisible();
  const walkInName = `${WALK_IN.first} ${WALK_IN.last}`;
  phones.set(walkInName, walkInPhone);

  // 3. The host approves the walk-in and checks in the player with no phone.
  await page.goto("/setup");
  await page
    .getByRole("button", { name: `Approve ${walkInName}` })
    .click({ timeout: POLL_TIMEOUT_MS });
  await expect(
    walkInPhone.getByRole("heading", { name: "You're in, Emma" }),
  ).toBeVisible({
    timeout: POLL_TIMEOUT_MS,
  });
  await page.goto("/arrivals");
  const row = page.getByRole("listitem").filter({ hasText: NO_PHONE_NAME });
  await row.getByRole("button", { name: "Check in" }).click();
  await pickDetails(row);
  await row.getByRole("button", { name: "Check in" }).click();
  await expect(
    page.getByRole("heading", { name: "Not arrived (1)" }),
  ).toBeVisible();

  // 4. Start. Two free courts: the app calls each its own four.
  await page.goto("/setup");
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Start Whole social?" })
    .getByRole("button", { name: "Confirm start" })
    .click();
  await expect(page).toHaveURL(/\/live$/);
  const { data: session } = await adminClient
    .from("sessions")
    .select("id")
    .eq("social_id", socialId)
    .eq("status", "live")
    .single();
  const sessionId = session!.id;
  await expect
    .poll(
      async () =>
        Object.values((await readState(sessionId)).courts).filter(
          (court) => court.nextGroup,
        ).length,
      { timeout: POLL_TIMEOUT_MS },
    )
    .toBe(2);

  const state0 = await readState(sessionId);
  const nameById = new Map(
    Object.values(state0.participants).map((participant) => [
      participant.participant.participantId,
      `${participant.participant.firstName} ${participant.participant.lastName}`,
    ]),
  );
  const [courtA, courtB] = Object.values(state0.courts);
  const courtAId = courtA.court.courtId;
  const courtBId = courtB.court.courtId;
  const groupNames = async (courtId: string) =>
    calledSeats((await readState(sessionId)).courts[courtId].nextGroup!).map(
      (id) => nameById.get(id!)!,
    );

  // 5. Friend pair: two of the four still waiting (12 here, 8 called).
  const called = new Set([
    ...(await groupNames(courtAId)),
    ...(await groupNames(courtBId)),
  ]);
  const waiting = [...phones.keys()].filter((name) => !called.has(name));
  expect(waiting.length).toBeGreaterThanOrEqual(2);
  const [asker, friend] = waiting;
  await phones.get(asker)!.reload();
  await phones
    .get(asker)!
    .getByRole("button", { name: "Play with a friend" })
    .click();
  await phones
    .get(asker)!
    .getByLabel("Friend's name")
    .fill(friend.split(" ")[0]);
  await phones
    .get(asker)!
    .getByRole("listitem")
    .filter({ hasText: friend })
    .getByRole("button", { name: "Ask" })
    .click();
  await expect(
    phones.get(friend)!.getByRole("button", { name: "Team up" }),
  ).toBeVisible({
    timeout: POLL_TIMEOUT_MS,
  });
  await phones.get(friend)!.getByRole("button", { name: "Team up" }).click();
  await expect(
    phones.get(asker)!.getByText(`Teamed up with ${friend}`, { exact: false }),
  ).toBeVisible({ timeout: POLL_TIMEOUT_MS });

  // 6. One of court A's four needs a rest: the app fills only that seat.
  const beforeRest = await groupNames(courtAId);
  const rester = beforeRest.find((name) => phones.has(name))!;
  await phones.get(rester)!.reload();
  await phones
    .get(rester)!
    .getByRole("button", { name: "Need a rest" })
    .click();
  await phones
    .get(rester)!
    .getByRole("button", { name: "Yes, I need a rest" })
    .click();
  await expect
    .poll(async () => (await groupNames(courtAId)).includes(rester), {
      timeout: POLL_TIMEOUT_MS,
    })
    .toBe(false);
  const afterRest = await groupNames(courtAId);
  expect(afterRest.filter((name) => beforeRest.includes(name))).toHaveLength(3);
  // Back from the break: Ready again, so four are free for a later call.
  await phones.get(rester)!.reload();
  await phones
    .get(rester)!
    .getByRole("button", { name: "I'm ready again" })
    .click();
  await expect(
    phones.get(rester)!.getByText("You've been ready for"),
  ).toBeVisible();

  /** Everyone in a court's group gets ready: phones tap, the host confirms the rest. */
  async function confirmGroup(courtId: string, courtLabel: string) {
    const names = await groupNames(courtId);
    for (const name of names.filter((n) => phones.has(n))) {
      const phone = phones.get(name)!;
      await phone.reload();
      await phone.getByRole("button", { name: "I'm ready" }).click();
    }
    for (const name of names.filter((n) => !phones.has(n))) {
      await page.reload();
      const card = page.getByRole("article", { name: courtLabel, exact: true });
      await card.getByLabel(`Options for ${name}`).click();
      await card.getByRole("button", { name: "Confirm in person" }).click();
    }
    await expect
      .poll(
        async () =>
          (await readState(sessionId)).courts[courtId].nextGroup?.confirmedIds
            ?.length,
        { timeout: POLL_TIMEOUT_MS },
      )
      .toBe(4);
    return names;
  }

  // 7. Both groups confirm; court A starts from a phone, court B by the host.
  const gameA1 = await confirmGroup(courtAId, "Court 1");
  const gameB1 = await confirmGroup(courtBId, "Court 2");
  const starter = gameA1.find((name) => phones.has(name))!;
  await expect(
    phones.get(starter)!.getByRole("heading", { name: "Head to Court 1" }),
  ).toBeVisible({
    timeout: POLL_TIMEOUT_MS,
  });
  await phones
    .get(starter)!
    .getByRole("button", { name: "Game started" })
    .click();
  await page.reload();
  await page
    .getByRole("article", { name: "Court 2", exact: true })
    .getByRole("button", { name: "Start game" })
    .click();
  await expect
    .poll(
      async () =>
        Object.values((await readState(sessionId)).courts).filter(
          (court) => court.activeMatchId,
        ).length,
      { timeout: POLL_TIMEOUT_MS },
    )
    .toBe(2);

  // 8. Court 2 finishes first: it gets its own next four straight away,
  //    while court 1 is still playing (and has no group of its own yet).
  const finish = async (courtLabel: string) => {
    await page.reload();
    await page
      .getByRole("article", { name: courtLabel, exact: true })
      .getByRole("button", { name: "Game finished" })
      .click();
    // Wait for the finish to be saved before reading the log.
    await expect(
      page
        .getByRole("article", { name: courtLabel, exact: true })
        .getByRole("button", { name: "Game finished" }),
    ).toHaveCount(0, { timeout: POLL_TIMEOUT_MS });
  };
  await finish("Court 2");
  await expect
    .poll(
      async () => !!(await readState(sessionId)).courts[courtBId].nextGroup,
      {
        timeout: POLL_TIMEOUT_MS,
      },
    )
    .toBe(true);
  let live = await readState(sessionId);
  expect(live.courts[courtBId].activeMatchId).toBeNull();
  expect(live.courts[courtAId].activeMatchId).not.toBeNull();
  expect(live.courts[courtAId].nextGroup).toBeFalsy();

  // The host asks court 1's next four early (D12), tied to court 1.
  await page.reload();
  const courtOneCard = page.getByRole("article", {
    name: "Court 1",
    exact: true,
  });
  await courtOneCard.getByRole("button", { name: "Prepare next four" }).click();
  await courtOneCard.getByRole("button", { name: "Call these four" }).click();
  await expect
    .poll(
      async () => !!(await readState(sessionId)).courts[courtAId].nextGroup,
      {
        timeout: POLL_TIMEOUT_MS,
      },
    )
    .toBe(true);
  const courtAGroupEarly = await groupNames(courtAId);
  const courtBGroup = await groupNames(courtBId);
  expect(courtAGroupEarly.filter((name) => courtBGroup.includes(name))).toEqual(
    [],
  );
  expect(courtAGroupEarly.filter((name) => gameA1.includes(name))).toEqual([]);

  // 9. Court 2's next group confirms and starts; its first four add the score
  //    after the next game has already begun on that court.
  await confirmGroup(courtBId, "Court 2");
  await page.reload();
  await page
    .getByRole("article", { name: "Court 2", exact: true })
    .getByRole("button", { name: "Start game" })
    .click();
  await expect
    .poll(
      async () => !!(await readState(sessionId)).courts[courtBId].activeMatchId,
      {
        timeout: POLL_TIMEOUT_MS,
      },
    )
    .toBe(true);
  live = await readState(sessionId);
  const scorer = gameB1.find(
    (name) =>
      phones.has(name) &&
      Object.values(live.participants).some(
        (p) =>
          nameById.get(p.participant.participantId) === name &&
          p.activeMatchId === null,
      ),
  )!;
  const scorerPhone = phones.get(scorer)!;
  await scorerPhone.reload();
  await expect(
    scorerPhone.getByText("Add the score for your last game"),
  ).toBeVisible({
    timeout: POLL_TIMEOUT_MS,
  });
  const inputs = scorerPhone.getByRole("textbox");
  await inputs.nth(0).fill("11");
  await inputs.nth(1).fill("7");
  await scorerPhone.getByRole("button", { name: "Save score" }).click();
  await expect(scorerPhone.getByText("Already recorded")).toBeVisible({
    timeout: POLL_TIMEOUT_MS,
  });

  // 10. Court 1 finishes: its own group is on it, ready to confirm.
  await finish("Court 1");
  live = await readState(sessionId);
  expect(live.courts[courtAId].nextGroup).toBeTruthy();
  expect(live.courts[courtAId].activeMatchId).toBeNull();
  expect(await groupNames(courtAId)).toEqual(courtAGroupEarly);
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Recent games" }),
  ).toContainText("Court 2");
  await page.screenshot({
    path: testInfo.outputPath("whole-social-live.png"),
    fullPage: true,
  });
});
