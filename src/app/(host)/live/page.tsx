import type { Metadata } from "next";
import { Suspense } from "react";
import { readLiveSession } from "@/server/live/liveActions";
import { LiveSession } from "./LiveSession";

export const metadata: Metadata = {
  title: "Live courts · Pickleball Social Manager",
};
export default function LivePage() {
  return (
    <Suspense
      fallback={
        <p className="text-muted" role="status">
          Loading live courts…
        </p>
      }
    >
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
