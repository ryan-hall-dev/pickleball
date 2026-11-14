import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDraftParticipant,
  readSessionDraft,
  removeDraftParticipant,
  type ReadSessionDraftResult,
} from "@/server/setup/setupActions";
import type { DraftParticipant, SessionDraft } from "@/server/setup/setupDraft";
import { useDraftAttendance } from "./useDraftAttendance";

vi.mock("@/server/setup/setupActions", () => ({
  addDraftParticipant: vi.fn(),
  removeDraftParticipant: vi.fn(),
  readSessionDraft: vi.fn(),
}));

const readSessionDraftMock = vi.mocked(readSessionDraft);
const addParticipantMock = vi.mocked(addDraftParticipant);
const removeParticipantMock = vi.mocked(removeDraftParticipant);

const SESSION_ID = "d0000000-0000-4000-8000-000000000001";

function attendee(index: number, firstName: string): DraftParticipant {
  return {
    participantId: `e0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    firstName,
    lastName: "Player",
    skillLevel: "beginner",
  };
}

const grace = attendee(1, "Grace");
const kai = attendee(2, "Kai");
const zoe = attendee(3, "Zoe");

function draftRead(participants: DraftParticipant[]): ReadSessionDraftResult {
  return {
    ok: true,
    draft: { participants } as unknown as SessionDraft,
  };
}

function renderAttendance(initialParticipants: DraftParticipant[]) {
  return renderHook(() => useDraftAttendance(SESSION_ID, initialParticipants));
}

beforeEach(() => {
  readSessionDraftMock.mockReset();
  addParticipantMock.mockReset();
  removeParticipantMock.mockReset();
});

describe("useDraftAttendance: writes", () => {
  it("adds a player with the level and shows the server's list", async () => {
    addParticipantMock.mockResolvedValue({
      ok: true,
      participants: [grace, kai],
    });
    const { result } = renderAttendance([grace]);
    await act(async () =>
      result.current.queueChange({
        change: {
          kind: "addParticipant",
          participantId: kai.participantId,
          participant: {
            firstName: "Kai",
            lastName: "Player",
            skillLevel: "beginner",
          },
        },
        description: "Adding Kai Player",
      }),
    );
    expect(addParticipantMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      participantId: kai.participantId,
      firstName: "Kai",
      lastName: "Player",
      skillLevel: "beginner",
    });
    expect(result.current.participants).toEqual([grace, kai]);
  });

  it("keeps a refused add for Retry with the server's message (e.g. a name clash)", async () => {
    addParticipantMock.mockResolvedValue({
      ok: false,
      message: "Someone named Grace Player is already in this session.",
    });
    const { result } = renderAttendance([grace]);
    await act(async () =>
      result.current.queueChange({
        change: {
          kind: "addParticipant",
          participantId: "e0000000-0000-4000-8000-000000000099",
          participant: {
            firstName: "Grace",
            lastName: "Player",
            skillLevel: "beginner",
          },
        },
        description: "Adding Grace Player",
      }),
    );
    expect(result.current.participants).toEqual([grace]);
    expect(result.current.failures).toMatchObject([
      {
        description: "Adding Grace Player",
        message: "Someone named Grace Player is already in this session.",
      },
    ]);
  });

  it("removes any player through removeDraftParticipant", async () => {
    removeParticipantMock.mockResolvedValue({ ok: true, participants: [kai] });
    const { result } = renderAttendance([grace, kai]);
    await act(async () =>
      result.current.queueChange({
        change: {
          kind: "removeParticipant",
          participantId: grace.participantId,
        },
        description: "Removing Grace Player",
      }),
    );
    expect(removeParticipantMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      participantId: grace.participantId,
    });
    expect(result.current.participants).toEqual([kai]);
  });
});

describe("useDraftAttendance: check-ins", () => {
  it("adds an approved attendee once", () => {
    const { result } = renderAttendance([grace]);
    act(() => result.current.addApprovedParticipant(kai));
    act(() => result.current.addApprovedParticipant(kai));
    expect(result.current.participants).toEqual([grace, kai]);
  });

  it("re-reads the list when another host changed it", async () => {
    readSessionDraftMock.mockResolvedValue(draftRead([grace, zoe]));
    const { result } = renderAttendance([grace]);
    await act(() => result.current.rereadParticipants());
    expect(readSessionDraftMock).toHaveBeenCalledWith(SESSION_ID);
    expect(result.current.participants).toEqual([grace, zoe]);
  });

  it("drops a re-read that an approval here overtook", async () => {
    let answerRead: (result: ReadSessionDraftResult) => void = () => {};
    readSessionDraftMock.mockReturnValue(
      new Promise((resolve) => {
        answerRead = resolve;
      }),
    );
    const { result } = renderAttendance([grace]);
    let reread: Promise<void> = Promise.resolve();
    act(() => {
      reread = result.current.rereadParticipants();
    });
    act(() => result.current.addApprovedParticipant(kai));
    await act(async () => {
      answerRead(draftRead([grace]));
      await reread;
    });
    expect(result.current.participants).toEqual([grace, kai]);
  });

  it("skips a re-read while a write is on its way (its answer brings the list)", async () => {
    removeParticipantMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderAttendance([grace]);
    act(() =>
      result.current.queueChange({
        change: {
          kind: "removeParticipant",
          participantId: grace.participantId,
        },
        description: "Removing Grace",
      }),
    );
    await act(() => result.current.rereadParticipants());
    expect(readSessionDraftMock).not.toHaveBeenCalled();
  });

  it("keeps the list when the re-read fails", async () => {
    readSessionDraftMock.mockRejectedValue(new Error("offline"));
    const { result } = renderAttendance([grace]);
    await act(() => result.current.rereadParticipants());
    expect(result.current.participants).toEqual([grace]);
  });
});
