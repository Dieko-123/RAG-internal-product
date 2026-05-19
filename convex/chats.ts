import { v } from 'convex/values'
import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import { internal } from './_generated/api'
import type { MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import {
  getDefaultOrganization,
  requireAllowedUser,
} from './permissions'

const citationValidator = v.object({
  title: v.optional(v.string()),
  uri: v.optional(v.string()),
  pageNumber: v.optional(v.number()),
  excerpt: v.optional(v.string()),
  fileSearchStore: v.optional(v.string()),
  manualId: v.optional(v.string()),
  manualVersionId: v.optional(v.string()),
  sourceFileName: v.optional(v.string()),
  providerUri: v.optional(v.string()),
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

    const sorted = sessions.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1
      }

      const aSortTime = a.pinned ? (a.pinnedAt ?? a.updatedAt) : a.updatedAt
      const bSortTime = b.pinned ? (b.pinnedAt ?? b.updatedAt) : b.updatedAt

      return bSortTime - aSortTime
    })

    return await Promise.all(
      sorted.map(async (session) => {
        const manualIds =
          session.selectedManualIds && session.selectedManualIds.length > 0
            ? session.selectedManualIds
            : [session.manualId]
        const manuals = await Promise.all(manualIds.map((id) => ctx.db.get(id)))
        const manualTitles = manuals.filter(Boolean).map((m) => m!.title)
        return { ...session, manualTitles }
      }),
    )
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

export const deleteChat = mutation({
  args: {
    chatSessionId: v.id('chatSessions'),
  },
  handler: async (ctx, args) => {
    const user = await requireAllowedUser(ctx)
    const session = await ctx.db.get(args.chatSessionId)

    if (!session || session.userTokenIdentifier !== user.tokenIdentifier) {
      throw new Error('Chat not found')
    }

    const messages = await ctx.db
      .query('chatMessages')
      .withIndex('by_chatSessionId', (q) => q.eq('chatSessionId', args.chatSessionId))
      .collect()

    await Promise.all(messages.map((m) => ctx.db.delete(m._id)))
    await ctx.db.delete(args.chatSessionId)
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

    const existingMessageCount = await ctx.db
      .query('chatMessages')
      .withIndex('by_chatSessionId', (q) => q.eq('chatSessionId', chatSessionId))
      .take(1)
    const isFirstExchange = existingMessageCount.length === 0

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

    await ctx.db.patch(chatSessionId, { updatedAt: now })

    if (isFirstExchange) {
      await ctx.scheduler.runAfter(0, internal.gemini.internalGenerateChatTitle, {
        chatSessionId,
        question: args.question,
        answerText: args.refusal ? '' : args.answerText,
      })
    }

    return {
      chatSessionId,
      assistantMessageId,
    }
  },
})

export const internalLockChatScope = internalMutation({
  args: {
    userTokenIdentifier: v.string(),
    organizationId: v.id('organizations'),
    selectedManualIds: v.array(v.id('manuals')),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const deduped = [...new Set(args.selectedManualIds)]

    if (deduped.length < 1 || deduped.length > 30) {
      throw new Error('Select between 1 and 30 manuals.')
    }

    const org = await ctx.db.get(args.organizationId)
    if (!org) {
      throw new Error('Organization not found.')
    }

    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
        q
          .eq('organizationId', args.organizationId)
          .eq('userTokenIdentifier', args.userTokenIdentifier),
      )
      .collect()

    const isOrgLevel = memberships.some(
      (m) =>
        m.departmentId === undefined &&
        (m.role === 'owner' || m.role === 'org_admin'),
    )

    const userDeptIds = new Set<string>()
    for (const m of memberships) {
      if (m.departmentId) {
        userDeptIds.add(m.departmentId)
      }
    }

    const now = Date.now()
    const resolvedVersions: Array<{
      manualId: Id<'manuals'>
      manualVersionId: Id<'manualVersions'>
      title: string
      sourceFileName: string
    }> = []

    for (const manualId of deduped) {
      const manual = await ctx.db.get(manualId)
      if (!manual) {
        throw new Error(`Manual not found.`)
      }

      if (manual.organizationId !== args.organizationId) {
        throw new Error(`Manual "${manual.title}" does not belong to this organization.`)
      }

      if (manual.status !== 'active') {
        throw new Error(`Manual "${manual.title}" is not active.`)
      }

      const vis = manual.visibility ?? 'org'
      if (vis === 'restricted') {
        throw new Error(`Manual "${manual.title}" is not available for search.`)
      }

      if (vis === 'department' && manual.departmentId && !isOrgLevel) {
        if (!userDeptIds.has(manual.departmentId)) {
          throw new Error(
            `You do not have access to manual "${manual.title}".`,
          )
        }
      }

      if (!manual.currentVersionId) {
        throw new Error(`Manual "${manual.title}" has no active version.`)
      }

      const version = await ctx.db.get(manual.currentVersionId)
      if (!version || version.status !== 'active') {
        throw new Error(`Manual "${manual.title}" version is not active.`)
      }
      if ((version.providerMode ?? 'legacy_per_manual_store') !== 'shared_org_store') {
        throw new Error(
          `Manual "${manual.title}" is not available for multi-manual search.`,
        )
      }

      resolvedVersions.push({
        manualId: manual._id,
        manualVersionId: version._id,
        title: manual.title,
        sourceFileName: version.sourceFileName,
      })
    }

    const selectedManualVersionIds = resolvedVersions.map((r) => r.manualVersionId)
    const chatSessionId = await ctx.db.insert('chatSessions', {
      userTokenIdentifier: args.userTokenIdentifier,
      organizationId: args.organizationId,
      scopeMode: 'selected',
      selectedManualIds: deduped,
      selectedManualVersionIds,
      manualId: resolvedVersions[0].manualId,
      manualVersionId: resolvedVersions[0].manualVersionId,
      title: normalizeTitle(args.title),
      pinned: false,
      createdAt: now,
      updatedAt: now,
    })

    return {
      chatSessionId,
      selectedManualVersionIds,
      resolvedVersions,
    }
  },
})

export const internalGetLockedScope = internalQuery({
  args: {
    chatSessionId: v.id('chatSessions'),
    userTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.chatSessionId)
    if (!session || session.userTokenIdentifier !== args.userTokenIdentifier) {
      throw new Error('Chat not found')
    }

    const selectedManualVersionIds =
      session.selectedManualVersionIds && session.selectedManualVersionIds.length > 0
        ? session.selectedManualVersionIds
        : [session.manualVersionId]

    const selectedManualIds =
      session.selectedManualIds && session.selectedManualIds.length > 0
        ? session.selectedManualIds
        : [session.manualId]

    return {
      chatSessionId: session._id,
      organizationId: session.organizationId,
      selectedManualIds,
      selectedManualVersionIds,
    }
  },
})

export const internalRecordMultiManualExchange = internalMutation({
  args: {
    chatSessionId: v.id('chatSessions'),
    userTokenIdentifier: v.string(),
    title: v.string(),
    question: v.string(),
    answerText: v.string(),
    refusal: v.boolean(),
    citations: v.array(
      v.object({
        title: v.optional(v.string()),
        uri: v.optional(v.string()),
        pageNumber: v.optional(v.number()),
        excerpt: v.optional(v.string()),
        fileSearchStore: v.optional(v.string()),
        manualId: v.optional(v.string()),
        manualVersionId: v.optional(v.string()),
        sourceFileName: v.optional(v.string()),
        providerUri: v.optional(v.string()),
      }),
    ),
    warning: v.optional(v.string()),
    model: v.string(),
    latencyMs: v.number(),
    sourceFileName: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const session = await ctx.db.get(args.chatSessionId)
    if (!session || session.userTokenIdentifier !== args.userTokenIdentifier) {
      throw new Error('Chat not found')
    }

    // First exchange = no messages yet. Use this rather than checking the title
    // string, because new sessions are created with deterministic fallback titles
    // (not "New chat"), so a title-string check would always skip AI generation.
    const existingMessageCount = await ctx.db
      .query('chatMessages')
      .withIndex('by_chatSessionId', (q) => q.eq('chatSessionId', args.chatSessionId))
      .take(1)
    const isFirstExchange = existingMessageCount.length === 0

    await ctx.db.insert('chatMessages', {
      chatSessionId: args.chatSessionId,
      userTokenIdentifier: args.userTokenIdentifier,
      role: 'user',
      content: args.question,
      createdAt: now,
    })

    const assistantMessage: {
      chatSessionId: Id<'chatSessions'>
      userTokenIdentifier: string
      role: 'assistant'
      content: string
      refusal: boolean
      citations: Array<{
        title?: string
        uri?: string
        pageNumber?: number
        excerpt?: string
        fileSearchStore?: string
        manualId?: string
        manualVersionId?: string
        sourceFileName?: string
        providerUri?: string
      }>
      warning?: string
      model: string
      latencyMs: number
      sourceFileName: string
      createdAt: number
    } = {
      chatSessionId: args.chatSessionId,
      userTokenIdentifier: args.userTokenIdentifier,
      role: 'assistant',
      content: args.answerText,
      refusal: args.refusal,
      citations: args.citations,
      model: args.model,
      latencyMs: args.latencyMs,
      sourceFileName: args.sourceFileName,
      createdAt: now + 1,
    }
    if (args.warning) {
      assistantMessage.warning = args.warning
    }

    await ctx.db.insert('chatMessages', assistantMessage)

    await ctx.db.patch(args.chatSessionId, { updatedAt: now })

    if (isFirstExchange) {
      await ctx.scheduler.runAfter(0, internal.gemini.internalGenerateChatTitle, {
        chatSessionId: args.chatSessionId,
        question: args.question,
        answerText: args.refusal ? '' : args.answerText,
      })
    }

    return { chatSessionId: args.chatSessionId }
  },
})

export const internalListBackfillCandidates = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    batchSize: v.number(),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('chatSessions')
      .order('asc')
      .paginate({ cursor: args.cursor, numItems: args.batchSize })

    const candidates: Array<{
      chatSessionId: Id<'chatSessions'>
      question: string
      answerText: string
    }> = []

    for (const session of result.page) {
      const msgs = await ctx.db
        .query('chatMessages')
        .withIndex('by_chatSessionId', (q) =>
          q.eq('chatSessionId', session._id),
        )
        .order('asc')
        .take(2)

      if (msgs.length < 2) continue

      const userMsg = msgs.find((m) => m.role === 'user')
      const assistantMsg = msgs.find((m) => m.role === 'assistant')
      if (!userMsg || !assistantMsg) continue
      if (!isReplaceableTitle(session, userMsg.content)) continue

      candidates.push({
        chatSessionId: session._id,
        question: userMsg.content,
        answerText: assistantMsg.refusal ? '' : assistantMsg.content,
      })
    }

    return { candidates, isDone: result.isDone, continueCursor: result.continueCursor }
  },
})

export const internalUpdateChatTitle = internalMutation({
  args: {
    chatSessionId: v.id('chatSessions'),
    title: v.string(),
    sourceQuestion: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const session = await ctx.db.get(args.chatSessionId)
    if (!session) return false

    if (!isReplaceableTitle(session, args.sourceQuestion)) return false

    const cleaned = cleanGeneratedTitle(args.title)
    if (!cleaned) return false

    await ctx.db.patch(args.chatSessionId, {
      title: cleaned,
      titleAiGenerated: true,
    })
    return true
  },
})

function isReplaceableTitle(
  session: { title: string; titleAiGenerated?: boolean },
  sourceQuestion?: string,
): boolean {
  if (
    sourceQuestion &&
    session.title === legacyBuggyNormalizeTitle(sourceQuestion) &&
    session.title !== normalizeTitle(sourceQuestion)
  ) {
    return true
  }
  // Once marked as AI-generated, never overwrite regardless of length.
  if (session.titleAiGenerated) return false
  if (!session.title || session.title === 'New chat') return true
  // Deterministic fallback titles from normalizeTitle are <=34 chars.
  return session.title.length <= 34
}

function cleanGeneratedTitle(raw: string): string {
  const firstLine = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  const stripped = stripLeadingTitleNoise(
    firstLine.replace(/^["']|["']$/g, '').replace(/[.,;:!?]+$/, '').trim(),
  )
  if (stripped.length < 3 || stripped.length > 60) return ''
  return stripped
}

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

  const withoutQuestionPrefix = stripLeadingTitleNoise(
    trimmed.replace(/^(tell|explain|describe|show|summarize)\b\s+(me\s+)?(about\s+)?/i, ''),
  )
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

const LEADING_TITLE_NOISE = new Set([
  'about',
  'are',
  'can',
  'could',
  'did',
  'do',
  'does',
  'how',
  'i',
  'is',
  'it',
  'should',
  'that',
  'the',
  'there',
  'this',
  'to',
  'we',
  'what',
  'when',
  'where',
  'why',
  'would',
  'you',
])

function stripLeadingTitleNoise(value: string): string {
  let remaining = value.trim()
  for (let i = 0; i < 4; i += 1) {
    const match = remaining.match(/^([A-Za-z]+)\b[\s,;:]*/)
    if (!match) break
    if (!LEADING_TITLE_NOISE.has(match[1].toLowerCase())) break
    remaining = remaining.slice(match[0].length).trimStart()
  }
  return remaining || value.trim()
}

function legacyBuggyNormalizeTitle(value: string): string {
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
