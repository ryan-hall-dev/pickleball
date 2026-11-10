// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkinSubmitInputSchema,
  checkinTagSchema,
  isSearchableQuery,
  searchQuerySchema,
  validateGuestForm,
} from "./checkinRules";

describe("validateGuestForm", () => {
  it("needs all three fields, with the copy deck's messages", () => {
    expect(
      validateGuestForm({ firstName: "", lastName: "  ", skillLevel: null }),
    ).toEqual({
      isValid: false,
      fieldErrors: {
        firstName: "Enter your first name",
        lastName: "Enter your last name",
        skillLevel: "Choose your level",
      },
    });
  });

  it("reports only the missing field", () => {
    expect(
      validateGuestForm({
        firstName: "Kai",
        lastName: "",
        skillLevel: "beginner",
      }),
    ).toEqual({
      isValid: false,
      fieldErrors: {
        firstName: undefined,
        lastName: "Enter your last name",
        skillLevel: undefined,
      },
    });
  });

  it("tidies the names and accepts a complete form", () => {
    expect(
      validateGuestForm({
        firstName: "  Kai ",
        lastName: "de  la Moreno",
        skillLevel: "intermediate",
      }),
    ).toEqual({
      isValid: true,
      input: {
        kind: "guest",
        firstName: "Kai",
        lastName: "de la Moreno",
        skillLevel: "intermediate",
      },
    });
  });

  it("refuses names longer than the database allows", () => {
    const validation = validateGuestForm({
      firstName: "K".repeat(51),
      lastName: "Moreno",
      skillLevel: "advanced",
    });
    expect(validation).toMatchObject({
      isValid: false,
      fieldErrors: { firstName: "Use at most 50 characters." },
    });
  });
});

describe("checkinSubmitInputSchema", () => {
  const memberInput = {
    kind: "member",
    memberId: "a0000000-0000-4000-8000-000000000001",
    firstName: "Grace",
    lastName: "Kim",
    updatedSkillLevel: null,
  };

  it("accepts a member with or without an updated level", () => {
    expect(checkinSubmitInputSchema.safeParse(memberInput).success).toBe(true);
    expect(
      checkinSubmitInputSchema.safeParse({
        ...memberInput,
        updatedSkillLevel: "advanced",
      }).success,
    ).toBe(true);
  });

  it("refuses a malformed member id or level", () => {
    expect(
      checkinSubmitInputSchema.safeParse({ ...memberInput, memberId: "42" })
        .success,
    ).toBe(false);
    expect(
      checkinSubmitInputSchema.safeParse({
        ...memberInput,
        updatedSkillLevel: "pro",
      }).success,
    ).toBe(false);
    expect(
      checkinSubmitInputSchema.safeParse({ ...memberInput, kind: "host" })
        .success,
    ).toBe(false);
  });
});

describe("search and tag inputs", () => {
  it("searches only from 2 letters, folded like search_name", () => {
    expect(isSearchableQuery("")).toBe(false);
    expect(isSearchableQuery(" P ")).toBe(false);
    expect(isSearchableQuery("Pe")).toBe(true);
    expect(isSearchableQuery("É ")).toBe(false);
    expect(isSearchableQuery("Él")).toBe(true);
  });

  it("refuses queries longer than any name", () => {
    expect(searchQuerySchema.safeParse("a".repeat(50)).success).toBe(true);
    expect(searchQuerySchema.safeParse("a".repeat(51)).success).toBe(false);
    expect(searchQuerySchema.safeParse(42).success).toBe(false);
  });

  it("accepts only the check-in tag format", () => {
    expect(checkinTagSchema.safeParse("k7qm2xpa0123456789ab").success).toBe(
      true,
    );
    expect(checkinTagSchema.safeParse("short").success).toBe(false);
    expect(checkinTagSchema.safeParse("UPPER0123456789abcdef").success).toBe(
      false,
    );
    expect(checkinTagSchema.safeParse("../../admin-0123456789").success).toBe(
      false,
    );
  });
});
