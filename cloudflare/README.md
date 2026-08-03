# li-pulse on Cloudflare

This is the zero-budget hosted edition of li-pulse:

- Worker API in `src/index.ts`
- Static frontend in `public/`
- Durable cache and run audit in Cloudflare D1
- BYOK provider credentials; keys are never persisted

## Deploy

```bash
pnpm install
pnpm db:remote
pnpm deploy
```

The D1 binding and database ID are configured in `wrangler.jsonc`. For production abuse protection, create a Cloudflare Turnstile widget, add its client widget to `public/index.html`, and set the server secret with `wrangler secret put TURNSTILE_SECRET`.

The public API accepts at most 100 profiles per run. Use smaller browser-side batches (20–25 profiles) for real provider traffic to stay comfortably within Workers Free limits.

