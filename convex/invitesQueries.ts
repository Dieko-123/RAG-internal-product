import { v } from 'convex/values'
import { internalMutation, internalQuery, query } from './_generated/server'
import type { Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import {
  getDefaultOrganization,
  isAdminIdentity,
  requireAllowedUser,
} from './permissions'

export const listInvites = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAllowedUser(ctx)
    const organization = await getDefaultOrganization(ctx)
    if (!organization) return []

    const isOrgLevel =
      isAdminIdentity(identity) ||
      (await isOrgAdminOrOwner(ctx, organization._id, identity.tokenIdentifier))

    if (isOrgLevel) {
      return await ctx.db
        .query('invites')
        .withIndex('by_organizationId', (q) => q.eq('organizationId', organization._id))
        .take(100)
    }

    const deptAdminIds = await getDepartmentAdminIds(ctx, organization._id, identity.tokenIdentifier)
    if (deptAdminIds.size === 0) return []

    const allInvites = await ctx.db
      .query('invites')
      .withIndex('by_organizationId', (q) => q.eq('organizationId', organization._id))
      .take(100)

    return allInvites.filter(
      (invite) => invite.departmentId && deptAdminIds.has(invite.departmentId),
    )
  },
})

export const internalRequireInvitePermission = internalQuery({
  args: {
    departmentId: v.optional(v.id('departments')),
    targetRole: v.union(v.literal('org_admin'), v.literal('member'), v.literal('viewer')),
    targetDepartmentRole: v.optional(
      v.union(v.literal('department_admin'), v.literal('member'), v.literal('viewer')),
    ),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx)
    const organization = await getDefaultOrganization(ctx)
    if (!organization) {
      throw new Error('Organization not configured.')
    }

    const isOrgLevel =
      isAdminIdentity(identity) ||
      (await isOrgAdminOrOwner(ctx, organization._id, identity.tokenIdentifier))

    if (isOrgLevel) {
      if (args.departmentId) {
        const dept = await ctx.db.get(args.departmentId)
        if (!dept || dept.organizationId !== organization._id) {
          throw new Error('Department not found.')
        }
      }

      return {
        identity,
        organizationId: organization._id,
        inviterRole: 'org_admin' as const,
        allowedDepartmentId: args.departmentId,
      }
    }

    if (!args.departmentId) {
      throw new Error('Only org admins can invite users without a department.')
    }

    const dept = await ctx.db.get(args.departmentId)
    if (!dept || dept.organizationId !== organization._id) {
      throw new Error('Department not found.')
    }

    const deptMembership = await ctx.db
      .query('memberships')
      .withIndex('by_departmentId_and_userTokenIdentifier', (q) =>
        q
          .eq('departmentId', args.departmentId!)
          .eq('userTokenIdentifier', identity.tokenIdentifier),
      )
      .unique()

    if (!deptMembership || deptMembership.role !== 'department_admin') {
      throw new Error('You do not have permission to invite users.')
    }

    if (args.targetRole === 'org_admin') {
      throw new Error('Department admins cannot invite org admins.')
    }

    if (args.targetDepartmentRole === 'department_admin') {
      throw new Error('Department admins cannot assign department_admin role.')
    }

    return {
      identity,
      organizationId: organization._id,
      inviterRole: 'department_admin' as const,
      allowedDepartmentId: args.departmentId,
    }
  },
})

export const internalGetPendingInviteByEmail = internalQuery({
  args: {
    emailNormalized: v.string(),
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query('invites')
      .withIndex('by_emailNormalized_and_status', (q) =>
        q.eq('emailNormalized', args.emailNormalized).eq('status', 'pending'),
      )
      .first()

    if (invite && invite.organizationId === args.organizationId) {
      return invite._id
    }
    return null
  },
})

export const internalCreateInvite = internalMutation({
  args: {
    organizationId: v.id('organizations'),
    email: v.string(),
    emailNormalized: v.string(),
    role: v.union(v.literal('org_admin'), v.literal('member'), v.literal('viewer')),
    departmentId: v.optional(v.id('departments')),
    departmentRole: v.optional(
      v.union(v.literal('department_admin'), v.literal('member'), v.literal('viewer')),
    ),
    clerkInvitationId: v.optional(v.string()),
    invitedByTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000

    const inviteId = await ctx.db.insert('invites', {
      organizationId: args.organizationId,
      email: args.email,
      emailNormalized: args.emailNormalized,
      role: args.role,
      departmentId: args.departmentId,
      departmentRole: args.departmentRole,
      status: 'pending',
      clerkInvitationId: args.clerkInvitationId,
      invitedByTokenIdentifier: args.invitedByTokenIdentifier,
      createdAt: now,
      expiresAt: now + thirtyDaysMs,
    })

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: args.invitedByTokenIdentifier,
      action: 'invite_created',
      targetType: 'invite',
      targetId: inviteId,
      metadata: {
        email: args.email,
        role: args.role,
        departmentId: args.departmentId ?? '',
        departmentRole: args.departmentRole ?? '',
      },
      createdAt: now,
    })

    return inviteId
  },
})

export const internalRevokeInvite = internalMutation({
  args: {
    inviteId: v.id('invites'),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx)
    const organization = await getDefaultOrganization(ctx)
    if (!organization) throw new Error('Organization not configured.')

    const invite = await ctx.db.get(args.inviteId)
    if (!invite) throw new Error('Invite not found.')
    if (invite.organizationId !== organization._id) throw new Error('Invite not found.')
    if (invite.status !== 'pending') throw new Error('Only pending invites can be revoked.')

    const isOrgLevel =
      isAdminIdentity(identity) ||
      (await isOrgAdminOrOwner(ctx, organization._id, identity.tokenIdentifier))

    if (!isOrgLevel) {
      if (!invite.departmentId) {
        throw new Error('Only org admins can revoke org-level invites.')
      }
      const deptMembership = await ctx.db
        .query('memberships')
        .withIndex('by_departmentId_and_userTokenIdentifier', (q) =>
          q
            .eq('departmentId', invite.departmentId!)
            .eq('userTokenIdentifier', identity.tokenIdentifier),
        )
        .unique()

      if (!deptMembership || deptMembership.role !== 'department_admin') {
        throw new Error('You do not have permission to revoke this invite.')
      }
    }

    const now = Date.now()
    await ctx.db.patch(args.inviteId, {
      status: 'revoked',
      revokedAt: now,
    })

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: identity.tokenIdentifier,
      action: 'invite_revoked',
      targetType: 'invite',
      targetId: args.inviteId,
      metadata: { email: invite.email },
      createdAt: now,
    })

    return { clerkInvitationId: invite.clerkInvitationId }
  },
})

export const internalAcceptInvite = internalMutation({
  args: {
    emailNormalized: v.string(),
    userTokenIdentifier: v.string(),
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query('invites')
      .withIndex('by_emailNormalized_and_status', (q) =>
        q.eq('emailNormalized', args.emailNormalized).eq('status', 'pending'),
      )
      .first()

    if (!invite || invite.organizationId !== args.organizationId) {
      return false
    }

    if (invite.expiresAt && invite.expiresAt < Date.now()) {
      await ctx.db.patch(invite._id, { status: 'expired' })
      return false
    }

    const now = Date.now()

    await ctx.db.patch(invite._id, {
      status: 'accepted',
      acceptedByTokenIdentifier: args.userTokenIdentifier,
      acceptedAt: now,
    })

    const existingOrgMembership = await ctx.db
      .query('memberships')
      .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
        q
          .eq('organizationId', args.organizationId)
          .eq('userTokenIdentifier', args.userTokenIdentifier),
      )
      .first()

    if (!existingOrgMembership) {
      await ctx.db.insert('memberships', {
        organizationId: args.organizationId,
        userTokenIdentifier: args.userTokenIdentifier,
        role: invite.role === 'org_admin' ? 'org_admin' : invite.role,
        createdAt: now,
        updatedAt: now,
      })
    } else if (
      invite.role === 'org_admin' &&
      existingOrgMembership.role !== 'owner' &&
      existingOrgMembership.role !== 'org_admin'
    ) {
      await ctx.db.patch(existingOrgMembership._id, {
        role: 'org_admin',
        updatedAt: now,
      })
    }

    if (invite.departmentId) {
      const existingDeptMembership = await ctx.db
        .query('memberships')
        .withIndex('by_departmentId_and_userTokenIdentifier', (q) =>
          q
            .eq('departmentId', invite.departmentId!)
            .eq('userTokenIdentifier', args.userTokenIdentifier),
        )
        .unique()

      if (!existingDeptMembership) {
        await ctx.db.insert('memberships', {
          organizationId: args.organizationId,
          departmentId: invite.departmentId,
          userTokenIdentifier: args.userTokenIdentifier,
          role: invite.departmentRole ?? 'member',
          createdAt: now,
          updatedAt: now,
        })
      }
    }

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: args.userTokenIdentifier,
      action: 'invite_accepted',
      targetType: 'invite',
      targetId: invite._id,
      metadata: {
        email: invite.email,
        role: invite.role,
        departmentId: invite.departmentId ?? '',
      },
      createdAt: now,
    })

    return true
  },
})

async function isOrgAdminOrOwner(
  ctx: Pick<QueryCtx, 'db'>,
  organizationId: Id<'organizations'>,
  tokenIdentifier: string,
): Promise<boolean> {
  const memberships = await ctx.db
    .query('memberships')
    .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
      q
        .eq('organizationId', organizationId)
        .eq('userTokenIdentifier', tokenIdentifier),
    )
    .collect()

  return memberships.some(
    (m) =>
      m.departmentId === undefined &&
      (m.role === 'owner' || m.role === 'org_admin'),
  )
}

async function getDepartmentAdminIds(
  ctx: Pick<QueryCtx, 'db'>,
  organizationId: Id<'organizations'>,
  tokenIdentifier: string,
): Promise<Set<string>> {
  const memberships = await ctx.db
    .query('memberships')
    .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
      q
        .eq('organizationId', organizationId)
        .eq('userTokenIdentifier', tokenIdentifier),
    )
    .collect()

  const deptIds = new Set<string>()
  for (const m of memberships) {
    if (m.departmentId && m.role === 'department_admin') {
      deptIds.add(m.departmentId)
    }
  }
  return deptIds
}
