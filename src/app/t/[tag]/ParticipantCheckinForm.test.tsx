import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenCheckinPage } from "@/server/checkin/checkinResults";
import type {
  ParticipantCheckinInput,
  CheckinFormValues,
} from "@/server/checkin/checkinRules";
import { ParticipantCheckinForm } from "./ParticipantCheckinForm";
afterEach(cleanup);
const page: OpenCheckinPage = {
  status: "open",
  socialName: "Riverside",
  currentRequest: null,
  now: "2026-11-15T09:00:00Z",
  session: {
    sessionId: "a0000000-0000-4000-8000-000000000001",
    name: "Saturday Social",
    status: "draft",
    durationMinutes: 120,
    startedAt: null,
    endsAt: null,
    plannedStart: "2026-11-15T10:00:00Z",
    plannedEnd: "2026-11-15T12:00:00Z",
    courtsCount: 2,
    checkedInCount: 0,
  },
};
function Form({
  onCheckIn,
  isBusy = false,
}: {
  onCheckIn: (input: ParticipantCheckinInput) => void;
  isBusy?: boolean;
}) {
  const [values, setValues] = useState<CheckinFormValues>({
    firstName: "",
    lastName: "",
    skillLevel: null,
    gender: null,
  });
  return (
    <ParticipantCheckinForm
      page={page}
      values={values}
      onValuesChange={setValues}
      serverFieldErrors={{}}
      isBusy={isBusy}
      onCheckIn={onCheckIn}
    />
  );
}
describe("fresh session participant form", () => {
  it("shows the welcome and session card with no member lookup", () => {
    render(<Form onCheckIn={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Welcome to Riverside" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Saturday Social" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "First name" })).toHaveValue("");
    for (const name of ["Beginner", "Intermediate", "Advanced"])
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
  });
  it("requires names and level, focuses the error, and submits trimmed complete details", () => {
    const submit = vi.fn();
    render(<Form onCheckIn={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    expect(screen.getByText("Enter your first name")).toBeInTheDocument();
    expect(screen.getByText("Enter your last name")).toBeInTheDocument();
    expect(screen.getByText("Choose your level")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "First name" })).toHaveFocus();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "First name" }), {
      target: { value: "  Kai  " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Last name" }), {
      target: { value: "Moreno" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Male" }));
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      firstName: "Kai",
      lastName: "Moreno",
      skillLevel: "advanced",
      gender: "male",
    });
  });
  it("disables fields and submit while a request or cookie initialization is pending", () => {
    render(<Form onCheckIn={vi.fn()} isBusy />);
    expect(screen.getByRole("textbox", { name: "First name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check in" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Beginner" })).toBeDisabled();
  });
});

it("starts with no gender selected and requires a choice", () => {
  const submit = vi.fn();
  render(<Form onCheckIn={submit} />);
  expect(screen.getByRole("button", { name: "Male" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByRole("button", { name: "Female" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  fireEvent.click(screen.getByRole("button", { name: "Check in" }));
  expect(
    screen.getByRole("group", { name: "Gender" }),
  ).toHaveAccessibleDescription("Choose male or female.");
  expect(submit).not.toHaveBeenCalled();
});
