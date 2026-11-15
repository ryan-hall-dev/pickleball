// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkinSubmitInputSchema,
  checkinTagSchema,
  validateCheckinForm,
} from "./checkinRules";

describe("validateCheckinForm", () => {
  it("needs all three fields, with the copy deck's messages", () => {
    expect(
      validateCheckinForm({
        firstName: "",
        lastName: "  ",
        skillLevel: null,
        gender: null,
      }),
    ).toEqual({
      isValid: false,
      fieldErrors: {
        firstName: "Enter your first name",
        lastName: "Enter your last name",
        skillLevel: "Choose your level",
        gender: "Choose male or female.",
      },
    });
  });

  it("reports only the missing field", () => {
    expect(
      validateCheckinForm({
        firstName: "Kai",
        lastName: "",
        skillLevel: "beginner",
        gender: "male" as const,
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
      validateCheckinForm({
        firstName: "  Kai ",
        lastName: "de  la Moreno",
        skillLevel: "intermediate",
        gender: "male" as const,
      }),
    ).toEqual({
      isValid: true,
      input: {
        firstName: "Kai",
        lastName: "de la Moreno",
        skillLevel: "intermediate",
        gender: "male" as const,
      },
    });
  });

  it("refuses names longer than the database allows", () => {
    const validation = validateCheckinForm({
      firstName: "K".repeat(51),
      lastName: "Moreno",
      skillLevel: "advanced",
      gender: "male" as const,
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

  it("refuses the obsolete member path", () => {
    expect(checkinSubmitInputSchema.safeParse(memberInput).success).toBe(false);
  });
});

describe("tag inputs", () => {
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
