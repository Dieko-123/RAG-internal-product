import { v } from 'convex/values'
import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import {
  ensureUserAndMembership,
  getOrCreateDefaultOrganization,
  isAdminIdentity,
  requireManualUploadPermission,
  requireOrganizationMembership,
  requireOrgAdmin,
  requireAllowedUser,
} from './permissions'
import type { Id } from './_generated/dataModel'

function toSafeIdentity(identity: {
  subject: string
  tokenIdentifier: string
  issuer: string
  email?: string | null
  name?: string | null
}) {
  return {
    subject: identity.subject,
    tokenIdentifier: identity.tokenIdentifier,
    issuer: identity.issuer,
    email: identity.email ?? null,
    name: identity.name ?? null,
  }
}

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()

    if (!identity) {
      return null
    }

    return toSafeIdentity(identity)
  },
})

export const isCurrentUserAdmin = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()

    if (!identity) {
      return false
    }

    return isAdminIdentity(toSafeIdentity(identity))
  },
})

export const ensureCurrentUserAccess = mutation({
  args: {
    email: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await ensureUserAndMembership(ctx, {
      emailOverride: args.email,
      nameOverride: args.name,
    })

    const emailNormalized = (result.identity.email ?? args.email)?.toLowerCase()?.trim()
    if (emailNormalized) {
      const pendingInvites = await ctx.db
        .query('invites')
        .withIndex('by_emailNormalized_and_status', (q) =>
          q.eq('emailNormalized', emailNormalized).eq('status', 'pending'),
        )
        .collect()
      const pendingInvite = pendingInvites.find(
        (invite) => invite.organizationId === result.organizationId,
      )

      if (
        pendingInvite &&
        pendingInvite.organizationId === result.organizationId
      ) {
        if (!pendingInvite.expiresAt || pendingInvite.expiresAt >= Date.now()) {
          const now = Date.now()
          await ctx.db.patch(pendingInvite._id, {
            status: 'accepted',
            acceptedByTokenIdentifier: result.identity.tokenIdentifier,
            acceptedAt: now,
          })

          if (!pendingInvite.departmentId && pendingInvite.role !== result.role) {
            const orgMembership = await ctx.db
              .query('memberships')
              .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
                q
                  .eq('organizationId', result.organizationId)
                  .eq('userTokenIdentifier', result.identity.tokenIdentifier),
              )
              .filter((q) => q.eq(q.field('departmentId'), undefined))
              .unique()

            if (orgMembership && orgMembership.role !== 'owner') {
              await ctx.db.patch(orgMembership._id, {
                role: pendingInvite.role,
                updatedAt: now,
              })
            }
          }

          if (pendingInvite.departmentId) {
            const existingDeptMembership = await ctx.db
              .query('memberships')
              .withIndex('by_departmentId_and_userTokenIdentifier', (q) =>
                q
                  .eq('departmentId', pendingInvite.departmentId!)
                  .eq('userTokenIdentifier', result.identity.tokenIdentifier),
              )
              .unique()

            if (!existingDeptMembership) {
              await ctx.db.insert('memberships', {
                organizationId: result.organizationId,
                departmentId: pendingInvite.departmentId,
                userTokenIdentifier: result.identity.tokenIdentifier,
                role: pendingInvite.departmentRole ?? 'member',
                createdAt: now,
                updatedAt: now,
              })
            } else if (
              pendingInvite.departmentRole &&
              existingDeptMembership.role !== pendingInvite.departmentRole
            ) {
              await ctx.db.patch(existingDeptMembership._id, {
                role: pendingInvite.departmentRole,
                updatedAt: now,
              })
            }
          }

          await ctx.db.insert('auditEvents', {
            actorTokenIdentifier: result.identity.tokenIdentifier,
            action: 'invite_accepted',
            targetType: 'invite',
            targetId: pendingInvite._id,
            metadata: {
              email: pendingInvite.email,
              role: pendingInvite.role,
              departmentId: pendingInvite.departmentId ?? '',
            },
            createdAt: now,
          })
        } else {
          await ctx.db.patch(pendingInvite._id, { status: 'expired' })
        }
      }
    }

    return {
      organizationId: result.organizationId,
      role: result.role,
    }
  },
})

export const listExistingUsersForAdmin = query({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    await requireOrgAdmin(ctx, args.organizationId)

    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_organizationId', (q) =>
        q.eq('organizationId', args.organizationId),
      )
      .collect()
    const tokenIdentifiers = [
      ...new Set(memberships.map((membership) => membership.userTokenIdentifier)),
    ]
    const users = []

    for (const tokenIdentifier of tokenIdentifiers) {
      const user = await ctx.db
        .query('users')
        .withIndex('by_tokenIdentifier', (q) =>
          q.eq('tokenIdentifier', tokenIdentifier),
        )
        .unique()
      if (user) {
        users.push(user)
      }
    }

    return users.sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''))
  },
})

export const assignUserToDepartment = mutation({
  args: {
    organizationId: v.id('organizations'),
    userTokenIdentifier: v.string(),
    departmentId: v.id('departments'),
    role: v.union(v.literal('member'), v.literal('department_admin')),
  },
  handler: async (ctx, args) => {
    const { identity, organizationId } = await requireOrgAdmin(ctx, args.organizationId)
    const now = Date.now()
    const user = await ctx.db
      .query('users')
      .withIndex('by_tokenIdentifier', (q) =>
        q.eq('tokenIdentifier', args.userTokenIdentifier),
      )
      .unique()

    if (!user || user.status !== 'active') {
      throw new Error('User must sign in before department assignment.')
    }

    const department = await ctx.db.get(args.departmentId)

    if (!department || department.organizationId !== organizationId) {
      throw new Error('Department not found.')
    }

    const organizationMembership = await ctx.db
      .query('memberships')
      .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
        q
          .eq('organizationId', organizationId)
          .eq('userTokenIdentifier', args.userTokenIdentifier),
      )
      .filter((q) => q.eq(q.field('departmentId'), undefined))
      .unique()

    if (!organizationMembership) {
      throw new Error('User must belong to the organization first.')
    }

    const existing = await ctx.db
      .query('memberships')
      .withIndex('by_departmentId_and_userTokenIdentifier', (q) =>
        q
          .eq('departmentId', args.departmentId)
          .eq('userTokenIdentifier', args.userTokenIdentifier),
      )
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, {
        role: args.role,
        updatedAt: now,
      })

      await ctx.db.insert('auditEvents', {
        actorTokenIdentifier: identity.tokenIdentifier,
        action: 'membership_updated',
        targetType: 'membership',
        targetId: existing._id,
        metadata: {
          departmentName: department.name,
          role: args.role,
          userTokenIdentifier: args.userTokenIdentifier,
        },
        createdAt: now,
      })

      return existing._id
    }

    const membershipId = await ctx.db.insert('memberships', {
      organizationId,
      departmentId: args.departmentId,
      userTokenIdentifier: args.userTokenIdentifier,
      role: args.role,
      createdAt: now,
      updatedAt: now,
    })

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: identity.tokenIdentifier,
      action: 'membership_assigned',
      targetType: 'membership',
      targetId: membershipId,
      metadata: {
        departmentName: department.name,
        role: args.role,
        userTokenIdentifier: args.userTokenIdentifier,
      },
      createdAt: now,
    })

    return membershipId
  },
})

export const suspendUser = mutation({
  args: {
    organizationId: v.id('organizations'),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const { identity, organizationId } = await requireOrgAdmin(ctx, args.organizationId)
    const now = Date.now()
    const user = await ctx.db.get(args.userId)

    if (!user) {
      throw new Error('User not found.')
    }

    const targetMembership = await ctx.db
      .query('memberships')
      .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
        q
          .eq('organizationId', organizationId)
          .eq('userTokenIdentifier', user.tokenIdentifier),
      )
      .first()

    if (!targetMembership) {
      throw new Error('User not found.')
    }

    if (user.status === 'suspended') {
      return
    }

    if (user.tokenIdentifier === identity.tokenIdentifier) {
      const orgAdmins = await ctx.db
        .query('memberships')
        .withIndex('by_organizationId', (q) => q.eq('organizationId', organizationId))
        .filter((q) =>
          q.and(
            q.eq(q.field('departmentId'), undefined),
            q.or(
              q.eq(q.field('role'), 'owner'),
              q.eq(q.field('role'), 'org_admin'),
            ),
          ),
        )
        .collect()

      if (orgAdmins.length <= 1) {
        throw new Error('Cannot suspend the last org admin.')
      }
    }

    await ctx.db.patch(args.userId, { status: 'suspended', updatedAt: now })

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: identity.tokenIdentifier,
      action: 'user_suspended',
      targetType: 'user',
      targetId: args.userId,
      metadata: {
        email: user.email ?? '',
        userTokenIdentifier: user.tokenIdentifier,
      },
      createdAt: now,
    })
  },
})

export const unsuspendUser = mutation({
  args: {
    organizationId: v.id('organizations'),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const { identity, organizationId } = await requireOrgAdmin(ctx, args.organizationId)
    const now = Date.now()
    const user = await ctx.db.get(args.userId)

    if (!user) {
      throw new Error('User not found.')
    }

    const targetMembership = await ctx.db
      .query('memberships')
      .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
        q
          .eq('organizationId', organizationId)
          .eq('userTokenIdentifier', user.tokenIdentifier),
      )
      .first()

    if (!targetMembership) {
      throw new Error('User not found.')
    }

    if (user.status === 'active') {
      return
    }

    await ctx.db.patch(args.userId, { status: 'active', updatedAt: now })

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: identity.tokenIdentifier,
      action: 'user_unsuspended',
      targetType: 'user',
      targetId: args.userId,
      metadata: {
        email: user.email ?? '',
        userTokenIdentifier: user.tokenIdentifier,
      },
      createdAt: now,
    })
  },
})

export const getCurrentOrganization = query({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    await requireOrganizationMembership(ctx, args.organizationId)

    return await ctx.db.get(args.organizationId)
  },
})

export const listMyOrganizations = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAllowedUser(ctx)
    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_userTokenIdentifier', (q) =>
        q.eq('userTokenIdentifier', identity.tokenIdentifier),
      )
      .collect()

    const byOrganizationId = new Map<
      Id<'organizations'>,
      {
        roles: Array<'owner' | 'org_admin' | 'department_admin' | 'member' | 'viewer'>
        departmentIds: Id<'departments'>[]
      }
    >()

    for (const membership of memberships) {
      const existing = byOrganizationId.get(membership.organizationId) ?? {
        roles: [],
        departmentIds: [],
      }
      existing.roles.push(membership.role)
      if (membership.departmentId) {
        existing.departmentIds.push(membership.departmentId)
      }
      byOrganizationId.set(membership.organizationId, existing)
    }

    const organizations = []
    for (const [organizationId, membershipInfo] of byOrganizationId) {
      const organization = await ctx.db.get(organizationId)
      if (!organization) continue

      organizations.push({
        _id: organization._id,
        name: organization.name,
        slug: organization.slug,
        roles: membershipInfo.roles,
        departmentIds: membershipInfo.departmentIds,
      })
    }

    return organizations.sort((a, b) => a.name.localeCompare(b.name))
  },
})

export const internalRequireAllowedUser = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await requireAllowedUser(ctx)
  },
})

export const internalRequireManualUploadPermission = internalQuery({
  args: {
    organizationId: v.id('organizations'),
    visibility: v.union(v.literal('org'), v.literal('department'), v.literal('restricted')),
    departmentId: v.optional(v.id('departments')),
  },
  handler: async (ctx, args) => {
    return await requireManualUploadPermission(ctx, {
      organizationId: args.organizationId,
      visibility: args.visibility,
      departmentId: args.departmentId,
    })
  },
})

export const internalRequireOrgAdmin = internalQuery({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    return await requireOrgAdmin(ctx, args.organizationId)
  },
})

export const internalRequireOrganizationMembership = internalQuery({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    return await requireOrganizationMembership(ctx, args.organizationId)
  },
})

export const internalGetOrCreateOrgStore = internalMutation({
  args: {
    organizationId: v.id('organizations'),
    geminiFileSearchStoreName: v.string(),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId)
    if (!org) throw new Error('Organization not found.')

    if (org.geminiFileSearchStoreName) {
      return org.geminiFileSearchStoreName
    }

    await ctx.db.patch(args.organizationId, {
      geminiFileSearchStoreName: args.geminiFileSearchStoreName,
      updatedAt: Date.now(),
    })

    return args.geminiFileSearchStoreName
  },
})

export const internalGetOrgStoreName = internalQuery({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId)
    return org?.geminiFileSearchStoreName ?? null
  },
})

export const internalGetOrgFilterMode = internalQuery({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId)
    return org?.geminiFilterMode ?? null
  },
})

export const internalSetOrgFilterMode = internalMutation({
  args: {
    organizationId: v.id('organizations'),
    geminiFilterMode: v.union(v.literal('or_syntax'), v.literal('multi_entry')),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId)
    if (!org) throw new Error('Organization not found.')

    await ctx.db.patch(args.organizationId, {
      geminiFilterMode: args.geminiFilterMode,
      updatedAt: Date.now(),
    })
  },
})

export const getCurrentUserUploadInfo = query({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx)
    const organization = await ctx.db.get(args.organizationId)

    if (!organization) {
      return { canUpload: false, role: 'member' as const, departments: [] }
    }

    const orgMemberships = await ctx.db
      .query('memberships')
      .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
        q
          .eq('organizationId', args.organizationId)
          .eq('userTokenIdentifier', identity.tokenIdentifier),
      )
      .collect()

    if (!isAdminIdentity(identity) && orgMemberships.length === 0) {
      throw new Error('Organization not found.')
    }

    const orgLevelMembership = orgMemberships.find(
      (m) => m.departmentId === undefined,
    )
    const isOrgAdmin =
      isAdminIdentity(identity) ||
      (orgLevelMembership &&
        (orgLevelMembership.role === 'owner' || orgLevelMembership.role === 'org_admin'))

    const deptAdminMemberships = orgMemberships.filter(
      (m) => m.departmentId !== undefined && m.role === 'department_admin',
    )

    const departments = []
    for (const m of deptAdminMemberships) {
      if (m.departmentId) {
        const dept = await ctx.db.get(m.departmentId)
        if (dept && dept.status !== 'archived') {
          departments.push({ _id: dept._id, name: dept.name, slug: dept.slug })
        }
      }
    }

    const canUpload = Boolean(isOrgAdmin) || departments.length > 0

    return {
      canUpload,
      role: isOrgAdmin ? ('org_admin' as const) : ('department_admin' as const),
      departments,
    }
  },
})

export const ensureCohortDemoOrganization = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAllowedUser(ctx)
    if (!isAdminIdentity(identity)) {
      throw new Error('Admin access required')
    }

    await getOrCreateDefaultOrganization(ctx)

    const now = Date.now()
    const slug = 'cohort-demo-organization'
    let organization = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique()

    if (!organization) {
      const organizationId = await ctx.db.insert('organizations', {
        name: 'Cohort Demo Organization',
        slug,
        createdAt: now,
        updatedAt: now,
      })
      organization = await ctx.db.get(organizationId)
    }

    if (!organization) {
      throw new Error('Could not create cohort demo organization.')
    }

    const orgMembership = await ctx.db
      .query('memberships')
      .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
        q
          .eq('organizationId', organization._id)
          .eq('userTokenIdentifier', identity.tokenIdentifier),
      )
      .filter((q) => q.eq(q.field('departmentId'), undefined))
      .unique()

    if (!orgMembership) {
      await ctx.db.insert('memberships', {
        organizationId: organization._id,
        userTokenIdentifier: identity.tokenIdentifier,
        role: 'org_admin',
        createdAt: now,
        updatedAt: now,
      })
    }

    const departmentNames = ['Demo Operations', 'Demo Finance', 'Demo HR']
    const departments = []
    for (const name of departmentNames) {
      const deptSlug = slugify(name)
      let department = await ctx.db
        .query('departments')
        .withIndex('by_organizationId_and_slug', (q) =>
          q.eq('organizationId', organization._id).eq('slug', deptSlug),
        )
        .unique()

      if (!department) {
        const departmentId = await ctx.db.insert('departments', {
          organizationId: organization._id,
          name,
          slug: deptSlug,
          createdAt: now,
          updatedAt: now,
        })
        department = await ctx.db.get(departmentId)
      }

      if (department) {
        departments.push(department)
      }
    }

    return { organization, departments }
  },
})

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
