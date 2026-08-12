# MJ SMS Telegram Bot (Grizzly only)

Deploy on **Vercel**. Supplier: **GrizzlySMS** (same as MJ HUB Server 1).

## Env vars (Vercel → Project → Settings → Environment Variables)

| Name | Required | Notes |
|------|----------|--------|
| `BOT_TOKEN` | Yes | From @BotFather |
| `GRIZZLYSMS_API_KEY` | Yes | Same key as main website |
| `SUPABASE_REST_URL` | Yes | e.g. `https://xxxx.supabase.co/rest/v1` |
| `SUPABASE_SERVICE_KEY` | Yes | Service role key |
| `USD_TO_NGN_RATE` | No | Default `1500` |
| `WEBHOOK_SECRET` | Recommended | Telegram webhook secret |
| `GEMINI_API_KEY` | Recommended | Mira AI chat (Pidgin, full tools) |
| `PAYSTACK_SECRET_KEY` | Recommended | Wallet top-up via Paystack |
| `ADMIN_TELEGRAM_ID` | No | Admin Telegram numeric id |

## Deploy

1. Push this repo to GitHub
2. Import project on vercel.com
3. Set env vars
4. Deploy
5. Open once: `https://YOUR-PROJECT.vercel.app/setup-webhook?secret=YOUR_WEBHOOK_SECRET`
6. In Paystack Dashboard → Settings → Webhooks, add:
   `https://YOUR-PROJECT.vercel.app/paystack`
   Event: `charge.success`

## Features

- Natural Pidgin + English agent (Mira) with full tool calling
- Buy numbers, check OTP, cancel/refund
- Paystack funding (`/fund 2000` or chat "fund my wallet")
- GrizzlySMS Server 1 only

## Stop Render

On Render: suspend/delete the old service so it does not fight the webhook.
