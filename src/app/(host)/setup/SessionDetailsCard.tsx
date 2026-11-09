"use client";

import { useRef, type HTMLInputTypeAttribute, type Ref } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  SELECTED_OPTION_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
  UNSELECTED_OPTION_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import {
  CHANGEOVER_MINUTES_RANGE,
  LOCATION_MAX_LENGTH,
  SHORT_LABEL_MAX_LENGTH,
  TARGET_MATCH_MINUTES_RANGE,
} from "@/server/setup/setupRules";
import {
  addMinutesToTimeValue,
  DURATION_PRESET_MINUTES,
  type SetupForm,
  type SetupFormErrors,
  type SetupFormField,
} from "./setupPlanning";
import { SetupSection } from "./SetupSection";

const CUSTOM_OPTION_CLASS_NAME =
  "inline-flex h-11 items-center justify-center rounded-xl border border-dashed border-outline px-[18px] text-[15px] font-semibold text-muted hover:text-text";

/** Card 1: name, date, start/end, duration chips, location, host, match timing. */
export function SessionDetailsCard({
  form,
  fieldErrors,
  durationMinutes,
  isEndNextDay,
  onChange,
}: {
  form: SetupForm;
  fieldErrors: SetupFormErrors;
  durationMinutes: number | null;
  /** The end time is on the next day (an overnight session). */
  isEndNextDay: boolean;
  onChange: (patch: Partial<SetupForm>) => void;
}) {
  const endTimeInputRef = useRef<HTMLInputElement>(null);
  const hasValidDuration =
    durationMinutes !== null && durationMinutes > 0 && !fieldErrors.endTime;
  const isCustomDuration =
    hasValidDuration &&
    !(DURATION_PRESET_MINUTES as readonly number[]).includes(durationMinutes);

  function changeStartTime(startTime: string) {
    // Moving the start keeps the chosen length: the end moves with it.
    onChange(
      hasValidDuration
        ? {
            startTime,
            endTime: addMinutesToTimeValue(startTime, durationMinutes),
          }
        : { startTime },
    );
  }

  return (
    <SetupSection
      stepNumber={1}
      headingId="session-details-heading"
      heading="Session details"
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
        <div className="col-span-full">
          <SetupTextField
            id="session-name"
            field="name"
            label="Session name"
            value={form.name}
            maxLength={SHORT_LABEL_MAX_LENGTH}
            error={fieldErrors.name}
            onValueChange={(name) => onChange({ name })}
            inputClassName="font-semibold"
          />
        </div>
        <SetupTextField
          id="session-date"
          field="date"
          label="Date"
          type="date"
          value={form.date}
          error={fieldErrors.date}
          onValueChange={(date) => onChange({ date })}
        />
        <SetupTextField
          id="session-start-time"
          field="startTime"
          label="Start time"
          type="time"
          value={form.startTime}
          error={fieldErrors.startTime}
          onValueChange={changeStartTime}
          inputClassName="tabular-nums"
        />
        <SetupTextField
          id="session-end-time"
          field="endTime"
          label="End time"
          type="time"
          value={form.endTime}
          error={fieldErrors.endTime}
          onValueChange={(endTime) => onChange({ endTime })}
          inputClassName="tabular-nums"
          inputRef={endTimeInputRef}
          hint={isEndNextDay ? "(next day)" : undefined}
        />

        <div className="col-span-full flex flex-col gap-1.5">
          <span id="session-duration-label" className={FIELD_LABEL_CLASS_NAME}>
            Duration
            {hasValidDuration && (
              <span className="font-semibold text-lime tabular-nums">
                {" "}
                · {durationMinutes} minutes, calculated from start and end
              </span>
            )}
          </span>
          <div
            role="group"
            aria-labelledby="session-duration-label"
            className="flex flex-wrap gap-2"
          >
            {DURATION_PRESET_MINUTES.map((presetMinutes) => {
              const isSelected =
                hasValidDuration && durationMinutes === presetMinutes;
              return (
                <button
                  key={presetMinutes}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() =>
                    onChange({
                      endTime: addMinutesToTimeValue(
                        form.startTime,
                        presetMinutes,
                      ),
                    })
                  }
                  className={`${
                    isSelected
                      ? SELECTED_OPTION_BUTTON_CLASS_NAME
                      : UNSELECTED_OPTION_BUTTON_CLASS_NAME
                  } tabular-nums`}
                >
                  {presetMinutes} min
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={isCustomDuration}
              // A custom length is set by typing the end time.
              onClick={() => endTimeInputRef.current?.focus()}
              className={
                isCustomDuration
                  ? SELECTED_OPTION_BUTTON_CLASS_NAME
                  : CUSTOM_OPTION_CLASS_NAME
              }
            >
              {isCustomDuration ? `Custom · ${durationMinutes} min` : "Custom…"}
            </button>
          </div>
        </div>

        <SetupTextField
          id="session-location"
          field="location"
          label="Location (optional)"
          value={form.location}
          maxLength={LOCATION_MAX_LENGTH}
          error={fieldErrors.location}
          onValueChange={(location) => onChange({ location })}
        />
        <SetupTextField
          id="session-host-name"
          field="hostName"
          label="Host"
          value={form.hostName}
          maxLength={SHORT_LABEL_MAX_LENGTH}
          error={fieldErrors.hostName}
          onValueChange={(hostName) => onChange({ hostName })}
        />
        <SetupTextField
          id="session-target-match-minutes"
          field="targetMatchMinutes"
          label="Match length (min)"
          type="number"
          inputMode="numeric"
          min={TARGET_MATCH_MINUTES_RANGE.min}
          max={TARGET_MATCH_MINUTES_RANGE.max}
          value={form.targetMatchMinutes}
          error={fieldErrors.targetMatchMinutes}
          onValueChange={(targetMatchMinutes) =>
            onChange({ targetMatchMinutes })
          }
          inputClassName="tabular-nums"
        />
        <SetupTextField
          id="session-changeover-minutes"
          field="changeoverMinutes"
          label="Changeover (min)"
          type="number"
          inputMode="numeric"
          min={CHANGEOVER_MINUTES_RANGE.min}
          max={CHANGEOVER_MINUTES_RANGE.max}
          value={form.changeoverMinutes}
          error={fieldErrors.changeoverMinutes}
          onValueChange={(changeoverMinutes) => onChange({ changeoverMinutes })}
          inputClassName="tabular-nums"
        />
      </div>
    </SetupSection>
  );
}

function SetupTextField({
  id,
  field,
  label,
  value,
  error,
  onValueChange,
  type = "text",
  inputMode,
  min,
  max,
  maxLength,
  inputClassName = "",
  inputRef,
  hint,
}: {
  id: string;
  field: SetupFormField;
  label: string;
  value: string;
  error: string | undefined;
  onValueChange: (value: string) => void;
  type?: HTMLInputTypeAttribute;
  inputMode?: "numeric";
  min?: number;
  max?: number;
  maxLength?: number;
  inputClassName?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Short note beside the label, e.g. "(next day)"; also read with the input. */
  hint?: string;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy =
    [hint && hintId, error && errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-1.5">
        <label htmlFor={id} className={FIELD_LABEL_CLASS_NAME}>
          {label}
        </label>
        {hint && (
          <span id={hintId} className="text-[13px] font-semibold text-link">
            {hint}
          </span>
        )}
      </div>
      <input
        ref={inputRef}
        id={id}
        name={field}
        type={type}
        inputMode={inputMode}
        min={min}
        max={max}
        maxLength={maxLength}
        // A host types session and other people's names: never autofill their own.
        autoComplete="off"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${TEXT_INPUT_CLASS_NAME} ${inputClassName}`}
      />
      {error && <AttentionMessage id={errorId}>{error}</AttentionMessage>}
    </div>
  );
}
