# 🧰 Ephemeral Suite

🌐 [Español](./README.md) · **English** · [Português](./README.pt.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MauricioPerera/wrangler-ephemeral-suite)

**Chat + whiteboard + airdrop in a single deploy.** If you want all three tools at once (a meeting where you chat, draw, and pass along a file), you don't need three separate `wrangler deploy --temporary` runs with three temporary accounts — this combines them into a single Worker, a single account, a single link/claim URL.

Each tool still exists **standalone**, unchanged, for anyone who only needs one:
[wrangler-ephemeral-chat](https://github.com/MauricioPerera/wrangler-ephemeral-chat) · [wrangler-ephemeral-whiteboard](https://github.com/MauricioPerera/wrangler-ephemeral-whiteboard) · [wrangler-ephemeral-airdrop](https://github.com/MauricioPerera/wrangler-ephemeral-airdrop)

## How it works

- `wrangler deploy --temporary` creates a temporary Cloudflare account (no login) and deploys a single Worker with **three separate Durable Objects** (`ChatRoom`, `Board`, `Drop`).
- Each tool lives under its own route prefix so they don't collide:
  - `/chat` — real-time chat
  - `/board` — collaborative whiteboard
  - `/drop` — share a file via QR/link
- `/` is a simple hub with links to all three.
- Everything shares the same temporary account — one countdown, one claim URL, one deploy.

## Requirements

- Node.js
- Wrangler **4.102.0 or later**
- **Not logged in** to Wrangler (`wrangler logout` if you already have a session)

## Deploy

```bash
git clone https://github.com/MauricioPerera/wrangler-ephemeral-suite.git
cd wrangler-ephemeral-suite
npm install
npx wrangler deploy --temporary
```

Open the root URL for the hub, or go straight to `/chat`, `/board`, or `/drop`.

### Permanent deploy (optional)

`wrangler login` + `npx wrangler deploy` instead of `--temporary`, or the **Deploy to Cloudflare** button above.

## Features

Same as the three individual projects, no cuts:

- **Chat**: real-time, admin + single-use invites, persistent history, mobile UI
- **Whiteboard**: live collaborative drawing, export/import PNG and JSON, admin + invites
- **Airdrop**: drag & drop upload, QR generated in the browser, download without prior connection, verified up to 18MB

## Why this is worth it over three deploys

- One `wrangler deploy --temporary` instead of three
- One claim URL if you want to keep everything
- One temporary account sharing the same ~1 hour window — everything expires together, no desync between tools
- Total bundle stays small (~60KB, no WASM like in the sandbox) — no real cost to combining

## What you lose by combining

- You can't deploy "just the chat" from this repo anymore — use the corresponding standalone repo for that
- The code for the three tools is duplicated between this repo and the three originals (intentional: each stays independent, no shared dependency)

## Structure

```
src/index.js       — all three Worker + Durable Object (ChatRoom, Board, Drop) + hub + prefix-based routing
wrangler.jsonc      — Worker config with the three Durable Object bindings
```

## Limits (inherited from Cloudflare temporary accounts)

Same as the three individual projects — see their respective READMEs for the tested detail of each.

## Are you an AI agent?

See [AGENTS.md](./AGENTS.md) for autonomous deployment instructions with `wrangler --temporary`.
