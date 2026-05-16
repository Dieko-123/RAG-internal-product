import { v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import type { MutationCtx } from './_generated/server'
import { requireUser } from './permissions'

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
    const user = await requireUser(ctx)

    return await ctx.db
      .query('chatSessions')
      .withIndex('by_userTokenIdentifier_and_updatedAt', (q) =>
        q.eq('userTokenIdentifier', user.tokenIdentifier),
      )
      .order('desc')
      .take(40)
  },
})

export const listChatMessages = query({
  args: {
    chatSessionId: v.optional(v.id('chatSessions')),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx)

    if (!args.chatSessionId) {
      return []
    }

    const chatSessionId = args.chatSessionId
    const session = await ctx.db.get(chatSessionId)

    if (!session || session.userTokenIdentifier !== user.tokenIdentifier) {
      throw new Error('Chat not found')
    }

    return await ctx.db
      .query('chatMessages')
      .withIndex('by_chatSessionId', (q) =>
        q.eq('chatSessionId', chatSessionId),
      )
      .take(100)
  },
})

export const createChatSession = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx)
    const activeManual = await getActiveManualRecord(ctx)

    if (!activeManual) {
      throw new Error('No active manual is available yet.')
    }

    return await ctx.db.insert('chatSessions', {
      userTokenIdentifier: user.tokenIdentifier,
      manualId: activeManual.manual._id,
      manualVersionId: activeManual.version._id,
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
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
      chatSessionId = await ctx.db.insert('chatSessions', {
        userTokenIdentifier: args.userTokenIdentifier,
        manualId: args.manualId,
        manualVersionId: args.manualVersionId,
        title: normalizeTitle(args.title),
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

  return { manual, version }
}

function normalizeTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed) return 'New chat'
  return trimmed.length <= 64 ? trimmed : `${trimmed.slice(0, 61)}...`
}
