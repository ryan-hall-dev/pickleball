"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  LINK_BUTTON_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import { useMessages } from "@/i18n/LocaleProvider";
import { translateValidationMessage } from "@/i18n/messages";
import type {
  OpenCheckinPage,
  RosterSearchResult,
  SearchRosterResult,
} from "@/server/checkin/checkinResults";
import {
  rosterClaimInputSchema,
  type RosterClaimInput,
} from "@/server/checkin/checkinRules";
import { GENDERS, type Gender } from "@/server/participantRules";
import {
  rosterLabelText,
  type RosterLabel,
} from "@/server/roster/rosterLabels";
import type { SkillLevel } from "@/server/skillLevels";
import {
  CheckMarkIcon,
  ClockIcon,
  PersonIcon,
  SearchIcon,
} from "./CheckinIcons";
import { BrandLine, InfoNotice, SkillLevelOptions } from "./CheckinParts";
import { StateScreen, StateText } from "./CheckinStateScreens";
import { LiveSessionCard } from "./LiveSessionCard";
import {
  BOTTOM_ACTION_BAR_CLASS_NAME,
  FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME,
  SELECTED_LEVEL_OPTION_CLASS_NAME,
  STATE_PANEL_CLASS_NAME,
  UNSELECTED_LEVEL_OPTION_CLASS_NAME,
} from "./checkinStyles";

// The roster check-in (docs/designs/reclub-to-court/, p1-p4): a listed player
// finds their name, gives gender and level, and is in. No host approval.

/** Wait this long after the last key before searching. */
const SEARCH_DELAY_MS = 300;
const MIN_SEARCH_LENGTH = 2;

function useRosterLabel() {
  const copy = useMessages().checkin.roster;
  return (label: RosterLabel) => rosterLabelText(label, copy.guestOf);
}

/** p1: Find your name. */
export function RosterFindScreen({
  page,
  notice,
  search,
  onNameChosen,
  onNotHere,
  onSearchFailed,
}: {
  page: OpenCheckinPage;
  notice: "kept" | "gone" | null;
  search: (query: string) => Promise<SearchRosterResult>;
  onNameChosen: (result: RosterSearchResult) => void;
  onNotHere: () => void;
  onSearchFailed: (result: Extract<SearchRosterResult, { ok: false }>) => void;
}) {
  const copy = useMessages().checkin.roster;
  const labelText = useRosterLabel();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<{
    query: string;
    results: RosterSearchResult[];
  } | null>(null);
  const searchRef = useRef(search);
  const onFailedRef = useRef(onSearchFailed);
  useEffect(() => {
    searchRef.current = search;
    onFailedRef.current = onSearchFailed;
  });

  const trimmed = query.trim();
  useEffect(() => {
    if (trimmed.length < MIN_SEARCH_LENGTH) return;
    let isCurrent = true;
    const timeout = setTimeout(() => {
      void searchRef.current(trimmed).then((result) => {
        if (!isCurrent) return;
        if (result.ok) setAnswer({ query: trimmed, results: result.results });
        else onFailedRef.current(result);
      });
    }, SEARCH_DELAY_MS);
    return () => {
      isCurrent = false;
      clearTimeout(timeout);
    };
  }, [trimmed]);

  const isAnswered = answer?.query === trimmed;
  const results = isAnswered ? answer.results : [];
  const status =
    trimmed.length < MIN_SEARCH_LENGTH
      ? copy.typeMore
      : !isAnswered
        ? copy.searching
        : results.length === 0
          ? copy.noMatches
          : null;

  return (
    <>
      <BrandLine name={page.socialName} />
      <div>
        <h1 className="text-[26px] leading-[1.15] font-extrabold">
          {copy.findHeading}
        </h1>
        <p className="mt-1 text-sm text-muted">{copy.findIntro}</p>
      </div>
      {notice && (
        <AttentionMessage>
          {notice === "kept" ? copy.keptNotice : copy.goneNotice}
        </AttentionMessage>
      )}
      <LiveSessionCard page={page} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className={FIELD_LABEL_CLASS_NAME}>
          {copy.searchLabel}
        </label>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" />
          <input
            id={inputId}
            type="search"
            autoComplete="off"
            autoCapitalize="words"
            enterKeyHint="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={`${TEXT_INPUT_CLASS_NAME} pl-[42px]`}
          />
        </div>
        <p role="status" className="min-h-5 text-[13px] text-muted">
          {status}
        </p>
      </div>
      {results.length > 0 && (
        <ul
          aria-label={copy.resultsLabel}
          className="flex flex-col overflow-hidden rounded-2xl border border-card-border bg-card"
        >
          {results.map((result) => (
            <li
              key={result.rosterEntryId}
              className="border-t border-inner-border first:border-t-0"
            >
              <button
                type="button"
                onClick={() => onNameChosen(result)}
                className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-inner"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-base font-semibold break-words ${
                      result.isInUse ? "text-muted" : ""
                    }`}
                  >
                    {labelText(result.label)}
                  </span>
                  {result.hostNote && (
                    <span className="block text-[13px] text-muted">
                      {copy.hostNote(result.hostNote)}
                    </span>
                  )}
                </span>
                {result.isInUse && (
                  <span className="shrink-0 rounded-full border border-inner-border bg-inner px-2.5 py-1 text-xs font-bold text-text-soft">
                    {copy.inUse}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={BOTTOM_ACTION_BAR_CLASS_NAME}>
        <button
          type="button"
          onClick={onNotHere}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          {copy.notHere}
        </button>
      </div>
    </>
  );
}

const guestNameSchema = rosterClaimInputSchema.shape.guestName.unwrap();

/** p2: gender and level (a guest also gives their name), then I'm here. */
export function RosterDetailsScreen({
  page,
  selection,
  isBusy,
  onClaim,
  onBack,
}: {
  page: OpenCheckinPage;
  selection: RosterSearchResult;
  isBusy: boolean;
  onClaim: (input: Omit<RosterClaimInput, "sessionId">) => void;
  onBack: () => void;
}) {
  const messages = useMessages();
  const copy = messages.checkin.roster;
  const labelText = useRosterLabel();
  const isGuest = selection.label.displayName === null;
  const [gender, setGender] = useState<Gender | null>(null);
  const [skillLevel, setSkillLevel] = useState<SkillLevel | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [hasPressed, setHasPressed] = useState(false);
  const ids = {
    gender: useId(),
    level: useId(),
    firstName: useId(),
    lastName: useId(),
  };

  const guestCheck = isGuest
    ? guestNameSchema.safeParse({ firstName, lastName })
    : null;
  const guestErrors =
    guestCheck && !guestCheck.success
      ? z.flattenError(guestCheck.error).fieldErrors
      : {};
  const errors = hasPressed
    ? {
        gender: gender ? undefined : messages.validation.genderRequired,
        skillLevel: skillLevel ? undefined : messages.validation.levelRequired,
        firstName: guestErrors.firstName?.[0],
        lastName: guestErrors.lastName?.[0],
      }
    : {};
  const shown = (message: string | undefined) =>
    message && translateValidationMessage(message, messages);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setHasPressed(true);
    if (!gender || !skillLevel) return;
    if (guestCheck && !guestCheck.success) return;
    onClaim({
      rosterEntryId: selection.rosterEntryId,
      gender,
      skillLevel,
      guestName: guestCheck?.success ? guestCheck.data : null,
    });
  }

  return (
    <>
      <BrandLine name={page.socialName} />
      <div>
        <h1 className="text-[26px] leading-[1.15] font-extrabold break-words">
          {isGuest
            ? labelText(selection.label)
            : copy.detailsHeading(labelText(selection.label))}
        </h1>
        <button
          type="button"
          onClick={onBack}
          className={LINK_BUTTON_CLASS_NAME}
        >
          {copy.notYou}
        </button>
      </div>
      <form
        id="roster-claim-form"
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-4 rounded-card border border-card-border bg-card p-[18px]"
      >
        {isGuest && (
          <>
            <p className="text-sm text-text-soft">{copy.guestIntro}</p>
            {(["firstName", "lastName"] as const).map((field) => (
              <div key={field} className="flex flex-col gap-1.5">
                <label htmlFor={ids[field]} className={FIELD_LABEL_CLASS_NAME}>
                  {messages.checkin[field]}
                </label>
                <input
                  id={ids[field]}
                  type="text"
                  autoCapitalize="words"
                  autoComplete={
                    field === "firstName" ? "given-name" : "family-name"
                  }
                  value={field === "firstName" ? firstName : lastName}
                  disabled={isBusy}
                  onChange={(event) =>
                    (field === "firstName" ? setFirstName : setLastName)(
                      event.target.value,
                    )
                  }
                  aria-invalid={errors[field] ? true : undefined}
                  aria-describedby={
                    errors[field] ? `${ids[field]}-error` : undefined
                  }
                  className={TEXT_INPUT_CLASS_NAME}
                />
                {errors[field] && (
                  <AttentionMessage id={`${ids[field]}-error`}>
                    {shown(errors[field])}
                  </AttentionMessage>
                )}
              </div>
            ))}
          </>
        )}
        <div className="flex flex-col gap-1.5">
          <span id={ids.gender} className={FIELD_LABEL_CLASS_NAME}>
            {messages.checkin.gender}
          </span>
          <div
            role="group"
            aria-labelledby={ids.gender}
            aria-describedby={errors.gender ? `${ids.gender}-error` : undefined}
            className="grid grid-cols-2 gap-2"
          >
            {GENDERS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={gender === option}
                disabled={isBusy}
                onClick={() => setGender(option)}
                className={
                  gender === option
                    ? SELECTED_LEVEL_OPTION_CLASS_NAME
                    : UNSELECTED_LEVEL_OPTION_CLASS_NAME
                }
              >
                {messages.genders[option]}
              </button>
            ))}
          </div>
          {errors.gender && (
            <AttentionMessage id={`${ids.gender}-error`}>
              {shown(errors.gender)}
            </AttentionMessage>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span id={ids.level} className={FIELD_LABEL_CLASS_NAME}>
            {messages.checkin.yourLevel}
          </span>
          <SkillLevelOptions
            selectedSkillLevel={skillLevel}
            onSkillLevelPressed={setSkillLevel}
            labelledById={ids.level}
            describedById={errors.skillLevel ? `${ids.level}-error` : undefined}
            isInvalid={Boolean(errors.skillLevel)}
            isDisabled={isBusy}
          />
          {errors.skillLevel && (
            <AttentionMessage id={`${ids.level}-error`}>
              {shown(errors.skillLevel)}
            </AttentionMessage>
          )}
        </div>
      </form>
      <div className={BOTTOM_ACTION_BAR_CLASS_NAME}>
        <button
          type="submit"
          form="roster-claim-form"
          disabled={isBusy}
          aria-busy={isBusy}
          className={`${PRIMARY_BUTTON_CLASS_NAME} gap-2.5`}
        >
          <CheckMarkIcon sizePx={20} />
          {copy.imHere}
        </button>
      </div>
    </>
  );
}

/** p3: the name is in use; "That's my name" asks the host. */
export function RosterInUseScreen({
  page,
  selection,
  isBusy,
  onThatsMyName,
  onChooseAnother,
}: {
  page: OpenCheckinPage;
  selection: RosterSearchResult;
  isBusy: boolean;
  onThatsMyName: () => void;
  onChooseAnother: () => void;
}) {
  const copy = useMessages().checkin.roster;
  const labelText = useRosterLabel();
  return (
    <StateScreen
      brandName={page.socialName}
      iconTone="orange"
      icon={<PersonIcon />}
      title={copy.inUseHeading}
      action={
        <>
          <button
            type="button"
            onClick={onThatsMyName}
            disabled={isBusy}
            aria-busy={isBusy}
            className={`${SECONDARY_BUTTON_CLASS_NAME} h-14 w-full text-[17px]`}
          >
            {copy.thatsMyName}
          </button>
          <p className="text-center text-[13px] text-muted">
            {copy.hostAskedNote}
          </p>
          <button
            type="button"
            onClick={onChooseAnother}
            disabled={isBusy}
            className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
          >
            {copy.chooseAnother}
          </button>
        </>
      }
    >
      <StateText>{copy.inUseText(labelText(selection.label))}</StateText>
    </StateScreen>
  );
}

/** p4 for "That's my name": waits for the host (the page polls). */
export function RosterTransferWaitingScreen({
  page,
  onChooseAnother,
}: {
  page: OpenCheckinPage;
  onChooseAnother: () => void;
}) {
  const messages = useMessages();
  const copy = messages.checkin.roster;
  const labelText = useRosterLabel();
  const request = page.rosterTransferRequest;
  return (
    <StateScreen
      brandName={page.socialName}
      iconTone="blue"
      icon={<ClockIcon sizePx={34} />}
      title={copy.transferWaitingTitle}
      afterState={
        <InfoNotice role="status">
          {messages.checkin.waiting.updatesItself}
        </InfoNotice>
      }
      action={
        <button
          type="button"
          onClick={onChooseAnother}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          {copy.chooseAnother}
        </button>
      }
    >
      {request && (
        <StateText>
          {copy.transferWaitingText(labelText(request.label))}
        </StateText>
      )}
    </StateScreen>
  );
}

/** Checked in from the roster: in Ready, nothing more to do yet. */
export function RosterCheckedInScreen({ page }: { page: OpenCheckinPage }) {
  const copy = useMessages().checkin.roster;
  const claim = page.rosterClaim;
  return (
    <StateScreen
      brandName={page.socialName}
      iconTone="lime"
      icon={<CheckMarkIcon sizePx={36} />}
      role="status"
      title={copy.checkedInTitle(claim?.firstName ?? "")}
      afterState={
        <div className={STATE_PANEL_CLASS_NAME}>
          <p className="text-base">{copy.keepOpen}</p>
        </div>
      }
    >
      <StateText>{copy.checkedInText(page.session.name)}</StateText>
    </StateScreen>
  );
}

/** "My name isn't here" while the host has closed walk-ins. */
export function WalkInsClosedScreen({
  page,
  onFindYourName,
}: {
  page: OpenCheckinPage;
  onFindYourName: (() => void) | null;
}) {
  const copy = useMessages().checkin.roster;
  return (
    <StateScreen
      brandName={page.socialName}
      iconTone="orange"
      icon={<PersonIcon />}
      role="alert"
      title={copy.walkInsClosedTitle}
      action={
        onFindYourName && (
          <button
            type="button"
            onClick={onFindYourName}
            className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
          >
            {copy.findHeading}
          </button>
        )
      }
    >
      <StateText>{copy.walkInsClosedText}</StateText>
    </StateScreen>
  );
}
