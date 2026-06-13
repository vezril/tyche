# PRD: Self-Hosted YNAB Replacement ("Tyche")

| | |
|---|---|
| **Status** | **Approved** — Gate 1 passed 2026-06-12 (Calvin). AS-1/AS-2 confirmed; OQ-1, OQ-4, OQ-5, OQ-6 resolved (see §10). OQ-2 remains an action item before sync work is scheduled. |
| **Author** | requirements-analyst (claude-toolkit SDLC) |
| **Date** | 2026-06-12 |
| **Inputs** | `docs/analysis/ynab-usage.md` (live YNAB plan pull), `docs/analysis/plaid-feasibility.md` (verdict: feasible-with-caveats) |
| **Downstream** | `docs/architecture.md` (solution-architect), story files (spec-driven-development) |

---

## 1. Vision

Calvin pays for YNAB to run a zero-based envelope budget against his RBC accounts. He wants to stop paying and stop depending on a SaaS he doesn't control — without giving up the budgeting model or the quality of the experience. This product is a **self-hosted, single-user replacement for YNAB** that reproduces the envelope/zero-based budgeting workflow he actually uses today (monthly assignment from Ready to Assign, per-category activity and rollover, on-budget and tracking accounts), keeps his financial data on his own hardware, and feeds the transaction register automatically from RBC via Plaid — with a manual file-import fallback for the days Plaid↔RBC inevitably breaks. Success looks like: Calvin cancels his YNAB subscription and doesn't miss it.

## 2. Target User & Jobs-to-be-Done

**Persona: Calvin — the self-hosting budgeter.** One person, one household budget, one bank (RBC), currency CAD. Comfortable operating Docker services on a home server. Experienced YNAB user (~31 categories in ~9 groups across 5 accounts); the YNAB mental model is fully internalized — the product must match it, not re-educate him.

Jobs-to-be-done (the progress he's hiring this product to make):

- **JTBD-1 — Give every dollar a job.** When money arrives, assign all of it to categories so the plan is zero-based and intentional.
- **JTBD-2 — Know what I can spend right now.** Before a purchase, see the category's *available* amount and trust it reflects reality.
- **JTBD-3 — Keep the ledger true without typing everything.** Get bank transactions into the register with minimal manual effort, and reconcile against the bank so the numbers are believed.
- **JTBD-4 — Own my financial data.** Keep years of transaction and budget history on hardware I control, exportable at any time, surviving hardware failure via backups.
- **JTBD-5 — Stop paying rent on my budget.** Replace the YNAB subscription at near-zero recurring cost (Plaid Trial plan: $0 expected).

## 3. Key User Journeys

- **UJ-1 — Initial setup & migration.** Calvin deploys the app on his home server, creates his budget, recreates (or imports) his account/category structure and YNAB history, links his RBC login via Plaid, and lands on a budget screen that matches his last YNAB state. *(FR-30..34, FR-20)*
- **UJ-2 — Payday assignment.** Income lands in a chequing account (via sync or manual entry); Ready to Assign increases; Calvin opens the month grid and assigns the new money across categories until Ready to Assign is $0. *(FR-1..6)*
- **UJ-3 — Transaction review.** Every day or two, Calvin opens the app, sees newly synced RBC transactions awaiting approval, confirms/edits payee and category for each, and approves them; category activity and available amounts update immediately. *(FR-13..16, FR-20..23)*
- **UJ-4 — Spending check.** Standing in a store, Calvin opens the app on his phone's browser and checks a category's available balance before buying. *(FR-2, NFR-1, NFR-9)*
- **UJ-5 — Covering an overspend.** Groceries goes negative; Calvin moves money from another category (or accepts the overspend and lets month rollover handle it per the defined rollover rule). *(FR-5..7)*
- **UJ-6 — Sync breaks; life goes on.** A sync attempt returns a "re-authentication required" condition. The app surfaces the broken connection prominently; Calvin either re-links through Plaid's update flow, or downloads an OFX/CSV from RBC online banking and imports it manually with duplicate-safe matching. *(FR-24..28)*
- **UJ-7 — Month rollover.** A new month begins; positive category balances carry forward, overspends are handled per the rollover rule, and the new month is ready for assignment. *(FR-8)*
- **UJ-8 — Reconciliation.** Calvin compares an account's cleared balance against RBC's reported balance, marks transactions cleared, resolves discrepancies (creating an adjustment if needed), and locks the account as reconciled as of that date. *(FR-17..18)*
- **UJ-9 — Operator care & feeding.** Calvin backs up the system with one command, tests a restore on another machine, and upgrades the app version without losing data. *(FR-35..36, NFR-5..7, NFR-11)*

## 4. Glossary

| Term | Definition |
|---|---|
| **Zero-based / envelope budgeting** | Every dollar of available money is assigned to a category ("envelope") until none remains unassigned. Spending is judged against the category's available balance, not the account balance. |
| **Ready to Assign (RTA)** | The pool of on-budget money not yet assigned to any category. Income to on-budget accounts flows here; assigning to categories draws it down. Target state each month: $0. |
| **Category** | A named envelope (e.g., Groceries, Rent) that holds assigned money and accumulates activity. |
| **Category group** | A named, ordered grouping of categories for display and subtotals (e.g., "Fixed Bills", "Fun Money"). |
| **Assigned (budgeted)** | The amount of money allocated to a category in a given month. |
| **Activity** | The net sum of transaction amounts categorized to a category within a given month. |
| **Available (category balance)** | What's left to spend in a category: `carryover from prior month + assigned this month + activity this month`. May be negative (overspent). |
| **Overspend** | A category whose available balance is negative within a month. |
| **Overspend rollover** | What happens to a negative category balance at month boundary. YNAB's cash-overspend rule: the negative amount does **not** carry in the category; it is deducted from the next month's Ready to Assign, and the category restarts at $0. (See AS-1 — the MVP replicates this rule.) |
| **Month rollover** | The transition between budget months: positive available balances carry forward into the next month's carryover; overspends are handled per the overspend-rollover rule. |
| **On-budget account** | An account whose balance participates in the budget: its inflows feed RTA and its outflows must be categorized (e.g., chequing, savings). |
| **Tracking account** | An off-budget account whose balance is recorded for net-worth visibility only (e.g., TFSA). Its transactions never affect RTA or category balances. |
| **Transfer** | A paired transaction moving money between two accounts in the budget. On-budget↔on-budget transfers need no category; transfers involving a tracking account are treated as categorized outflow/inflow on the on-budget side. |
| **Cleared** | A transaction the bank has confirmed (settled). Cleared balance is the sum of cleared transactions in an account. |
| **Reconciled** | A cleared transaction locked during reconciliation, asserting the app's cleared balance matched the bank's actual balance at a point in time. |
| **Approval** | Imported transactions enter a pending review state; the user confirms category/payee before they count as reviewed. |
| **Payee** | The counterparty of a transaction (e.g., "Loblaws"). Used for display, search, and category suggestions. |
| **Split transaction** | A single transaction whose amount is divided across multiple categories. |
| **Plaid** | Third-party data aggregator providing API access to RBC account/transaction data. The only external service the system talks to. |
| **Item** | Plaid's unit of a bank connection: one set of login credentials at one institution. One RBC login = one Item. The Plaid Trial plan allows up to 10 live Items. |
| **Plaid Link / update mode** | Plaid's hosted widget for connecting (or, in *update mode*, re-authenticating) a bank login. Produces a public token the backend exchanges for a long-lived access token. |
| **Access token / sync cursor** | Per-Item secrets/state the backend holds: the access token grants ongoing read access to bank data (must be encrypted at rest); the cursor marks the position in Plaid's incremental transaction sync stream. |
| **`ITEM_LOGIN_REQUIRED`** | Plaid error meaning the bank connection broke (e.g., RBC changed its auth flow) and the user must re-link via update mode. Expected to happen periodically with RBC. |
| **OFX / QFX / CSV import** | Manual fallback: files exported from RBC online banking (rolling ~90-day window) and uploaded into the app. |

## 5. Functional Requirements

Convention: each FR states the behavior and a testable consequence ("Verified by"). Priorities: **[MVP]** or **[P2]** (post-MVP phase); see §8 for the cut.

### Budgeting (the month grid)

- **FR-1 [MVP]** The system shall maintain a monthly budget where each (category, month) pair has an assigned amount, activity, and available balance, with `available = prior-month carryover + assigned + activity`. *Verified by: given a category with $50 carryover, $200 assigned, and −$120 activity in a month, the displayed available is $130.*
- **FR-2 [MVP]** The system shall provide a month-grid budget screen showing, per category and per category group (with group subtotals), the assigned, activity, and available amounts for a selected month, with navigation to any past or future month. *Verified by: opening any month renders all ~31 categories grouped into their ~9 groups with correct per-group subtotals.*
- **FR-3 [MVP]** The system shall compute and prominently display Ready to Assign for the selected month: on-budget inflows categorized to RTA, minus total assigned across all months up to and including the selected month, per the overspend-rollover rule (AS-1). *Verified by: entering a $1,000 income inflow raises RTA by exactly $1,000; assigning $1,000 across categories returns RTA to its prior value.*
- **FR-4 [MVP]** The system shall allow assigning money to (and unassigning from) any category for any month via direct cell editing in the month grid, persisting on commit. *Verified by: editing a category's assigned value updates RTA and the category's available in the same interaction, and the value survives a page reload.*
- **FR-5 [MVP]** The system shall support moving available money directly from one category to another within a month, recorded as paired assignment adjustments. *Verified by: moving $50 from Category A to B decreases A's available by $50, increases B's by $50, and leaves RTA unchanged.*
- **FR-6 [MVP]** The system shall warn (not block) when Ready to Assign is negative (over-assigned) or positive (unassigned money), so the zero-based target is visible. *Verified by: assigning more than RTA turns the RTA indicator into a distinct negative/warning state.*
- **FR-7 [MVP]** The system shall permit category available balances to go negative (overspending) without blocking transaction entry. *Verified by: categorizing a transaction larger than the category's available results in a negative available displayed in a distinct overspent style (matches observed usage: Groceries −$138.93).*
- **FR-8 [MVP]** At each month boundary the system shall carry positive category balances forward as the next month's carryover and apply the overspend-rollover rule (AS-1: cash overspends reset the category to $0 and deduct from next month's RTA). *Verified by: a category ending June at −$40 shows $0 carryover in July and July's RTA is $40 lower than it would otherwise be; a category ending June at +$40 shows $40 carryover in July.*
- **FR-9 [MVP]** The system shall support creating, renaming, reordering, hiding, and deleting categories and category groups; deleting a category with history shall require reassigning its transactions to another category. *Verified by: a category with transactions cannot be deleted without choosing a target category, and afterwards all its transactions report the target category.*

### Accounts & register

- **FR-10 [MVP]** The system shall support both on-budget accounts (chequing, savings) and off-budget tracking accounts, where tracking-account activity never affects RTA or category balances. *Verified by: recording a $500 inflow to the TFSA tracking account changes that account's balance and net worth, but no category or RTA value changes.*
- **FR-11 [MVP]** The system shall support creating an account with a starting balance and closing an account while preserving its transaction history. *Verified by: a closed account disappears from active lists but its transactions remain visible in history and reports.*
- **FR-12 [MVP]** The system shall maintain at least the five account shapes in current use (multiple chequing, one savings, one tracking asset account), with per-account working and cleared balances. *Verified by: recreating the analysis-document account structure yields five accounts whose balances equal the sum of their transactions plus starting balance.*
- **FR-13 [MVP]** The system shall provide a per-account register listing transactions with date, payee, category, memo, outflow/inflow amount, cleared status, and approval status, sortable and filterable by date range, payee, category, and free-text search. *Verified by: searching a payee substring returns exactly the matching transactions in the account.*
- **FR-14 [MVP]** The system shall support manual creation, editing, and deletion of transactions, including future-dated entries. *Verified by: a manually entered transaction appears in the register and adjusts account, category, and RTA values per its categorization.*
- **FR-15 [MVP]** The system shall support split transactions dividing one transaction's amount across multiple categories, with the split lines required to sum to the transaction total. *Verified by: saving a split whose lines don't sum to the total is rejected with a clear message; a valid split posts each line's amount to its category's activity.*
- **FR-16 [MVP]** The system shall support transfers between accounts as paired, linked transactions (editing/deleting one side updates or removes the other), including on-budget↔tracking transfers categorized on the on-budget side. *Verified by: a $200 transfer from Spending to Savings changes both balances and leaves RTA and categories untouched; a $200 transfer from chequing to TFSA requires a category and reduces it by $200.*
- **FR-17 [MVP]** The system shall track a cleared/uncleared/reconciled state per transaction and display per-account cleared vs working balances. *Verified by: toggling a transaction's cleared flag moves its amount between the uncleared and cleared balance figures.*
- **FR-18 [MVP]** The system shall provide an account reconciliation flow: the user enters the bank's actual balance; the system compares it to the cleared balance, offers a balance-adjustment transaction for any difference, and locks all cleared transactions as reconciled. *Verified by: after reconciling, reconciled transactions require explicit confirmation to edit, and the post-reconciliation cleared balance equals the entered bank balance.*
- **FR-19 [MVP]** The system shall maintain a payee list built from entered/imported transactions, offering autocomplete and remembering the last category used per payee as the default suggestion. *Verified by: after categorizing "Loblaws" to Groceries once, the next "Loblaws" transaction pre-suggests Groceries.*

### Bank import — Plaid sync and manual fallback

- **FR-20 [MVP]** The system shall let the user link an RBC bank login through Plaid's Link flow and map each discovered bank account to an app account (or skip it). *Verified by: completing Link in Plaid's sandbox creates an Item whose accounts are individually mappable; unmapped accounts produce no transactions.*
- **FR-21 [MVP]** The system shall fetch transactions incrementally from Plaid on an automatic schedule (polling; no inbound/public URL required) and on user-initiated manual refresh, applying added, modified, and removed transactions from the sync stream. *Verified by: with the scheduler running, a transaction added in Plaid sandbox appears in the register within one polling interval (NFR-4) without any user action; a transaction removed upstream is removed or voided in the register.*
- **FR-22 [MVP]** Imported transactions shall enter the register as unapproved, and the system shall provide a review queue to approve, recategorize, edit, or reject them; unapproved transactions are visibly distinct. *Verified by: a synced transaction shows in the review queue and does not lose its imported amount/date when the user edits only its category.*
- **FR-23 [MVP]** The system shall match incoming imported transactions against existing register transactions (e.g., a manual entry for the same purchase, or a prior file import of the same period) and merge matches instead of duplicating, with a user-visible way to unmatch. *Verified by: importing a file overlapping an already-synced period creates zero duplicate transactions; a manually entered $43.10 transaction matches the synced bank copy and the register shows one transaction.*
- **FR-24 [MVP]** The system shall support manual import of RBC-exported OFX/QFX and CSV files into a chosen account, passing through the same review and duplicate-matching pipeline as Plaid sync. *Verified by: importing a real RBC CSV export populates the review queue with correctly parsed dates, payees, and signed amounts.*
- **FR-25 [MVP]** The system shall treat Plaid sync and file import as interchangeable feeds for the budget: all budget math (FR-1..8) is independent of how a transaction arrived. *Verified by: an identical transaction entered manually, via file import, or via sync produces identical category/RTA effects.*
- **FR-26 [MVP]** When a sync attempt fails because the bank connection requires re-authentication (e.g., Plaid `ITEM_LOGIN_REQUIRED`), the system shall mark the connection broken, surface a prominent persistent banner with the last-successful-sync time, and offer re-link via Plaid Link update mode. *Verified by: simulating the error in sandbox flips the connection status to "needs attention," shows the banner, and completing update mode clears it and resumes sync without re-mapping accounts.*
- **FR-27 [MVP]** The system shall display sync health per connection: last attempt, last success, and outcome of recent attempts. *Verified by: after a failed poll, the connection detail view shows the failure and timestamp.*
- **FR-28 [MVP]** The system shall allow unlinking a bank connection, which revokes/discards its access token and stops syncing while preserving all already-imported transactions. *Verified by: after unlinking, no further sync attempts occur for that Item and the register history is intact.*
- **FR-29 [P2]** The system shall import account balances from Plaid for linked tracking accounts (e.g., TFSA) and offer one-click balance-adjustment transactions to true them up. *Verified by: when the linked TFSA balance differs from the app's, an adjustment suggestion equal to the difference is offered.* (MVP: tracking balances maintained manually — AS-9.)

### Migration from YNAB

- **FR-30 [MVP]** The system shall import Calvin's existing YNAB data — accounts, category groups/categories, payees, full transaction history (including splits and transfers), and per-month assigned amounts — from YNAB's export format and/or an API pull, to the extent the source data allows (AS-4). *Verified by: after migration, each account's working balance and each category's current-month available match the values in YNAB on migration day, to the cent.*
- **FR-31 [MVP]** The migration shall be idempotent or safely re-runnable into an empty budget, and shall produce a discrepancy report listing anything it could not map. *Verified by: running the import twice from scratch yields identical results; unmappable rows appear in the report rather than being silently dropped.*
- **FR-32 [MVP]** The system shall store and compute all amounts in CAD with exact decimal precision (no binary floating-point money). *Verified by: summing 10,000 randomly generated transactions matches the same sum computed externally with decimal arithmetic, exactly.*

### Administration & data ownership

- **FR-33 [MVP]** The system shall require authentication (single user account with a password) before any budget data or API is accessible. *Verified by: every page and API endpoint returns an auth challenge/redirect when accessed without a valid session.*
- **FR-34 [MVP]** The system shall provide settings to manage the Plaid credentials (client ID/secret), the polling schedule, and the user's password. *Verified by: changing the polling interval takes effect without redeploying.*
- **FR-35 [MVP]** The system shall support a full backup as a single artifact and a documented restore that reproduces the complete state (transactions, budget months, connections' metadata, settings), executable with one command each. *Verified by: backup on host A, restore on host B, and a scripted comparison shows identical balances, RTA, and transaction counts; the restored instance can resume Plaid syncing after at most a re-link.*
- **FR-36 [MVP]** The system shall export all transactions and the monthly budget (assigned/activity/available per category per month) to CSV on demand. *Verified by: the exported register row count equals the register's transaction count and re-totaling the CSV reproduces account balances.*
- **FR-37 [P2]** The system shall provide basic reports: spending by category and by payee over a date range, income vs expense by month, and net worth over time (including tracking accounts). *Verified by: the spending-by-category total for a date range equals the sum of matching register transactions.*
- **FR-38 [P2]** The system shall support scheduled/recurring transactions that auto-enter the register on their date. *(Not in current YNAB use — see usage analysis; deferred.)*
- **FR-39 [P2]** The system shall support category targets/goals (monthly funding targets with progress display). *(Usage unconfirmed — OQ-3.)*

## 6. Non-Functional Requirements

Each NFR is quantified and carries a verification method. These become the architecture characteristics.

- **NFR-1 — Performance (interactive).** With 5 years of history (≥10,000 transactions, ≥40 categories, 60 budget months): month-grid budget screen reaches usable render in **< 1 s** and an account register (latest 100 rows) in **< 1 s** on a desktop browser over LAN; editing an assigned amount or approving a transaction reflects in the UI in **< 200 ms** perceived. *Verify: seeded-data performance test measuring p95 over 20 loads.*
- **NFR-2 — Data residency.** No budget, transaction, or credential data leaves the host **except** outbound calls to Plaid's API and the user's browser loading the Plaid Link widget during link/re-link. No telemetry, analytics, CDN-hosted app assets, or third-party fonts at runtime. *Verify: network capture during 24 h of normal use (excluding link flows) shows outbound connections to Plaid endpoints only.*
- **NFR-3 — Secrets at rest.** Plaid access tokens and the Plaid client secret are encrypted at rest (not stored in plaintext in the database, files, or logs); no secret ever appears in application logs. *Verify: grep of database dump, volume files, and 30 days of logs finds no plaintext token/secret material.*
- **NFR-4 — Sync freshness.** Automatic polling runs at a configurable interval, default **every 6 hours** (≈4×/day, within Plaid's ~daily institution refresh cadence); a healthy connection is never more than one interval stale, and the UI always shows last-success time so staleness is visible. *Verify: scheduler logs over 7 days show ≥ 95% of scheduled polls executed within 10 minutes of their slot.*
- **NFR-5 — Deployability.** The entire system deploys on a home server with **one `docker compose up -d`** from a documented compose file; first-run setup (admin password, Plaid keys) is completable in **≤ 30 minutes** by following the README, with no public/inbound URL, domain, or port-forwarding required. *Verify: clean-machine install test against the README, timed.*
- **NFR-6 — Resource footprint.** Steady-state usage ≤ **1 GB RAM** and ≤ **5% average CPU** of a modest home server; disk growth ≤ **1 GB/year** at Calvin's transaction volume. *Verify: container stats sampled over 7 days of normal use.*
- **NFR-7 — Durability & recovery.** A committed transaction or budget edit survives an immediate hard container/host restart (zero acknowledged-write loss); backups (FR-35) are restorable with **RPO ≤ 24 h** (daily backup-able) and **RTO ≤ 1 h** following the documented procedure. *Verify: kill -9 test after writes; quarterly restore drill.*
- **NFR-8 — Availability.** Best-effort single-host service: target **≥ 99% monthly availability** (≈ ≤ 7 h downtime/month is acceptable); the system self-recovers (auto-restart, no manual steps) after host reboot or power loss. *Verify: pull the plug on the host; service is reachable without intervention after boot.*
- **NFR-9 — Usability bar.** The web UI is comparable to YNAB for the core loops: assigning a month's money (UJ-2) and reviewing/approving a day's transactions (UJ-3) each take **≤ 2 minutes** of interaction for a typical day, with full keyboard-driven entry in the register and budget grid; responsive layout is usable on a phone-sized viewport (≥ 380 px) for UJ-3 and UJ-4. *Verify: timed task walkthroughs by Calvin against the same tasks in YNAB.*
- **NFR-10 — Security posture.** Designed for LAN/VPN exposure (AS-2): authenticated sessions expire after a configurable idle period (default 30 days, this is a trusted network); login is rate-limited (≥ 5 failures → ≥ 1-minute lockout); all credentials stored using a modern password hash. *Verify: automated auth tests; config inspection.*
- **NFR-11 — Upgradability.** Upgrading to a new app version is `docker compose pull && up -d`; data migrations run automatically and are backward-protected by the pre-upgrade backup (FR-35); an upgrade never silently alters historical balances. *Verify: upgrade test from previous release with a balance-checksum comparison before/after.*
- **NFR-12 — Auditability of money math.** Every balance shown (account, category, RTA) is recomputable from raw transactions + assignments; a built-in consistency check verifies stored aggregates against recomputation. *Verify: consistency check passes on the migrated dataset and after 30 days of use.*

## 7. Non-Goals

Explicitly out of scope (any of these returning to scope requires a PRD revision):

- **NG-1 — Multi-user / shared budgets / multiple budgets.** One user, one budget. No roles, invitations, or concurrent-editor semantics.
- **NG-2 — Multi-currency.** CAD only. No FX handling.
- **NG-3 — Credit card accounts and YNAB's credit-card payment mechanics.** The live plan has no credit card accounts; the dedicated credit-overspend/payment-category machinery is not built. (Confirm: OQ-6.)
- **NG-4 — Native mobile apps.** Responsive web only; no iOS/Android apps, no offline mode, no push notifications.
- **NG-5 — Public SaaS posture.** No public-internet hardening beyond NFR-10, no multi-tenant design, no horizontal scaling, no email/notification infrastructure.
- **NG-6 — Investment tracking beyond balances.** Tracking accounts hold balances/transactions only; no holdings, positions, or market-price syncing.
- **NG-7 — Loan planner, age-of-money, advanced YNAB analytics.** Not in observed use.
- **NG-8 — Bank aggregators other than Plaid, and banks other than RBC, in MVP.** The import abstraction (FR-25) keeps the door open; building additional integrations does not happen now.
- **NG-9 — Payment initiation.** Read-only with respect to the bank: the system never moves real money, only records it.

## 8. MVP Scope Cut

**Release gate for MVP:** Calvin runs his real June/July 2026 budget in this system in parallel with YNAB for one full month, and the numbers agree (SM-1).

| Phase | Contents |
|---|---|
| **MVP** | Budget engine & month grid (FR-1..9); accounts, register, splits, transfers, cleared/reconcile, payees (FR-10..19); Plaid link + polling sync + review/approval + duplicate matching + re-link handling (FR-20..28); OFX/CSV fallback import (FR-24); YNAB migration (FR-30..32); auth, settings, backup/restore, CSV export (FR-33..36); all NFRs. |
| **Phase 2** | Reports (FR-37); Plaid tracking-account balance true-up (FR-29); scheduled transactions (FR-38); category targets (FR-39); quality-of-life (bulk edit, category-spend drill-down from the grid). |
| **Later / icebox** | Anything in §7 Non-Goals that gets re-justified; additional importer backends; multi-device sync conveniences. |

Rationale: the usage analysis shows the month grid is the core surface, the register second, reports later; scheduled transactions and goals are not in active use. MVP therefore is exactly "the YNAB Calvin actually uses, plus the import resilience the feasibility report says he'll need."

## 9. Success Metrics (with counter-metrics)

- **SM-1 — Parity month.** During a one-month parallel run, end-of-month RTA, every category available, and every account balance match YNAB within $0.01. *(Validates FR-1..19, FR-30..32.)*
  - **Counter-metric:** time spent reconciling the two systems ≤ 1 h total for the month — parity must not be achieved by constant manual fixing.
- **SM-2 — Subscription cancelled.** Calvin cancels YNAB within 2 months of MVP go-live and is still actively budgeting in the clone (≥ 3 sessions/week) 3 months later. *(Validates the vision.)*
  - **Counter-metric:** budgeting engagement does not degrade — transactions are approved within ≤ 4 days of posting, ≥ 90% of weeks (no "abandoned budget" failure mode).
- **SM-3 — Import mostly hands-off.** ≥ 80% of weeks require zero manual file imports (Plaid sync + re-link suffices); when sync does break, recovery (re-link or file import) takes ≤ 15 minutes. *(Validates FR-20..28, NFR-4.)*
  - **Counter-metric:** duplicate or missing transactions discovered at reconciliation ≤ 1 per month — automation must not corrupt the register.
- **SM-4 — Ops burden stays hobby-sized.** Total operations time (upgrades, backups, debugging) ≤ 30 minutes/month after the first month; recurring cash cost ≤ $5/month (expected $0 on Plaid Trial). *(Validates NFR-5..8, NFR-11.)*
  - **Counter-metric:** zero data-loss incidents; a restore drill passes each quarter.

## 10. Assumptions & Open Questions

Calvin could not be interviewed for this draft. Each ambiguity below was resolved with a recorded assumption (AS-N) rather than silently; all AS items require confirmation at the PRD gate, and OQ items genuinely need his answer.

### Assumptions

- **AS-1 — Overspend rollover follows YNAB's cash rule.** Negative category balances reset to $0 at month boundary and reduce next month's RTA (they do not carry as negative category balances). Chosen because the goal is YNAB familiarity and all his accounts are cash accounts. *(Affects FR-3, FR-8.)*
- **AS-2 — LAN/VPN access only; no public internet exposure.** Security requirements (NFR-10) are scoped to a trusted home network (optionally a personal VPN like Tailscale for UJ-4 away from home). If he wants the app reachable from the open internet, NFR-10 must be substantially strengthened.
- **AS-3 — Single budget, single user, CAD-only is sufficient permanently for MVP** (per usage analysis); no second household member needs access.
- **AS-4 — YNAB's standard data export (plus optionally an API pull while the subscription is live) is an acceptable migration source**, accepting that some derived history (e.g., exact past RTA snapshots) may be reconstructed rather than imported verbatim, as long as FR-30's balance-parity check passes for the migration-day state.
- **AS-5 — Split transactions and reconciliation are MVP**, even though the usage pull couldn't directly observe them — both are core to the YNAB register workflow and cheap to confirm.
- **AS-6 — Plaid Trial plan is the access path** ($0, ≤ 10 Items, no security questionnaire), and Calvin's 1–2 RBC Items fit comfortably under the cap; outgrowing it (paid Production) is acceptable at the estimated ~$0.30–$0.60/Item/month.
- **AS-7 — Polling freshness of ~6 hours is acceptable**; he does not need near-real-time transaction visibility, so no public webhook endpoint is required (per the feasibility report).
- **AS-8 — The home server runs Docker (linux, amd64 or arm64)** with ≥ 2 GB RAM available and persistent disk; "must run via docker-compose on this box" is a genuine constraint (NFR-5), not a solution choice.
- **AS-9 — The TFSA tracking account is maintained with occasional manual balance adjustments in MVP** (Plaid-driven true-up deferred to FR-29/P2), since tracking accounts don't affect budget math.
- **AS-10 — RBC's auth flakiness is tolerable given the fallback.** Per the feasibility report, periodic `ITEM_LOGIN_REQUIRED` re-links and occasional reliance on OFX/CSV import are accepted operating conditions, not defects — hence FR-24/FR-26 are MVP, not nice-to-haves.

### Open Questions

- **OQ-1 — RESOLVED (gate, 2026-06-12):** strict YNAB cash semantics per AS-1 (overspends reset to $0 and deduct from next month's RTA).
- **OQ-2 — Verify in the Plaid dashboard that RBC is not on the Trial plan's excluded-institutions list** before any sync work is scheduled (flagged by the feasibility report). If excluded, the import strategy inverts: file import becomes primary and FR-20..23/26..28 move to P2.
- **OQ-3 — Are category targets/goals in use or desired?** The API pull couldn't confirm. Currently FR-39/P2; if he relies on them monthly, they should move to MVP.
- **OQ-4 — RESOLVED (gate, 2026-06-12):** LAN/VPN only; no public-internet exposure. AS-2 confirmed; NFR-10 stands as written.
- **OQ-5 — RESOLVED (gate, 2026-06-12):** full multi-year YNAB history migrates (FR-30 at full depth — all transactions and budget months).
- **OQ-6 — RESOLVED (gate, 2026-06-12):** cash accounts only, permanently. NG-3 confirmed; no credit-card payment mechanics in the engine.
- **OQ-7 — RESOLVED (gate 2, 2026-06-12):** local-disk backup artifact is sufficient; Calvin handles off-host copies. FR-35 scope unchanged; NFR-2 stays strict.

## 11. Definition-of-Ready Self-Check

- **Necessary** — every MVP FR traces to observed usage (`ynab-usage.md`), a feasibility caveat (`plaid-feasibility.md`), or a stated stakeholder constraint (self-hosting, data ownership); features *not* observed in use were pushed to P2 or Non-Goals rather than included "because YNAB has them." ✔
- **Unambiguous** — YNAB-specific vocabulary is pinned in the glossary; the two genuinely ambiguous behaviors found (overspend rollover, remote access) are recorded as AS-1/OQ-1 and AS-2/OQ-4 instead of being silently resolved. ✔ (pending gate)
- **Singular** — each FR states one behavior; composites (e.g., sync) were split across FR-20..28. Reviewed; no FR bundles unrelated behaviors. ✔
- **Feasible** — bank connectivity is grounded in the feasibility report (Trial plan, polling, no public URL); every MVP requirement is buildable by one developer; the riskiest external dependency (RBC↔Plaid) has a required fallback (FR-24) baked in. ✔ (contingent on OQ-2)
- **Verifiable** — every FR carries a "Verified by" consequence; every NFR has a number and a measurement method; success metrics each have a counter-metric. ✔
- **Traceable** — stable IDs throughout (UJ-N, FR-N, NFR-N, NG-N, SM-N, AS-N, OQ-N); journeys reference FRs, metrics reference FRs, assumptions reference the requirements they affect — architecture and stories can cite `docs/prd.md#FR-N` directly. ✔

**Gate condition:** Calvin confirms or amends AS-1..AS-10 and answers OQ-1..OQ-7 (OQ-2 is a 5-minute dashboard check and blocks sync scheduling). Then the PRD is locked and handed to the solution-architect.
