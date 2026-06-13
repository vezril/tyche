# Feasibility Report: Plaid + RBC for a Self-Hosted YNAB-Style Budgeting App (June 2026)

## Verdict: **FEASIBLE-WITH-CAVEATS**

A single developer can sign up for Plaid's free Trial plan (auto-approved, up to 10 live bank connections, no cost), connect RBC personal accounts, and pull transactions via `/transactions/sync` with polling — no public webhook URL required. **Key caveats:** (1) RBC's connection is Plaid's proprietary API/token integration, not standards-based OAuth, and RBC's frequently-changing authentication flow has caused real-world linking failures and forced re-authentication; (2) exact pricing beyond the free tier is quote-based and unpublished; (3) bank connectivity status can change at any time, and a hobby project has no leverage when it breaks. Plan for a manual OFX/CSV import path as a fallback regardless.

---

## 1. Does Plaid support RBC?

**Yes.** RBC and Plaid signed a data-access agreement (June 2022) giving Plaid API-based access for RBC's 14M+ digital clients, explicitly replacing screen-scraping of RBC data ([RBC newsroom](https://www.rbc.com/newsroom/news/article.html?article=125699), [American Banker](https://www.americanbanker.com/news/plaid-royal-bank-of-canada-reach-data-sharing-agreement), [Open Banking Expo](https://www.openbankingexpo.com/news/rbc-enters-data-access-agreement-with-plaid/)).

- **Products:** Transactions, Auth, Balance, and Identity are all supported in Canada ([Plaid product availability by country](https://support.plaid.com/hc/en-us/articles/27895826947735-What-Plaid-products-are-supported-in-each-country-and-region), [Plaid US/Canada coverage](https://plaid.com/docs/institutions/)). For a budgeting app you only need Transactions (Balance data rides along on accounts).
- **Connection type:** Not OAuth. Plaid's OAuth guide states plainly: "OAuth connections are not currently used by financial institutions in Canada" ([Plaid OAuth guide](https://plaid.com/docs/link/oauth/)). The RBC link is a hybrid: the user authenticates with RBC credentials/MFA inside Plaid Link, and RBC grants Plaid scoped digital tokens against its machine-readable data portal — API-based, not classic screen-scraping, but not standards OAuth either ([American Banker](https://www.americanbanker.com/news/plaid-royal-bank-of-canada-reach-data-sharing-agreement)).
- **Reliability:** This is the weakest link. RBC has repeatedly changed its authentication flow; a widely-shared July 2025 account described a 14-minute, ultimately failed RBC link attempt via Plaid across QuickBooks, FreshBooks, and Wealthsimple ([LinkedIn post](https://www.linkedin.com/posts/dahanadam_goodbye-plaid-rbc-it-used-to-take-just-activity-7354514153509736450-2yu-)). Plaid's own consumer help center flags MFA/OTP-at-every-login settings as incompatible with stable connections ([Plaid consumer help](https://support-my.plaid.com/hc/en-us/articles/9098915502999-Your-account-settings-are-incompatible)). Expect occasional `ITEM_LOGIN_REQUIRED` errors requiring re-link through Plaid Link update mode.

## 2. Developer access path (hobby project)

- **Signup:** Free at dashboard.plaid.com/signup; select "Personal use" ([Plaid: Can I use Plaid for free?](https://support.plaid.com/hc/en-us/articles/16194695660311-Can-I-use-Plaid-for-free)).
- **Environments (2026):** Sandbox (free, fake institutions, unlimited) → **Trial plan** → full Production. The old "Development"/"Limited Production" tiers were retired for new US/Canada teams on April 15, 2026 and replaced by the Trial plan: **free, auto-approved for most developers, real production data, up to 10 live Items, access to most institutions** ([Plaid: Sandbox vs Production vs Trial](https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different)). A single user with a handful of RBC accounts is 1–2 Items (one Item per bank login), far under the cap.
- **Full Production approval** (only needed beyond 10 Items or for non-bundled products): application display info, company info, Plaid MSA, and a **security questionnaire** ([Plaid OAuth/registration guide](https://plaid.com/docs/link/oauth/), [Launch checklist](https://plaid.com/docs/launch-checklist/)). **Trial plan users are exempt until they upgrade** ([same OAuth guide](https://plaid.com/docs/link/oauth/)).
- **Canada-specific extras:** None beyond the above — the OAuth registration/questionnaire machinery applies to US OAuth institutions; Canadian institutions don't use OAuth ([Plaid OAuth guide](https://plaid.com/docs/link/oauth/)). *Verify in the dashboard that RBC isn't on the small list of Trial-excluded institutions before building.*

## 3. Pricing

- **Free tier:** The Trial plan is genuinely free with real data up to 10 Items — for one user syncing a few RBC accounts, **expected cost: $0** ([Plaid free-use article](https://support.plaid.com/hc/en-us/articles/16194695660311-Can-I-use-Plaid-for-free), [Sandbox/Trial comparison](https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different)).
- **Transactions pricing model:** subscription — a flat **monthly fee per connected Item for as long as the Item exists**, regardless of API call count (exception: `/transactions/refresh`, billed per request) ([Plaid billing docs](https://plaid.com/docs/account/billing/), [Plaid pricing models article](https://support.plaid.com/hc/en-us/articles/16194632655895-How-much-does-Plaid-cost-and-what-are-the-pricing-models)).
- **If you outgrow the trial:** Pay-as-you-go is month-to-month with no upfront commitment/minimums in the US/Canada; exact rates are only shown during the Production access request flow ([plaid.com/pricing](https://plaid.com/pricing/)). Third-party estimates put Transactions at roughly **$0.30–$0.60 per Item per month** at list ([Vendr](https://www.vendr.com/marketplace/plaid)) — i.e., a couple dollars a month at worst for this use case.

## 4. Technical flow and self-hosted considerations

1. Backend calls `POST /link/token/create` (with `client_id` + `secret`) → short-lived **link_token**.
2. Frontend opens **Plaid Link** (JS widget) with the link_token; user authenticates to RBC; Link returns a **public_token**.
3. Backend exchanges it via `/item/public_token/exchange` → permanent **access_token** + item_id.
4. Backend calls **`/transactions/sync`** with the access_token and a **cursor**: first call (no cursor) pages through history via `next_cursor`/`has_more`; subsequent calls return only added/modified/removed transactions since the stored cursor ([Plaid Transactions docs](https://plaid.com/docs/transactions/), [API reference](https://plaid.com/docs/api/products/transactions/)).

**What you must store and secure:** the Plaid `secret`, each Item's `access_token` (treat like a password — encrypt at rest; it grants ongoing read access to the bank account), and the per-Item sync `cursor`.

**Webhooks vs polling:** The `SYNC_UPDATES_AVAILABLE` webhook is recommended but **not required** — calling `/transactions/sync` on a schedule (e.g., a few times daily; Plaid refreshes data roughly once+ per day per institution) works fine ([Plaid Transactions docs](https://plaid.com/docs/transactions/)). **A self-hosted deployment behind NAT therefore does not need a publicly reachable URL.** The one webhook-ish gap: you'll learn about `ITEM_LOGIN_REQUIRED` (broken RBC connection) only when a sync call errors, which is acceptable for polling.

## 5. Alternatives for Canadian banks

| Option | Hobby-project rating | Notes |
|---|---|---|
| **Flinks** | Poor | Strong Canadian coverage incl. RBC, but usage-based pricing with **monthly minimum commitments** and sales-led onboarding; no self-serve free production tier ([flinks.com/pricing](https://www.flinks.com/pricing)) |
| **MX** | Poor | Enterprise aggregator (one of Monarch's providers for Canada) — contract/sales-driven, no hobby tier ([Monarch providers](https://help.monarch.com/hc/en-us/articles/360048393352-Guide-to-Connecting-Your-Accounts), [mx.com](https://www.mx.com/)) |
| **Manual OFX/QFX/CSV import from RBC online banking** | **Good — best fallback** | Free, 100% reliable, RBC supports CSV/OFX/QFX export from Account Activity ([RBC download guide](http://www.rbcroyalbank.com/online/downloading-transactions.html)); limitation: only ~90-day (chequing) / ~3-month (credit card) rolling export window ([capyparse](https://capyparse.com/blog/rbc-royal-bank-statement-to-csv)), so import regularly |
| **RBC direct consumer API** | Not available | [developer.rbc.com](https://developer.rbc.com/) exposes only limited packages (e.g., credit-card catalog) and business-banking APIs via relationship managers — **no public consumer account/transaction API** ([RBC newsroom](https://www.rbc.com/newsroom/news/article.html?article=123919), [RBC business APIs](https://www.rbcroyalbank.com/business/api/index.html)) |

## Recommended approach

Build the importer abstraction first, with two backends: (1) Plaid via the free Trial plan using `/transactions/sync` polling (zero cost, no public URL, no security questionnaire), and (2) manual OFX/CSV upload as the always-works fallback for when the RBC↔Plaid connection inevitably needs re-linking or breaks.
