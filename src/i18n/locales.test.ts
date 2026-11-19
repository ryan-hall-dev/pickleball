// @vitest-environment node
import { describe, expect, it } from "vitest";
import { localeFromAcceptLanguage, pickLocale } from "./locales";
import { MESSAGES, translateValidationMessage } from "./messages";

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
