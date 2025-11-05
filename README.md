# poo-tee-weet

## Scripts

- `npm run dev` – start a Vite dev server with hot reload.
- `npm run build` – generate a production build in `dist/`.
- `npm run preview` – preview the production build locally.
- `npm run format` – format source files with Prettier.
- `npm run typecheck` – run TypeScript in checkJs mode for JSDoc types.

## Environment

- Copy `.env.example` to `.env` and set `VITE_CLERK_PUBLISHABLE_KEY` with your Clerk publishable key.

## Authentication

- Visit `http://localhost:5173#/sign-up` to create a new Clerk account, or use `#/sign-in` for existing users.
- Successful sign-in returns you to the editor with a Clerk user menu pinned to the top-right corner.

## JSDoc Types

- Source files opt into type checking with `// @ts-check`.
- Add `@type`/`@param` annotations to expose types to editors and `npm run typecheck`.
