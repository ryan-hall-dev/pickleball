import type { Database } from "@/lib/database.types";

export type SkillLevel = Database["public"]["Enums"]["skill_level"];

export const SKILL_LEVELS = [
  "beginner",
  "intermediate",
  "advanced",
] as const satisfies readonly SkillLevel[];

export const SKILL_LEVEL_LABELS: Record<SkillLevel, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};
