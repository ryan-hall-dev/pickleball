// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "@/engine";

describe("engine", () => {
  it("exposes the engine version", () => {
    expect(ENGINE_VERSION).toBe(1);
  });
});
