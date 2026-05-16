import { query } from './_generated/server'

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()

    if (!identity) {
      throw new Error('Not authenticated')
    }

    return {
      subject: identity.subject,
      tokenIdentifier: identity.tokenIdentifier,
      issuer: identity.issuer,
      email: identity.email ?? null,
      name: identity.name ?? null,
    }
  },
})
