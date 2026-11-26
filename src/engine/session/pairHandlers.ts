// simple-social-v2 friend pairs (docs/plans/reclub-to-court-v1.md, D4): two
// Ready players agree to be on the same team for their next game. The pair
// waits as one, ranked by the shorter of the two waits (the scheduler), and
// each keeps their own wait underneath. It is used up when either starts a
// game, and ends by itself when either takes a break or leaves.
import type { EventHandler, StateDraft } from "./draft";
import { sessionError, type SessionError } from "./errors";
import { isSessionError, requireAvailableParticipant } from "./playerHandlers";
import { isSimpleSocialV2, reservedCourtId } from "./simplePolicy";
import type { FriendPair, SessionState } from "./state";
import type { ParticipantId } from "./types";

/** The pair (requested or accepted) a player is in, if any. */
export function friendPairOf(
  state: SessionState,
  participantId: ParticipantId,
): FriendPair | null {
  return (
    Object.values(state.friendPairs ?? {}).find(
      (pair) =>
        pair.participantId === participantId || pair.friendId === participantId,
    ) ?? null
  );
}

/** Accepted pairs: the players the scheduler keeps together. */
export function acceptedFriendPairs(state: SessionState): FriendPair[] {
  return Object.values(state.friendPairs ?? {}).filter(
    (pair) => pair.status === "accepted",
  );
}

function setPairs(draft: StateDraft, pairs: Record<number, FriendPair>) {
  draft.next.friendPairs = pairs;
}

/** Removes and returns every pair that involves any of `participantIds`. */
export function takePairsOf(
  draft: StateDraft,
  participantIds: readonly ParticipantId[],
): FriendPair[] {
  const pairs = draft.next.friendPairs ?? {};
  const taken = Object.values(pairs).filter(
    (pair) =>
      participantIds.includes(pair.participantId) ||
      participantIds.includes(pair.friendId),
  );
  if (taken.length === 0) return [];
  const remaining = { ...pairs };
  for (const pair of taken) delete remaining[pair.requestSeq];
  setPairs(draft, remaining);
  return taken;
}

/** Puts back pairs a start used up (its undo), unless someone paired again since. */
export function restorePairs(draft: StateDraft, pairs: readonly FriendPair[]) {
  if (pairs.length === 0) return;
  const restored = { ...(draft.next.friendPairs ?? {}) };
  for (const pair of pairs) {
    if (
      friendPairOf(draft.next, pair.participantId) ||
      friendPairOf(draft.next, pair.friendId)
    )
      continue;
    restored[pair.requestSeq] = pair;
  }
  setPairs(draft, restored);
}

function requireReadyForPair(
  draft: StateDraft,
  participantId: ParticipantId,
  now: number,
  ignoredPairSeq?: number,
): SessionError | null {
  const available = requireAvailableParticipant(draft, participantId, now);
  if (isSessionError(available)) return available;
  if (reservedCourtId(draft.next, participantId, now) !== null)
    return sessionError(
      "PLAYER_RESERVED",
      `${draft.participantLabel(participantId)} is already Up next.`,
    );
  const pair = friendPairOf(draft.next, participantId);
  if (pair && pair.requestSeq !== ignoredPairSeq)
    return sessionError(
      "ALREADY_PAIRED",
      `${draft.participantLabel(participantId)} is already in a friend pair.`,
    );
  return null;
}

function requireV2(draft: StateDraft): SessionError | null {
  return isSimpleSocialV2(draft.next.config)
    ? null
    : sessionError(
        "POLICY_ACTION_NOT_ALLOWED",
        "Friend pairs need the newer simple-social policy.",
      );
}

export const handleFriendPairRequested: EventHandler<"FriendPairRequested"> = (
  draft,
  event,
) => {
  const policyError = requireV2(draft);
  if (policyError) return policyError;
  const { participantId, friendId } = event.payload;
  if (participantId === friendId)
    return sessionError("INVALID_PAIR", "Ask someone else to team up.");
  for (const id of [participantId, friendId]) {
    const error = requireReadyForPair(draft, id, event.at);
    if (error) return error;
  }
  setPairs(draft, {
    ...(draft.next.friendPairs ?? {}),
    [event.seq]: {
      requestSeq: event.seq,
      participantId,
      friendId,
      status: "requested",
    },
  });
  return null;
};

function requirePair(draft: StateDraft, requestSeq: number) {
  return (
    draft.next.friendPairs?.[requestSeq] ??
    sessionError("UNKNOWN_PAIR", "That friend request has ended.")
  );
}

export const handleFriendPairAccepted: EventHandler<"FriendPairAccepted"> = (
  draft,
  event,
) => {
  const policyError = requireV2(draft);
  if (policyError) return policyError;
  const pair = requirePair(draft, event.payload.requestSeq);
  if ("code" in pair) return pair;
  if (pair.status !== "requested")
    return sessionError("UNKNOWN_PAIR", "That pair has already teamed up.");
  for (const id of [pair.participantId, pair.friendId]) {
    const error = requireReadyForPair(draft, id, event.at, pair.requestSeq);
    if (error) return error;
  }
  setPairs(draft, {
    ...draft.next.friendPairs,
    [pair.requestSeq]: { ...pair, status: "accepted" },
  });
  return null;
};

export const handleFriendPairEnded: EventHandler<"FriendPairEnded"> = (
  draft,
  event,
) => {
  const policyError = requireV2(draft);
  if (policyError) return policyError;
  const pair = requirePair(draft, event.payload.requestSeq);
  if ("code" in pair) return pair;
  const remaining = { ...draft.next.friendPairs };
  delete remaining[pair.requestSeq];
  setPairs(draft, remaining);
  return null;
};
