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
  ].map(([name, calledCourtId], index) => ({
    participantId: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: name!,
    skill: "intermediate",
    gender: "female",
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
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Change players" }));
  for (const picker of screen.getAllByRole("combobox")) {
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
