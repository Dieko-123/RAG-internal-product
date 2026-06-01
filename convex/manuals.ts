import { v } from 'convex/values'
import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import {
  isAdminIdentity,
  requireManualUploadPermission,
  requireOrganizationMembership,
  requireAllowedUser,
  requireOrgAdmin,
} from './permissions'

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
  manualId: v.optional(v.string()),
  manualVersionId: v.optional(v.string()),
  sourceFileName: v.optional(v.string()),
  providerUri: v.optional(v.string()),
})

// TODO: optimize ingestion job lookup when manual count grows (N+1 query)
export const listManuals = query({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    const { identity, organizationId } = await requireOrganizationMembership(
      ctx,
      args.organizationId,
    )
    const organization = await ctx.db.get(organizationId)
    const manuals = await collectOrganizationManuals(
      ctx,
      organizationId,
      shouldIncludeLegacyDefaultOrgManuals(organization),
    )

    const orgManuals = manuals.sort((a, b) => b.updatedAt - a.updatedAt)

    const isOrgLevel =
      isAdminIdentity(identity) ||
      (await isOrgAdminOrOwner(ctx, organizationId, identity.tokenIdentifier))

    let visibleManuals = orgManuals
    if (!isOrgLevel) {
      const userDeptIds = organization
        ? await getUserAccessibleDepartmentIds(ctx, organizationId, identity.tokenIdentifier)
        : new Set<string>()

      visibleManuals = orgManuals.filter((manual) => {
        const vis = manual.visibility ?? 'org'
        if (vis === 'org') return true
        if (vis === 'department' && manual.departmentId) {
          return userDeptIds.has(manual.departmentId)
        }
        return false
      })
    }

    const results = []

    for (const manual of visibleManuals) {
      const jobs = await ctx.db
        .query('ingestionJobs')
        .withIndex('by_manualId', (q) => q.eq('manualId', manual._id))
        .collect()
      const latestIngestionJob = jobs.sort((a, b) => b.updatedAt - a.updatedAt)[0]

      results.push({
        ...manual,
        organizationId: manual.organizationId ?? organizationId,
        visibility: manual.visibility ?? 'org',
        latestIngestionJob: latestIngestionJob
          ? {
              _id: latestIngestionJob._id,
              status: latestIngestionJob.status,
              lastError: latestIngestionJob.lastError,
              canRetryIndexing: Boolean(
                latestIngestionJob.geminiOperationName ||
                  latestIngestionJob.geminiDocumentName ||
                  latestIngestionJob.geminiFileName ||
                  latestIngestionJob.status === 'indexing',
              ),
            }
          : undefined,
      })
    }

    return results
  },
})

export const listSelectableManuals = query({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    const { identity, organizationId } = await requireOrganizationMembership(
      ctx,
      args.organizationId,
    )
    const organization = await ctx.db.get(organizationId)
    if (!organization) return []

    const activeManuals = (await collectOrganizationManuals(
      ctx,
      organizationId,
      shouldIncludeLegacyDefaultOrgManuals(organization),
    ))
      .filter((manual) => manual.status === 'active')
      .sort((a, b) => b.updatedAt - a.updatedAt)

    const isOrgLevel =
      isAdminIdentity(identity) ||
      (await isOrgAdminOrOwner(ctx, organizationId, identity.tokenIdentifier))

    const userDeptIds = isOrgLevel
      ? null
      : await getUserAccessibleDepartmentIds(ctx, organizationId, identity.tokenIdentifier)

    const results: Array<{
      _id: Id<'manuals'>
      title: string
      visibility: string
      departmentName?: string
    }> = []

    for (const manual of activeManuals) {
      if (!manual.currentVersionId) continue
      const version = await ctx.db.get(manual.currentVersionId)
      if (!version || version.status !== 'active') continue
      if ((version.providerMode ?? 'legacy_per_manual_store') !== 'shared_org_store') continue

      const vis = manual.visibility ?? 'org'
      if (vis === 'restricted') continue

      if (!isOrgLevel && userDeptIds) {
        if (vis === 'department' && manual.departmentId) {
          if (!userDeptIds.has(manual.departmentId)) continue
        }
      }

      let departmentName: string | undefined
      if (vis === 'department' && manual.departmentId) {
        const dept = await ctx.db.get(manual.departmentId)
        departmentName = dept?.name
      }

      results.push({
        _id: manual._id,
        title: manual.title,
        visibility: vis,
        departmentName,
      })
    }

    return results
  },
})

export const getActiveManual = query({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    await requireOrganizationMembership(ctx, args.organizationId)

    return await getActiveManualRecord(ctx, args.organizationId)
  },
})

// Admin-only debug query — safe fields only, no secrets or raw content.
export const debugManualState = query({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    const { organizationId } = await requireOrgAdmin(ctx, args.organizationId)
    const organization = await ctx.db.get(organizationId)

    const manuals = (await collectOrganizationManuals(
      ctx,
      organizationId,
      shouldIncludeLegacyDefaultOrgManuals(organization),
    ))
      .sort((a, b) => b.updatedAt - a.updatedAt)

    const results = []
    for (const manual of manuals) {
      const version = manual.currentVersionId ? await ctx.db.get(manual.currentVersionId) : null
      const jobs = await ctx.db
        .query('ingestionJobs')
        .withIndex('by_manualId', (q) => q.eq('manualId', manual._id))
        .collect()
      const latestJob = jobs.sort((a, b) => b.updatedAt - a.updatedAt)[0]

      results.push({
        manualId: manual._id,
        title: manual.title,
        slug: manual.slug,
        status: manual.status,
        visibility: manual.visibility ?? 'org',
        organizationId: manual.organizationId,
        departmentId: manual.departmentId ?? null,
        currentVersionId: manual.currentVersionId ?? null,
        version: version ? {
          manualVersionId: version._id,
          status: version.status,
          providerMode: version.providerMode ?? 'legacy_per_manual_store',
          sourceFileName: version.sourceFileName,
          mimeType: version.mimeType ?? null,
          sizeBytes: version.sizeBytes ?? null,
          organizationId: version.organizationId ?? null,
          departmentId: version.departmentId ?? null,
          visibility: version.visibility ?? 'org',
          geminiFileSearchStoreName: version.geminiFileSearchStoreName ?? null,
          geminiDocumentNamePresent: Boolean(version.geminiDocumentName ?? version.geminiFileSearchDocumentName),
          geminiFileNamePresent: Boolean(version.geminiFileName),
        } : null,
        latestJob: latestJob ? {
          ingestionJobId: latestJob._id,
          status: latestJob.status,
          lastError: latestJob.lastError ?? null,
          geminiOperationNamePresent: Boolean(latestJob.geminiOperationName),
          geminiDocumentNamePresent: Boolean(latestJob.geminiDocumentName),
          geminiFileNamePresent: Boolean(latestJob.geminiFileName),
          geminiFileSearchStoreName: latestJob.geminiFileSearchStoreName ?? null,
          storageDeletedAt: latestJob.storageDeletedAt ?? null,
          attempts: latestJob.attempts,
          maxAttempts: latestJob.maxAttempts,
        } : null,
      })
    }

    return {
      organizationId,
      orgStoreName: organization?.geminiFileSearchStoreName ?? null,
      geminiFilterMode: organization?.geminiFilterMode ?? null,
      manuals: results,
    }
  },
})

export const getManualForQuestion = query({
  args: {
    organizationId: v.id('organizations'),
    manualId: v.optional(v.id('manuals')),
  },
  handler: async (ctx, args) => {
    await requireOrganizationMembership(ctx, args.organizationId)

    return await getManualForQuestionRecord(ctx, args.organizationId, args.manualId)
  },
})

export const internalGetActiveManual = internalQuery({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    return await getActiveManualRecord(ctx, args.organizationId)
  },
})

export const internalGetManualForQuestion = internalQuery({
  args: {
    organizationId: v.id('organizations'),
    manualId: v.optional(v.id('manuals')),
  },
  handler: async (ctx, args) => {
    return await getManualForQuestionRecord(ctx, args.organizationId, args.manualId)
  },
})

export const archiveManual = mutation({
  args: {
    organizationId: v.id('organizations'),
    manualId: v.id('manuals'),
  },
  handler: async (ctx, args) => {
    const { identity, organizationId } = await requireOrgAdmin(ctx, args.organizationId)
    const now = Date.now()
    const manual = await ctx.db.get(args.manualId)
    const organization = await ctx.db.get(organizationId)
    const allowLegacyManual = shouldIncludeLegacyDefaultOrgManuals(organization)

    if (
      !manual ||
      (manual.organizationId !== organizationId &&
        !(manual.organizationId === undefined && allowLegacyManual))
    ) {
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
    organizationId: v.id('organizations'),
    manualId: v.id('manuals'),
  },
  handler: async (ctx, args) => {
    const { identity, organizationId } = await requireOrgAdmin(ctx, args.organizationId)
    const now = Date.now()
    const manual = await ctx.db.get(args.manualId)
    const organization = await ctx.db.get(organizationId)
    const allowLegacyManual = shouldIncludeLegacyDefaultOrgManuals(organization)

    if (
      !manual ||
      (manual.organizationId !== organizationId &&
        !(manual.organizationId === undefined && allowLegacyManual))
    ) {
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
  args: {
    organizationId: v.id('organizations'),
    visibility: v.union(v.literal('org'), v.literal('department')),
    departmentId: v.optional(v.id('departments')),
  },
  handler: async (ctx, args) => {
    await requireManualUploadPermission(ctx, {
      organizationId: args.organizationId,
      visibility: args.visibility,
      departmentId: args.departmentId,
    })

    return await ctx.storage.generateUploadUrl()
  },
})

export const internalCreateManualIfMissing = internalMutation({
  args: {
    organizationId: v.id('organizations'),
    title: v.string(),
    slug: v.string(),
    actorTokenIdentifier: v.string(),
    visibility: v.optional(v.union(v.literal('org'), v.literal('department'), v.literal('restricted'))),
    departmentId: v.optional(v.id('departments')),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const visibility = args.visibility ?? 'org'
    const existing = await ctx.db
      .query('manuals')
      .withIndex('by_organizationId_and_slug', (q) =>
        q.eq('organizationId', args.organizationId).eq('slug', args.slug),
      )
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, {
        organizationId: args.organizationId,
        visibility: existing.visibility ?? visibility,
        departmentId: existing.departmentId ?? args.departmentId,
        status: existing.status === 'active' ? 'active' : 'indexing',
        updatedAt: now,
      })
      return existing._id
    }

    return await ctx.db.insert('manuals', {
      organizationId: args.organizationId,
      departmentId: args.departmentId,
      visibility,
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
    geminiFileSearchStoreName: v.optional(v.string()),
    geminiFileSearchDocumentName: v.optional(v.string()),
    geminiFileName: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    status: manualStatus,
    actorTokenIdentifier: v.string(),
    visibility: v.optional(v.union(v.literal('org'), v.literal('department'), v.literal('restricted'))),
    departmentId: v.optional(v.id('departments')),
    providerMode: v.optional(v.union(v.literal('legacy_per_manual_store'), v.literal('shared_org_store'))),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const manual = await ctx.db.get(args.manualId)
    if (!manual?.organizationId) {
      throw new Error('Manual organization is not configured.')
    }
    const organizationId = manual.organizationId
    const visibility = args.visibility ?? manual?.visibility ?? 'org'
    const departmentId = args.departmentId ?? manual?.departmentId
    const providerMode = args.providerMode ?? 'legacy_per_manual_store'

    return await ctx.db.insert('manualVersions', {
      manualId: args.manualId,
      organizationId,
      departmentId,
      visibility,
      versionLabel: args.versionLabel,
      sourceFileName: args.sourceFileName,
      provider: args.provider,
      providerMode,
      geminiFileSearchStoreName: args.geminiFileSearchStoreName,
      geminiDocumentName: args.geminiFileSearchDocumentName,
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
    geminiFileSearchStoreName: v.optional(v.string()),
    geminiFileName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const versionPatch: {
      status: 'active'
      geminiFileSearchStoreName?: string
      geminiFileSearchDocumentName?: string
      geminiDocumentName?: string
      geminiFileName?: string
      updatedAt: number
    } = {
      status: 'active',
      updatedAt: now,
    }

    if (args.geminiFileSearchStoreName) {
      versionPatch.geminiFileSearchStoreName = args.geminiFileSearchStoreName
    }

    if (args.geminiFileSearchDocumentName) {
      versionPatch.geminiFileSearchDocumentName = args.geminiFileSearchDocumentName
      versionPatch.geminiDocumentName = args.geminiFileSearchDocumentName
    }

    if (args.geminiFileName) {
      versionPatch.geminiFileName = args.geminiFileName
    }

    const manual = await ctx.db.get(args.manualId)
    if (
      manual?.currentVersionId &&
      manual.currentVersionId !== args.manualVersionId
    ) {
      const previousVersion = await ctx.db.get(manual.currentVersionId)
      if (previousVersion?.status === 'active') {
        await ctx.db.patch(previousVersion._id, {
          status: 'archived',
          updatedAt: now,
        })
      }
    }

    await ctx.db.patch(args.manualVersionId, versionPatch)

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

export const internalGetManualVersionsForScope = internalQuery({
  args: {
    organizationId: v.id('organizations'),
    manualVersionIds: v.array(v.id('manualVersions')),
    userTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireAllowedUser(ctx)
    if (identity.tokenIdentifier !== args.userTokenIdentifier) {
      throw new Error('Token mismatch')
    }

    const organization = await ctx.db.get(args.organizationId)
    if (!organization) {
      throw new Error('Organization not configured.')
    }
    const allowLegacyManuals = shouldIncludeLegacyDefaultOrgManuals(organization)

    const isOrgLevel =
      isAdminIdentity(identity) ||
      (await isOrgAdminOrOwner(ctx, args.organizationId, identity.tokenIdentifier))

    const userDeptIds = isOrgLevel
      ? null
      : await getUserAccessibleDepartmentIds(ctx, args.organizationId, identity.tokenIdentifier)

    type EffectiveVersion = {
      manualId: Id<'manuals'>
      manualVersionId: Id<'manualVersions'>
      title: string
      sourceFileName: string
      geminiFileName?: string
      geminiDocumentName?: string
      geminiFileSearchStoreName?: string
      providerMode: string
    }

    type ExcludedManual = {
      manualId: string
      manualVersionId: string
      title?: string
      reason: 'archived' | 'failed' | 'unauthorized' | 'missing' | 'unsupported_provider_mode'
    }

    const effective: EffectiveVersion[] = []
    const excluded: ExcludedManual[] = []

    for (const versionId of args.manualVersionIds) {
      const version = await ctx.db.get(versionId)
      if (!version) {
        excluded.push({ manualId: '', manualVersionId: versionId, reason: 'missing' })
        continue
      }

      const manual = await ctx.db.get(version.manualId)
      if (!manual) {
        excluded.push({ manualId: version.manualId, manualVersionId: versionId, reason: 'missing' })
        continue
      }

      const manualOrganizationId = manual.organizationId ?? version.organizationId
      if (
        manualOrganizationId !== args.organizationId &&
        !(manualOrganizationId === undefined && allowLegacyManuals)
      ) {
        excluded.push({
          manualId: manual._id,
          manualVersionId: versionId,
          title: manual.title,
          reason: 'unauthorized',
        })
        continue
      }

      if (version.organizationId && version.organizationId !== args.organizationId) {
        excluded.push({
          manualId: manual._id,
          manualVersionId: versionId,
          title: manual.title,
          reason: 'unauthorized',
        })
        continue
      }

      if (manual.status === 'archived' || version.status === 'archived') {
        excluded.push({
          manualId: manual._id,
          manualVersionId: versionId,
          title: manual.title,
          reason: 'archived',
        })
        continue
      }

      if (manual.status === 'failed' || version.status === 'failed') {
        excluded.push({
          manualId: manual._id,
          manualVersionId: versionId,
          title: manual.title,
          reason: 'failed',
        })
        continue
      }

      if (manual.status !== 'active' || version.status !== 'active') {
        excluded.push({
          manualId: manual._id,
          manualVersionId: versionId,
          title: manual.title,
          reason: 'failed',
        })
        continue
      }

      const vis = manual.visibility ?? 'org'
      if (vis === 'restricted') {
        excluded.push({
          manualId: manual._id,
          manualVersionId: versionId,
          title: manual.title,
          reason: 'unauthorized',
        })
        continue
      }

      const providerMode = version.providerMode ?? 'legacy_per_manual_store'
      if (providerMode !== 'shared_org_store') {
        excluded.push({
          manualId: manual._id,
          manualVersionId: versionId,
          title: manual.title,
          reason: 'unsupported_provider_mode',
        })
        continue
      }

      if (!isOrgLevel && userDeptIds) {
        if (vis === 'department' && manual.departmentId) {
          if (!userDeptIds.has(manual.departmentId)) {
            excluded.push({
              manualId: manual._id,
              manualVersionId: versionId,
              title: manual.title,
              reason: 'unauthorized',
            })
            continue
          }
        }
      }

      const effectiveVersion: EffectiveVersion = {
        manualId: manual._id,
        manualVersionId: version._id,
        title: manual.title,
        sourceFileName: version.sourceFileName,
        providerMode,
      }
      if (version.geminiFileName) {
        effectiveVersion.geminiFileName = version.geminiFileName
      }
      const geminiDocumentName =
        version.geminiDocumentName ?? version.geminiFileSearchDocumentName
      if (geminiDocumentName) {
        effectiveVersion.geminiDocumentName = geminiDocumentName
      }
      if (version.geminiFileSearchStoreName) {
        effectiveVersion.geminiFileSearchStoreName = version.geminiFileSearchStoreName
      }

      effective.push(effectiveVersion)
    }

    return {
      effective,
      excluded,
      organizationId: organization._id,
      orgStoreName: organization.geminiFileSearchStoreName,
    }
  },
})

export const internalGetRetrievalDebugState = internalQuery({
  args: {
    organizationId: v.id('organizations'),
    manualId: v.optional(v.id('manuals')),
    manualVersionId: v.optional(v.id('manualVersions')),
  },
  handler: async (ctx, args) => {
    const organization = await ctx.db.get(args.organizationId)
    if (!organization) {
      throw new Error('Organization not configured.')
    }

    let manual = args.manualId ? await ctx.db.get(args.manualId) : null
    let version = args.manualVersionId ? await ctx.db.get(args.manualVersionId) : null

    if (!manual && version) {
      manual = await ctx.db.get(version.manualId)
    }

    if (!manual) {
      throw new Error('Manual not found.')
    }

    if ((manual.organizationId ?? version?.organizationId) !== args.organizationId) {
      throw new Error('Manual not found.')
    }

    if (!version && manual.currentVersionId) {
      version = await ctx.db.get(manual.currentVersionId)
    }

    if (!version) {
      throw new Error('Manual version not found.')
    }

    const jobs = await ctx.db
      .query('ingestionJobs')
      .withIndex('by_manualVersionId', (q) => q.eq('manualVersionId', version._id))
      .take(20)
    const latestJob = jobs.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null

    return {
      organization: {
        _id: organization._id,
        geminiFileSearchStoreNamePresent: Boolean(organization.geminiFileSearchStoreName),
        geminiFileSearchStoreName: organization.geminiFileSearchStoreName ?? null,
        geminiFilterMode: organization.geminiFilterMode ?? null,
      },
      manual: {
        _id: manual._id,
        title: manual.title,
        slug: manual.slug,
        status: manual.status,
        organizationId: manual.organizationId ?? organization._id,
        visibility: manual.visibility ?? 'org',
        departmentId: manual.departmentId ?? null,
        currentVersionId: manual.currentVersionId ?? null,
      },
      manualVersion: {
        _id: version._id,
        status: version.status,
        providerMode: version.providerMode ?? 'legacy_per_manual_store',
        sourceFileName: version.sourceFileName,
        organizationId: version.organizationId ?? manual.organizationId ?? organization._id,
        visibility: version.visibility ?? manual.visibility ?? 'org',
        departmentId: version.departmentId ?? manual.departmentId ?? null,
        geminiFileSearchStoreNamePresent: Boolean(version.geminiFileSearchStoreName),
        geminiFileSearchStoreName: version.geminiFileSearchStoreName ?? null,
        geminiDocumentName:
          version.geminiDocumentName ?? version.geminiFileSearchDocumentName ?? null,
        geminiFileName: version.geminiFileName ?? null,
        geminiDocumentNamePresent: Boolean(
          version.geminiDocumentName ?? version.geminiFileSearchDocumentName,
        ),
        geminiFileNamePresent: Boolean(version.geminiFileName),
      },
      latestJob: latestJob
        ? {
            _id: latestJob._id,
            status: latestJob.status,
            lastError: latestJob.lastError ?? null,
            geminiOperationNamePresent: Boolean(latestJob.geminiOperationName),
            geminiOperationKind: latestJob.geminiOperationKind ?? null,
            geminiFileSearchStoreNamePresent: Boolean(latestJob.geminiFileSearchStoreName),
            geminiDocumentNamePresent: Boolean(latestJob.geminiDocumentName),
            geminiFileNamePresent: Boolean(latestJob.geminiFileName),
            storageDeletedAt: latestJob.storageDeletedAt ?? null,
            attempts: latestJob.attempts,
            maxAttempts: latestJob.maxAttempts,
          }
        : null,
    }
  },
})

async function getActiveManualRecord(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
) {
  const identity = await requireAllowedUser(ctx)
  const manuals = await ctx.db
    .query('manuals')
    .withIndex('by_organizationId_and_status', (q) =>
      q.eq('organizationId', organizationId).eq('status', 'active'),
    )
    .order('desc')
    .take(50)
  const organization = await ctx.db.get(organizationId)
  const allowLegacyManual = shouldIncludeLegacyDefaultOrgManuals(organization)

  for (const manual of manuals) {
    if (!manual.currentVersionId) {
      continue
    }

    if (
      manual.organizationId !== organizationId &&
      !(manual.organizationId === undefined && allowLegacyManual)
    ) {
      continue
    }

    if (!(await canAccessManual(ctx, organizationId, identity, manual))) {
      continue
    }

    const version = await ctx.db.get(manual.currentVersionId)

    if (!version || version.status !== 'active') {
      continue
    }

    if (version.organizationId && version.organizationId !== organizationId) {
      continue
    }

    return {
      manual: {
        ...manual,
        organizationId: manual.organizationId ?? organizationId,
        visibility: manual.visibility ?? 'org',
      },
      version: {
        ...version,
        organizationId: version.organizationId ?? manual.organizationId ?? organizationId,
        departmentId: version.departmentId ?? manual.departmentId,
        visibility: version.visibility ?? manual.visibility ?? 'org',
        providerMode: version.providerMode ?? 'legacy_per_manual_store',
        geminiDocumentName:
          version.geminiDocumentName ?? version.geminiFileSearchDocumentName,
      },
    }
  }

  return null
}

async function isOrgAdminOrOwner(
  ctx: QueryCtx,
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

async function collectOrganizationManuals(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  includeLegacyManuals = false,
): Promise<Array<Doc<'manuals'>>> {
  const currentManuals = await ctx.db
    .query('manuals')
    .withIndex('by_organizationId', (q) => q.eq('organizationId', organizationId))
    .collect()
  const legacyManuals = includeLegacyManuals
    ? await ctx.db
        .query('manuals')
        .withIndex('by_organizationId', (q) => q.eq('organizationId', undefined))
        .collect()
    : []

  return [...currentManuals, ...legacyManuals]
}

function shouldIncludeLegacyDefaultOrgManuals(
  organization: { slug: string } | null,
): boolean {
  return organization?.slug === 'execujet-aviation-nigeria'
}

async function getUserAccessibleDepartmentIds(
  ctx: QueryCtx,
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
    if (m.departmentId) {
      deptIds.add(m.departmentId)
    }
  }
  return deptIds
}

async function getManualForQuestionRecord(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  manualId: Id<'manuals'> | undefined,
) {
  const identity = await requireAllowedUser(ctx)

  if (!manualId) {
    return await getActiveManualRecord(ctx, organizationId)
  }

  const manual = await ctx.db.get(manualId)

  if (
    !manual ||
    manual.status !== 'active' ||
    !manual.currentVersionId
  ) {
    return null
  }

  const organization = await ctx.db.get(organizationId)
  const allowLegacyManual = shouldIncludeLegacyDefaultOrgManuals(organization)
  if (
    manual.organizationId !== organizationId &&
    !(manual.organizationId === undefined && allowLegacyManual)
  ) {
    return null
  }

  if (!(await canAccessManual(ctx, organizationId, identity, manual))) {
    return null
  }

  const version = await ctx.db.get(manual.currentVersionId)

  if (
    !version ||
    version.status !== 'active' ||
    (version.organizationId && version.organizationId !== organizationId)
  ) {
    return null
  }

  return {
    manual: {
      ...manual,
      visibility: manual.visibility ?? 'org',
    },
    version: {
      ...version,
      visibility: version.visibility ?? manual.visibility ?? 'org',
      providerMode: version.providerMode ?? 'legacy_per_manual_store',
      geminiDocumentName:
        version.geminiDocumentName ?? version.geminiFileSearchDocumentName,
    },
  }
}

async function canAccessManual(
  ctx: QueryCtx,
  organizationId: Id<'organizations'>,
  identity: Awaited<ReturnType<typeof requireAllowedUser>>,
  manual: Doc<'manuals'>,
): Promise<boolean> {
  const visibility = manual.visibility ?? 'org'

  if (visibility === 'restricted') {
    return false
  }

  if (isAdminIdentity(identity)) {
    return true
  }

  const memberships = await ctx.db
    .query('memberships')
    .withIndex('by_organizationId_and_userTokenIdentifier', (q) =>
      q
        .eq('organizationId', organizationId)
        .eq('userTokenIdentifier', identity.tokenIdentifier),
    )
    .collect()

  const isOrgLevel = memberships.some(
    (membership) =>
      membership.departmentId === undefined &&
      (membership.role === 'owner' || membership.role === 'org_admin'),
  )

  if (isOrgLevel || visibility === 'org') {
    return memberships.length > 0
  }

  if (visibility === 'department' && manual.departmentId) {
    return memberships.some(
      (membership) => membership.departmentId === manual.departmentId,
    )
  }

  return false
}
