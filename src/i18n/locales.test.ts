// @vitest-environment node
import { describe, expect, it } from "vitest";
import { localeFromAcceptLanguage, pickLocale } from "./locales";
import { courtName } from "./courtName";
import {
  MESSAGES,
  translateEngineError,
  translateMessage,
  translateValidationMessage,
} from "./messages";
import { en } from "./messages/en";

describe("picking the language", () => {
  it("uses Vietnamese only when the browser ranks it above English", () => {
    expect(localeFromAcceptLanguage("vi-VN,vi;q=0.9,en-US;q=0.8")).toBe("vi");
    expect(localeFromAcceptLanguage("en-US,en;q=0.9,vi;q=0.8")).toBe("en");
    expect(localeFromAcceptLanguage("fr-FR,vi;q=0.5")).toBe("vi");
    expect(localeFromAcceptLanguage("en;q=0.4,vi;q=0.6")).toBe("vi");
    expect(localeFromAcceptLanguage("vi;q=0")).toBe("en");
    expect(localeFromAcceptLanguage("de-DE")).toBe("en");
    expect(localeFromAcceptLanguage("")).toBe("en");
    expect(localeFromAcceptLanguage(null)).toBe("en");
  });
  it("lets the saved choice win and ignores a tampered cookie", () => {
    expect(pickLocale("en", "vi-VN")).toBe("en");
    expect(pickLocale("vi", "en-US")).toBe("vi");
    expect(pickLocale("xx", "vi-VN")).toBe("vi");
    expect(pickLocale(undefined, undefined)).toBe("en");
  });
});

describe("translated validation messages", () => {
  it("shows the shared English rules in Vietnamese", () => {
    expect(
      translateValidationMessage("Enter your first name", MESSAGES.vi),
    ).toBe("Nhập tên của bạn");
    expect(
      translateValidationMessage("Use at most 50 characters.", MESSAGES.vi),
    ).toBe("Tối đa 50 ký tự.");
    expect(
      translateValidationMessage("Use at most 50 characters.", MESSAGES.en),
    ).toBe("Use at most 50 characters.");
    expect(translateValidationMessage("Something new", MESSAGES.vi)).toBe(
      "Something new",
    );
  });
  it("has every placeholder message in both languages", () => {
    const sample = (messages: typeof MESSAGES.en) =>
      [
        messages.checkin.welcomeHeading("Club X"),
        messages.checkin.approved.title("Ana"),
        messages.checkin.waiting.sent("Friday"),
        messages.checkin.alreadyCheckedIn.nothingMore("Ana"),
        messages.time.minutesLeft(5),
      ].join(" | ");
    expect(sample(MESSAGES.vi)).toContain("Club X");
    expect(sample(MESSAGES.vi)).toContain("Ana");
    expect(sample(MESSAGES.vi)).toContain("Friday");
    expect(sample(MESSAGES.vi)).not.toEqual(sample(MESSAGES.en));
  });
});

describe("host server messages", () => {
  it("shows a fixed server message in Vietnamese and leaves English alone", () => {
    const english = en.serverMessages.live.updatedByAnotherHost;
    expect(translateMessage(english, MESSAGES.vi)).toBe(
      MESSAGES.vi.serverMessages.live.updatedByAnotherHost,
    );
    expect(translateMessage(english, MESSAGES.en)).toBe(english);
  });
  it("keeps the names and numbers a message carries", () => {
    expect(
      translateMessage(
        en.serverMessages.setup.nameAlreadyInSession("Linh", "Tran"),
        MESSAGES.vi,
      ),
    ).toBe(
      MESSAGES.vi.serverMessages.setup.nameAlreadyInSession("Linh", "Tran"),
    );
    expect(
      translateMessage(en.validation.wholeMinutes(1, 720), MESSAGES.vi),
    ).toBe("Nhập số phút nguyên từ 1 đến 720.");
    expect(
      translateMessage(
        en.serverMessages.hosts.nowAHost("Mai Le", "mai@example.com"),
        MESSAGES.vi,
      ),
    ).toContain("mai@example.com");
  });
  it("shows engine rejections by code in Vietnamese, in full in English", () => {
    const error = {
      code: "COURT_BUSY" as const,
      message: "Court 2 already has a game in progress.",
    };
    expect(translateEngineError(error, MESSAGES.en)).toBe(error.message);
    expect(translateEngineError(error, MESSAGES.vi)).toBe(
      "Sân này đang có trận.",
    );
  });
  it("names generated courts in the chosen language only", () => {
    expect(courtName("Court 3", MESSAGES.vi)).toBe("Sân 3");
    expect(courtName("Court 3", MESSAGES.en)).toBe("Court 3");
    expect(courtName("Riverside 1", MESSAGES.vi)).toBe("Riverside 1");
  });
});
