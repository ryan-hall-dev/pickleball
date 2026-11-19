"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import { PRIMARY_BUTTON_CLASS_NAME } from "@/components/controlStyles";
import type { CheckinSessionHeader } from "@/server/checkin/checkinResults";
import {
  BrokenLinkIcon,
  CalendarIcon,
  CheckMarkIcon,
  ClockIcon,
  NoConnectionIcon,
  PendingIcon,
  PersonIcon,
  RefreshIcon,
} from "./CheckinIcons";
import { useLocale, useMessages } from "@/i18n/LocaleProvider";
import { BrandLine } from "./CheckinParts";
import { formatCheckinSessionWhen } from "./checkinHeaderFormatting";
import {
  BOTTOM_ACTION_BAR_CLASS_NAME,
  FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME,
  STATE_PANEL_CLASS_NAME,
} from "./checkinStyles";
import type { Requester } from "./checkinViewState";

// P06-P13: the state screens. Brand line only (no LIVE NOW card), a 72px
// icon, a heading and words, so no state relies on colour alone.

const ICON_TONE_CLASS_NAMES = {
  blue: "border-2 border-blue-edge bg-blue-surface text-link",
  lime: "bg-lime text-on-lime",
  neutral: "border-2 border-outline bg-inner text-text-soft",
  orange: "border-2 border-orange-edge bg-orange-surface-strong text-orange",
} as const;

function StateScreen({
  brandName,
  iconTone,
  icon,
  role,
  title,
  children,
  afterState,
  action,
}: {
  brandName: string;
  iconTone: keyof typeof ICON_TONE_CLASS_NAMES;
  icon: ReactNode;
  /** status for outcomes, alert for failures; none while waiting (its poll line is the live region). */
  role?: "status" | "alert";
  title: string;
  children: ReactNode;
  afterState?: ReactNode;
  action?: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // A new screen replaces the old one: start reading from its heading.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <>
      <BrandLine name={brandName} />
      <div
        role={role}
        className="flex flex-col items-center gap-3.5 px-1 pt-9 text-center"
      >
        <div
          aria-hidden="true"
          className={`flex size-[72px] items-center justify-center rounded-full ${ICON_TONE_CLASS_NAMES[iconTone]}`}
        >
          {icon}
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-[26px] leading-[1.15] font-extrabold tracking-[-0.01em] break-words focus:outline-none"
        >
          {title}
        </h1>
        {children}
      </div>
      {afterState}
      {action && <div className={BOTTOM_ACTION_BAR_CLASS_NAME}>{action}</div>}
    </>
  );
}

function StateText({ children }: { children: ReactNode }) {
  return <p className="text-base text-text-soft">{children}</p>;
}

type PillTone = "waiting" | "checkedIn";

function StatusPill({ tone }: { tone: PillTone }) {
  const copy = useMessages().checkin.pill;
  return tone === "waiting" ? (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-edge bg-blue-surface px-2.5 py-1 text-xs font-bold text-blue-soft">
      <PendingIcon />
      {copy.waiting}
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-lime-edge bg-lime-surface px-2.5 py-1 text-xs font-bold text-lime-soft">
      <CheckMarkIcon sizePx={12} />
      {copy.checkedIn}
    </span>
  );
}

/** The player's own name with their request's status, e.g. "Grace Kim · Waiting". */
function OwnRequestRow({
  displayName,
  caption,
  pillTone,
}: {
  displayName: string;
  caption: string;
  pillTone: PillTone;
}) {
  return (
    <div className="flex items-center gap-3">
      <InitialsAvatar name={displayName} tone="next" size="large" />
      <p className="min-w-0 flex-1">
        <strong className="block text-[17px] font-bold break-words">
          {displayName}
        </strong>
        <span className="block text-[13px] text-muted tabular-nums">
          {caption}
        </span>
      </p>
      <StatusPill tone={pillTone} />
    </div>
  );
}

function BulletPanel({ title, items }: { title: string; items: string[] }) {
  return (
    <section className={STATE_PANEL_CLASS_NAME}>
      <h2 className="text-[15px] font-bold">{title}</h2>
      <ul className="flex list-disc flex-col gap-1.5 pl-[18px] text-sm text-text-soft">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/** P06 */
export function WaitingScreen({
  socialName,
  session,
  requester,
}: {
  socialName: string;
  session: CheckinSessionHeader;
  requester: Requester;
}) {
  const copy = useMessages().checkin.waiting;
  return (
    <StateScreen
      brandName={socialName}
      iconTone="blue"
      icon={<ClockIcon sizePx={34} />}
      title={copy.title}
      afterState={
        <>
          <div className={STATE_PANEL_CLASS_NAME}>
            <OwnRequestRow
              displayName={requester.displayName}
              caption={session.name}
              pillTone="waiting"
            />
            <p
              role="status"
              className="flex items-center gap-2 text-[13px] font-semibold text-link"
            >
              <RefreshIcon />
              {copy.updatesItself}
            </p>
          </div>
          <BulletPanel
            title={copy.whileYouWait}
            items={[copy.keepOpen, copy.takingAWhile]}
          />
        </>
      }
    >
      <StateText>{copy.sent(session.name)}</StateText>
    </StateScreen>
  );
}

/** P07 */
export function ApprovedScreen({
  socialName,
  session,
  requester,
}: {
  socialName: string;
  session: CheckinSessionHeader;
  requester: Requester;
}) {
  const { locale, messages } = useLocale();
  const copy = messages.checkin.approved;
  return (
    <StateScreen
      brandName={socialName}
      iconTone="lime"
      icon={<CheckMarkIcon sizePx={36} />}
      role="status"
      title={copy.title(requester.firstName)}
      afterState={
        <>
          <div className={STATE_PANEL_CLASS_NAME}>
            <OwnRequestRow
              displayName={requester.displayName}
              caption={formatCheckinSessionWhen(session, messages, locale)}
              pillTone="checkedIn"
            />
          </div>
          <BulletPanel
            title={copy.whatNext}
            items={[copy.courtWhenTurn, copy.stayNear, copy.canClose]}
          />
        </>
      }
    >
      <StateText>{copy.checkedInTo(session.name)}</StateText>
    </StateScreen>
  );
}

/** Already checked in: answered only to this phone's own approved request. */
export function AlreadyCheckedInScreen({
  socialName,
  session,
  requester,
}: {
  socialName: string;
  session: CheckinSessionHeader;
  requester: Requester;
}) {
  const { locale, messages } = useLocale();
  const copy = messages.checkin.alreadyCheckedIn;
  return (
    <StateScreen
      brandName={socialName}
      iconTone="lime"
      icon={<CheckMarkIcon sizePx={36} />}
      role="status"
      title={copy.title(session.name)}
      afterState={
        <div className={STATE_PANEL_CLASS_NAME}>
          <OwnRequestRow
            displayName={requester.displayName}
            caption={formatCheckinSessionWhen(session, messages, locale)}
            pillTone="checkedIn"
          />
        </div>
      }
    >
      <StateText>{copy.nothingMore(requester.firstName)}</StateText>
    </StateScreen>
  );
}

/** P08: neutral wording and icon; Try again starts a new request. */
export function RejectedScreen({
  socialName,
  onTryAgain,
}: {
  socialName: string;
  onTryAgain: () => void;
}) {
  const messages = useMessages();
  return (
    <StateScreen
      brandName={socialName}
      iconTone="neutral"
      icon={<PersonIcon />}
      role="status"
      title={messages.checkin.rejected.title}
      action={
        <button
          type="button"
          onClick={onTryAgain}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          {messages.checkin.tryAgain}
        </button>
      }
    >
      <StateText>{messages.checkin.rejected.text}</StateText>
    </StateScreen>
  );
}

/** P10 */
export function RateLimitedScreen({
  brandName,
  isBusy,
  onTryAgain,
}: {
  brandName: string;
  isBusy: boolean;
  onTryAgain: () => void;
}) {
  const messages = useMessages();
  return (
    <StateScreen
      brandName={brandName}
      iconTone="orange"
      icon={<span className="text-[34px] leading-none font-extrabold">!</span>}
      role="alert"
      title={messages.checkin.rateLimited.title}
      action={
        <button
          type="button"
          onClick={onTryAgain}
          disabled={isBusy}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          {messages.checkin.tryAgain}
        </button>
      }
    >
      <StateText>{messages.checkin.rateLimited.text}</StateText>
    </StateScreen>
  );
}

/** P11: the app's name, nothing about any social, host or session. */
export function InactiveLinkScreen() {
  const messages = useMessages();
  return (
    <StateScreen
      brandName={messages.appName}
      iconTone="neutral"
      icon={<BrokenLinkIcon />}
      title={messages.checkin.inactive.title}
    >
      <StateText>{messages.checkin.inactive.text}</StateText>
    </StateScreen>
  );
}

/** P12 */
export function NoOpenSessionScreen({
  socialName,
  isBusy,
  onCheckAgain,
}: {
  socialName: string;
  isBusy: boolean;
  onCheckAgain: () => void;
}) {
  const copy = useMessages().checkin.noOpenSession;
  return (
    <StateScreen
      brandName={socialName}
      iconTone="neutral"
      icon={<CalendarIcon />}
      title={copy.title}
      action={
        <button
          type="button"
          onClick={onCheckAgain}
          disabled={isBusy}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          {copy.checkAgain}
        </button>
      }
    >
      <StateText>{copy.text}</StateText>
    </StateScreen>
  );
}

/** P13: offline and server errors alike. */
export function UnavailableScreen({
  brandName,
  isBusy,
  onTryAgain,
}: {
  brandName: string;
  isBusy: boolean;
  onTryAgain: () => void;
}) {
  const messages = useMessages();
  const copy = messages.checkin.unavailable;
  return (
    <StateScreen
      brandName={brandName}
      iconTone="orange"
      icon={<NoConnectionIcon />}
      role="alert"
      title={copy.title}
      action={
        <button
          type="button"
          onClick={onTryAgain}
          disabled={isBusy}
          aria-busy={isBusy}
          className={PRIMARY_BUTTON_CLASS_NAME}
        >
          {messages.checkin.tryAgain}
        </button>
      }
    >
      <StateText>{copy.text}</StateText>
      <p className="text-sm text-muted">{copy.noDoubleSend}</p>
    </StateScreen>
  );
}
