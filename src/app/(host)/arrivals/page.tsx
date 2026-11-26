import type { Metadata } from "next";
import { Suspense } from "react";
import { hostPageTitle } from "@/i18n/getLocale";
import { readHostAccess } from "@/server/auth/currentHost";
import { readHostRoster } from "@/server/roster/hostRosterActions";
import { HostLoading } from "../HostLoading";
import { ArrivalsBoard } from "./ArrivalsBoard";

export async function generateMetadata(): Promise<Metadata> {
  return { title: await hostPageTitle("arrivals") };
}

/** Arrivals (docs/designs/reclub-to-court/, h1-h6): the Reclub list and who has come. */
export default function ArrivalsPage() {
  return (
    <Suspense fallback={<HostLoading page="arrivals" />}>
      <ArrivalsContent />
    </Suspense>
  );
}

async function ArrivalsContent() {
  const hostAccess = await readHostAccess();
  // Fails closed: only hosts see the roster (the actions check again).
  if (hostAccess.status !== "host") return null;
  const initialRead = await readHostRoster();
  return <ArrivalsBoard initialRead={initialRead} />;
}
