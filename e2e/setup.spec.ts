// Session setup (/setup) against the LOCAL Supabase stack: Session details,
// Courts, Who's playing and the Session summary. Runs on desktop and on a
// phone (the `mobile` project). Test courts carry a unique token in their
// name; test sessions belong to the test's own host. Everything is removed
// afterwards. Players exist only inside their session.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  addHostRow,
  adminClient,
  createLogin,
  createSocial,
  deleteCreatedLogins,
  findUserIdByEmail,
  signIn,
  signInAsNewManager,
  uniqueEmail,
  uniqueSocialName,
  useRandomClientIp,
} from "./support/localHostSession";

const testHostUserIds: string[] = [];

function uniqueCourtToken(): string {
  const token = `Zqcourt${randomUUID().slice(0, 8)}`;
  return token;
}

/** Adds courts to a social, after its existing ones, in the given order. */
async function insertCourts(socialId: string, courtNames: string[]) {
  const { error } = await adminClient.from("courts").insert(
    courtNames.map((name, index) => ({
      social_id: socialId,
      name,
      sort_order: 900_001 + index,
    })),
  );
  if (error) throw error;
}

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

test("a host sets up a draft's details and courts, sees the summary, reloads and discards it", async ({
  page,
}) => {
  const courtToken = uniqueCourtToken();
  const { email, socialId } = await signInAsNewManager(
    page,
    "setup",
    (newSocialId) =>
      insertCourts(newSocialId, [`${courtToken} A`, `${courtToken} B`]),
  );
  const hostUserId = (await findUserIdByEmail(email))!;
  testHostUserIds.push(hostUserId);

  // Open Session setup from the nav: no draft yet.
  const setupNavLink = page
    .getByRole("navigation", { name: "Host" })
    .getByRole("link", { name: "Session setup" });
  await setupNavLink.click();
  await expect(
    page.getByRole("heading", { name: "Set up a session" }),
  ).toBeVisible();
  await expect(setupNavLink).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "No session in progress" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start a new session" }).click();
  await expect(
    page.getByRole("heading", { name: "Session details" }),
  ).toBeVisible();
  await expectSaved(page);

  // Session details: name, date, times and duration chips.
  await page.getByLabel("Session name").fill("E2E Saturday social");
  await page.getByLabel("Date").fill("2026-12-05");
  await page.getByLabel("Start time").fill("18:00");
  await page.getByRole("button", { name: "90 min" }).click();
  await expect(page.getByLabel("End time")).toHaveValue("19:30");
  await expect(page.getByRole("button", { name: "90 min" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByText("· 90 minutes, calculated from start and end"),
  ).toBeVisible();
  // An earlier end time is the next day: fine up to 12 hours, refused beyond.
  const endTimeInput = page.getByLabel("End time");
  await endTimeInput.fill("01:00");
  await expect(page.getByText("(next day)")).toBeVisible();
  await expect(endTimeInput).not.toHaveAttribute("aria-invalid");
  await endTimeInput.fill("17:00");
  await expect(endTimeInput).toHaveAttribute("aria-invalid", "true");
  await expect(endTimeInput).toHaveAccessibleDescription(
    "(next day) A session can last at most 12 hours.",
  );
  await expect(saveStatus(page)).toContainText("Not saved");
  await page.getByLabel("End time").fill("19:30");
  await page.getByLabel("Location (optional)").fill("Riverside courts");
  await expectSaved(page);

  // Courts: pick the two test courts, add one through "Add court", choose singles.
  const courtA = page.getByRole("button", {
    name: new RegExp(`${courtToken} A`),
  });
  const courtB = page.getByRole("button", {
    name: new RegExp(`${courtToken} B`),
  });
  await courtA.click();
  await courtB.click();
  await expect(courtA).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("8 on court")).toBeVisible();
  await page.getByRole("button", { name: "Singles · 1 v 1" }).click();
  await expect(
    page.getByRole("button", { name: "Singles · 1 v 1" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("4 on court")).toBeVisible();
  // A new singles-only court is selected straight away, and then doubles is
  // unavailable until it's removed again.
  await page.getByRole("button", { name: "Add court", exact: true }).click();
  await page.getByLabel("Court name").fill(`${courtToken} C`);
  await page.getByRole("button", { name: "Doubles", exact: true }).click();
  await page.getByRole("button", { name: "Add court", exact: true }).click();
  const courtC = page.getByRole("button", {
    name: new RegExp(`${courtToken} C`),
  });
  await expect(courtC).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Doubles · 2 v 2" }),
  ).toBeDisabled();
  await expect(page.getByText("6 on court")).toBeVisible();
  await expectSaved(page);

  const summary = page.getByRole("complementary", {
    name: "Session summary and start",
  });
  await expect(summary).toContainText("E2E Saturday social");
  await expect(summary).toContainText("Sat 5 Dec · 18:00 – 19:30");
  await expect(summary).toContainText("90 min");
  await expect(summary).toContainText("3 · singles");
  await expect(summary).toContainText(
    "Not enough players: a court needs 2 and 0 are attending.",
  );
  await expect(
    summary.getByRole("button", { name: /start pickleball session/i }),
  ).toBeDisabled();
  await expectNoHorizontalScroll(page);

  // Players arrive in a later step; add ten guests directly to see the estimate.
  const sessionId = await openDraftSessionId(hostUserId);
  const { error: guestsError } = await adminClient
    .from("session_participants")
    .insert(
      Array.from({ length: 10 }, (_, index) => ({
        session_id: sessionId,
        social_id: socialId,
        first_name: `Guest${index}`,
        skill_level: "beginner" as const,
        last_name: courtToken,
      })),
    );
  if (guestsError) throw guestsError;

  // Reload: everything persisted.
  await page.reload();
  await expect(page.getByLabel("Session name")).toHaveValue(
    "E2E Saturday social",
  );
  await expect(page.getByLabel("Date")).toHaveValue("2026-12-05");
  await expect(page.getByLabel("Start time")).toHaveValue("18:00");
  await expect(page.getByLabel("End time")).toHaveValue("19:30");
  await expect(page.getByLabel("Location (optional)")).toHaveValue(
    "Riverside courts",
  );
  await expect(courtA).toHaveAttribute("aria-pressed", "true");
  await expect(courtC).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Singles · 1 v 1" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(summary).toContainText("Players10");
  await expect(
    summary.getByRole("img", {
      name: "Capacity: 3 courts of 2 players, 6 on court, 4 waiting",
    }),
  ).toBeVisible();
  // 90 min of 15 + 2 min slots = 5 rounds; 6 seats for 10 players = 3 games each.
  await expect(summary).toContainText(
    "About 5 rounds fit in 90 min, so expect 3 games per player.",
  );
  await expect(
    page.getByText("10 players → 4 waiting at the start"),
  ).toBeVisible();

  // Removing a court updates the estimate and re-enables doubles.
  await page.getByRole("button", { name: "Remove a court" }).click();
  await expect(courtC).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Doubles · 2 v 2" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Doubles · 2 v 2" }).click();
  await expect(summary).toContainText(
    "About 5 rounds fit in 90 min, so expect 4 games per player.",
  );
  await expectSaved(page);
  await expectNoHorizontalScroll(page);

  // Discard (after removing the test guests, which only a draft allows).
  await adminClient
    .from("session_participants")
    .delete()
    .eq("session_id", sessionId);
  // The dialog names the draft and the co-host impact; Esc keeps the draft.
  await page.getByRole("button", { name: "Discard draft" }).click();
  const discardDialog = page.getByRole("dialog", {
    name: "Discard “E2E Saturday social”?",
  });
  await expect(discardDialog).toContainText("for every host of");
  await expect(
    discardDialog.getByRole("button", { name: "Keep draft" }),
  ).toBeFocused();
  await expect(
    discardDialog.getByRole("button", { name: "Discard for all hosts" }),
  ).toBeDisabled();
  await expectNoHorizontalScroll(page);
  await page.keyboard.press("Escape");
  await expect(discardDialog).toBeHidden();
  const { data: kept } = await adminClient
    .from("sessions")
    .select("status")
    .eq("id", sessionId)
    .single();
  expect(kept?.status).toBe("draft");
  await discardDraftForAllHosts(page, "E2E Saturday social");
  await expect(
    page.getByRole("heading", { name: "No session in progress" }),
  ).toBeVisible();
  const { data: discarded } = await adminClient
    .from("sessions")
    .select("status")
    .eq("id", sessionId)
    .single();
  expect(discarded?.status).toBe("cancelled");
});

test("setup works from the keyboard with a visible focus ring", async ({
  page,
}) => {
  const { email } = await signInAsNewManager(page, "setup-keys");
  testHostUserIds.push((await findUserIdByEmail(email))!);
  await page.goto("/setup");
  await page.getByRole("button", { name: "Start a new session" }).click();
  await expect(
    page.getByRole("heading", { name: "Session details" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "60 min" }).focus();
  await page.keyboard.press("Tab");
  const chip90 = page.getByRole("button", { name: "90 min" });
  await expect(chip90).toBeFocused();
  await expect(chip90).toHaveCSS("outline-style", "solid");
  await expect(chip90).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Space");
  await expect(chip90).toHaveAttribute("aria-pressed", "true");
  // "Custom…" moves focus to the end time, where a custom length is typed.
  await page.getByRole("button", { name: "Custom…" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("End time")).toBeFocused();
  await expectSaved(page);
  await expectNoHorizontalScroll(page);
});

async function startNewDraft(page: Page) {
  await page.goto("/setup");
  await page.getByRole("button", { name: "Start a new session" }).click();
  await expect(
    page.getByRole("heading", { name: "Who's playing?" }),
  ).toBeVisible();
}

test("a host who isn't the social manager can't add courts", async ({
  page,
}) => {
  const email = uniqueEmail("setup-host");
  const hostUserId = await createLogin(email);
  await addHostRow(
    hostUserId,
    "E2E setup host",
    "host",
    await createSocial(uniqueSocialName("setup-host")),
  );
  testHostUserIds.push(hostUserId);
  await signIn(page, email);
  await startNewDraft(page);
  await expect(page.getByRole("heading", { name: "Courts" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add court", exact: true }),
  ).toHaveCount(0);
});

test("a second social's manager sees only their own social's courts", async ({
  page,
}) => {
  const courtToken = uniqueCourtToken();
  // Social A, with nobody signed in: a court that B must never see.
  const socialAId = await createSocial(uniqueSocialName("setup-social-a"));
  await insertCourts(socialAId, [`${courtToken} Court 1`]);

  // Social B has its own "Court 1" (names are unique per social).
  const { email } = await signInAsNewManager(
    page,
    "setup-social-b",
    async (socialBId) => {
      await insertCourts(socialBId, [`${courtToken} Court 1`]);
    },
  );
  testHostUserIds.push((await findUserIdByEmail(email))!);

  await startNewDraft(page);
  await expect(
    page.getByRole("button", { name: new RegExp(`${courtToken} Court 1`) }),
  ).toHaveCount(1);
});

const RECOMMENDED_PRIORITY_LABELS = [
  "Equal games for everyone",
  "Shortest waits",
  "Playing time",
  "Full courts",
  "No back-to-back games",
  "Mix up partners",
];

async function expectPriorityOrder(page: Page, expectedLabels: string[]) {
  const rows = page
    .getByRole("list", { name: "What matters most" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(expectedLabels.length);
  for (const [index, label] of expectedLabels.entries()) {
    await expect(rows.nth(index)).toContainText(`${index + 1}. ${label}`);
  }
}

async function savedRotation(hostUserId: string) {
  const { data, error } = await adminClient
    .from("sessions")
    .select("config_snapshot")
    .eq("host_id", hostUserId)
    .eq("status", "draft")
    .single();
  if (error) throw error;
  return (data.config_snapshot as { rotation?: unknown }).rotation;
}

test("a host reorders the rotation and switches rules; it persists across navigation, tabs and reloads", async ({
  page,
  context,
}) => {
  const { email } = await signInAsNewManager(page, "setup-rotation");
  const hostUserId = (await findUserIdByEmail(email))!;
  testHostUserIds.push(hostUserId);
  await startNewDraft(page);
  await expectPriorityOrder(page, RECOMMENDED_PRIORITY_LABELS);
  const manualSwitch = page.getByRole("switch", {
    name: "Allow manual assignments",
  });
  await expect(manualSwitch).toHaveAttribute("aria-checked", "true");

  // Buttons: Shortest waits to the top; focus stays on that row.
  await page.getByRole("button", { name: "Move Shortest waits up" }).click();
  await expect(
    page.getByRole("button", { name: "Move Shortest waits down" }),
  ).toBeFocused();
  if (test.info().project.name === "mobile") {
    // Keyboard on a phone: the Move button. dnd-kit's keyboard drag scrolls
    // the page instead of moving the row on this viewport (a dnd-kit quirk;
    // the buttons are the supported path there).
    await page.getByRole("button", { name: "Move Mix up partners up" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Move Mix up partners up" }),
    ).toBeFocused();
  } else {
    // Keyboard drag: pick up Mix up partners, move it up one, drop it. Each
    // step waits for dnd-kit's screen-reader announcement ("Picked up…" is
    // replaced at once by where the row is now).
    await page
      .getByRole("button", { name: "Drag to reorder Mix up partners" })
      .focus();
    await page.keyboard.press("Space");
    await expect(
      page.getByText("Mix up partners is over position 6 of 6."),
    ).toBeAttached();
    // dnd-kit starts listening for arrow keys a tick after the pick-up is
    // announced, so a very quick first ArrowUp can be missed: press again
    // until it lands (a press that lands is announced well within 500ms).
    await expect(async () => {
      await page.keyboard.press("ArrowUp");
      await expect(
        page.getByText("Mix up partners is over position 5 of 6."),
      ).toBeAttached({ timeout: 500 });
    }).toPass({ timeout: 5_000 });
    await page.keyboard.press("Space");
  }
  const reorderedLabels = [
    "Shortest waits",
    "Equal games for everyone",
    "Playing time",
    "Full courts",
    "Mix up partners",
    "No back-to-back games",
  ];
  await expectPriorityOrder(page, reorderedLabels);
  await manualSwitch.click();
  await expect(manualSwitch).toHaveAttribute("aria-checked", "false");
  await expectSaved(page);
  expect(await savedRotation(hostUserId)).toEqual({
    objectiveOrder: [
      "shortestWaits",
      "equalGames",
      "playingTime",
      "fullCourts",
      "mixPartners",
      "noBackToBack",
    ],
    rules: {
      preventConsecutive: true,
      fewerGamesFirst: true,
      longestWaitFirst: true,
      mixPartners: true,
      minimiseRepeatOpponents: true,
      allowManualAssignments: false,
    },
  });

  // Away to Hosts and back: still there.
  const nav = page.getByRole("navigation", { name: "Host" });
  await nav.getByRole("link", { name: "Hosts" }).click();
  await expect(page).toHaveURL(/\/hosts$/);
  await nav.getByRole("link", { name: "Session setup" }).click();
  await expectPriorityOrder(page, reorderedLabels);
  await expect(manualSwitch).toHaveAttribute("aria-checked", "false");

  // A second tab shows the same; a rule changed there shows in tab 1 on reload.
  const secondTab = await context.newPage();
  await secondTab.goto("/setup");
  await expectPriorityOrder(secondTab, reorderedLabels);
  await expect(
    secondTab.getByRole("switch", { name: "Allow manual assignments" }),
  ).toHaveAttribute("aria-checked", "false");
  const secondTabOpponents = secondTab.getByRole("switch", {
    name: "Rotate opponents",
  });
  await secondTabOpponents.click();
  await expect(secondTabOpponents).toHaveAttribute("aria-checked", "false");
  await expectSaved(secondTab);
  await secondTab.close();
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "Rotate opponents" }),
  ).toHaveAttribute("aria-checked", "false");
  await expectPriorityOrder(page, reorderedLabels);

  // Leaving within the autosave delay still saves the last change.
  await page.getByRole("button", { name: "Move Playing time up" }).click();
  await nav.getByRole("link", { name: "Hosts" }).click();
  await expect(page).toHaveURL(/\/hosts$/);
  await expect
    .poll(async () => {
      const rotation = (await savedRotation(hostUserId)) as {
        objectiveOrder: string[];
      };
      return rotation.objectiveOrder.slice(0, 2);
    })
    .toEqual(["shortestWaits", "playingTime"]);
  await nav.getByRole("link", { name: "Session setup" }).click();
  await expectPriorityOrder(page, [
    "Shortest waits",
    "Playing time",
    "Equal games for everyone",
    "Full courts",
    "Mix up partners",
    "No back-to-back games",
  ]);
  // Back on the (cached) route, the next edit saves: the flush on leaving
  // recorded the new revision, so no false "changed elsewhere".
  await page.getByLabel("Location (optional)").fill("After a quick leave");
  await expectSaved(page);
  await expect(
    page.getByRole("region", { name: "Setup changed elsewhere" }),
  ).toHaveCount(0);
  await expect
    .poll(async () => {
      const { data } = await adminClient
        .from("sessions")
        .select("location")
        .eq("host_id", hostUserId)
        .eq("status", "draft")
        .single();
      return data?.location;
    })
    .toBe("After a quick leave");
  await expectNoHorizontalScroll(page);
});

test("a host saves a setup, discards the draft, and reuses the setup in a new one", async ({
  page,
}) => {
  const courtToken = uniqueCourtToken();
  const { email } = await signInAsNewManager(page, "setup-saved", (socialId) =>
    insertCourts(socialId, [`${courtToken} A`, `${courtToken} B`]),
  );
  const hostUserId = (await findUserIdByEmail(email))!;
  testHostUserIds.push(hostUserId);
  await startNewDraft(page);
  // A new host has nothing to reuse.
  await expect(
    page.getByRole("region", { name: "Reuse a saved setup" }),
  ).toHaveCount(0);

  await page.getByLabel("Session name").fill("E2E Thursday ladder");
  await page.getByLabel("Location (optional)").fill("Riverside courts");
  await page.getByRole("button", { name: "90 min" }).click();
  const courtA = page.getByRole("button", {
    name: new RegExp(`${courtToken} A`),
  });
  await courtA.click();
  await page.getByRole("button", { name: "Move Playing time up" }).click();
  await page.getByRole("switch", { name: "Allow manual assignments" }).click();
  await expectSaved(page);

  await page.getByRole("button", { name: "Save this setup" }).click();
  await expect(page.getByLabel("Setup name")).toHaveValue(
    "E2E Thursday ladder",
  );
  await page.getByRole("button", { name: "Save setup" }).click();
  await expect(page.getByText("Saved “E2E Thursday ladder”.")).toBeVisible();

  // A fresh draft starts from the defaults and offers the setup.
  await discardDraftForAllHosts(page, "E2E Thursday ladder");
  await page.getByRole("button", { name: "Start a new session" }).click();
  const banner = page.getByRole("region", { name: "Reuse a saved setup" });
  await expect(banner).toContainText("Reuse “E2E Thursday ladder” · last used");
  await expect(banner).toContainText("1 court · Equal games first");
  await expect(page.getByLabel("Location (optional)")).toHaveValue("");
  await expect(courtA).toHaveAttribute("aria-pressed", "false");
  const defaultName = await page.getByLabel("Session name").inputValue();
  const startTime = await page.getByLabel("Start time").inputValue();

  await banner.getByRole("button", { name: "Use this setup" }).click();
  await expect(page.getByText("Using “E2E Thursday ladder”.")).toBeVisible();
  await expect(banner).toHaveCount(0);
  const expectAppliedValues = async () => {
    await expect(page.getByLabel("Location (optional)")).toHaveValue(
      "Riverside courts",
    );
    await expect(courtA).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "90 min" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectPriorityOrder(page, [
      "Equal games for everyone",
      "Playing time",
      "Shortest waits",
      "Full courts",
      "No back-to-back games",
      "Mix up partners",
    ]);
    await expect(
      page.getByRole("switch", { name: "Allow manual assignments" }),
    ).toHaveAttribute("aria-checked", "false");
    // The session's own name and start stay.
    await expect(page.getByLabel("Session name")).toHaveValue(defaultName);
    await expect(page.getByLabel("Start time")).toHaveValue(startTime);
  };
  await expectAppliedValues();
  await expectSaved(page);

  // Reload: applied values persisted, and the banner doesn't come back.
  await page.reload();
  await expectAppliedValues();
  await expect(
    page.getByRole("region", { name: "Reuse a saved setup" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Saved setups" }).click();
  await expect(
    page.getByRole("region", { name: "Saved setups" }).getByRole("listitem"),
  ).toHaveCount(1);
  await expectNoHorizontalScroll(page);
});

test("the stepper and checklist flag a half-filled guest form", async ({
  page,
}) => {
  const { email, socialId } = await signInAsNewManager(page, "setup-stepper");
  const hostUserId = (await findUserIdByEmail(email))!;
  testHostUserIds.push(hostUserId);
  await startNewDraft(page);
  const steps = page.getByRole("list", { name: "Setup steps" });
  await expect(steps.getByRole("listitem")).toHaveText([
    "Details, done",
    "2Courts, not started",
    "3Players, not started",
    "Rotation, done",
    "5Review & start, not started",
  ]);

  // Four players attend (enough for doubles), so the guest form is the one thing to fix.
  const sessionId = await openDraftSessionId(hostUserId);
  const { error: guestsError } = await adminClient
    .from("session_participants")
    .insert(
      Array.from({ length: 4 }, (_, index) => ({
        session_id: sessionId,
        social_id: socialId,
        first_name: `Guest${index}`,
        skill_level: "beginner" as const,
        last_name: "Stepper",
      })),
    );
  if (guestsError) throw guestsError;
  await page.reload();
  await expect(steps.getByRole("listitem").nth(2)).toHaveText("Players, done");

  await page.getByLabel("First name").fill("Kai");
  await expect(steps.getByRole("listitem").nth(2)).toHaveText(
    "!Players · 1 to fix, needs attention",
  );
  const checklist = page.getByRole("list", { name: "Setup checklist" });
  await expect(checklist).toContainText(
    "Participant form has an unfinished entry: add Kai's last name or clear it",
  );
  await expect(
    page.getByRole("button", { name: /start pickleball session/i }),
  ).toBeDisabled();

  await page.getByLabel("First name").fill("");
  await expect(steps.getByRole("listitem").nth(2)).toHaveText("Players, done");
  await expectNoHorizontalScroll(page);
});

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

  // Tab A switches a rule off and saves.
  const tabAOpponents = tabA.getByRole("switch", { name: "Rotate opponents" });
  await tabAOpponents.click();
  await expect(tabAOpponents).toHaveAttribute("aria-checked", "false");
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
  expect(
    (
      row.config_snapshot as {
        rotation: { rules: { minimiseRepeatOpponents: boolean } };
      }
    ).rotation.rules.minimiseRepeatOpponents,
  ).toBe(false);

  // Reload: tab B shows tab A's value and can save again.
  await conflictBanner.getByRole("button", { name: "Reload" }).click();
  await expect(
    tabB.getByRole("switch", { name: "Rotate opponents" }),
  ).toHaveAttribute("aria-checked", "false");
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
  await nav.getByRole("link", { name: "Hosts" }).click();
  await expect(tabB).toHaveURL(/\/hosts$/);
  await nav.getByRole("link", { name: "Session setup" }).click();
  await tabB.getByLabel("Location (optional)").fill("After navigating");
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
  await nav.getByRole("link", { name: "Hosts" }).click();
  await saveIsHeld;
  await expect(page).toHaveURL(/\/hosts$/);
  await nav.getByRole("link", { name: "Session setup" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(saveStatus(page)).toHaveText("Saving…");
  await releaseHeldSave();

  await expectSaved(page);
  await expect(page.getByLabel("Session name")).toHaveValue(
    "Saved on the way out",
  );
  await page.getByLabel("Location (optional)").fill("After coming back");
  await expectSaved(page);
  await expect(
    page.getByRole("region", { name: "Setup changed elsewhere" }),
  ).toHaveCount(0);
  await expect
    .poll(async () => {
      const { data } = await adminClient
        .from("sessions")
        .select("name, location")
        .eq("host_id", hostUserId)
        .eq("status", "draft")
        .single();
      return data;
    })
    .toEqual({ name: "Saved on the way out", location: "After coming back" });
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
