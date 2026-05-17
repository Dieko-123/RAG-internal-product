'use node'

import { createClerkClient } from '@clerk/backend'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { action, internalAction } from './_generated/server'

export const inviteUser = action({
  args: {
    email: v.string(),
    role: v.union(v.literal('org_admin'), v.literal('member'), v.literal('viewer')),
    departmentId: v.optional(v.id('departments')),
    departmentRole: v.optional(
      v.union(v.literal('department_admin'), v.literal('member'), v.literal('viewer')),
    ),
  },
  handler: async (ctx, args) => {
    const permission: {
      identity: { tokenIdentifier: string }
      organizationId: Id<'organizations'>
      inviterRole: 'org_admin' | 'department_admin'
      allowedDepartmentId?: Id<'departments'>
    } = await ctx.runQuery(internal.invitesQueries.internalRequireInvitePermission, {
      departmentId: args.departmentId,
      targetRole: args.role,
      targetDepartmentRole: args.departmentRole,
    })

    const emailNormalized = args.email.trim().toLowerCase()
    if (!emailNormalized || !emailNormalized.includes('@')) {
      throw new Error('Valid email address is required.')
    }

    if (permission.inviterRole === 'department_admin') {
      if (args.role === 'org_admin') {
        throw new Error('Department admins cannot invite org admins.')
      }
      if (args.departmentRole === 'department_admin') {
        throw new Error('Department admins cannot assign department_admin role.')
      }
      if (!args.departmentId || args.departmentId !== permission.allowedDepartmentId) {
        throw new Error('You can only invite users to your own department.')
      }
    }

    const existingPending: Id<'invites'> | null = await ctx.runQuery(
      internal.invitesQueries.internalGetPendingInviteByEmail,
      {
        emailNormalized,
        organizationId: permission.organizationId,
      },
    )

    if (existingPending) {
      throw new Error('A pending invite already exists for this email.')
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY?.trim()
    if (!clerkSecretKey) {
      throw new Error('CLERK_SECRET_KEY is not configured.')
    }

    const redirectUrl = process.env.APP_INVITE_REDIRECT_URL?.trim() || undefined
    const clerk = createClerkClient({ secretKey: clerkSecretKey })

    let clerkInvitationId: string | undefined
    try {
      const invitation = await clerk.invitations.createInvitation({
        emailAddress: emailNormalized,
        redirectUrl,
        publicMetadata: {
          organizationId: permission.organizationId,
          role: args.role,
          departmentId: args.departmentId ?? null,
          departmentRole: args.departmentRole ?? null,
        },
      })
      clerkInvitationId = invitation.id
    } catch (clerkError) {
      const message = clerkError instanceof Error ? clerkError.message : 'Clerk invitation failed'
      throw new Error(`Could not send invitation: ${message}`, { cause: clerkError })
    }

    const inviteId: Id<'invites'> = await ctx.runMutation(
      internal.invitesQueries.internalCreateInvite,
      {
        organizationId: permission.organizationId,
        email: args.email.trim(),
        emailNormalized,
        role: args.role,
        departmentId: args.departmentId,
        departmentRole: args.departmentRole,
        clerkInvitationId,
        invitedByTokenIdentifier: permission.identity.tokenIdentifier,
      },
    )

    return { inviteId, clerkInvitationId }
  },
})

export const revokeInvite = action({
  args: {
    inviteId: v.id('invites'),
  },
  handler: async (ctx, args) => {
    const result: {
      clerkInvitationId?: string
    } = await ctx.runMutation(
      internal.invitesQueries.internalRevokeInvite,
      { inviteId: args.inviteId },
    )

    if (result.clerkInvitationId) {
      const clerkSecretKey = process.env.CLERK_SECRET_KEY?.trim()
      if (clerkSecretKey) {
        const clerk = createClerkClient({ secretKey: clerkSecretKey })
        try {
          await clerk.invitations.revokeInvitation(result.clerkInvitationId)
        } catch {
          // Best-effort revocation in Clerk
        }
      }
    }

    return { success: true }
  },
})

export const internalAcceptMatchingInvite = internalAction({
  args: {
    email: v.string(),
    userTokenIdentifier: v.string(),
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const emailNormalized = args.email.trim().toLowerCase()

    const accepted: boolean = await ctx.runMutation(
      internal.invitesQueries.internalAcceptInvite,
      {
        emailNormalized,
        userTokenIdentifier: args.userTokenIdentifier,
        organizationId: args.organizationId,
      },
    )

    return accepted
  },
})
