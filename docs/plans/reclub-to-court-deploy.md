# Reclub to court v1 · deploy steps

Status: **awaiting Ryan's approval. Nothing here has been run.**

Release: commit `576b78f` (branch `codex/reclub-to-court-v1`), five database migrations (`20261126090000` to `20261126150000`) and the app. No new environment variables or secrets.

## Before you approve

- Pick a time with **no social running** and none due for a few hours.
- Know what changes for hosts: socials started after the release use the new flow (phones confirm, Up next, scores). Earlier sessions are unchanged.
- Not yet checked: real phones, dark mode and tablet on the new screens, Vietnamese wording.

## Steps

Stop at the first unexpected result.

| #   | Who           | Step                                                                                                                                                                         | Must see                      |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | Claude        | Clean export of `576b78f` into a new folder under `/private/tmp`; install; lint, typecheck, build                                                                            | All pass                      |
| 2   | Ryan + Claude | Link that folder to the **pilot** database and the `pickleball-pilot` Vercel project. Ryan types any password; confirm the database is the pilot one and not the old project | Right project named           |
| 3   | Claude        | `pnpm exec supabase migration list`                                                                                                                                          | Exactly these five pending    |
| 4   | Claude        | Back up the pilot database (schema and data) to a private folder outside the repository. It contains players' names                                                          | Both files non-empty          |
| 5   | Claude        | Restore that backup into a throwaway local database (never the working one), apply the five migrations, compare row counts and replay the old session logs                   | Counts unchanged, logs replay |
| 6   | Claude        | `pnpm exec supabase db push`                                                                                                                                                 | Five applied                  |
| 7   | Claude        | `vercel deploy --prod` from the export folder                                                                                                                                | Deployment ready              |
| 8   | Claude        | Load the sign-in page and the check-in page; no sign-in, no test players                                                                                                     | Both load                     |
| 9   | Ryan          | Sign in, create a test social session, run the real-phone checklist in the plan                                                                                              | Your call                     |

If step 5 can't be done cleanly, I stop and tell you before touching the pilot database.

## If something goes wrong

- **App:** `vercel promote <URL of pickleball-pilot-9y4667qo9>` returns to today's version. The database changes only add things, so today's app works with them; leave them in place.
- **Catch:** today's app cannot read a session started with the new flow. **End any such session before going back**, otherwise the live screen shows an error until a new session starts.
- **Database:** restoring the backup is a last resort, and needs your separate approval.

## Approval

Reply "approve the deploy of 576b78f" to run steps 1 to 8. Pushing the branch stays with you.
