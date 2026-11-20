import { redirect } from "next/navigation";
import { getMessages } from "@/i18n/getLocale";
import type { Messages } from "@/i18n/messages";
import { readHostAccess } from "@/server/auth/currentHost";
import { installationHasAnyHost } from "@/server/hosts/hostDirectory";
import { LoginForm } from "./LoginForm";

/** Reads the request (session cookie, hosts count), so it streams in behind Suspense. */
export async function LoginPanel() {
  // Anyone already signed in goes to the host area, which shows "not a host
  // here" to signed-in non-hosts.
  const hostAccess = await readHostAccess();
  if (hostAccess.status !== "signed_out") redirect("/setup");

  return (await installationHasAnyHost()) ? (
    <LoginForm />
  ) : (
    <NoHostsYet messages={await getMessages()} />
  );
}

function NoHostsYet({ messages }: { messages: Messages }) {
  const text = messages.host.login.noHosts;
  return (
    <>
      <h1
        id="login-heading"
        className="text-[32px] font-extrabold tracking-[-0.01em]"
      >
        {text.title}
      </h1>
      <p className="text-muted">{text.text}</p>
      <pre className="overflow-x-auto rounded-2xl border border-inner-border bg-inner p-3.5 text-sm text-text">
        <code>
          pnpm create-social --name &quot;Your social&quot; --manager-email
          you@example.com --manager-name &quot;Your name&quot;
        </code>
      </pre>
      <p className="text-sm text-muted">{text.then}</p>
    </>
  );
}
