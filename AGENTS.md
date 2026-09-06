# Repository Guidelines

## Layout

- `src/App.svelte` – Clerk provider and signed-in/out switch.
- `src/components/SignedInView.svelte` – the whole signed-in app: the writing page (top bar, title, tags, contenteditable body, WebSocket autosave) and the pages list (tag filter, search). Screens are switched with local state, no router.
- `src/components/Icon.svelte` – the few Lucide glyphs the interface uses, inlined.
- `src/components/SignedOutView.svelte` – Clerk sign-in/sign-up.
- `worker/src/index.ts` – Worker router plus `UserIndexDO` and `DocumentDO`.
- `wrangler.toml` – Worker config; production `ALLOWED_ORIGINS` is set here.
- Static assets live in `public/`. `dist/` is build output and never committed.

## Commands

- `pnpm install`, then `pnpm dev` and `pnpm dev:worker` in two terminals.
- `pnpm typecheck` and `pnpm typecheck:worker` must both pass before committing.
- `pnpm build` to confirm the bundle compiles.

## Style

- Code is TypeScript inside Svelte 5 (runes) and TypeScript in the Worker. Prettier defaults: two-space indent, semicolons, trailing commas.
- Tailwind utilities over custom CSS. Theme tokens live in `tailwind.config.js`: oat paper surfaces, plum-cast ink, a single plum accent; Literata for titles and prose, Public Sans for interface text, IBM Plex Mono for tags and counts. Copy is sentence case, quiet, no emoji.
- Keep it flat and small. Prefer adding to the existing file over new abstractions unless the file is clearly the wrong place.

## Testing

- No automated tests. The Clerk production instance is bound to poo-tee-weet.com, so end-to-end checks run against the live site after deploy. Smoke-test the Worker locally with `pnpm dev:worker` and curl for auth and CORS behaviour.

## Commits

- Imperative, sentence-case summaries under ~60 characters.
- Push to `main` deploys the frontend via Cloudflare Pages. The Worker needs a separate `pnpm wrangler deploy`.
