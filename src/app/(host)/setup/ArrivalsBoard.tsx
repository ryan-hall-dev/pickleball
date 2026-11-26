"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  CARD_CLASS_NAME,
  FIELD_LABEL_CLASS_NAME,
  LINK_BUTTON_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  SELECTED_OPTION_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
  UNSELECTED_OPTION_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { STICKER_AND_QR_PAGE_PATH } from "../checkin-link/checkinLinkPaths";
import { useLocale } from "@/i18n/LocaleProvider";
import { translateMessage } from "@/i18n/messages";
import { GENDERS, type Gender } from "@/server/participantRules";
import {
  decideRosterTransfer,
  hostCheckInRosterEntry,
  importRosterPaste,
  readHostRoster,
  removeRosterEntry,
  setRosterEntryNote,
  setWalkInsOpen,
  type ReadHostRosterResult,
  type RosterWriteResult,
} from "@/server/roster/hostRosterActions";
import {
  existingRosterEntries,
  type HostRoster,
  type HostRosterEntry,
} from "@/server/roster/hostRosterResults";
import { rosterLabelText } from "@/server/roster/rosterLabels";
import {
  compareRosterPaste,
  readPastedRoster,
  type RosterComparison,
  type PastedRoster,
} from "@/server/roster/rosterText";
import { SKILL_LEVELS, type SkillLevel } from "@/server/skillLevels";

// Arrivals, a section of Session setup and Live courts (h1-h6): paste the Reclub list,
// answer "That's my name", check in people with no phone, close walk-ins.
// Listed players check themselves in; only exceptions need the host.

/** The roster refreshes this often while the page is visible. */
const POLL_INTERVAL_MS = 5_000;

const SECTION_HEADING_CLASS_NAME = "text-xl font-bold compact:text-base";
const ROW_CLASS_NAME =
  "flex flex-wrap items-center gap-2 border-t border-inner-border py-2.5 first:border-t-0";

function useText() {
  const { messages } = useLocale();
  return { messages, text: messages.host.arrivals };
}

function formatTime(iso: string, locale: string) {
  return new Date(iso).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ArrivalsBoard({
  showQrLink = false,
  onArrivedChanged,
}: {
  /** Setup shows the check-in QR code here; Live has it with Check-ins. */
  showQrLink?: boolean;
  /** Someone checked in (or was removed): the page re-reads its players. */
  onArrivedChanged?: () => void;
}) {
  const { messages, text } = useText();
  const [read, setRead] = useState<ReadHostRosterResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await readHostRoster().catch((): ReadHostRosterResult => ({
      ok: false,
      message: messages.serverMessages.offline,
    }));
    // A failed poll keeps what is already shown.
    setRead((current) => (result.ok || !current?.ok ? result : current));
  }, [messages]);

  const arrivedIds = (read?.ok ? (read.roster?.entries ?? []) : [])
    .flatMap((entry) => entry.participant?.participantId ?? [])
    .sort()
    .join();
  const onArrivedChangedRef = useRef(onArrivedChanged);
  useEffect(() => {
    onArrivedChangedRef.current = onArrivedChanged;
  });
  // The first read counts too: players may have arrived before this page.
  useEffect(() => {
    if (arrivedIds) onArrivedChangedRef.current?.();
  }, [arrivedIds]);

  useEffect(() => {
    const poll = () => {
      if (!document.hidden) void refresh();
    };
    const firstRead = setTimeout(poll, 0);
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearTimeout(firstRead);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);

  /** Runs a write, shows its refusal (translated), then re-reads the list. */
  const runWrite = useCallback(
    async (write: () => Promise<RosterWriteResult>) => {
      setMessage(null);
      const result = await write().catch((): RosterWriteResult => ({
        ok: false,
        message: messages.serverMessages.offline,
      }));
      if (!result.ok) setMessage(translateMessage(result.message, messages));
      await refresh();
      return result;
    },
    [messages, refresh],
  );

  if (!read) return null;
  if (!read.ok) {
    return (
      <AttentionMessage>
        {translateMessage(read.message, messages)}
      </AttentionMessage>
    );
  }
  const roster = read.roster;
  if (!roster) return null;

  const arrivedCount = roster.entries.filter(
    (entry) => entry.participant,
  ).length;
  return (
    <div className="flex flex-col gap-4 compact:gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-xl font-bold compact:text-base">
          {text.heading}
        </h2>
        {roster.entries.length > 0 && (
          <span className="rounded-full bg-inner-border px-3 py-1 text-[13px] font-bold text-text-soft tabular-nums">
            {text.arrivedCount(arrivedCount, roster.entries.length)}
          </span>
        )}
        {showQrLink && (
          <Link
            href={STICKER_AND_QR_PAGE_PATH}
            className={OUTLINE_BUTTON_CLASS_NAME}
          >
            {messages.host.tray.showQrCode}
          </Link>
        )}
      </div>
      {message && (
        <div role="alert">
          <AttentionMessage>{message}</AttentionMessage>
        </div>
      )}
      {roster.entries.length > 0 && (
        <>
          <NeedsYouCard roster={roster} runWrite={runWrite} />
          <NotArrivedCard roster={roster} runWrite={runWrite} />
          <ArrivedCard roster={roster} />
        </>
      )}
      <ReclubPasteCard roster={roster} runWrite={runWrite} />
    </div>
  );
}

type RunWrite = (
  write: () => Promise<RosterWriteResult>,
) => Promise<RosterWriteResult>;

function useLabel() {
  const { messages } = useText();
  return (entry: HostRosterEntry) =>
    rosterLabelText(entry.label, messages.checkin.roster.guestOf);
}

/** h5: "That's my name" requests (walk-ins stay in the Check-ins tray). */
function NeedsYouCard({
  roster,
  runWrite,
}: {
  roster: HostRoster;
  runWrite: RunWrite;
}) {
  const { text } = useText();
  const { locale } = useLocale();
  const label = useLabel();
  const [busyId, setBusyId] = useState<string | null>(null);
  const requests = roster.transferRequests;
  return (
    <section
      aria-labelledby="arrivals-needs-you"
      className={`${CARD_CLASS_NAME} flex flex-col gap-3 ${
        requests.length > 0 ? "border-orange-edge" : ""
      }`}
    >
      <h2 id="arrivals-needs-you" className={SECTION_HEADING_CLASS_NAME}>
        {text.needsYou(requests.length)}
      </h2>
      {requests.length === 0 && (
        <p className="text-sm text-muted">{text.nothingNeedsYou}</p>
      )}
      {requests.map((request) => {
        const entry = roster.entries.find(
          (candidate) => candidate.rosterEntryId === request.rosterEntryId,
        );
        if (!entry) return null;
        const askedAt = formatTime(request.createdAt, locale);
        const claimedAt = entry.claimedAt
          ? formatTime(entry.claimedAt, locale)
          : "";
        const decide = (shouldMove: boolean) => {
          setBusyId(request.transferRequestId);
          void runWrite(() =>
            decideRosterTransfer({
              transferRequestId: request.transferRequestId,
              shouldMove,
            }),
          ).finally(() => setBusyId(null));
        };
        const isBusy = busyId === request.transferRequestId;
        return (
          <div
            key={request.transferRequestId}
            className="flex flex-col gap-2 rounded-2xl border border-orange-edge bg-orange-surface p-3"
          >
            <strong className="break-words">
              {text.nameRequest(label(entry))}
            </strong>
            <span className="text-[13px] text-text-soft">
              {entry.hasPhone
                ? text.nameRequestDetail(claimedAt, askedAt)
                : text.nameRequestNoPhone(claimedAt, askedAt)}
            </span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => decide(true)}
                className={SECONDARY_BUTTON_CLASS_NAME}
              >
                {text.moveToNewPhone}
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => decide(false)}
                className={OUTLINE_BUTTON_CLASS_NAME}
              >
                {text.keepAsItIs}
              </button>
            </div>
          </div>
        );
      })}
      <p className="text-[13px] text-muted">{text.walkInsHint}</p>
    </section>
  );
}

/** h5/h6: listed people who haven't arrived; a host checks in a phoneless one. */
function NotArrivedCard({
  roster,
  runWrite,
}: {
  roster: HostRoster;
  runWrite: RunWrite;
}) {
  const { text } = useText();
  const label = useLabel();
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [isTogglingWalkIns, setIsTogglingWalkIns] = useState(false);
  const waiting = roster.entries.filter((entry) => !entry.participant);
  return (
    <section
      aria-labelledby="arrivals-not-arrived"
      className={`${CARD_CLASS_NAME} flex flex-col gap-2`}
    >
      <h2 id="arrivals-not-arrived" className={SECTION_HEADING_CLASS_NAME}>
        {text.notArrived(waiting.length)}
      </h2>
      {waiting.length === 0 && (
        <p className="text-sm text-muted">{text.everyoneArrived}</p>
      )}
      <ul className="flex flex-col">
        {waiting.map((entry) => (
          <li key={entry.rosterEntryId} className={ROW_CLASS_NAME}>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold break-words">
                {label(entry)}
              </span>
              {entry.label.twinCount > 1 && entry.label.displayName && (
                <NoteLine entry={entry} roster={roster} runWrite={runWrite} />
              )}
            </span>
            {openEntryId !== entry.rosterEntryId && (
              <button
                type="button"
                onClick={() => setOpenEntryId(entry.rosterEntryId)}
                className={OUTLINE_BUTTON_CLASS_NAME}
              >
                {text.checkIn}
              </button>
            )}
            {openEntryId === entry.rosterEntryId && (
              <HostCheckInPanel
                entry={entry}
                roster={roster}
                runWrite={runWrite}
                onClose={() => setOpenEntryId(null)}
              />
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 border-t border-inner-border pt-3">
        <span className="min-w-0 flex-1 font-semibold">
          {roster.walkInsOpen ? text.walkInsAreOpen : text.walkInsAreClosed}
        </span>
        <button
          type="button"
          disabled={isTogglingWalkIns}
          aria-busy={isTogglingWalkIns}
          onClick={() => {
            setIsTogglingWalkIns(true);
            void runWrite(() =>
              setWalkInsOpen({
                sessionId: roster.sessionId,
                walkInsOpen: !roster.walkInsOpen,
              }),
            ).finally(() => setIsTogglingWalkIns(false));
          }}
          className={OUTLINE_BUTTON_CLASS_NAME}
        >
          {roster.walkInsOpen ? text.closeWalkIns : text.openWalkIns}
        </button>
      </div>
    </section>
  );
}

/** The short note that tells two people of the same name apart. */
function NoteLine({
  entry,
  roster,
  runWrite,
}: {
  entry: HostRosterEntry;
  roster: HostRoster;
  runWrite: RunWrite;
}) {
  const { text } = useText();
  const inputId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
        {entry.hostNote ? text.note(entry.hostNote) : text.sameNameTwice}
        <button
          type="button"
          onClick={() => setDraft(entry.hostNote ?? "")}
          className={LINK_BUTTON_CLASS_NAME}
        >
          {entry.hostNote ? text.editNote : text.addNote}
        </button>
      </span>
    );
  }
  return (
    <form
      className="mt-1 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void runWrite(() =>
          setRosterEntryNote({
            sessionId: roster.sessionId,
            rosterEntryId: entry.rosterEntryId,
            hostNote: draft,
          }),
        ).then((result) => {
          if (result.ok) setDraft(null);
        });
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {text.noteLabel(entry.label.displayName ?? "")}
      </label>
      <input
        id={inputId}
        value={draft}
        maxLength={40}
        onChange={(event) => setDraft(event.target.value)}
        className={`${TEXT_INPUT_CLASS_NAME} max-w-56`}
      />
      <button type="submit" className={OUTLINE_BUTTON_CLASS_NAME}>
        {text.saveNote}
      </button>
    </form>
  );
}

/** h6: gender and level (a guest's own name too); checked in with no phone. */
function HostCheckInPanel({
  entry,
  roster,
  runWrite,
  onClose,
}: {
  entry: HostRosterEntry;
  roster: HostRoster;
  runWrite: RunWrite;
  onClose: () => void;
}) {
  const { messages, text } = useText();
  const label = useLabel();
  const isGuest = entry.label.displayName === null;
  const [gender, setGender] = useState<Gender | null>(null);
  const [skillLevel, setSkillLevel] = useState<SkillLevel | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  // One attempt keeps its ids, so a retry can't add the person twice.
  const [attemptIds] = useState(() => ({
    participantId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
  }));
  const ids = { first: useId(), last: useId() };
  const isReady =
    gender !== null &&
    skillLevel !== null &&
    (!isGuest || (firstName.trim() !== "" && lastName.trim() !== ""));

  return (
    <div className="flex w-full flex-col gap-3 rounded-2xl border border-inner-border bg-inner p-3">
      <strong>{text.checkInTitle(label(entry))}</strong>
      <span className="text-[13px] text-muted">{text.checkInIntro}</span>
      {isGuest && (
        <div className="grid gap-2 sm:grid-cols-2">
          <span className="text-[13px] text-muted sm:col-span-2">
            {text.guestNameHint}
          </span>
          <label className="flex flex-col gap-1.5" htmlFor={ids.first}>
            <span className={FIELD_LABEL_CLASS_NAME}>
              {messages.checkin.firstName}
            </span>
            <input
              id={ids.first}
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              className={TEXT_INPUT_CLASS_NAME}
            />
          </label>
          <label className="flex flex-col gap-1.5" htmlFor={ids.last}>
            <span className={FIELD_LABEL_CLASS_NAME}>
              {messages.checkin.lastName}
            </span>
            <input
              id={ids.last}
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              className={TEXT_INPUT_CLASS_NAME}
            />
          </label>
        </div>
      )}
      <div
        role="group"
        aria-label={messages.checkin.gender}
        className="grid grid-cols-2 gap-2"
      >
        {GENDERS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={gender === option}
            onClick={() => setGender(option)}
            className={
              gender === option
                ? SELECTED_OPTION_BUTTON_CLASS_NAME
                : UNSELECTED_OPTION_BUTTON_CLASS_NAME
            }
          >
            {messages.genders[option]}
          </button>
        ))}
      </div>
      <div
        role="group"
        aria-label={messages.checkin.yourLevel}
        className="grid grid-cols-3 gap-2"
      >
        {SKILL_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            aria-pressed={skillLevel === level}
            onClick={() => setSkillLevel(level)}
            className={`${
              skillLevel === level
                ? SELECTED_OPTION_BUTTON_CLASS_NAME
                : UNSELECTED_OPTION_BUTTON_CLASS_NAME
            } px-1`}
          >
            {messages.levels[level]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!isReady || isBusy}
          aria-busy={isBusy}
          onClick={() => {
            if (!gender || !skillLevel) return;
            setIsBusy(true);
            void runWrite(() =>
              hostCheckInRosterEntry({
                sessionId: roster.sessionId,
                rosterEntryId: entry.rosterEntryId,
                ...attemptIds,
                gender,
                skillLevel,
                guestName: isGuest ? { firstName, lastName } : null,
              }),
            ).then((result) => {
              setIsBusy(false);
              if (result.ok) onClose();
            });
          }}
          className={SECONDARY_BUTTON_CLASS_NAME}
        >
          {text.checkIn}
        </button>
        <button
          type="button"
          onClick={onClose}
          className={OUTLINE_BUTTON_CLASS_NAME}
        >
          {messages.host.common.cancel}
        </button>
      </div>
    </div>
  );
}

/** Who has arrived, newest first, with "No phone" for host check-ins. */
function ArrivedCard({ roster }: { roster: HostRoster }) {
  const { text } = useText();
  const { locale } = useLocale();
  const label = useLabel();
  const arrived = roster.entries
    .filter((entry) => entry.participant)
    .sort((left, right) =>
      (right.claimedAt ?? "").localeCompare(left.claimedAt ?? ""),
    );
  if (arrived.length === 0) return null;
  return (
    <details className={`${CARD_CLASS_NAME} group`}>
      <summary className="flex min-h-11 cursor-pointer items-center text-xl font-bold compact:text-base">
        {text.arrived(arrived.length)}
      </summary>
      <ul className="mt-2 flex flex-col">
        {arrived.map((entry) => {
          const participant = entry.participant!;
          const name =
            `${participant.firstName} ${participant.lastName}`.trim();
          const listed = label(entry);
          return (
            <li key={entry.rosterEntryId} className={ROW_CLASS_NAME}>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold break-words">{name}</span>
                <span className="block text-[13px] text-muted">
                  {listed !== name ? `${listed} · ` : ""}
                  {entry.claimedAt &&
                    text.checkedInAt(formatTime(entry.claimedAt, locale))}
                </span>
              </span>
              {!entry.hasPhone && (
                <span className="rounded-full border border-orange-edge bg-orange-surface px-2.5 py-1 text-xs font-bold text-orange-ink">
                  {text.noPhone}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** h1-h3: paste the Reclub list, check the names, add the new ones. */
function ReclubPasteCard({
  roster,
  runWrite,
}: {
  roster: HostRoster;
  runWrite: RunWrite;
}) {
  const { messages, text: arrivalsText } = useText();
  const text = arrivalsText.reclub;
  const textareaId = useId();
  const [pastedText, setPastedText] = useState("");
  const [preview, setPreview] = useState<{
    pasted: PastedRoster;
    comparison: RosterComparison;
    expectedEntryCount: number;
  } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  const entriesById = new Map(
    roster.entries.map((entry) => [entry.rosterEntryId, entry]),
  );
  const label = useLabel();

  function checkNames() {
    const pasted = readPastedRoster(pastedText);
    setDoneMessage(null);
    setPreview({
      pasted,
      comparison: compareRosterPaste(
        existingRosterEntries(roster),
        pasted.names,
      ),
      expectedEntryCount: roster.entries.length,
    });
  }

  const pastedNameCounts = new Map<string, number>();
  for (const addition of preview?.comparison.additions ?? []) {
    if (addition.kind === "player")
      pastedNameCounts.set(
        addition.name,
        (pastedNameCounts.get(addition.name) ?? 0) + 1,
      );
  }
  for (const entry of roster.entries) {
    const name = entry.label.displayName;
    if (name && pastedNameCounts.has(name))
      pastedNameCounts.set(name, pastedNameCounts.get(name)! + 1);
  }

  return (
    <section
      aria-labelledby="arrivals-reclub"
      className={`${CARD_CLASS_NAME} flex flex-col gap-3`}
    >
      <h2 id="arrivals-reclub" className={SECTION_HEADING_CLASS_NAME}>
        {text.heading}
      </h2>
      <p className="text-sm text-muted">
        {roster.entries.length === 0 ? text.intro : text.pasteAgainIntro}
      </p>
      {doneMessage && (
        <p role="status" className="text-sm font-semibold text-lime-ink">
          {doneMessage}
        </p>
      )}
      {!preview && (
        <>
          <label htmlFor={textareaId} className={FIELD_LABEL_CLASS_NAME}>
            {text.pasteLabel}
          </label>
          <textarea
            id={textareaId}
            value={pastedText}
            onChange={(event) => setPastedText(event.target.value)}
            rows={6}
            className={`${TEXT_INPUT_CLASS_NAME} h-auto min-h-36 py-3`}
          />
          <button
            type="button"
            disabled={pastedText.trim() === ""}
            onClick={checkNames}
            className={`${OUTLINE_BUTTON_CLASS_NAME} self-start`}
          >
            {text.checkNames}
          </button>
        </>
      )}
      {preview && (
        <>
          {preview.pasted.names.length === 0 ? (
            <AttentionMessage>{text.noNames}</AttentionMessage>
          ) : preview.comparison.additions.length === 0 ? (
            <p className="text-sm">{text.nothingNew}</p>
          ) : (
            <>
              <strong>
                {text.namesFound(preview.comparison.additions.length)}
              </strong>
              <ul className="flex flex-col">
                {preview.comparison.additions.map((addition) => (
                  <li key={addition.key} className={ROW_CLASS_NAME}>
                    <span className="min-w-0 flex-1 break-words">
                      {addition.kind === "player"
                        ? addition.name
                        : messages.checkin.roster.guestOf(addition.guestOfName)}
                      {addition.kind === "player" &&
                        (pastedNameCounts.get(addition.name) ?? 0) > 1 && (
                          <span className="block text-[13px] text-muted">
                            {arrivalsText.sameNameTwice}
                          </span>
                        )}
                    </span>
                    {addition.kind === "guest" && (
                      <span className="rounded-full bg-inner-border px-2.5 py-1 text-xs font-bold text-text-soft">
                        {text.guest}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {preview.comparison.missingEntryIds.length > 0 && (
            <div className="flex flex-col">
              <strong>{text.missingHeading}</strong>
              {preview.comparison.missingEntryIds.map((entryId) => {
                const entry = entriesById.get(entryId);
                if (!entry) return null;
                return (
                  <div key={entryId} className={ROW_CLASS_NAME}>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold break-words">
                        {label(entry)}
                      </span>
                      <span className="block text-[13px] text-muted">
                        {entry.participant
                          ? text.missingCheckedIn
                          : text.missingNotArrived}
                      </span>
                    </span>
                    {entry.participant ? (
                      <span className="rounded-full bg-inner-border px-2.5 py-1 text-xs font-bold text-text-soft">
                        {text.kept}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          void runWrite(() =>
                            removeRosterEntry({
                              sessionId: roster.sessionId,
                              rosterEntryId: entryId,
                            }),
                          ).then((result) => {
                            if (!result.ok) return;
                            setPreview(
                              (current) =>
                                current && {
                                  ...current,
                                  expectedEntryCount:
                                    current.expectedEntryCount - 1,
                                  comparison: {
                                    ...current.comparison,
                                    missingEntryIds:
                                      current.comparison.missingEntryIds.filter(
                                        (id) => id !== entryId,
                                      ),
                                  },
                                },
                            );
                          })
                        }
                        className={OUTLINE_BUTTON_CLASS_NAME}
                      >
                        {text.remove}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {preview.pasted.waitlistCount > 0 && (
            <p className="text-[13px] text-muted">
              {text.waitlistLeftOut(preview.pasted.waitlistCount)}
            </p>
          )}
          {preview.pasted.skippedLines.length > 0 && (
            <p className="text-[13px] text-muted">
              {text.skippedLines(preview.pasted.skippedLines.length)}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            {preview.comparison.additions.length > 0 && (
              <button
                type="button"
                disabled={isBusy}
                aria-busy={isBusy}
                onClick={() => {
                  setIsBusy(true);
                  void runWrite(() =>
                    importRosterPaste({
                      sessionId: roster.sessionId,
                      pastedText,
                      expectedEntryCount: preview.expectedEntryCount,
                    }),
                  ).then((result) => {
                    setIsBusy(false);
                    if (!result.ok) {
                      setPreview(null);
                      return;
                    }
                    setDoneMessage(text.added(result.added ?? 0));
                    setPreview(null);
                    setPastedText("");
                  });
                }}
                className={`${PRIMARY_BUTTON_CLASS_NAME} sm:w-auto`}
              >
                {text.add(preview.comparison.additions.length)}
              </button>
            )}
            <button
              type="button"
              onClick={() => setPreview(null)}
              className={OUTLINE_BUTTON_CLASS_NAME}
            >
              {text.cancel}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
