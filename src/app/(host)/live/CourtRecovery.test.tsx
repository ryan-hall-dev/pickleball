import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderWithLocale as render } from "@/i18n/testing";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveCourt, LivePlayer } from "@/server/live/liveTypes";
import { CourtRecovery } from "./CourtRecovery";

afterEach(cleanup);
const courtId = "c0000000-0000-4000-8000-000000000001";
const matchId = "a0000000-0000-4000-8000-000000000001";
function player(
  index: number,
  overrides: Partial<LivePlayer> = {},
): LivePlayer {
  return {
    participantId: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Player ${index}`,
    skill: "intermediate",
    gender: "male",
    status: index <= 4 ? "playing" : "waiting",
    currentWaitMs: 0,
    returnsAt: null,
    skipSeq: null,
    calledCourtId: null,
    calledCourtName: null,
    ...overrides,
  };
}
const lineup = [1, 2, 3, 4].map((index) => player(index));
const activeCourt: LiveCourt = {
  courtId,
  name: "Court 1",
  called: null,
  suggestion: null,
  activeMatch: {
    matchId,
    startedAt: 0,
    teamA: lineup.slice(0, 2).map((p) => p.participantId),
    teamB: lineup.slice(2).map((p) => p.participantId),
  },
};

it("offers only available, unreserved same-seat replacements and submits explicit confirmation", () => {
  const onAction = vi.fn();
  const eligible = player(5);
  render(
    <CourtRecovery
      court={activeCourt}
      players={[
        ...lineup,
        eligible,
        player(6, { gender: "female" }),
        player(7, { calledCourtId: courtId }),
        player(8, { status: "skipped" }),
      ]}
      undoOptions={[]}
      disabled={false}
      onAction={onAction}
    />,
  );
  fireEvent.click(screen.getByText("Court options"));
  fireEvent.click(screen.getByRole("button", { name: /^Replace\ player$/ }));
  const incoming = screen.getByLabelText("Replacement player");
  expect(within(incoming).getAllByRole("option")).toHaveLength(2);
  expect(
    within(incoming).getByRole("option", { name: eligible.name }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Confirm replacement" }),
  ).toBeDisabled();
  fireEvent.change(incoming, { target: { value: eligible.participantId } });
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
  expect(onAction).toHaveBeenCalledExactlyOnceWith({
    kind: "replace",
    matchId,
    outId: lineup[0].participantId,
    inId: eligible.participantId,
  });
});

it("explains no valid replacement and requires explicit interrupted-game confirmation without resting anyone", () => {
  const onAction = vi.fn();
  render(
    <CourtRecovery
      court={activeCourt}
      players={lineup}
      undoOptions={[]}
      disabled={false}
      onAction={onAction}
    />,
  );
  fireEvent.click(screen.getByText("Court options"));
  fireEvent.click(screen.getByRole("button", { name: /^Replace\ player$/ }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "No valid replacement is available",
  );
  expect(
    screen.getByRole("button", { name: "Confirm replacement" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: /^End\ as\ interrupted$/ }),
  );
  expect(onAction).not.toHaveBeenCalled();
  expect(
    screen.getByRole("group", { name: "Confirm interrupted game" }),
  ).toHaveTextContent("No completed game is counted");
  fireEvent.click(screen.getByRole("button", { name: "Keep playing" }));
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: /^End\ as\ interrupted$/ }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: /^Confirm\ interrupted\ game$/,
    }),
  );
  expect(onAction).toHaveBeenCalledExactlyOnceWith({
    kind: "interrupt",
    matchId,
  });
});

it("shows only projected safe undo choices and respects the shared write lock", () => {
  const onAction = vi.fn();
  const court = { ...activeCourt, activeMatch: null };
  const option = { courtId, matchId, targetSeq: 4, kind: "finish" as const };
  const { rerender } = render(
    <CourtRecovery
      court={court}
      players={lineup}
      undoOptions={[option]}
      disabled={true}
      onAction={onAction}
    />,
  );
  fireEvent.click(screen.getByText("Court options"));
  expect(
    screen.getByRole("button", { name: "Undo game finish" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: /^Replace\ player$/ }),
  ).toBeNull();
  rerender(
    <CourtRecovery
      court={court}
      players={lineup}
      undoOptions={[option]}
      disabled={false}
      onAction={onAction}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Undo game finish" }));
  expect(onAction).toHaveBeenCalledExactlyOnceWith({
    kind: "undo",
    targetSeq: 4,
  });
  rerender(
    <CourtRecovery
      court={court}
      players={lineup}
      undoOptions={[]}
      disabled={false}
      onAction={onAction}
    />,
  );
  expect(screen.queryByText("Court options")).toBeNull();
});

it("refuses a selected replacement who becomes reserved after another host acts", () => {
  const onAction = vi.fn();
  const incoming = player(5);
  const { rerender } = render(
    <CourtRecovery
      court={activeCourt}
      players={[...lineup, incoming]}
      undoOptions={[]}
      disabled={false}
      onAction={onAction}
    />,
  );
  fireEvent.click(screen.getByText("Court options"));
  fireEvent.click(screen.getByRole("button", { name: /^Replace\ player$/ }));
  fireEvent.change(screen.getByLabelText("Replacement player"), {
    target: { value: incoming.participantId },
  });
  rerender(
    <CourtRecovery
      court={activeCourt}
      players={[...lineup, { ...incoming, calledCourtId: courtId }]}
      undoOptions={[]}
      disabled={false}
      onAction={onAction}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Confirm replacement" }),
  ).toBeDisabled();
  fireEvent.submit(
    screen.getByRole("form", { name: "Replace player on Court 1" }),
  );
  expect(onAction).not.toHaveBeenCalled();
});
