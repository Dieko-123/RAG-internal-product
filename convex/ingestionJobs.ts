import { v } from 'convex/values'
import { internalMutation, internalQuery } from './_generated/server'

export const internalCreateQueuedJob = internalMutation({
  args: {
    manualId: v.id('manuals'),
    manualVersionId: v.id('manualVersions'),
    organizationId: v.id('organizations'),
    storageId: v.id('_storage'),
    maxAttempts: v.number(),
    actorTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()

    return await ctx.db.insert('ingestionJobs', {
      manualId: args.manualId,
      manualVersionId: args.manualVersionId,
      organizationId: args.organizationId,
      storageId: args.storageId,
      status: 'queued',
      attempts: 0,
      maxAttempts: args.maxAttempts,
      createdByTokenIdentifier: args.actorTokenIdentifier,
      createdAt: now,
      updatedAt: now,
    })
  },
})

export const internalGetJob = internalQuery({
  args: {
    ingestionJobId: v.id('ingestionJobs'),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.ingestionJobId)
    if (!job) return null

    const manual = await ctx.db.get(job.manualId)
    const manualVersion = await ctx.db.get(job.manualVersionId)

    return {
      job,
      manual,
      manualVersion,
    }
  },
})

export const internalMarkUploading = internalMutation({
  args: {
    ingestionJobId: v.id('ingestionJobs'),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.ingestionJobId, {
      status: 'uploading',
      lastError: undefined,
      updatedAt: Date.now(),
    })
  },
})

export const internalMarkIndexing = internalMutation({
  args: {
    ingestionJobId: v.id('ingestionJobs'),
    manualVersionId: v.id('manualVersions'),
    geminiOperationName: v.optional(v.string()),
    geminiOperationKind: v.optional(
      v.union(
        v.literal('upload_to_file_search_store'),
        v.literal('import_file'),
      ),
    ),
    geminiFileSearchStoreName: v.string(),
    geminiDocumentName: v.optional(v.string()),
    geminiFileName: v.optional(v.string()),
    nextPollAt: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()

    await ctx.db.patch(args.ingestionJobId, {
      status: 'indexing',
      geminiOperationName: args.geminiOperationName,
      geminiOperationKind: args.geminiOperationKind,
      geminiFileSearchStoreName: args.geminiFileSearchStoreName,
      geminiDocumentName: args.geminiDocumentName,
      geminiFileName: args.geminiFileName,
      nextPollAt: args.nextPollAt,
      lastError: undefined,
      updatedAt: now,
    })

    await ctx.db.patch(args.manualVersionId, {
      status: 'indexing',
      geminiFileSearchStoreName: args.geminiFileSearchStoreName,
      geminiDocumentName: args.geminiDocumentName,
      geminiFileSearchDocumentName: args.geminiDocumentName,
      geminiFileName: args.geminiFileName,
      updatedAt: now,
    })
  },
})

export const internalMarkStorageDeleted = internalMutation({
  args: {
    ingestionJobId: v.id('ingestionJobs'),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.ingestionJobId, {
      storageId: undefined,
      storageDeletedAt: Date.now(),
      updatedAt: Date.now(),
    })
  },
})

export const internalScheduleNextPoll = internalMutation({
  args: {
    ingestionJobId: v.id('ingestionJobs'),
    attempts: v.number(),
    nextPollAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.ingestionJobId, {
      attempts: args.attempts,
      nextPollAt: args.nextPollAt,
      updatedAt: Date.now(),
    })
  },
})

export const internalMarkActive = internalMutation({
  args: {
    ingestionJobId: v.id('ingestionJobs'),
    manualId: v.id('manuals'),
    manualVersionId: v.id('manualVersions'),
    geminiDocumentName: v.optional(v.string()),
    geminiFileName: v.optional(v.string()),
    actorTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
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

    await ctx.db.patch(args.manualVersionId, {
      status: 'active',
      geminiDocumentName: args.geminiDocumentName,
      geminiFileSearchDocumentName: args.geminiDocumentName,
      geminiFileName: args.geminiFileName,
      errorMessage: undefined,
      updatedAt: now,
    })

    await ctx.db.patch(args.manualId, {
      status: 'active',
      currentVersionId: args.manualVersionId,
      updatedAt: now,
    })

    await ctx.db.patch(args.ingestionJobId, {
      status: 'active',
      geminiDocumentName: args.geminiDocumentName,
      geminiFileName: args.geminiFileName,
      lastError: undefined,
      updatedAt: now,
    })

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: args.actorTokenIdentifier,
      action: 'manual.ingest_upload',
      targetType: 'manual',
      targetId: args.manualId,
      metadata: {
        manualVersionId: args.manualVersionId,
        ingestionJobId: args.ingestionJobId,
        title: manual?.title ?? '',
      },
      createdAt: now,
    })
  },
})

export const internalMarkFailed = internalMutation({
  args: {
    ingestionJobId: v.id('ingestionJobs'),
    manualId: v.id('manuals'),
    manualVersionId: v.id('manualVersions'),
    errorMessage: v.string(),
    actorTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const manual = await ctx.db.get(args.manualId)

    await ctx.db.patch(args.ingestionJobId, {
      status: 'failed',
      lastError: args.errorMessage,
      updatedAt: now,
    })

    await ctx.db.patch(args.manualVersionId, {
      status: 'failed',
      errorMessage: args.errorMessage,
      updatedAt: now,
    })

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
      } else {
        await ctx.db.patch(args.manualId, {
          status: 'failed',
          updatedAt: now,
        })
      }
    } else {
      await ctx.db.patch(args.manualId, {
        status: 'failed',
        updatedAt: now,
      })
    }

    await ctx.db.insert('auditEvents', {
      actorTokenIdentifier: args.actorTokenIdentifier,
      action: 'manual.ingest_upload_failed',
      targetType: 'manual',
      targetId: args.manualId,
      metadata: {
        manualVersionId: args.manualVersionId,
        ingestionJobId: args.ingestionJobId,
        errorMessage: args.errorMessage,
      },
      createdAt: now,
    })
  },
})

export const internalPrepareRetry = internalMutation({
  args: {
    ingestionJobId: v.id('ingestionJobs'),
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.ingestionJobId)

    if (!job) {
      throw new Error('Ingestion job not found.')
    }

    if (job.organizationId !== args.organizationId) {
      throw new Error('Ingestion job not found.')
    }

    if (job.status !== 'failed') {
      throw new Error('Only failed ingestion jobs can be retried.')
    }

    if (!canRetryIndexing(job)) {
      throw new Error('Re-upload required.')
    }

    await ctx.db.patch(args.ingestionJobId, {
      status: 'indexing',
      lastError: undefined,
      nextPollAt: Date.now(),
      updatedAt: Date.now(),
    })

    await ctx.db.patch(job.manualVersionId, {
      status: 'indexing',
      errorMessage: undefined,
      updatedAt: Date.now(),
    })

    return job
  },
})

export const internalGetLatestJobsByManualIds = internalQuery({
  args: {
    manualIds: v.array(v.id('manuals')),
  },
  handler: async (ctx, args) => {
    const results = []

    for (const manualId of args.manualIds) {
      const jobs = await ctx.db
        .query('ingestionJobs')
        .withIndex('by_manualId', (q) => q.eq('manualId', manualId))
        .collect()
      const latest = jobs.sort((a, b) => b.updatedAt - a.updatedAt)[0]

      if (latest) {
        results.push({
          ...latest,
          canRetryIndexing: canRetryIndexing(latest),
        })
      }
    }

    return results
  },
})

export const internalGetStuckUploadingJobs = internalQuery({
  args: {
    cutoff: v.number(),
    batchSize: v.number(),
  },
  handler: async (ctx, args) => {
    const uploadingJobs = await ctx.db
      .query('ingestionJobs')
      .withIndex('by_status', (q) => q.eq('status', 'uploading'))
      .take(args.batchSize)

    return uploadingJobs.filter((job) => job.updatedAt < args.cutoff)
  },
})

function canRetryIndexing(job: {
  status: string
  geminiOperationName?: string
  geminiDocumentName?: string
  geminiFileName?: string
}) {
  return Boolean(
    job.geminiOperationName ||
      job.geminiDocumentName ||
      job.geminiFileName ||
      job.status === 'indexing',
  )
}
