import { z } from "zod";
import type { CourtConfig } from "@/engine/session/types";

// Technical bound for court JSON, independent of attendance or membership.
const MAX_SESSION_COURTS = 1000;
const courtIdSchema = z.uuid();

export function sessionCourtsFromCount(
  existing: readonly CourtConfig[],
  count: number,
  createId: () => string,
): CourtConfig[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SESSION_COURTS) {
    throw new Error(
      `Court count must be an integer from 1 to ${MAX_SESSION_COURTS}.`,
    );
  }

  const courtIds = new Set<string>();
  return Array.from({ length: count }, (_, index) => {
    const courtId =
      index < existing.length ? existing[index].courtId : createId();
    if (!courtIdSchema.safeParse(courtId).success) {
      throw new Error("Court IDs must be valid UUIDs.");
    }
    const normalizedCourtId = courtId.toLowerCase();
    if (courtIds.has(normalizedCourtId)) {
      throw new Error("Court IDs must be unique.");
    }
    courtIds.add(normalizedCourtId);
    return { courtId, name: `Court ${index + 1}`, format: "doubles" };
  });
}
