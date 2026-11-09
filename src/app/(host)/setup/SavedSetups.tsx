"use client";

import { useId, useState, type FormEvent } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import type { SavedSetupSummary } from "@/server/setup/setupDraft";
import { SHORT_LABEL_MAX_LENGTH } from "@/server/setup/setupRules";
import { ROTATION_OBJECTIVE_COPY } from "./rotationOptions";

export type SavedSetupsPanel = "none" | "list" | "save";

const SAVED_SETUPS_PANEL_ID = "saved-setups-panel";
const SAVE_SETUP_PANEL_ID = "save-setup-panel";

/** Outline buttons in the blue reuse banner (36px; 44px for fingers). */
const BANNER_BUTTON_CLASS_NAME =
  "inline-flex h-9 items-center justify-center rounded-[10px] border border-blue-edge px-3 text-sm font-semibold text-blue-soft hover:bg-blue-avatar disabled:cursor-not-allowed disabled:text-placeholder pointer-coarse:h-11";

/** "last used 31 Oct · 4 courts · Equal games first" */
export function describeSavedSetup(setup: SavedSetupSummary): string {
  const lastUsed = new Date(setup.lastUsedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
  const courts = `${setup.courtCount} ${setup.courtCount === 1 ? "court" : "courts"}`;
  return `last used ${lastUsed} · ${courts} · ${ROTATION_OBJECTIVE_COPY[setup.topObjective].shortLabel} first`;
}

/** Header buttons (DESIGN.md Setup): "Saved setups" and "Save this setup". */
export function SavedSetupsButtons({
  isDisabled,
  openPanel,
  onOpenPanelChange,
}: {
  /** While a setup is being applied. */
  isDisabled: boolean;
  openPanel: SavedSetupsPanel;
  onOpenPanelChange: (panel: SavedSetupsPanel) => void;
}) {
  const toggle = (panel: SavedSetupsPanel) =>
    onOpenPanelChange(openPanel === panel ? "none" : panel);
  return (
    <>
      <button
        type="button"
        aria-expanded={openPanel === "list"}
        aria-controls={SAVED_SETUPS_PANEL_ID}
        disabled={isDisabled}
        onClick={() => toggle("list")}
        className={`${OUTLINE_BUTTON_CLASS_NAME} gap-2`}
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
        Saved setups
      </button>
      <button
        type="button"
        aria-expanded={openPanel === "save"}
        aria-controls={SAVE_SETUP_PANEL_ID}
        disabled={isDisabled}
        onClick={() => toggle("save")}
        className={`${OUTLINE_BUTTON_CLASS_NAME} gap-2`}
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 4h11l3 3v13H5z" />
          <path d="M8 4v5h7V4M8 20v-6h8v6" />
        </svg>
        Save this setup
      </button>
    </>
  );
}

/** The host's saved setups, most recently used first, each with Use. */
export function SavedSetupsList({
  savedSetups,
  isApplying,
  onUse,
}: {
  savedSetups: SavedSetupSummary[];
  isApplying: boolean;
  onUse: (setup: SavedSetupSummary) => void;
}) {
  return (
    <section
      id={SAVED_SETUPS_PANEL_ID}
      aria-labelledby="saved-setups-heading"
      className="rounded-[20px] border border-inner-border bg-inner p-4"
    >
      <h2 id="saved-setups-heading" className="mb-3 text-base font-bold">
        Saved setups
      </h2>
      {savedSetups.length === 0 ? (
        <p className="text-[15px] text-muted">
          No saved setups yet. Use &ldquo;Save this setup&rdquo; to keep this
          one&apos;s location, courts, timings and rotation for next time.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {savedSetups.map((setup) => (
            <li
              key={setup.setupId}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-inner-border bg-card px-3.5 py-2.5"
            >
              <span className="flex min-w-0 flex-[1_1_220px] flex-col">
                <span className="truncate font-semibold">{setup.name}</span>
                <span className="text-xs text-muted tabular-nums">
                  {describeSavedSetup(setup)}
                </span>
              </span>
              <button
                type="button"
                disabled={isApplying}
                aria-label={`Use ${setup.name}`}
                onClick={() => onUse(setup)}
                className={SECONDARY_BUTTON_CLASS_NAME}
              >
                Use
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type SaveSetupOutcome =
  { ok: true; message: string } | { ok: false; message: string };

/** "Save this setup": a name (default: the session's), then save or replace. */
export function SaveSetupForm({
  isDisabled,
  defaultName,
  onSave,
  onClose,
}: {
  /** While a setup is being applied. */
  isDisabled: boolean;
  defaultName: string;
  onSave: (setupName: string) => Promise<SaveSetupOutcome>;
  onClose: () => void;
}) {
  const [setupName, setSetupName] = useState(defaultName.trim());
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const errorId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (setupName.trim() === "") {
      setError("Name this setup.");
      return;
    }
    setIsSaving(true);
    setError(null);
    const outcome = await onSave(setupName);
    setIsSaving(false);
    if (!outcome.ok) setError(outcome.message);
  }

  return (
    <section
      id={SAVE_SETUP_PANEL_ID}
      aria-labelledby="save-setup-heading"
      className="rounded-[20px] border border-inner-border bg-inner p-4"
    >
      <h2 id="save-setup-heading" className="text-base font-bold">
        Save this setup
      </h2>
      <p className="mt-1 mb-3 text-[13px] text-muted">
        Keeps the location, length, courts, timings and rotation (not who&apos;s
        playing). Saving under a name you already use replaces that setup.
      </p>
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-wrap items-start gap-2.5"
      >
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5">
          <label htmlFor="save-setup-name" className={FIELD_LABEL_CLASS_NAME}>
            Setup name
          </label>
          <input
            id="save-setup-name"
            type="text"
            autoComplete="off"
            required
            maxLength={SHORT_LABEL_MAX_LENGTH}
            value={setupName}
            onChange={(event) => {
              setSetupName(event.target.value);
              setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={TEXT_INPUT_CLASS_NAME}
          />
          <div aria-live="polite" className="empty:hidden">
            {error && <AttentionMessage id={errorId}>{error}</AttentionMessage>}
          </div>
        </div>
        <div className="mt-[25px] flex gap-2">
          <button
            type="submit"
            disabled={isSaving || isDisabled}
            className={SECONDARY_BUTTON_CLASS_NAME}
          >
            {isSaving ? "Saving…" : "Save setup"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className={OUTLINE_BUTTON_CLASS_NAME}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

/** DESIGN.md reuse banner: offers the most recently used setup. */
export function ReuseSetupBanner({
  setup,
  isApplying,
  onUse,
  onDismiss,
}: {
  setup: SavedSetupSummary;
  isApplying: boolean;
  onUse: () => void;
  onDismiss: () => void;
}) {
  return (
    <section
      aria-label="Reuse a saved setup"
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[20px] border border-blue-edge bg-blue-surface px-4 py-3"
    >
      <svg
        aria-hidden="true"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-link"
      >
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5M12 7v5l3 2" />
      </svg>
      <p className="min-w-0 flex-[1_1_300px] text-sm">
        <b>Reuse &ldquo;{setup.name}&rdquo;</b>{" "}
        <span className="text-muted tabular-nums">
          · {describeSavedSetup(setup)}
        </span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={isApplying}
          onClick={onUse}
          className={BANNER_BUTTON_CLASS_NAME}
        >
          {isApplying ? "Applying…" : "Use this setup"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className={BANNER_BUTTON_CLASS_NAME}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
