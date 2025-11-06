# Repository Guidelines

## Project Structure & Module Organization
- `index.html` hosts the app shell loaded by Vite; avoid editing generated markup directly.
- `src/main.js` bootstraps the editor UI—add new modules under `src/` and import them through this entry point.
- `src/app.css` wires Tailwind layers; extend styling through Tailwind utilities or the config rather than ad-hoc CSS files.
- Tailwind lives in `tailwind.config.js` and `postcss.config.js`; add theme extensions or plugins there when new design tokens are required.
- Static assets live in `public/` (icons, `img/`); reference them with absolute paths so Vite handles caching.
- Production builds emit to `dist/`; never commit the directory.

## Build, Test, and Development Commands
- Run `npm install` before your first build to sync dependencies.
- `npm run dev` launches Vite with hot reload for iterative work.
- `npm run build` produces the optimized bundle in `dist/` for release checks.
- `npm run preview` serves the build locally to validate asset loading.
- `npm run typecheck` enforces the JSDoc typing contract across `src/`.
- `npm run format` applies the shared Prettier config to JavaScript and CSS.

## Coding Style & Naming Conventions
- Rely on Prettier defaults: two-space indentation, semicolons, trailing commas on multiline lists.
- Prefer ES modules, arrow functions, and `const`-first declarations in `src/`.
- Use camelCase for variables/functions, PascalCase for constructor-like exports, and kebab-case for new files.
- Reach for Tailwind utility classes that follow our established best practices, and avoid inline styles or bespoke selectors unless no Tailwind solution exists.
- Annotate new code with `// @ts-check` and JSDoc tags so `npm run typecheck` stays green.

## Testing Guidelines
- No automated tests exist yet; when adding behavior, include focused Vitest specs alongside the feature as `*.test.js`.
- Mock DOM APIs sparingly—exercise exported functions or rendered markup instead.
- Always run `npm run dev` and `npm run typecheck` before submitting to catch runtime and typing regressions.

## Commit & Pull Request Guidelines
- Follow the Git history: imperative, sentence-case summaries under ~60 characters (for example, `Improve editor initialization`).
- Reference related issues in the body, and attach before/after screenshots for visible UI changes.
- Ensure PR descriptions cover intent, approach, and manual verification steps so reviewers can reproduce locally.
