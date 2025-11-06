# poo-tee-weet

## Scripts

- `npm run dev` – start the Vite dev server with hot reload.
- `npm run dev:worker` – run the Cloudflare Worker locally with Wrangler.
- `npm run build` – generate a production build in `dist/`.
- `npm run preview` – preview the production build locally.
- `npm run format` – format source files with Prettier.
- `npm run typecheck` – run TypeScript in checkJs mode for JSDoc types.

## Environment

- Copy `.env.example` to `.env` (or `.env.local`) and set:
  - `VITE_CLERK_PUBLISHABLE_KEY` – Clerk publishable key.
  - `VITE_WORKER_BASE_URL` – base URL for the Worker (defaults to `http://127.0.0.1:8787`).
- Copy `.dev.vars.example` to `.dev.vars` and set:
  - `CLERK_SECRET_KEY` – Clerk secret key.
  - `ALLOWED_ORIGINS` – comma separated list of origins allowed to call the Worker.

## Authentication

- Visit `http://localhost:5173#/sign-up` to create a new Clerk account, or use `#/sign-in` for existing users.
- Successful sign-in returns you to the editor with a Clerk user menu pinned to the top-right corner.

## Backend Worker

- The Worker entry point lives in `worker/src/index.ts` and exposes REST endpoints for document CRUD.
- Durable Objects:
  - `DocumentDO` stores canonical document content.
  - `UserIndexDO` manages per-user document indexes and orchestrates writes.
- Run `npm run dev:worker` to start Wrangler locally (`wrangler dev --local`), then launch the Vite dev server in a second terminal.
- Production deploys are triggered through the Cloudflare deployment automation (build + `wrangler deploy`).
- Deploy using your usual Wrangler deployment flow (`wrangler deploy`) once environment variables are configured.

## JSDoc Types

- Source files opt into type checking with `// @ts-check`.
- Add `@type`/`@param` annotations to expose types to editors and `npm run typecheck`.
