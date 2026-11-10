import { InitialsAvatar } from "@/components/InitialsAvatar";
import {
  LINK_BUTTON_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import type {
  NameMatch,
  OpenCheckinPage,
  RecognisedMember,
} from "@/server/checkin/checkinResults";
import {
  isSearchableQuery,
  MAX_SEARCH_MATCHES,
} from "@/server/checkin/checkinRules";
import { CheckMarkIcon, ChevronIcon, SearchIcon } from "./CheckinIcons";
import { BrandLine, InfoNotice } from "./CheckinParts";
import { BOTTOM_ACTION_BAR_CLASS_NAME } from "./checkinStyles";
import type { CheckinCandidate, SearchState } from "./checkinViewState";
import { LiveSessionCard } from "./LiveSessionCard";

const SEARCH_INPUT_ID = "checkin-name-search";
const SEARCH_STATUS_ID = "checkin-name-search-status";

/**
 * P01 (recognised phone) and P02 (new phone), with the name search (P03).
 * Privacy (plan decision 2026-11-09): no names before 2 letters, at most 5,
 * names only, never anyone's check-in status.
 */
export function WelcomeScreen({
  page,
  search,
  onSearchQueryChange,
  onCandidatePicked,
  onGuestFormOpened,
}: {
  page: OpenCheckinPage;
  search: SearchState;
  onSearchQueryChange: (query: string) => void;
  onCandidatePicked: (candidate: CheckinCandidate) => void;
  onGuestFormOpened: () => void;
}) {
  const { recognisedMember } = page;
  return (
    <>
      <BrandLine name={page.socialName} />
      <LiveSessionCard page={page} />
      <h2 className="mt-1 text-lg font-bold">Who&apos;s checking in?</h2>
      {recognisedMember && <RecognisedPhoneCard member={recognisedMember} />}
      <p
        className={`text-sm text-muted ${recognisedMember ? "text-center" : ""}`}
      >
        {recognisedMember ? "Not you? Find your name" : "Find your name"}
      </p>
      <NameSearch
        search={search}
        onSearchQueryChange={onSearchQueryChange}
        onNamePicked={(match) =>
          onCandidatePicked({ ...match, source: "search" })
        }
      />
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onGuestFormOpened}
          className={`${LINK_BUTTON_CLASS_NAME} px-1 underline underline-offset-[3px]`}
        >
          Not a member? Check in as a guest
        </button>
      </div>
      {recognisedMember && (
        <div
          className={`${BOTTOM_ACTION_BAR_CLASS_NAME} sticky bottom-0 bg-bg`}
        >
          <button
            type="button"
            onClick={() =>
              onCandidatePicked({
                memberId: recognisedMember.memberId,
                firstName: recognisedMember.firstName,
                lastName: recognisedMember.lastName,
                source: "recognised",
              })
            }
            className={`${PRIMARY_BUTTON_CLASS_NAME} gap-2.5`}
          >
            <CheckMarkIcon sizePx={20} />
            Check in as {recognisedMember.firstName}
          </button>
        </div>
      )}
    </>
  );
}

function RecognisedPhoneCard({ member }: { member: RecognisedMember }) {
  const fullName = `${member.firstName} ${member.lastName}`;
  return (
    <div className="flex min-h-[72px] items-center gap-3 rounded-[20px] border border-blue-edge bg-blue-surface px-4 py-3.5">
      <InitialsAvatar name={fullName} tone="next" size="large" />
      <p className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-link">
          This phone was used by
        </span>
        <strong className="block text-lg font-bold break-words">
          {fullName}
        </strong>
      </p>
      <span
        aria-hidden="true"
        className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-blue text-on-blue"
      >
        <CheckMarkIcon sizePx={15} />
      </span>
    </div>
  );
}

function NameSearch({
  search,
  onSearchQueryChange,
  onNamePicked,
}: {
  search: SearchState;
  onSearchQueryChange: (query: string) => void;
  onNamePicked: (match: NameMatch) => void;
}) {
  const isSearchable = isSearchableQuery(search.query);
  const matches = isSearchable ? search.matches : null;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={SEARCH_INPUT_ID} className="sr-only">
          Find your name
        </label>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-[15px] left-3.5 text-muted" />
          <input
            id={SEARCH_INPUT_ID}
            type="search"
            autoComplete="off"
            autoCapitalize="words"
            spellCheck={false}
            placeholder="Type your name"
            value={search.query}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            aria-describedby={SEARCH_STATUS_ID}
            className={`${TEXT_INPUT_CLASS_NAME} pl-[42px]`}
          />
        </div>
      </div>
      {/* One polite region for the hint and the search outcome. */}
      <div id={SEARCH_STATUS_ID} role="status" className="empty:hidden">
        {!isSearchable && (
          <p className="text-[13px] text-muted">
            Type at least 2 letters of your name
          </p>
        )}
        {matches?.length === 0 && (
          <InfoNotice>
            No one matches “{search.matchesQuery}”. Check the spelling, or check
            in as a guest.
          </InfoNotice>
        )}
        {matches?.length === MAX_SEARCH_MATCHES && (
          <p className="text-[13px] text-muted">
            {MAX_SEARCH_MATCHES} names shown. Not listed? Type more of your
            name.
          </p>
        )}
      </div>
      {/* Screen readers hear how many names the list shows (1-4; 5 has its
          own line above). Out of the layout, so it adds no gap. */}
      <p role="status" className="sr-only">
        {matches && matches.length > 0 && matches.length < MAX_SEARCH_MATCHES
          ? `${matches.length} ${matches.length === 1 ? "name" : "names"} found`
          : ""}
      </p>
      {matches && matches.length > 0 && (
        <ul aria-label="Matching names" className="flex flex-col gap-2">
          {matches.map((match) => {
            const fullName = `${match.firstName} ${match.lastName}`;
            return (
              <li key={match.memberId}>
                <button
                  type="button"
                  onClick={() => onNamePicked(match)}
                  className="flex min-h-[52px] w-full items-center gap-3 rounded-2xl border border-inner-border bg-inner px-3 py-2 text-left text-[15px] font-semibold hover:bg-nav-active"
                >
                  <InitialsAvatar name={fullName} />
                  <span className="min-w-0 flex-1 break-words">{fullName}</span>
                  <ChevronIcon direction="right" className="text-muted" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
