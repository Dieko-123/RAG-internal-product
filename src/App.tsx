import {
  Component,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { SignInButton, SignUpButton, UserButton, useUser } from '@clerk/react'
import {
  Authenticated,
  AuthLoading,
  useAction,
  Unauthenticated,
  useConvexAuth,
  useMutation,
  useQuery,
} from 'convex/react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import './App.css'

const execuJetLogoUrl = `${import.meta.env.BASE_URL}execujet-aviation-nigeria-logo.png`

type View = 'chat' | 'documents' | 'admin'

type ManualListItem = {
  _id: Id<'manuals'>
  title: string
  slug: string
  status: string
  visibility?: 'org' | 'department' | 'restricted'
  latestIngestionJob?: {
    _id: Id<'ingestionJobs'>
    status: 'queued' | 'uploading' | 'indexing' | 'active' | 'failed'
    lastError?: string
    canRetryIndexing: boolean
  }
}

type ChatSessionId = Id<'chatSessions'>
type ManualId = Id<'manuals'>
type DepartmentId = Id<'departments'>

type ChatSession = {
  _id: ChatSessionId
  manualId: ManualId
  title: string
  pinned?: boolean
}

type Department = {
  _id: DepartmentId
  name: string
  slug: string
}

type AppUser = {
  _id: Id<'users'>
  tokenIdentifier: string
  email?: string
  name?: string
  status: 'active' | 'suspended'
}

type DepartmentMember = {
  _id: Id<'memberships'>
  departmentId?: DepartmentId
  userTokenIdentifier: string
  role: 'owner' | 'org_admin' | 'department_admin' | 'member' | 'viewer'
}

const maxManualUploadBytes = 25 * 1024 * 1024
const supportedManualExtensions = ['pdf', 'txt', 'md']
const supportedManualMimeTypes = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  '',
]

function App() {
  return (
    <main className="app">
      <AppErrorBoundary>
        <AuthLoading>
          <div className="loading-screen">
            <BrandMark />
            <span>Loading...</span>
          </div>
        </AuthLoading>

        <Unauthenticated>
          <SignedOutHome />
        </Unauthenticated>

        <Authenticated>
          <SignedInShell />
        </Authenticated>
      </AppErrorBoundary>
    </main>
  )
}

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('App render failed', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <section className="entry-layout">
          <div className="entry-card">
            <BrandMark />
            <h1>Unable to load the app</h1>
            <p>{this.state.error.message}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </section>
      )
    }

    return this.props.children
  }
}

function SignedOutHome() {
  return (
    <section className="entry-layout">
      <div className="entry-card">
        <BrandMark />
        <h1>Manual Assistant</h1>
        <p>
          Search and reference internal manuals with AI-powered retrieval.
        </p>
        <div className="login-actions">
          <SignInButton mode="modal">
            <button type="button" className="btn btn-primary">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button type="button" className="btn">
              Request access
            </button>
          </SignUpButton>
        </div>
      </div>
    </section>
  )
}

function SignedInShell() {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth()
  const [view, setView] = useState<View>('chat')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selectedChatId, setSelectedChatId] = useState<ChatSessionId | null>(null)
  const [accessState, setAccessState] = useState<
    'idle' | 'checking' | 'ready' | 'denied'
  >('idle')
  const [accessError, setAccessError] = useState<string | null>(null)
  const queryArgs = isAuthenticated ? {} : 'skip'
  const protectedQueryArgs =
    isAuthenticated && accessState === 'ready' ? {} : 'skip'
  const { isLoaded: isClerkUserLoaded, user: clerkUser } = useUser()
  const currentUser = useQuery(api.users.getCurrentUser, queryArgs)
  const isAdmin = useQuery(api.users.isCurrentUserAdmin, queryArgs)
  const uploadInfo = useQuery(api.users.getCurrentUserUploadInfo, protectedQueryArgs)
  const chatSessions = useQuery(api.chats.listChatSessions, protectedQueryArgs)
  const ensureCurrentUserAccess = useMutation(api.users.ensureCurrentUserAccess)
  const setChatPinned = useMutation(api.chats.setChatPinned)
  const displayName = useMemo(() => {
    if (clerkUser) {
      return clerkUser.fullName ?? clerkUser.primaryEmailAddress?.emailAddress ?? 'User'
    }
    if (!currentUser) return ''
    return currentUser.name ?? currentUser.email ?? 'User'
  }, [clerkUser, currentUser])

  const canAccessAdmin = isAdmin || (uploadInfo?.canUpload ?? false)
  const activeView = !canAccessAdmin && view === 'admin' ? 'chat' : view

  useEffect(() => {
    if (!isAuthenticated || !isClerkUserLoaded || accessState !== 'idle') return

    let cancelled = false

    void ensureCurrentUserAccess({
      email: clerkUser?.primaryEmailAddress?.emailAddress ?? undefined,
      name: clerkUser?.fullName ?? undefined,
    })
      .then(() => {
        if (!cancelled) {
          setAccessState('ready')
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setAccessError(
            err instanceof Error
              ? err.message
              : 'Not authorized for this internal app.',
          )
          setAccessState('denied')
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    accessState,
    ensureCurrentUserAccess,
    isAuthenticated,
    isClerkUserLoaded,
    clerkUser,
  ])

  function startNewChat() {
    setView('chat')
    setSelectedChatId(null)
  }

  function openChat(session: ChatSession) {
    setView('chat')
    setSelectedChatId(session._id)
  }

  function togglePinned(session: ChatSession) {
    void setChatPinned({
      chatSessionId: session._id,
      pinned: !session.pinned,
    })
  }

  if (isAuthLoading || (isAuthenticated && currentUser === undefined)) {
    return (
      <div className="loading-screen">
        <BrandMark />
        <span>Connecting your session...</span>
      </div>
    )
  }

  if (accessState === 'checking' || accessState === 'idle') {
    return (
      <div className="loading-screen">
        <BrandMark />
        <span>Checking internal access...</span>
      </div>
    )
  }

  if (accessState === 'denied') {
    return (
      <section className="entry-layout">
        <div className="entry-card">
          <BrandMark />
          <h1>Access unavailable</h1>
          <p>{accessError ?? 'Not authorized for this internal app.'}</p>
        </div>
      </section>
    )
  }

  return (
    <section
      className="console"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
    >
      <aside className="sidebar">
        <div className="sidebar-topbar">
          <BrandMark compact={sidebarCollapsed} />
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              {sidebarCollapsed ? (
                <path d="M9 6l6 6-6 6" />
              ) : (
                <path d="M15 6l-6 6 6 6" />
              )}
            </svg>
          </button>
        </div>
        <nav className="nav-list" aria-label="Navigation">
          <button
            type="button"
            className={activeView === 'chat' ? 'nav-item active' : 'nav-item'}
            onClick={() => setView('chat')}
            title="Ask"
          >
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span className="nav-label">Ask</span>
          </button>
          <button
            type="button"
            className={activeView === 'documents' ? 'nav-item active' : 'nav-item'}
            onClick={() => setView('documents')}
            title="Documents"
          >
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="nav-label">Documents</span>
          </button>
          {canAccessAdmin ? (
            <button
              type="button"
              className={activeView === 'admin' ? 'nav-item active' : 'nav-item'}
              onClick={() => setView('admin')}
              title="Admin"
            >
              <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l7 4v5c0 4.4-2.9 8.4-7 9.4-4.1-1-7-5-7-9.4V7l7-4z" />
              </svg>
              <span className="nav-label">Admin</span>
            </button>
          ) : null}
        </nav>
        {activeView === 'chat' ? (
          <section className="chat-history" aria-label="Previous chats">
            <button
              type="button"
              className="new-chat-button"
              onClick={startNewChat}
              title="New chat"
            >
              <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              <span className="nav-label">New chat</span>
            </button>
            <div className="history-list">
              {(chatSessions ?? []).length === 0 ? (
                <span className="history-empty">No previous chats</span>
              ) : (
                <>
                  <ChatSessionGroup
                    label="Pinned"
                    sessions={(chatSessions ?? []).filter((session) => session.pinned)}
                    selectedChatId={selectedChatId}
                    onOpenChat={openChat}
                    onTogglePinned={togglePinned}
                  />
                  <ChatSessionGroup
                    label="Recent"
                    sessions={(chatSessions ?? []).filter((session) => !session.pinned)}
                    selectedChatId={selectedChatId}
                    onOpenChat={openChat}
                    onTogglePinned={togglePinned}
                  />
                </>
              )}
            </div>
          </section>
        ) : null}
        <div className="sidebar-footer">
          <UserButton />
          <div className="sidebar-user">
            <div className="user-name">{displayName}</div>
            {isAdmin ? <div className="user-role">Admin</div> : null}
          </div>
        </div>
      </aside>

      <div className="main-panel">
        {activeView === 'chat' ? (
          <ChatWorkspace
            selectedChatId={selectedChatId}
            onSelectChat={setSelectedChatId}
            canQuery={accessState === 'ready'}
          />
        ) : activeView === 'documents' ? (
          <DocumentsWorkspace canQuery={accessState === 'ready'} />
        ) : (
          <AdminWorkspace canQuery={accessState === 'ready'} isOrgAdmin={!!isAdmin} uploadInfo={uploadInfo} />
        )}
      </div>
    </section>
  )
}

type SelectableManual = {
  _id: ManualId
  title: string
  visibility: string
  departmentName?: string
}

const MAX_SELECTED_MANUALS = 5

function ChatWorkspace({
  selectedChatId,
  onSelectChat,
  canQuery,
}: {
  selectedChatId: ChatSessionId | null
  onSelectChat: (chatSessionId: ChatSessionId | null) => void
  canQuery: boolean
}) {
  const queryArgs = canQuery ? {} : 'skip'
  const selectableManuals = useQuery(api.manuals.listSelectableManuals, queryArgs)
  const messages = useQuery(
    api.chats.listChatMessages,
    canQuery
      ? {
          chatSessionId: selectedChatId ?? undefined,
        }
      : 'skip',
  )
  const askMultiManualQuestion = useAction(api.gemini.askMultiManualQuestion)
  const [question, setQuestion] = useState('')
  const [isAsking, setIsAsking] = useState(false)
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedManualIds, setSelectedManualIds] = useState<ManualId[]>([])

  const scopeLocked = selectedChatId !== null
  const manualsList: SelectableManual[] = selectableManuals ?? []
  const manualsLoading = selectableManuals === undefined
  const displayedMessages = messages ?? []
  const hasSelectedManuals = selectedManualIds.length > 0
  const selectedManualReady = !manualsLoading && (hasSelectedManuals || scopeLocked)

  function toggleManual(manualId: ManualId) {
    if (scopeLocked) return
    setSelectedManualIds((prev) => {
      if (prev.includes(manualId)) {
        return prev.filter((id) => id !== manualId)
      }
      if (prev.length >= MAX_SELECTED_MANUALS) return prev
      return [...prev, manualId]
    })
  }

  async function handleAsk() {
    const trimmedQuestion = question.trim()
    if (!trimmedQuestion || isAsking) return
    if (!selectedChatId && selectedManualIds.length === 0) return

    setIsAsking(true)
    setPendingQuestion(trimmedQuestion)
    setQuestion('')
    setError(null)

    try {
      const result = await askMultiManualQuestion({
        question: trimmedQuestion,
        chatSessionId: selectedChatId ?? undefined,
        selectedManualIds: selectedChatId ? undefined : selectedManualIds,
      })
      onSelectChat(result.chatSessionId)
    } catch (err) {
      setQuestion(trimmedQuestion)
      setError(err instanceof Error ? err.message : 'Question failed')
    } finally {
      setIsAsking(false)
      setPendingQuestion(null)
    }
  }

  const selectedTitles = manualsList
    .filter((m) => selectedManualIds.includes(m._id))
    .map((m) => m.title)

  return (
    <section className="chat-workspace">
      <div className="page-header">
        <h1>Ask a question</h1>
        <p>
          {scopeLocked
            ? 'Scope locked for this chat.'
            : hasSelectedManuals
              ? `Searching: ${selectedTitles.join(', ')}`
              : manualsLoading
                ? 'Loading manuals...'
                : manualsList.length > 0
                  ? 'Select manuals to search'
                  : 'No manuals available for search'}
        </p>
      </div>

      <div className="connection-status">
        <span className={selectedManualReady ? 'status-dot' : 'status-dot status-idle'} />
        {manualsLoading
          ? 'Loading manuals'
          : selectedManualReady
            ? scopeLocked
              ? 'Scope locked'
              : `${selectedManualIds.length} manual${selectedManualIds.length !== 1 ? 's' : ''} selected`
            : 'Select manuals'}
      </div>

      {!scopeLocked && manualsList.length > 0 ? (
        <div className="manual-selector" aria-label="Select manuals to search">
          {manualsList.map((manual) => {
            const isChecked = selectedManualIds.includes(manual._id)
            const isDisabled = !isChecked && selectedManualIds.length >= MAX_SELECTED_MANUALS
            return (
              <label
                className={`manual-checkbox${isChecked ? ' checked' : ''}${isDisabled ? ' disabled' : ''}`}
                key={manual._id}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={isDisabled}
                  onChange={() => toggleManual(manual._id)}
                />
                <span className="manual-checkbox-title">{manual.title}</span>
                <span className="manual-checkbox-meta">
                  {manual.visibility === 'department' && manual.departmentName
                    ? manual.departmentName
                    : manual.visibility}
                </span>
              </label>
            )
          })}
        </div>
      ) : null}

      {scopeLocked ? (
        <div className="scope-locked-notice">
          Scope locked for this chat. Start a new chat to change manuals.
        </div>
      ) : null}

      <div className="chat-container">
        <div className="messages-area">
          {displayedMessages.length === 0 && !pendingQuestion ? (
            <div className="message-empty">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              Select manuals and ask a question
            </div>
          ) : (
            <>
              {displayedMessages.map((message) => (
                <article
                  className={
                    message.role === 'assistant'
                      ? message.refusal
                        ? 'message message-warning'
                        : 'message message-assistant'
                      : 'message message-user'
                  }
                  key={message._id}
                >
                  {message.role === 'assistant' && message.warning ? (
                    <div className="message-scope-warning">{message.warning}</div>
                  ) : null}
                  <p>{message.content}</p>
                  {message.role === 'assistant' ? (
                    <>
                      <div className="answer-meta">
                        {message.model ?? 'manual answer'}
                        {message.latencyMs ? ` / ${message.latencyMs}ms` : ''}
                        {message.sourceFileName ? ` / ${message.sourceFileName}` : ''}
                      </div>
                      {!message.refusal && message.citations && message.citations.length > 0 ? (
                        <CitationList citations={message.citations} />
                      ) : null}
                    </>
                  ) : null}
                </article>
              ))}
              {pendingQuestion ? (
                <article className="message message-user message-pending">
                  <p>{pendingQuestion}</p>
                </article>
              ) : null}
            </>
          )}
          {error ? <div className="inline-error">{error}</div> : null}
        </div>

        <div className="composer">
          <textarea
            aria-label="Ask a question"
            placeholder={
              manualsLoading
                ? 'Loading manuals...'
                : selectedManualReady
                  ? 'Ask about the selected manuals'
                  : 'Select at least one manual'
            }
            rows={1}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void handleAsk()
              }
            }}
            disabled={manualsLoading || !selectedManualReady || isAsking}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              manualsLoading ||
              !selectedManualReady ||
              isAsking ||
              !question.trim()
            }
            onClick={() => void handleAsk()}
            aria-label="Ask manual question"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
    </section>
  )
}

function CitationList({
  citations,
}: {
  citations: Array<{
    title?: string
    uri?: string
    pageNumber?: number
    excerpt?: string
    manualId?: string
    manualVersionId?: string
    sourceFileName?: string
  }>
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, { label: string; items: typeof citations }>()
    for (const citation of citations) {
      const key = citation.manualVersionId ?? citation.manualId ?? citation.title ?? citation.sourceFileName ?? 'unknown'
      const label = citation.title ?? citation.sourceFileName ?? 'Unknown source'
      const existing = groups.get(key)
      if (existing) {
        existing.items.push(citation)
      } else {
        groups.set(key, { label, items: [citation] })
      }
    }
    return groups
  }, [citations])

  return (
    <div className="citations">
      {[...grouped.values()].map(({ label, items }) => (
        <div className="citation-group" key={`${label}-${items[0]?.manualVersionId ?? items[0]?.uri ?? ''}`}>
          <div className="citation-group-title">From: {label}</div>
          {items.map((citation, index) => (
            <div className="citation" key={`${citation.uri ?? citation.title ?? index}`}>
              {citation.pageNumber ? <strong>Page {citation.pageNumber}</strong> : null}
              {citation.excerpt ? <p>{citation.excerpt}</p> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function DocumentsWorkspace({ canQuery }: { canQuery: boolean }) {
  const manuals = useQuery(
    api.manuals.listManuals,
    canQuery ? {} : 'skip',
  )

  return (
    <>
      <div className="page-header">
        <h1>Documents</h1>
        <p>Browse indexed manuals available to the assistant</p>
      </div>

      <ManualStatusList manuals={manuals} />
    </>
  )
}

type UploadInfo = {
  canUpload: boolean
  role: 'org_admin' | 'department_admin' | 'member'
  departments: Array<{ _id: DepartmentId; name: string; slug: string }>
}

function AdminWorkspace({
  canQuery,
  isOrgAdmin,
  uploadInfo,
}: {
  canQuery: boolean
  isOrgAdmin: boolean
  uploadInfo: UploadInfo | undefined
}) {
  const [isIngesting, setIsIngesting] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [isCreatingDepartment, setIsCreatingDepartment] = useState(false)
  const [isAssigningDepartment, setIsAssigningDepartment] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [manualTitle, setManualTitle] = useState('')
  const [uploadVisibility, setUploadVisibility] = useState<'org' | 'department'>('org')
  const [uploadDepartmentId, setUploadDepartmentId] = useState<DepartmentId | ''>('')
  const [departmentName, setDepartmentName] = useState('')
  const [selectedDepartmentId, setSelectedDepartmentId] =
    useState<DepartmentId | ''>('')
  const [selectedUserTokenIdentifier, setSelectedUserTokenIdentifier] =
    useState('')
  const [departmentRole, setDepartmentRole] = useState<
    'member' | 'department_admin'
  >('member')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const manuals = useQuery(
    api.manuals.listManuals,
    canQuery ? {} : 'skip',
  )
  const departments = useQuery(
    api.departments.listDepartments,
    canQuery ? {} : 'skip',
  )
  const users = useQuery(
    api.users.listExistingUsersForAdmin,
    canQuery ? {} : 'skip',
  )
  const departmentMembers = useQuery(
    api.departments.listDepartmentMembers,
    canQuery && selectedDepartmentId
      ? { departmentId: selectedDepartmentId }
      : 'skip',
  )
  const ingestDummyManual = useAction(api.gemini.ingestDummyManual)
  const ingestUploadedManual = useAction(api.gemini.ingestUploadedManual)
  const retryIndexing = useAction(api.gemini.retryIndexing)
  const generateManualUploadUrl = useMutation(api.manuals.generateManualUploadUrl)
  const createDepartment = useMutation(api.departments.createDepartment)
  const assignUserToDepartment = useMutation(api.users.assignUserToDepartment)
  const archiveManual = useMutation(api.manuals.archiveManual)
  const restoreManual = useMutation(api.manuals.restoreManual)
  const archiveDepartment = useMutation(api.departments.archiveDepartment)
  const removeDepartmentMembership = useMutation(
    api.departments.removeDepartmentMembership,
  )
  const suspendUser = useMutation(api.users.suspendUser)
  const unsuspendUser = useMutation(api.users.unsuspendUser)

  async function handleIngest() {
    setIsIngesting(true)
    setMessage(null)
    setError(null)

    try {
      const result = await ingestDummyManual({})
      setMessage(`Dummy manual is ${result.status}. Store: ${result.geminiFileSearchStoreName}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ingestion failed')
    } finally {
      setIsIngesting(false)
    }
  }

  async function handleUploadManual() {
    if (!selectedFile || isUploading) return

    const title = manualTitle.trim()
    const validationError = validateManualFile(selectedFile)

    if (!title) {
      setError('Manual title is required')
      return
    }

    if (validationError) {
      setError(validationError)
      return
    }

    setIsUploading(true)
    setMessage(null)
    setError(null)

    try {
      const uploadUrl = await generateManualUploadUrl({})
      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': selectedFile.type || 'application/octet-stream' },
        body: selectedFile,
      })

      if (!uploadResponse.ok) {
        throw new Error(`Convex upload failed with ${uploadResponse.status}`)
      }

      const { storageId } = (await uploadResponse.json()) as {
        storageId: Id<'_storage'>
      }

      const result = await ingestUploadedManual({
        storageId,
        title,
        sourceFileName: selectedFile.name,
        mimeType: selectedFile.type || '',
        sizeBytes: selectedFile.size,
        visibility: uploadVisibility,
        departmentId: uploadVisibility === 'department' && uploadDepartmentId
          ? uploadDepartmentId
          : undefined,
      })

      setMessage(`${result.title} queued for indexing.`)
      setSelectedFile(null)
      setManualTitle('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Manual upload failed')
    } finally {
      setIsUploading(false)
    }
  }

  async function handleCreateDepartment() {
    const name = departmentName.trim()

    if (!name || isCreatingDepartment) return

    setIsCreatingDepartment(true)
    setMessage(null)
    setError(null)

    try {
      await createDepartment({ name })
      setDepartmentName('')
      setMessage(`Created department: ${name}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Department creation failed')
    } finally {
      setIsCreatingDepartment(false)
    }
  }

  async function handleAssignDepartment() {
    if (
      !selectedDepartmentId ||
      !selectedUserTokenIdentifier ||
      isAssigningDepartment
    ) {
      return
    }

    setIsAssigningDepartment(true)
    setMessage(null)
    setError(null)

    try {
      await assignUserToDepartment({
        departmentId: selectedDepartmentId,
        userTokenIdentifier: selectedUserTokenIdentifier,
        role: departmentRole,
      })
      setMessage('Department membership assigned')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Department assignment failed')
    } finally {
      setIsAssigningDepartment(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Admin</h1>
        <p>Upload and index manuals for Gemini File Search</p>
      </div>

      <div className="document-grid">
        <section className="manual-panel">
          <div className="upload-zone">
            <div className="drop-area">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <p>
                Upload one controlled real-format manual for Gemini File Search.
              </p>
              <span className="file-types">PDF, TXT, or MD up to 25 MB</span>
              <input
                type="file"
                accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null
                  const validationError = file ? validateManualFile(file) : null
                  setSelectedFile(file)
                  setError(validationError)
                  if (file && !manualTitle) {
                    setManualTitle(file.name.replace(/\.[^.]+$/, ''))
                  }
                }}
                disabled={isUploading || isIngesting}
              />
            </div>
          </div>
          <label className="field-label">
            Manual title
            <input
              type="text"
              value={manualTitle}
              onChange={(event) => setManualTitle(event.target.value)}
              placeholder="Operations Manual"
              disabled={isUploading}
            />
          </label>
          <label className="field-label">
            Visibility
            <select
              value={uploadVisibility}
              onChange={(event) => {
                const v = event.target.value as 'org' | 'department'
                setUploadVisibility(v)
                if (v === 'org') setUploadDepartmentId('')
              }}
              disabled={isUploading || (!isOrgAdmin && uploadInfo?.role !== 'org_admin')}
            >
              <option value="org">Organization-wide</option>
              <option value="department">Department only</option>
            </select>
          </label>
          {uploadVisibility === 'department' ? (
            <label className="field-label">
              Department
              <select
                value={uploadDepartmentId}
                onChange={(event) =>
                  setUploadDepartmentId(event.target.value as DepartmentId | '')
                }
                disabled={isUploading}
              >
                <option value="">Select department</option>
                {(isOrgAdmin ? (departments ?? []) : (uploadInfo?.departments ?? [])).map(
                  (dept) => (
                    <option value={dept._id} key={dept._id}>
                      {dept.name}
                    </option>
                  ),
                )}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              !selectedFile ||
              isUploading ||
              isIngesting ||
              (uploadVisibility === 'department' && !uploadDepartmentId)
            }
            onClick={() => void handleUploadManual()}
          >
            {isUploading ? 'Uploading...' : 'Upload and index manual'}
          </button>
          <div className="admin-divider">Test fixture</div>
          <button
            type="button"
            className="btn"
            disabled={isIngesting || isUploading}
            onClick={() => void handleIngest()}
          >
            {isIngesting ? 'Indexing...' : 'Ingest dummy manual'}
          </button>
          {message ? <div className="inline-success">{message}</div> : null}
          {error ? <div className="inline-error">{error}</div> : null}
        </section>

        <ManualStatusList
          manuals={manuals}
          onRetry={(ingestionJobId) => {
            void retryIndexing({ ingestionJobId }).then(() => {
              setMessage('Retry indexing queued')
            }).catch((err) => {
              setError(err instanceof Error ? err.message : 'Retry failed')
            })
          }}
          onArchive={(manualId) => {
            void archiveManual({ manualId }).then(() => {
              setMessage('Manual archived')
            }).catch((err) => {
              setError(err instanceof Error ? err.message : 'Archive failed')
            })
          }}
          onRestore={(manualId) => {
            void restoreManual({ manualId }).then(() => {
              setMessage('Manual restored')
            }).catch((err) => {
              setError(err instanceof Error ? err.message : 'Restore failed')
            })
          }}
        />

        {isOrgAdmin ? (
          <section className="manual-panel admin-org-panel">
            <div>
              <h2>Departments</h2>
              <p>Create lightweight departments for future scoped manuals.</p>
            </div>
            <label className="field-label">
              Department name
              <input
                type="text"
                value={departmentName}
                onChange={(event) => setDepartmentName(event.target.value)}
                placeholder="Flight Operations"
                disabled={isCreatingDepartment}
              />
            </label>
            <button
              type="button"
              className="btn"
              disabled={!departmentName.trim() || isCreatingDepartment}
              onClick={() => void handleCreateDepartment()}
            >
              {isCreatingDepartment ? 'Creating...' : 'Create department'}
            </button>
            <DepartmentList
              departments={departments}
              onArchive={(departmentId) => {
                void archiveDepartment({ departmentId }).then(() => {
                  setMessage('Department archived')
                }).catch((err) => {
                  setError(err instanceof Error ? err.message : 'Archive failed')
                })
              }}
            />
          </section>
        ) : null}

        {isOrgAdmin ? (
          <section className="manual-panel admin-org-panel">
            <div>
              <h2>Users</h2>
              <p>Manage user access. Suspended users cannot use the app.</p>
            </div>
            <UserList
              users={users}
              onSuspend={(userId) => {
                void suspendUser({ userId }).then(() => {
                  setMessage('User suspended')
                }).catch((err) => {
                  setError(err instanceof Error ? err.message : 'Suspend failed')
                })
              }}
              onUnsuspend={(userId) => {
                void unsuspendUser({ userId }).then(() => {
                  setMessage('User unsuspended')
                }).catch((err) => {
                  setError(err instanceof Error ? err.message : 'Unsuspend failed')
                })
              }}
            />
          </section>
        ) : null}

        {isOrgAdmin ? (
          <section className="manual-panel admin-org-panel">
            <div>
              <h2>Department membership</h2>
              <p>Users appear here after they sign in once.</p>
            </div>
            <label className="field-label">
              Existing user
              <select
                value={selectedUserTokenIdentifier}
                onChange={(event) =>
                  setSelectedUserTokenIdentifier(event.target.value)
                }
                disabled={isAssigningDepartment}
              >
                <option value="">Select user</option>
                {(users ?? []).map((user: AppUser) => (
                  <option value={user.tokenIdentifier} key={user._id}>
                    {user.email ?? user.name ?? user.tokenIdentifier}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Department
              <select
                value={selectedDepartmentId}
                onChange={(event) =>
                  setSelectedDepartmentId(event.target.value as DepartmentId | '')
                }
                disabled={isAssigningDepartment}
              >
                <option value="">Select department</option>
                {(departments ?? []).map((department: Department) => (
                  <option value={department._id} key={department._id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Role
              <select
                value={departmentRole}
                onChange={(event) =>
                  setDepartmentRole(
                    event.target.value as 'member' | 'department_admin',
                  )
                }
                disabled={isAssigningDepartment}
              >
                <option value="member">Member</option>
                <option value="department_admin">Department admin</option>
              </select>
            </label>
            <button
              type="button"
              className="btn"
              disabled={
                !selectedUserTokenIdentifier ||
                !selectedDepartmentId ||
                isAssigningDepartment
              }
              onClick={() => void handleAssignDepartment()}
            >
              {isAssigningDepartment ? 'Assigning...' : 'Assign department'}
            </button>
            <DepartmentMemberList
              members={departmentMembers}
              users={users}
              onRemove={(userTokenIdentifier) => {
                if (!selectedDepartmentId) return

                void removeDepartmentMembership({
                  departmentId: selectedDepartmentId,
                  userTokenIdentifier,
                }).then(() => {
                  setMessage('Department membership removed')
                }).catch((err) => {
                  setError(err instanceof Error ? err.message : 'Remove failed')
                })
              }}
            />
          </section>
        ) : null}
      </div>
    </>
  )
}

function DepartmentMemberList({
  members,
  users,
  onRemove,
}: {
  members: DepartmentMember[] | undefined
  users: AppUser[] | undefined
  onRemove: (userTokenIdentifier: string) => void
}) {
  const usersByToken = useMemo(() => {
    return new Map((users ?? []).map((user) => [user.tokenIdentifier, user]))
  }, [users])

  if (members === undefined) {
    return <div className="compact-list"><span>Select a department to view members</span></div>
  }

  return (
    <div className="compact-list" aria-label="Department members">
      {members.length === 0 ? (
        <span>No members assigned to this department</span>
      ) : (
        members.map((member) => {
          const user = usersByToken.get(member.userTokenIdentifier)
          const label = user?.name ?? user?.email ?? member.userTokenIdentifier

          return (
            <div className="compact-row" key={member._id}>
              <div>
                <strong>{label}</strong>
                <span>{member.role}</span>
              </div>
              <button
                type="button"
                className="btn-small btn-danger"
                onClick={() => {
                  if (confirm(`Remove "${label}" from this department?`)) {
                    onRemove(member.userTokenIdentifier)
                  }
                }}
              >
                Remove
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}

function DepartmentList({
  departments,
  onArchive,
}: {
  departments: Department[] | undefined
  onArchive?: (departmentId: DepartmentId) => void
}) {
  const rows = departments ?? []

  return (
    <div className="compact-list" aria-label="Departments">
      {departments === undefined ? (
        <span>Loading departments...</span>
      ) : rows.length === 0 ? (
        <span>No departments yet</span>
      ) : (
        rows.map((department) => (
          <div className="compact-row" key={department._id}>
            <div>
              <strong>{department.name}</strong>
              <span>{department.slug}</span>
            </div>
            {onArchive ? (
              <button
                type="button"
                className="btn-small btn-danger"
                onClick={() => {
                  if (confirm(`Archive "${department.name}"? Remove all members first.`)) {
                    onArchive(department._id)
                  }
                }}
              >
                Archive
              </button>
            ) : null}
          </div>
        ))
      )}
    </div>
  )
}

function UserList({
  users,
  onSuspend,
  onUnsuspend,
}: {
  users: AppUser[] | undefined
  onSuspend: (userId: Id<'users'>) => void
  onUnsuspend: (userId: Id<'users'>) => void
}) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    const rows = users ?? []
    const term = search.trim().toLowerCase()
    if (!term) return rows
    return rows.filter((user) =>
      (user.email ?? '').toLowerCase().includes(term),
    )
  }, [users, search])

  return (
    <div className="compact-list" aria-label="Users">
      <input
        type="text"
        className="user-search"
        placeholder="Search by email..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {users === undefined ? (
        <span>Loading users...</span>
      ) : filtered.length === 0 ? (
        <span>{search ? 'No matching users' : 'No users yet'}</span>
      ) : (
        filtered.map((user) => (
          <div className="compact-row" key={user._id}>
            <div>
              <strong>{user.name ?? user.email ?? 'Unknown'}</strong>
              <span className={user.status === 'suspended' ? 'status-suspended' : ''}>
                {user.email ?? 'No email'} · {user.status}
              </span>
            </div>
            {user.status === 'active' ? (
              <button
                type="button"
                className="btn-small btn-danger"
                onClick={() => {
                  if (confirm(`Suspend "${user.email ?? user.name}"? They will lose access.`)) {
                    onSuspend(user._id)
                  }
                }}
              >
                Suspend
              </button>
            ) : (
              <button
                type="button"
                className="btn-small"
                onClick={() => onUnsuspend(user._id)}
              >
                Unsuspend
              </button>
            )}
          </div>
        ))
      )}
    </div>
  )
}

function ManualStatusList({
  manuals,
  onRetry,
  onArchive,
  onRestore,
}: {
  manuals: ManualListItem[] | undefined
  onRetry?: (ingestionJobId: Id<'ingestionJobs'>) => void
  onArchive?: (manualId: Id<'manuals'>) => void
  onRestore?: (manualId: Id<'manuals'>) => void
}) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    const rows = manuals ?? []
    const term = search.trim().toLowerCase()
    if (!term) return rows
    return rows.filter((manual) =>
      manual.title.toLowerCase().includes(term),
    )
  }, [manuals, search])

  return (
    <section className="manual-list" aria-label="Manual status">
      <div className="manual-row manual-search-row">
        <input
          type="text"
          className="user-search"
          placeholder="Search manuals..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {manuals === undefined ? (
        <div className="manual-row muted-row">Loading manuals...</div>
      ) : filtered.length === 0 ? (
        <div className="manual-row muted-row">
          {search ? 'No matching manuals' : 'No manuals indexed yet'}
        </div>
      ) : (
        filtered.map((manual) => (
          <div className="manual-row" key={manual._id}>
            <div>
              <strong>{manual.title}</strong>
              <span>
                {manual.slug}
                {manual.visibility ? ` / ${manual.visibility}` : ''}
              </span>
              {manual.latestIngestionJob?.lastError ? (
                <span className="manual-error">
                  {manual.latestIngestionJob.lastError}
                </span>
              ) : null}
            </div>
            <div className="manual-row-actions">
              <mark>{manual.latestIngestionJob?.status ?? manual.status}</mark>
              {manual.latestIngestionJob?.status === 'failed' ? (
                manual.latestIngestionJob.canRetryIndexing && onRetry ? (
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => {
                      const jobId = manual.latestIngestionJob?._id
                      if (jobId) onRetry(jobId)
                    }}
                  >
                    Retry indexing
                  </button>
                ) : (
                  <span className="manual-action-note">Re-upload required</span>
                )
              ) : null}
              {onArchive && manual.status === 'active' ? (
                <button
                  type="button"
                  className="btn-small btn-danger"
                  onClick={() => {
                    if (confirm(`Archive "${manual.title}"? It will be hidden from new chats.`)) {
                      onArchive(manual._id)
                    }
                  }}
                >
                  Archive
                </button>
              ) : null}
              {onRestore && manual.status === 'archived' ? (
                <button
                  type="button"
                  className="btn-small"
                  onClick={() => onRestore(manual._id)}
                >
                  Restore
                </button>
              ) : null}
            </div>
          </div>
        ))
      )}
    </section>
  )
}

function ChatSessionGroup({
  label,
  sessions,
  selectedChatId,
  onOpenChat,
  onTogglePinned,
}: {
  label: string
  sessions: ChatSession[]
  selectedChatId: ChatSessionId | null
  onOpenChat: (session: ChatSession) => void
  onTogglePinned: (session: ChatSession) => void
}) {
  if (sessions.length === 0) return null

  return (
    <section className="history-group" aria-label={`${label} chats`}>
      <div className="history-group-label">{label}</div>
      {sessions.map((session) => (
        <div
          className={
            selectedChatId === session._id
              ? 'history-item active'
              : 'history-item'
          }
          key={session._id}
        >
          <button
            type="button"
            className="history-open"
            onClick={() => onOpenChat(session)}
            title={session.title || 'New chat'}
          >
            <span>{formatChatTitle(session.title)}</span>
          </button>
          <button
            type="button"
            className={session.pinned ? 'pin-button pinned' : 'pin-button'}
            aria-label={session.pinned ? 'Unpin chat' : 'Pin chat'}
            title={session.pinned ? 'Unpin chat' : 'Pin chat'}
            onClick={(event) => {
              event.stopPropagation()
              onTogglePinned(session)
            }}
          >
            <svg viewBox="0 0 24 24" fill={session.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5" />
              <path d="M8 3h8l-1 8 4 4v2H5v-2l4-4z" />
            </svg>
          </button>
        </div>
      ))}
    </section>
  )
}

function validateManualFile(file: File): string | null {
  const extension = getFileExtension(file.name)
  const mimeType = file.type.toLowerCase()

  if (!supportedManualExtensions.includes(extension)) {
    return 'Only PDF, TXT, and MD manuals are supported.'
  }

  if (!supportedManualMimeTypes.includes(mimeType)) {
    return 'The selected file type is not supported.'
  }

  if (file.size <= 0) {
    return 'The selected manual is empty.'
  }

  if (file.size > maxManualUploadBytes) {
    return 'Manual file must be 25 MB or smaller.'
  }

  return null
}

function getFileExtension(fileName: string) {
  const index = fileName.lastIndexOf('.')
  return index === -1 ? '' : fileName.slice(index + 1).toLowerCase()
}

function formatChatTitle(value: string | null | undefined): string {
  const trimmed = value?.trim().replace(/\s+/g, ' ') ?? ''
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
  const wasTruncated =
    words.length > 4 ||
    normalized.length < candidate.length ||
    withoutQuestionPrefix.length < trimmed.length

  return wasTruncated ? `${normalized.replace(/[.,;:!?-]+$/, '')}...` : normalized
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'brand-mark compact' : 'brand-mark'}>
      <img src={execuJetLogoUrl} alt="ExecuJet" />
      <span>Manual Assistant</span>
    </div>
  )
}

export default App
