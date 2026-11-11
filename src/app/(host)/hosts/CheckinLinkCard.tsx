import Link from "next/link";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  CARD_CLASS_NAME,
  LINK_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { STICKER_AND_QR_PAGE_PATH } from "../checkin-link/checkinLinkPaths";
import { IssueNewLinkButton } from "./IssueNewLinkButton";

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
  return (
    <section
      aria-labelledby="checkin-link-card-heading"
      className={`${CARD_CLASS_NAME} flex flex-col gap-4`}
    >
      <h2 id="checkin-link-card-heading" className="text-xl font-bold">
        Check-in link
      </h2>
      <p className="text-sm text-muted">
        Players open this link from the QR code or a sticker to check in.
      </p>
      {checkinLink.status === "loaded" && (
        <p className="rounded-2xl border border-inner-border bg-inner px-3.5 py-3 text-sm font-semibold break-all text-text-soft">
          {checkinLink.shortLink}
        </p>
      )}
      {checkinLink.status === "loading" && (
        <p className="text-sm text-muted" aria-live="polite">
          Loading the check-in link…
        </p>
      )}
      {checkinLink.status === "failed" && (
        <AttentionMessage>
          Couldn&apos;t load the check-in link.
        </AttentionMessage>
      )}
      <Link
        href={STICKER_AND_QR_PAGE_PATH}
        className={`${LINK_BUTTON_CLASS_NAME} self-start underline`}
      >
        Open Sticker and QR
      </Link>
      {canIssueNewLink && (
        <div className="flex flex-col gap-2.5 border-t border-card-border pt-4">
          <p className="text-sm text-muted">
            Issue a new link if the old one was shared where it shouldn&apos;t
            be. The current link, QR code and every printed sticker stop
            working.
          </p>
          <IssueNewLinkButton socialName={socialName} />
        </div>
      )}
    </section>
  );
}
