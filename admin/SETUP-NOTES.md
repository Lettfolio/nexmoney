# NexMoney Back Office — Setup Notes

## What this is
A case-tracking and client-retention system in the `admin/` folder of the website. It runs on Supabase (project **nexmoney-backoffice**, London region, free tier) and works from any static hosting — it deploys along with the website, and sits at `yourdomain.com/admin/`.

## Your login
- URL: double-click `admin/index.html` to use it right now; it will live at `yourdomain.com/admin/` once the website is hosted (Supabase can't serve web pages from its own domain, so the app needs normal web hosting)
- Email: `daniel@nexmoney.co.uk`
- Temporary password: `NexMoney-Temp-2026!`

**Change this password** after first login using "Forgot password?" on the login screen, or ask Claude to set a new one. To add your 1–2 colleagues: Supabase Dashboard → Authentication → Users → "Add user".

### Password reset (one-time config)
The "Forgot password?" button emails you a reset link. For the link to come back to the right page, do this once in the Supabase Dashboard (project *nexmoney-backoffice*) → **Authentication → URL Configuration**:
- Site URL: `https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1/admin`
- Add the same URL under Redirect URLs.

### Biometric login (Face ID / Windows Hello / fingerprint)
When you first sign in, let your browser (Chrome/Edge/Safari) or password manager save the login — it will then offer to fill it with your face/fingerprint on future visits. You also stay signed in between visits on trusted devices, so you'll rarely see the login screen at all.

## What it does

### The retention pipeline (added July 2026)
When a completed client's rate-end date comes inside your reminder window (6 months by default), the system automatically:
1. Creates a new **Enquiry** case for them, tagged 🔁 retention and linked to the original case.
2. Emails them the rate-end reminder immediately, and schedules a **follow-up chase email** for around the 5-months-to-go mark.
3. Creates a **"Call client" task** for around 4 months before the rate ends — visible in the Tasks due panel on the dashboard.
4. If you win the case (Completed) or they go elsewhere (Not Proceeding), any unsent chase emails are cancelled and tasks closed automatically.

The dashboard's Retention pipeline panel tracks open opportunities and your won/lost conversion rate. When a retention case completes and you upload the new mortgage offer, its new rate-end date is captured — so the cycle repeats itself for every client, forever.

1. **Pipeline** — cases move through Enquiry → Fact Find → DIP → Application → Offer → Exchange → Completed.
2. **Rate/ERC flags** — any completed case where the ERC end date runs past the rate end date is flagged "ERC conflict" on the dashboard.
3. **Rate-end reminders** — clients are automatically emailed 6 months (configurable) before their rate ends, inviting them back to remortgage. This is the churn-reducer.
4. **Review requests** — 3 days (configurable) after a case completes, the client automatically gets a "leave us a Google review" email.
5. **Fee requests** — from any case, click "Email fee request" to send a bank-transfer payment email with a unique reference. Mark paid when the money lands.

Automation runs every morning at **8am** (Supabase cron job). You can also trigger it any time from the Emails tab ("Run automation now").

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
Rate-end dates carried over from the spreadsheet were calculated as completion date + product term. They're flagged **purple with a ≈ symbol** everywhere until confirmed — open the case, correct the date if needed, untick "estimated", Save. Uploading the mortgage offer does this automatically.

## Fill in Settings on first login
- Bank account name / sort code / account number (needed for fee request emails)
- Google review link (Google Business Profile → "Ask for reviews" → copy link)
- Adviser name and phone (used in email sign-offs)
- Reminder lead time and review delay if you want different timings

## Added July 2026: protection prompts, evidence packs, reports, introducer portal
- **Protection**: every case has a Protection status. Cases at Application/Offer/Exchange with "Not discussed" get a 🛡 badge and appear in the dashboard's Protection opportunities panel. Reports tracks protection uptake %.
- **Evidence pack**: on any case, "🗂 Evidence pack" opens a printable FCA-file-ready report — client, case details, full event timeline (stage changes, emails sent, offer uploads are logged automatically), communications, notes and tasks. Print → Save as PDF.
- **Reports tab**: completions by month, live pipeline funnel, pipeline loan value, fees banked vs outstanding, retention conversion, protection uptake, lead sources and introducer league table. Set "Lead source" on cases to feed it.
- **Introducers**: add them in Settings → assign on cases → their referrals show in Reports. "Create portal login" gives them access to `introducer.html` — a separate page where they see ONLY their own referrals' names and progress (nothing else; enforced by database security, not just the interface).
- **Team logins**: Settings → Team logins creates full-access colleague accounts (temporary password shown once).
- **Security upgrade**: access is now role-based. Anyone who somehow creates an account gets NO data access until you grant a role. Your account and invited colleagues are "staff"; introducers see only their own cases.

## Added July 2026: workflow upgrade — leads, diary, handoffs
- **Website leads**: the contact form on nexmoney.co.uk now feeds straight into the back office (with anti-spam protection). New enquiries appear at the top of the **Today** screen — Accept creates the client + case assigned to you and opens it; Discard bins it. Works as soon as the site is live (the form posts to the system directly, wherever the site is hosted).
- **Today screen** (was Dashboard): reorganised around your working day — new leads and today's appointments first, then retention/tasks, then alerts.
- **Diary**: week view with prev/next, filter by staff member, appointments linked to clients/cases. "Book appointment" button on every case. Today's appointments show on the Today screen.
- **Handoffs**: every case and task has an "Assigned to". Change it to hand a case to a colleague (it's recorded in the case's event log). Pipeline has a search box and an adviser filter (All / Unassigned / per person); cards show the owner's initials. Tasks panel defaults to "Mine" (yours + unassigned) — click to toggle All.
- **Drag and drop**: drag pipeline cards between columns to move cases on.

## Technical reference
- Supabase project ref: `sclghkmvzpwtmnzbkaoe` (https://sclghkmvzpwtmnzbkaoe.supabase.co)
- Edge function: `process-emails` (composes and sends all emails via Resend, logs everything to the Emails tab)
- Cron: `nexmoney-process-emails`, daily 08:00 UTC
- All data is protected by row-level security — only signed-in users can read or write anything.
