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
import { APP_NAME, BrandLine } from "./CheckinParts";
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
  return tone === "waiting" ? (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-edge bg-blue-surface px-2.5 py-1 text-xs font-bold text-blue-soft">
      <PendingIcon />
      Waiting
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-lime-edge bg-lime-surface px-2.5 py-1 text-xs font-bold text-lime-soft">
      <CheckMarkIcon sizePx={12} />
      Checked in
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
  return (
    <StateScreen
      brandName={socialName}
      iconTone="blue"
      icon={<ClockIcon sizePx={34} />}
      title="Waiting for the host to approve"
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
              This page updates by itself every few seconds.
            </p>
          </div>
          <BulletPanel
            title="While you wait"
            items={[
              "Keep this page open, or come back to the same link later. Your request stays here.",
              "Taking a while? Let a host know you've arrived.",
            ]}
          />
        </>
      }
    >
      <StateText>Your check-in for {session.name} has been sent.</StateText>
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
  return (
    <StateScreen
      brandName={socialName}
      iconTone="lime"
      icon={<CheckMarkIcon sizePx={36} />}
      role="status"
      title={`You're in, ${requester.firstName}`}
      afterState={
        <>
          <div className={STATE_PANEL_CLASS_NAME}>
            <OwnRequestRow
              displayName={requester.displayName}
              caption={formatCheckinSessionWhen(session)}
              pillTone="checkedIn"
            />
          </div>
          <BulletPanel
            title="What happens next"
            items={[
              "The hosts put you on a court when it's your turn.",
              "Stay near the courts and listen for your name.",
              "You can close this page.",
            ]}
          />
        </>
      }
    >
      <StateText>You&apos;re checked in to {session.name}.</StateText>
    </StateScreen>
  );
}

/** P09 (this phone's own member, straight away) and P09b (a host closed the request). */
export function AlreadyCheckedInScreen({
  socialName,
  session,
  requester,
  confirmedBy,
}: {
  socialName: string;
  session: CheckinSessionHeader;
  requester: Requester;
  confirmedBy: "own_phone" | "host";
}) {
  return (
    <StateScreen
      brandName={socialName}
      iconTone="lime"
      icon={<CheckMarkIcon sizePx={36} />}
      role="status"
      title={`You're already checked in to ${session.name}`}
      afterState={
        <div className={STATE_PANEL_CLASS_NAME}>
          <OwnRequestRow
            displayName={requester.displayName}
            caption={formatCheckinSessionWhen(session)}
            pillTone="checkedIn"
          />
        </div>
      }
    >
      <StateText>
        {confirmedBy === "own_phone"
          ? `Nothing more to do, ${requester.firstName}. Stay near the courts and listen for your name.`
          : "A host confirmed you're on the list. Nothing else to do."}
      </StateText>
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
  return (
    <StateScreen
      brandName={socialName}
      iconTone="neutral"
      icon={<PersonIcon />}
      role="status"
      title="Check-in not approved"
      action={
        <button
          type="button"
          onClick={onTryAgain}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          Try again
        </button>
      }
    >
      <StateText>
        The host didn&apos;t approve this check-in. Please speak to the host.
      </StateText>
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
  return (
    <StateScreen
      brandName={brandName}
      iconTone="orange"
      icon={<span className="text-[34px] leading-none font-extrabold">!</span>}
      role="alert"
      title="Too many attempts"
      action={
        <button
          type="button"
          onClick={onTryAgain}
          disabled={isBusy}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          Try again
        </button>
      }
    >
      <StateText>
        Too many attempts. Wait a few minutes and try again.
      </StateText>
    </StateScreen>
  );
}

/** P11: the app's name, nothing about any social, host or session. */
export function InactiveLinkScreen() {
  return (
    <StateScreen
      brandName={APP_NAME}
      iconTone="neutral"
      icon={<BrokenLinkIcon />}
      title="This check-in link isn't active"
    >
      <StateText>Ask a host at the courts for the current QR code.</StateText>
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
  return (
    <StateScreen
      brandName={socialName}
      iconTone="neutral"
      icon={<CalendarIcon />}
      title="No social open right now"
      action={
        <button
          type="button"
          onClick={onCheckAgain}
          disabled={isBusy}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          Check again
        </button>
      }
    >
      <StateText>Check back when your host opens the session.</StateText>
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
  return (
    <StateScreen
      brandName={brandName}
      iconTone="orange"
      icon={<NoConnectionIcon />}
      role="alert"
      title="Something went wrong"
      action={
        <button
          type="button"
          onClick={onTryAgain}
          disabled={isBusy}
          aria-busy={isBusy}
          className={PRIMARY_BUTTON_CLASS_NAME}
        >
          Try again
        </button>
      }
    >
      <StateText>
        We couldn&apos;t reach the check-in. Check your connection and try
        again.
      </StateText>
      <p className="text-sm text-muted">
        If you&apos;d already pressed Check in, trying again won&apos;t send a
        second request.
      </p>
    </StateScreen>
  );
}
