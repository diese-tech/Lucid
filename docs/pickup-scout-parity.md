# Pickup / Scout operator parity (#78)

## Baseline and deployment evidence

Audit date: 2026-10-09. Lucid baseline: `a8b35e59645e0c0f0d666b8dcee2031c9bdc92f3` (PR #79). Ratatoskr reference: `a266b8d808e6881ca042b0db5525fd07b454c52d`.

GitHub's commit status for the Lucid baseline records Railway context `heartfelt-love - Lucid`, state `success`, updated 2026-10-08T14:28:44Z, destination `lucid-production-e2d1.up.railway.app`. [Deployment record](https://railway.com/project/40ae1533-b171-461e-b2e1-8b68b4d48b39/service/f31dd459-b02e-4efb-b241-462a49cc1456?id=9fecf496-ea60-4a93-b01c-0a5481648630&environmentId=89f84014-d527-4496-839d-26885d1bb7c1). This establishes deployment of #79; it does not establish live acceptance of #78.

## Registered command inventory

Source: Lucid `src/discord/commands.ts`, `help.ts`, `router.ts`, and each named flow. Ratatoskr `src/commands/scout.ts`, `src/services/scoutAuthorization.ts`, `scoutCreate.ts`, `scoutCancel.ts`, `scoutReview.ts`, `scoutPublish.ts`, `scoutCoordination.ts`, `scoutFinish.ts`, and `scoutCardLifecycle.ts`.

| Lucid baseline command | Authority / behavior | Scout reference / classification |
| --- | --- | --- |
| `/help` | Any guild member; private guidance | `/help`; equivalent, operator guidance incomplete |
| `/pickup create` | Origin-channel Pickup Space staff or native Administrator; private format/role/eligibility/details/preview wizard | `/scout create division:<division>` in Scout Ops; intentional space/format difference |
| `/pickup cancel` | Current space staff or Administrator; open/ready pickup picker then confirmation | `/scout cancel`; equivalent intent, add consistent version-bound private confirmation |
| `/pickup config [timezone] [bind_emoji]` | Manage Server; guild timezone and reaction binding | `/scout config [timezone] [bind_emoji] [operations_channel]`; intentional infrastructure difference |
| `/pickup space create name:<name>` | Manage Server; independently configured space | Division/config provisioning; intentional Lucid model |
| `/pickup space edit space:<space>` | Manage Server; current space channels/roles/default eligibility | Division/config provisioning; intentional Lucid model |
| `/pickup space list` | Manage Server; guild's spaces | Division status; intentional Lucid model |
| `/pickup space delete space:<space>` | Manage Server; confirmation, refuses spaces with pickup history | Division archive/delete; preserve Lucid's stricter history rule |

Lucid has no manage/reopen command at baseline. Add `/pickup manage`; retain `/help` rather than creating a redundant help command.

## Complete interaction inventory by action family

Literal Lucid IDs below are from `src/discord/ids.ts`; routing is from `router.ts`. Selects carry stable IDs, not display names. Private continuation IDs are distinct from canonical persistent entry messages.

| Surface / source | Buttons, selects, modals (baseline IDs) | Checks / confirmations / parity action |
| --- | --- | --- |
| Create (`flows/create.ts`) | Format `cf`; role limit `crl`; eligibility role `cer`; details `cod` / modal `cdm`; post `cp`, overlap-confirm `cpa`, edit `ce`, cancel `cc` | Owner-bound temporary draft; space staff on each step; preview before post. Preserve format and overlap behavior. Draft expires on restart. |
| Config (`flows/config.ts`) | Bind emoji `cfgb`, optional Fill skip `cfgsf`; reaction sequence; timezone autocomplete | Manage Server; distinct custom guild emoji; preserve guild-wide config. |
| Spaces (`flows/spaces.ts`) | Channel `spc`, role `spr`, more `spm`, back `spb`, rename `spn` / modal `spnm`, delete `spd`, confirm `spdc`; space autocomplete | Manage Server each step; preserve existing history/routing constraints. |
| Staff draft (`flows/review.ts`) | Shuffle `sh`, edit `er`, swap teams by role `esw`, exchange any two assignments `ecr`, replace slot `ers`, slot `eps`, target `ept`, back `eb` | Entry checks `reviewMessageId`, current space staff, draft lifecycle/version. Baseline shuffle and final swap/target selection commit immediately: add exact proposal + explicit confirmation. Move version claim inside mutation/event transaction. |
| Manual seating (`flows/seat.ts`) | Entry `seat`, seat `seatps`, candidate `seatpp`, page `seatnp`, confirmation `seatc` | Open pickup only; eligible signed-up unseated member; off-role override warning; canonical staff entry. Preserve placement semantics; bind preview to expected version. |
| Publish (`flows/review.ts`) | Entry `pub`, confirm `pubc`, back `pubb`, repair `pubr` | Canonical staff entry; withdrawals/eligibility; destination preflight; #79 durable send/uncertainty/recovery. Preserve this state machine and freeze exact preview version. |
| Published replacement (`flows/replace.ts`) | Public entry `rep`, slot `reps`, bench `repb`, search `repse` / modal `repsm`, candidate `repc`, confirm `repcf` | Canonical `rosterMessageId`; private confirmation; eligible current member; emergency non-signup substitute supported. Baseline confirmation reloads latest version: bind the previewed version and atomically claim/write/event/notice. |
| Published swap (`flows/review.ts`) | Staff entry `pswp`, first `pswpf`, second `pswpc` | Canonical staff entry and published version claim; baseline final selection commits immediately. Add explicit confirmation; preserve player-following availability metadata. |
| Cancel (`flows/cancel.ts`) | Staff entry `can`, command picker `canp`, confirm `canc` | Canonical staff entry except command/private continuation; open/ready only; add preview version/context binding. |
| Finish (`flows/finish.ts`) | Public entry `fin`, staff entry `finst`, confirm `finc` | Each entry checks its own canonical message; published only; manual attribution; add preview version/context binding. Automatic T+3h finish remains unchanged. |
| Player availability (`flows/availability.ts`) | Public `una`, confirm `unac` | Canonical roster; currently seated actor; replacement-needed flag and organizer notification. Preserve player workflow. |
| Navigation (`components.ts`, `render.ts`) | Link buttons View Signup / View Roster / Manage Pickup / View Final Roster | Links confer no authority. Keep public links; new Manage entry opens a private workspace. |

## Reference differences and disposition

| Capability | Source evidence / disposition |
| --- | --- |
| Permanent staff workspace | Both bots have lifecycle cards. Lucid's healthy published card has only Finish; Swap appears only with replacement-needed seats, replacement is on the public roster. **Gap:** compact card + Manage, full private workspace, existing actions reachable regardless of warning. |
| Roster/candidate context | Lucid `renderControlCard`, `renderReviewCard`, `renderExpandedPublishedCard`; Ratatoskr `buildScoutWorkingRosterView`. **Equivalent:** partial/full roster, eligibility warnings, unseated candidates; carry them into workspace with bounded/paginated displays. |
| Authority | Lucid per-space roles + native Administrator; Ratatoskr named league roles + division Manager/Captain. **Intentional:** retain Lucid policy. Recheck current member and current space at confirmation. |
| Multi-game / hosts / organizer | Ratatoskr review expansion, coordination host/organizer selectors, ping confirmations. **Intentional:** no two-game expansion, hosts, division roles, seasonal rules, or command renames in Lucid. |
| Roster transactions | Both persist mutation events and delivery/notification work. **Gap:** ensure claims roll back with changes/events/intents; no UI-only authorization. |
| Publish recovery | Lucid #79 `publicationStatus`, marker search, Repair Delivery, startup reconciliation. **Equivalent required safeguard:** no second roster on ambiguous send; pending/uncertain freezes edits. |
| Restart | Both keep canonical records and recover message projections; creation drafts expire. **Gap:** reopen workspace from persistent staff card or command, while unsaved private proposals expire rather than mutate unseen state. |
| Help / errors | Lucid `/help` exists; Ratatoskr has domain-aware operational guidance. **Gap:** describe manage, lifecycle actions, permissions, retry vs repair, and saved-but-refresh-pending outcomes accurately. |

## Fluxcord fit assessment (assessment only)

Reference: [PhoenXHO/fluxcord](https://github.com/PhoenXHO/fluxcord), package source version 0.2.0; `README.md`, `docs/core-concepts/permission-gates.md`, `persistence.md`, `sessions-and-expiry.md`, `src/discord/platform.ts`, and `KNOWN_ISSUES.md`.

- Node >=22 matches Lucid's declared 22.x engine. Its discord.js peer floor is 14.25.1; Lucid currently declares ^14.16.3. Adoption must explicitly verify the lockfile peer version and align CI's older Node 20 leg. TSX would require compiler/include changes; plain builders are available.
- The existing Discord client can use `createUiBridge` plus the core runtime, avoiding a second bot/client or replacement command registrar. Namespace routing and keep public Lucid messages out of the Components V2 conversion.
- Flow/session ownership is not Pickup Space authorization. A custom policy and the operation layer must re-fetch current membership and space authorization per action; nearest control policies can override flow gates.
- Persistent panels can use an application-provided RehydrateStore. Ephemeral panels cannot rehydrate and have an absolute interaction ceiling; recovery must reopen from a persistent entry and reload canonical state, never replay an unsaved mutation.
- Costs: new pre-1.0 dependency, runtime/router integration, rendering/expiry tests, and documented bridge-wide queue/REST redraw constraints. SQLite remains canonical; no second roster database or reconciliation engine.
- **Decision:** no installation or migration in #78. Complete operator parity on existing discord.js components. Consider Fluxcord separately if a measured reduction in interaction plumbing justifies those costs. Lucid #76 vetting remains separate.

## Verification and release record

No live #78 acceptance has been performed at baseline. Do not close #78 based only on local tests or CI. Record local tests, PR CI, and disposable-space live results separately. Live checklist: both formats; two independently authorized spaces; lost permissions before/after publish preflight; recovery of original roster exactly once; expired/stale/unauthorized confirmations; restart; terminal read-only navigation; large benches and message limits.

Implementation inventory and tests will be recorded alongside the safeguards/workspace PRs. Ratatoskr is a read-only reference; no changes to its repository or live guild are part of this work.
