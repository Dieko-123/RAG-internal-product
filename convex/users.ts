import { v } from 'convex/values'
import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import {
  ensureUserAndMembership,
  getDefaultOrganization,
  isAdminIdentity,
  requireManualUploadPermission,
  requireOrgAdmin,
  requireAllowedUser,
} from './permissions'

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
      const pendingInvite = await ctx.db
        .query('invites')
        .withIndex('by_emailNormalized_and_status', (q) =>
          q.eq('emailNormalized', emailNormalized).eq('status', 'pending'),
        )
        .first()

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
  args: {},
  handler: async (ctx) => {
    await requireOrgAdmin(ctx)

    return await ctx.db.query('users').withIndex('by_email').take(100)
  },
})

export const assignUserToDepartment = mutation({
  args: {
    userTokenIdentifier: v.string(),
    departmentId: v.id('departments'),
    role: v.union(v.literal('member'), v.literal('department_admin')),
  },
  handler: async (ctx, args) => {
    const { identity, organizationId } = await requireOrgAdmin(ctx)
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
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const { identity, organizationId } = await requireOrgAdmin(ctx)
    const now = Date.now()
    const user = await ctx.db.get(args.userId)

    if (!user) {
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
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireOrgAdmin(ctx)
    const now = Date.now()
    const user = await ctx.db.get(args.userId)

    if (!user) {
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
  args: {},
  handler: async (ctx) => {
    await requireOrgAdmin(ctx)

    return await getDefaultOrganization(ctx)
  },
})

export const internalRequireAllowedUser = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await requireAllowedUser(ctx)
  },
})

export const internalGetDefaultOrgId = internalQuery({
  args: {},
  handler: async (ctx) => {
    const org = await getDefaultOrganization(ctx)
    return org?._id ?? null
  },
})

export const internalRequireManualUploadPermission = internalQuery({
  args: {
    visibility: v.union(v.literal('org'), v.literal('department'), v.literal('restricted')),
    departmentId: v.optional(v.id('departments')),
  },
  handler: async (ctx, args) => {
    return await requireManualUploadPermission(ctx, {
      visibility: args.visibility,
      departmentId: args.departmentId,
    })
  },
})

export const internalRequireOrgAdmin = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await requireOrgAdmin(ctx)
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
  args: {},
  handler: async (ctx) => {
    const identity = await requireAllowedUser(ctx)
    const organization = await getDefaultOrganization(ctx)

    if (!organization) {
      return { canUpload: false, role: 'member' as const, departments: [] }
    }

    const orgMemberships = await ctx.db
      .query('memberships')
      .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
        q
          .eq('organizationId', organization._id)
          .eq('userTokenIdentifier', identity.tokenIdentifier),
      )
      .collect()

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
