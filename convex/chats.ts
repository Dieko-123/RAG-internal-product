import { v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import type { MutationCtx } from './_generated/server'
import { getDefaultOrganization, requireAllowedUser } from './permissions'

const citationValidator = v.object({
  title: v.optional(v.string()),
  uri: v.optional(v.string()),
  pageNumber: v.optional(v.number()),
  excerpt: v.optional(v.string()),
  fileSearchStore: v.optional(v.string()),
})

export const listChatSessions = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAllowedUser(ctx)

    const recentSessions = await ctx.db
      .query('chatSessions')
      .withIndex('by_userTokenIdentifier_and_updatedAt', (q) =>
        q.eq('userTokenIdentifier', user.tokenIdentifier),
      )
      .order('desc')
      .take(40)
    const pinnedSessions = await ctx.db
      .query('chatSessions')
      .withIndex('by_userTokenIdentifier_and_pinned', (q) =>
        q.eq('userTokenIdentifier', user.tokenIdentifier).eq('pinned', true),
      )
      .take(40)
    const sessionsById = new Map(
      [...pinnedSessions, ...recentSessions].map((session) => [
        session._id,
        session,
      ]),
    )
    const sessions = [...sessionsById.values()]

    return sessions.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1
      }

      const aSortTime = a.pinned ? (a.pinnedAt ?? a.updatedAt) : a.updatedAt
      const bSortTime = b.pinned ? (b.pinnedAt ?? b.updatedAt) : b.updatedAt

      return bSortTime - aSortTime
    })
  },
})

export const listChatMessages = query({
  args: {
    chatSessionId: v.optional(v.id('chatSessions')),
  },
  handler: async (ctx, args) => {
    const user = await requireAllowedUser(ctx)

    if (!args.chatSessionId) {
      return []
    }

    const chatSessionId = args.chatSessionId
    const session = await ctx.db.get(chatSessionId)

    if (!session || session.userTokenIdentifier !== user.tokenIdentifier) {
      throw new Error('Chat not found')
    }

    const newestMessages = await ctx.db
      .query('chatMessages')
      .withIndex('by_chatSessionId', (q) =>
        q.eq('chatSessionId', chatSessionId),
      )
      .order('desc')
      .take(100)

    return newestMessages.reverse()
  },
})

export const createChatSession = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireAllowedUser(ctx)
    const activeManual = await getActiveManualRecord(ctx)

    if (!activeManual) {
      throw new Error('No active manual is available yet.')
    }

    return await ctx.db.insert('chatSessions', {
      userTokenIdentifier: user.tokenIdentifier,
      organizationId: activeManual.manual.organizationId,
      scopeMode: 'selected',
      selectedManualIds: [activeManual.manual._id],
      selectedManualVersionIds: [activeManual.version._id],
      manualId: activeManual.manual._id,
      manualVersionId: activeManual.version._id,
      title: 'New chat',
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  },
})

export const setChatPinned = mutation({
  args: {
    chatSessionId: v.id('chatSessions'),
    pinned: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireAllowedUser(ctx)
    const session = await ctx.db.get(args.chatSessionId)

    if (!session || session.userTokenIdentifier !== user.tokenIdentifier) {
      throw new Error('Chat not found')
    }

    await ctx.db.patch(args.chatSessionId, {
      pinned: args.pinned,
      pinnedAt: args.pinned ? Date.now() : undefined,
    })
  },
})

export const internalRecordChatExchange = internalMutation({
  args: {
    chatSessionId: v.optional(v.id('chatSessions')),
    userTokenIdentifier: v.string(),
    manualId: v.id('manuals'),
    manualVersionId: v.id('manualVersions'),
    title: v.string(),
    question: v.string(),
    answerText: v.string(),
    refusal: v.boolean(),
    citations: v.array(citationValidator),
    model: v.string(),
    latencyMs: v.number(),
    sourceFileName: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    let chatSessionId = args.chatSessionId

    if (chatSessionId) {
      const session = await ctx.db.get(chatSessionId)

      if (!session || session.userTokenIdentifier !== args.userTokenIdentifier) {
        throw new Error('Chat not found')
      }
    } else {
      const manual = await ctx.db.get(args.manualId)
      chatSessionId = await ctx.db.insert('chatSessions', {
        userTokenIdentifier: args.userTokenIdentifier,
        organizationId: manual?.organizationId,
        scopeMode: 'selected',
        selectedManualIds: [args.manualId],
        selectedManualVersionIds: [args.manualVersionId],
        manualId: args.manualId,
        manualVersionId: args.manualVersionId,
        title: normalizeTitle(args.title),
        pinned: false,
        createdAt: now,
        updatedAt: now,
      })
    }

    const session = await ctx.db.get(chatSessionId)
    const shouldRetitle = session?.title === 'New chat'

    await ctx.db.insert('chatMessages', {
      chatSessionId,
      userTokenIdentifier: args.userTokenIdentifier,
      role: 'user',
      content: args.question,
      createdAt: now,
    })

    const assistantMessageId = await ctx.db.insert('chatMessages', {
      chatSessionId,
      userTokenIdentifier: args.userTokenIdentifier,
      role: 'assistant',
      content: args.answerText,
      refusal: args.refusal,
      citations: args.citations,
      model: args.model,
      latencyMs: args.latencyMs,
      sourceFileName: args.sourceFileName,
      createdAt: now + 1,
    })

    await ctx.db.patch(
      chatSessionId,
      shouldRetitle
        ? { title: normalizeTitle(args.title), updatedAt: now }
        : { updatedAt: now },
    )

    return {
      chatSessionId,
      assistantMessageId,
    }
  },
})

async function getActiveManualRecord(ctx: MutationCtx) {
  const organization = await getDefaultOrganization(ctx)
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
    manual: {
      ...manual,
      organizationId: manual.organizationId ?? organization?._id,
      visibility: manual.visibility ?? 'org',
    },
    version: {
      ...version,
      providerMode: version.providerMode ?? 'legacy_per_manual_store',
    },
  }
}

function normalizeTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed) return 'New chat'

  const withoutQuestionPrefix = trimmed
    .replace(/^(can|could|would|should|do|does|did|what|when|where|why|how|is|are)\s+(i|we|you|the|this|that|there|it)?\s*/i, '')
    .replace(/^(tell|explain|describe|show|summarize)\s+(me\s+)?(about\s+)?/i, '')
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'are',
    'for',
    'from',
    'in',
    'my',
    'of',
    'on',
    'the',
    'to',
    'we',
    'with',
    'your',
  ])
  const meaningfulWords = withoutQuestionPrefix
    .split(' ')
    .map((word) => word.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter((word) => word.length > 0 && !stopWords.has(word.toLowerCase()))
  const words = meaningfulWords.length > 0 ? meaningfulWords : trimmed.split(' ')
  const candidate = words.slice(0, 4).join(' ')
  const normalized = candidate.length <= 34 ? candidate : candidate.slice(0, 31)

  return normalized.replace(/[.,;:!?-]+$/, '') || 'New chat'
}
