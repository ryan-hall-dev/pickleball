// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isSameFullName,
  MEMBER_NAME_MAX_LENGTH,
  memberFullNameKey,
  memberInputSchema,
} from "./memberRules";

function fieldErrorsFor(input: unknown) {
  const parsed = memberInputSchema.safeParse(input);
  if (parsed.success) throw new Error("expected the input to be refused");
  return z.flattenError(parsed.error).fieldErrors;
}

describe("memberInputSchema", () => {
  it("trims names, collapses inner whitespace and accepts a level", () => {
    expect(
      memberInputSchema.parse({
        firstName: "  Anne \t Marie ",
        lastName: " O'Brien ",
        skillLevel: "intermediate",
      }),
    ).toEqual({
      firstName: "Anne Marie",
      lastName: "O'Brien",
      skillLevel: "intermediate",
    });
  });

  it('treats "Not set" (empty) as no level', () => {
    expect(
      memberInputSchema.parse({
        firstName: "Grace",
        lastName: "Kim",
        skillLevel: "",
      }).skillLevel,
    ).toBeNull();
  });

  it("requires both names", () => {
    expect(
      fieldErrorsFor({ firstName: "  ", lastName: "", skillLevel: "" }),
    ).toEqual({
      firstName: ["Enter a first name."],
      lastName: ["Enter a last name."],
    });
  });

  it("accepts the longest name the database allows and refuses one more", () => {
    const longestName = "a".repeat(MEMBER_NAME_MAX_LENGTH);
    expect(
      memberInputSchema.safeParse({
        firstName: longestName,
        lastName: "Kim",
        skillLevel: "",
      }).success,
    ).toBe(true);
    expect(
      fieldErrorsFor({
        firstName: `${longestName}a`,
        lastName: "Kim",
        skillLevel: "",
      }).firstName,
    ).toEqual([`Use at most ${MEMBER_NAME_MAX_LENGTH} characters.`]);
  });

  it("refuses control characters", () => {
    expect(
      fieldErrorsFor({
        firstName: "Gr\u0000ace",
        lastName: "Kim",
        skillLevel: "",
      }).firstName,
    ).toEqual(["Remove special characters."]);
  });

  it("refuses an unknown skill level", () => {
    expect(
      fieldErrorsFor({ firstName: "Grace", lastName: "Kim", skillLevel: "pro" })
        .skillLevel,
    ).toEqual(["Choose a skill level from the list."]);
  });

  it("refuses missing fields", () => {
    expect(memberInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("memberFullNameKey and isSameFullName", () => {
  it("fold case, accents and spacing like members.search_name", () => {
    expect(memberFullNameKey({ firstName: "Zoë", lastName: "Núñez" })).toBe(
      "zoe nunez",
    );
    expect(
      isSameFullName(
        { firstName: "Zoe", lastName: "Nunez" },
        { firstName: "Zoë", lastName: "Núñez" },
      ),
    ).toBe(true);
    expect(
      isSameFullName(
        { firstName: "anne  marie", lastName: "KIM" },
        { firstName: "Anne Marie", lastName: "Kim" },
      ),
    ).toBe(true);
  });

  it("tell different names apart, including ones with symbols", () => {
    expect(
      isSameFullName(
        { firstName: "Grace", lastName: "Kimm" },
        { firstName: "Grace", lastName: "Kim" },
      ),
    ).toBe(false);
    expect(
      isSameFullName(
        { firstName: "Ja*ne", lastName: "Doe" },
        { firstName: "Jaxne", lastName: "Doe" },
      ),
    ).toBe(false);
    expect(
      isSameFullName(
        { firstName: "Ja*ne", lastName: "Doe" },
        { firstName: "JA*NE", lastName: "doe" },
      ),
    ).toBe(true);
  });
});
