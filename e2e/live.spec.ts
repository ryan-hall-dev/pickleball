import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  adminClient,
  deleteCreatedLogins,
  signInAsNewManager,
  useRandomClientIp,
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
  await expect(court.getByText("Court free", { exact: true })).toBeVisible();
  await court.getByRole("button", { name: "Prepare next four" }).click();
  await court.getByRole("button", { name: "Call these four" }).click();
  await expect(
    court.getByRole("heading", { name: "Up next · Called" }),
  ).toBeVisible();
  await expect(restButtons).toHaveCount(4);
  await expect(
    court.getByRole("button", { name: "Game finished" }),
  ).toHaveCount(0);

  await court.getByRole("button", { name: "Start these four" }).click();
  await expect(court.getByText(/Playing ·/)).toBeVisible();
  await expect(restButtons).toHaveCount(0);
  for (const firstName of FIRST_NAMES)
    await expect(
      court.getByText(`${firstName} Journey`, { exact: true }),
    ).toBeVisible();
  await court.getByRole("button", { name: "Game finished" }).click();
  await expect(court.getByText("Court free", { exact: true })).toBeVisible();
  await expect(restButtons).toHaveCount(4);
  await expect(
    court.getByRole("button", { name: "Game finished" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(restButtons).toHaveCount(4);
  await expect(court.getByText("Court free", { exact: true })).toBeVisible();

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
    "PlayerSkipped",
    "PlayerUnskipped",
  ]);
  expect(events?.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
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
  expect(nextEvents?.map((event) => event.type)).toEqual([
    "SessionStarted",
    "PlayerSkipped",
  ]);
  const { data: endedEvents, error: endedEventsError } = await adminClient
    .from("session_events")
    .select("type")
    .eq("session_id", draft.id)
    .order("seq");
  if (endedEventsError) throw endedEventsError;
  expect(endedEvents).toHaveLength(7);
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
  await court.getByRole("button", { name: "Prepare next four" }).click();
  await court.getByRole("button", { name: "Call these four" }).click();
  await court.getByRole("button", { name: "Start these four" }).click();
  await expect(restButtons).toHaveCount(1);
  await court.getByText("Court options", { exact: true }).click();
  await court.getByRole("button", { name: "Undo game start" }).click();
  await expect(restButtons).toHaveCount(5);
  await expect(
    court.getByRole("heading", { name: "Up next · Called" }),
  ).toBeVisible();
  await court.getByRole("button", { name: "Start these four" }).click();
  await court.getByRole("button", { name: "Game finished" }).click();
  await expect(restButtons).toHaveCount(5);
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
  await expect(court.getByText("Court free", { exact: true })).toBeVisible();
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
    "MatchCompletionReverted",
    "PlayerReplaced",
    "PlayerLeft",
    "MatchAbandoned",
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
