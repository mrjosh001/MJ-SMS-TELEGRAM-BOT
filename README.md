# MJ SMS Telegram Bot v3

Server 1 = Grizzly · Server 2 = SMS-Bus (same account/prices as mjhub.store).

## Deploy order
1. DB (already applied to the website Supabase project): `supabase/migrations/20261017_bot_wallet.sql`
2. Vercel env (existing ones keep working): `BOT_TOKEN`, `WEBHOOK_SECRET` (**now required**), `GRIZZLYSMS_API_KEY`,
   `SMSBUS_API_TOKEN` (new), `MJ_HUB_REST_URL`, `MJ_HUB_SERVICE_KEY`, `PAYSTACK_SECRET_KEY`, `ADMIN_TELEGRAM_ID` (no default now), optional `GEMINI_API_KEY`.
3. Deploy, then open `https://YOUR-APP.vercel.app/setup-webhook?secret=WEBHOOK_SECRET` once (also installs the Menu button list).
4. Paystack webhook URL: `https://YOUR-APP.vercel.app/paystack`.

Old balances in the paused "MJ SMS BOT" project are not migrated (restore it and ask for a one-off import if needed).
