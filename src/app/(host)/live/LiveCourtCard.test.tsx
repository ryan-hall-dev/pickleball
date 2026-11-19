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
  fireEvent.click(
    screen.getByRole("button", { name: /^Team A · Player 2: choose player/ }),
  );
  const choices = within(screen.getByRole("list"));
  expect(choices.getByRole("button", { name: /Male player/ })).toBeVisible();
  // Called to another court, or no gender (never valid): not offered.
  expect(choices.queryByRole("button", { name: /Other call/ })).toBeNull();
  expect(choices.queryByRole("button", { name: /Available/ })).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
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

function pickerFixture(
  genders: Array<"male" | "female">,
  waitsInMinutes: number[],
) {
  const players: LivePlayer[] = genders.map((gender, index) => ({
    participantId: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `${gender === "male" ? "Man" : "Woman"} ${index + 1}`,
    skill: "intermediate",
    gender,
    status: "waiting",
    currentWaitMs: waitsInMinutes[index] * 60_000,
    returnsAt: null,
    skipSeq: null,
    calledCourtId: null,
    calledCourtName: null,
  }));
  const court: LiveCourt = {
    courtId: "c0000000-0000-4000-8000-000000000001",
    name: "Court 1",
    activeMatch: null,
    called: null,
    suggestion: {
      reason: "",
      teamA: [players[0].participantId, players[1].participantId],
      teamB: [players[2].participantId, players[3].participantId],
    },
  };
  const onAction = vi.fn();
  render(
    <LiveCourtCard
      court={court}
      players={players}
      now={0}
      timeIsUp={false}
      disabled={false}
      selected={false}
      onPrepare={vi.fn()}
      onAction={onAction}
      undoOptions={[]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Change players" }));
  return { players, onAction };
}

it("offers only valid, longest-waiting replacements, with search and a fold", () => {
  // Group: Man 1, Man 2 vs Man 3, Man 4. Bench: 7 women and 1 man.
  const { players, onAction } = pickerFixture(
    [
      "male",
      "male",
      "male",
      "male",
      "female",
      "female",
      "female",
      "female",
      "female",
      "female",
      "female",
      "male",
    ],
    [9, 9, 9, 9, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  fireEvent.click(
    screen.getByRole("button", { name: /^Team A · Player 1: Man 1/ }),
  );
  const list = () => within(screen.getByRole("list"));
  // A woman would break an all-male group: only the benched man is valid.
  expect(list().getAllByRole("button")).toHaveLength(1);
  expect(list().getByRole("button", { name: /Man 12/ })).toBeVisible();
  fireEvent.click(list().getByRole("button", { name: /Man 12/ }));
  expect(
    screen.getByRole("button", { name: /^Team A · Player 1: Man 12/ }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Call chosen four" }));
  expect(onAction).toHaveBeenCalledWith({
    kind: "call",
    courtId: "c0000000-0000-4000-8000-000000000001",
    teamA: [players[11].participantId, players[1].participantId],
    teamB: [players[2].participantId, players[3].participantId],
  });
});

it("orders by wait, folds past five, and filters by name", () => {
  // Group: two women vs two women; bench of 8 more women with distinct waits.
  const {} = pickerFixture(
    [
      "female",
      "female",
      "female",
      "female",
      "female",
      "female",
      "female",
      "female",
      "female",
      "female",
      "female",
      "female",
    ],
    [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  fireEvent.click(
    screen.getByRole("button", { name: /^Team B · Player 2: Woman 4/ }),
  );
  const list = () => within(screen.getByRole("list"));
  const rows = list().getAllByRole("button");
  expect(rows).toHaveLength(5);
  expect(rows[0]).toHaveTextContent("Woman 12");
  expect(rows[0]).toHaveTextContent("8 min");
  fireEvent.click(screen.getByRole("button", { name: "Show all 8 players" }));
  expect(list().getAllByRole("button")).toHaveLength(8);
  fireEvent.change(screen.getByLabelText("Search players"), {
    target: { value: "woman 6" },
  });
  expect(list().getAllByRole("button")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Search players"), {
    target: { value: "zzz" },
  });
  expect(screen.getByText(/No one by that name/)).toBeVisible();
});
