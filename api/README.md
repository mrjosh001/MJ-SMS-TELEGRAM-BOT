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
| `WEBHOOK_SECRET` | No | Optional path secret |
| `GEMINI_API_KEY` | No | Optional AI chat |
| `PAYSTACK_SECRET_KEY` | No | Optional /fund |

## Deploy

1. Push this repo to GitHub
2. Import project on vercel.com
3. Set env vars
4. Deploy
5. Open once: `https://YOUR-PROJECT.vercel.app/setup-webhook`  
   That registers Telegram webhook to your Vercel URL.

## Stop Render

On Render: suspend/delete the old service so it does not fight the webhook.
