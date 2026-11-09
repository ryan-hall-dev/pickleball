// Verification script (read-only): checks that every session the M4.5 A3
// backfill closed through its log (supabase/migrations/20261110150000_socials_sessions.sql)
// still replays. It finds every session with an event by the migration actor,
// replays the whole log with the engine, and compares the engine's match
// records with the session's `matches` rows (teams, start, end, duration,
// status). Prints a summary; exits non-zero on any mismatch.
// Run it before and after applying A3 to a hosted project
// (docs/plans/socials.md §8). Usage: `pnpm verify-migrated-logs [--production]`.
import { registerHooks } from "node:module";
import { parseArgs } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/database.types";

type DatabaseClient = SupabaseClient<Database>;

/** The documented actor id of every event the A3 backfill appended. */
const MIGRATION_ACTOR_USER_ID = "00000000-0000-0000-0000-000000000000";
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
// PostgREST returns at most `max_rows` (supabase/config.toml) rows per request.
const PAGE_SIZE = 1000;
const USAGE = `Usage:
  pnpm verify-migrated-logs [--production]
      Replays every session the A3 backfill closed and compares its matches rows.

Options:
  --production  Allow a non-local NEXT_PUBLIC_SUPABASE_URL (a hosted project:
                only with Ryan's OK). The script only reads. Refused otherwise.
  --help        Show this help.

Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (.env.local is loaded
automatically).`;

function fail(message: string): never {
  console.error(`verify-migrated-logs: ${message}`);
  process.exit(1);
}

function readOptions() {
  const { values } = parseArgs({
    options: {
      production: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  return { allowProduction: values.production };
}

function connect(allowProduction: boolean): DatabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !secretKey) {
    fail(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (local values: `pnpm exec supabase status`, copied into .env.local).",
    );
  }
  let hostname: string;
  try {
    hostname = new URL(supabaseUrl).hostname;
  } catch {
    fail(`NEXT_PUBLIC_SUPABASE_URL is not a URL: "${supabaseUrl}".`);
  }
  if (!LOCAL_HOSTNAMES.has(hostname) && !allowProduction) {
    fail(
      `refusing a non-local database (${hostname}). Re-run with --production if you really mean that project.`,
    );
  }
  return createClient<Database>(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The engine uses extensionless relative imports (resolved by Next and
 * Vitest). Plain Node needs the file: try `<specifier>.ts`, then
 * `<specifier>/index.ts`, and load them as TypeScript ES modules.
 */
function resolveExtensionlessTypeScriptImports() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (!specifier.startsWith(".")) throw error;
        for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
          try {
            return nextResolve(candidate, context);
          } catch {
            // Try the next candidate.
          }
        }
        throw error;
      }
    },
    // The app's package.json has no "type": tell Node these are ES modules.
    load(url, context, nextLoad) {
      return url.endsWith(".ts")
        ? nextLoad(url, { ...context, format: "module-typescript" })
        : nextLoad(url, context);
    },
  });
}

/** Reads every row of a paged query, in order. */
async function readAllRows<TRow>(
  readPage: (
    fromRow: number,
    toRow: number,
  ) => PromiseLike<{ data: TRow[] | null; error: { message: string } | null }>,
  label: string,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (let fromRow = 0; ; fromRow += PAGE_SIZE) {
    const { data, error } = await readPage(fromRow, fromRow + PAGE_SIZE - 1);
    if (error) fail(`${label} failed: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE_SIZE) return rows;
  }
}

function toIso(timestamp: string | number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

async function main() {
  const { allowProduction } = readOptions();
  const client = connect(allowProduction);
  resolveExtensionlessTypeScriptImports();
  const { matchRecords, replay } = await import("../src/engine/session");
  type SessionEvent = Parameters<typeof replay>[0][number];

  const migrationEvents = await readAllRows(
    (fromRow, toRow) =>
      client
        .from("session_events")
        .select("session_id")
        .eq("actor_user_id", MIGRATION_ACTOR_USER_ID)
        .order("session_id")
        .order("seq")
        .range(fromRow, toRow),
    "Finding the migration's events",
  );
  const sessionIds = [
    ...new Set(migrationEvents.map((event) => event.session_id)),
  ];

  const mismatches: string[] = [];
  let comparedMatchRowCount = 0;
  for (const sessionId of sessionIds) {
    const { data: session, error: sessionError } = await client
      .from("sessions")
      .select("status, last_seq")
      .eq("id", sessionId)
      .single();
    if (sessionError)
      fail(`Reading session ${sessionId} failed: ${sessionError.message}`);
    const eventRows = await readAllRows(
      (fromRow, toRow) =>
        client
          .from("session_events")
          .select("seq, event_id, type, payload, occurred_at, actor_user_id")
          .eq("session_id", sessionId)
          .order("seq")
          .range(fromRow, toRow),
      `Reading the log of session ${sessionId}`,
    );
    const matchRows = await readAllRows(
      (fromRow, toRow) =>
        client
          .from("matches")
          .select(
            "id, court_name, team_a, team_b, started_at, ended_at, duration_seconds, status",
          )
          .eq("session_id", sessionId)
          .order("id")
          .range(fromRow, toRow),
      `Reading the matches of session ${sessionId}`,
    );

    // The same mapping as src/server/sessionLog.ts.
    const events = eventRows.map((row) => ({
      seq: row.seq,
      eventId: row.event_id,
      at: Date.parse(row.occurred_at),
      actorId: row.actor_user_id,
      type: row.type,
      payload: row.payload,
    })) as unknown as SessionEvent[];
    const lastEvent = events.at(-1);
    if (session.status !== "ended" || lastEvent?.type !== "SessionEnded") {
      mismatches.push(
        `${sessionId}: expected an ended session whose log ends with SessionEnded, got ${session.status} ending with ${lastEvent?.type ?? "nothing"}`,
      );
      continue;
    }
    if (session.last_seq !== lastEvent.seq) {
      mismatches.push(
        `${sessionId}: last_seq ${session.last_seq} but the log ends at seq ${lastEvent.seq}`,
      );
    }
    const replayed = replay(events);
    if (!replayed.ok) {
      mismatches.push(
        `${sessionId}: the log fails to replay at seq ${replayed.failedSeq}: ${replayed.error.code} ${replayed.error.message}`,
      );
      continue;
    }

    // As submitSessionAction writes them: one row per match with a row status.
    const expectedRows = new Map(
      matchRecords(replayed.state, lastEvent.at)
        .filter((record) => record.matchesRowStatus !== null)
        .map((record) => [
          record.matchId,
          {
            court_name: record.courtName,
            team_a: record.teamA,
            team_b: record.teamB,
            started_at: toIso(record.startedAt),
            ended_at: toIso(record.endedAt),
            duration_seconds: Math.round(record.activeDurationMs / 1000),
            status: record.matchesRowStatus,
          },
        ]),
    );
    for (const row of matchRows) {
      const expected = expectedRows.get(row.id);
      expectedRows.delete(row.id);
      const actual = {
        court_name: row.court_name,
        team_a: row.team_a,
        team_b: row.team_b,
        started_at: toIso(row.started_at),
        ended_at: toIso(row.ended_at),
        duration_seconds: row.duration_seconds,
        status: row.status,
      };
      comparedMatchRowCount += 1;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `${sessionId}: match ${row.id} is ${JSON.stringify(actual)} but the log gives ${JSON.stringify(expected ?? null)}`,
        );
      }
    }
    for (const matchId of expectedRows.keys()) {
      mismatches.push(
        `${sessionId}: the log has a row for match ${matchId} but the database has none`,
      );
    }
  }

  console.log(
    `Checked ${sessionIds.length} session(s) closed by the migration and ${comparedMatchRowCount} match row(s).`,
  );
  if (mismatches.length > 0) {
    console.error(`${mismatches.length} mismatch(es):`);
    for (const mismatch of mismatches) console.error(`  ${mismatch}`);
    process.exit(1);
  }
  console.log("Every log replays and every match row matches the engine.");
}

await main();
