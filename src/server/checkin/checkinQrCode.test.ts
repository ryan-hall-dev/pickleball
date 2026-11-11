// @vitest-environment node
// The check-in QR code encodes exactly the link. The project has no QR
// decoder dependency, so the test decodes uqr's module matrix itself
// (decodeQrModules: format bits, unmasking, codewords, byte mode) and then
// checks the SVG we serve draws exactly that matrix, quiet zone included.
import { encode, QrCodeDataType } from "uqr";
import { describe, expect, it, vi } from "vitest";
import { decodeQrModules } from "@/server/testing/decodeQrModules";
import {
  CHECKIN_QR_ERROR_CORRECTION_LEVEL,
  CHECKIN_QR_QUIET_ZONE_MODULES,
  checkinQrCodeModules,
  checkinQrCodeSvg,
} from "./checkinLink";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

const CHECKIN_LINK =
  "https://pickleball.example/t/0123456789abcdef0123456789abcdef";

/** Decodes the code `checkinQrCodeModules` gives, quiet zone removed. */
function decodeCheckinQrCode(checkinLink: string) {
  const quietZone = CHECKIN_QR_QUIET_ZONE_MODULES;
  const withQuietZone = checkinQrCodeModules(checkinLink);
  const modules = withQuietZone
    .slice(quietZone, -quietZone)
    .map((row) => row.slice(quietZone, -quietZone));
  // uqr marks which modules carry data; the same code without a border.
  const { types } = encode(checkinLink, {
    ecc: CHECKIN_QR_ERROR_CORRECTION_LEVEL,
    border: 0,
  });
  return decodeQrModules(
    modules,
    (x, y) => types[y][x] === QrCodeDataType.Data,
  );
}

/** The dark modules the SVG draws: one `M<x> <y>h<n>v1h-<n>z` per run. */
function darkModulesFromSvg(svg: string) {
  const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
  const pathData = /<path fill="#000000" d="([^"]*)"/.exec(svg)?.[1];
  if (!size || pathData === undefined) {
    throw new Error("Unexpected QR SVG shape.");
  }
  const dark = new Set<string>();
  for (const [, x, y, runLength] of pathData.matchAll(
    /M(\d+) (\d+)h(\d+)v1h-\3z/g,
  )) {
    for (let step = 0; step < Number(runLength); step += 1) {
      dark.add(`${y},${Number(x) + step}`);
    }
  }
  return {
    size,
    isDark: (row: number, column: number) => dark.has(`${row},${column}`),
  };
}

describe("checkinQrCodeSvg", () => {
  it("encodes exactly the check-in link at error correction level M", () => {
    expect(decodeCheckinQrCode(CHECKIN_LINK)).toMatchObject({
      text: CHECKIN_LINK,
      errorCorrectionLevel: "M",
    });
  });

  it("decodes a reissued link as that link (the decoder isn't fixed to one input)", () => {
    const reissuedLink = "http://localhost:3000/t/fedcba9876543210fedcba98";
    expect(decodeCheckinQrCode(reissuedLink).text).toBe(reissuedLink);
  });

  it("draws exactly the code's modules, black on white, with a 4-module quiet zone", () => {
    const svg = checkinQrCodeSvg(CHECKIN_LINK);
    const modules = checkinQrCodeModules(CHECKIN_LINK);
    const drawn = darkModulesFromSvg(svg);
    const quietZone = CHECKIN_QR_QUIET_ZONE_MODULES;

    expect(svg).toContain(
      `<path fill="#ffffff" d="M0 0h${drawn.size}v${drawn.size}H0z"/>`,
    );
    expect(drawn.size).toBe(modules.length);
    for (let row = 0; row < drawn.size; row += 1) {
      for (let column = 0; column < drawn.size; column += 1) {
        const isQuietZone =
          Math.min(row, column) < quietZone ||
          Math.max(row, column) >= drawn.size - quietZone;
        if (isQuietZone) expect(modules[row][column]).toBe(false);
        expect(drawn.isDark(row, column), `module ${row},${column}`).toBe(
          modules[row][column],
        );
      }
    }
  });
});
