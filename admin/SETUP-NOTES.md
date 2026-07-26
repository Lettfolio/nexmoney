# NexMoney Back Office — Setup Notes

## What this is
A case-tracking and client-retention system in the `admin/` folder of the website. It runs on Supabase (project **nexmoney-backoffice**, London region, free tier) and works from any static hosting — it deploys along with the website, and sits at `yourdomain.com/admin/`.

## Your login
- URL: double-click `admin/index.html` to use it right now; it will live at `yourdomain.com/admin/` once the website is hosted (Supabase can't serve web pages from its own domain, so the app needs normal web hosting)
- Email: `daniel@nexmoney.co.uk`
- Temporary password: `NexMoney-Temp-2026!`

**Change this password** after first login using "Forgot password?" on the login screen, or ask Claude to set a new one. To add a colleague, use **Settings → Team logins** and pick the role you want them to have (Administrator, Adviser or Introducer) — see "Roles" below. Only the Owner can do this; the database refuses it for anyone else, so the button isn't shown to them.

### Password reset (one-time config)
The "Forgot password?" button emails you a reset link. For the link to come back to the right page, do this once in the Supabase Dashboard (project *nexmoney-backoffice*) → **Authentication → URL Configuration**:
- Site URL: `https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1/admin`
- Add the same URL under Redirect URLs.

### Biometric login (Face ID / Windows Hello / fingerprint)
When you first sign in, let your browser (Chrome/Edge/Safari) or password manager save the login — it will then offer to fill it with your face/fingerprint on future visits. You also stay signed in between visits on trusted devices, so you'll rarely see the login screen at all.

## What it does

### The retention pipeline (added July 2026)
**Retention is surfaced for you, but nothing about it happens on its own.** Nothing in the system creates a retention case, sends a retention email, schedules a chase or opens a task — every one of those is a click you make. What the system does is make sure a rate ending never goes unnoticed:

1. **It finds them.** Any completed case whose rate-end date falls inside your reminder window (6 months by default, Settings → "Rate reminder lead time") is counted in the Today screen's "Rates ending ≤ 6mo (or overdue)" figure and listed under **Rate & ERC alerts**, oldest first, with an OVERDUE badge once the date has passed. Completed cases in that list carry a **Reminder pending** badge until a rate-end reminder has gone out, and a green **Reminder sent** badge afterwards.
2. **It shouts when one is missed.** If a rate has actually ended and there is no open retention case, Data health raises a **critical** alert ("Rate has ENDED with no retention case") — that alert exists precisely because nothing creates the case for you.
3. **You do the rest.** Open the case → "Email rate-end reminder" to queue and send the email → create the new retention case yourself and set its **Lead source** to Retention → add a "Call client" task with a due date if you want the reminder on the Today screen. Chase emails are sent the same way, by hand, when you decide to send them.

The dashboard's Retention pipeline panel tracks retention cases (those linked to an original case) and your won/lost conversion rate — it fills up as you create them, not by itself. When a retention case completes and you upload the new mortgage offer, "Read mortgage offer (AI)" fills in the new rate-end date for you to check and Save; from that point the case appears in the rate-end list again when the new date comes into the window.

1. **Pipeline** — cases move through Enquiry → Fact Find → DIP → Application → Offer → Exchange → Completed.
2. **Rate/ERC flags** — any completed case where the ERC end date runs past the rate end date is flagged "ERC conflict" on the dashboard.
3. **Rate-end reminders** — the churn-reducer, but a manual one. Every completed case whose rate ends inside your reminder window (6 months by default, configurable in Settings) is listed on the Today screen under Rate & ERC alerts and badged **Reminder pending**. Open the case and click "Email rate-end reminder" to send it. Nothing emails the client for you, so work that list.
4. **Review requests** — from a completed case, click "Email review request" to send the "leave us a Google review" email (you need a review link in Settings first). This is not on a timer: Settings has a "Review request delay after completion (days)" box, but nothing in the back office acts on it, so no review email goes out unless you send it.
5. **Fee requests** — from any case, click "Email fee request" to send a bank-transfer payment email with a unique reference. Sending it sets the case's fee status to **Requested** and records when it was asked for, so the case, the fee badges and the change history all show the invoice has gone out and a colleague can see it without asking. Mark paid when the money lands (a fee already marked paid or waived is never moved back to requested).

**What "automation" actually means here.** Emails you queue are *sent* automatically: the `process-emails` function runs every morning at **8am** (Supabase cron job), takes everything sitting in the email queue and sends it through Resend, recording sent/failed on the Emails tab. You can trigger the same run any time from the Emails tab ("Run automation now") — that is what the button does, and sending is also triggered immediately whenever you queue an email from a case. What the run does **not** do is compose anything new: it reports how many rate-end reminders, review requests and fee requests it newly queued and that figure comes back as **0**. Composing is your click, every time.

## One thing you must do: connect Resend (email sending)
Emails queue up but won't send until this is done (~15 minutes):

1. Create a free account at https://resend.com (3,000 emails/month free).
2. In Resend: **Domains → Add domain** → add the NexMoney domain and add the DNS records it shows you at your domain registrar. Wait for "Verified".
3. In Resend: **API Keys → Create API key** → copy it.
4. In Supabase Dashboard (project *nexmoney-backoffice*): **Edge Functions → Secrets → Add secret**
   - Name: `RESEND_API_KEY`
   - Value: the key you copied.
5. In the back office **Settings** tab, set "From email" to something on your verified domain, e.g. `NexMoney <hello@yourdomain.co.uk>`, and check "Reply-to email" is where you want replies.

## Second thing to do: connect the AI features (~10 minutes)
The **Import tab** (bulk upload sorted by AI) and the **"Read mortgage offer" button** on cases both need an Anthropic API key:

1. Create an account at https://console.anthropic.com and add a small amount of credit (£5 goes a very long way — each import or offer-read costs pennies).
2. Create an API key (starts `sk-ant-`).
3. In Supabase Dashboard (project *nexmoney-backoffice*): **Edge Functions → Secrets → Add secret**
   - Name: `ANTHROPIC_API_KEY`
   - Value: the key.

### How the AI features work
- **Import tab**: paste anything (spreadsheet rows, emails, notes) or choose a CSV/Excel file → Analyse → review the table it produces → Import selected. Existing clients are matched by name, and missing emails/phones are filled in rather than duplicated. This is also the easiest way to add email addresses in bulk: paste a list of "name – email" pairs.
- **Read mortgage offer**: open a case → "Read mortgage offer (AI)" → choose the offer PDF. It fills in lender, rate, rate end date, ERC end date, loan amount etc. for you to check and Save, stores the PDF against the case, and clears the "estimated" flag on the rate end date.

### Estimated dates
Rate-end dates carried over from the spreadsheet were calculated as completion date + product term. They're flagged **purple with a ≈ symbol** everywhere until confirmed — open the case, correct the date if needed, untick "estimated", Save. "Read mortgage offer (AI)" fills in the real date and unticks "estimated" for you — it fills the form, so you still press Save to keep it.

## Fill in Settings on first login
Settings is the Owner's screen: only the Owner can change these values, and the database refuses the write for everyone else. Administrators and Advisers see the settings that affect their work read-only, rather than being shown a form that would fail on Save. The bank details go further: the database only returns them to the Owner, so they are not merely hidden from the screen — the values are never sent to anyone else's browser. Fee-request emails still work for everyone, because the app only asks the database whether the details are filled in (yes/no) and the email itself is composed on the server.
- Bank account name / sort code / account number (needed for fee request emails)
- Google review link (Google Business Profile → "Ask for reviews" → copy link)
- Adviser name and phone (used in email sign-offs)
- Reminder lead time and review delay if you want different timings

## Added July 2026: protection prompts, evidence packs, reports, introducer portal
- **Protection**: every case has a Protection status. Cases at Application/Offer/Exchange with "Not discussed" get a 🛡 badge and appear in the dashboard's Protection opportunities panel. Reports tracks protection uptake %.
- **Evidence pack**: on any case, "🗂 Evidence pack" opens a printable FCA-file-ready report — client, case details, an event timeline, communications, notes, tasks and a change history. Print → Save as PDF. The event timeline is written by the database itself as you work: stage changes, fee status, offer uploads, rate-end dates, protection status and reassignment are each logged automatically, with the person who made the change. It is not a record of every edit — a changed loan amount or rate is not an event — so the pack ends with a **Change history** section listing every field-level change the audit trail holds for the case (see "Change history" below). Client communications (emails) are tracked and shown accurately alongside it. The pack is written to be handed to a file reviewer: the cover names who generated it and when, every person, client, case and introducer is named rather than referred to by an internal reference, coded values (stage, fee status, protection status, email type) are printed in the same words the screens use, notes carry their author and tasks their owner, and where a deleted record's name genuinely cannot be recovered the pack says so in a sentence instead of printing a reference number.
- **Reports tab**: completions by month, live pipeline funnel, pipeline loan value, fees banked vs outstanding, retention conversion, protection uptake, lead sources and introducer league table. Set "Lead source" on cases to feed it.
- **Introducers**: add them in Settings → assign on cases → their referrals show in Reports. "Create portal login" gives them access to `introducer.html` — a separate page where they see ONLY their own referrals' names and progress (nothing else; enforced by database security, not just the interface).
- **Team logins**: Settings → Team logins creates a colleague's account at the role you choose — Administrator, Adviser or Introducer (temporary password shown once). Owner is not on the list on purpose: you promote an existing account to Owner from the same panel, so one unattended click can never mint a top-level login. The panel and the roster are visible to the Owner only.
- **Security**: access is role-based and the roles are enforced by the database, not by which buttons you can see. See "Roles" below.

## Added July 2026: workflow upgrade — leads, diary, handoffs
- **Website leads**: the contact form on nexmoney.co.uk now feeds straight into the back office (with anti-spam protection). New enquiries appear at the top of the **Today** screen — Accept creates the client + case assigned to you and opens it; Discard bins it. Works as soon as the site is live (the form posts to the system directly, wherever the site is hosted).
- **Today screen** (was Dashboard): reorganised around your working day — new leads and today's appointments first, then retention/tasks, then alerts.
- **Diary**: week view with prev/next, filter by staff member, appointments linked to clients/cases. "Book appointment" button on every case. Today's appointments show on the Today screen.
- **Handoffs**: every case and task has an "Assigned to". Change it to hand a case to a colleague — every change of owner is recorded automatically in the case's event log, naming the new adviser and who made the change, so there is a trail of who held a case and when. Pipeline has a search box and an adviser filter (All / Unassigned / per person); cards show the owner's initials. Tasks panel defaults to "Mine" (yours + unassigned) — click to toggle All.
- **Drag and drop**: drag pipeline cards between columns to move cases on.

## Added July 2026: roles, and a change history

### Roles
Every login has a role, and the **database** decides what it allows — not the screens. The screens only avoid offering an action the database would refuse.

| Can they… | Owner | Administrator | Adviser |
|---|---|---|---|
| See and work every case, client, note, task, appointment and email | yes | yes | yes |
| Delete a client or a case (and merge duplicates, which deletes one) | yes | yes | no |
| Change Settings, including bank details and the financial-promotions switch | yes | no | no |
| Read Settings | yes | yes | yes |
| Add, remove or re-role a login | yes | no | no |
| See firm-wide money: fees, forecast, adviser scoreboard and introducer revenue in Reports, and estimated commission on Protection &amp; GI | yes | no | no |

Daniel is the **Owner**; Kim is an **Administrator**; Wayne and Luke are **Advisers**. There is no per-adviser case split: advisers still see every case. Anyone who creates an account without being invited gets the role `none` and sees nothing at all until you grant them one. Introducers have their own role and only ever see their own referrals.

Three caveats, so nothing here is oversold:
- **The Reports money rule is the interface hiding figures, not a lock.** The report the screen is built from is still readable by any staff login, so treat it as tidiness rather than confidentiality. The same goes for the estimated commission now hidden on Protection &amp; GI: the pipeline it is built from still returns the figure to every staff login. Every other row in that table is refused by the database itself.
- **"Read Settings" does not include the bank details, the API keys or the cron key.** Those values are returned to the Owner and to nobody else, so an Administrator or an Adviser reads the rest of the configuration and never receives them at all. That one *is* a lock, not tidiness — see "Fill in Settings on first login" above.
- **The last Owner cannot be demoted or deleted** — the database refuses it, so promote someone else to Owner first.

### Change history
Since **26 July 2026** the database keeps its own append-only record of every insert, update and delete on clients, cases, tasks, notes, appointments, introducers, settings and logins: who did it, when, and the old and new value of each field that changed. It is written by the database, has no write path through the back office, and cannot be edited or erased from here. You can read it in four places:

- **Settings → Change history** — the whole log. Filter by what changed (Settings, logins and roles, clients, cases, tasks/notes/appointments, introducers), by who made the change and by date; newest first, 25 to a page; open any entry for the field-by-field before and after. This is the Owner's view and the only one that can show changes to Settings and to team logins.
- The **Change history** drawer on any case.
- The same drawer on any client.
- The **Change history** section at the end of the evidence pack.

The three record-level views can only ever show entries that belong to that case or client. A change to Settings or to a login belongs to neither, so those entries appear in Settings → Change history and nowhere else.

What it does and doesn't cover:
- Nothing from before 26 July 2026 is in it. An empty history means no change since that date, not that nothing ever happened.
- Bank details, keys, tokens and passwords record as `(hidden)`: the log proves the value changed and deliberately never stores the value.
- Settings and login entries are readable by the Owner only. The database withholds them from every other login, so those rows are genuinely absent from anyone else's copy of the history rather than hidden by a screen. The Owner reads them in **Settings → Change history**, which is why that panel is shown to the Owner alone — the rest of the team would see a filter that returns nothing.
- Saving a form without changing anything writes nothing, so the log stays readable.

This sits underneath the case **event log** described above, which stays the short human-readable story of a case (stage changes, fee status, offer uploads, rate-end dates, protection status, reassignment). The event log answers "what happened on this case"; the change history answers "who changed that number, and what was it before".

## Technical reference
- Supabase project ref: `sclghkmvzpwtmnzbkaoe` (https://sclghkmvzpwtmnzbkaoe.supabase.co)
- Edge function: `process-emails` (composes and sends all emails via Resend, logs everything to the Emails tab)
- Cron: `nexmoney-process-emails`, daily 08:00 UTC
- All data is protected by row-level security. A signed-in login with no role reads and writes nothing; what a role may do is listed under "Roles" above and enforced in the database. `case_events` and `audit_log` are readable but have no write path at all — the app can never add to or amend them.
