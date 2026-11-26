import type { ListPendingCheckinsResult } from "@/server/checkin/hostCheckinResults";
import type { ReadLiveResult } from "@/server/live/liveTypes";
import type { ReadHostRosterResult } from "@/server/roster/hostRosterActions";

// Background refreshes for the host screens (see /api/host-poll): plain
// requests that never queue ahead of a tap. A failed request throws, which
// the callers already treat as "couldn't refresh".

async function hostPoll<Result>(
  kind: "live" | "checkins" | "roster",
  input?: unknown,
): Promise<Result> {
  const response = await fetch("/api/host-poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, input }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Refresh failed: ${response.status}`);
  return (await response.json()) as Result;
}

export const pollLiveSession = (input: {
  sessionId?: string;
  prepareCourtId?: string;
}) => hostPoll<ReadLiveResult>("live", input);
export const pollPendingCheckins = () =>
  hostPoll<ListPendingCheckinsResult>("checkins");
export const pollHostRoster = () => hostPoll<ReadHostRosterResult>("roster");
