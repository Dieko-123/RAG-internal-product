import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'

type AuthCtx = Pick<QueryCtx | MutationCtx | ActionCtx, 'auth'>

export type SafeIdentity = {
  subject: string
  tokenIdentifier: string
  issuer: string
  email: string | null
  name: string | null
}

export async function requireUser(ctx: AuthCtx): Promise<SafeIdentity> {
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
}

export async function requireAdmin(ctx: AuthCtx): Promise<SafeIdentity> {
  const identity = await requireUser(ctx)
  const adminEmails = parseList(process.env.APP_ADMIN_EMAILS, {
    lowercase: true,
  })
  const adminTokenIdentifiers = parseList(
    process.env.APP_ADMIN_TOKEN_IDENTIFIERS,
  )
  const email = identity.email?.toLowerCase()
  const tokenIdentifier = identity.tokenIdentifier

  if (email && adminEmails.has(email)) {
    return identity
  }

  if (adminTokenIdentifiers.has(tokenIdentifier)) {
    return identity
  }

  throw new Error('Admin access required')
}

function parseList(
  value: string | undefined,
  options: { lowercase?: boolean } = {},
): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .map((item) => (options.lowercase ? item.toLowerCase() : item))
      .filter(Boolean),
  )
}
