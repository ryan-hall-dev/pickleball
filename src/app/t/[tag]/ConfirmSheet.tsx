"use client";

import { useEffect, useRef, type MouseEvent, type SyntheticEvent } from "react";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import { SkillChip } from "@/components/SkillChip";
import { PRIMARY_BUTTON_CLASS_NAME } from "@/components/controlStyles";
import type { OpenCheckinPage } from "@/server/checkin/checkinResults";
import type { SkillLevel } from "@/server/members/memberSearch";
import { CheckMarkIcon, ChevronIcon } from "./CheckinIcons";
import {
  HOST_APPROVES_NOTE,
  InfoNotice,
  SkillLevelOptions,
} from "./CheckinParts";
import { formatCheckinSessionWhen } from "./checkinHeaderFormatting";
import { FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME } from "./checkinStyles";
import type { ConfirmSheetState } from "./checkinViewState";

const TITLE_ID = "checkin-confirm-title";
const LEVEL_DISCLOSURE_ID = "checkin-update-level-toggle";
const LEVEL_PICKER_ID = "checkin-update-level";

/**
 * The confirm bottom sheet (P04a recognised phone: name and saved level;
 * P04b/c picked from search: name only, with an optional, collapsed "Update
 * your level" that preselects nothing so the saved level stays private).
 * A native modal <dialog>: focus stays inside, Esc and the backdrop close it.
 */
export function ConfirmSheet({
  page,
  confirm,
  isBusy,
  onClose,
  onLevelPickerToggled,
  onLevelPressed,
  onCheckIn,
}: {
  page: OpenCheckinPage;
  confirm: ConfirmSheetState | null;
  isBusy: boolean;
  onClose: () => void;
  onLevelPickerToggled: () => void;
  onLevelPressed: (skillLevel: SkillLevel) => void;
  onCheckIn: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const isOpen = confirm !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) throw new Error("The confirm sheet isn't mounted.");
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  function closeWithEscape(event: SyntheticEvent<HTMLDialogElement>) {
    // Closed through the state, so Esc can't close it mid-submit.
    event.preventDefault();
    onClose();
  }

  function closeOnBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    // The content fills the dialog, so only the backdrop targets it directly.
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={TITLE_ID}
      onCancel={closeWithEscape}
      onClose={() => {
        // A browser may force-close after repeated Esc: follow it.
        if (isOpen) onClose();
      }}
      onClick={closeOnBackdropClick}
      className="mx-auto mt-auto mb-0 max-h-[calc(100%-24px)] w-full max-w-[440px] overflow-y-auto rounded-t-[28px] rounded-b-none border-x-0 border-t border-b-0 border-inner-border bg-card p-0 text-text shadow-[0_24px_64px_rgba(0,0,0,0.5)] backdrop:bg-bg-backdrop/80"
    >
      {confirm && (
        <ConfirmSheetContent
          page={page}
          confirm={confirm}
          isBusy={isBusy}
          onClose={onClose}
          onLevelPickerToggled={onLevelPickerToggled}
          onLevelPressed={onLevelPressed}
          onCheckIn={onCheckIn}
        />
      )}
    </dialog>
  );
}

function ConfirmSheetContent({
  page,
  confirm,
  isBusy,
  onClose,
  onLevelPickerToggled,
  onLevelPressed,
  onCheckIn,
}: {
  page: OpenCheckinPage;
  confirm: ConfirmSheetState;
  isBusy: boolean;
  onClose: () => void;
  onLevelPickerToggled: () => void;
  onLevelPressed: (skillLevel: SkillLevel) => void;
  onCheckIn: () => void;
}) {
  const { candidate } = confirm;
  const fullName = `${candidate.firstName} ${candidate.lastName}`;
  const isRecognised = candidate.source === "recognised";
  // Only the phone's own member shows a saved level (privacy).
  const savedSkillLevel = isRecognised
    ? (page.recognisedMember?.skillLevel ?? null)
    : null;

  return (
    <div className="flex flex-col gap-4 px-5 pt-6 pb-[max(24px,env(safe-area-inset-bottom))]">
      <div>
        <h2
          id={TITLE_ID}
          className="text-[26px] leading-[1.15] font-extrabold break-words"
        >
          Check in as {fullName}?
        </h2>
        <p className="mt-1 text-sm text-muted tabular-nums">
          {page.session.name} · {formatCheckinSessionWhen(page.session)}
        </p>
      </div>
      <div className="flex items-center gap-3.5 rounded-[18px] border border-inner-border bg-inner p-3.5">
        <InitialsAvatar
          name={fullName}
          tone={isRecognised ? "next" : "waiting"}
          size="extraLarge"
        />
        <div className="min-w-0">
          <strong className="block text-lg font-bold break-words">
            {fullName}
          </strong>
          {isRecognised && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <SkillChip skillLevel={savedSkillLevel} />
              <span className="text-xs text-muted">Your saved level</span>
            </div>
          )}
        </div>
      </div>
      {!isRecognised && (
        <>
          <button
            id={LEVEL_DISCLOSURE_ID}
            type="button"
            aria-expanded={confirm.isLevelPickerOpen}
            aria-controls={LEVEL_PICKER_ID}
            onClick={onLevelPickerToggled}
            disabled={isBusy}
            className="flex min-h-12 w-full items-center justify-between rounded-[14px] border border-outline px-3.5 text-[15px] font-semibold hover:bg-inner"
          >
            <span>
              Update your level{" "}
              <small className="text-[15px] font-medium text-muted">
                (optional)
              </small>
            </span>
            <ChevronIcon
              direction={confirm.isLevelPickerOpen ? "up" : "down"}
            />
          </button>
          {confirm.isLevelPickerOpen && (
            <div className="-mt-1.5 flex flex-col gap-1.5">
              <SkillLevelOptions
                id={LEVEL_PICKER_ID}
                selectedSkillLevel={confirm.updatedSkillLevel}
                onSkillLevelPressed={onLevelPressed}
                labelledById={LEVEL_DISCLOSURE_ID}
                describedById={`${LEVEL_PICKER_ID}-hint`}
                isDisabled={isBusy}
              />
              <p
                id={`${LEVEL_PICKER_ID}-hint`}
                className="text-[13px] text-muted"
              >
                Skip this to keep your saved level. Tap a selected level again
                to clear it.
              </p>
            </div>
          )}
        </>
      )}
      {!confirm.isLevelPickerOpen && (
        <InfoNotice>{HOST_APPROVES_NOTE}</InfoNotice>
      )}
      <button
        type="button"
        onClick={onCheckIn}
        disabled={isBusy}
        aria-busy={isBusy}
        className={`${PRIMARY_BUTTON_CLASS_NAME} gap-2.5`}
      >
        <CheckMarkIcon sizePx={20} />
        Check in
      </button>
      <button
        type="button"
        onClick={onClose}
        disabled={isBusy}
        className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
      >
        Back
      </button>
    </div>
  );
}
