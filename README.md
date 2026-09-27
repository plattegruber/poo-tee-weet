# poo-tee-weet

A distraction free writing tool. Live at https://poo-tee-weet.com.

Svelte 5 + Tailwind SPA in `src/` (two screens: the writing page and a pages list), Clerk for auth, and a Cloudflare Worker in `worker/` with two Durable Objects: `DocumentDO` holds one document, `UserIndexDO` holds one user's document list. Autosave runs over a WebSocket to the document's Durable Object.

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

## Plugins

Plugins are enabled per document by tag. There is one so far.

### platte.dev

Add the tag `platte.dev` to a document and it becomes a post at `src/posts/<slug>.md` in the [platte-dot-dev](https://github.com/plattegruber/platte-dot-dev) repo. The document and the post are the same thing seen from two places: edit either side and the other catches up. Pushing to `main` there deploys the blog.

- **Push.** The Worker waits until typing has been idle for 30 seconds (or the last editor tab closes), converts the document to markdown with frontmatter, and commits it through the GitHub Contents API.
- **Pull.** Opening a document checks the file on GitHub. If it changed and the document did not, the post is converted back to editor HTML and loaded in.
- **Conflicts.** If both sides changed before they caught up, poo-tee-weet wins. The GitHub version stays in git history.
- **Adopt.** An empty document whose title matches an existing post takes that post over. A document with text takes a fresh slug (`title-2`) so nothing is overwritten.
- The slug is fixed on first publish, so renaming a document later updates the post title but keeps the URL.
- `date` is the first publish date and sticks if edited on GitHub. `description` is always the first paragraph.
- Removing the tag or deleting the document stops syncing. It does not delete the post. A file deleted on GitHub while the tag is on is put back.
- Only the configured `PLATTE_DEV_OWNER_ID` can publish, so other accounts tagging `platte.dev` are ignored.

Configuration: `PLATTE_DEV_OWNER_ID`, `PLATTE_DEV_REPO`, `PLATTE_DEV_BRANCH` and `PLATTE_DEV_POSTS_DIR` live in `wrangler.toml` under `[vars]`. `GITHUB_TOKEN` is a secret: a fine-grained personal access token with **Contents: read and write** on the blog repo, set with `wrangler secret put GITHUB_TOKEN`.

## Deploying

- **Frontend:** Cloudflare Pages project `poo-tee-weet` builds `main` from GitHub automatically. Pushing to `main` deploys the site.
- **Worker:** manual. Run `pnpm wrangler deploy` after logging in with `wrangler login`. Secrets are `CLERK_SECRET_KEY` and `GITHUB_TOKEN`, set with `wrangler secret put <NAME>`.
