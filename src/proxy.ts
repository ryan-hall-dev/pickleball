import { NextResponse, type NextRequest } from "next/server";
import { refreshSupabaseSession } from "@/lib/supabase/proxy";

/** Paths a signed-out visitor may open. Everything else is the host area. */
const SIGNED_OUT_PATH_PREFIXES = ["/login"];

function isSignedOutPath(pathname: string): boolean {
  return SIGNED_OUT_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function proxy(request: NextRequest) {
  const { response, isSignedIn } = await refreshSupabaseSession(request);
  if (isSignedIn || isSignedOutPath(request.nextUrl.pathname)) return response;
  // A server action call (POST with Next-Action) gets no redirect: the action
  // checks access itself and returns "your session has ended" to its form.
  if (request.headers.has("next-action")) return response;

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  const redirectResponse = NextResponse.redirect(loginUrl);
  // Keep any cookie changes (e.g. a cleared, expired session).
  for (const cookie of response.cookies.getAll()) {
    redirectResponse.cookies.set(cookie);
  }
  return redirectResponse;
}

export const config = {
  // Skips Next internals, static files and the public player check-in page
  // (/t/<tag>, opened by NFC stickers: no login, no session to refresh).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|t/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
