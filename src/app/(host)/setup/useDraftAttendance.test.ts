import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSessionDraft,
  setDraftMemberAttendance,
  type ReadSessionDraftResult,
} from "@/server/setup/setupActions";
import type { DraftParticipant, SessionDraft } from "@/server/setup/setupDraft";
import { useDraftAttendance } from "./useDraftAttendance";

vi.mock("@/server/setup/setupActions", () => ({
  setDraftMemberAttendance: vi.fn(),
  addDraftGuest: vi.fn(),
  removeDraftGuest: vi.fn(),
  readSessionDraft: vi.fn(),
}));

const readSessionDraftMock = vi.mocked(readSessionDraft);
const setAttendanceMock = vi.mocked(setDraftMemberAttendance);

const SESSION_ID = "d0000000-0000-4000-8000-000000000001";

function attendee(index: number, firstName: string): DraftParticipant {
  return {
    participantId: `e0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    memberId: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    isGuest: false,
    firstName,
    lastName: "Player",
    skillLevel: "beginner",
    isMemberActive: true,
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
  return renderHook(() =>
    useDraftAttendance(SESSION_ID, initialParticipants, []),
  );
}

beforeEach(() => {
  readSessionDraftMock.mockReset();
  setAttendanceMock.mockReset();
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
    setAttendanceMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderAttendance([grace]);
    act(() =>
      result.current.queueChange({
        change: {
          kind: "setMembers",
          memberIds: [grace.memberId!],
          attending: false,
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
