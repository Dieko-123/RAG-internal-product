# Deployment

This project is a React + Vite single-page app backed by Convex. Deploy only
the built static frontend to Cloudflare. Gemini and other private keys belong
in Convex environment variables, never in Cloudflare frontend variables.

## Cloudflare Pages

Recommended Pages settings:

- GitHub repo: `Dieko-123/RAG-internal-product`
- Production branch: `main`
- Preview branch: `dev`
- Root directory: repository root
- Framework preset: Vite, or None
- Build command: `npm run build`
- Build output directory: `dist`
- Node version: 20

Required Cloudflare Pages environment variables:

- `VITE_CONVEX_URL`
- `VITE_CLERK_PUBLISHABLE_KEY`

Do not set these in Cloudflare Pages:

- `GEMINI_API_KEY`
- `CLERK_SECRET_KEY`
- private keys
- confidential document values

The `public/_redirects` file is copied by Vite into `dist/_redirects` so
Cloudflare Pages serves `index.html` for SPA navigation routes.

## Cloudflare Workers Static Assets

If deploying as a Worker instead of Pages, `wrangler.toml` serves `./dist` as
static assets and enables SPA fallback:

```toml
[assets]
directory = "./dist"
not_found_handling = "single-page-application"
```

Deploying to a `workers.dev` URL means you are looking at a Workers deployment,
not the usual Pages URL. If that URL shows Hello World, verify that the Worker is
connected to this repository and the latest commit, not a default starter Worker.

## Convex

Production frontend deployments must point to a Convex deployment that has the
same backend functions deployed and the required server-side environment
variables set.

Required Convex environment variables:

- `CLERK_JWT_ISSUER_DOMAIN`
- `GEMINI_API_KEY`
- `GEMINI_DEFAULT_MODEL=gemini-2.5-flash-lite`
- `APP_ADMIN_EMAILS`
- `APP_ADMIN_TOKEN_IDENTIFIERS`

Do not add Gemini keys to the frontend, Cloudflare Pages, or browser code.

## Clerk

In Clerk, allow the deployed Cloudflare origin and callback URLs. At minimum,
check the Cloudflare URL used by users is allowed for sign-in, sign-up, and
redirects. Use a Clerk publishable key from the matching Clerk environment.
