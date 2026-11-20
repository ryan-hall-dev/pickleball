import { expect, test, type Page } from "@playwright/test";
import {
  addHostRow,
  createLogin,
  createSocial,
  deleteCreatedLogins,
  mailpitSearchUrl,
  readNewestSignInCode,
  uniqueEmail,
  uniqueSocialName,
  useRandomClientIp,
} from "./support/localHostSession";

// A host whose phone is set to Vietnamese runs a session in Vietnamese at
// phone width (docs/plans/bilingual-ui.md phase 2).
test.use({ locale: "vi-VN", viewport: { width: 390, height: 844 } });
test.afterAll(deleteCreatedLogins);

async function expectNoSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
}

test("a Vietnamese phone signs in, sets up and runs a game in Vietnamese, then switches to English", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await useRandomClientIp(page);
  const email = uniqueEmail("host-vi");
  const socialId = await createSocial(uniqueSocialName("host-vi"));
  await addHostRow(
    await createLogin(email),
    "E2E host-vi",
    "manager",
    socialId,
  );

  // Sign in, in Vietnamese from the first visit.
  await fetch(mailpitSearchUrl(email), { method: "DELETE" });
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "Đăng nhập người tổ chức" }),
  ).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Gửi mã" }).click();
  await expect(
    page.getByRole("heading", { name: "Kiểm tra email của bạn" }),
  ).toBeVisible();
  await page.getByLabel("Mã 6 chữ số").fill(await readNewestSignInCode(email));
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.waitForURL((url) => url.pathname === "/setup");

  // Setup.
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expect(
    page.getByRole("heading", { name: "Chuẩn bị buổi chơi" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Tạo buổi chơi mới" }).click();
  await page.getByLabel("Tên buổi chơi").fill("Buổi tối thứ Sáu");
  await page.getByLabel("Số sân").fill("1");
  await page.getByLabel("Thời lượng (phút)").fill("60");
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Đã lưu");
  const playerForm = page.getByRole("form", { name: "Thêm người chơi" });
  const addButton = playerForm.getByRole("button", {
    name: "Thêm người chơi",
  });
  // Field errors from the shared rules show in Vietnamese.
  await addButton.click();
  await expect(playerForm.getByText("Nhập tên.")).toBeVisible();
  for (const firstName of ["An", "Bình", "Châu", "Dũng"]) {
    await playerForm.getByLabel("Tên", { exact: true }).fill(firstName);
    await playerForm.getByLabel("Họ", { exact: true }).fill("Nguyễn");
    await playerForm.getByLabel("Giới tính").selectOption("male");
    await playerForm.getByLabel("Trình độ").selectOption("intermediate");
    await addButton.click();
    await expect(
      page.getByRole("button", { name: `Xóa ${firstName} Nguyễn` }),
    ).toBeEnabled();
  }
  await expectNoSidewaysScroll(page);
  await page
    .getByRole("button", { name: "Bắt đầu buổi chơi", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Bắt đầu Buổi tối thứ Sáu?" })
    .getByRole("button", { name: "Xác nhận bắt đầu" })
    .click();
  await expect(page).toHaveURL(/\/live$/);

  // Live: the free court gets its four, the host starts and finishes a game.
  const court = page.getByRole("article", { name: "Sân 1" });
  await court.getByRole("button", { name: "Bắt đầu trận" }).click();
  await expect(court.getByText(/^Đang chơi · \d+ phút$/)).toBeVisible();
  await expectNoSidewaysScroll(page);
  await court.getByRole("button", { name: "Trận đã xong" }).click();
  await expect(court.getByText("Sẵn sàng bắt đầu")).toBeVisible();

  // Switching to English applies at once and is remembered.
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("article", { name: "Court 1" })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Courts & Up next" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
