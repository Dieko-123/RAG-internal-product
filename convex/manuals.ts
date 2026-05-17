import { v } from 'convex/values'
import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import type { Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { requireAllowedUser, requireOrgAdmin } from './permissions'

const manualStatus = v.union(
  v.literal('draft'),
  v.literal('indexing'),
  v.literal('active'),
  v.literal('failed'),
  v.literal('archived'),
)

const citationValidator = v.object({
  title: v.optional(v.string()),
  uri: v.optional(v.string()),
  pageNumber: v.optional(v.number()),
  excerpt: v.optional(v.string()),
  fileSearchStore: v.optional(v.string()),
})

export const listManuals = query({
  args: {},
  handler: async (ctx) => {
    await requireAllowedUser(ctx)

    return await ctx.db.query('manuals').withIndex('by_slug').take(20)
  },
})

export const getActiveManual = query({
  args: {},
  handler: async (ctx) => {
    await requireAllowedUser(ctx)

    return await getActiveManualRecord(ctx)
  },
})

export const getManualForQuestion = query({
  args: {
    manualId: v.optional(v.id('manuals')),
  },
  handler: async (ctx, args) => {
    await requireAllowedUser(ctx)

    return await getManualForQuestionRecord(ctx, args.manualId)
  },
})

export const internalGetActiveManual = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await getActiveManualRecord(ctx)
  },
})

export const internalGetManualForQuestion = internalQuery({
  args: {
    manualId: v.optional(v.id('manuals')),
  },
  handler: async (ctx, args) => {
    return await getManualForQuestionRecord(ctx, args.manualId)
  },
})

export const archiveManual = mutation({
  args: {
    manualId: v.id('manuals'),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireOrgAdmin(ctx)
    const now = Date.now()
    const manual = await ctx.db.get(args.manualId)

    if (!manual) {
      throw new Error('Manual not found.')
    }

    if (manual.status === 'archived') {
      return
    }

    if (manual.currentVersionId) {
      const version = await ctx.db.get(manual.currentVersionId)
      if (version && version.status === 'active') {
        await ctx.db.patch(version._id, { status: 'archived', updatedAt: now })
      }
    }

    await ctx.db.patch(args.manualId, { status: 'archived', updatedAt: now })

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: identity.tokenIdentifier,
      action: 'manual_archived',
      targetType: 'manual',
      targetId: args.manualId,
      metadata: { title: manual.title, slug: manual.slug },
      createdAt: now,
    })
  },
})

export const restoreManual = mutation({
  args: {
    manualId: v.id('manuals'),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireOrgAdmin(ctx)
    const now = Date.now()
    const manual = await ctx.db.get(args.manualId)

    if (!manual) {
      throw new Error('Manual not found.')
    }

    if (manual.status !== 'archived') {
      return
    }

    if (manual.currentVersionId) {
      const version = await ctx.db.get(manual.currentVersionId)
      if (version && version.status === 'archived') {
        await ctx.db.patch(version._id, { status: 'active', updatedAt: now })
      }
    }

    await ctx.db.patch(args.manualId, { status: 'active', updatedAt: now })

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: identity.tokenIdentifier,
      action: 'manual_restored',
      targetType: 'manual',
      targetId: args.manualId,
      metadata: { title: manual.title, slug: manual.slug },
      createdAt: now,
    })
  },
})

export const generateManualUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireOrgAdmin(ctx)

    return await ctx.storage.generateUploadUrl()
  },
})

export const internalCreateManualIfMissing = internalMutation({
  args: {
    title: v.string(),
    slug: v.string(),
    actorTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const existing = await ctx.db
      .query('manuals')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug))
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: existing.status === 'active' ? 'active' : 'indexing',
        updatedAt: now,
      })
      return existing._id
    }

    return await ctx.db.insert('manuals', {
      title: args.title,
      slug: args.slug,
      status: 'indexing',
      createdByTokenIdentifier: args.actorTokenIdentifier,
      createdAt: now,
      updatedAt: now,
    })
  },
})

export const internalCreateManualVersion = internalMutation({
  args: {
    manualId: v.id('manuals'),
    versionLabel: v.string(),
    sourceFileName: v.string(),
    provider: v.literal('gemini_file_search'),
    geminiFileSearchStoreName: v.string(),
    geminiFileSearchDocumentName: v.optional(v.string()),
    geminiFileName: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    status: manualStatus,
    actorTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()

    return await ctx.db.insert('manualVersions', {
      manualId: args.manualId,
      versionLabel: args.versionLabel,
      sourceFileName: args.sourceFileName,
      provider: args.provider,
      geminiFileSearchStoreName: args.geminiFileSearchStoreName,
      geminiFileSearchDocumentName: args.geminiFileSearchDocumentName,
      geminiFileName: args.geminiFileName,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      status: args.status,
      createdByTokenIdentifier: args.actorTokenIdentifier,
      createdAt: now,
      updatedAt: now,
    })
  },
})

export const internalMarkManualVersionActive = internalMutation({
  args: {
    manualId: v.id('manuals'),
    manualVersionId: v.id('manualVersions'),
    geminiFileSearchDocumentName: v.optional(v.string()),
    geminiFileName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now()

    await ctx.db.patch(args.manualVersionId, {
      status: 'active',
      geminiFileSearchDocumentName: args.geminiFileSearchDocumentName,
      geminiFileName: args.geminiFileName,
      updatedAt: now,
    })

    await ctx.db.patch(args.manualId, {
      status: 'active',
      currentVersionId: args.manualVersionId,
      updatedAt: now,
    })
  },
})

export const internalMarkManualVersionFailed = internalMutation({
  args: {
    manualId: v.id('manuals'),
    manualVersionId: v.optional(v.id('manualVersions')),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const manual = await ctx.db.get(args.manualId)

    if (args.manualVersionId) {
      await ctx.db.patch(args.manualVersionId, {
        status: 'failed',
        errorMessage: args.errorMessage,
        updatedAt: now,
      })
    }

    if (manual?.currentVersionId) {
      const currentVersion = await ctx.db.get(manual.currentVersionId)

      if (
        currentVersion?.status === 'active' &&
        currentVersion._id !== args.manualVersionId
      ) {
        await ctx.db.patch(args.manualId, {
          status: 'active',
          updatedAt: now,
        })
        return
      }
    }

    await ctx.db.patch(args.manualId, {
      status: 'failed',
      updatedAt: now,
    })
  },
})

export const internalLogQuestion = internalMutation({
  args: {
    manualId: v.id('manuals'),
    manualVersionId: v.id('manualVersions'),
    userTokenIdentifier: v.string(),
    question: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('questions', {
      manualId: args.manualId,
      manualVersionId: args.manualVersionId,
      userTokenIdentifier: args.userTokenIdentifier,
      question: args.question,
      createdAt: Date.now(),
    })
  },
})

export const internalLogAnswer = internalMutation({
  args: {
    questionId: v.id('questions'),
    answerText: v.string(),
    refusal: v.boolean(),
    citations: v.array(citationValidator),
    model: v.string(),
    latencyMs: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('answers', {
      questionId: args.questionId,
      answerText: args.answerText,
      refusal: args.refusal,
      citations: args.citations,
      model: args.model,
      latencyMs: args.latencyMs,
      createdAt: Date.now(),
    })
  },
})

export const internalWriteAuditEvent = internalMutation({
  args: {
    actorTokenIdentifier: v.string(),
    action: v.string(),
    targetType: v.string(),
    targetId: v.optional(v.string()),
    metadata: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: args.actorTokenIdentifier,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      metadata: args.metadata,
      createdAt: Date.now(),
    })
  },
})

async function getActiveManualRecord(ctx: QueryCtx) {
  const manual = await ctx.db
    .query('manuals')
    .withIndex('by_status', (q) => q.eq('status', 'active'))
    .order('desc')
    .first()

  if (!manual?.currentVersionId) {
    return null
  }

  const version = await ctx.db.get(manual.currentVersionId)

  if (!version || version.status !== 'active') {
    return null
  }

  return {
    manual,
    version,
  }
}

async function getManualForQuestionRecord(
  ctx: QueryCtx,
  manualId: Id<'manuals'> | undefined,
) {
  if (!manualId) {
    return await getActiveManualRecord(ctx)
  }

  const manual = await ctx.db.get(manualId)

  if (!manual || manual.status !== 'active' || !manual.currentVersionId) {
    return null
  }

  const version = await ctx.db.get(manual.currentVersionId)

  if (!version || version.status !== 'active') {
    return null
  }

  return {
    manual,
    version,
  }
}
