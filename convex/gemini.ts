'use node'

import {
  GoogleGenAI,
  ImportFileOperation,
  UploadToFileSearchStoreOperation,
} from '@google/genai'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { action, internalAction } from './_generated/server'
import type { ActionCtx } from './_generated/server'
import {
  DUMMY_MANUAL_CONTENT,
  DUMMY_MANUAL_FILE_NAME,
  DUMMY_MANUAL_SLUG,
  DUMMY_MANUAL_TITLE,
} from './fixtures/dummyManual'
import { requireAdmin } from './permissions'

const DEFAULT_MODEL = 'gemini-2.5-flash'
const REFUSAL = 'I could not find this in the manual.'
const INDEXING_POLL_INTERVAL_MS = Number(process.env.INGESTION_POLL_INTERVAL_MS) || 5000
const INDEXING_MAX_ATTEMPTS = Number(process.env.INGESTION_MAX_POLL_ATTEMPTS) || 240
const UPLOAD_JOB_MAX_ATTEMPTS = Number(process.env.INGESTION_MAX_POLL_ATTEMPTS) || 240
const STUCK_UPLOADING_TIMEOUT_MS = 5 * 60 * 1000
const MANUAL_ONLY_INSTRUCTION =
  'You are a manual-based internal assistant. Answer only from the attached manual/File Search results. Do not use outside knowledge. If the manual does not clearly contain the answer, say exactly: I could not find this in the manual. Every factual answer should cite the relevant source when citation metadata is available.'

type Citation = {
  title?: string
  uri?: string
  pageNumber?: number
  excerpt?: string
  fileSearchStore?: string
  sourceFileName?: string
  providerUri?: string
}

type GeminiCustomMetadata = Array<{
  key: string
  stringValue: string
}>

type FileSearchIngestionOperation =
  | UploadToFileSearchStoreOperation
  | ImportFileOperation

type ActiveManual = {
  manual: {
    _id: Id<'manuals'>
    title: string
    slug: string
  }
  version: {
    _id: Id<'manualVersions'>
    sourceFileName: string
    geminiFileSearchStoreName?: string
  }
} | null

type IngestDummyManualResult = {
  manualId: Id<'manuals'>
  manualVersionId: Id<'manualVersions'>
  status: 'active'
  geminiFileSearchStoreName: string
  geminiFileSearchDocumentName?: string
  geminiFileName?: string
}

type IngestUploadedManualResult = {
  manualId: Id<'manuals'>
  manualVersionId: Id<'manualVersions'>
  ingestionJobId: Id<'ingestionJobs'>
  status: 'queued'
  title: string
  sourceFileName: string
}

type RetryIndexingResult = {
  ingestionJobId: Id<'ingestionJobs'>
  manualId: Id<'manuals'>
  manualVersionId: Id<'manualVersions'>
  status: 'indexing'
}

type AskManualQuestionResult = {
  chatSessionId: Id<'chatSessions'>
  answerText: string
  refusal: boolean
  citations: Citation[]
  latencyMs: number
  model: string
  manualTitle: string
  sourceFileName: string
}

export const ingestDummyManual = action({
  args: {},
  handler: async (ctx): Promise<IngestDummyManualResult> => {
    const admin = await requireAdmin(ctx)
    const apiKey = readRequiredEnv('GEMINI_API_KEY')
    const ai = new GoogleGenAI({ apiKey })

    const orgId = await getOrgIdForUser(ctx)

    const manualId: Id<'manuals'> = await ctx.runMutation(
      internal.manuals.internalCreateManualIfMissing,
      {
        title: DUMMY_MANUAL_TITLE,
        slug: DUMMY_MANUAL_SLUG,
        actorTokenIdentifier: admin.tokenIdentifier,
        visibility: 'org',
      },
    )

    let manualVersionId: Id<'manualVersions'> | null = null

    try {
      const existingStoreName: string | null = await ctx.runQuery(
        internal.users.internalGetOrgStoreName,
        { organizationId: orgId },
      )

      let storeName: string
      if (existingStoreName) {
        storeName = existingStoreName
      } else {
        const newStore = await ai.fileSearchStores.create({
          config: { displayName: `org-store-${orgId}` },
        })
        if (!newStore.name) {
          throw new Error('Gemini did not return a File Search store name.')
        }
        storeName = await ctx.runMutation(
          internal.users.internalGetOrCreateOrgStore,
          { organizationId: orgId, geminiFileSearchStoreName: newStore.name },
        )
      }

      manualVersionId = await ctx.runMutation(
        internal.manuals.internalCreateManualVersion,
        {
          manualId,
          versionLabel: 'v1',
          sourceFileName: DUMMY_MANUAL_FILE_NAME,
          provider: 'gemini_file_search',
          providerMode: 'shared_org_store',
          geminiFileSearchStoreName: storeName,
          mimeType: 'text/plain',
          sizeBytes: DUMMY_MANUAL_CONTENT.length,
          status: 'indexing',
          actorTokenIdentifier: admin.tokenIdentifier,
          visibility: 'org',
        },
      )
      const createdManualVersionId = manualVersionId

      const imported = await importBlobIntoSharedStore(ai, {
        storeName,
        file: new Blob([DUMMY_MANUAL_CONTENT], { type: 'text/plain' }),
        displayName: DUMMY_MANUAL_FILE_NAME,
        mimeType: 'text/plain',
        customMetadata: [
          { key: 'organizationId', stringValue: orgId },
          { key: 'organization_id', stringValue: orgId },
          { key: 'visibility', stringValue: 'org' },
          { key: 'departmentId', stringValue: 'org' },
          { key: 'department_id', stringValue: 'org' },
          { key: 'manualId', stringValue: manualId },
          { key: 'manual_id', stringValue: manualId },
          { key: 'manualVersionId', stringValue: createdManualVersionId },
          { key: 'manual_version_id', stringValue: createdManualVersionId },
          { key: 'status', stringValue: 'active' },
        ],
      })

      const operation = await waitForOperation(ai, imported.operation)

      const documentName = normalizeGeminiDocumentName(
        storeName,
        extractStringField(operation.response, 'documentName'),
      )
      const fileName = imported.fileName

      await ctx.runMutation(internal.manuals.internalMarkManualVersionActive, {
        manualId,
        manualVersionId,
        geminiFileSearchDocumentName: documentName,
        geminiFileSearchStoreName: storeName,
        geminiFileName: fileName,
      })

      await ctx.runMutation(internal.manuals.internalWriteAuditEvent, {
        actorTokenIdentifier: admin.tokenIdentifier,
        action: 'manual.ingest_dummy',
        targetType: 'manual',
        targetId: manualId,
        metadata: {
          manualVersionId,
          geminiFileSearchStoreName: storeName,
          geminiFileSearchDocumentName: documentName ?? '',
          geminiFileName: fileName ?? '',
        },
      })

      if (!manualVersionId) {
        throw new Error('Manual version was not created.')
      }

      return {
        manualId,
        manualVersionId,
        status: 'active',
        geminiFileSearchStoreName: storeName,
        geminiFileSearchDocumentName: documentName,
        geminiFileName: fileName,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown ingestion error'

      await ctx.runMutation(internal.manuals.internalMarkManualVersionFailed, {
        manualId,
        manualVersionId: manualVersionId ?? undefined,
        errorMessage: message,
      })

      await ctx.runMutation(internal.manuals.internalWriteAuditEvent, {
        actorTokenIdentifier: admin.tokenIdentifier,
        action: 'manual.ingest_dummy_failed',
        targetType: 'manual',
        targetId: manualId,
        metadata: {
          manualVersionId: manualVersionId ?? '',
          errorMessage: message,
        },
      })

      throw error
    }
  },
})

export const ingestUploadedManual = action({
  args: {
    storageId: v.id('_storage'),
    title: v.string(),
    sourceFileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    visibility: v.optional(v.union(v.literal('org'), v.literal('department'), v.literal('restricted'))),
    departmentId: v.optional(v.id('departments')),
  },
  handler: async (ctx, args): Promise<IngestUploadedManualResult> => {
    const visibility = args.visibility ?? 'org'
    const permission = await ctx.runQuery(
      internal.users.internalRequireManualUploadPermission,
      { visibility, departmentId: args.departmentId },
    )
    const fileInfo = validateManualUpload(args)
    const slug = slugify(fileInfo.title)

    const manualId: Id<'manuals'> = await ctx.runMutation(
      internal.manuals.internalCreateManualIfMissing,
      {
        title: fileInfo.title,
        slug,
        actorTokenIdentifier: permission.identity.tokenIdentifier,
        visibility: permission.effectiveVisibility,
        departmentId: permission.effectiveDepartmentId,
      },
    )
    const versionLabel = `upload-${Date.now()}`
    const manualVersionId: Id<'manualVersions'> = await ctx.runMutation(
      internal.manuals.internalCreateManualVersion,
      {
        manualId,
        versionLabel,
        sourceFileName: fileInfo.sourceFileName,
        provider: 'gemini_file_search',
        mimeType: fileInfo.mimeType,
        sizeBytes: fileInfo.sizeBytes,
        status: 'indexing',
        actorTokenIdentifier: permission.identity.tokenIdentifier,
        visibility: permission.effectiveVisibility,
        departmentId: permission.effectiveDepartmentId,
        providerMode: 'shared_org_store',
      },
    )
    const ingestionJobId: Id<'ingestionJobs'> = await ctx.runMutation(
      internal.ingestionJobs.internalCreateQueuedJob,
      {
        manualId,
        manualVersionId,
        organizationId: permission.organizationId,
        storageId: args.storageId,
        maxAttempts: UPLOAD_JOB_MAX_ATTEMPTS,
        actorTokenIdentifier: permission.identity.tokenIdentifier,
      },
    )

    await ctx.scheduler.runAfter(0, internal.gemini.internalRunIngestionJob, {
      ingestionJobId,
    })

    return {
      manualId,
      manualVersionId,
      ingestionJobId,
      status: 'queued',
      title: fileInfo.title,
      sourceFileName: fileInfo.sourceFileName,
    }
  },
})

export const retryIndexing = action({
  args: {
    ingestionJobId: v.id('ingestionJobs'),
  },
  handler: async (ctx, args): Promise<RetryIndexingResult> => {
    const admin = await ctx.runQuery(internal.users.internalRequireOrgAdmin, {})
    const job = await ctx.runMutation(
      internal.ingestionJobs.internalPrepareRetry,
      {
        ingestionJobId: args.ingestionJobId,
        organizationId: admin.organizationId,
      },
    )

    await ctx.scheduler.runAfter(0, internal.gemini.internalPollIngestionJob, {
      ingestionJobId: args.ingestionJobId,
    })

    return {
      ingestionJobId: args.ingestionJobId,
      manualId: job.manualId,
      manualVersionId: job.manualVersionId,
      status: 'indexing' as const,
    }
  },
})

export const internalRunIngestionJob = internalAction({
  args: {
    ingestionJobId: v.id('ingestionJobs'),
  },
  handler: async (ctx, args) => {
    const loaded = await ctx.runQuery(internal.ingestionJobs.internalGetJob, {
      ingestionJobId: args.ingestionJobId,
    })

    if (!loaded?.job || !loaded.manual || !loaded.manualVersion) {
      throw new Error('Ingestion job not found.')
    }

    const { job, manual, manualVersion } = loaded

    if (job.status !== 'queued') {
      return
    }

    try {
      await ctx.runMutation(internal.ingestionJobs.internalMarkUploading, {
        ingestionJobId: job._id,
      })

      if (!job.storageId) {
        throw new Error('Re-upload required.')
      }

      const fileBlob = await ctx.storage.get(job.storageId)

      if (!fileBlob) {
        throw new Error('Uploaded manual file was not found in Convex storage. Re-upload required.')
      }

      const apiKey = readRequiredEnv('GEMINI_API_KEY')
      const ai = new GoogleGenAI({ apiKey })

      const isSharedStore = manualVersion.providerMode === 'shared_org_store'
      let storeName: string

      if (isSharedStore) {
        const existingStoreName: string | null = await ctx.runQuery(
          internal.users.internalGetOrgStoreName,
          { organizationId: job.organizationId },
        )

        if (existingStoreName) {
          storeName = existingStoreName
        } else {
          const newStore = await ai.fileSearchStores.create({
            config: {
              displayName: `org-store-${job.organizationId}`,
            },
          })
          if (!newStore.name) {
            throw new Error('Gemini did not return a File Search store name.')
          }
          storeName = await ctx.runMutation(
            internal.users.internalGetOrCreateOrgStore,
            {
              organizationId: job.organizationId,
              geminiFileSearchStoreName: newStore.name,
            },
          )
        }
      } else {
        const fileSearchStore = await ai.fileSearchStores.create({
          config: {
            displayName: `${manual.title} ${Date.now()}`,
          },
        })
        if (!fileSearchStore.name) {
          throw new Error('Gemini did not return a File Search store name.')
        }
        storeName = fileSearchStore.name
      }

      const customMetadata = isSharedStore
        ? [
            { key: 'organizationId', stringValue: job.organizationId },
            { key: 'organization_id', stringValue: job.organizationId },
            { key: 'visibility', stringValue: manualVersion.visibility ?? 'org' },
            {
              key: 'departmentId',
              stringValue:
                manualVersion.visibility === 'department' && manualVersion.departmentId
                  ? manualVersion.departmentId
                  : 'org',
            },
            {
              key: 'department_id',
              stringValue:
                manualVersion.visibility === 'department' && manualVersion.departmentId
                  ? manualVersion.departmentId
                  : 'org',
            },
            { key: 'manualId', stringValue: manual._id },
            { key: 'manual_id', stringValue: manual._id },
            { key: 'manualVersionId', stringValue: manualVersion._id },
            { key: 'manual_version_id', stringValue: manualVersion._id },
            { key: 'status', stringValue: 'active' },
          ]
        : [
            { key: 'manual_slug', stringValue: manual.slug },
            { key: 'manual_version', stringValue: manualVersion.versionLabel },
            { key: 'source_file_name', stringValue: manualVersion.sourceFileName },
          ]

      const imported = isSharedStore
        ? await importBlobIntoSharedStore(ai, {
            storeName,
            file: fileBlob,
            displayName: manualVersion.sourceFileName,
            mimeType: manualVersion.mimeType,
            customMetadata,
          })
        : {
            operation: await ai.fileSearchStores.uploadToFileSearchStore({
              fileSearchStoreName: storeName,
              file: fileBlob,
              config: {
                displayName: manualVersion.sourceFileName,
                mimeType: manualVersion.mimeType,
                customMetadata,
              },
            }),
            fileName: undefined,
          }
      const operation = imported.operation
      const documentName = normalizeGeminiDocumentName(
        storeName,
        extractStringField(operation.response, 'documentName'),
      )
      const fileName = imported.fileName ?? extractStringField(operation.response, 'fileName')
      const nextPollAt = Date.now() + INDEXING_POLL_INTERVAL_MS

      await ctx.runMutation(internal.ingestionJobs.internalMarkIndexing, {
        ingestionJobId: job._id,
        manualVersionId: manualVersion._id,
        geminiOperationName: operation.name,
        geminiOperationKind: isSharedStore
          ? 'import_file'
          : 'upload_to_file_search_store',
        geminiFileSearchStoreName: storeName,
        geminiDocumentName: documentName,
        geminiFileName: fileName,
        nextPollAt,
      })

      await deleteTemporaryUpload(ctx, job.storageId, job._id)

      await ctx.scheduler.runAfter(
        operation.done ? 0 : INDEXING_POLL_INTERVAL_MS,
        internal.gemini.internalPollIngestionJob,
        { ingestionJobId: job._id },
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown upload ingestion error'

      if (job.storageId) {
        await deleteTemporaryUpload(ctx, job.storageId, job._id)
      }

      await ctx.runMutation(internal.ingestionJobs.internalMarkFailed, {
        ingestionJobId: job._id,
        manualId: job.manualId,
        manualVersionId: job.manualVersionId,
        errorMessage: message,
        actorTokenIdentifier: job.createdByTokenIdentifier,
      })
    }
  },
})

export const internalPollIngestionJob = internalAction({
  args: {
    ingestionJobId: v.id('ingestionJobs'),
  },
  handler: async (ctx, args) => {
    const loaded = await ctx.runQuery(internal.ingestionJobs.internalGetJob, {
      ingestionJobId: args.ingestionJobId,
    })

    if (!loaded?.job || !loaded.manualVersion) {
      throw new Error('Ingestion job not found.')
    }

    const { job, manualVersion } = loaded

    if (job.status !== 'indexing') {
      return
    }

    if (job.attempts >= job.maxAttempts) {
      await ctx.runMutation(internal.ingestionJobs.internalMarkFailed, {
        ingestionJobId: job._id,
        manualId: job.manualId,
        manualVersionId: job.manualVersionId,
        errorMessage: 'Gemini indexing did not complete within the retry limit.',
        actorTokenIdentifier: job.createdByTokenIdentifier,
      })
      return
    }

    const resolvedDocumentName = job.geminiDocumentName ?? manualVersion.geminiDocumentName
    const resolvedFileName = job.geminiFileName ?? manualVersion.geminiFileName

    if (resolvedDocumentName) {
      await ctx.runMutation(internal.ingestionJobs.internalMarkActive, {
        ingestionJobId: job._id,
        manualId: job.manualId,
        manualVersionId: job.manualVersionId,
        geminiDocumentName: resolvedDocumentName,
        geminiFileName: resolvedFileName,
        actorTokenIdentifier: job.createdByTokenIdentifier,
      })
      return
    }

    if (!job.geminiOperationName) {
      await ctx.runMutation(internal.ingestionJobs.internalMarkFailed, {
        ingestionJobId: job._id,
        manualId: job.manualId,
        manualVersionId: job.manualVersionId,
        errorMessage: 'Re-upload required.',
        actorTokenIdentifier: job.createdByTokenIdentifier,
      })
      return
    }

    try {
      const apiKey = readRequiredEnv('GEMINI_API_KEY')
      const ai = new GoogleGenAI({ apiKey })
      const operationKind =
        job.geminiOperationKind ??
        (manualVersion.providerMode === 'shared_org_store'
          ? 'import_file'
          : 'upload_to_file_search_store')
      const operation = await getFileSearchOperation(ai, {
        name: job.geminiOperationName,
        kind: operationKind,
      })

      if (operation.error) {
        throw new Error(`Gemini File Search indexing failed: ${JSON.stringify(operation.error)}`)
      }

      if (operation.done) {
        const completedDocumentName = normalizeGeminiDocumentName(
          job.geminiFileSearchStoreName ?? manualVersion.geminiFileSearchStoreName,
          extractStringField(operation.response, 'documentName') ??
            job.geminiDocumentName ??
            manualVersion.geminiDocumentName,
        )
        if (!completedDocumentName) {
          throw new Error('Gemini File Search import completed without a document name.')
        }

        await ctx.runMutation(internal.ingestionJobs.internalMarkActive, {
          ingestionJobId: job._id,
          manualId: job.manualId,
          manualVersionId: job.manualVersionId,
          geminiDocumentName: completedDocumentName,
          geminiFileName:
            extractStringField(operation.response, 'fileName') ??
            job.geminiFileName ??
            manualVersion.geminiFileName,
          actorTokenIdentifier: job.createdByTokenIdentifier,
        })
        return
      }

      const nextPollAt = Date.now() + INDEXING_POLL_INTERVAL_MS
      await ctx.runMutation(internal.ingestionJobs.internalScheduleNextPoll, {
        ingestionJobId: job._id,
        attempts: job.attempts + 1,
        nextPollAt,
      })
      await ctx.scheduler.runAfter(
        INDEXING_POLL_INTERVAL_MS,
        internal.gemini.internalPollIngestionJob,
        { ingestionJobId: job._id },
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown indexing poll error'

      await ctx.runMutation(internal.ingestionJobs.internalMarkFailed, {
        ingestionJobId: job._id,
        manualId: job.manualId,
        manualVersionId: job.manualVersionId,
        errorMessage: message,
        actorTokenIdentifier: job.createdByTokenIdentifier,
      })
    }
  },
})

export const internalRecoverStuckJobs = internalAction({
  args: {},
  handler: async (ctx) => {
    const stuckJobs: Array<{
      _id: Id<'ingestionJobs'>
      manualId: Id<'manuals'>
      manualVersionId: Id<'manualVersions'>
      createdByTokenIdentifier: string
      geminiOperationName?: string
      geminiDocumentName?: string
      geminiFileName?: string
      geminiFileSearchStoreName?: string
      nextPollAt?: number
    }> = await ctx.runQuery(
      internal.ingestionJobs.internalGetStuckUploadingJobs,
      { olderThanMs: STUCK_UPLOADING_TIMEOUT_MS },
    )

    for (const job of stuckJobs) {
      const hasProviderIds = Boolean(
        job.geminiOperationName || job.geminiDocumentName || job.geminiFileName,
      )

      if (hasProviderIds) {
        await ctx.runMutation(internal.ingestionJobs.internalMarkIndexing, {
          ingestionJobId: job._id,
          manualVersionId: job.manualVersionId,
          geminiOperationName: job.geminiOperationName,
          geminiFileSearchStoreName: job.geminiFileSearchStoreName ?? '',
          geminiDocumentName: job.geminiDocumentName,
          geminiFileName: job.geminiFileName,
          nextPollAt: Date.now() + INDEXING_POLL_INTERVAL_MS,
        })
        await ctx.scheduler.runAfter(
          0,
          internal.gemini.internalPollIngestionJob,
          { ingestionJobId: job._id },
        )
      } else {
        await ctx.runMutation(internal.ingestionJobs.internalMarkFailed, {
          ingestionJobId: job._id,
          manualId: job.manualId,
          manualVersionId: job.manualVersionId,
          errorMessage: 'Upload did not complete. Re-upload required.',
          actorTokenIdentifier: job.createdByTokenIdentifier,
        })
      }
    }
  },
})

export const askManualQuestion = action({
  args: {
    question: v.string(),
    chatSessionId: v.optional(v.id('chatSessions')),
    manualId: v.optional(v.id('manuals')),
  },
  handler: async (ctx, args): Promise<AskManualQuestionResult> => {
    const user = await ctx.runQuery(internal.users.internalRequireAllowedUser, {})
    const question = args.question.trim()

    if (!question) {
      throw new Error('Question is required')
    }

    const activeManual: ActiveManual = await ctx.runQuery(
      internal.manuals.internalGetManualForQuestion,
      { manualId: args.manualId },
    )

    if (!activeManual) {
      throw new Error('No active manual is available yet.')
    }

    if (!activeManual.version.geminiFileSearchStoreName) {
      throw new Error('The selected manual is not ready for questions yet.')
    }

    const model = process.env.GEMINI_DEFAULT_MODEL?.trim() || DEFAULT_MODEL
    const apiKey = readRequiredEnv('GEMINI_API_KEY')
    const ai = new GoogleGenAI({ apiKey })
    const startedAt = Date.now()

    const response = await ai.models.generateContent({
      model,
      contents: question,
      config: {
        systemInstruction: MANUAL_ONLY_INSTRUCTION,
        temperature: 0,
        tools: [
          {
            fileSearch: {
              fileSearchStoreNames: [
                activeManual.version.geminiFileSearchStoreName,
              ],
              metadataFilter: `manual_slug="${activeManual.manual.slug}"`,
            },
          },
        ],
      },
    })

    const latencyMs = Date.now() - startedAt
    const citations = normalizeCitations(
      response.candidates?.[0]?.groundingMetadata,
    )
    const normalizedCitations = citations.map((citation) => ({
      ...citation,
      title: activeManual.version.sourceFileName,
      sourceFileName: activeManual.version.sourceFileName,
      providerUri: citation.providerUri ?? citation.uri,
    }))
    const rawText = response.text?.trim() ?? ''
    const refusal = shouldRefuse(rawText)
    const answerText = refusal ? REFUSAL : rawText
    const answerCitations = refusal ? [] : normalizedCitations

    const questionId = await ctx.runMutation(
      internal.manuals.internalLogQuestion,
      {
        manualId: activeManual.manual._id,
        manualVersionId: activeManual.version._id,
        userTokenIdentifier: user.tokenIdentifier,
        question,
      },
    )

    await ctx.runMutation(internal.manuals.internalLogAnswer, {
      questionId,
      answerText,
      refusal,
      citations: answerCitations,
      model,
      latencyMs,
    })

    await ctx.runMutation(internal.manuals.internalWriteAuditEvent, {
      actorTokenIdentifier: user.tokenIdentifier,
      action: 'manual.ask_question',
      targetType: 'manual',
      targetId: activeManual.manual._id,
      metadata: {
        questionId,
        manualVersionId: activeManual.version._id,
        refusal: String(refusal),
      },
    })

    const chatRecord = await ctx.runMutation(
      internal.chats.internalRecordChatExchange,
      {
        chatSessionId: args.chatSessionId,
        userTokenIdentifier: user.tokenIdentifier,
        manualId: activeManual.manual._id,
        manualVersionId: activeManual.version._id,
        title: question,
        question,
        answerText,
        refusal,
        citations: answerCitations,
        model,
        latencyMs,
        sourceFileName: activeManual.version.sourceFileName,
      },
    )

    return {
      chatSessionId: chatRecord.chatSessionId,
      answerText,
      refusal,
      citations: answerCitations,
      latencyMs,
      model,
      manualTitle: activeManual.manual.title,
      sourceFileName: activeManual.version.sourceFileName,
    }
  },
})

type MultiManualQuestionResult = {
  chatSessionId: Id<'chatSessions'>
  answerText: string
  refusal: boolean
  citations: Array<{
    title?: string
    manualId?: string
    manualVersionId?: string
    sourceFileName?: string
    excerpt?: string
    pageNumber?: number
    providerUri?: string
  }>
  warning?: string
  effectiveManualIds: string[]
  effectiveManualVersionIds: string[]
  excludedManuals?: Array<{
    manualId: string
    manualVersionId?: string
    title?: string
    reason: string
  }>
  latencyMs: number
  model: string
}

type DebugProbeResult = {
  label: string
  metadataFilter: string | null
  ok: boolean
  errorMessage?: string
  rawAnswerPreview: string
  rawAnswerPresent: boolean
  refusal: boolean
  groundingChunksCount: number
  citationsCount: number
  sourceHints: Array<{
    title?: string
    uri?: string
    textPreview?: string
  }>
}

type RetrievalDebugState = {
  organization: {
    _id: Id<'organizations'>
    geminiFileSearchStoreNamePresent: boolean
    geminiFileSearchStoreName: string | null
    geminiFilterMode: 'or_syntax' | 'multi_entry' | null
  }
  manual: {
    _id: Id<'manuals'>
    title: string
    slug: string
    status: string
    organizationId: Id<'organizations'>
    visibility: 'org' | 'department' | 'restricted'
    departmentId: Id<'departments'> | null
    currentVersionId: Id<'manualVersions'> | null
  }
  manualVersion: {
    _id: Id<'manualVersions'>
    status: string
    providerMode: string
    sourceFileName: string
    organizationId: Id<'organizations'>
    visibility: 'org' | 'department' | 'restricted'
    departmentId: Id<'departments'> | null
    geminiFileSearchStoreNamePresent: boolean
    geminiFileSearchStoreName: string | null
    geminiDocumentName: string | null
    geminiFileName: string | null
    geminiDocumentNamePresent: boolean
    geminiFileNamePresent: boolean
  }
  latestJob: {
    _id: Id<'ingestionJobs'>
    status: string
    lastError: string | null
    geminiOperationNamePresent: boolean
    geminiOperationKind: 'upload_to_file_search_store' | 'import_file' | null
    geminiFileSearchStoreNamePresent: boolean
    geminiDocumentNamePresent: boolean
    geminiFileNamePresent: boolean
    storageDeletedAt: number | null
    attempts: number
    maxAttempts: number
  } | null
}

type DebugGeminiRetrievalResult = {
  safeState: unknown
  scopeDebug: unknown
  filterDebug: unknown
  probes: DebugProbeResult[]
  providerStoreProbe: unknown
  providerDocumentProbe: unknown
  productionPostProcessing: unknown
  interpretation: string
}

export const askMultiManualQuestion = action({
  args: {
    question: v.string(),
    chatSessionId: v.optional(v.id('chatSessions')),
    selectedManualIds: v.optional(v.array(v.id('manuals'))),
  },
  handler: async (ctx, args): Promise<MultiManualQuestionResult> => {
    const user = await ctx.runQuery(internal.users.internalRequireAllowedUser, {})
    const question = args.question.trim()
    if (!question) {
      throw new Error('Question is required')
    }

    let chatSessionId = args.chatSessionId
    let selectedManualVersionIds: Id<'manualVersions'>[]

    if (chatSessionId) {
      const lockedScope: {
        chatSessionId: Id<'chatSessions'>
        organizationId?: Id<'organizations'>
        selectedManualIds: Id<'manuals'>[]
        selectedManualVersionIds: Id<'manualVersions'>[]
      } = await ctx.runQuery(internal.chats.internalGetLockedScope, {
        chatSessionId,
        userTokenIdentifier: user.tokenIdentifier,
      })
      selectedManualVersionIds = lockedScope.selectedManualVersionIds
    } else {
      if (!args.selectedManualIds || args.selectedManualIds.length === 0) {
        throw new Error('Select at least one manual.')
      }
      const dedupedManualIds = [...new Set(args.selectedManualIds)]
      if (dedupedManualIds.length > 30) {
        throw new Error('Select at most 30 manuals.')
      }

      const orgId = await getOrgIdForUser(ctx)

      const lockResult: {
        chatSessionId: Id<'chatSessions'>
        selectedManualVersionIds: Id<'manualVersions'>[]
        resolvedVersions: Array<{
          manualId: Id<'manuals'>
          manualVersionId: Id<'manualVersions'>
          title: string
          sourceFileName: string
        }>
      } = await ctx.runMutation(internal.chats.internalLockChatScope, {
        userTokenIdentifier: user.tokenIdentifier,
        organizationId: orgId,
        selectedManualIds: dedupedManualIds,
        title: question,
      })

      chatSessionId = lockResult.chatSessionId
      selectedManualVersionIds = lockResult.selectedManualVersionIds
    }

    const scopeData: {
      effective: Array<{
        manualId: Id<'manuals'>
        manualVersionId: Id<'manualVersions'>
        title: string
        sourceFileName: string
        geminiFileName?: string
        geminiDocumentName?: string
        geminiFileSearchStoreName?: string
        providerMode: string
      }>
      excluded: Array<{
        manualId: string
        manualVersionId: string
        title?: string
        reason: string
      }>
      organizationId: Id<'organizations'>
      orgStoreName?: string
    } = await ctx.runQuery(internal.manuals.internalGetManualVersionsForScope, {
      manualVersionIds: selectedManualVersionIds,
      userTokenIdentifier: user.tokenIdentifier,
    })

    if (scopeData.effective.length === 0) {
      const errorResult: MultiManualQuestionResult = {
        chatSessionId: chatSessionId!,
        answerText: 'The manuals in this chat\'s scope are no longer available.',
        refusal: true,
        citations: [],
        effectiveManualIds: [],
        effectiveManualVersionIds: [],
        excludedManuals: scopeData.excluded,
        latencyMs: 0,
        model: '',
      }

      await ctx.runMutation(internal.chats.internalRecordMultiManualExchange, {
        chatSessionId: chatSessionId!,
        userTokenIdentifier: user.tokenIdentifier,
        title: question,
        question,
        answerText: errorResult.answerText,
        refusal: true,
        citations: [],
        warning: 'The manuals in this chat\'s scope are no longer available.',
        model: '',
        latencyMs: 0,
        sourceFileName: '',
      })

      return errorResult
    }

    const warning =
      scopeData.excluded.length > 0
        ? buildExcludedWarning(scopeData.excluded)
        : undefined

    const storeName = scopeData.orgStoreName
    if (!storeName) {
      throw new Error('Organization store is not configured.')
    }

    const model = process.env.GEMINI_DEFAULT_MODEL?.trim() || DEFAULT_MODEL
    const apiKey = readRequiredEnv('GEMINI_API_KEY')
    const ai = new GoogleGenAI({ apiKey })
    const startedAt = Date.now()

    const orgId = scopeData.organizationId
    const cachedFilterMode: string | null = await ctx.runQuery(
      internal.users.internalGetOrgFilterMode,
      { organizationId: orgId },
    )

    let response: Awaited<ReturnType<typeof ai.models.generateContent>>
    let usedFilterMode: 'or_syntax' | 'multi_entry'

    // OR mode: single filter expression, supports up to 30 manuals.
    // multi_entry mode: one tool entry per manual, capped at 20 until broader
    // counts are validated against the Gemini API.
    const MULTI_ENTRY_MAX = 20

    // Cached filter mode is a speed hint, not a guarantee. Gemini can reject OR
    // syntax after an API update. Always fall back to multi_entry on syntax
    // errors, and always try OR for selections that exceed multi_entry's cap.
    const effectiveCount = scopeData.effective.length
    const canUseMultiEntry = effectiveCount <= MULTI_ENTRY_MAX

    const tryOrFirst =
      cachedFilterMode !== 'multi_entry' || effectiveCount > MULTI_ENTRY_MAX

    if (tryOrFirst) {
      try {
        response = await callGeminiOrSyntax(ai, model, question, storeName, scopeData.effective)
        usedFilterMode = 'or_syntax'
        if (cachedFilterMode !== 'or_syntax') {
          await ctx.runMutation(internal.users.internalSetOrgFilterMode, {
            organizationId: orgId,
            geminiFilterMode: 'or_syntax',
          })
        }
      } catch (orError) {
        const errorMessage = orError instanceof Error ? orError.message : ''
        if (isFilterSyntaxError(errorMessage)) {
          if (!canUseMultiEntry) {
            throw new Error(
              `Please select ${MULTI_ENTRY_MAX} or fewer manuals and try again.`,
              { cause: orError },
            )
          }
          try {
            response = await callGeminiMultiEntry(ai, model, question, storeName, scopeData.effective)
            usedFilterMode = 'multi_entry'
            if (cachedFilterMode !== 'multi_entry') {
              await ctx.runMutation(internal.users.internalSetOrgFilterMode, {
                organizationId: orgId,
                geminiFilterMode: 'multi_entry',
              })
            }
          } catch (fallbackError) {
            throw new Error(
              'I could not search the selected manuals safely. Please try fewer manuals or try again.',
              { cause: fallbackError },
            )
          }
        } else {
          throw orError
        }
      }
    } else {
      // Org is cached to multi_entry and selection fits within its cap.
      try {
        response = await callGeminiMultiEntry(ai, model, question, storeName, scopeData.effective)
        usedFilterMode = 'multi_entry'
      } catch (multiEntryError) {
        throw new Error(
          'I could not search the selected manuals. Please try again.',
          { cause: multiEntryError },
        )
      }
    }

    const latencyMs = Date.now() - startedAt
    const rawCitations = normalizeMultiManualCitations(
      response.candidates?.[0]?.groundingMetadata,
      scopeData.effective,
    )
    const rawText = response.text?.trim() ?? ''
    const refusal = shouldRefuse(rawText)
    const answerText = refusal ? REFUSAL : rawText
    const answerCitations = refusal ? [] : rawCitations
    const citationWarning =
      !refusal && rawCitations.length === 0
        ? 'The answer was generated but no citation could be matched to a manual source.'
        : undefined
    const combinedWarning = warning && citationWarning
      ? `${warning} ${citationWarning}`
      : (warning ?? citationWarning)

    const effectiveManualIds = scopeData.effective.map((v) => v.manualId as string)
    const effectiveManualVersionIds = scopeData.effective.map(
      (v) => v.manualVersionId as string,
    )

    await ctx.runMutation(internal.chats.internalRecordMultiManualExchange, {
      chatSessionId: chatSessionId!,
      userTokenIdentifier: user.tokenIdentifier,
      title: question,
      question,
      answerText,
      refusal,
      citations: answerCitations,
      warning: combinedWarning,
      model,
      latencyMs,
      sourceFileName: scopeData.effective.map((v) => v.sourceFileName).join(', '),
    })

    await ctx.runMutation(internal.manuals.internalWriteAuditEvent, {
      actorTokenIdentifier: user.tokenIdentifier,
      action: 'manual.ask_multi_manual_question',
      targetType: 'chatSession',
      targetId: chatSessionId,
      metadata: {
        effectiveManualIds: effectiveManualIds.join(','),
        filterMode: usedFilterMode,
        refusal: String(refusal),
      },
    })

    return {
      chatSessionId: chatSessionId!,
      answerText,
      refusal,
      citations: answerCitations,
      warning: combinedWarning,
      effectiveManualIds,
      effectiveManualVersionIds,
      excludedManuals: scopeData.excluded.length > 0 ? scopeData.excluded : undefined,
      latencyMs,
      model,
    }
  },
})

const TITLE_GENERATION_PROMPT = (question: string, answer: string) => `Create a short sidebar title for this chat.

Rules:
- 3 to 6 words
- clear and specific
- no quotes
- no markdown
- no trailing punctuation
- title case
- do not include the words "chat" or "manual"
- describe the user's actual topic
- return only the title

User question:
${question}

Assistant answer:
${answer}`

export const internalGenerateChatTitle = internalAction({
  args: {
    chatSessionId: v.id('chatSessions'),
    question: v.string(),
    answerText: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY?.trim()
      if (!apiKey) return

      const model =
        process.env.CHAT_TITLE_MODEL?.trim() || 'gemini-2.5-flash'

      const ai = new GoogleGenAI({ apiKey })
      const prompt = TITLE_GENERATION_PROMPT(
        args.question.slice(0, 600),
        args.answerText.slice(0, 800),
      )

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: { temperature: 0.4, maxOutputTokens: 32 },
      })

      const raw = response.text?.trim() ?? ''
      if (raw) {
        await ctx.runMutation(internal.chats.internalUpdateChatTitle, {
          chatSessionId: args.chatSessionId,
          title: raw,
        })
      }
    } catch {
      // Title generation failure must never surface to the user.
    }
  },
})

export const backfillChatTitles = action({
  args: {
    batchSize: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<{
    processed: number
    updated: number
    isDone: boolean
    continueCursor: string | null
  }> => {
    await requireAdmin(ctx)

    const apiKey = process.env.GEMINI_API_KEY?.trim()
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured.')

    const model = process.env.CHAT_TITLE_MODEL?.trim() || 'gemini-2.5-flash'
    const batchSize = Math.min(args.batchSize ?? 50, 100)
    const cursor = args.cursor ?? null

    const { candidates, isDone, continueCursor } = await ctx.runQuery(
      internal.chats.internalListBackfillCandidates,
      { cursor, batchSize },
    )

    const ai = new GoogleGenAI({ apiKey })
    let updated = 0

    for (const candidate of candidates) {
      try {
        const prompt = TITLE_GENERATION_PROMPT(
          candidate.question.slice(0, 600),
          candidate.answerText.slice(0, 800),
        )
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { temperature: 0.4, maxOutputTokens: 32 },
        })
        const raw = response.text?.trim() ?? ''
        if (raw) {
          await ctx.runMutation(internal.chats.internalUpdateChatTitle, {
            chatSessionId: candidate.chatSessionId,
            title: raw,
          })
          updated++
        }
      } catch {
        // Skip this session and continue with the rest.
      }
    }

    return {
      processed: candidates.length,
      updated,
      isDone,
      continueCursor: isDone ? null : continueCursor,
    }
  },
})

export const debugGeminiRetrievalForManual = action({
  args: {
    manualId: v.optional(v.id('manuals')),
    manualVersionId: v.optional(v.id('manualVersions')),
    testQuestion: v.string(),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<DebugGeminiRetrievalResult> => {
    const admin = await requireAdmin(ctx)
    const question = args.testQuestion.trim()
    if (!question) {
      throw new Error('Test question is required.')
    }
    if (!args.manualId && !args.manualVersionId) {
      throw new Error('Provide manualId or manualVersionId.')
    }

    const debugState: RetrievalDebugState = await ctx.runQuery(
      internal.manuals.internalGetRetrievalDebugState,
      {
        manualId: args.manualId,
        manualVersionId: args.manualVersionId,
      },
    )

    const scopeData: {
      effective: EffectiveVersion[]
      excluded: Array<{
        manualId: string
        manualVersionId: string
        title?: string
        reason: string
      }>
      organizationId: Id<'organizations'>
      orgStoreName?: string
    } = await ctx.runQuery(internal.manuals.internalGetManualVersionsForScope, {
      manualVersionIds: [debugState.manualVersion._id],
      userTokenIdentifier: admin.tokenIdentifier,
    })

    const storeName =
      debugState.manualVersion.providerMode === 'shared_org_store'
        ? debugState.organization.geminiFileSearchStoreName
        : debugState.manualVersion.geminiFileSearchStoreName

    const effectiveVersion = scopeData.effective[0] ?? {
      manualId: debugState.manual._id,
      manualVersionId: debugState.manualVersion._id,
      title: debugState.manual.title,
      sourceFileName: debugState.manualVersion.sourceFileName,
      providerMode: debugState.manualVersion.providerMode,
    }

    const model = args.model?.trim() || process.env.GEMINI_DEFAULT_MODEL?.trim() || DEFAULT_MODEL
    const apiKey = readRequiredEnv('GEMINI_API_KEY')
    const ai = new GoogleGenAI({ apiKey })
    const cachedFilterMode = debugState.organization.geminiFilterMode
    const orFilter = buildOrSyntaxMetadataFilter([effectiveVersion])
    const legacyCamelFilter = `manualVersionId="${effectiveVersion.manualVersionId}"`
    const unquotedFilter = `manualVersionId=${effectiveVersion.manualVersionId}`
    const multiEntryFilters = buildMultiEntryMetadataFilters([effectiveVersion])
    const productionFilterMode =
      cachedFilterMode === 'multi_entry' ? 'multi_entry' : 'or_syntax'

    const probes: DebugProbeResult[] = []
    const providerStoreProbe = storeName
      ? await runProviderStoreProbe(
          ai,
          storeName,
          normalizeGeminiDocumentName(
            storeName,
            debugState.manualVersion.geminiDocumentName ?? undefined,
          ) ?? null,
        )
      : {
          ok: false,
          errorMessage: 'No File Search store name is available for this provider mode.',
          storeNamePresent: false,
        }
    const providerDocumentProbe = await runProviderDocumentProbe(
      ai,
      normalizeGeminiDocumentName(
        storeName ?? undefined,
        debugState.manualVersion.geminiDocumentName ?? undefined,
      ) ?? null,
      {
        manualId: debugState.manual._id,
        manualVersionId: debugState.manualVersion._id,
        organizationId: debugState.manual.organizationId,
      },
    )

    if (!storeName) {
      probes.push({
        label: 'store-unavailable',
        metadataFilter: null,
        ok: false,
        errorMessage: 'No File Search store name is available for this provider mode.',
        rawAnswerPreview: '',
        rawAnswerPresent: false,
        refusal: true,
        groundingChunksCount: 0,
        citationsCount: 0,
        sourceHints: [],
      })
    } else {
      probes.push(
        await runGeminiRetrievalProbe({
          ai,
          model,
          question,
          storeName,
          label: 'A: shared/selected store without metadataFilter',
          metadataFilter: null,
          versions: [effectiveVersion],
        }),
      )
      probes.push(
        await runGeminiRetrievalProbe({
          ai,
          model,
          question,
          storeName,
          label: 'B0: legacy camelCase manualVersionId metadataFilter',
          metadataFilter: legacyCamelFilter,
          versions: [effectiveVersion],
        }),
      )
      probes.push(
        await runGeminiRetrievalProbe({
          ai,
          model,
          question,
          storeName,
          label: 'B2: unquoted manualVersionId metadataFilter',
          metadataFilter: unquotedFilter,
          versions: [effectiveVersion],
        }),
      )
      probes.push(
        await runGeminiRetrievalProbe({
          ai,
          model,
          question,
          storeName,
          label: 'B: simple manualVersionId metadataFilter',
          metadataFilter: orFilter,
          versions: [effectiveVersion],
        }),
      )
      probes.push(
        await runGeminiRetrievalProbe({
          ai,
          model,
          question,
          storeName,
          label: `C: production filter mode (${productionFilterMode})`,
          metadataFilter:
            productionFilterMode === 'multi_entry' ? multiEntryFilters : orFilter,
          versions: [effectiveVersion],
        }),
      )
      probes.push(
        await runGeminiRetrievalProbe({
          ai,
          model,
          question,
          storeName,
          label:
            productionFilterMode === 'multi_entry'
              ? 'D: alternate or_syntax filter mode'
              : 'D: alternate multi_entry filter mode',
          metadataFilter:
            productionFilterMode === 'multi_entry' ? orFilter : multiEntryFilters,
          versions: [effectiveVersion],
        }),
      )
    }

    const productionProbe = probes.find((probe) =>
      probe.label.startsWith('C:'),
    )

    return {
      safeState: {
        manualId: debugState.manual._id,
        manualTitle: debugState.manual.title,
        manualStatus: debugState.manual.status,
        manualOrganizationId: debugState.manual.organizationId,
        manualVisibility: debugState.manual.visibility,
        manualDepartmentId: debugState.manual.departmentId,
        manualVersionId: debugState.manualVersion._id,
        manualVersionStatus: debugState.manualVersion.status,
        providerMode: debugState.manualVersion.providerMode,
        manualVersionStorePresent:
          debugState.manualVersion.geminiFileSearchStoreNamePresent,
        manualVersionDocumentPresent:
          debugState.manualVersion.geminiDocumentNamePresent,
        manualVersionFilePresent: debugState.manualVersion.geminiFileNamePresent,
        organizationStorePresent:
          debugState.organization.geminiFileSearchStoreNamePresent,
        latestIngestionJob: debugState.latestJob
          ? {
              status: debugState.latestJob.status,
              lastError: debugState.latestJob.lastError,
              geminiOperationNamePresent:
                debugState.latestJob.geminiOperationNamePresent,
              geminiOperationKind: debugState.latestJob.geminiOperationKind,
              geminiFileSearchStoreNamePresent:
                debugState.latestJob.geminiFileSearchStoreNamePresent,
              geminiDocumentNamePresent:
                debugState.latestJob.geminiDocumentNamePresent,
              geminiFileNamePresent: debugState.latestJob.geminiFileNamePresent,
              storageDeletedAt: debugState.latestJob.storageDeletedAt,
              attempts: debugState.latestJob.attempts,
              maxAttempts: debugState.latestJob.maxAttempts,
            }
          : null,
      },
      scopeDebug: {
        selectedManualIds: [debugState.manual._id],
        lockedSelectedManualVersionIds: [debugState.manualVersion._id],
        effectiveManualVersionIds: scopeData.effective.map(
          (v) => v.manualVersionId,
        ),
        effectiveManualIds: scopeData.effective.map((v) => v.manualId),
        excludedManuals: scopeData.excluded,
      },
      filterDebug: {
        cachedFilterMode,
        productionFilterMode,
        orSyntaxMetadataFilter: orFilter,
        legacyCamelMetadataFilter: legacyCamelFilter,
        unquotedMetadataFilter: unquotedFilter,
        multiEntryMetadataFilters: multiEntryFilters,
      },
      probes,
      providerStoreProbe,
      providerDocumentProbe,
      productionPostProcessing: productionProbe
        ? {
            rawAnswerPresent: productionProbe.rawAnswerPresent,
            rawAnswerPreview: productionProbe.rawAnswerPreview,
            shouldRefuseResult: productionProbe.refusal,
            finalAnswerPreview: productionProbe.refusal
              ? REFUSAL
              : productionProbe.rawAnswerPreview,
            citationsCount: productionProbe.citationsCount,
            groundingChunksCount: productionProbe.groundingChunksCount,
          }
        : null,
      interpretation: interpretRetrievalProbes(probes),
    }
  },
})

async function getOrgIdForUser(ctx: ActionCtx): Promise<Id<'organizations'>> {
  const orgId: Id<'organizations'> | null = await ctx.runQuery(
    internal.users.internalGetDefaultOrgId,
    {},
  )
  if (!orgId) {
    throw new Error('Organization not configured.')
  }
  return orgId
}

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

async function callGeminiOrSyntax(
  ai: GoogleGenAI,
  model: string,
  question: string,
  storeName: string,
  versions: EffectiveVersion[],
) {
  const metadataFilter = buildOrSyntaxMetadataFilter(versions)

  return await ai.models.generateContent({
    model,
    contents: question,
    config: {
      systemInstruction: MANUAL_ONLY_INSTRUCTION,
      temperature: 0,
      tools: [
        {
          fileSearch: {
            fileSearchStoreNames: [storeName],
            metadataFilter,
          },
        },
      ],
    },
  })
}

async function callGeminiMultiEntry(
  ai: GoogleGenAI,
  model: string,
  question: string,
  storeName: string,
  versions: EffectiveVersion[],
) {
  const tools = buildMultiEntryMetadataFilters(versions).map((metadataFilter) => ({
    fileSearch: {
      fileSearchStoreNames: [storeName],
      metadataFilter,
    },
  }))

  return await ai.models.generateContent({
    model,
    contents: question,
    config: {
      systemInstruction: MANUAL_ONLY_INSTRUCTION,
      temperature: 0,
      tools,
    },
  })
}

function buildOrSyntaxMetadataFilter(versions: EffectiveVersion[]): string {
  const filterParts = versions.map(
    (v) => `manual_version_id="${v.manualVersionId}"`,
  )
  return filterParts.length === 1
    ? filterParts[0]
    : filterParts.join(' OR ')
}

function buildMultiEntryMetadataFilters(versions: EffectiveVersion[]): string[] {
  return versions.map((v) => `manual_version_id="${v.manualVersionId}"`)
}

async function runProviderStoreProbe(
  ai: GoogleGenAI,
  storeName: string,
  expectedDocumentName: string | null,
) {
  try {
    const store = await ai.fileSearchStores.get({ name: storeName })
    const record = isRecord(store) ? store : {}
    const listedDocuments = []
    let expectedDocumentListed = false
    const documents = await ai.fileSearchStores.documents.list({
      parent: storeName,
      config: { pageSize: 20 },
    })

    for await (const document of documents) {
      const doc = isRecord(document) ? document : {}
      const name = getString(doc.name) ?? ''
      if (expectedDocumentName && name === expectedDocumentName) {
        expectedDocumentListed = true
      }
      listedDocuments.push({
        nameMatchesExpected: Boolean(expectedDocumentName && name === expectedDocumentName),
        displayName: getString(doc.displayName) ?? null,
        state: getString(doc.state) ?? null,
        metadataKeys: Array.isArray(doc.customMetadata)
          ? doc.customMetadata
              .map((entry) => isRecord(entry) ? getString(entry.key) : undefined)
              .filter((key): key is string => Boolean(key))
          : [],
      })
      if (listedDocuments.length >= 20) break
    }

    return {
      ok: true,
      storeNamePresent: true,
      displayName: getString(record.displayName) ?? null,
      activeDocumentsCount: getNumber(record.activeDocumentsCount) ?? null,
      pendingDocumentsCount: getNumber(record.pendingDocumentsCount) ?? null,
      failedDocumentsCount: getNumber(record.failedDocumentsCount) ?? null,
      embeddingModel: getString(record.embeddingModel) ?? null,
      expectedDocumentListed,
      listedDocuments,
      keys: Object.keys(record).sort(),
    }
  } catch (error) {
    return {
      ok: false,
      storeNamePresent: true,
      errorMessage:
        error instanceof Error ? error.message : 'Unknown provider store probe error',
    }
  }
}

async function runProviderDocumentProbe(
  ai: GoogleGenAI,
  documentName: string | null,
  expectedMetadata?: {
    manualId: Id<'manuals'>
    manualVersionId: Id<'manualVersions'>
    organizationId: Id<'organizations'>
  },
) {
  if (!documentName) {
    return {
      ok: false,
      errorMessage: 'No Gemini document name is stored for this manual version.',
      documentNamePresent: false,
    }
  }

  try {
    const document = await ai.fileSearchStores.documents.get({ name: documentName })
    const doc = isRecord(document) ? document : {}
    const metadata = Array.isArray(doc.customMetadata)
      ? doc.customMetadata
          .map((entry) => {
            if (!isRecord(entry)) return null
            const key = getString(entry.key)
            if (!key) return null
            const value = getString(entry.stringValue)
            return {
              key,
              value:
                key === 'status' ||
                key === 'visibility' ||
                key === 'departmentId'
                  ? value
                  : value
                    ? '[redacted]'
                    : undefined,
            }
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      : []
    const metadataMatches = expectedMetadata && Array.isArray(doc.customMetadata)
      ? {
          organizationId: metadataValueMatches(
            doc.customMetadata,
            'organizationId',
            expectedMetadata.organizationId,
          ),
          organization_id: metadataValueMatches(
            doc.customMetadata,
            'organization_id',
            expectedMetadata.organizationId,
          ),
          manualId: metadataValueMatches(
            doc.customMetadata,
            'manualId',
            expectedMetadata.manualId,
          ),
          manual_id: metadataValueMatches(
            doc.customMetadata,
            'manual_id',
            expectedMetadata.manualId,
          ),
          manualVersionId: metadataValueMatches(
            doc.customMetadata,
            'manualVersionId',
            expectedMetadata.manualVersionId,
          ),
          manual_version_id: metadataValueMatches(
            doc.customMetadata,
            'manual_version_id',
            expectedMetadata.manualVersionId,
          ),
        }
      : null

    return {
      ok: true,
      documentNamePresent: true,
      providerState:
        getString(doc.state) ??
        getString(doc.status) ??
        getString(doc.documentStatus) ??
        null,
      displayName: getString(doc.displayName) ?? null,
      sizeBytes: getNumber(doc.sizeBytes) ?? null,
      metadataMatches,
      metadata,
      keys: Object.keys(doc).sort(),
    }
  } catch (error) {
    return {
      ok: false,
      documentNamePresent: true,
      errorMessage:
        error instanceof Error ? error.message : 'Unknown provider document probe error',
    }
  }
}

function metadataValueMatches(
  metadata: unknown[],
  key: string,
  expectedValue: string,
): boolean {
  for (const entry of metadata) {
    if (!isRecord(entry)) continue
    if (getString(entry.key) !== key) continue
    return getString(entry.stringValue) === expectedValue
  }
  return false
}

function normalizeGeminiDocumentName(
  storeName: string | undefined,
  documentName: string | undefined,
): string | undefined {
  if (!documentName) return undefined
  if (documentName.startsWith('fileSearchStores/')) return documentName
  if (!storeName) return documentName
  return `${storeName}/documents/${documentName}`
}

async function runGeminiRetrievalProbe(args: {
  ai: GoogleGenAI
  model: string
  question: string
  storeName: string
  label: string
  metadataFilter: string | string[] | null
  versions: EffectiveVersion[]
}): Promise<DebugProbeResult> {
  try {
    const tools = Array.isArray(args.metadataFilter)
      ? args.metadataFilter.map((metadataFilter) => ({
          fileSearch: {
            fileSearchStoreNames: [args.storeName],
            metadataFilter,
          },
        }))
      : [
          {
            fileSearch: args.metadataFilter
              ? {
                  fileSearchStoreNames: [args.storeName],
                  metadataFilter: args.metadataFilter,
                }
              : {
                  fileSearchStoreNames: [args.storeName],
                },
          },
        ]

    const response = await args.ai.models.generateContent({
      model: args.model,
      contents: args.question,
      config: {
        systemInstruction: MANUAL_ONLY_INSTRUCTION,
        temperature: 0,
        tools,
      },
    })

    const rawAnswer = response.text?.trim() ?? ''
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata
    const citations = normalizeMultiManualCitations(groundingMetadata, args.versions)
    const sourceHints = getGroundingSourceHints(groundingMetadata)

    return {
      label: args.label,
      metadataFilter: Array.isArray(args.metadataFilter)
        ? args.metadataFilter.join(' | ')
        : args.metadataFilter,
      ok: true,
      rawAnswerPreview: truncate(rawAnswer, 600) ?? '',
      rawAnswerPresent: rawAnswer.length > 0,
      refusal: shouldRefuse(rawAnswer),
      groundingChunksCount: sourceHints.length,
      citationsCount: citations.length,
      sourceHints,
    }
  } catch (error) {
    return {
      label: args.label,
      metadataFilter: Array.isArray(args.metadataFilter)
        ? args.metadataFilter.join(' | ')
        : args.metadataFilter,
      ok: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown Gemini probe error',
      rawAnswerPreview: '',
      rawAnswerPresent: false,
      refusal: true,
      groundingChunksCount: 0,
      citationsCount: 0,
      sourceHints: [],
    }
  }
}

function getGroundingSourceHints(
  groundingMetadata: unknown,
): DebugProbeResult['sourceHints'] {
  if (!isRecord(groundingMetadata)) return []
  const chunks = groundingMetadata.groundingChunks
  if (!Array.isArray(chunks)) return []

  return chunks
    .map((chunk) => {
      if (!isRecord(chunk) || !isRecord(chunk.retrievedContext)) return null
      const rc = chunk.retrievedContext
      return {
        title: getString(rc.title),
        uri: truncate(getString(rc.uri), 160),
        textPreview: truncate(getString(rc.text), 220),
      }
    })
    .filter((hint): hint is NonNullable<typeof hint> => hint !== null)
    .slice(0, 5)
}

function interpretRetrievalProbes(probes: DebugProbeResult[]): string {
  const noFilter = probes.find((probe) => probe.label.startsWith('A:'))
  const simpleFilter = probes.find((probe) => probe.label.startsWith('B:'))
  const production = probes.find((probe) => probe.label.startsWith('C:'))

  if (!noFilter?.ok) {
    return 'Probe A failed: the store/tool call failed before metadata filtering. Check ingestion, indexing status, store name, or Gemini File Search tool configuration.'
  }
  if (noFilter.refusal || noFilter.groundingChunksCount === 0) {
    return 'Probe A returned no grounded answer: Gemini is not retrieving chunks even without metadata filtering. Check whether the document was indexed into the selected store.'
  }
  if (!simpleFilter?.ok || simpleFilter.refusal || simpleFilter.groundingChunksCount === 0) {
    return 'Probe A succeeded but Probe B failed: the manualVersionId metadata filter likely does not match uploaded document metadata or the filter syntax is wrong.'
  }
  if (!production?.ok || production.refusal || production.groundingChunksCount === 0) {
    return 'Probe B succeeded but production mode failed: the production filter mode, scope resolution, or post-processing path is the likely bug.'
  }
  return 'Retrieval probes found grounded answers. If the UI still refuses, inspect frontend display or chat-session scope selection.'
}

function buildExcludedWarning(
  excluded: Array<{ manualId: string; title?: string; reason: string }>,
): string {
  const reasonLabels: Record<string, string> = {
    archived: 'archived',
    failed: 'unavailable',
    unauthorized: 'access removed',
    missing: 'not found',
    unsupported_provider_mode: 'incompatible',
  }
  const details = excluded
    .map((e) => `${e.title ?? 'Unknown'} — ${reasonLabels[e.reason] ?? e.reason}`)
    .join('; ')
  return `Some manuals in this chat are no longer available and were excluded. Excluded: ${details}.`
}

function isFilterSyntaxError(message: string): boolean {
  const lower = message.toLowerCase()
  const transientPatterns = [
    'timeout',
    'rate limit',
    'quota',
    'overloaded',
    'unavailable',
    'deadline exceeded',
    'internal error',
    'connection',
    'network',
    '503',
    '429',
    '500',
    'unauthorized',
    '401',
    '403',
  ]
  if (transientPatterns.some((p) => lower.includes(p))) {
    return false
  }

  return (
    (lower.includes('metadata') && lower.includes('filter')) ||
    (lower.includes('metadatafilter') && (lower.includes('syntax') || lower.includes('invalid') || lower.includes('unsupported'))) ||
    (lower.includes('operator') && (lower.includes('unsupported') || lower.includes('invalid'))) ||
    lower.includes('tool_config') ||
    (lower.includes('tool config') && lower.includes('invalid'))
  )
}

function normalizeMultiManualCitations(
  groundingMetadata: unknown,
  versions: EffectiveVersion[],
): MultiManualQuestionResult['citations'] {
  if (!isRecord(groundingMetadata)) return []
  const chunks = groundingMetadata.groundingChunks
  if (!Array.isArray(chunks)) return []

  // Keys are ordered by specificity: geminiFileName/geminiDocumentName are unique
  // provider IDs; sourceFileName is a user-controlled string that may collide across
  // manuals (e.g. two uploads both named "manual.pdf"), so it is only added when
  // no more specific key already covers this version.
  const versionLookup = new Map<string, EffectiveVersion>()
  for (const v of versions) {
    if (v.geminiFileName) versionLookup.set(v.geminiFileName, v)
    if (v.geminiDocumentName) versionLookup.set(v.geminiDocumentName, v)
  }
  for (const v of versions) {
    if (v.sourceFileName && !versionLookup.has(v.sourceFileName)) {
      versionLookup.set(v.sourceFileName, v)
    }
  }

  return chunks
    .map((chunk) => {
      if (!isRecord(chunk) || !isRecord(chunk.retrievedContext)) return null
      const rc = chunk.retrievedContext

      const uri = getString(rc.uri)
      const title = getString(rc.title)
      const excerpt = truncate(getString(rc.text), 280)
      const pageNumber = getNumber(rc.pageNumber)

      let matched: EffectiveVersion | undefined
      const providerValues = [uri, title].filter(
        (value): value is string => Boolean(value),
      )
      for (const providerValue of providerValues) {
        matched = versionLookup.get(providerValue)
        if (!matched) {
          for (const [key, ver] of versionLookup) {
            if (providerValue.includes(key) || key.includes(providerValue)) {
              matched = ver
              break
            }
          }
        }
        if (matched) break
      }
      if (!matched && title) {
        for (const ver of versions) {
          if (ver.sourceFileName === title || ver.title === title) {
            matched = ver
            break
          }
        }
      }

      return {
        title: matched?.sourceFileName ?? title ?? 'Unknown source',
        manualId: matched?.manualId as string | undefined,
        manualVersionId: matched?.manualVersionId as string | undefined,
        sourceFileName: matched?.sourceFileName,
        excerpt,
        pageNumber,
        providerUri: uri,
      }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .slice(0, 10)
}

async function importBlobIntoSharedStore(
  ai: GoogleGenAI,
  args: {
    storeName: string
    file: Blob
    displayName: string
    mimeType?: string
    customMetadata: GeminiCustomMetadata
  },
): Promise<{
  operation: ImportFileOperation
  fileName: string
}> {
  const uploadedFile = await ai.files.upload({
    file: args.file,
    config: {
      displayName: args.displayName,
      mimeType: args.mimeType,
    },
  })

  if (!uploadedFile.name) {
    throw new Error('Gemini Files API did not return a file name.')
  }

  const operation = await ai.fileSearchStores.importFile({
    fileSearchStoreName: args.storeName,
    fileName: uploadedFile.name,
    config: {
      customMetadata: args.customMetadata,
    },
  })

  return {
    operation,
    fileName: uploadedFile.name,
  }
}

async function getFileSearchOperation(
  ai: GoogleGenAI,
  args: {
    name: string
    kind: 'upload_to_file_search_store' | 'import_file'
  },
): Promise<FileSearchIngestionOperation> {
  if (args.kind === 'import_file') {
    const operationRequest = new ImportFileOperation()
    operationRequest.name = args.name
    return (await ai.operations.get({
      operation: operationRequest,
    })) as ImportFileOperation
  }

  const operationRequest = new UploadToFileSearchStoreOperation()
  operationRequest.name = args.name
  return (await ai.operations.get({
    operation: operationRequest,
  })) as UploadToFileSearchStoreOperation
}

async function waitForOperation(
  ai: GoogleGenAI,
  operation: FileSearchIngestionOperation,
): Promise<FileSearchIngestionOperation> {
  let current = operation

  for (let attempts = 0; attempts < INDEXING_MAX_ATTEMPTS; attempts += 1) {
    if (current.done) {
      if (current.error) {
        throw new Error(`Gemini File Search indexing failed: ${JSON.stringify(current.error)}`)
      }
      return current
    }

    await new Promise((resolve) => setTimeout(resolve, INDEXING_POLL_INTERVAL_MS))
    if (!current.name) {
      throw new Error('Gemini File Search operation did not include an operation name.')
    }

    current = await getFileSearchOperation(ai, {
      name: current.name,
      kind: current instanceof ImportFileOperation
        ? 'import_file'
        : 'upload_to_file_search_store',
    })
  }

  throw new Error(
    `Timed out waiting for Gemini File Search indexing after ${Math.round(
      (INDEXING_MAX_ATTEMPTS * INDEXING_POLL_INTERVAL_MS) / 1000,
    )} seconds. Operation: ${current.name ?? 'unknown'}`,
  )
}

function normalizeCitations(groundingMetadata: unknown): Citation[] {
  if (!isRecord(groundingMetadata)) return []
  const chunks = groundingMetadata.groundingChunks
  if (!Array.isArray(chunks)) return []

  return chunks
    .map((chunk): Citation | null => {
      if (!isRecord(chunk) || !isRecord(chunk.retrievedContext)) return null
      const retrievedContext = chunk.retrievedContext

      return {
        title: getString(retrievedContext.title),
        uri: getString(retrievedContext.uri),
        pageNumber: getNumber(retrievedContext.pageNumber),
        excerpt: truncate(getString(retrievedContext.text), 280),
        fileSearchStore: getString(retrievedContext.fileSearchStore),
      }
    })
    .filter((citation): citation is Citation => citation !== null)
    .slice(0, 5)
}

function shouldRefuse(answerText: string): boolean {
  const normalized = answerText.trim()
  if (!normalized) return true
  if (normalized === REFUSAL) return true
  if (/^I could not find this in the manual\.?$/i.test(normalized)) return true
  if (/\b(could not|cannot|can't|not able to)\s+find\s+(this|that|it|the answer|an answer|information|any information)\b/i.test(normalized)) {
    return true
  }
  return false
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not configured in Convex environment variables.`)
  }
  return value
}

function validateManualUpload(args: {
  title: string
  sourceFileName: string
  mimeType: string
  sizeBytes: number
}) {
  const title = args.title.trim()
  const sourceFileName = args.sourceFileName.trim()
  const mimeType = normalizeMimeType(args.mimeType, sourceFileName)
  const extension = getFileExtension(sourceFileName)
  const maxSizeBytes = 25 * 1024 * 1024

  if (!title) {
    throw new Error('Manual title is required.')
  }

  if (!sourceFileName) {
    throw new Error('Manual file name is required.')
  }

  if (!['pdf', 'txt', 'md', 'docx'].includes(extension)) {
    throw new Error('Only PDF, TXT, MD, and DOCX manuals are supported.')
  }

  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (
    (extension === 'pdf' && mimeType !== 'application/pdf') ||
    (extension === 'txt' && mimeType !== 'text/plain') ||
    (extension === 'md' && !['text/markdown', 'text/plain'].includes(mimeType)) ||
    (extension === 'docx' && mimeType !== DOCX_MIME)
  ) {
    throw new Error('Manual file type does not match the selected file extension.')
  }
  // TODO: If direct DOCX retrieval quality is poor, add a server-side Mammoth
  // extraction fallback: DOCX → extract raw text → upload extracted TXT to Gemini.

  if (!Number.isFinite(args.sizeBytes) || args.sizeBytes <= 0) {
    throw new Error('Manual file is empty.')
  }

  if (args.sizeBytes > maxSizeBytes) {
    throw new Error('Manual file must be 25 MB or smaller for Phase 2A.')
  }

  return {
    title,
    sourceFileName,
    mimeType,
    sizeBytes: args.sizeBytes,
  }
}

function normalizeMimeType(mimeType: string, sourceFileName: string): string {
  const normalized = mimeType.trim().toLowerCase()
  if (normalized) return normalized

  const extension = getFileExtension(sourceFileName)
  if (extension === 'pdf') return 'application/pdf'
  if (extension === 'md') return 'text/markdown'
  if (extension === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return 'text/plain'
}

function getFileExtension(sourceFileName: string): string {
  const index = sourceFileName.lastIndexOf('.')
  return index === -1 ? '' : sourceFileName.slice(index + 1).toLowerCase()
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

  return slug || `manual-${Date.now()}`
}

async function deleteTemporaryUpload(
  ctx: ActionCtx,
  storageId: Id<'_storage'>,
  ingestionJobId?: Id<'ingestionJobs'>,
) {
  try {
    await ctx.storage.delete(storageId)
    if (ingestionJobId) {
      await ctx.runMutation(internal.ingestionJobs.internalMarkStorageDeleted, {
        ingestionJobId,
      })
    }
  } catch (error) {
    console.warn(
      `Unable to delete temporary uploaded manual ${storageId}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    )
  }
}

function extractStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  return getString(value[key])
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
