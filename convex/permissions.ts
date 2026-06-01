import type { Id } from './_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'

type AuthCtx = Pick<QueryCtx | MutationCtx | ActionCtx, 'auth'>
type DbCtx = Pick<QueryCtx | MutationCtx, 'auth' | 'db'>

const DEFAULT_ORGANIZATION_NAME = 'ExecuJet Aviation Nigeria'
const DEFAULT_ORGANIZATION_SLUG = 'execujet-aviation-nigeria'

export type SafeIdentity = {
  subject: string
  tokenIdentifier: string
  issuer: string
  email: string | null
  name: string | null
}

export type MembershipRole =
  | 'owner'
  | 'org_admin'
  | 'department_admin'
  | 'member'
  | 'viewer'

export type OrgScopedPermission = {
  identity: SafeIdentity
  organizationId: Id<'organizations'>
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

export function isAdminIdentity(identity: SafeIdentity): boolean {
  const adminEmails = parseList(process.env.APP_ADMIN_EMAILS, {
    lowercase: true,
  })
  const adminTokenIdentifiers = parseList(
    process.env.APP_ADMIN_TOKEN_IDENTIFIERS,
  )
  const email = identity.email?.toLowerCase()
  const tokenIdentifier = identity.tokenIdentifier

  if (email && adminEmails.has(email)) {
    return true
  }

  return adminTokenIdentifiers.has(tokenIdentifier)
}

export async function requireAdmin(ctx: AuthCtx): Promise<SafeIdentity> {
  const identity = await requireUser(ctx)

  if (isAdminIdentity(identity)) {
    return identity
  }

  throw new Error('Admin access required')
}

export async function requireAllowedUser(ctx: DbCtx): Promise<SafeIdentity> {
  const identity = await requireUser(ctx)

  const user = await ctx.db
    .query('users')
    .withIndex('by_tokenIdentifier', (q) =>
      q.eq('tokenIdentifier', identity.tokenIdentifier),
    )
    .unique()

  if (user?.status === 'suspended') {
    throw new Error('Not authorized for this internal app.')
  }

  if (isAdminIdentity(identity) || isAllowedIdentity(identity)) {
    return identity
  }

  if (user?.status === 'active') {
    return identity
  }

  throw new Error('Not authorized for this internal app.')
}

export async function ensureUserAndMembership(
  ctx: MutationCtx,
  overrides?: { emailOverride?: string; nameOverride?: string },
) {
  const identity = await requireUser(ctx)
  const now = Date.now()
  const email = (overrides?.emailOverride ?? identity.email)?.toLowerCase()?.trim()
  const name = overrides?.nameOverride ?? identity.name ?? undefined
  const existingUser = await ctx.db
    .query('users')
    .withIndex('by_tokenIdentifier', (q) =>
      q.eq('tokenIdentifier', identity.tokenIdentifier),
    )
    .unique()
  let targetOrganizationId: Id<'organizations'> | null = null
  let targetRole: MembershipRole = isAdminIdentity(identity) ? 'org_admin' : 'member'
  let pendingInvite:
    | {
        organizationId: Id<'organizations'>
        role: 'org_admin' | 'member' | 'viewer'
      }
    | null = null

  if (!isAdminIdentity(identity) && !isAllowedIdentity(identity)) {
    if (existingUser?.status === 'active') {
      const existingMembership = await ctx.db
        .query('memberships')
        .withIndex('by_userTokenIdentifier', (q) =>
          q.eq('userTokenIdentifier', identity.tokenIdentifier),
        )
        .collect()
      const membership =
        existingMembership.find((m) => m.departmentId === undefined) ??
        existingMembership[0]

      if (!membership) {
        throw new Error('Not authorized for this internal app.')
      }

      targetOrganizationId = membership.organizationId
      targetRole = membership.role
    } else if (existingUser?.status === 'suspended') {
      throw new Error('Not authorized for this internal app.')
    } else {
      if (email) {
        const pendingInvites = await ctx.db
          .query('invites')
          .withIndex('by_emailNormalized_and_status', (q) =>
            q.eq('emailNormalized', email).eq('status', 'pending'),
          )
          .collect()

        const validInvite = pendingInvites.find(
          (inv) => !inv.expiresAt || inv.expiresAt >= now,
        )

        if (!validInvite) {
          throw new Error('Not authorized for this internal app.')
        }

        pendingInvite = {
          organizationId: validInvite.organizationId,
          role: validInvite.role,
        }
        targetOrganizationId = validInvite.organizationId
        targetRole = validInvite.role
      } else {
        throw new Error('Not authorized for this internal app.')
      }
    }
  }

  if (!targetOrganizationId) {
    const existingMembership = await ctx.db
      .query('memberships')
      .withIndex('by_userTokenIdentifier', (q) =>
        q.eq('userTokenIdentifier', identity.tokenIdentifier),
      )
      .collect()
    const membership =
      existingMembership.find((m) => m.departmentId === undefined) ??
      existingMembership[0]

    if (membership) {
      targetOrganizationId = membership.organizationId
      targetRole = membership.role
    } else {
      targetOrganizationId = await getOrCreateDefaultOrganization(ctx)
      targetRole = isAdminIdentity(identity) ? 'org_admin' : 'member'
    }
  }

  if (existingUser) {
    await ctx.db.patch(existingUser._id, {
      email,
      name,
      updatedAt: now,
    })
  } else {
    await ctx.db.insert('users', {
      tokenIdentifier: identity.tokenIdentifier,
      email,
      name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
  }

  const existingMembership = await ctx.db
    .query('memberships')
    .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
      q
        .eq('organizationId', targetOrganizationId)
        .eq('userTokenIdentifier', identity.tokenIdentifier),
    )
    .filter((q) => q.eq(q.field('departmentId'), undefined))
    .unique()

  if (existingMembership) {
    if (
      existingMembership.role !== targetRole &&
      (targetRole === 'org_admin' || pendingInvite)
    ) {
      await ctx.db.patch(existingMembership._id, {
        role: targetRole,
        updatedAt: now,
      })
    }
  } else {
    await ctx.db.insert('memberships', {
      organizationId: targetOrganizationId,
      userTokenIdentifier: identity.tokenIdentifier,
      role: targetRole,
      createdAt: now,
      updatedAt: now,
    })
  }

  return {
    identity,
    organizationId: targetOrganizationId,
    role: targetRole,
  }
}

export async function requireOrgAdmin(ctx: DbCtx): Promise<{
  identity: SafeIdentity
  organizationId: Id<'organizations'>
}>
export async function requireOrgAdmin(
  ctx: DbCtx,
  organizationId: Id<'organizations'>,
): Promise<{
  identity: SafeIdentity
  organizationId: Id<'organizations'>
}>
export async function requireOrgAdmin(
  ctx: DbCtx,
  organizationId?: Id<'organizations'>,
): Promise<{
  identity: SafeIdentity
  organizationId: Id<'organizations'>
}> {
  const identity = await requireAllowedUser(ctx)
  const resolvedOrganizationId =
    organizationId ?? (await getDefaultOrganization(ctx))?._id

  if (!resolvedOrganizationId) {
    throw new Error('Organization is not configured.')
  }

  const memberships = await ctx.db
    .query('memberships')
    .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
      q
        .eq('organizationId', resolvedOrganizationId)
        .eq('userTokenIdentifier', identity.tokenIdentifier),
    )
    .collect()
  const hasOrgAdminRole = memberships.some(
    (membership) =>
      membership.departmentId === undefined &&
      (membership.role === 'owner' || membership.role === 'org_admin'),
  )

  if (!isAdminIdentity(identity) && !hasOrgAdminRole) {
    throw new Error('Admin access required')
  }

  return {
    identity,
    organizationId: resolvedOrganizationId,
  }
}

export async function requireOrganizationMembership(
  ctx: DbCtx,
  organizationId: Id<'organizations'>,
): Promise<OrgScopedPermission & { roles: MembershipRole[] }> {
  const identity = await requireAllowedUser(ctx)
  const organization = await ctx.db.get(organizationId)

  if (!organization) {
    throw new Error('Organization not found.')
  }

  const memberships = await ctx.db
    .query('memberships')
    .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
      q
        .eq('organizationId', organizationId)
        .eq('userTokenIdentifier', identity.tokenIdentifier),
    )
    .collect()

  if (!isAdminIdentity(identity) && memberships.length === 0) {
    throw new Error('Organization not found.')
  }

  return {
    identity,
    organizationId,
    roles: memberships.map((membership) => membership.role),
  }
}

export async function getDefaultOrganization(ctx: Pick<QueryCtx | MutationCtx, 'db'>) {
  return await ctx.db
    .query('organizations')
    .withIndex('by_slug', (q) => q.eq('slug', DEFAULT_ORGANIZATION_SLUG))
    .unique()
}

export async function getOrCreateDefaultOrganization(ctx: MutationCtx) {
  const existing = await getDefaultOrganization(ctx)

  if (existing) {
    return existing._id
  }

  const now = Date.now()

  return await ctx.db.insert('organizations', {
    name: DEFAULT_ORGANIZATION_NAME,
    slug: DEFAULT_ORGANIZATION_SLUG,
    createdAt: now,
    updatedAt: now,
  })
}

function isAllowedIdentity(identity: SafeIdentity): boolean {
  const allowedEmails = parseList(process.env.APP_ALLOWED_EMAILS, {
    lowercase: true,
  })
  const allowedDomains = parseList(process.env.APP_ALLOWED_EMAIL_DOMAINS, {
    lowercase: true,
  })
  const email = identity.email?.toLowerCase()

  if (!email) {
    return false
  }

  if (allowedEmails.has(email)) {
    return true
  }

  const domain = email.split('@')[1]

  return Boolean(domain && allowedDomains.has(domain))
}

export type UploadPermissionResult = {
  identity: SafeIdentity
  organizationId: Id<'organizations'>
  effectiveVisibility: 'org' | 'department'
  effectiveDepartmentId: Id<'departments'> | undefined
}

export async function requireManualUploadPermission(
  ctx: DbCtx,
  opts: {
    organizationId: Id<'organizations'>
    visibility: 'org' | 'department' | 'restricted'
    departmentId?: Id<'departments'>
  },
): Promise<UploadPermissionResult> {
  if (opts.visibility === 'restricted') {
    throw new Error('Restricted visibility uploads are not yet supported.')
  }

  const identity = await requireAllowedUser(ctx)
  const organization = await ctx.db.get(opts.organizationId)

  if (!organization) {
    throw new Error('Organization not found.')
  }

  const orgMemberships = await ctx.db
    .query('memberships')
    .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
      q
        .eq('organizationId', opts.organizationId)
        .eq('userTokenIdentifier', identity.tokenIdentifier),
    )
    .collect()

  const isOrgLevel = orgMemberships.some(
    (m) =>
      m.departmentId === undefined &&
      (m.role === 'owner' || m.role === 'org_admin'),
  )

  if (!isAdminIdentity(identity) && orgMemberships.length === 0) {
    throw new Error('Organization not found.')
  }

  if (isAdminIdentity(identity) || isOrgLevel) {
    if (opts.visibility === 'department' && opts.departmentId) {
      const dept = await ctx.db.get(opts.departmentId)
      if (!dept || dept.organizationId !== opts.organizationId) {
        throw new Error('Department not found in this organization.')
      }
    }

    return {
      identity,
      organizationId: opts.organizationId,
      effectiveVisibility: opts.visibility,
      effectiveDepartmentId: opts.visibility === 'department' ? opts.departmentId : undefined,
    }
  }

  if (opts.visibility === 'org') {
    throw new Error('Only org admins can upload org-wide manuals.')
  }

  if (opts.visibility !== 'department' || !opts.departmentId) {
    throw new Error('Department admins must specify a target department.')
  }

  const dept = await ctx.db.get(opts.departmentId)
  if (!dept || dept.organizationId !== opts.organizationId) {
    throw new Error('Department not found in this organization.')
  }

  const deptMembership = await ctx.db
    .query('memberships')
    .withIndex('by_departmentId_and_userTokenIdentifier', (q) =>
      q
        .eq('departmentId', opts.departmentId!)
        .eq('userTokenIdentifier', identity.tokenIdentifier),
    )
    .unique()

  if (!deptMembership || deptMembership.role !== 'department_admin') {
    throw new Error('You do not have upload permission for this department.')
  }

  return {
    identity,
    organizationId: opts.organizationId,
    effectiveVisibility: 'department',
    effectiveDepartmentId: opts.departmentId,
  }
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
