# poo-tee-weet

A distraction free writing tool. Live at https://poo-tee-weet.com.

Svelte 5 + Tailwind SPA in `src/`, Clerk for auth, and a Cloudflare Worker in `worker/` with two Durable Objects: `DocumentDO` holds one document, `UserIndexDO` holds one user's document list. Autosave runs over a WebSocket to the document's Durable Object.

## Scripts (pnpm)

- `pnpm dev` – Vite dev server with hot reload.
- `pnpm dev:worker` – run the Worker locally with Wrangler on port 8787.
- `pnpm build` – production build into `dist/`.
- `pnpm preview` – serve the production build locally.
- `pnpm typecheck` – svelte-check over the frontend.
- `pnpm typecheck:worker` – tsc over the Worker.
- `pnpm format` – Prettier.

## Environment

- Copy `.env.example` to `.env`:
  - `VITE_CLERK_PUBLISHABLE_KEY` – Clerk publishable key.
  - `VITE_WORKER_BASE_URL` – Worker origin (defaults to `http://127.0.0.1:8787`).
- Copy `.dev.vars.example` to `.dev.vars`:
  - `CLERK_SECRET_KEY` – Clerk secret key.
  - `ALLOWED_ORIGINS` – comma separated origins allowed to call the Worker. Production value lives in `wrangler.toml` under `[vars]`.

The frontend asks Clerk for a token using the JWT template named `poo-tee-weet`; that template must exist in the Clerk instance.

## Auth

Visit `http://localhost:5173#/sign-up` to create an account or `#/sign-in` for existing users.

## Worker API

All routes require `Authorization: Bearer <clerk token>` (WebSocket upgrades pass it as `?auth=`).

- `GET /me/docs` – list documents and tags.
- `POST /me/docs` – create a document `{ title, content, tags }`.
- `GET /docs/:id` – read a document.
- `POST /docs/:id` – update a document.
- `DELETE /docs/:id` – delete a document and its index entry.
- `GET /docs/:id/sync` (WebSocket) – realtime autosave; server sends `snapshot`, `ack`, `remote-update`.

## Deploying

- **Frontend:** Cloudflare Pages project `poo-tee-weet` builds `main` from GitHub automatically. Pushing to `main` deploys the site.
- **Worker:** manual. Run `pnpm wrangler deploy` after logging in with `wrangler login`. The only secret is `CLERK_SECRET_KEY`, set with `wrangler secret put CLERK_SECRET_KEY`.
