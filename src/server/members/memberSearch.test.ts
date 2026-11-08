// @vitest-environment node
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildMemberDirectoryHref,
  DEFAULT_MEMBER_DIRECTORY_QUERY,
  escapeLikePattern,
  MEMBER_SEARCH_TEXT_MAX_LENGTH,
  memberSearchLikePattern,
  normalizeMemberSearchText,
  parseMemberDirectoryQuery,
  type MemberDirectoryQuery,
} from "./memberSearch";

describe("parseMemberDirectoryQuery", () => {
  it("uses the defaults for an empty URL", () => {
    expect(parseMemberDirectoryQuery({})).toEqual(
      DEFAULT_MEMBER_DIRECTORY_QUERY,
    );
  });

  it("reads every filter", () => {
    expect(
      parseMemberDirectoryQuery({
        q: "  grace ",
        skill: "advanced",
        status: "deactivated",
        page: "3",
      }),
    ).toEqual({
      searchText: "grace",
      skillLevel: "advanced",
      status: "deactivated",
      pageCount: 3,
    });
  });

  it.each([
    [{ skill: "expert" }, { skillLevel: null }],
    [{ status: "deleted" }, { status: "active" }],
    [{ page: "0" }, { pageCount: 1 }],
    [{ page: "-2" }, { pageCount: 1 }],
    [{ page: "2.5" }, { pageCount: 1 }],
    [{ page: "abc" }, { pageCount: 1 }],
    [{ page: "99999999" }, { pageCount: 1 }],
  ])("falls back to the default for malformed %j", (searchParams, expected) => {
    expect(parseMemberDirectoryQuery(searchParams)).toMatchObject(expected);
  });

  it("takes the first value of a repeated parameter", () => {
    expect(
      parseMemberDirectoryQuery({ q: ["kim", "lee"], skill: ["beginner"] }),
    ).toMatchObject({ searchText: "kim", skillLevel: "beginner" });
  });

  it("caps very long search text", () => {
    const query = parseMemberDirectoryQuery({ q: "a".repeat(500) });
    expect(query.searchText).toHaveLength(MEMBER_SEARCH_TEXT_MAX_LENGTH);
  });
});

describe("buildMemberDirectoryHref", () => {
  it("leaves defaults out of the URL", () => {
    expect(buildMemberDirectoryHref(DEFAULT_MEMBER_DIRECTORY_QUERY)).toBe(
      "/members",
    );
  });

  it("encodes search text safely", () => {
    expect(
      buildMemberDirectoryHref({
        ...DEFAULT_MEMBER_DIRECTORY_QUERY,
        searchText: "o'brien & co?",
      }),
    ).toBe("/members?q=o%27brien+%26+co%3F");
  });

  it("round-trips through parseMemberDirectoryQuery", () => {
    const queryArbitrary: fc.Arbitrary<MemberDirectoryQuery> = fc.record({
      searchText: fc
        .string({ maxLength: MEMBER_SEARCH_TEXT_MAX_LENGTH })
        .map((text) => text.trim()),
      skillLevel: fc.constantFrom(null, "beginner", "intermediate", "advanced"),
      status: fc.constantFrom("active", "deactivated"),
      pageCount: fc.integer({ min: 1, max: 999_999 }),
    });
    fc.assert(
      fc.property(queryArbitrary, (query) => {
        const href = buildMemberDirectoryHref(query);
        const searchParams = Object.fromEntries(
          new URL(href, "http://localhost").searchParams,
        );
        expect(parseMemberDirectoryQuery(searchParams)).toEqual(query);
      }),
    );
  });
});

describe("normalizeMemberSearchText", () => {
  it.each([
    ["Élodie", "elodie"],
    ["  ZOË   Ñúñez ", "zoe nunez"],
    ["O'Brien-Smith", "o'brien-smith"],
    ["Ångström", "angstrom"],
    ["", ""],
  ])("%j → %j", (text, normalized) => {
    expect(normalizeMemberSearchText(text)).toBe(normalized);
  });
});

describe("escapeLikePattern", () => {
  it.each([
    ["50%", "50\\%"],
    ["a_b", "a\\_b"],
    // PostgREST turns "*" into "%" even when escaped, so it becomes "_".
    ["star*", "star_"],
    ["back\\slash", "back\\\\slash"],
    ["plain name", "plain name"],
  ])("%j → %j", (text, escaped) => {
    expect(escapeLikePattern(text)).toBe(escaped);
  });

  it("leaves no unescaped % or escape, and one _ per * only", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        // Drop escaped pairs; what's left may only hold the "_" made from "*".
        const unescapedRemainder = escapeLikePattern(text).replace(
          /\\[\\%_]/g,
          "",
        );
        expect(unescapedRemainder).not.toMatch(/[\\%*]/);
        expect(unescapedRemainder.split("_").length - 1).toBe(
          text.split("*").length - 1,
        );
      }),
    );
  });
});

describe("memberSearchLikePattern", () => {
  it("is null when there is nothing to search for", () => {
    expect(memberSearchLikePattern("")).toBeNull();
    expect(memberSearchLikePattern("   ")).toBeNull();
  });

  it("wraps the normalised, escaped text for a contains search", () => {
    expect(memberSearchLikePattern(" Gr%ce ")).toBe("%gr\\%ce%");
    expect(memberSearchLikePattern("Ja*ne")).toBe("%ja_ne%");
  });
});
