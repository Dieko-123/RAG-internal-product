import type { AuthConfig } from 'convex/server'

const clerkDomain = process.env.CLERK_JWT_ISSUER_DOMAIN

if (!clerkDomain) {
  throw new Error('Missing CLERK_JWT_ISSUER_DOMAIN')
}

export default {
  providers: [
    {
      domain: clerkDomain,
      applicationID: 'convex',
    },
  ],
} satisfies AuthConfig
