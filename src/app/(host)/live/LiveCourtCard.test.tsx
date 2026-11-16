import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveCourt, LivePlayer } from "@/server/live/liveTypes";
import { LiveCourtCard } from "./LiveCourtCard";

afterEach(cleanup);

it("uses court UUIDs to exclude another called group's players even when labels match", () => {
  const ownCourtId = "c0000000-0000-4000-8000-000000000001";
  const otherCourtId = "c0000000-0000-4000-8000-000000000002";
  const players: (LivePlayer & { calledCourtId: string | null })[] = [
    ["Own call", ownCourtId],
    ["Other call", otherCourtId],
    ["Available", null],
    ["Male player", null],
  ].map(([name, calledCourtId], index) => ({
    participantId: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: name!,
    skill: "intermediate",
    gender:
      name === "Male player" ? "male" : name === "Available" ? null : "female",
    status: "waiting",
    currentWaitMs: 0,
    returnsAt: null,
    skipSeq: null,
    calledCourtId,
    calledCourtName: calledCourtId ? "Same label" : null,
  }));
  const court: LiveCourt = {
    courtId: ownCourtId,
    name: "Same label",
    activeMatch: null,
    suggestion: null,
    called: {
      calledEventId: "e0000000-0000-4000-8000-000000000001",
      teamA: [players[0].participantId, null],
      teamB: [null, null],
    },
  };
  render(
    <LiveCourtCard
      court={court}
      players={players}
      now={0}
      timeIsUp={false}
      disabled={false}
      selected={false}
      onPrepare={vi.fn()}
      onAction={vi.fn()}
      undoOptions={[]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Change players" }));
  const vacancyMessage = screen
    .getByText(/A called player is unavailable/)
    .closest("p")!;
  expect(within(vacancyMessage).getByText("!")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  for (const picker of screen.getAllByRole("combobox")) {
    expect(
      within(picker).getByRole("option", { name: /Own call · Female/ }),
    ).toBeInTheDocument();
    expect(
      within(picker).getByRole("option", { name: /Male player · Male/ }),
    ).toBeInTheDocument();
    expect(
      within(picker).getByRole("option", {
        name: /Available · Gender missing/,
      }),
    ).toBeInTheDocument();
    expect(picker).not.toHaveTextContent("null");
    expect(
      within(picker).getByRole("option", { name: /Own call/ }),
    ).toBeInTheDocument();
    expect(
      within(picker).getByRole("option", { name: /Available/ }),
    ).toBeInTheDocument();
    expect(
      within(picker).queryByRole("option", { name: /Other call/ }),
    ).toBeNull();
  }
});

it("closes a recovery confirmation when a co-host changes the active match", () => {
  const onAction = vi.fn();
  const players: LivePlayer[] = Array.from({ length: 4 }, (_, index) => ({
    participantId: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `Player ${index + 1}`,
    skill: "intermediate",
    gender: "male",
    status: "playing",
    currentWaitMs: null,
    returnsAt: null,
    skipSeq: null,
    calledCourtId: null,
    calledCourtName: null,
  }));
  const court: LiveCourt = {
    courtId: "c0000000-0000-4000-8000-000000000001",
    name: "Court 1",
    called: null,
    suggestion: null,
    activeMatch: {
      matchId: "d0000000-0000-4000-8000-000000000001",
      startedAt: 0,
      teamA: players.slice(0, 2).map((player) => player.participantId),
      teamB: players.slice(2).map((player) => player.participantId),
    },
  };
  const props = {
    players,
    now: 0,
    timeIsUp: false,
    disabled: false,
    selected: false,
    onPrepare: vi.fn(),
    onAction,
    undoOptions: [],
  };
  const { rerender } = render(<LiveCourtCard {...props} court={court} />);
  fireEvent.click(screen.getByText("Court options"));
  fireEvent.click(screen.getByRole("button", { name: "End as interrupted" }));
  expect(
    screen.getByRole("group", { name: "Confirm interrupted game" }),
  ).toBeInTheDocument();
  rerender(
    <LiveCourtCard
      {...props}
      court={{
        ...court,
        activeMatch: {
          ...court.activeMatch!,
          matchId: "d0000000-0000-4000-8000-000000000002",
        },
      }}
    />,
  );
  expect(
    screen.queryByRole("group", { name: "Confirm interrupted game" }),
  ).toBeNull();
  expect(onAction).not.toHaveBeenCalled();
});
