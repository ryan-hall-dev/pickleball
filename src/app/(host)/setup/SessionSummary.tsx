"use client";

import { useState, type ReactNode } from "react";
import { estimateGames, type CourtFormat } from "@/engine";
import { formatSessionWhen } from "@/lib/sessionTime";
import { CheckIcon } from "./CheckIcon";
import type { ChecklistItem, SetupReadiness } from "./setupReadiness";
import {
  courtCapacity,
  describeGamesEstimate,
  type GamesEstimateCopy,
} from "./setupPlanning";
import { SetupSection } from "./SetupSection";

// Drawing caps for the capacity diagram (not data limits): beyond these the
// diagram says "+N" instead of drawing every court or player.
const MAX_DRAWN_COURTS = 12;
const MAX_DRAWN_WAITING_PLAYERS = 40;

/** Planned length and match timing, or null while any of them is invalid. */
export interface SummaryTiming {
  durationMinutes: number;
  targetMatchMinutes: number;
  changeoverMinutes: number;
}

/** Card 5 (aside): summary rows, capacity diagram, games estimate and START. */
export function SessionSummary({
  sessionName,
  plannedStart,
  plannedEnd,
  timing,
  courtCount,
  matchFormat,
  attendingPlayerCount,
  attendingGuestCount,
  rotationSummary,
  readiness,
}: {
  sessionName: string;
  plannedStart: Date | null;
  plannedEnd: Date | null;
  timing: SummaryTiming | null;
  courtCount: number;
  matchFormat: CourtFormat;
  attendingPlayerCount: number;
  attendingGuestCount: number;
  /** e.g. "Equal games first". */
  rotationSummary: string;
  readiness: SetupReadiness;
}) {
  const [isStartNoteShown, setIsStartNoteShown] = useState(false);
  const capacity = courtCapacity(courtCount, matchFormat, attendingPlayerCount);
  const attendingMemberCount = attendingPlayerCount - attendingGuestCount;
  const estimateCopy: GamesEstimateCopy = timing
    ? describeGamesEstimate(
        estimateGames({
          ...timing,
          courtFormats: Array.from({ length: courtCount }, () => matchFormat),
          playerCount: attendingPlayerCount,
        }),
        { ...timing, attendingPlayerCount },
      )
    : {
        tone: "attention",
        lead: "Fix the session times to see how many games fit.",
        emphasis: null,
      };

  return (
    <aside
      aria-label="Session summary and start"
      className="flex min-w-0 flex-[1_1_360px] flex-col gap-[18px]"
    >
      <SetupSection
        stepNumber={5}
        headingId="session-summary-heading"
        heading="Session summary"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-[15px]">
          <SummaryRow term="Session">
            {sessionName.trim() || <Muted>Not named yet</Muted>}
          </SummaryRow>
          <SummaryRow term="When">
            {plannedStart && plannedEnd && plannedEnd > plannedStart ? (
              <span className="tabular-nums">
                {formatSessionWhen(plannedStart, plannedEnd)}
              </span>
            ) : (
              <Muted>Check the times</Muted>
            )}
          </SummaryRow>
          <SummaryRow term="Duration">
            {timing ? (
              <span className="tabular-nums">{timing.durationMinutes} min</span>
            ) : (
              <Muted>Check the times</Muted>
            )}
          </SummaryRow>
          <SummaryRow term="Players">
            <span className="tabular-nums">
              {attendingPlayerCount}
              {attendingPlayerCount > 0 && (
                <span className="font-medium text-muted">
                  {" "}
                  ({attendingMemberCount}{" "}
                  {attendingMemberCount === 1 ? "member" : "members"} +{" "}
                  {attendingGuestCount}{" "}
                  {attendingGuestCount === 1 ? "guest" : "guests"})
                </span>
              )}
            </span>
          </SummaryRow>
          <SummaryRow term="Courts">
            {courtCount === 0 ? (
              <Muted>None chosen</Muted>
            ) : (
              <span className="tabular-nums">
                {courtCount} · {matchFormat}
              </span>
            )}
          </SummaryRow>
          <SummaryRow
            term="On court at once"
            valueClassName="font-bold text-lime"
          >
            <span className="tabular-nums">{capacity.onCourtAtStart}</span>
          </SummaryRow>
          <SummaryRow term="Waiting at start" valueClassName="font-bold">
            <span className="tabular-nums">{capacity.waitingAtStart}</span>
          </SummaryRow>
          <SummaryRow term="Rotation">{rotationSummary}</SummaryRow>
        </dl>

        <CapacityDiagram
          courtCount={courtCount}
          playersPerCourt={capacity.playersPerCourt}
          onCourtAtStart={capacity.onCourtAtStart}
          waitingAtStart={capacity.waitingAtStart}
        />

        <GamesEstimateBox copy={estimateCopy} />

        <SetupChecklist items={readiness.checklist} />
      </SetupSection>

      <section
        aria-label="Start session"
        className="flex flex-col gap-2.5 rounded-card border border-card-border bg-card p-[18px]"
      >
        {/* Enabled by the same readiness as the stepper and checklist; the confirm step is M6. */}
        <button
          type="button"
          disabled={!readiness.isReadyToStart}
          onClick={() => setIsStartNoteShown(true)}
          aria-describedby="start-session-note"
          className="flex h-16 w-full items-center justify-center gap-2 rounded-[18px] bg-lime px-2 text-[19px] font-extrabold tracking-[0.03em] text-on-lime uppercase disabled:cursor-not-allowed disabled:border disabled:border-inner-border disabled:bg-transparent disabled:text-placeholder"
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M7 4.5v15l13-7.5z" />
          </svg>
          Start pickleball session
        </button>
        <p
          id="start-session-note"
          className="text-center text-[13px] text-muted"
        >
          {readiness.isReadyToStart
            ? "You'll confirm on the next step. First matches are generated and courts assigned automatically."
            : readiness.isSetupComplete
              ? "Waiting for your changes to save."
              : "Finish the checklist to start."}
        </p>
        {/* Until M6 builds the confirm step, say so rather than do nothing. */}
        {isStartNoteShown && readiness.isReadyToStart && (
          <p role="status" className="text-center text-sm text-lime-soft">
            Starting a session arrives in the next update. Your setup is saved.
          </p>
        )}
      </section>
    </aside>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="font-medium text-muted">{children}</span>;
}

function SummaryRow({
  term,
  valueClassName = "font-semibold",
  children,
}: {
  term: string;
  valueClassName?: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted">{term}</dt>
      <dd className={`min-w-0 text-right break-words ${valueClassName}`}>
        {children}
      </dd>
    </>
  );
}

function CapacityDiagram({
  courtCount,
  playersPerCourt,
  onCourtAtStart,
  waitingAtStart,
}: {
  courtCount: number;
  playersPerCourt: number;
  onCourtAtStart: number;
  waitingAtStart: number;
}) {
  if (courtCount === 0) return null;
  const drawnCourtCount = Math.min(courtCount, MAX_DRAWN_COURTS);
  const drawnWaitingCount = Math.min(waitingAtStart, MAX_DRAWN_WAITING_PLAYERS);
  // The next group up: one court's worth of the waiting players.
  const nextUpCount = Math.min(playersPerCourt, waitingAtStart);
  const label = `Capacity: ${courtCount} ${courtCount === 1 ? "court" : "courts"} of ${playersPerCourt} players, ${onCourtAtStart} on court, ${waitingAtStart} waiting`;

  return (
    <div
      role="img"
      aria-label={label}
      className="mt-[18px] rounded-[18px] bg-inner p-3.5"
    >
      <div className="grid grid-cols-4 gap-2">
        {Array.from({ length: drawnCourtCount }, (_, courtIndex) => (
          <div
            key={courtIndex}
            className="flex flex-col items-center gap-1.5 rounded-[10px] border-2 border-lime-edge px-1 pt-2 pb-1.5"
          >
            <div className="grid grid-cols-[repeat(2,14px)] gap-1">
              {Array.from({ length: playersPerCourt }, (_, seatIndex) => {
                const isFilled =
                  courtIndex * playersPerCourt + seatIndex < onCourtAtStart;
                return (
                  <span
                    key={seatIndex}
                    className={`size-3.5 rounded-full ${
                      isFilled ? "bg-lime" : "border-2 border-lime-edge"
                    }`}
                  />
                );
              })}
            </div>
            <span className="text-[11px] font-semibold text-lime-caption">
              C{courtIndex + 1}
            </span>
          </div>
        ))}
      </div>
      {courtCount > drawnCourtCount && (
        <p className="mt-2 text-xs text-muted tabular-nums">
          +{courtCount - drawnCourtCount} more courts
        </p>
      )}
      {waitingAtStart > 0 && (
        // As in the design: the waiting queue in grey, with the next group up
        // in blue at the right-hand end.
        <div className="mt-3 flex flex-wrap items-center gap-1">
          {Array.from(
            { length: Math.max(drawnWaitingCount - nextUpCount, 0) },
            (_, waitingIndex) => (
              <span
                key={`waiting-${waitingIndex}`}
                className="size-3.5 rounded-full bg-drag-handle"
              />
            ),
          )}
          {waitingAtStart > drawnWaitingCount && (
            <span className="mx-1 text-xs font-semibold text-muted tabular-nums">
              +{waitingAtStart - drawnWaitingCount}
            </span>
          )}
          {Array.from({ length: nextUpCount }, (_, nextIndex) => (
            <span
              key={`next-${nextIndex}`}
              className="size-3.5 rounded-full bg-blue"
            />
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap justify-between gap-x-3 text-xs text-muted tabular-nums">
        <span>{onCourtAtStart} playing</span>
        <span>
          {waitingAtStart} waiting
          {nextUpCount > 0 && ` · next ${nextUpCount} in blue`}
        </span>
      </div>
    </div>
  );
}

function GamesEstimateBox({ copy }: { copy: GamesEstimateCopy }) {
  if (copy.tone === "info") {
    return (
      <p
        aria-live="polite"
        className="mt-3.5 rounded-2xl border border-lime-edge bg-lime-surface px-3.5 py-3 text-sm text-lime-soft"
      >
        {copy.lead}
        {copy.emphasis && (
          <>
            <b>{copy.emphasis}</b>.
          </>
        )}
      </p>
    );
  }
  return (
    <p
      aria-live="polite"
      className="mt-3.5 flex items-start gap-2 rounded-[14px] border border-orange-edge bg-orange-surface px-3.5 py-2.5 text-sm text-orange-text"
    >
      <span
        aria-hidden="true"
        className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-orange text-xs font-extrabold text-on-orange"
      >
        !
      </span>
      <span>{copy.lead}</span>
    </p>
  );
}

/** Summary checklist: a check or "!" plus words for every line. */
function SetupChecklist({ items }: { items: ChecklistItem[] }) {
  return (
    <ul
      aria-label="Setup checklist"
      className="mt-4 flex flex-col gap-2 text-sm"
    >
      {items.map((item) => (
        <li
          key={item.text}
          className={`flex items-center gap-2.5 ${item.isDone ? "" : "text-orange-text"}`}
        >
          {item.isDone ? (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-lime text-on-lime">
              <CheckIcon sizePx={11} />
            </span>
          ) : (
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-orange text-xs font-extrabold text-on-orange"
            >
              !
            </span>
          )}
          <span>
            <span className="sr-only">
              {item.isDone ? "Done: " : "To do: "}
            </span>
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
