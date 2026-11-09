"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ICON_BUTTON_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import type {
  RotationObjective,
  RotationPreferences,
  RotationRules,
} from "@/engine";
import { recommendedRotationPreferences } from "@/server/setup/setupRules";
import {
  isRecommendedRotation,
  moveObjective,
  ROTATION_OBJECTIVE_COPY,
  ROTATION_RULE_COPY,
} from "./rotationOptions";
import { SetupSection } from "./SetupSection";

type MoveDirection = "up" | "down";

const RECOMMENDED_TOP_OBJECTIVE =
  recommendedRotationPreferences().objectiveOrder[0];

function objectiveLabel(objective: UniqueIdentifier): string {
  return ROTATION_OBJECTIVE_COPY[objective as RotationObjective].label;
}

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "To reorder, press Space or Enter to pick up a priority, use the up and down arrow keys to move it, then press Space or Enter to drop it, or Escape to cancel. The Move up and Move down buttons do the same.",
};

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Card 4: what matters most (ranked objectives) and the rule switches. */
export function RotationCard({
  rotation,
  onChange,
}: {
  rotation: RotationPreferences;
  onChange: (rotation: RotationPreferences) => void;
}) {
  const { objectiveOrder, rules } = rotation;
  const objectiveCount = objectiveOrder.length;
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const moveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  /** The button to keep focus on after its row moves (focused after the re-render). */
  const pendingFocusButtonKeyRef = useRef<string | null>(null);
  const registerMoveButton = useCallback(
    (buttonKey: string, element: HTMLButtonElement | null) => {
      if (element) moveButtonRefs.current.set(buttonKey, element);
      else moveButtonRefs.current.delete(buttonKey);
    },
    [],
  );

  // Runs after every render: the move re-renders the list with the new order.
  useEffect(() => {
    const buttonKey = pendingFocusButtonKeyRef.current;
    if (!buttonKey) return;
    pendingFocusButtonKeyRef.current = null;
    moveButtonRefs.current.get(buttonKey)?.focus();
  });

  function positionText(objective: UniqueIdentifier, order = objectiveOrder) {
    return `position ${order.indexOf(objective as RotationObjective) + 1} of ${objectiveCount}`;
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${objectiveLabel(active.id)}, in ${positionText(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${objectiveLabel(active.id)} is over ${positionText(over.id)}.`
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `${objectiveLabel(active.id)} dropped in ${positionText(over.id)}.`
        : `${objectiveLabel(active.id)} dropped where it was.`,
    onDragCancel: ({ active }) =>
      `Reordering cancelled. ${objectiveLabel(active.id)} stays in ${positionText(active.id)}.`,
  };

  function changeOrder(nextOrder: RotationObjective[]) {
    onChange({ ...rotation, objectiveOrder: nextOrder });
  }

  function moveByButton(index: number, direction: MoveDirection) {
    const toIndex = direction === "up" ? index - 1 : index + 1;
    const objective = objectiveOrder[index];
    const nextOrder = moveObjective(objectiveOrder, index, toIndex);
    changeOrder(nextOrder);
    // Stay on the same button; at either end that button is disabled, so
    // the row's other one takes focus.
    const isAtEnd =
      (direction === "up" && toIndex === 0) ||
      (direction === "down" && toIndex === objectiveCount - 1);
    const focusDirection: MoveDirection = isAtEnd
      ? direction === "up"
        ? "down"
        : "up"
      : direction;
    pendingFocusButtonKeyRef.current = `${objective}-${focusDirection}`;
    setMoveAnnouncement(
      `${objectiveLabel(objective)} moved to ${positionText(objective, nextOrder)}.`,
    );
  }

  function finishDrag({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    changeOrder(
      moveObjective(
        objectiveOrder,
        objectiveOrder.indexOf(active.id as RotationObjective),
        objectiveOrder.indexOf(over.id as RotationObjective),
      ),
    );
  }

  function setRule(ruleKey: keyof RotationRules, isOn: boolean) {
    onChange({ ...rotation, rules: { ...rules, [ruleKey]: isOn } });
  }

  return (
    <SetupSection
      stepNumber={4}
      headingId="rotation-heading"
      heading="Rotation"
      actions={
        <button
          type="button"
          disabled={isRecommendedRotation(rotation)}
          onClick={() => {
            onChange(recommendedRotationPreferences());
            setMoveAnnouncement("Rotation reset to the recommended settings.");
          }}
          className={OUTLINE_BUTTON_CLASS_NAME}
        >
          Reset to recommended
        </button>
      }
    >
      <div className="flex flex-wrap gap-[18px]">
        <div className="min-w-0 flex-[1_1_300px]">
          <h3
            id="rotation-priorities-heading"
            className="text-[15px] font-bold"
          >
            What matters most
          </h3>
          <p
            id="rotation-priorities-hint"
            className="mt-1 mb-2.5 text-[13px] text-muted"
          >
            Drag or use the arrows. Higher on the list counts for more; nothing
            is ignored.
          </p>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            accessibility={{
              // Its live region is a role="status"; outside <main> it can't
              // be mistaken for the autosave status. (The editor only
              // renders in the browser, so document exists.)
              container: document.body,
              announcements,
              screenReaderInstructions: SCREEN_READER_INSTRUCTIONS,
            }}
            onDragEnd={finishDrag}
          >
            <SortableContext
              items={objectiveOrder}
              strategy={verticalListSortingStrategy}
            >
              <ol
                aria-labelledby="rotation-priorities-heading"
                aria-describedby="rotation-priorities-hint"
                className="flex flex-col gap-2"
              >
                {objectiveOrder.map((objective, index) => (
                  <PriorityRow
                    key={objective}
                    objective={objective}
                    rank={index + 1}
                    objectiveCount={objectiveCount}
                    registerMoveButton={registerMoveButton}
                    onMove={(direction) => moveByButton(index, direction)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          <p aria-live="polite" className="sr-only">
            {moveAnnouncement}
          </p>
        </div>

        <div className="min-w-0 flex-[1_1_300px]">
          <h3 id="rotation-rules-heading" className="text-[15px] font-bold">
            Rules
          </h3>
          <p className="mt-1 mb-2.5 text-[13px] text-muted">
            Recommended settings are on. Each rule you switch off stops counting
            towards who plays next; the priorities above set how much the rest
            count. Manual assignments only controls what you can do on the live
            screen.
          </p>
          <ul
            aria-labelledby="rotation-rules-heading"
            className="flex flex-col"
          >
            {ROTATION_RULE_COPY.map(({ ruleKey, label, hint }) => (
              <li
                key={ruleKey}
                className="flex items-center gap-3 border-b border-card-border py-2.5"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    id={`rotation-rule-${ruleKey}`}
                    className="text-[15px] font-semibold"
                  >
                    {label}
                  </span>
                  <span
                    id={`rotation-rule-${ruleKey}-hint`}
                    className="text-xs text-muted"
                  >
                    {hint}
                  </span>
                </span>
                <RuleSwitch
                  isOn={rules[ruleKey]}
                  labelId={`rotation-rule-${ruleKey}`}
                  hintId={`rotation-rule-${ruleKey}-hint`}
                  onChange={(isOn) => setRule(ruleKey, isOn)}
                />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </SetupSection>
  );
}

function PriorityRow({
  objective,
  rank,
  objectiveCount,
  registerMoveButton,
  onMove,
}: {
  objective: RotationObjective;
  rank: number;
  objectiveCount: number;
  registerMoveButton: (
    buttonKey: string,
    element: HTMLButtonElement | null,
  ) => void;
  onMove: (direction: MoveDirection) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: objective,
    transition: prefersReducedMotion() ? null : undefined,
  });
  const { label, hint } = ROTATION_OBJECTIVE_COPY[objective];
  const isTop = rank === 1;
  const moveButtons: { direction: MoveDirection; isDisabled: boolean }[] = [
    { direction: "up", isDisabled: rank === 1 },
    { direction: "down", isDisabled: rank === objectiveCount },
  ];

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex items-center gap-2.5 rounded-[14px] border py-2.5 pr-2 pl-1 ${
        isTop
          ? "border-lime-edge bg-lime-surface"
          : "border-inner-border bg-inner"
      } ${isDragging ? "relative z-10" : ""}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder ${label}`}
        className="flex h-11 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-drag-handle active:cursor-grabbing pointer-coarse:w-11"
      >
        <svg aria-hidden="true" width="12" height="20" viewBox="0 0 12 20">
          {[4, 10, 16].flatMap((centreY) =>
            [3, 9].map((centreX) => (
              <circle
                key={`${centreX}-${centreY}`}
                cx={centreX}
                cy={centreY}
                r="1.5"
                fill="currentColor"
              />
            )),
          )}
        </svg>
      </button>
      <span
        aria-hidden="true"
        className={`flex size-7 shrink-0 items-center justify-center rounded-[9px] font-extrabold tabular-nums ${
          isTop ? "bg-lime text-on-lime" : "bg-inner-border text-text"
        }`}
      >
        {rank}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-semibold">
          <span className="sr-only">{rank}. </span>
          {label}
        </span>
        <span className="text-xs text-muted">{hint}</span>
      </span>
      {isTop && objective === RECOMMENDED_TOP_OBJECTIVE && (
        <span className="shrink-0 rounded-full bg-lime px-2 py-[3px] text-[11px] font-bold text-on-lime">
          DEFAULT
        </span>
      )}
      {moveButtons.map(({ direction, isDisabled }) => (
        <button
          key={direction}
          type="button"
          ref={(element) =>
            registerMoveButton(`${objective}-${direction}`, element)
          }
          aria-label={`Move ${label} ${direction}`}
          disabled={isDisabled}
          onClick={() => onMove(direction)}
          className={ICON_BUTTON_CLASS_NAME}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={direction === "up" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
          </svg>
        </button>
      ))}
    </li>
  );
}

/** DESIGN.md toggle: 52x30 track, 24px white knob; lime and right when on. */
function RuleSwitch({
  isOn,
  labelId,
  hintId,
  onChange,
}: {
  isOn: boolean;
  labelId: string;
  hintId: string;
  onChange: (isOn: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      aria-labelledby={labelId}
      aria-describedby={hintId}
      onClick={() => onChange(!isOn)}
      // The track is 30px high; the invisible margin makes the target 44px.
      className={`relative flex h-[30px] w-[52px] shrink-0 rounded-full p-[3px] after:absolute after:-inset-[7px] after:content-[''] ${
        isOn ? "justify-end bg-lime" : "justify-start bg-outline"
      }`}
    >
      <span className="block size-6 rounded-full bg-white" />
    </button>
  );
}
