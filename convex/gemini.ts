'use node'

import { GoogleGenAI, type UploadToFileSearchStoreOperation } from '@google/genai'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { action } from './_generated/server'
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
const INDEXING_POLL_INTERVAL_MS = 5000
const INDEXING_MAX_ATTEMPTS = 96
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
    geminiFileSearchStoreName: string
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

type IngestUploadedManualResult = IngestDummyManualResult & {
  title: string
  sourceFileName: string
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
  },
  handler: async (ctx, args): Promise<IngestUploadedManualResult> => {
    const admin = await requireAdmin(ctx)
    const fileInfo = validateManualUpload(args)
    const apiKey = readRequiredEnv('GEMINI_API_KEY')
    const ai = new GoogleGenAI({ apiKey })
    const slug = slugify(fileInfo.title)

    const manualId: Id<'manuals'> = await ctx.runMutation(
      internal.manuals.internalCreateManualIfMissing,
      {
        title: fileInfo.title,
        slug,
        actorTokenIdentifier: admin.tokenIdentifier,
      },
    )

    let manualVersionId: Id<'manualVersions'> | null = null

    try {
      const fileBlob = await ctx.storage.get(args.storageId)

      if (!fileBlob) {
        throw new Error('Uploaded manual file was not found in Convex storage.')
      }

      const fileSearchStore = await ai.fileSearchStores.create({
        config: {
          displayName: `${fileInfo.title} ${Date.now()}`,
        },
      })

      if (!fileSearchStore.name) {
        throw new Error('Gemini did not return a File Search store name.')
      }

      const versionLabel = `upload-${Date.now()}`

      manualVersionId = await ctx.runMutation(
        internal.manuals.internalCreateManualVersion,
        {
          manualId,
          versionLabel,
          sourceFileName: fileInfo.sourceFileName,
          provider: 'gemini_file_search',
          geminiFileSearchStoreName: fileSearchStore.name,
          mimeType: fileInfo.mimeType,
          sizeBytes: fileInfo.sizeBytes,
          status: 'indexing',
          actorTokenIdentifier: admin.tokenIdentifier,
        },
      )

      let operation = await ai.fileSearchStores.uploadToFileSearchStore({
        fileSearchStoreName: fileSearchStore.name,
        file: fileBlob,
        config: {
          displayName: fileInfo.sourceFileName,
          mimeType: fileInfo.mimeType,
          customMetadata: [
            { key: 'manual_slug', stringValue: slug },
            { key: 'manual_version', stringValue: versionLabel },
            { key: 'source_file_name', stringValue: fileInfo.sourceFileName },
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
        action: 'manual.ingest_upload',
        targetType: 'manual',
        targetId: manualId,
        metadata: {
          manualVersionId,
          geminiFileSearchStoreName: fileSearchStore.name,
          geminiFileSearchDocumentName: documentName ?? '',
          geminiFileName: fileName ?? '',
          sourceFileName: fileInfo.sourceFileName,
          mimeType: fileInfo.mimeType,
          sizeBytes: String(fileInfo.sizeBytes),
        },
      })

      return {
        manualId,
        manualVersionId,
        status: 'active',
        geminiFileSearchStoreName: fileSearchStore.name,
        geminiFileSearchDocumentName: documentName,
        geminiFileName: fileName,
        title: fileInfo.title,
        sourceFileName: fileInfo.sourceFileName,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown upload ingestion error'

      await ctx.runMutation(internal.manuals.internalMarkManualVersionFailed, {
        manualId,
        manualVersionId: manualVersionId ?? undefined,
        errorMessage: message,
      })

      await ctx.runMutation(internal.manuals.internalWriteAuditEvent, {
        actorTokenIdentifier: admin.tokenIdentifier,
        action: 'manual.ingest_upload_failed',
        targetType: 'manual',
        targetId: manualId,
        metadata: {
          manualVersionId: manualVersionId ?? '',
          sourceFileName: fileInfo.sourceFileName,
          errorMessage: message,
        },
      })

      throw error
    } finally {
      await deleteTemporaryUpload(ctx, args.storageId)
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
    const refusal = shouldRefuse(rawText)
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

function shouldRefuse(answerText: string): boolean {
  const normalized = answerText.trim()
  if (!normalized) return true
  if (normalized === REFUSAL) return true
  return /\b(could not|cannot|can't|not able to)\s+find\b/i.test(normalized)
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
) {
  try {
    await ctx.storage.delete(storageId)
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
