import { describe, expect, it } from "vitest";
import { initialsFromName } from "./InitialsAvatar";

describe("initialsFromName", () => {
  it.each([
    ["Grace Kim", "GK"],
    ["  ada   lovelace byron ", "AB"],
    ["Local", "L"],
    ["élodie durand", "ÉD"],
    ["", "?"],
    ["   ", "?"],
  ])("%j → %j", (name, initials) => {
    expect(initialsFromName(name)).toBe(initials);
  });
});
