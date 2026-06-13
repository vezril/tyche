# Analysis: Current YNAB Usage (June 2026)

Input artifact for the PRD (SDLC Analysis phase). Pulled from the user's live YNAB
plan via the YNAB API — this is how the user *actually* uses YNAB today, which
defines the MVP feature bar for the self-hosted replacement.

## Budgeting model
- Zero-based / envelope budgeting ("give every dollar a job"), monthly cycle.
- "Inflow: Ready to Assign" is actively used as the assignment pool.
- Currency: CAD. YNAB stores amounts as milliunits (1/1000 of a dollar).

## Accounts (5)
| Account | Type | On budget |
|---|---|---|
| Primary Chequing – Automatic Payments | checking | yes |
| Spending Account | checking | yes |
| Savings | savings | yes |
| RBC Signature No Limit Banking – 2501 | checking | yes |
| TFSA – 1676 | tracking (other asset) | no |

Notable: a mix of on-budget cash accounts and an off-budget *tracking* account
(TFSA). The clone must support both kinds. Bank: Royal Bank of Canada (RBC).

## Categories
~31 categories organized into ~9 category groups, including:
- Savings goals (FHSA, Emergency Fund, RV Rent, Vehicle Maintenance)
- Debt payments (DMP Payment, Motorcycle Loan — biweekly cadence)
- Fixed bills (Rent, Cellphone/Internet, Hydro, Insurances, Subscriptions)
- Variable spending (Groceries, Eating Out, Alcohol, Gas, Home & Everyday)
- Fun money (Dopamine Fund, Hobbies, Steam, SWGOH)
- Workshop (rent, supplies/tools)
- Health (Therapist, Vision)

Observed behaviors that must be supported:
- Categories can be **overspent** (negative balance carried, e.g. Groceries −$138.93).
- Budgeted amounts change monthly; activity tracked per month per category.
- Category *balance* = carryover + budgeted + activity (YNAB month rollover semantics).

## Features NOT in active use (candidate non-goals / post-MVP)
- Scheduled/recurring transactions (none defined).
- Goals/targets on categories (not observed via API pull, unconfirmed).
- Multiple plans/budgets, shared budgets, multi-user.
- Loan planner, spending reports beyond basics (unconfirmed usage).

## Implications for the clone
- Single user, single budget, CAD-only is an acceptable MVP scope.
- The month-grid budget screen (assign money, see activity/available per category
  per month) is the core surface; account register is second; reports later.
- RBC connectivity (via Plaid or fallback import) feeds the register; budget math
  is independent of the import mechanism.
