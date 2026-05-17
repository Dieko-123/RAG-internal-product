# Branching and CI

This repository uses a protected integration flow for staged feature work.

## Branches

- `main` is the stable release branch. Cloudflare production should target this branch.
- `dev` is the integration branch. Cloudflare previews can target this branch.
- `feature/<short-name>` branches start from `dev`.
- Feature pull requests merge into `dev`.
- Release pull requests merge from `dev` into `main`.

Do not commit real secrets. Local `.env.local` files stay ignored. Gemini API keys must only live in Convex environment variables.

## Local commands

```bash
npm ci
npm run lint
npm run typecheck
npm run build
node scripts/ci/guard-secrets.mjs
node scripts/ci/guard-stack.mjs
```

For local development:

```bash
npx convex dev
npm run dev
```

CI does not run `npx convex dev`, deploy Convex functions, or require Convex deploy keys. It relies on TypeScript, committed generated Convex files, lint, and the Vite build.

## GitHub Actions

Pull requests into `dev` run the normal CI gate:

- install with `npm ci`
- lint
- typecheck
- build
- secret guard
- stack guard

Pull requests into `main` run the same checks and require the source branch to be `dev`.

## Cloudflare

Use the Cloudflare Git integration first. Do not add a Cloudflare API deployment workflow until the team needs manual promotions or custom release automation.

Recommended Cloudflare settings:

- Build command: `npm run build`
- Build output directory: `dist`
- Production branch: `main`
- Preview branch: `dev`

Cloudflare environment variables:

- `VITE_CONVEX_URL`
- `VITE_CLERK_PUBLISHABLE_KEY`

Convex environment variables stay in Convex:

- `CLERK_JWT_ISSUER_DOMAIN`
- `GEMINI_API_KEY`
- `GEMINI_DEFAULT_MODEL=gemini-2.5-flash-lite`
- `APP_ADMIN_EMAILS`
- `APP_ADMIN_TOKEN_IDENTIFIERS`
- `APP_ALLOWED_EMAILS`
- `APP_ALLOWED_EMAIL_DOMAINS`
- `MONTHLY_BUDGET_USD` later if needed

## GitHub branch protection

Protect `main`:

- Require a pull request before merging.
- Require the `CI Main` status check.
- Require at least one approval if desired.
- Require branches to be up to date if desired.
- Block force pushes.
- Block deletion.

Protect `dev`:

- Require a pull request before merging.
- Require the `CI Dev` status check.
- Block force pushes.
- Block deletion.

## Guardrails

Gemini API usage must stay in Convex/server-side code. Do not expose Gemini secrets or calls from browser code. `APP_ADMIN_EMAILS` and `APP_ADMIN_TOKEN_IDENTIFIERS` are comma-separated bootstrap admin allowlists. `APP_ALLOWED_EMAILS` and `APP_ALLOWED_EMAIL_DOMAINS` control non-admin access before memberships are created.
