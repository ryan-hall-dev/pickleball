# 0003 — Socials as independent communities at a shared venue

Status: **proposed** (assessment, 2026-11-09). Not implemented. Needs Ryan's answers to the open questions, then a plan (`docs/plans/socials.md`) before M5.

## Business model (Ryan, 2026-11-09)

- A **venue** is the physical facility. It can host several independent **socials** (e.g. Pickleball Riverside, Riverside Morning Social, Riverside Competitive Social).
- Each social has its own **Social Manager**, who names it, configures it, builds its community and appoints its **operational hosts**. The roles are not interchangeable.
- Each social has its own **members directory**, sessions, attendance, saved setups, history and check-in. Nothing is shared between socials because they use the same venue.
- A player may belong to several socials, but as an independent member of each; nothing about them is shared automatically.
- Operational hosts of one social **co-run one session together**.

## How the app works today

The app was built for one club per installation:

| Area                             | Today                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Tenancy                          | None. Every table is installation-wide. `private.is_host()` lets any host read every row (RLS)             |
| Roles                            | `hosts.role` = `admin` or `host`, installation-wide. Admins invite and remove hosts and add courts         |
| Name                             | Single-row `club_settings.club_name` (unused)                                                              |
| Members, member phones           | One directory for the installation                                                                         |
| Courts                           | One list for the installation (admins add)                                                                 |
| Sessions                         | Belong to the host who created it (`sessions.host_id`); only that host edits the draft; one draft per host |
| Check-in                         | Per-host sticker tag → that host's open session; search covers the whole directory                         |
| Saved setups                     | Private to the host who saved them                                                                         |
| Live actions, check-in approvals | Any host, any session                                                                                      |

## Gaps against the model

1. **Data isolation (critical).** A host of social A can read social B's members, sessions, attendance and check-ins through RLS today. Every table needs a social owner, and every policy and write function must check the actor's role _in that social_.
2. **Member ownership.** `members` needs `social_id`. Check-in search, duplicate-name checks and phone recognition (`member_devices`) must be scoped to the social. A phone used at two socials links to a separate member in each.
3. **Roles per social.** Replace the installation-wide `hosts.role` with a membership table: (user, social, role = `manager` | `host`). Today's "admin" maps to Social Manager _within a social_.
4. **Sessions belong to the social,** not to one host. Any host of the social can edit the draft (the M4.4 optimistic concurrency already protects co-editing) and run it live. The pending tray shows the social's requests to all its hosts.
5. **Check-in routing.** A sticker should open _the social's_ open session, so a player can tap either host's sticker (or a single social sticker).
6. **Saved setups, history** move to the social.
7. **Courts are physical,** so they belong to the venue and are shared. Two socials running at once must not both use the same court.
8. **Who creates socials and appoints Social Managers** has no home today: it needs a venue-level role.
9. **Signing in:** a person in several socials must choose which social they are working in; every screen and action carries that social.

## Impact

This touches every table, every RLS policy, every write function and server action, and most tests (pgTAP, integration, e2e). It's best done **before M5**: M5's check-in routing, search scope and pending tray all depend on it, and building them single-tenant first would mean redoing them. The local and dev data can be migrated into one default social, since nothing is in production yet.

## Open questions for Ryan

1. Is one installation one venue, or must it hold several venues?
2. Who creates a social and appoints its Social Manager (a venue administrator, or self-service sign-up)?
3. Can one person be a host or manager in more than one social?
4. Who manages the venue's courts, and should the app stop two socials booking the same court at the same time?
5. One sticker per social, or one per host (each opening the social's open session)?
6. Can a social run more than one session at the same time?
