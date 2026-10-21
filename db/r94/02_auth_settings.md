# R94 · 02 · Auth and backup toggles (dashboard, Daniel)

Project `sclghkmvzpwtmnzbkaoe` → Authentication / Database settings. No SQL; flip, then tick.

1. **Sign-ups OFF**: Authentication → Sign In / Providers → "Allow new users to sign up" off.
   Staff arrive only by `invite-user` (owner/admin), so nothing in the app needs open sign-up.
2. **Minimum password length 12**: Authentication → Policies (Passwords) → 12, and require
   lower + upper + digits. Existing passwords keep working; it applies at the next change.
3. **Auth DB connections → percentage**: Settings → Database → Connection pooling → Auth
   server "Percentage" (advisor INFO `auth_db_connections_absolute`, today fixed at 10).
4. **Backups**: Database → Backups — confirm daily backups are listed for the last 7 days.
   Consider Point-in-Time Recovery (paid add-on): a client book with ~200 vault logins and
   commission history makes "lose up to 24 h" the real exposure.
5. Afterwards: re-run the advisors (security + performance) and paste the counts in the PR.
