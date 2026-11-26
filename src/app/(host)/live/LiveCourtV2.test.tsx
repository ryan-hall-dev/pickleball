import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderWithLocale as render } from "@/i18n/testing";
import type { LivePlayer, LiveSessionView } from "@/server/live/liveTypes";
import { CallOverList } from "./LiveCourtV2";

afterEach(cleanup);

const NOW = 10 * 60_000;
const player = (participantId: string, hasPhone: boolean) =>
  ({ participantId, name: participantId, hasPhone }) as LivePlayer;

function session(isPlaying: boolean, freeSince: number): LiveSessionView {
  return {
    players: [player("Kevin", true), player("Lan", false)],
    courts: [
      {
        courtId: "c1",
        name: "Court 1",
        activeMatch: isPlaying ? {} : null,
        freeSince,
        called: {
          teamA: ["Kevin", "Lan"],
          teamB: [null, null],
          confirmedIds: [],
          askedAt: { Kevin: 0, Lan: 0 },
        },
      },
    ],
  } as unknown as LiveSessionView;
}

it("prompts nobody while the court is still playing", () => {
  render(<CallOverList session={session(true, 0)} now={NOW} />);
  expect(screen.queryByText(/Call over/)).toBeNull();
  expect(screen.queryByText(/Kevin|Lan/)).toBeNull();
});

it("on a free court lists no-phone players at once, others after a minute", () => {
  render(<CallOverList session={session(false, NOW - 10_000)} now={NOW} />);
  expect(screen.getByText(/^Lan · .* · no phone$/)).toBeVisible();
  expect(screen.queryByText(/Kevin/)).toBeNull();
  cleanup();
  render(<CallOverList session={session(false, NOW - 90_000)} now={NOW} />);
  expect(screen.getByText(/^Kevin · .* · no reply 1 min$/)).toBeVisible();
});
