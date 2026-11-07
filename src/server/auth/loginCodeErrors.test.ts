// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  normalizeLoginCode,
  requestLoginCodeOutcomeFromError,
  verifyLoginCodeFailureFromError,
} from "./loginCodeErrors";

describe("requestLoginCodeOutcomeFromError", () => {
  it("reports a sent code when there is no error", () => {
    expect(requestLoginCodeOutcomeFromError(null)).toBe("CODE_SENT");
  });

  it.each(["otp_disabled", "signup_disabled", "user_not_found"])(
    "hides that an email isn't invited (%s) by reporting a sent code",
    (code) => {
      expect(requestLoginCodeOutcomeFromError({ code, status: 422 })).toBe(
        "CODE_SENT",
      );
    },
  );

  it("hides the per-email send limit, which only fires for invited emails", () => {
    expect(
      requestLoginCodeOutcomeFromError({
        code: "over_email_send_rate_limit",
        status: 429,
      }),
    ).toBe("CODE_SENT");
  });

  it("reports the per-IP rate limit by code or by HTTP 429", () => {
    expect(
      requestLoginCodeOutcomeFromError({ code: "over_request_rate_limit" }),
    ).toBe("RATE_LIMITED");
    expect(requestLoginCodeOutcomeFromError({ status: 429 })).toBe(
      "RATE_LIMITED",
    );
  });

  it("reports an invalid email", () => {
    expect(
      requestLoginCodeOutcomeFromError({ code: "email_address_invalid" }),
    ).toBe("INVALID_EMAIL");
  });

  it("reports anything else as unavailable", () => {
    expect(
      requestLoginCodeOutcomeFromError({
        code: "unexpected_failure",
        status: 500,
      }),
    ).toBe("UNAVAILABLE");
    expect(requestLoginCodeOutcomeFromError({})).toBe("UNAVAILABLE");
  });
});

describe("verifyLoginCodeFailureFromError", () => {
  it("reports a wrong or expired code", () => {
    expect(
      verifyLoginCodeFailureFromError({ code: "otp_expired", status: 403 }),
    ).toBe("WRONG_OR_EXPIRED_CODE");
    expect(verifyLoginCodeFailureFromError({ status: 403 })).toBe(
      "WRONG_OR_EXPIRED_CODE",
    );
  });

  it("reports rate limits", () => {
    expect(
      verifyLoginCodeFailureFromError({
        code: "over_request_rate_limit",
        status: 429,
      }),
    ).toBe("RATE_LIMITED");
  });

  it("reports anything else as unavailable", () => {
    expect(verifyLoginCodeFailureFromError({ status: 500 })).toBe(
      "UNAVAILABLE",
    );
  });
});

describe("normalizeLoginCode", () => {
  it("accepts six digits, ignoring spaces and dashes", () => {
    expect(normalizeLoginCode("123456")).toBe("123456");
    expect(normalizeLoginCode(" 123 456 ")).toBe("123456");
    expect(normalizeLoginCode("123-456")).toBe("123456");
  });

  it.each(["", "12345", "1234567", "12a456", "１２３４５６"])(
    "rejects %j",
    (rawCode) => {
      expect(normalizeLoginCode(rawCode)).toBeNull();
    },
  );
});
