import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

const manualStatus = v.union(
  v.literal('draft'),
  v.literal('indexing'),
  v.literal('active'),
  v.literal('failed'),
  v.literal('archived'),
)

const citation = v.object({
  title: v.optional(v.string()),
  uri: v.optional(v.string()),
  pageNumber: v.optional(v.number()),
  excerpt: v.optional(v.string()),
  fileSearchStore: v.optional(v.string()),
})

export default defineSchema({
  manuals: defineTable({
    title: v.string(),
    slug: v.string(),
    status: manualStatus,
    currentVersionId: v.optional(v.id('manualVersions')),
    createdByTokenIdentifier: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_slug', ['slug'])
    .index('by_status', ['status']),

  manualVersions: defineTable({
    manualId: v.id('manuals'),
    versionLabel: v.string(),
    sourceFileName: v.string(),
    provider: v.literal('gemini_file_search'),
    geminiFileSearchStoreName: v.string(),
    geminiFileSearchDocumentName: v.optional(v.string()),
    geminiFileName: v.optional(v.string()),
    status: manualStatus,
    errorMessage: v.optional(v.string()),
    createdByTokenIdentifier: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_manualId', ['manualId'])
    .index('by_status', ['status'])
    .index('by_manualId_and_status', ['manualId', 'status']),

  questions: defineTable({
    manualId: v.id('manuals'),
    manualVersionId: v.id('manualVersions'),
    userTokenIdentifier: v.string(),
    question: v.string(),
    createdAt: v.number(),
  })
    .index('by_userTokenIdentifier', ['userTokenIdentifier'])
    .index('by_manualId', ['manualId'])
    .index('by_manualVersionId', ['manualVersionId']),

  answers: defineTable({
    questionId: v.id('questions'),
    answerText: v.string(),
    refusal: v.boolean(),
    citations: v.array(citation),
    model: v.string(),
    latencyMs: v.number(),
    createdAt: v.number(),
  }).index('by_questionId', ['questionId']),

  chatSessions: defineTable({
    userTokenIdentifier: v.string(),
    manualId: v.id('manuals'),
    manualVersionId: v.id('manualVersions'),
    title: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_userTokenIdentifier_and_updatedAt', [
      'userTokenIdentifier',
      'updatedAt',
    ])
    .index('by_manualId', ['manualId']),

  chatMessages: defineTable({
    chatSessionId: v.id('chatSessions'),
    userTokenIdentifier: v.string(),
    role: v.union(v.literal('user'), v.literal('assistant')),
    content: v.string(),
    refusal: v.optional(v.boolean()),
    citations: v.optional(v.array(citation)),
    model: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    sourceFileName: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_chatSessionId', ['chatSessionId'])
    .index('by_userTokenIdentifier', ['userTokenIdentifier']),

  auditEvents: defineTable({
    actorTokenIdentifier: v.string(),
    action: v.string(),
    targetType: v.string(),
    targetId: v.optional(v.string()),
    metadata: v.record(v.string(), v.string()),
    createdAt: v.number(),
  })
    .index('by_targetType_and_targetId', ['targetType', 'targetId'])
    .index('by_actorTokenIdentifier', ['actorTokenIdentifier']),
})
