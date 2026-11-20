// Session setup (/setup) against the LOCAL Supabase stack: Session details,
// Courts, Who's playing and the Session summary. Runs on desktop and on a
// phone (the `mobile` project). Test courts carry a unique token in their
// name; test sessions belong to the test's own host. Everything is removed
// afterwards. Players exist only inside their session.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  adminClient,
  deleteCreatedLogins,
  findUserIdByEmail,
  signInAsNewManager,
  useRandomClientIp,
  openHostMenuOnPhones,
} from "./support/localHostSession";

const testHostUserIds: string[] = [];

test.beforeEach(async ({ page }) => {
  await useRandomClientIp(page);
});

test.afterAll(async () => {
  // Test-only cleanup with the secret key; the app never deletes sessions or courts.
  for (const hostUserId of testHostUserIds.splice(0)) {
    const { data: sessions } = await adminClient
      .from("sessions")
      .select("id, status")
      .eq("host_id", hostUserId);
    for (const session of sessions ?? []) {
      // Participants can only be removed while the session is a draft.
      if (session.status === "draft") {
        await adminClient
          .from("session_participants")
          .delete()
          .eq("session_id", session.id);
      }
      const { error } = await adminClient
        .from("sessions")
        .delete()
        .eq("id", session.id);
      if (error) {
        console.warn(
          `Couldn't delete e2e session ${session.id}: ${error.message}`,
        );
      }
    }
  }
  // After the sessions: the socials, with their courts.
  await deleteCreatedLogins();
});

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * The autosave status, inside <main>: dnd-kit's drag announcements are
 * another (visually hidden) status region at the end of <body>.
 */
function saveStatus(page: Page) {
  return page.getByRole("main").getByRole("status");
}

async function expectSaved(page: Page) {
  await expect(saveStatus(page)).toHaveText("Saved");
}

/** Discards the open draft through both steps of the confirmation dialog. */
async function discardDraftForAllHosts(page: Page, draftName: string) {
  await page.getByRole("button", { name: "Discard draft" }).click();
  const discardDialog = page.getByRole("dialog", {
    name: `Discard “${draftName}”?`,
  });
  await discardDialog
    .getByRole("checkbox", {
      name: `I understand this discards “${draftName}” for all hosts`,
    })
    .check();
  await discardDialog
    .getByRole("button", { name: "Discard for all hosts" })
    .click();
}

async function openDraftSessionId(hostUserId: string): Promise<string> {
  const { data, error } = await adminClient
    .from("sessions")
    .select("id")
    .eq("host_id", hostUserId)
    .eq("status", "draft")
    .single();
  if (error) throw error;
  return data.id;
}

async function startNewDraft(page: Page) {
  await page.goto("/setup");
  await page.getByRole("button", { name: "Start a new session" }).click();
  await expect(page.getByLabel("Court count")).toBeVisible();
  await page.getByLabel("Court count").fill("1");
  await expectSaved(page);
}
test("a stale tab can't overwrite newer settings: it says so, and saves again after a reload", async ({
  page,
  context,
}) => {
  const { email } = await signInAsNewManager(page, "setup-two-tabs");
  const hostUserId = (await findUserIdByEmail(email))!;
  testHostUserIds.push(hostUserId);
  await startNewDraft(page);
  const tabA = page;
  const tabB = await context.newPage();
  await tabB.goto("/setup");
  await expectSaved(tabB);

  await tabA.getByLabel("Session duration (minutes)").fill("90");
  await expectSaved(tabA);

  // Tab B still shows the old settings; its edit is refused.
  await tabB.getByLabel("Session name").fill("Stale tab name");
  const conflictBanner = tabB.getByRole("region", {
    name: "Setup changed elsewhere",
  });
  await expect(conflictBanner).toContainText(
    "Setup was changed by another host, tab or device. Reload to see the latest — your unsaved changes here will be lost.",
  );
  await expect(saveStatus(tabB)).toHaveText("! Not saved: changed elsewhere");
  await expect(tabB.getByLabel("Session name")).toHaveValue("Stale tab name");
  const { data: row, error } = await adminClient
    .from("sessions")
    .select("name, config_snapshot")
    .eq("host_id", hostUserId)
    .eq("status", "draft")
    .single();
  if (error) throw error;
  expect(row.name).not.toBe("Stale tab name");
  await conflictBanner.getByRole("button", { name: "Reload" }).click();
  await expect(tabB.getByLabel("Session duration (minutes)")).toHaveValue("90");
  await expect(conflictBanner).toHaveCount(0);
  await tabB.getByLabel("Session name").fill("Fresh tab name");
  await expectSaved(tabB);
  await expect
    .poll(async () => {
      const { data } = await adminClient
        .from("sessions")
        .select("name")
        .eq("host_id", hostUserId)
        .eq("status", "draft")
        .single();
      return data?.name;
    })
    .toBe("Fresh tab name");

  // A client-side trip away and back loads the newest revision too.
  const nav = tabB.getByRole("navigation", { name: "Host" });
  await openHostMenuOnPhones(tabB);
  await nav.getByRole("link", { name: "Hosts" }).click();
  await expect(tabB).toHaveURL(/\/hosts$/);
  await openHostMenuOnPhones(tabB);
  await nav.getByRole("link", { name: "Session setup" }).click();
  await tabB.getByLabel("Session name").fill("After navigating");
  await expectSaved(tabB);
  await expect(
    tabB.getByRole("region", { name: "Setup changed elsewhere" }),
  ).toHaveCount(0);
  await tabB.close();
});

// A truly fresh editor after leaving (Setup evicted from Next's <Activity>
// cache) can't be forced here: Next keeps 3 routes per layout level and the
// host area has only a few sections (Setup, Hosts, the check-in link). The component tests cover that path (SessionSetupEditor.test.tsx,
// "after the editor truly unmounts"). This covers coming back to the cached
// Setup while the save made on leaving is still on its way.
test("coming back while the save made on leaving is still on its way: it lands, then the next edit saves", async ({
  page,
}) => {
  const { email } = await signInAsNewManager(page, "setup-slow-leave");
  const hostUserId = (await findUserIdByEmail(email))!;
  testHostUserIds.push(hostUserId);
  await startNewDraft(page);
  await expectSaved(page);

  // Hold the next server action (the save on leaving) until the test lets it go.
  let releaseHeldSave!: () => Promise<void>;
  const saveIsHeld = new Promise<void>((resolveSaveIsHeld) => {
    let isHolding = false;
    void page.route("**/*", async (route) => {
      const request = route.request();
      const isServerAction =
        request.method() === "POST" && !!request.headers()["next-action"];
      if (isHolding || !isServerAction) {
        await route.fallback();
        return;
      }
      isHolding = true;
      releaseHeldSave = () => route.continue();
      resolveSaveIsHeld();
    });
  });

  // An edit, then away within the autosave delay, and straight back.
  await page.getByLabel("Session name").fill("Saved on the way out");
  const nav = page.getByRole("navigation", { name: "Host" });
  await openHostMenuOnPhones(page);
  await nav.getByRole("link", { name: "Hosts" }).click();
  await saveIsHeld;
  await expect(page).toHaveURL(/\/hosts$/);
  await openHostMenuOnPhones(page);
  await nav.getByRole("link", { name: "Session setup" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(saveStatus(page)).toHaveText("Saving…");
  await releaseHeldSave();

  await expectSaved(page);
  await expect(page.getByLabel("Session name")).toHaveValue(
    "Saved on the way out",
  );
  await page.getByLabel("Session name").fill("After coming back");
  await expectSaved(page);
  await expect(
    page.getByRole("region", { name: "Setup changed elsewhere" }),
  ).toHaveCount(0);
  await expect
    .poll(async () => {
      const { data } = await adminClient
        .from("sessions")
        .select("name")
        .eq("host_id", hostUserId)
        .eq("status", "draft")
        .single();
      return data;
    })
    .toEqual({ name: "After coming back" });
});

test("legacy missing player details require explicit choices and persist after an in-flight own autosave", async ({
  page,
}) => {
  const { email, socialId } = await signInAsNewManager(page, "legacy-details");
  const hostUserId = (await findUserIdByEmail(email))!;
  testHostUserIds.push(hostUserId);
  await startNewDraft(page);
  const sessionId = await openDraftSessionId(hostUserId);
  const participantId = randomUUID();
  const firstName = `Legacy${randomUUID().slice(0, 8)}`;
  const fullName = `${firstName} Player`;
  const { error } = await adminClient.from("session_participants").insert({
    id: participantId,
    social_id: socialId,
    session_id: sessionId,
    first_name: firstName,
    last_name: "Player",
    gender: null,
    skill_level: null,
  });
  if (error) throw error;

  async function storedDetails() {
    const { data, error: readError } = await adminClient
      .from("session_participants")
      .select("gender, skill_level")
      .eq("social_id", socialId)
      .eq("session_id", sessionId)
      .eq("id", participantId)
      .single();
    if (readError) throw readError;
    return data;
  }

  await page.reload();
  await expectSaved(page);
  const details = page.getByRole("form", {
    name: `Complete details for ${fullName}`,
  });
  const gender = details.getByRole("combobox", {
    name: `Gender for ${fullName}`,
  });
  const level = details.getByRole("combobox", {
    name: `Level for ${fullName}`,
  });
  await expect(gender).toHaveValue("");
  await expect(level).toHaveValue("");
  await gender.selectOption("female");
  await details.getByRole("button", { name: "Save details" }).click();
  await expect(
    details.getByText("Choose male or female and a level."),
  ).toBeVisible();
  expect(await storedDetails()).toEqual({ gender: null, skill_level: null });
  await level.selectOption("advanced");

  // Hold this specific autosave, never a tray poll, while details wait for it.
  const pendingLocation = `Own save ${randomUUID().slice(0, 8)}`;
  const heldSave: { release?: () => Promise<void> } = {};
  let hasHeldSave = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      !hasHeldSave &&
      request.method() === "POST" &&
      request.headers()["next-action"] &&
      request.postData()?.includes(pendingLocation)
    ) {
      hasHeldSave = true;
      heldSave.release = () => route.continue();
      return;
    }
    await route.fallback();
  });

  try {
    await page.getByLabel("Session name").fill(pendingLocation);
    await expect.poll(() => hasHeldSave).toBe(true);
    await details.getByRole("button", { name: "Save details" }).click();
    await expect(page.getByLabel("Session name")).toBeDisabled();
    expect(await storedDetails()).toEqual({ gender: null, skill_level: null });
    await heldSave.release!();
    delete heldSave.release;
    await expect
      .poll(storedDetails)
      .toEqual({ gender: "female", skill_level: "advanced" });
    await expect(details).toHaveCount(0);
    await expectSaved(page);
    await expect(
      page.getByRole("region", { name: "Setup changed elsewhere" }),
    ).toHaveCount(0);

    // The next settings write must use the revision returned by details save.
    const nextLocation = `${pendingLocation} done`;
    await page.getByLabel("Session name").fill(nextLocation);
    await expectSaved(page);
    await page.reload();
    await expectSaved(page);
    await expect(page.getByLabel("Session name")).toHaveValue(nextLocation);
    await expect(details).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Players" })).toContainText(
      fullName,
    );
    await expect(page.getByRole("list", { name: "Players" })).toContainText(
      "Advanced · Female",
    );
    expect(await storedDetails()).toEqual({
      gender: "female",
      skill_level: "advanced",
    });
    await expect(
      page.getByRole("region", { name: "Setup changed elsewhere" }),
    ).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  } finally {
    await heldSave.release?.();
  }
});

test("session-only players require a level, persist, reject duplicate names and can be removed", async ({
  page,
}) => {
  await signInAsNewManager(page, "session-players");
  await page.getByRole("button", { name: "Start a new session" }).click();
  const players = page.getByRole("region", { name: "Who's playing?" });
  const form = players.getByRole("form", { name: "Add a player" });
  await form.getByLabel("First name").fill("Zoë");
  await form.getByLabel("Last name").fill("Núñez");
  await form.getByRole("button", { name: "Add player", exact: true }).click();
  await expect(form.getByText("Choose a level.")).toBeVisible();
  await form.getByLabel("Gender", { exact: true }).selectOption("male");
  await form.getByLabel("Skill", { exact: true }).selectOption("intermediate");
  await form.getByRole("button", { name: "Add player", exact: true }).click();
  await expect(
    players.getByRole("button", { name: "Remove Zoë Núñez" }),
  ).toBeEnabled();
  await page.reload();
  await expect(players.getByRole("list", { name: "Players" })).toContainText(
    "Zoë Núñez",
  );
  await form.getByLabel("First name").fill("ZOE");
  await form.getByLabel("Last name").fill("nunez");
  await form.getByLabel("Gender", { exact: true }).selectOption("male");
  await form.getByLabel("Skill", { exact: true }).selectOption("advanced");
  await form.getByRole("button", { name: "Add player", exact: true }).click();
  await expect(players.getByText(/already in this session/)).toBeVisible();
  await expect(
    players.getByRole("list", { name: "Players" }).getByRole("listitem"),
  ).toHaveCount(1);
  await page.reload();
  await players.getByRole("button", { name: "Remove Zoë Núñez" }).click();
  await expect(players.getByRole("list", { name: "Players" })).toHaveCount(0);
  await page.reload();
  await expect(players.getByRole("list", { name: "Players" })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test("short Setup saves numbered courts and duration, reloads and discards with confirmation", async ({
  page,
}) => {
  const { email, socialId } = await signInAsNewManager(page, "short-setup");
  const userId = (await findUserIdByEmail(email))!;
  testHostUserIds.push(userId);
  await startNewDraft(page);
  await page.getByLabel("Session name").fill("Short phone social");
  await page.getByLabel("Court count").fill("3");
  await page.getByLabel("Session duration (minutes)").fill("90");
  await expectSaved(page);
  const sessionId = await openDraftSessionId(userId);
  const { data: before, error } = await adminClient
    .from("sessions")
    .select("config_snapshot,planned_start,planned_end")
    .eq("id", sessionId)
    .eq("social_id", socialId)
    .single();
  if (error) throw error;
  expect(
    (
      before.config_snapshot as { courts: { name: string; format: string }[] }
    ).courts.map((c) => [c.name, c.format]),
  ).toEqual([
    ["Court 1", "doubles"],
    ["Court 2", "doubles"],
    ["Court 3", "doubles"],
  ]);
  expect(
    Date.parse(before.planned_end) - Date.parse(before.planned_start),
  ).toBe(90 * 60_000);
  await page.reload();
  await expectSaved(page);
  await expect(page.getByLabel("Court count")).toHaveValue("3");
  await expect(page.getByLabel("Session duration (minutes)")).toHaveValue("90");
  await expect(page.getByLabel("Location (optional)")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start session", exact: true }),
  ).toBeDisabled();
  await expectNoHorizontalScroll(page);
  await discardDraftForAllHosts(page, "Short phone social");
  await expect(
    page.getByRole("heading", { name: "No session in progress" }),
  ).toBeVisible();
});

test("a host confirms Start and reaches the live Courts screen", async ({
  page,
}) => {
  const { email, socialId } = await signInAsNewManager(page, "simple-start");
  const userId = (await findUserIdByEmail(email))!;
  testHostUserIds.push(userId);
  await startNewDraft(page);
  const sessionId = await openDraftSessionId(userId);
  const { error } = await adminClient.from("session_participants").insert(
    Array.from({ length: 4 }, (_, i) => ({
      social_id: socialId,
      session_id: sessionId,
      first_name: `Player${i}`,
      last_name: "Starter",
      gender: "male",
      skill_level: "intermediate" as const,
    })),
  );
  if (error) throw error;
  await page.reload();
  await expectSaved(page);
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Start .*social\?/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Confirm start" }).click();
  await expect(page).toHaveURL(/\/live$/);
  await expect(
    page.getByRole("heading", { name: "Courts & Up next", exact: true }),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);
});
