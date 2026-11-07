import { redirect } from "next/navigation";
import { readHostAccess } from "@/server/auth/currentHost";
import { clubHasAnyHost } from "@/server/hosts/hostDirectory";
import { LoginForm } from "./LoginForm";

/** Reads the request (session cookie, hosts count), so it streams in behind Suspense. */
export async function LoginPanel() {
  // Anyone already signed in goes to the host area, which shows "not a host
  // here" to signed-in non-hosts.
  const hostAccess = await readHostAccess();
  if (hostAccess.status !== "signed_out") redirect("/");

  return (await clubHasAnyHost()) ? <LoginForm /> : <NoHostsYet />;
}

function NoHostsYet() {
  return (
    <>
      <h1
        id="login-heading"
        className="text-[32px] font-extrabold tracking-[-0.01em]"
      >
        No hosts yet
      </h1>
      <p className="text-muted">
        Nobody can sign in until the first admin exists. Whoever runs this app
        creates one from a terminal in the project folder:
      </p>
      <pre className="overflow-x-auto rounded-2xl border border-inner-border bg-inner p-3.5 text-sm text-text">
        <code>
          pnpm create-admin --email you@example.com --name &quot;Your name&quot;
        </code>
      </pre>
      <p className="text-sm text-muted">
        Then reload this page and sign in with that email. Full steps are in
        docs/auth.md.
      </p>
    </>
  );
}
