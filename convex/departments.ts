import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireAllowedUser, requireOrgAdmin } from './permissions'

export const listDepartments = query({
  args: {},
  handler: async (ctx) => {
    await requireAllowedUser(ctx)
    const organization = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', 'execujet-aviation-nigeria'))
      .unique()

    if (!organization) {
      return []
    }

    const departments = await ctx.db
      .query('departments')
      .withIndex('by_organizationId', (q) => q.eq('organizationId', organization._id))
      .collect()

    return departments.filter((d) => d.status !== 'archived')
  },
})

export const createDepartment = mutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const { organizationId } = await requireOrgAdmin(ctx)
    const name = args.name.trim()

    if (!name) {
      throw new Error('Department name is required.')
    }

    const slug = slugify(name)
    const existing = await ctx.db
      .query('departments')
      .withIndex('by_organizationId_and_slug', (q) =>
        q.eq('organizationId', organizationId).eq('slug', slug),
      )
      .unique()

    if (existing) {
      throw new Error('A department with this name already exists.')
    }

    const now = Date.now()

    return await ctx.db.insert('departments', {
      organizationId,
      name,
      slug,
      createdAt: now,
      updatedAt: now,
    })
  },
})

export const archiveDepartment = mutation({
  args: {
    departmentId: v.id('departments'),
  },
  handler: async (ctx, args) => {
    const { identity, organizationId } = await requireOrgAdmin(ctx)
    const now = Date.now()
    const department = await ctx.db.get(args.departmentId)

    if (!department || department.organizationId !== organizationId) {
      throw new Error('Department not found.')
    }

    if (department.status === 'archived') {
      return
    }

    const activeMemberships = await ctx.db
      .query('memberships')
      .withIndex('by_departmentId', (q) => q.eq('departmentId', args.departmentId))
      .collect()
    const activeManuals = await ctx.db
      .query('manuals')
      .withIndex('by_departmentId', (q) => q.eq('departmentId', args.departmentId))
      .filter((q) => q.neq(q.field('status'), 'archived'))
      .take(1)

    if (activeMemberships.length > 0) {
      throw new Error(
        'Cannot archive department with active members. Remove all members first.',
      )
    }

    if (activeManuals.length > 0) {
      throw new Error(
        'Cannot archive department with active manuals. Archive those manuals first.',
      )
    }

    await ctx.db.patch(args.departmentId, { status: 'archived', updatedAt: now })

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: identity.tokenIdentifier,
      action: 'department_archived',
      targetType: 'department',
      targetId: args.departmentId,
      metadata: { name: department.name, slug: department.slug },
      createdAt: now,
    })
  },
})

export const removeDepartmentMembership = mutation({
  args: {
    departmentId: v.id('departments'),
    userTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const { identity, organizationId } = await requireOrgAdmin(ctx)
    const now = Date.now()
    const department = await ctx.db.get(args.departmentId)

    if (!department || department.organizationId !== organizationId) {
      throw new Error('Department not found.')
    }

    const membership = await ctx.db
      .query('memberships')
      .withIndex('by_departmentId_and_userTokenIdentifier', (q) =>
        q
          .eq('departmentId', args.departmentId)
          .eq('userTokenIdentifier', args.userTokenIdentifier),
      )
      .unique()

    if (!membership) {
      throw new Error('Membership not found.')
    }

    await ctx.db.delete(membership._id)

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: identity.tokenIdentifier,
      action: 'membership_removed',
      targetType: 'membership',
      targetId: membership._id,
      metadata: {
        departmentName: department.name,
        userTokenIdentifier: args.userTokenIdentifier,
      },
      createdAt: now,
    })
  },
})

export const listDepartmentMembers = query({
  args: {
    departmentId: v.id('departments'),
  },
  handler: async (ctx, args) => {
    await requireOrgAdmin(ctx)

    return await ctx.db
      .query('memberships')
      .withIndex('by_departmentId', (q) => q.eq('departmentId', args.departmentId))
      .collect()
  },
})

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
