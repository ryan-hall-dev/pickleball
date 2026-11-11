import "server-only";
import { headers } from "next/headers";
import { encode } from "uqr";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  checkinLinkFromOrigin,
  publicOriginFromHeaders,
  publicOriginFromSetting,
  shortCheckinLink,
} from "./checkinLinkRules";

export interface CheckinLink {
  /** Absolute, e.g. https://pickleball.example/t/<tag>: copied, encoded, written to NFC. */
  link: string;
  /** Without the scheme, printed under the QR code. */
  shortLink: string;
}

/**
 * M (15% recovery) keeps the code small enough to scan from a phone held at
 * arm's length; the links have no logo over them that would need Q or H.
 */
export const CHECKIN_QR_ERROR_CORRECTION_LEVEL = "M";
/** The QR spec's quiet zone: 4 white modules on every side, part of the SVG. */
export const CHECKIN_QR_QUIET_ZONE_MODULES = 4;

/**
 * The signed-in host's social's check-in link, read with their session (RLS:
 * a host reads only their own social's row). The origin is PUBLIC_APP_ORIGIN
 * when set, otherwise this request's (see publicOriginFromHeaders).
 */
export async function readCheckinLink(socialId: string): Promise<CheckinLink> {
  const publicOrigin =
    publicOriginFromSetting(process.env.PUBLIC_APP_ORIGIN) ??
    publicOriginFromHeaders(await headers());
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("socials")
    .select("checkin_tag")
    .eq("id", socialId)
    .single();
  if (error) {
    throw new Error(
      `Reading the social's check-in tag failed: ${error.message}`,
    );
  }
  const link = checkinLinkFromOrigin(publicOrigin, data.checkin_tag);
  return { link, shortLink: shortCheckinLink(link) };
}

/** The QR code's modules (`true` = dark), quiet zone included. */
export function checkinQrCodeModules(checkinLink: string): boolean[][] {
  return encode(checkinLink, {
    ecc: CHECKIN_QR_ERROR_CORRECTION_LEVEL,
    border: CHECKIN_QR_QUIET_ZONE_MODULES,
  }).data;
}

/**
 * The QR code for `checkinLink` as an SVG document: black modules on white,
 * quiet zone included, one unit per module, sized by its container (viewBox
 * only). Each row's dark runs are one rectangle, so no seams show between
 * modules. Made on the server, so no QR code runs in the browser.
 */
export function checkinQrCodeSvg(checkinLink: string): string {
  const modules = checkinQrCodeModules(checkinLink);
  const size = modules.length;
  const darkRuns: string[] = [];
  modules.forEach((row, rowIndex) => {
    let column = 0;
    while (column < size) {
      if (!row[column]) {
        column += 1;
        continue;
      }
      const runStart = column;
      while (column < size && row[column]) column += 1;
      const runLength = column - runStart;
      darkRuns.push(`M${runStart} ${rowIndex}h${runLength}v1h-${runLength}z`);
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<path fill="#ffffff" d="M0 0h${size}v${size}H0z"/>` +
    `<path fill="#000000" d="${darkRuns.join("")}"/>` +
    `</svg>`
  );
}
