# NexMoney Back Office — Feature Roadmap

## ⭐ Revolution (Stonebridge) — division of labour (researched July 2026)

**The golden fact:** Stonebridge provides a `client_data_export_V2` xlsx report (request via helpdesk@stonebridgegroup.co.uk, 0345 646 5505 option 5, business principals only) with ~55 fields per client: lender, product, initial rate, **initial term expiry date, ERC end date**, rate type, plus **protection flags (taken protection, income protection, home insurance, policy type, premium)**. This means Revolution → back office can be a weekly file import with zero re-keying (the AI Import tab can read it today; a dedicated matcher is recommendation #1 below). There is no route back INTO Revolution — so the rule is: **key everything into Revolution first; this system syncs FROM it.**

Stays in Revolution (compliance record — never duplicate): fact find, sourcing evidence, suitability letters, ID/AML (RevolutionID), protection quoting (SolutionBuilder embedded), GI quoting (LV= SmartQuote embedded), financial promotions approvals, commission statements.
Lives here (Revolution is weak at it): pipeline/workflow, retention journeys, lifecycle client emails, chase automation, tasks/diary, adviser £ reporting, AI import/extraction, website leads.

Next builds in priority order:
1. **client_data_export_V2 importer** (EASY) — weekly upsert; replaces manual entry as the ongoing sync.
2. **Protection gap report** (EASY) — from the same export: every completed mortgage with no protection/GI → monthly call list per adviser. Cheapest revenue lever available.
3. **Protection outcome as a pipeline gate** (EASY) — case can't reach Submitted without quoted / referred to Stonebridge Protect / declined-with-reason; declines get a 6-month re-approach task.
4. **GI triggers** (EASY) — auto-task "run LV= SmartQuote" at application/offer/exchange + "buildings cover needed at exchange" client email.
5. **Multi-touch educational retention journey** (MEDIUM) — Eligible-style sequence with real SVR-cost figures from the export (they claim 16–30% uplift).
6. **Solicitor-chase automation with AI-drafted chasers** (MEDIUM) — milestone timers draft the chaser + client update for one-click send.
7. **AI inbound document classification** (MEDIUM) — classify payslips/statements/ID, tick the checklist, auto-chase missing items every 3 days.
8. **Commission reconciliation** (MEDIUM) — import Stonebridge statements, match against expected proc fees, flag gaps.
9. **Clawback watch** (HARD) — protection policies tracked against the 48-month clawback window.

**Before switching on client-facing automation, check with Stonebridge:** as an AR, marketing-type emails (referral nudges, review requests, protection cross-sell, the website copy) likely count as financial promotions needing principal approval — get the templates pre-approved via Revolution's Promotions Approvals and keep the trail. Rate-end emails must stay information-not-advice. Confirm they're comfortable with client data in a GDPR-compliant UK/EU-hosted database and mirror Revolution's vulnerability flags (no pushy sequences to vulnerable clients). Marketing emails need soft opt-in + unsubscribe.

*Based on a review of the UK broker CRM market (360 Lifecycle, Smartr365, Acre, OMS, finova/eKeeper, Intelliflo, Mortgage Brain CRM Brain, Twenty7tec, Knowledge Bank, MIDAS, plus AI entrants JammJar, Sikoia, Aveni, Nivo, Dashly, Eligible.ai) — July 2026.*

## Where NexMoney already matches or beats the market
- Kanban pipeline, rate-end + ERC alerts, automated rate-end reminders and review requests — equivalent to 360's "Hotbox" concept in miniature.
- AI bulk import and AI mortgage-offer PDF extraction — genuinely ahead of most incumbents (only Smartr365 Maia, Acre Document Checker, Sikoia are comparable).
- Fee request emails with references — small firms on eKeeper pay extra for this.

## Buildable next (in priority order)

### 1. Client portal with document upload + live case status ⭐ table stakes
Every product in the market has one. Clients log in, upload payslips/bank statements, see where their case is, message you. Kills "any update?" calls and email attachment chaos. Buildable on the existing Supabase stack (client logins + storage + permissions).

### 2. Client-completed fact find
Structured form in the portal that pre-fills the case record — data entry moves to the client. Pairs with the AI import (messy answers → clean record).

### 3. Retention pipeline, not just reminder emails (the "Hotbox" upgrade)
When a rate-end is inside the window, auto-create a new Enquiry case linked to the old one, with a multi-touch sequence (email at 6mo, chase at 5mo, SMS/call task at 4mo) and conversion tracking. Turns the current one-shot email into measurable pipeline. This is what 360 Lifecycle is most famous for.

### 4. Stage-triggered task automation
Rules like "case hits Offer → create 3 tasks + send client doc checklist". The heart of finova and SmartrFlow. Guarantees consistency across you + colleagues.

### 5. AI suitability letter / reasons-why generator
Acre auto-generates from case data; AI entrants draft from calls. Biggest time sink in compliant advice — and a natural extension of the AI already wired in.

### 6. Proc-fee / commission reconciliation
Expected income per case; import lender remittance statements (the offer-PDF reader can be extended to parse them) and flag unpaid proc fees. Unclaimed proc fees are silent lost revenue — Twenty7tec's income-matching is prized for exactly this.

### 7. Protection & GI cross-sell prompts
Rule-driven nudge on every case with no protection recorded ("discuss life cover?"). Protection commission rescues margin on small cases; Consumer Duty likes the conversation being evidenced.

### 8. Compliance evidence pack per case
Append-only event log (who did what, when, which emails went) + one-click PDF bundle: fact find, offer doc, suitability letter, research evidence. FCA-file-ready without assembly (Acre's ledger, Knowledge Bank's Evidence of Research).

### 9. AI call assistant
Upload/record client calls → transcript, fact-find updates, follow-up draft, vulnerability flags. The hottest 2025-26 category (Acre, Intelliflo IQ, JammJar, Aveni); claims of 6-8 hours saved per application.

### 10. KPI dashboard
Conversion by stage/adviser/lead source, average days per stage, pipeline value, retention conversion rate. Simple SQL views + charts.

### 11. E-signatures
Terms of business / fee agreement signing in the portal (per-use API like Dropbox Sign, or click-to-accept with audit log).

### 12. Introducer portal
Estate agents/accountants submit leads and watch progress (read-only). Keeps referrers loyal and shows which sources convert (Acre, CRM Brain both push this).

## Not realistically DIY (industry-gated)
- **Product sourcing / criteria / affordability in-platform** (Twenty7tec, Mortgage Brain, Knowledge Bank are paid B2B APIs) — keep using them standalone; add an "attach research PDF" slot to cases instead.
- **Direct lender submission** (one-click DIP→application to Halifax/NatWest etc.) — lender APIs only open to the big platforms.
- **Credit reports** (Experian/Equifax contracts). Partially reachable: open banking via TrueLayer/GoCardless and per-check ID verification (Stripe Identity/Onfido) can be bought at per-use pricing later.

## Suggested build order
Portal + fact find (1-2) → retention pipeline (3) → task automation (4) → AI suitability letters (5) → fee reconciliation (6). Each is a session or two of work on the current stack.
