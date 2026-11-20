import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithLocale as render } from "@/i18n/testing";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDraftParticipant,
  removeDraftParticipant,
  type DraftAttendanceResult,
} from "@/server/setup/setupActions";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import { useDraftAttendance } from "./useDraftAttendance";
import { EMPTY_PARTICIPANT_FORM } from "./whosPlaying";
import { WhosPlayingCard } from "./WhosPlayingCard";

vi.mock("@/server/setup/setupActions", () => ({
  addDraftParticipant: vi.fn(),
  removeDraftParticipant: vi.fn(),
}));

afterEach(cleanup);

const addParticipantMock = vi.mocked(addDraftParticipant);
const removeParticipantMock = vi.mocked(removeDraftParticipant);

const SESSION_ID = "d0000000-0000-4000-8000-000000000001";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function player(
  participantId: string,
  firstName: string,
  lastName: string,
  skillLevel: DraftParticipant["skillLevel"] = "intermediate",
): DraftParticipant {
  return { participantId, firstName, lastName, skillLevel, gender: "male" };
}

const grace = player("p-grace", "Grace", "Kim", "advanced");

/** The card with the real attendance hook, as the editor uses it. */
function CardHarness({
  participants,
  saveDetails,
}: {
  participants: DraftParticipant[];
  saveDetails?: Parameters<typeof useDraftAttendance>[2];
}) {
  const attendance = useDraftAttendance(SESSION_ID, participants, saveDetails);
  const [participantForm, setParticipantForm] = useState(
    EMPTY_PARTICIPANT_FORM,
  );
  return (
    <>
      <WhosPlayingCard
        attendance={attendance}
        participantForm={participantForm}
        onParticipantFormChange={setParticipantForm}
      />
      <p data-testid="player-count">{attendance.participants.length}</p>
    </>
  );
}

function renderCard(participants: DraftParticipant[] = []) {
  return render(<CardHarness participants={participants} />);
}

function fillPlayerForm(firstName: string, lastName: string, level: string) {
  fireEvent.change(screen.getByLabelText("First name"), {
    target: { value: firstName },
  });
  fireEvent.change(screen.getByLabelText("Last name"), {
    target: { value: lastName },
  });
  fireEvent.change(screen.getByLabelText("Gender"), {
    target: { value: "male" },
  });
  fireEvent.change(screen.getByLabelText("Skill"), {
    target: { value: level },
  });
}

function addPlayerButton() {
  return screen.getByRole("button", { name: "Add player" });
}

describe("WhosPlayingCard", () => {
  beforeEach(() => {
    addParticipantMock.mockReset();
    removeParticipantMock.mockReset();
  });

  it("lists the draft's players with their level and counts them", () => {
    renderCard([grace, player("p-kai", "Kai", "Lee", null)]);
    const players = screen.getByRole("list", { name: "Players" });
    expect(players).toHaveTextContent("Grace Kim");
    expect(players).toHaveTextContent("Advanced");
    expect(players).toHaveTextContent("No level");
    expect(screen.getByText("players")).toBeInTheDocument();
    expect(screen.getByTestId("player-count")).toHaveTextContent("2");
    // No member directory any more.
    expect(
      screen.queryByRole("searchbox", { name: /Search members/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Select all/ }),
    ).not.toBeInTheDocument();
  });

  it("requires first name, last name and level, then adds a player and removes one", async () => {
    addParticipantMock.mockResolvedValue({
      ok: true,
      participants: [player("p-new", "Kai", "Lee")],
    });
    renderCard();
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Kai" },
    });
    fireEvent.click(addPlayerButton());
    const lastName = screen.getByLabelText("Last name");
    expect(lastName).toHaveAttribute("aria-invalid", "true");
    expect(lastName).toHaveAccessibleDescription("Enter a last name.");
    expect(screen.getByLabelText("Skill")).toHaveAccessibleDescription(
      "Choose a level.",
    );
    expect(addParticipantMock).not.toHaveBeenCalled();

    fillPlayerForm("Kai", " Lee ", "intermediate");
    expect(lastName).not.toHaveAttribute("aria-invalid");
    fireEvent.click(addPlayerButton());
    expect(addParticipantMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      // Chosen in the browser, so a retry can't add Kai twice.
      participantId: expect.stringMatching(UUID_PATTERN),
      firstName: "Kai",
      lastName: "Lee",
      skillLevel: "intermediate",
      gender: "male" as const,
    });
    // The form is ready for the next player.
    expect(screen.getByLabelText("First name")).toHaveValue("");
    // Pending until the server answers, then the saved player replaces it.
    expect(screen.getByText("Adding…")).toBeInTheDocument();
    const removeKai = () =>
      screen.getByRole("button", { name: "Remove Kai Lee" });
    await waitFor(() => expect(removeKai()).toBeEnabled());
    expect(screen.getByRole("list", { name: "Players" })).toHaveTextContent(
      "Intermediate",
    );

    removeParticipantMock.mockResolvedValue({ ok: true, participants: [] });
    fireEvent.click(removeKai());
    expect(removeParticipantMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      participantId: "p-new",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove Kai Lee" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows the server's refusal for a name already in the session, and offers Retry", async () => {
    addParticipantMock.mockResolvedValueOnce({
      ok: false,
      message:
        "Someone named Grace Kim is already in this session. Add something to tell them apart, like an initial.",
    });
    renderCard([grace]);
    fillPlayerForm("Grace", "Kim", "beginner");
    fireEvent.click(addPlayerButton());
    expect(
      await screen.findByText(
        "Not saved: Adding Grace Kim. Someone named Grace Kim is already in this session. Add something to tell them apart, like an initial.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("player-count")).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("retries a failed add", async () => {
    addParticipantMock.mockResolvedValueOnce({
      ok: false,
      message: "Something went wrong. Try again in a moment.",
    });
    renderCard();
    fillPlayerForm("Kai", "Lee", "beginner");
    fireEvent.click(addPlayerButton());
    expect(
      await screen.findByText(
        "Not saved: Adding Kai Lee. Something went wrong. Try again in a moment.",
      ),
    ).toBeInTheDocument();

    addParticipantMock.mockResolvedValueOnce({
      ok: true,
      participants: [player("p-kai", "Kai", "Lee", "beginner")],
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("player-count")).toHaveTextContent("1"),
    );
    expect(screen.queryByText(/Not saved/)).not.toBeInTheDocument();
    expect(addParticipantMock).toHaveBeenCalledTimes(2);
    // The retry reuses the browser's id, so it can't add Kai twice.
    expect(addParticipantMock.mock.calls[1][0].participantId).toBe(
      addParticipantMock.mock.calls[0][0].participantId,
    );
  });

  it("treats a network failure as a failed change", async () => {
    removeParticipantMock.mockRejectedValueOnce(new Error("offline"));
    renderCard([grace]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Grace Kim" }));
    expect(
      await screen.findByText(/Couldn't reach the server/),
    ).toBeInTheDocument();
    // Shown again: the removal didn't happen.
    expect(screen.getByTestId("player-count")).toHaveTextContent("1");
  });

  it("writes changes made while one is pending in order, and ends on the last server list", async () => {
    const deferredResults: ((result: DraftAttendanceResult) => void)[] = [];
    const deferred = () =>
      new Promise<DraftAttendanceResult>((resolve) => {
        deferredResults.push(resolve);
      });
    removeParticipantMock.mockImplementation(deferred);
    addParticipantMock.mockImplementation(deferred);
    renderCard([grace]);

    fireEvent.click(screen.getByRole("button", { name: "Remove Grace Kim" }));
    fillPlayerForm("Kai", "Lee", "advanced");
    fireEvent.click(addPlayerButton());
    // Shown at once: Grace gone, Kai being added.
    expect(screen.queryByText("Grace Kim")).not.toBeInTheDocument();
    expect(screen.getByText("Adding…")).toBeInTheDocument();
    // Only the first write has started.
    expect(removeParticipantMock).toHaveBeenCalledTimes(1);
    expect(addParticipantMock).not.toHaveBeenCalled();

    deferredResults[0]({ ok: true, participants: [] });
    await waitFor(() => expect(addParticipantMock).toHaveBeenCalledTimes(1));
    const kaiId = addParticipantMock.mock.calls[0][0].participantId;
    deferredResults[1]({
      ok: true,
      participants: [player(kaiId, "Kai", "Lee", "advanced")],
    });
    await waitFor(() =>
      expect(screen.queryByText("Saving attendance…")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Adding…")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Kai Lee" }),
    ).toBeEnabled();
    expect(screen.getByTestId("player-count")).toHaveTextContent("1");
  });

  it("keeps a saved change when only the list couldn't refresh, without offering Retry", async () => {
    addParticipantMock.mockResolvedValue({
      ok: true,
      participants: null,
      message: "Saved, but the list couldn't refresh. Reload the page.",
    });
    renderCard();
    fillPlayerForm("Kai", "Lee", "beginner");
    fireEvent.click(addPlayerButton());
    expect(
      await screen.findByText(
        "Saved, but the list couldn't refresh. Reload the page.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Kai Lee")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Retry/ }),
    ).not.toBeInTheDocument();
  });
});

it("requires explicit missing legacy gender and level, preserves known details, and persists the selection", async () => {
  const saveDetails = vi.fn().mockResolvedValue({ ok: true, draftRevision: 4 });
  render(
    <CardHarness
      participants={[{ ...grace, gender: null, skillLevel: null }]}
      saveDetails={saveDetails}
    />,
  );
  const gender = screen.getByRole("combobox", { name: "Gender for Grace Kim" });
  const level = screen.getByRole("combobox", { name: "Level for Grace Kim" });
  expect(gender).toHaveValue("");
  expect(level).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Save details" }));
  expect(saveDetails).not.toHaveBeenCalled();
  fireEvent.change(gender, { target: { value: "female" } });
  fireEvent.change(level, { target: { value: "advanced" } });
  fireEvent.click(screen.getByRole("button", { name: "Save details" }));
  await waitFor(() =>
    expect(saveDetails).toHaveBeenCalledWith(
      grace.participantId,
      "female",
      "advanced",
    ),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("form", { name: "Complete details for Grace Kim" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("list", { name: "Players" })).toHaveTextContent(
    "Advanced · Female",
  );
});
it("prefills a known legacy level and retains missing details after a conflict", async () => {
  const saveDetails = vi.fn().mockResolvedValue({
    ok: false,
    message: "Changed elsewhere",
    isConflict: true,
  });
  render(
    <CardHarness
      participants={[{ ...grace, gender: null }]}
      saveDetails={saveDetails}
    />,
  );
  expect(
    screen.getByRole("combobox", { name: "Level for Grace Kim" }),
  ).toHaveValue("advanced");
  fireEvent.change(
    screen.getByRole("combobox", { name: "Gender for Grace Kim" }),
    { target: { value: "female" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save details" }));
  await screen.findByText("Changed elsewhere");
  expect(
    screen.getByRole("combobox", { name: "Gender for Grace Kim" }),
  ).toHaveValue("female");
  expect(screen.getByRole("list", { name: "Players" })).toHaveTextContent(
    "Gender missing",
  );
});
