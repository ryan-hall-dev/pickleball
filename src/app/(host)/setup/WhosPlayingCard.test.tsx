import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveMemberChoice } from "@/server/members/memberDirectory";
import { MEMBER_DIRECTORY_PAGE_SIZE } from "@/server/members/memberSearch";
import {
  addDraftGuest,
  removeDraftGuest,
  setDraftMemberAttendance,
  type DraftAttendanceResult,
} from "@/server/setup/setupActions";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import { useState } from "react";
import { useDraftAttendance } from "./useDraftAttendance";
import { EMPTY_GUEST_FORM } from "./whosPlaying";
import { WhosPlayingCard } from "./WhosPlayingCard";

vi.mock("@/server/setup/setupActions", () => ({
  setDraftMemberAttendance: vi.fn(),
  addDraftGuest: vi.fn(),
  removeDraftGuest: vi.fn(),
}));

const setAttendanceMock = vi.mocked(setDraftMemberAttendance);
const addGuestMock = vi.mocked(addDraftGuest);
const removeGuestMock = vi.mocked(removeDraftGuest);

const SESSION_ID = "d0000000-0000-4000-8000-000000000001";

function member(
  index: number,
  firstName: string,
  lastName: string,
  skillLevel: ActiveMemberChoice["skillLevel"] = null,
): ActiveMemberChoice {
  return {
    id: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    firstName,
    lastName,
    skillLevel,
  };
}

const grace = member(1, "Grace", "Kim", "advanced");
const kofi = member(2, "Kofi", "Mensah", "beginner");
const zoe = member(3, "Zoe", "Park");

function attendee(entry: ActiveMemberChoice): DraftParticipant {
  return {
    participantId: `e-${entry.id}`,
    memberId: entry.id,
    isGuest: false,
    firstName: entry.firstName,
    lastName: entry.lastName,
    skillLevel: entry.skillLevel,
    isMemberActive: true,
  };
}

function guest(participantId: string, firstName: string): DraftParticipant {
  return {
    participantId,
    memberId: null,
    isGuest: true,
    firstName,
    lastName: "Guest",
    skillLevel: "intermediate",
    isMemberActive: null,
  };
}

/** The card with the real attendance hook, as the editor uses it. */
function CardHarness({
  activeMembers,
  participants,
}: {
  activeMembers: ActiveMemberChoice[];
  participants: DraftParticipant[];
}) {
  const attendance = useDraftAttendance(
    SESSION_ID,
    participants,
    activeMembers,
  );
  const [guestForm, setGuestForm] = useState(EMPTY_GUEST_FORM);
  return (
    <>
      <WhosPlayingCard
        activeMembers={activeMembers}
        attendance={attendance}
        guestForm={guestForm}
        onGuestFormChange={setGuestForm}
      />
      <p data-testid="player-count">{attendance.participants.length}</p>
    </>
  );
}

function renderCard(
  activeMembers: ActiveMemberChoice[],
  participants: DraftParticipant[] = [],
) {
  return render(
    <CardHarness activeMembers={activeMembers} participants={participants} />,
  );
}

function memberButton(name: string) {
  return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}

describe("WhosPlayingCard", () => {
  beforeEach(() => {
    setAttendanceMock.mockReset();
    addGuestMock.mockReset();
    removeGuestMock.mockReset();
  });

  afterEach(cleanup);

  it("points to the Members page when the club has no members, and still takes guests", () => {
    renderCard([]);
    expect(screen.getByText(/The club has no members yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a member" })).toHaveAttribute(
      "href",
      "/members/new",
    );
    expect(
      screen.queryByRole("button", { name: /Select all/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("First name")).toBeInTheDocument();
  });

  it("shows who is attending with aria-pressed and words, and counts members and guests", () => {
    renderCard([grace, kofi, zoe], [attendee(grace), guest("g-1", "Ben")]);
    expect(memberButton("Grace Kim")).toHaveAttribute("aria-pressed", "true");
    expect(memberButton("Grace Kim")).toHaveTextContent("Attending");
    expect(memberButton("Kofi Mensah")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(memberButton("Kofi Mensah")).toHaveTextContent("Not attending");
    const withText = (text: string) =>
      screen.getByText((_, element) => element?.textContent === text);
    // The design's four chips: registered, attending, not attending, guests.
    expect(withText("3 registered")).toHaveClass("bg-inner");
    expect(withText("1 attending")).toHaveClass("bg-lime-surface");
    expect(withText("2 not attending")).toHaveClass("bg-inner");
    expect(withText("+1 guest")).toHaveClass("bg-blue-surface");
  });

  it("toggles a member at once, writes it, and takes the server's list", async () => {
    setAttendanceMock.mockResolvedValue({
      ok: true,
      // The server also has Zoe, added in another tab.
      participants: [attendee(kofi), attendee(zoe)],
    });
    renderCard([grace, kofi, zoe]);
    fireEvent.click(memberButton("Kofi Mensah"));
    expect(memberButton("Kofi Mensah")).toHaveAttribute("aria-pressed", "true");
    expect(memberButton("Kofi Mensah")).toHaveTextContent("Saving…");
    expect(setAttendanceMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      memberIds: [kofi.id],
      attending: true,
    });
    await waitFor(() =>
      expect(memberButton("Zoe Park")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(memberButton("Kofi Mensah")).toHaveTextContent("Attending");
    expect(screen.getByTestId("player-count")).toHaveTextContent("2");
  });

  it("shows a failed change, undoes it on screen and retries it", async () => {
    setAttendanceMock.mockResolvedValueOnce({
      ok: false,
      message: "Something went wrong. Try again in a moment.",
    });
    renderCard([grace, kofi]);
    fireEvent.click(memberButton("Grace Kim"));
    expect(
      await screen.findByText(
        "Not saved: Adding Grace Kim. Something went wrong. Try again in a moment.",
      ),
    ).toBeInTheDocument();
    expect(memberButton("Grace Kim")).toHaveAttribute("aria-pressed", "false");

    setAttendanceMock.mockResolvedValueOnce({
      ok: true,
      participants: [attendee(grace)],
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(memberButton("Grace Kim")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.queryByText(/Not saved/)).not.toBeInTheDocument();
    expect(setAttendanceMock).toHaveBeenCalledTimes(2);
  });

  it("treats a network failure as a failed change", async () => {
    setAttendanceMock.mockRejectedValueOnce(new Error("offline"));
    renderCard([grace]);
    fireEvent.click(memberButton("Grace Kim"));
    expect(
      await screen.findByText(/Couldn't reach the server/),
    ).toBeInTheDocument();
  });

  it("pages a large club and searches and filters every member", () => {
    const manyMembers = Array.from({ length: 300 }, (_, index) =>
      member(
        index + 10,
        `Player${String(index).padStart(3, "0")}`,
        "Test",
        index % 3 === 0 ? "advanced" : "beginner",
      ),
    );
    renderCard(manyMembers);
    const list = screen.getByRole("list", { name: "Who's playing?" });
    expect(within(list).getAllByRole("button")).toHaveLength(
      MEMBER_DIRECTORY_PAGE_SIZE,
    );
    expect(
      screen.getByText(`Showing ${MEMBER_DIRECTORY_PAGE_SIZE} of 300 members`),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Show ${MEMBER_DIRECTORY_PAGE_SIZE} more`,
      }),
    );
    expect(within(list).getAllByRole("button")).toHaveLength(
      MEMBER_DIRECTORY_PAGE_SIZE * 2,
    );

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // A new filter starts from the first page again.
    expect(
      screen.getByText(
        `Showing ${MEMBER_DIRECTORY_PAGE_SIZE} of 100 matching members`,
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search members by name"), {
      target: { value: "player29" },
    });
    // Player290 … Player299, of which 291, 294, 297 are advanced.
    expect(
      screen.getByText("Showing 3 of 3 matching members"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search members by name"), {
      target: { value: "nobody" },
    });
    expect(
      screen.getByText("No members match. Try another name or level."),
    ).toBeInTheDocument();
  });

  it("selects every matching member, including those not on screen yet", () => {
    setAttendanceMock.mockReturnValue(new Promise(() => {}));
    const manyMembers = Array.from({ length: 120 }, (_, index) =>
      member(index + 10, `Player${index}`, "Test"),
    );
    renderCard(manyMembers);
    fireEvent.click(
      screen.getByRole("button", { name: "Select all 120 matching members" }),
    );
    expect(setAttendanceMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      memberIds: manyMembers.map((entry) => entry.id),
      attending: true,
    });
    expect(screen.getByText("Saving attendance…")).toBeInTheDocument();
  });

  it("clears attending members but keeps the guests", async () => {
    setAttendanceMock.mockResolvedValue({
      ok: true,
      participants: [guest("g-1", "Ben")],
    });
    renderCard(
      [grace, kofi, zoe],
      [attendee(grace), attendee(kofi), guest("g-1", "Ben")],
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear 2 attending members (guests stay)",
      }),
    );
    expect(setAttendanceMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      memberIds: [grace.id, kofi.id],
      attending: false,
    });
    await waitFor(() =>
      expect(memberButton("Grace Kim")).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Remove guest Ben Guest" }),
    ).toBeInTheDocument();
  });

  it("keeps a deactivated member who is attending so the host can remove them", () => {
    renderCard(
      [grace],
      [
        {
          ...attendee(member(9, "Ina", "Gone")),
          isMemberActive: false,
        },
      ],
    );
    expect(memberButton("Ina Gone")).toHaveAttribute("aria-pressed", "true");
    expect(memberButton("Ina Gone")).toHaveTextContent(
      "Deactivated · Attending",
    );
  });

  it("checks the guest form, adds a guest and removes one", async () => {
    addGuestMock.mockResolvedValue({
      ok: true,
      participants: [guest("g-new", "Kai")],
    });
    renderCard([grace]);
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Kai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
    const lastName = screen.getByLabelText("Last name");
    expect(lastName).toHaveAttribute("aria-invalid", "true");
    expect(lastName).toHaveAccessibleDescription("Enter a last name.");
    expect(addGuestMock).not.toHaveBeenCalled();

    fireEvent.change(lastName, { target: { value: " Guest " } });
    expect(lastName).not.toHaveAttribute("aria-invalid");
    fireEvent.change(screen.getByLabelText("Skill (optional)"), {
      target: { value: "intermediate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
    expect(addGuestMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      // Chosen in the browser, so a retry can't add Kai twice.
      participantId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      firstName: "Kai",
      lastName: "Guest",
      skillLevel: "intermediate",
    });
    // The form is ready for the next guest.
    expect(screen.getByLabelText("First name")).toHaveValue("");
    // Pending until the server answers, then the saved guest replaces it.
    expect(screen.getByText("Adding…")).toBeInTheDocument();
    const removeKai = () =>
      screen.getByRole("button", { name: "Remove guest Kai Guest" });
    await waitFor(() => expect(removeKai()).toBeEnabled());
    expect(screen.getByText("Guest · Intermediate")).toBeInTheDocument();

    removeGuestMock.mockResolvedValue({ ok: true, participants: [] });
    fireEvent.click(removeKai());
    expect(removeGuestMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      participantId: "g-new",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove guest Kai Guest" }),
      ).not.toBeInTheDocument(),
    );
  });
  it("writes changes made while one is pending in order, and ends on the last server list", async () => {
    const deferredResults: ((result: DraftAttendanceResult) => void)[] = [];
    const deferred = () =>
      new Promise<DraftAttendanceResult>((resolve) => {
        deferredResults.push(resolve);
      });
    setAttendanceMock.mockImplementation(deferred);
    addGuestMock.mockImplementation(deferred);
    renderCard([grace, kofi]);

    fireEvent.click(memberButton("Grace Kim"));
    fireEvent.click(memberButton("Grace Kim"));
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Kai" },
    });
    fireEvent.change(screen.getByLabelText("Last name"), {
      target: { value: "Guest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
    // Shown at once: Grace back to not attending, Kai being added.
    expect(memberButton("Grace Kim")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Adding…")).toBeInTheDocument();
    // Only the first write has started.
    expect(setAttendanceMock).toHaveBeenCalledTimes(1);
    expect(addGuestMock).not.toHaveBeenCalled();

    deferredResults[0]({ ok: true, participants: [attendee(grace)] });
    await waitFor(() => expect(setAttendanceMock).toHaveBeenCalledTimes(2));
    expect(
      setAttendanceMock.mock.calls.map(([input]) => input.attending),
    ).toEqual([true, false]);
    deferredResults[1]({ ok: true, participants: [] });
    await waitFor(() => expect(addGuestMock).toHaveBeenCalledTimes(1));
    const kaiId = addGuestMock.mock.calls[0][0].participantId;
    // The final list is the server's last answer: Kai, under the browser's id.
    deferredResults[2]({ ok: true, participants: [guest(kaiId, "Kai")] });
    await waitFor(() =>
      expect(screen.queryByText("Saving attendance…")).not.toBeInTheDocument(),
    );
    expect(memberButton("Grace Kim")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Adding…")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove guest Kai Guest" }),
    ).toBeEnabled();
    expect(screen.getByTestId("player-count")).toHaveTextContent("1");
  });

  it("keeps every failure, offers Retry all, and never retries what was changed since", async () => {
    setAttendanceMock.mockResolvedValue({
      ok: false,
      message: "Something went wrong. Try again in a moment.",
    });
    renderCard([grace, kofi, zoe]);
    fireEvent.click(memberButton("Grace Kim"));
    fireEvent.click(memberButton("Kofi Mensah"));
    expect(
      await screen.findByText(
        "2 changes not saved. Something went wrong. Try again in a moment.",
      ),
    ).toBeInTheDocument();

    // Selecting Grace again replaces her failed change (and fails again).
    fireEvent.click(memberButton("Grace Kim"));
    await waitFor(() => expect(setAttendanceMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/^2 changes not saved/)).toBeInTheDocument();

    setAttendanceMock.mockReset();
    setAttendanceMock.mockResolvedValue({
      ok: true,
      participants: [attendee(grace), attendee(kofi)],
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry all" }));
    await waitFor(() =>
      expect(screen.queryByText(/not saved/)).not.toBeInTheDocument(),
    );
    // Kofi's change and Grace's latest one, each once.
    expect(
      setAttendanceMock.mock.calls.map(([input]) => input.memberIds),
    ).toEqual([[kofi.id], [grace.id]]);
    expect(memberButton("Kofi Mensah")).toHaveAttribute("aria-pressed", "true");
  });

  it("drops a failed change that a later change undoes", async () => {
    setAttendanceMock.mockResolvedValueOnce({
      ok: false,
      message: "Something went wrong. Try again in a moment.",
    });
    renderCard([grace], [attendee(grace)]);
    fireEvent.click(memberButton("Grace Kim"));
    expect(
      await screen.findByText(/^Not saved: Removing Grace Kim/),
    ).toBeInTheDocument();
    // Grace is shown attending again; clicking now removes her once more,
    // so the stale failure is gone (Retry would repeat it).
    setAttendanceMock.mockResolvedValueOnce({ ok: true, participants: [] });
    fireEvent.click(memberButton("Grace Kim"));
    await waitFor(() =>
      expect(memberButton("Grace Kim")).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
    expect(screen.queryByText(/not saved/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Retry/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps a saved change when only the list couldn't refresh, without offering Retry", async () => {
    setAttendanceMock.mockResolvedValue({
      ok: true,
      participants: null,
      message: "Saved, but the list couldn't refresh. Reload the page.",
    });
    renderCard([grace]);
    fireEvent.click(memberButton("Grace Kim"));
    expect(
      await screen.findByText(
        "Saved, but the list couldn't refresh. Reload the page.",
      ),
    ).toBeInTheDocument();
    expect(memberButton("Grace Kim")).toHaveAttribute("aria-pressed", "true");
    expect(memberButton("Grace Kim")).toHaveTextContent("Attending");
    expect(
      screen.queryByRole("button", { name: /Retry/ }),
    ).not.toBeInTheDocument();
  });
});
