import { z } from "zod";
import type { SessionErrorCode } from "@/engine/session/errors";
import type { Gender } from "@/server/participantRules";
import type { SkillLevel } from "@/server/skillLevels";
import { draftParticipantInputSchema } from "@/server/setup/setupRules";

export interface LivePlayer {
  participantId: string;
  name: string;
  skill: SkillLevel | null;
  gender: Gender | null;
  status: "waiting" | "playing" | "skipped" | "away";
  currentWaitMs: number | null;
  returnsAt: number | null;
  skipSeq: number | null;
  calledCourtId: string | null;
  calledCourtName: string | null;
  /** simple-social-v2: false for someone checked in with no phone (call them in person). */
  hasPhone?: boolean;
  /** simple-social-v2: why they are paused. */
  skipReason?: "break" | "noReply" | null;
  /** simple-social-v2: when the current break began. */
  skipSince?: number | null;
  /** simple-social-v2: their friend pair (requested or teamed). */
  pair?: { requestSeq: number; friendName: string; isTeamed: boolean } | null;
}
export interface LiveTeams {
  teamA: Array<string | null>;
  teamB: Array<string | null>;
}
export interface LiveCourt {
  courtId: string;
  name: string;
  activeMatch: (LiveTeams & { matchId: string; startedAt: number }) | null;
  called:
    | (LiveTeams & {
        calledEventId: string;
        /** simple-social-v2: who has said they're ready. */
        confirmedIds?: string[];
        /** simple-social-v2: when each seated player was asked. */
        askedAt?: Record<string, number>;
      })
    | null;
  /** simple-social-v2: when the last game on this court ended, or null. */
  freeSince?: number | null;
  /** simple-social-v2 */
  isClosed?: boolean;
  closesAfterGame?: boolean;
  suggestion: (LiveTeams & { reason: string }) | null;
}
export interface LiveSessionView {
  sessionId: string;
  name: string;
  phase: "live" | "ended";
  /** simple-social-v2: confirmations, Call over, court options. */
  isV2?: boolean;
  lastSeq: number;
  now: number;
  startedAt: number;
  endedAt: number | null;
  deadline: number;
  timeIsUp: boolean;
  courts: LiveCourt[];
  players: LivePlayer[];
  undoOptions: LiveUndoOption[];
  /** simple-social-v2 (h13): the latest finished games and their scores. */
  recentGames?: LiveRecentGame[];
}
export interface LiveRecentGame {
  matchId: string;
  courtName: string;
  endedAt: number;
  teamA: string[];
  teamB: string[];
  score: {
    scoreTeamA: number;
    scoreTeamB: number;
    /** A player's name, or null when a host entered it. */
    enteredByName: string | null;
  } | null;
}
export interface LiveUndoOption {
  courtId: string;
  /** Empty for a court closing. */
  matchId: string;
  targetSeq: number;
  kind: "start" | "finish" | "close" | "closeAfterGame";
}
export type ReadLiveResult =
  | { ok: true; status: "session"; session: LiveSessionView }
  | { ok: true; status: "empty" | "draft" | "legacy" }
  | { ok: false; message: string };

const teamSchema = z.array(z.uuid()).length(2);
const teamsShape = { teamA: teamSchema, teamB: teamSchema };
export const liveCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("call"), courtId: z.uuid(), ...teamsShape }),
  z.object({
    kind: z.literal("change"),
    calledEventId: z.uuid(),
    ...teamsShape,
  }),
  z.object({ kind: z.literal("release"), calledEventId: z.uuid() }),
  z.object({
    kind: z.literal("start"),
    courtId: z.uuid(),
    calledEventId: z.uuid(),
    matchId: z.uuid(),
  }),
  z.object({ kind: z.literal("finish"), matchId: z.uuid() }),
  z.object({
    kind: z.literal("replace"),
    matchId: z.uuid(),
    outId: z.uuid(),
    inId: z.uuid(),
  }),
  z.object({ kind: z.literal("interrupt"), matchId: z.uuid() }),
  z.object({ kind: z.literal("undo"), targetSeq: z.number().int().positive() }),
  z.object({ kind: z.literal("rest"), participantId: z.uuid() }),
  z.object({
    kind: z.literal("ready"),
    participantId: z.uuid(),
    targetSeq: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("leave"), participantId: z.uuid() }),
  z.object({ kind: z.literal("end") }),
  // simple-social-v2 (docs/plans/reclub-to-court-v1.md, h7-h10):
  z.object({
    kind: z.literal("confirm"),
    calledEventId: z.uuid(),
    participantId: z.uuid(),
  }),
  z.object({ kind: z.literal("pauseNoReply"), participantId: z.uuid() }),
  z.object({
    kind: z.literal("move"),
    calledEventId: z.uuid(),
    toCourtId: z.uuid(),
  }),
  z.object({ kind: z.literal("closeAfterGame"), courtId: z.uuid() }),
  z.object({ kind: z.literal("closeNow"), courtId: z.uuid() }),
  /** "Stop game and close": abandon the game (no score, no completed game), then close. */
  z.object({
    kind: z.literal("stopAndClose"),
    courtId: z.uuid(),
    matchId: z.uuid(),
  }),
  z.object({
    kind: z.literal("endPair"),
    requestSeq: z.number().int().positive(),
  }),
]);
export type LiveCommand = z.infer<typeof liveCommandSchema>;
export const liveWriteSchema = z.object({
  sessionId: z.uuid(),
  eventId: z.uuid(),
  expectedLastSeq: z.number().int().positive(),
  command: liveCommandSchema,
});
export type LiveWriteInput = z.infer<typeof liveWriteSchema>;
/**
 * Why a write did not land. `rejected`: the server or engine refused it for
 * good (show the reason; the host carries on). `conflict`: the session moved
 * on (refresh, then act again). `unknown`: no trustworthy answer (timeout,
 * lost response, server error): only this case keeps a retry of the same
 * event id, so the outcome can be settled without a second action.
 */
export type LiveWriteFailureOutcome = "rejected" | "conflict" | "unknown";
export type LiveWriteResult =
  | { ok: true; seq: number; wasDuplicate: boolean }
  | {
      ok: false;
      message: string;
      outcome: LiveWriteFailureOutcome;
      /** An engine rejection's code, so the browser can show it in the chosen language. */
      engineErrorCode?: SessionErrorCode;
    };

/**
 * A host adds a player whose phone is missing or flat. `eventId` is kept by the
 * browser for as long as one form is open, so a retry after an uncertain answer
 * settles the same write and never adds the player twice.
 */
export const liveAddPlayerSchema = draftParticipantInputSchema.extend({
  sessionId: z.uuid(),
  eventId: z.uuid(),
  expectedLastSeq: z.number().int().positive(),
});
export type LiveAddPlayerInput = z.input<typeof liveAddPlayerSchema>;
