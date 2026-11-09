import type { SaveSessionDraftResult } from "@/server/setup/setupActions";

// This browser tab's own writes to each draft's settings, kept outside React
// so they outlive the editor. When the editor truly unmounts (its route left
// Next's Activity cache, or a navigation remounted the page), its last save
// can still be on its way, and the next editor can render server data read
// before that save landed: revision N on screen while the database is at
// N+1, so its first edit would be refused as "changed elsewhere" although
// the other writer was this same tab. The next editor asks here first.
//
// Module state lives as long as the page's JavaScript: a full reload or
// closing the tab starts fresh, and that case is covered by the editor's
// "leave page?" prompt while edits are unsaved.

/** What this tab's writes to one draft's settings came to. */
export interface OwnDraftWritesOutcome {
  /** The newest settings revision this tab's writes produced (null: none did). */
  latestDraftRevision: number | null;
  /** A write was refused: another tab or device changed the settings first. */
  isConflict: boolean;
}

interface OwnDraftWrites {
  settled: OwnDraftWritesOutcome;
  /** Every write still on its way, chained; null when all have landed. */
  pending: Promise<OwnDraftWritesOutcome> | null;
}

const NO_WRITES: OwnDraftWritesOutcome = {
  latestDraftRevision: null,
  isConflict: false,
};

const ownDraftWritesBySessionId = new Map<string, OwnDraftWrites>();

/**
 * Records a settings write (save or apply) for `sessionId`. A rejected write
 * counts as failed here; its caller still sees the rejection.
 */
export function trackOwnDraftWrite(
  sessionId: string,
  write: Promise<SaveSessionDraftResult>,
): void {
  const ownWrites = ownDraftWritesBySessionId.get(sessionId) ?? {
    settled: NO_WRITES,
    pending: null,
  };
  ownDraftWritesBySessionId.set(sessionId, ownWrites);
  const earlierWrites = ownWrites.pending ?? Promise.resolve(ownWrites.settled);
  const writeResult = write.catch((): SaveSessionDraftResult => ({
    ok: false,
    message: "Write failed.",
  }));
  const allWrites = Promise.all([earlierWrites, writeResult]).then(
    ([earlier, result]): OwnDraftWritesOutcome => ({
      latestDraftRevision: result.ok
        ? Math.max(result.draftRevision, earlier.latestDraftRevision ?? -1)
        : earlier.latestDraftRevision,
      isConflict: earlier.isConflict || (!result.ok && !!result.isConflict),
    }),
  );
  ownWrites.pending = allWrites;
  void allWrites.then((outcome) => {
    ownWrites.settled = outcome;
    if (ownWrites.pending === allWrites) ownWrites.pending = null;
  });
}

/** This tab's writes a newly loaded draft may not include yet. */
export interface OwnDraftWritesNotYetLoaded {
  /** Resolves once every write has landed. */
  landed: Promise<OwnDraftWritesOutcome>;
  /**
   * A write was still on its way: a conflict it gets hasn't been shown yet.
   * Otherwise any conflict was already shown by the editor that got it.
   */
  wasStillLanding: boolean;
}

/**
 * Null when a draft loaded at `loadedDraftRevision` already includes every
 * settings write this tab made. Otherwise: a write still on its way, a newer
 * revision from this tab, or an earlier conflict.
 */
export function ownDraftWritesNotYetLoaded(
  sessionId: string,
  loadedDraftRevision: number,
): OwnDraftWritesNotYetLoaded | null {
  const ownWrites = ownDraftWritesBySessionId.get(sessionId);
  if (!ownWrites) return null;
  if (ownWrites.pending) {
    return { landed: ownWrites.pending, wasStillLanding: true };
  }
  const { settled } = ownWrites;
  const isLoadedDraftBehind =
    settled.latestDraftRevision !== null &&
    settled.latestDraftRevision > loadedDraftRevision;
  return settled.isConflict || isLoadedDraftBehind
    ? { landed: Promise.resolve(settled), wasStillLanding: false }
    : null;
}

/**
 * The editor re-read the draft at `freshDraftRevision` after a conflict it
 * had already shown: once that includes every write this tab made, the
 * conflict is over (the screen holds the server's values again).
 */
export function forgetShownConflict(
  sessionId: string,
  freshDraftRevision: number,
): void {
  const ownWrites = ownDraftWritesBySessionId.get(sessionId);
  if (!ownWrites || ownWrites.pending) return;
  const { latestDraftRevision } = ownWrites.settled;
  if (
    latestDraftRevision === null ||
    freshDraftRevision >= latestDraftRevision
  ) {
    ownWrites.settled = { ...ownWrites.settled, isConflict: false };
  }
}

/** Tests only: module state would otherwise carry over between tests. */
export function forgetOwnDraftWrites(): void {
  ownDraftWritesBySessionId.clear();
}
