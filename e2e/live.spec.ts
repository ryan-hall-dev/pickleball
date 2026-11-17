import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  addHostRow,
  adminClient,
  createLogin,
  createSocial,
  deleteCreatedLogins,
  signIn,
  signInAsNewManager,
  uniqueEmail,
  uniqueSocialName,
  useRandomClientIp,
  // Not a React hook (a Playwright helper): renamed for the hooks lint rule.
  useRandomClientIp as giveRandomClientIp,
} from "./support/localHostSession";

test.afterAll(deleteCreatedLogins);

const FIRST_NAMES = ["Alex", "Casey", "Drew", "Jamie"];

async function addPlayers(page: Page, lastName: string) {
  const playerForm = page.getByRole("form", { name: "Add a player" });
  for (const firstName of FIRST_NAMES) {
    await playerForm.getByLabel("First name").fill(firstName);
    await playerForm.getByLabel("Last name").fill(lastName);
    await playerForm.getByLabel("Gender", { exact: true }).selectOption("male");
    await playerForm
      .getByLabel("Skill", { exact: true })
      .selectOption("intermediate");
    await playerForm
      .getByRole("button", { name: "Add player", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: `Remove ${firstName} ${lastName}` }),
    ).toBeEnabled();
  }
}

test("a host runs a game, returns its four players to waiting and rests one", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  if (testInfo.project.name === "mobile")
    await page.setViewportSize({ width: 390, height: 844 });
  await useRandomClientIp(page);
  const { socialId } = await signInAsNewManager(page, "live-journey");
  await page.getByRole("button", { name: "Start a new session" }).click();
  await page.getByLabel("Session name").fill("Live browser journey");
  await page.getByLabel("Court count").fill("1");
  await page.getByLabel("Session duration (minutes)").fill("75");
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Saved");

  await addPlayers(page, "Journey");
  const { data: draft, error: draftError } = await adminClient
    .from("sessions")
    .select("id")
    .eq("social_id", socialId)
    .eq("status", "draft")
    .single();
  if (draftError) throw draftError;

  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Start Live browser journey?" })
    .getByRole("button", { name: "Confirm start" })
    .click();
  await expect(page).toHaveURL(/\/live$/);
  const court = page.getByRole("article", { name: "Court 1", exact: true });
  const waiting = page.getByRole("region", { name: /^Waiting/ });
  const restButtons = waiting.getByRole("button", { name: /^Rest / });
  await expect(restButtons).toHaveCount(4);
  // Order on the page: check-ins and the QR link, then waiting players, then
  // courts (desktop and the 390 px phone project).
  const checkInsTop = (
    await page.getByRole("region", { name: /^Check-ins waiting/ }).boundingBox()
  )?.y;
  const qrTop = (
    await page.getByRole("link", { name: "Show QR code" }).boundingBox()
  )?.y;
  const waitingTop = (await waiting.boundingBox())?.y;
  const courtsTop = (
    await page.getByRole("heading", { name: "Courts & Up next" }).boundingBox()
  )?.y;
  expect(checkInsTop).toBeDefined();
  expect(qrTop).toBeDefined();
  expect(checkInsTop!).toBeLessThan(waitingTop!);
  expect(qrTop!).toBeLessThan(waitingTop!);
  expect(waitingTop!).toBeLessThan(courtsTop!);
  // Starting the session prepared Court 1 by itself: no preparation step.
  await expect(
    court.getByText("Group prepared", { exact: true }),
  ).toBeVisible();
  await expect(
    court.getByRole("heading", { name: "Ready to start" }),
  ).toBeVisible();
  await expect(restButtons).toHaveCount(4);
  await expect(
    court.getByRole("button", { name: "Game finished" }),
  ).toHaveCount(0);

  await court.getByRole("button", { name: "Start game" }).click();
  await expect(court.getByText(/Playing ·/)).toBeVisible();
  await expect(restButtons).toHaveCount(0);
  for (const firstName of FIRST_NAMES)
    await expect(
      court.getByText(`${firstName} Journey`, { exact: true }),
    ).toBeVisible();
  await court.getByRole("button", { name: "Game finished" }).click();
  // The four are back in waiting and, by the wait-first rule, prepared again
  // (they are the only players); nothing starts until Start game.
  await expect(
    court.getByText("Group prepared", { exact: true }),
  ).toBeVisible();
  await expect(restButtons).toHaveCount(4);
  await expect(
    court.getByRole("button", { name: "Game finished" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(restButtons).toHaveCount(4);
  await expect(
    court.getByText("Group prepared", { exact: true }),
  ).toBeVisible();

  await waiting
    .getByRole("button", { name: "Rest Alex Journey", exact: true })
    .click();
  await expect(restButtons).toHaveCount(3);
  await waiting
    .getByRole("button", { name: "Ready now Alex Journey", exact: true })
    .click();
  await expect(restButtons).toHaveCount(4);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);

  const { data: events, error: eventsError } = await adminClient
    .from("session_events")
    .select("type, seq")
    .eq("session_id", draft.id)
    .order("seq");
  if (eventsError) throw eventsError;
  expect(events?.map((event) => event.type)).toEqual([
    "SessionStarted",
    "NextGroupCalled",
    "MatchStarted",
    "MatchCompleted",
    "NextGroupCalled",
    "PlayerSkipped",
    "PlayerUnskipped",
  ]);
  expect(events?.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  const { data: matches, error: matchesError } = await adminClient
    .from("matches")
    .select("status, team_a, team_b, ended_at")
    .eq("session_id", draft.id);
  if (matchesError) throw matchesError;
  expect(matches).toHaveLength(1);
  expect(matches![0].status).toBe("completed");
  expect(matches![0].ended_at).not.toBeNull();
  expect(new Set([...matches![0].team_a, ...matches![0].team_b]).size).toBe(4);

  await page.getByRole("button", { name: "End session", exact: true }).click();
  await page
    .getByRole("dialog", { name: "End this session?" })
    .getByRole("button", { name: "End session", exact: true })
    .click();
  await page.getByRole("link", { name: "Set up a new session" }).click();
  await page.getByRole("button", { name: "Start a new session" }).click();
  await page.getByLabel("Session name").fill("Next browser journey");
  await page.getByLabel("Court count").fill("1");
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Saved");
  await addPlayers(page, "Encore");
  const { data: nextDraft, error: nextDraftError } = await adminClient
    .from("sessions")
    .select("id")
    .eq("social_id", socialId)
    .eq("status", "draft")
    .single();
  if (nextDraftError) throw nextDraftError;
  expect(nextDraft.id).not.toBe(draft.id);
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Start Next browser journey?" })
    .getByRole("button", { name: "Confirm start" })
    .click();
  // No full-page reload: cached /live must switch identity to the new session.
  await expect(
    page.getByRole("heading", { level: 1, name: "Next browser journey" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(restButtons).toHaveCount(4);
  await expect(waiting.getByText(/Journey/)).toHaveCount(0);
  await waiting
    .getByRole("button", { name: "Rest Alex Encore", exact: true })
    .click();
  await expect(restButtons).toHaveCount(3);
  const { data: nextEvents, error: nextEventsError } = await adminClient
    .from("session_events")
    .select("type")
    .eq("session_id", nextDraft.id)
    .order("seq");
  if (nextEventsError) throw nextEventsError;
  // The new session was prepared by itself, and only its own log was written.
  expect(nextEvents?.map((event) => event.type)).toEqual([
    "SessionStarted",
    "NextGroupCalled",
    "PlayerSkipped",
  ]);
  const { data: endedEvents, error: endedEventsError } = await adminClient
    .from("session_events")
    .select("type")
    .eq("session_id", draft.id)
    .order("seq");
  if (endedEventsError) throw endedEventsError;
  expect(endedEvents).toHaveLength(8);
  expect(endedEvents?.at(-1)?.type).toBe("SessionEnded");
});

test("a host safely undoes start/finish, replaces a player and ends an interrupted game", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  if (testInfo.project.name === "mobile")
    await page.setViewportSize({ width: 390, height: 844 });
  await useRandomClientIp(page);
  const { socialId } = await signInAsNewManager(page, "live-recovery");
  await page.getByRole("button", { name: "Start a new session" }).click();
  await page.getByLabel("Session name").fill("Recovery social");
  await page.getByLabel("Court count").fill("1");
  await page.getByLabel("Session duration (minutes)").fill("75");
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Saved");
  const { data: draft, error: draftError } = await adminClient
    .from("sessions")
    .select("id")
    .eq("social_id", socialId)
    .eq("status", "draft")
    .single();
  if (draftError) throw draftError;
  const roster = Array.from({ length: 5 }, (_, index) => ({
    id: randomUUID(),
    social_id: socialId,
    session_id: draft.id,
    first_name: `Recovery${index + 1}`,
    last_name: "Player",
    gender: "male",
    skill_level: "intermediate" as const,
  }));
  const { error: playersError } = await adminClient
    .from("session_participants")
    .insert(roster);
  if (playersError) throw playersError;
  await page.reload();
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Start Recovery social?" })
    .getByRole("button", { name: "Confirm start" })
    .click();
  await expect(page).toHaveURL(/\/live$/);
  const court = page.getByRole("article", { name: "Court 1", exact: true });
  const waiting = page.getByRole("region", { name: /^Waiting/ });
  const restButtons = waiting.getByRole("button", { name: /^Rest / });
  await expect(
    court.getByText("Group prepared", { exact: true }),
  ).toBeVisible();
  await court.getByRole("button", { name: "Start game" }).click();
  await expect(restButtons).toHaveCount(1);
  await court.getByText("Court options", { exact: true }).click();
  await court.getByRole("button", { name: "Undo game start" }).click();
  await expect(restButtons).toHaveCount(5);
  await expect(
    court.getByRole("heading", { name: "Ready to start" }),
  ).toBeVisible();
  await court.getByRole("button", { name: "Start game" }).click();
  await court.getByRole("button", { name: "Game finished" }).click();
  await expect(restButtons).toHaveCount(5);
  // With five players the next group reserves some of the four who just
  // finished, so Undo needs that group released first (the engine says so).
  await expect(court.getByText("Court options", { exact: true })).toHaveCount(
    0,
  );
  await court.getByRole("button", { name: "Release group" }).click();
  await court.getByText("Court options", { exact: true }).click();
  await court.getByRole("button", { name: "Undo game finish" }).click();
  await expect(restButtons).toHaveCount(1);
  await expect(
    court.getByRole("button", { name: "Game finished" }),
  ).toBeVisible();
  // Reopening a match resets its recovery panel to avoid stale confirmations.
  await court.getByText("Court options", { exact: true }).click();
  const incomingName = (await restButtons
    .first()
    .getAttribute("aria-label"))!.replace("Rest ", "");
  const incoming = roster.find(
    (player) => `${player.first_name} ${player.last_name}` === incomingName,
  )!;
  await court
    .getByRole("button", { name: "Replace player", exact: true })
    .click();
  const replacement = court.getByRole("form", {
    name: "Replace player on Court 1",
  });
  const outgoingId = await replacement
    .getByLabel("Player leaving the game")
    .inputValue();
  const outgoing = roster.find((player) => player.id === outgoingId)!;
  await replacement.getByLabel("Replacement player").selectOption(incoming.id);
  await replacement
    .getByRole("button", { name: "Confirm replacement" })
    .click();
  await expect(replacement).not.toBeVisible();
  await expect(court.getByText(incomingName, { exact: true })).toBeVisible();
  await expect(
    court.getByRole("button", { name: "Undo game start" }),
  ).toHaveCount(0);
  await waiting
    .getByRole("button", {
      name: `Mark ${outgoing.first_name} ${outgoing.last_name} as left`,
      exact: true,
    })
    .click();
  await expect(restButtons).toHaveCount(0);
  await court
    .getByRole("button", { name: "Replace player", exact: true })
    .click();
  await expect(court.getByRole("status")).toHaveText(
    /No valid replacement is available/,
  );
  await expect(
    court.getByRole("button", { name: "Confirm replacement" }),
  ).toBeDisabled();
  await court
    .getByRole("button", { name: "End as interrupted", exact: true })
    .click();
  const interrupted = court.getByRole("group", {
    name: "Confirm interrupted game",
  });
  await expect(interrupted).toContainText("No completed game is counted");
  await interrupted
    .getByRole("button", { name: "Confirm interrupted game", exact: true })
    .click();
  await expect(restButtons).toHaveCount(4);
  // The freed court is prepared again from the four who are left.
  await expect(
    court.getByText("Group prepared", { exact: true }),
  ).toBeVisible();
  await expect(
    waiting.getByText("Nobody resting.", { exact: true }),
  ).toBeVisible();
  await expect(court.getByRole("button", { name: /Undo game/ })).toHaveCount(0);
  const { data: events, error: eventsError } = await adminClient
    .from("session_events")
    .select("type,payload")
    .eq("session_id", draft.id)
    .order("seq");
  if (eventsError) throw eventsError;
  expect(events?.map((event) => event.type)).toEqual([
    "SessionStarted",
    "NextGroupCalled",
    "MatchStarted",
    "MatchStartReverted",
    "MatchStarted",
    "MatchCompleted",
    "NextGroupCalled",
    "NextGroupReleased",
    "MatchCompletionReverted",
    "PlayerReplaced",
    "PlayerLeft",
    "MatchAbandoned",
    "NextGroupCalled",
  ]);
  expect(
    events?.find((event) => event.type === "PlayerReplaced")?.payload,
  ).toMatchObject({
    outId: outgoing.id,
    inId: incoming.id,
    countGameForOut: false,
  });
  const { data: matches, error: matchesError } = await adminClient
    .from("matches")
    .select("status")
    .eq("session_id", draft.id);
  if (matchesError) throw matchesError;
  expect(matches).toEqual([{ status: "abandoned" }]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test("a stale live approval shows a conflict, stays pending and approves exactly once on retry", async ({
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "runs once: it opens its own host and phone contexts",
  );
  test.setTimeout(90_000);
  // The co-host login is created first so cleanup (creation order) never
  // removes the social's only manager before its host.
  const socialId = await createSocial(uniqueSocialName("live-conflict"));
  const coHostEmail = uniqueEmail("live-conflict-cohost");
  await addHostRow(
    await createLogin(coHostEmail),
    "E2E live-conflict cohost",
    "host",
    socialId,
  );
  const managerEmail = uniqueEmail("live-conflict-manager");
  await addHostRow(
    await createLogin(managerEmail),
    "E2E live-conflict manager",
    "manager",
    socialId,
  );
  const contexts: BrowserContext[] = [];
  try {
    const hostPage = await newHostContext(browser, contexts);
    await signIn(hostPage, managerEmail);

    await hostPage.getByRole("button", { name: "Start a new session" }).click();
    await hostPage.getByLabel("Session name").fill("Conflict social");
    await hostPage.getByLabel("Court count").fill("1");
    await expect(hostPage.getByRole("main").getByRole("status")).toHaveText(
      "Saved",
    );
    const { data: draft, error: draftError } = await adminClient
      .from("sessions")
      .select("id")
      .eq("social_id", socialId)
      .eq("status", "draft")
      .single();
    if (draftError) throw draftError;
    const { error: rosterError } = await adminClient
      .from("session_participants")
      .insert(
        Array.from({ length: 5 }, (_, index) => ({
          id: randomUUID(),
          social_id: socialId,
          session_id: draft.id,
          first_name: `Conflict${index + 1}`,
          last_name: "Player",
          gender: "male",
          skill_level: "intermediate" as const,
        })),
      );
    if (rosterError) throw rosterError;
    await hostPage.reload();
    await hostPage
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await hostPage
      .getByRole("dialog", { name: "Start Conflict social?" })
      .getByRole("button", { name: "Confirm start" })
      .click();
    await expect(hostPage).toHaveURL(/\/live$/);

    // 1. Both hosts see the same live session.
    const coHostPage = await newHostContext(browser, contexts);
    await signIn(coHostPage, coHostEmail);
    await coHostPage.goto("/live");
    for (const page of [hostPage, coHostPage]) {
      await expect(
        page.getByRole("heading", { level: 1, name: "Conflict social" }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("region", { name: /^Waiting/ })
          .getByRole("button", { name: /^Rest / }),
      ).toHaveCount(5);
    }

    // 2. A player submits a real check-in; both hosts' trays list it.
    const { data: social, error: socialError } = await adminClient
      .from("socials")
      .select("checkin_tag")
      .eq("id", socialId)
      .single();
    if (socialError) throw socialError;
    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    contexts.push(phoneContext);
    const phone = await phoneContext.newPage();
    await useRandomClientIp(phone);
    await phone.goto(`/t/${social.checkin_tag}`);
    await phone.getByRole("button", { name: "Female", exact: true }).click();
    await phone.getByRole("textbox", { name: "First name" }).fill("Zoe");
    await phone.getByRole("textbox", { name: "Last name" }).fill("Park");
    await phone
      .getByRole("group", { name: "Your level" })
      .getByRole("button", { name: "Beginner" })
      .click();
    await phone.getByRole("button", { name: "Check in", exact: true }).click();
    await expect(
      phone.getByRole("heading", { name: "Waiting for the host to approve" }),
    ).toBeVisible();
    const trayRow = (page: Page) =>
      page
        .getByRole("region", { name: /^Check-ins waiting/ })
        .getByRole("listitem")
        .filter({ has: page.getByText("Zoe Park", { exact: true }) });
    await expect(trayRow(hostPage)).toBeVisible({ timeout: 12_000 });
    await expect(trayRow(coHostPage)).toBeVisible({ timeout: 12_000 });

    // 3. Freeze the approving host's polling (it skips while hidden), then the
    // co-host advances the session so the approving host's sequence is stale.
    await hostPage.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
    });
    const hostWaiting = hostPage.getByRole("region", { name: /^Waiting/ });
    const coHostWaiting = coHostPage.getByRole("region", { name: /^Waiting/ });
    await coHostWaiting
      .getByRole("button", { name: "Rest Conflict5 Player", exact: true })
      .click();
    await expect(
      coHostWaiting.getByRole("button", {
        name: "Ready now Conflict5 Player",
        exact: true,
      }),
    ).toBeVisible();
    // The frozen host still shows the old state.
    await expect(
      hostWaiting.getByRole("button", {
        name: "Rest Conflict5 Player",
        exact: true,
      }),
    ).toBeVisible();

    // 4. Approving shows the conflict, stays pending, adds nobody and
    // refreshes the live state.
    await hostPage.getByRole("button", { name: "Approve Zoe Park" }).click();
    await expect(trayRow(hostPage).getByRole("alert")).toContainText(
      "The session changed before this was saved. Nobody was added.",
    );
    await expect(trayRow(hostPage)).not.toContainText("Added to Who's playing");
    await expect(
      hostWaiting.getByRole("button", {
        name: "Ready now Conflict5 Player",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      hostWaiting.getByRole("button", { name: "Rest Zoe Park" }),
    ).toHaveCount(0);
    const participantsNamed = async () => {
      const { data, error } = await adminClient
        .from("session_participants")
        .select("id")
        .eq("session_id", draft.id)
        .eq("first_name", "Zoe")
        .eq("last_name", "Park");
      if (error) throw error;
      return data.length;
    };
    const joinedEventCount = async () => {
      const { data, error } = await adminClient
        .from("session_events")
        .select("seq")
        .eq("session_id", draft.id)
        .eq("type", "PlayerJoined");
      if (error) throw error;
      return data.length;
    };
    expect(await participantsNamed()).toBe(0);
    expect(await joinedEventCount()).toBe(0);
    const { data: pending, error: pendingError } = await adminClient
      .from("checkin_requests")
      .select("status")
      .eq("session_id", draft.id);
    if (pendingError) throw pendingError;
    expect(pending).toEqual([{ status: "pending" }]);

    // 5. Approving again succeeds exactly once.
    await hostPage.getByRole("button", { name: "Approve Zoe Park" }).click();
    await expect(trayRow(hostPage)).toContainText("Added to Who's playing");
    await expect(
      hostWaiting.getByRole("button", { name: "Rest Zoe Park", exact: true }),
    ).toBeVisible();

    // 6. Both hosts (and the phone) see the player; the database has one
    // participant and one PlayerJoined event.
    await expect(
      coHostWaiting.getByRole("button", { name: "Rest Zoe Park", exact: true }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(
      phone.getByRole("heading", { name: "You're in, Zoe" }),
    ).toBeVisible({ timeout: 12_000 });
    expect(await participantsNamed()).toBe(1);
    expect(await joinedEventCount()).toBe(1);
    const { data: events, error: eventsError } = await adminClient
      .from("session_events")
      .select("type, seq")
      .eq("session_id", draft.id)
      .order("seq");
    if (eventsError) throw eventsError;
    expect(events?.map((event) => event.type)).toEqual([
      "SessionStarted",
      "NextGroupCalled",
      "PlayerSkipped",
      "PlayerJoined",
    ]);
    expect(events?.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    const { data: approved, error: approvedError } = await adminClient
      .from("checkin_requests")
      .select("status")
      .eq("session_id", draft.id);
    if (approvedError) throw approvedError;
    expect(approved).toEqual([{ status: "approved" }]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

async function newHostContext(
  browser: Browser,
  contexts: BrowserContext[],
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  contexts.push(context);
  const page = await context.newPage();
  await giveRandomClientIp(page);
  return page;
}
