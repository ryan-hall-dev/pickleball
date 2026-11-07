import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("renders the app heading and token swatches", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Pickleball Social Manager",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("lime")).toBeInTheDocument();
  });
});
