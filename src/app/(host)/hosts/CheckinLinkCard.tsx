"use client";

import Link from "next/link";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  CARD_CLASS_NAME,
  LINK_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { STICKER_AND_QR_PAGE_PATH } from "../checkin-link/checkinLinkPaths";
import { IssueNewLinkButton } from "./IssueNewLinkButton";
import { useMessages } from "@/i18n/LocaleProvider";

/**
 * The Hosts page's "Check-in link" card (S04a): every host sees the link and
 * "Open Sticker and QR"; only a manager sees "Issue new link" (decision #29).
 * The server action checks the role again: hiding the button isn't the guard.
 * The link streams in on its own (`loading`), and a failed read leaves the
 * rest of the card working (`failed`).
 */
export type CheckinLinkCardLink =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; shortLink: string };

export function CheckinLinkCard({
  checkinLink,
  socialName,
  canIssueNewLink,
}: {
  checkinLink: CheckinLinkCardLink;
  socialName: string;
  canIssueNewLink: boolean;
}) {
  const text = useMessages().host.hosts.checkinLink;
  return (
    <section
      aria-labelledby="checkin-link-card-heading"
      className={`${CARD_CLASS_NAME} flex flex-col gap-4`}
    >
      <h2
        id="checkin-link-card-heading"
        className="text-xl font-bold compact:text-base"
      >
        {text.heading}
      </h2>
      <p className="text-sm text-muted">{text.intro}</p>
      {checkinLink.status === "loaded" && (
        <p className="rounded-2xl border border-inner-border bg-inner px-3.5 py-3 text-sm font-semibold break-all text-text-soft">
          {checkinLink.shortLink}
        </p>
      )}
      {checkinLink.status === "loading" && (
        <p className="text-sm text-muted" aria-live="polite">
          {text.loading}
        </p>
      )}
      {checkinLink.status === "failed" && (
        <AttentionMessage>{text.failed}</AttentionMessage>
      )}
      <Link
        href={STICKER_AND_QR_PAGE_PATH}
        className={`${LINK_BUTTON_CLASS_NAME} self-start underline`}
      >
        {text.openStickerAndQr}
      </Link>
      {canIssueNewLink && (
        <div className="flex flex-col gap-2.5 border-t border-card-border pt-4">
          <p className="text-sm text-muted">{text.issueNewIntro}</p>
          <IssueNewLinkButton socialName={socialName} />
        </div>
      )}
    </section>
  );
}
