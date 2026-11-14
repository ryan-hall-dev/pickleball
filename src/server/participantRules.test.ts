// @vitest-environment node
import { describe, expect, it } from "vitest";
import { personNameSchema } from "./participantRules";
describe("session participant names", () => {
  const schema = personNameSchema("Enter a name.");
  it("trims and collapses spacing while preserving accents", () => {
    expect(schema.parse("  Zoë   de  la Núñez  ")).toBe("Zoë de la Núñez");
  });
  it.each(["", "   ", "x".repeat(51), "Name\u0000", "Name\u007f"])(
    "rejects invalid name %j",
    (name) => {
      expect(schema.safeParse(name).success).toBe(false);
    },
  );
  it("accepts the maximum length", () => {
    expect(schema.parse("x".repeat(50))).toHaveLength(50);
  });
});
