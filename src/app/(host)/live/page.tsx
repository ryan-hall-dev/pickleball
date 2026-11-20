import type { Metadata } from "next";
import { Suspense } from "react";
import { hostPageTitle } from "@/i18n/getLocale";
import { HostLoading } from "../HostLoading";
import { readLiveSession } from "@/server/live/liveActions";
import { LiveSession } from "./LiveSession";

export async function generateMetadata(): Promise<Metadata> {
  return { title: await hostPageTitle("live") };
}
export default function LivePage() {
  return (
    <Suspense fallback={<HostLoading page="live" />}>
      <LiveContent />
    </Suspense>
  );
}
async function LiveContent() {
  const initialResult = await readLiveSession();
  return (
    <LiveSession
      key={
        initialResult.ok && initialResult.status === "session"
          ? initialResult.session.sessionId
          : "no-live-session"
      }
      initialResult={initialResult}
    />
  );
}
