import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithLocale as render } from "@/i18n/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { LivePlayer } from "@/server/live/liveTypes";
import { LiveWaiting } from "./LiveWaiting";

function makePlayers(
  count: number,
  status: LivePlayer["status"] = "waiting",
): LivePlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    participantId: `p${status}-${index}`,
    name: `${status} Person${index + 1}`,
    skill: "intermediate",
    gender: "female",
    status,
    currentWaitMs: (count - index) * 60_000,
    returnsAt: status === "skipped" ? 1_000_000 : null,
    skipSeq: status === "skipped" ? index + 1 : null,
    calledCourtId: null,
    calledCourtName: null,
  }));
}

function renderWaiting(players: LivePlayer[]) {
  const props = { now: 0, disabled: false, onAction: () => {} };
  const view = render(<LiveWaiting players={players} {...props} />);
  return {
    rerenderWith: (next: LivePlayer[]) =>
      view.rerender(<LiveWaiting players={next} {...props} />),
  };
}

describe("LiveWaiting folding", () => {
  afterEach(cleanup);

  it("shows the 3 longest waits and the full count, then opens all", () => {
    renderWaiting(makePlayers(12));
    expect(screen.getByText("(12)")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText(/1\. waiting Person1$/)).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Show all 12 waiting" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    expect(screen.getByText(/12\. waiting Person12$/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Show fewer waiting" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("stays open when the list refreshes", () => {
    const { rerenderWith } = renderWaiting(makePlayers(8));
    fireEvent.click(screen.getByRole("button", { name: "Show all 8 waiting" }));
    rerenderWith(makePlayers(9));
    expect(screen.getAllByRole("listitem")).toHaveLength(9);
  });

  it("has no fold button for 3 or fewer, and folds resting too", () => {
    renderWaiting(makePlayers(3));
    expect(
      screen.queryByRole("button", { name: /Show (all|fewer)/ }),
    ).toBeNull();
    cleanup();
    renderWaiting([...makePlayers(1), ...makePlayers(5, "skipped")]);
    expect(screen.getAllByRole("listitem")).toHaveLength(1 + 3);
    fireEvent.click(screen.getByRole("button", { name: "Show all 5 resting" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1 + 5);
  });
});
