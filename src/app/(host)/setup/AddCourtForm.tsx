"use client";

import { useState, useTransition, type FormEvent } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  SELECTED_OPTION_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
  UNSELECTED_OPTION_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import type { CourtFormat } from "@/engine";
import { addClubCourt } from "@/server/setup/setupActions";
import type { ClubCourt } from "@/server/setup/setupDraft";
import {
  COURT_FORMATS,
  SHORT_LABEL_MAX_LENGTH,
} from "@/server/setup/setupRules";

const SUPPORTED_FORMAT_LABELS: Record<CourtFormat, string> = {
  doubles: "Doubles",
  singles: "Singles",
};

/** Adds a court to the club (shared by every session), then selects it. */
export function AddCourtForm({
  suggestedName,
  onCancel,
  onAdded,
}: {
  suggestedName: string;
  onCancel: () => void;
  onAdded: (court: ClubCourt) => void;
}) {
  const [courtName, setCourtName] = useState(suggestedName);
  const [supportedFormats, setSupportedFormats] = useState<CourtFormat[]>([
    ...COURT_FORMATS,
  ]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggleFormat(format: CourtFormat) {
    setSupportedFormats((currentFormats) =>
      currentFormats.includes(format)
        ? currentFormats.filter((currentFormat) => currentFormat !== format)
        : COURT_FORMATS.filter(
            (knownFormat) =>
              knownFormat === format || currentFormats.includes(knownFormat),
          ),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    startTransition(async () => {
      const result = await addClubCourt({ name: courtName, supportedFormats });
      if (result.ok) onAdded(result.court);
      else setErrorMessage(result.message);
    });
  }

  return (
    <form
      onSubmit={submit}
      aria-labelledby="add-court-heading"
      className="mt-3 flex flex-col gap-3 rounded-[18px] border border-inner-border bg-inner p-4"
    >
      <h3 id="add-court-heading" className="text-base font-bold">
        Add a court to the club
      </h3>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-[1_1_200px] flex-col gap-1.5">
          <label htmlFor="new-court-name" className={FIELD_LABEL_CLASS_NAME}>
            Court name
          </label>
          <input
            id="new-court-name"
            value={courtName}
            onChange={(event) => setCourtName(event.target.value)}
            maxLength={SHORT_LABEL_MAX_LENGTH}
            autoComplete="off"
            // The form opens on request, so moving focus into it is expected.
            autoFocus
            className={TEXT_INPUT_CLASS_NAME}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span id="new-court-formats-label" className={FIELD_LABEL_CLASS_NAME}>
            Formats it supports
          </span>
          <div
            role="group"
            aria-labelledby="new-court-formats-label"
            className="flex gap-1.5"
          >
            {COURT_FORMATS.map((format) => {
              const isSelected = supportedFormats.includes(format);
              return (
                <button
                  key={format}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => toggleFormat(format)}
                  className={
                    isSelected
                      ? SELECTED_OPTION_BUTTON_CLASS_NAME
                      : UNSELECTED_OPTION_BUTTON_CLASS_NAME
                  }
                >
                  {SUPPORTED_FORMAT_LABELS[format]}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div aria-live="polite">
        {errorMessage && <AttentionMessage>{errorMessage}</AttentionMessage>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={isPending}
          className={SECONDARY_BUTTON_CLASS_NAME}
        >
          {isPending ? "Adding…" : "Add court"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={OUTLINE_BUTTON_CLASS_NAME}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
