"use client";

import { useState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  ICON_BUTTON_CLASS_NAME,
  SELECTED_OPTION_BUTTON_CLASS_NAME,
  UNSELECTED_OPTION_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { PLAYERS_PER_TEAM, type CourtFormat } from "@/engine";
import type { ClubCourt } from "@/server/setup/setupDraft";
import { COURT_FORMATS } from "@/server/setup/setupRules";
import { AddCourtForm } from "./AddCourtForm";
import { CheckIcon } from "./CheckIcon";
import { courtCapacity, type SetupForm } from "./setupPlanning";
import { SetupSection } from "./SetupSection";

const COURT_FORMAT_OPTION_LABELS: Record<CourtFormat, string> = {
  doubles: "Doubles · 2 v 2",
  singles: "Singles · 1 v 1",
};

function courtCountLabel(courtCount: number): string {
  return `${courtCount} ${courtCount === 1 ? "court" : "courts"}`;
}

/** Card 2: which club courts this session uses, the match format and the capacity line. */
export function CourtsCard({
  clubCourts,
  selectedCourtIds,
  matchFormat,
  attendingPlayerCount,
  courtsError,
  onChange,
  onCourtAdded,
}: {
  clubCourts: ClubCourt[];
  selectedCourtIds: string[];
  matchFormat: CourtFormat;
  attendingPlayerCount: number;
  courtsError: string | undefined;
  onChange: (patch: Partial<SetupForm>) => void;
  onCourtAdded: (court: ClubCourt) => void;
}) {
  const [isAddingCourt, setIsAddingCourt] = useState(false);
  const selectedCourtIdSet = new Set(selectedCourtIds);
  const selectedCourts = clubCourts.filter((court) =>
    selectedCourtIdSet.has(court.id),
  );
  const nextCourtToAdd = clubCourts.find(
    (court) =>
      !selectedCourtIdSet.has(court.id) &&
      court.supportedFormats.includes(matchFormat),
  );
  const capacity = courtCapacity(
    selectedCourts.length,
    matchFormat,
    attendingPlayerCount,
  );

  /** Keeps the selection in the club's court order. */
  function selectCourts(courtIds: ReadonlySet<string>) {
    onChange({
      selectedCourtIds: clubCourts
        .filter((court) => courtIds.has(court.id))
        .map((court) => court.id),
    });
  }

  function toggleCourt(courtId: string) {
    const nextCourtIds = new Set(selectedCourtIdSet);
    if (!nextCourtIds.delete(courtId)) nextCourtIds.add(courtId);
    selectCourts(nextCourtIds);
  }

  return (
    <SetupSection
      stepNumber={2}
      headingId="courts-heading"
      heading="Courts"
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Remove a court"
            disabled={selectedCourts.length === 0}
            onClick={() => toggleCourt(selectedCourts.at(-1)!.id)}
            className={ICON_BUTTON_CLASS_NAME}
          >
            −
          </button>
          <span
            aria-live="polite"
            className="min-w-24 text-center text-lg font-bold tabular-nums"
          >
            {courtCountLabel(selectedCourts.length)}
          </span>
          <button
            type="button"
            aria-label="Add a court"
            disabled={!nextCourtToAdd}
            onClick={() => toggleCourt(nextCourtToAdd!.id)}
            className={ICON_BUTTON_CLASS_NAME}
          >
            +
          </button>
        </div>
      }
    >
      <ul
        aria-labelledby="courts-heading"
        aria-describedby={courtsError ? "courts-error" : undefined}
        className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3"
      >
        {clubCourts.map((court) => (
          <li key={court.id}>
            <CourtTile
              court={court}
              isSelected={selectedCourtIdSet.has(court.id)}
              matchFormat={matchFormat}
              onToggle={() => toggleCourt(court.id)}
            />
          </li>
        ))}
        {!isAddingCourt && (
          <li>
            <button
              type="button"
              onClick={() => setIsAddingCourt(true)}
              className="flex h-[118px] w-full flex-col items-center justify-center gap-1.5 rounded-[18px] border-2 border-dashed border-outline text-[15px] font-semibold text-muted hover:text-text"
            >
              <span aria-hidden="true" className="text-[26px] leading-none">
                +
              </span>
              Add court
            </button>
          </li>
        )}
      </ul>
      {clubCourts.length === 0 && !isAddingCourt && (
        <p className="mt-3 text-sm text-muted">
          The club has no courts yet. Add the first one.
        </p>
      )}
      {isAddingCourt && (
        <AddCourtForm
          suggestedName={`Court ${clubCourts.length + 1}`}
          onCancel={() => setIsAddingCourt(false)}
          onAdded={(court) => {
            setIsAddingCourt(false);
            onCourtAdded(court);
          }}
        />
      )}
      {courtsError && (
        <div className="mt-3">
          <AttentionMessage id="courts-error">{courtsError}</AttentionMessage>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <div className="flex-[1_1_200px] rounded-2xl bg-inner px-3.5 py-3">
          <span id="match-format-label" className={FIELD_LABEL_CLASS_NAME}>
            Match format
          </span>
          <div
            role="group"
            aria-labelledby="match-format-label"
            className="mt-1.5 flex flex-wrap gap-1.5"
          >
            {COURT_FORMATS.map((format) => {
              const isSelected = format === matchFormat;
              // Every chosen court must support the format.
              const isSupported = selectedCourts.every((court) =>
                court.supportedFormats.includes(format),
              );
              return (
                <button
                  key={format}
                  type="button"
                  aria-pressed={isSelected}
                  disabled={!isSelected && !isSupported}
                  title={
                    isSupported
                      ? undefined
                      : `A chosen court doesn't support ${format}`
                  }
                  onClick={() => onChange({ matchFormat: format })}
                  className={
                    isSelected
                      ? SELECTED_OPTION_BUTTON_CLASS_NAME
                      : UNSELECTED_OPTION_BUTTON_CLASS_NAME
                  }
                >
                  {COURT_FORMAT_OPTION_LABELS[format]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-[2_1_360px] flex-wrap items-center gap-x-[18px] gap-y-2 rounded-2xl bg-inner px-4 py-3">
          <p className="text-[22px] font-bold tabular-nums">
            {selectedCourts.length}{" "}
            <span className="font-medium text-muted">
              {selectedCourts.length === 1 ? "court" : "courts"} ×
            </span>{" "}
            {capacity.playersPerCourt}{" "}
            <span className="font-medium text-muted">players =</span>{" "}
            <span className="text-lime">{capacity.seatsOnCourts} on court</span>
          </p>
          <p className="text-[15px] text-muted tabular-nums">
            {attendingPlayerCount === 0 ? (
              "No players attending yet."
            ) : (
              <>
                {attendingPlayerCount}{" "}
                {attendingPlayerCount === 1 ? "player" : "players"} →{" "}
                <b className="text-text">{capacity.waitingAtStart} waiting</b>{" "}
                at the start
              </>
            )}
          </p>
        </div>
      </div>
    </SetupSection>
  );
}

function CourtTile({
  court,
  isSelected,
  matchFormat,
  onToggle,
}: {
  court: ClubCourt;
  isSelected: boolean;
  matchFormat: CourtFormat;
  onToggle: () => void;
}) {
  const supportsMatchFormat = court.supportedFormats.includes(matchFormat);
  // A court that can't host the chosen format can't be picked (it can still be removed).
  const isDisabled = !isSelected && !supportsMatchFormat;
  const playersPerTeam = PLAYERS_PER_TEAM[matchFormat];
  const caption = supportsMatchFormat
    ? `${playersPerTeam * 2} players`
    : `${court.supportedFormats.includes("singles") ? "Singles" : "Doubles"} only`;
  const dotClassName = `size-5 rounded-full ${isSelected ? "bg-lime" : "bg-outline"}`;
  const teamDots = (team: "a" | "b") =>
    Array.from({ length: playersPerTeam }, (_, index) => (
      <span key={`${team}-${index}`} className={dotClassName} />
    ));

  return (
    <button
      type="button"
      aria-pressed={isSelected}
      disabled={isDisabled}
      onClick={onToggle}
      // Disabled per DESIGN.md: transparent, inner-border edge, placeholder text.
      className={`flex h-[118px] w-full flex-col justify-between rounded-[18px] border-2 px-3.5 py-3 text-left ${
        isSelected
          ? "border-lime bg-lime-surface text-text"
          : isDisabled
            ? "cursor-not-allowed border-inner-border bg-transparent text-placeholder"
            : "border-inner-border bg-inner text-text hover:border-outline"
      }`}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="truncate text-[17px] font-bold">{court.name}</span>
        {isSelected ? (
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-lime text-on-lime">
            <CheckIcon sizePx={12} />
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="size-[22px] shrink-0 rounded-full border-2 border-outline"
          />
        )}
      </span>
      <span aria-hidden="true" className="flex items-center gap-1.5">
        {teamDots("a")}
        <span
          className={`mx-0.5 h-5 w-1 rounded-sm ${isSelected ? "bg-lime-edge" : "bg-inner-border"}`}
        />
        {teamDots("b")}
      </span>
      <span
        className={`text-[13px] ${
          isSelected
            ? "text-lime-caption"
            : isDisabled
              ? "text-placeholder"
              : "text-muted"
        }`}
      >
        {caption}
      </span>
    </button>
  );
}
