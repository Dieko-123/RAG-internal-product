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
  manualId: v.optional(v.string()),
  manualVersionId: v.optional(v.string()),
  sourceFileName: v.optional(v.string()),
  providerUri: v.optional(v.string()),
})

const membershipRole = v.union(
  v.literal('owner'),
  v.literal('org_admin'),
  v.literal('department_admin'),
  v.literal('member'),
  v.literal('viewer'),
)

const manualVisibility = v.union(
  v.literal('org'),
  v.literal('department'),
  v.literal('restricted'),
)

const providerMode = v.union(
  v.literal('legacy_per_manual_store'),
  v.literal('shared_org_store'),
)

const ingestionJobStatus = v.union(
  v.literal('queued'),
  v.literal('uploading'),
  v.literal('indexing'),
  v.literal('active'),
  v.literal('failed'),
)

export default defineSchema({
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    geminiFileSearchStoreName: v.optional(v.string()),
    geminiFilterMode: v.optional(
      v.union(v.literal('or_syntax'), v.literal('multi_entry')),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_slug', ['slug']),

  departments: defineTable({
    organizationId: v.id('organizations'),
    name: v.string(),
    slug: v.string(),
    status: v.optional(v.union(v.literal('active'), v.literal('archived'))),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_organizationId', ['organizationId'])
    .index('by_organizationId_and_slug', ['organizationId', 'slug']),

  users: defineTable({
    tokenIdentifier: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    status: v.union(v.literal('active'), v.literal('suspended')),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_tokenIdentifier', ['tokenIdentifier'])
    .index('by_email', ['email']),

  memberships: defineTable({
    organizationId: v.id('organizations'),
    departmentId: v.optional(v.id('departments')),
    userTokenIdentifier: v.string(),
    role: membershipRole,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_userTokenIdentifier', ['userTokenIdentifier'])
    .index('by_organizationId', ['organizationId'])
    .index('by_organizationId_and_userTokenIdentifier', [
      'organizationId',
      'userTokenIdentifier',
    ])
    .index('by_departmentId', ['departmentId'])
    .index('by_departmentId_and_userTokenIdentifier', [
      'departmentId',
      'userTokenIdentifier',
    ]),

  manuals: defineTable({
    organizationId: v.optional(v.id('organizations')),
    departmentId: v.optional(v.id('departments')),
    visibility: v.optional(manualVisibility),
    title: v.string(),
    slug: v.string(),
    status: manualStatus,
    currentVersionId: v.optional(v.id('manualVersions')),
    createdByTokenIdentifier: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_slug', ['slug'])
    .index('by_status', ['status'])
    .index('by_organizationId', ['organizationId'])
    .index('by_departmentId', ['departmentId'])
    .index('by_organizationId_and_status', ['organizationId', 'status']),

  manualVersions: defineTable({
    manualId: v.id('manuals'),
    organizationId: v.optional(v.id('organizations')),
    departmentId: v.optional(v.id('departments')),
    visibility: v.optional(manualVisibility),
    versionLabel: v.string(),
    sourceFileName: v.string(),
    provider: v.literal('gemini_file_search'),
    providerMode: v.optional(providerMode),
    geminiFileSearchStoreName: v.optional(v.string()),
    geminiDocumentName: v.optional(v.string()),
    geminiFileSearchDocumentName: v.optional(v.string()),
    geminiFileName: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    status: manualStatus,
    errorMessage: v.optional(v.string()),
    createdByTokenIdentifier: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_manualId', ['manualId'])
    .index('by_status', ['status'])
    .index('by_manualId_and_status', ['manualId', 'status'])
    .index('by_organizationId', ['organizationId'])
    .index('by_departmentId', ['departmentId'])
    .index('by_providerMode', ['providerMode']),

  ingestionJobs: defineTable({
    manualId: v.id('manuals'),
    manualVersionId: v.id('manualVersions'),
    organizationId: v.id('organizations'),
    storageId: v.optional(v.id('_storage')),
    status: ingestionJobStatus,
    attempts: v.number(),
    maxAttempts: v.number(),
    nextPollAt: v.optional(v.number()),
    geminiOperationName: v.optional(v.string()),
    geminiOperationKind: v.optional(
      v.union(
        v.literal('upload_to_file_search_store'),
        v.literal('import_file'),
      ),
    ),
    geminiFileSearchStoreName: v.optional(v.string()),
    geminiDocumentName: v.optional(v.string()),
    geminiFileName: v.optional(v.string()),
    lastError: v.optional(v.string()),
    storageDeletedAt: v.optional(v.number()),
    createdByTokenIdentifier: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_status', ['status'])
    .index('by_manualVersionId', ['manualVersionId'])
    .index('by_manualId', ['manualId'])
    .index('by_organizationId', ['organizationId']),

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
    organizationId: v.optional(v.id('organizations')),
    scopeMode: v.optional(v.literal('selected')),
    selectedManualIds: v.optional(v.array(v.id('manuals'))),
    selectedManualVersionIds: v.optional(v.array(v.id('manualVersions'))),
    manualId: v.id('manuals'),
    manualVersionId: v.id('manualVersions'),
    title: v.string(),
    pinned: v.optional(v.boolean()),
    pinnedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_userTokenIdentifier_and_updatedAt', [
      'userTokenIdentifier',
      'updatedAt',
    ])
    .index('by_userTokenIdentifier_and_pinned', [
      'userTokenIdentifier',
      'pinned',
    ])
    .index('by_manualId', ['manualId']),

  chatMessages: defineTable({
    chatSessionId: v.id('chatSessions'),
    userTokenIdentifier: v.string(),
    role: v.union(v.literal('user'), v.literal('assistant')),
    content: v.string(),
    refusal: v.optional(v.boolean()),
    citations: v.optional(v.array(citation)),
    warning: v.optional(v.string()),
    model: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    sourceFileName: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_chatSessionId', ['chatSessionId'])
    .index('by_userTokenIdentifier', ['userTokenIdentifier']),

  invites: defineTable({
    organizationId: v.id('organizations'),
    email: v.string(),
    emailNormalized: v.string(),
    role: v.union(v.literal('org_admin'), v.literal('member'), v.literal('viewer')),
    departmentId: v.optional(v.id('departments')),
    departmentRole: v.optional(
      v.union(v.literal('department_admin'), v.literal('member'), v.literal('viewer')),
    ),
    status: v.union(
      v.literal('pending'),
      v.literal('accepted'),
      v.literal('revoked'),
      v.literal('expired'),
    ),
    clerkInvitationId: v.optional(v.string()),
    invitedByTokenIdentifier: v.string(),
    acceptedByTokenIdentifier: v.optional(v.string()),
    createdAt: v.number(),
    acceptedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index('by_organizationId', ['organizationId'])
    .index('by_emailNormalized_and_status', ['emailNormalized', 'status'])
    .index('by_organizationId_and_status', ['organizationId', 'status'])
    .index('by_departmentId', ['departmentId']),

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
