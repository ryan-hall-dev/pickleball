import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenCheckinPage } from "@/server/checkin/checkinResults";
import { LiveSessionCard } from "./LiveSessionCard";

afterEach(cleanup);

const page: OpenCheckinPage = {
  status: "open",
  socialName: "Social",
  currentRequest: null,
  now: "2026-11-15T15:00:00Z",
  session: {
    sessionId: "a0000000-0000-4000-8000-000000000001",
    name: "Sunday social",
    status: "draft",
    durationMinutes: 75,
    startedAt: null,
    endsAt: null,
    plannedStart: "2026-11-14T10:00:00Z",
    plannedEnd: "2026-11-14T11:15:00Z",
    courtsCount: 2,
    checkedInCount: 8,
  },
};
describe("LiveSessionCard", () => {
  it("shows an unstarted session's duration even after old draft placeholders pass", () => {
    render(<LiveSessionCard page={page} />);
    expect(screen.getByText("Session not started")).toBeInTheDocument();
    expect(screen.getByText("75 min session")).toBeInTheDocument();
    expect(screen.queryByText("Live now")).not.toBeInTheDocument();
    expect(screen.queryByText("to first game")).not.toBeInTheDocument();
  });
  it("shows unavailable timing, never an invented number, when the duration is null", () => {
    render(
      <LiveSessionCard
        page={{ ...page, session: { ...page.session, durationMinutes: null } }}
      />,
    );
    expect(screen.getByText("Session not started")).toBeInTheDocument();
    expect(screen.getByText("Duration unavailable")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/null|NaN|min session/)).not.toBeInTheDocument();
  });
  it("shows a live session and honest time-up state", () => {
    render(
      <LiveSessionCard
        page={{
          ...page,
          session: {
            ...page.session,
            status: "live",
            startedAt: "2026-11-15T13:00:00Z",
            endsAt: "2026-11-15T14:15:00Z",
          },
        }}
      />,
    );
    expect(screen.getByText("Live now")).toBeInTheDocument();
    expect(screen.getByText(/Session time is up/)).toBeInTheDocument();
    expect(screen.queryByText("Session not started")).not.toBeInTheDocument();
    expect(screen.queryByText("to first game")).not.toBeInTheDocument();
  });
});
