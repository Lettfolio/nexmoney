# nexmoney.co.uk go-live runbook (R92, prepared 24 Sep 2026)

The new site + back office live at nexmoney-two.vercel.app behind the reviewer gate. This is the ordered list to move
nexmoney.co.uk onto it. Canonical host is **www.nexmoney.co.uk** (every page's `<link rel="canonical">`, the sitemap
and the old site all use www) — the apex redirects to www. Owners: **Dev** (Cloudflare DNS), **Daniel** (Vercel,
Supabase, Resend, git push), **Claude** (code, verification). Nothing here is done until Daniel says "go".

## 0 · Already in the repo (this round)
- `vercel.json` — 31 permanent (301) redirects from every URL in the OLD site's sitemap to its nearest new page
  (list below). Live the moment it is pushed; harmless on nexmoney-two until the domain moves.
- Gate removal is ONE command on the day (step 4) — no branch to juggle.

## 1 · Before the day (any time from now)
1. **Resend** (Daniel, resend.com): Domains → Add domain `nexmoney.co.uk`, region **EU (Ireland)**. Resend shows three
   records — paste them to the dev (or me) exactly as shown:
   - `TXT  resend._domainkey.nexmoney.co.uk` → the DKIM value Resend generates
   - `MX   send.nexmoney.co.uk` → `feedback-smtp.eu-west-1.amazonses.com`, priority 10
   - `TXT  send.nexmoney.co.uk` → `v=spf1 include:amazonses.com ~all`
   Root SPF and DMARC (`p=reject`) stay untouched — DKIM alignment on the nexmoney.co.uk signature is what passes
   DMARC. Then API Keys → create `supabase-process-emails`, sending-only, domain-restricted. Keep it for step 5.
2. **Dev / Cloudflare**: add the three Resend records (DNS-only). Resend → Verify. Export the zone as a backup. Lower
   the TTL on the apex `A` and `www` records to 300 so the switch takes minutes, not a day.
3. **Vercel** (Daniel, project `nexmoney`, Settings → Domains): add `www.nexmoney.co.uk` (primary) and `nexmoney.co.uk`
   (redirect to www). Vercel will show the two records for step 4 and say "Invalid configuration" until DNS moves —
   that is expected.
4. **Stonebridge**: written sign-off that the reviewed site may go public (their reviewers used the gate).

## 2 · The day — order matters
1. **Claude** — live-verify nexmoney-two one last time (seven hashes, gate, `__errorLog` 0).
2. **Dev / Cloudflare** (DNS-only / grey cloud, NOT proxied):
   - `A     @    76.76.21.21`
   - `CNAME www  cname.vercel-dns.com`
   Delete or note any other record that still points at the old host `54.38.212.253`. Leave MX/SPF/DKIM/DMARC alone.
3. **Vercel**: Domains page turns green (cert issued) — usually within 5 minutes at TTL 300.
4. **Daniel — remove the gate** (Windows terminal, in the repo):
   ```
   git rm middleware.js gate.html
   git commit -m "Go-live: reviewer gate removed"
   git push origin main
   ```
   The battery runs on the push as usual; the deploy is live in ~1 minute.
5. **Daniel — Supabase** (dashboard, your sign-in): Authentication → URL Configuration → Site URL
   `https://www.nexmoney.co.uk/admin/`; Redirect URLs add `https://www.nexmoney.co.uk/admin/**` and
   `https://nexmoney.co.uk/admin/**`; keep `https://nexmoney-two.vercel.app/admin/**` for a week. Then Edge
   Functions → Secrets → add `RESEND_API_KEY` (from step 1.1).
6. **Claude — settings** (SQL, one statement, after 5): `site_url` → `https://www.nexmoney.co.uk`;
   `from_email` → `NexMoney <hello@nexmoney.co.uk>` (a real M365 mailbox so replies land — tell me the mailbox to
   use; `reply_to_email` stays daniel@). `email_hold` stays **on**.
7. **Claude — verify on the real domain**: `https://www.nexmoney.co.uk/` (no gate), `/admin` (hashes + tags),
   `/mortgages/buy-to-let` → 301 → `/buy-to-let-mortgages-dorset`, `http://nexmoney.co.uk/services` → https www,
   password-reset email round-trip, contact form → a lead on Today, `robots.txt`/`sitemap.xml` reachable.
8. **Test send, then release**: from Settings › Automations press "Send test" (or I send one held row to
   daniel@) — check it arrives from hello@nexmoney.co.uk with DKIM pass. Only then `email_hold` → `off`
   (deliberate act, your say-so). The 08:00 UTC run the next morning flushes the queue; I read its log.
9. **Search Console**: add the `www.nexmoney.co.uk` property (DNS TXT via the dev), submit `/sitemap.xml`.

## 3 · Rollback (any point in section 2)
Cloudflare: `A @ 54.38.212.253` back, delete the `www` CNAME (or point it back at the old host). TTL 300 → old site
returns in minutes. The gate commit can be reverted with `git revert HEAD`. Nothing in Supabase needs undoing — the
old admin URL stays in the redirect list for a week.

## 4 · After (first week)
Old hosting kept 30 days. Watch Vercel → Analytics for 404s the redirect map missed (add them to `vercel.json`).
Remove `https://nexmoney-two.vercel.app/admin/**` from Supabase redirect URLs after a week. Then the two Auth
hardenings still open: sign-ups OFF, minimum password 12.

## Redirect map (old sitemap → new page)
| Old URL(s) | New |
|---|---|
| /guides, /forum, /useful-links | /faq |
| /portal | /contact — **check**: the old client portal; if it was a real product, tell me where it should go |
| /exclusives, /mortgages/anything-else | /mortgages |
| /calculators/* | /calculators |
| /protection, /protection/* | /services#protection |
| /general-insurance, /general-insurance/* | /services#insurance |
| /other-services, /other-services/* | /services#specialist (conveyancing → #conveyancing) |
| /mortgages/buy-to-let, /complex-buy-to-let, /recycle | /buy-to-let-mortgages-dorset |
| /mortgages/remortgaging, /capital-raising | /remortgage-bournemouth |
| /mortgages/first-time-buyer, /help-to-buy(-1,-2), /right-to-buy | /first-time-buyer-mortgages-bournemouth |
| /mortgages/shared-ownership · /home-mover · /self-build | /mortgages#shared · #homemover · #selfbuild |
| /about/share-the-love | /share-the-love-terms |
| /about/introducers-partners | /contact |
| /about/*, /careers/* | /about |
| /, /services, /calculators, /testimonials, /about, /contact, /mortgages, /privacy | same path — no redirect needed |
