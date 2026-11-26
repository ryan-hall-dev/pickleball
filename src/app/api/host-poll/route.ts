import { NextResponse } from "next/server";
import { listPendingCheckins } from "@/server/checkin/hostCheckinActions";
import { readLiveSession } from "@/server/live/liveActions";
import { readHostRoster } from "@/server/roster/hostRosterActions";

// The host screens' background refreshes. They are a route, not server
// actions, because a browser runs server actions one at a time: a refresh in
// flight made the host's tap wait behind it. Each read authorises the host
// itself, exactly as before.

const READS = {
  live: readLiveSession,
  checkins: listPendingCheckins,
  roster: readHostRoster,
};

export async function POST(request: Request) {
  // Same-origin only (the cookies are sent by the browser).
  const origin = request.headers.get("origin");
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || new URL(origin).host !== host)
    return NextResponse.json({ ok: false }, { status: 403 });
  const body = (await request.json().catch(() => null)) as {
    kind?: unknown;
    input?: unknown;
  } | null;
  const kind = body?.kind;
  if (kind !== "live" && kind !== "checkins" && kind !== "roster")
    return NextResponse.json({ ok: false }, { status: 400 });
  const result =
    kind === "live"
      ? await READS.live((body?.input ?? {}) as { prepareCourtId?: string })
      : await READS[kind]();
  return NextResponse.json(result, {
    headers: { "cache-control": "no-store" },
  });
}
