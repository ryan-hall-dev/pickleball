import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RotationPreferences } from "@/engine";
import { recommendedRotationPreferences } from "@/server/setup/setupRules";
import { RotationCard } from "./RotationCard";

/** The card with its state held like the editor holds it. */
function RotationCardHarness({
  onChange,
}: {
  onChange: (rotation: RotationPreferences) => void;
}) {
  const [rotation, setRotation] = useState(recommendedRotationPreferences());
  return (
    <RotationCard
      rotation={rotation}
      onChange={(nextRotation) => {
        setRotation(nextRotation);
        onChange(nextRotation);
      }}
    />
  );
}

function renderCard() {
  const onChange = vi.fn<(rotation: RotationPreferences) => void>();
  render(<RotationCardHarness onChange={onChange} />);
  return { onChange };
}

function priorityLabels(): string[] {
  const list = screen.getByRole("list", { name: "What matters most" });
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".font-semibold")!.textContent ?? "");
}

describe("RotationCard", () => {
  afterEach(cleanup);

  it("lists all six priorities in the recommended order with plain-language hints", () => {
    renderCard();
    expect(priorityLabels()).toEqual([
      "1. Equal games for everyone",
      "2. Shortest waits",
      "3. Playing time",
      "4. Full courts",
      "5. No back-to-back games",
      "6. Mix up partners",
    ]);
    expect(
      screen.getByText(
        "Drag or use the arrows. Higher on the list counts for more; nothing is ignored.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Court minutes stay fair, even when some games run long",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("DEFAULT")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Move Equal games for everyone up" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Move Mix up partners down" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reset to recommended" }),
    ).toBeDisabled();
  });

  it("moves a priority with the buttons and keeps focus on the moved row", () => {
    const { onChange } = renderCard();
    const moveShortestWaitsUp = screen.getByRole("button", {
      name: "Move Shortest waits up",
    });
    moveShortestWaitsUp.focus();
    fireEvent.click(moveShortestWaitsUp);
    expect(priorityLabels().slice(0, 2)).toEqual([
      "1. Shortest waits",
      "2. Equal games for everyone",
    ]);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        objectiveOrder: [
          "shortestWaits",
          "equalGames",
          "playingTime",
          "fullCourts",
          "noBackToBack",
          "mixPartners",
        ],
      }),
    );
    // Now first: its up button is disabled, so its down button has focus.
    expect(moveShortestWaitsUp).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Move Shortest waits down" }),
    ).toHaveFocus();
    // The badge only marks the recommended first priority.
    expect(screen.queryByText("DEFAULT")).not.toBeInTheDocument();
    expect(
      screen.getByText("Shortest waits moved to position 1 of 6."),
    ).toBeInTheDocument();

    const movePlayingTimeDown = screen.getByRole("button", {
      name: "Move Playing time down",
    });
    movePlayingTimeDown.focus();
    fireEvent.click(movePlayingTimeDown);
    expect(priorityLabels()[3]).toBe("4. Playing time");
    expect(movePlayingTimeDown).toHaveFocus();
  });

  it("gives each drag handle the keyboard instructions (the drag itself is e2e: jsdom has no layout)", () => {
    renderCard();
    const handle = screen.getByRole("button", {
      name: "Drag to reorder Full courts",
    });
    expect(handle).toHaveAttribute("aria-roledescription", "sortable");
    expect(handle).toHaveAccessibleDescription(
      /press Space or Enter to pick up a priority, use the up and down arrow keys to move it/,
    );
  });

  it("flips rule switches, labelled by their row titles", () => {
    const { onChange } = renderCard();
    const manualSwitch = screen.getByRole("switch", {
      name: "Allow manual assignments",
    });
    expect(manualSwitch).toHaveAttribute("aria-checked", "true");
    expect(manualSwitch).toHaveAccessibleDescription(
      "You can lock or swap players on the live screen. Suggestions stay fair for everyone else.",
    );
    fireEvent.click(manualSwitch);
    expect(manualSwitch).toHaveAttribute("aria-checked", "false");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rules: expect.objectContaining({ allowManualAssignments: false }),
      }),
    );
    expect(screen.getAllByRole("switch")).toHaveLength(6);
    // Each hint says what switching the rule off does.
    expect(
      screen.getByRole("switch", { name: "Rotate partners" }),
    ).toHaveAccessibleDescription("Off: the same pairs can repeat");
    expect(
      screen.getByText(
        /Each rule you switch off stops counting towards who plays next; the priorities above set how much the rest count\. Manual assignments only controls what you can do on the live screen\./,
      ),
    ).toBeInTheDocument();
    for (const name of [
      "Avoid back-to-back games",
      "Favour players with fewer games",
      "Favour longer waits",
      "Rotate partners",
      "Rotate opponents",
    ]) {
      expect(screen.getByRole("switch", { name })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    }
  });

  it("resets to the recommended rotation", () => {
    const { onChange } = renderCard();
    fireEvent.click(
      screen.getByRole("button", { name: "Move Mix up partners up" }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Rotate opponents" }));
    const reset = screen.getByRole("button", { name: "Reset to recommended" });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(onChange).toHaveBeenLastCalledWith(recommendedRotationPreferences());
    expect(priorityLabels()[5]).toBe("6. Mix up partners");
    expect(
      screen.getByRole("switch", { name: "Rotate opponents" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(reset).toBeDisabled();
  });
});
