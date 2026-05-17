'use node'

import { GoogleGenAI, type UploadToFileSearchStoreOperation } from '@google/genai'
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

const DEFAULT_MODEL = 'gemini-2.5-flash-lite'
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
}

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
    const manualId: Id<'manuals'> = await ctx.runMutation(
      internal.manuals.internalCreateManualIfMissing,
      {
        title: DUMMY_MANUAL_TITLE,
        slug: DUMMY_MANUAL_SLUG,
        actorTokenIdentifier: admin.tokenIdentifier,
      },
    )

    let manualVersionId: Id<'manualVersions'> | null = null

    try {
      const fileSearchStore = await ai.fileSearchStores.create({
        config: {
          displayName: `${DUMMY_MANUAL_TITLE} ${Date.now()}`,
        },
      })

      if (!fileSearchStore.name) {
        throw new Error('Gemini did not return a File Search store name.')
      }

      manualVersionId = await ctx.runMutation(
        internal.manuals.internalCreateManualVersion,
        {
          manualId,
          versionLabel: 'v1',
          sourceFileName: DUMMY_MANUAL_FILE_NAME,
          provider: 'gemini_file_search',
          geminiFileSearchStoreName: fileSearchStore.name,
          mimeType: 'text/plain',
          sizeBytes: DUMMY_MANUAL_CONTENT.length,
          status: 'indexing',
          actorTokenIdentifier: admin.tokenIdentifier,
        },
      )

      let operation = await ai.fileSearchStores.uploadToFileSearchStore({
        fileSearchStoreName: fileSearchStore.name,
        file: new Blob([DUMMY_MANUAL_CONTENT], { type: 'text/plain' }),
        config: {
          displayName: DUMMY_MANUAL_FILE_NAME,
          mimeType: 'text/plain',
          customMetadata: [
            { key: 'manual_slug', stringValue: DUMMY_MANUAL_SLUG },
            { key: 'manual_version', stringValue: 'v1' },
          ],
        },
      })

      operation = await waitForOperation(ai, operation)

      const documentName = extractStringField(operation.response, 'documentName')
      const fileName = extractStringField(operation.response, 'fileName')

      await ctx.runMutation(internal.manuals.internalMarkManualVersionActive, {
        manualId,
        manualVersionId,
        geminiFileSearchDocumentName: documentName,
        geminiFileName: fileName,
      })

      await ctx.runMutation(internal.manuals.internalWriteAuditEvent, {
        actorTokenIdentifier: admin.tokenIdentifier,
        action: 'manual.ingest_dummy',
        targetType: 'manual',
        targetId: manualId,
        metadata: {
          manualVersionId,
          geminiFileSearchStoreName: fileSearchStore.name,
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
        geminiFileSearchStoreName: fileSearchStore.name,
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
            { key: 'visibility', stringValue: manualVersion.visibility ?? 'org' },
            {
              key: 'departmentId',
              stringValue:
                manualVersion.visibility === 'department' && manualVersion.departmentId
                  ? manualVersion.departmentId
                  : 'org',
            },
            { key: 'manualId', stringValue: manual._id },
            { key: 'manualVersionId', stringValue: manualVersion._id },
            { key: 'status', stringValue: 'active' },
          ]
        : [
            { key: 'manual_slug', stringValue: manual.slug },
            { key: 'manual_version', stringValue: manualVersion.versionLabel },
            { key: 'source_file_name', stringValue: manualVersion.sourceFileName },
          ]

      const operation = await ai.fileSearchStores.uploadToFileSearchStore({
        fileSearchStoreName: storeName,
        file: fileBlob,
        config: {
          displayName: manualVersion.sourceFileName,
          mimeType: manualVersion.mimeType,
          customMetadata,
        },
      })
      const documentName = extractStringField(operation.response, 'documentName')
      const fileName = extractStringField(operation.response, 'fileName')
      const nextPollAt = Date.now() + INDEXING_POLL_INTERVAL_MS

      await ctx.runMutation(internal.ingestionJobs.internalMarkIndexing, {
        ingestionJobId: job._id,
        manualVersionId: manualVersion._id,
        geminiOperationName: operation.name,
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

    if (!job.geminiOperationName) {
      if (job.geminiDocumentName || manualVersion.geminiDocumentName) {
        await ctx.runMutation(internal.ingestionJobs.internalMarkActive, {
          ingestionJobId: job._id,
          manualId: job.manualId,
          manualVersionId: job.manualVersionId,
          geminiDocumentName: job.geminiDocumentName ?? manualVersion.geminiDocumentName,
          geminiFileName: job.geminiFileName ?? manualVersion.geminiFileName,
          actorTokenIdentifier: job.createdByTokenIdentifier,
        })
        return
      }

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
      const operation = (await ai.operations.get({
        // The installed @google/genai SDK types accept an Operation object; name
        // is the serializable field required to resume polling in a later action.
        operation: { name: job.geminiOperationName } as UploadToFileSearchStoreOperation,
      })) as unknown as UploadToFileSearchStoreOperation

      if (operation.error) {
        throw new Error(`Gemini File Search indexing failed: ${JSON.stringify(operation.error)}`)
      }

      if (operation.done) {
        await ctx.runMutation(internal.ingestionJobs.internalMarkActive, {
          ingestionJobId: job._id,
          manualId: job.manualId,
          manualVersionId: job.manualVersionId,
          geminiDocumentName:
            extractStringField(operation.response, 'documentName') ??
            job.geminiDocumentName ??
            manualVersion.geminiDocumentName,
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
    const rawText = response.text?.trim() ?? ''
    const refusal = shouldRefuse(rawText, citations)
    const answerText = refusal ? REFUSAL : rawText
    const answerCitations = refusal ? [] : citations

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

async function waitForOperation(
  ai: GoogleGenAI,
  operation: UploadToFileSearchStoreOperation,
): Promise<UploadToFileSearchStoreOperation> {
  let current = operation

  for (let attempts = 0; attempts < INDEXING_MAX_ATTEMPTS; attempts += 1) {
    if (current.done) {
      if (current.error) {
        throw new Error(`Gemini File Search indexing failed: ${JSON.stringify(current.error)}`)
      }
      return current
    }

    await new Promise((resolve) => setTimeout(resolve, INDEXING_POLL_INTERVAL_MS))
    current = (await ai.operations.get({
      operation: current,
    })) as unknown as UploadToFileSearchStoreOperation
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

function shouldRefuse(answerText: string, citations: Citation[]): boolean {
  const normalized = answerText.trim()
  if (!normalized) return true
  if (normalized === REFUSAL) return true
  if (/\b(could not|cannot|can't|not able to)\s+find\b/i.test(normalized)) {
    return true
  }
  return citations.length === 0
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

  if (!['pdf', 'txt', 'md'].includes(extension)) {
    throw new Error('Only PDF, TXT, and MD manuals are supported in Phase 2A.')
  }

  if (
    (extension === 'pdf' && mimeType !== 'application/pdf') ||
    (extension === 'txt' && mimeType !== 'text/plain') ||
    (extension === 'md' && !['text/markdown', 'text/plain'].includes(mimeType))
  ) {
    throw new Error('Manual file type does not match the selected file extension.')
  }

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
