import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
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
const prettiflowLogoUrl = `${import.meta.env.BASE_URL}prettiflow-logo.png`
const demoOrganizationSlug = 'cohort-demo-organization'

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
type OrganizationId = Id<'organizations'>

type ChatSession = {
  _id: ChatSessionId
  manualId: ManualId
  title: string
  pinned?: boolean
  manualTitles?: string[]
}

type Department = {
  _id: DepartmentId
  name: string
  slug: string
}

type Organization = {
  _id: OrganizationId
  name: string
  slug: string
  roles: Array<'owner' | 'org_admin' | 'department_admin' | 'member' | 'viewer'>
  departmentIds: DepartmentId[]
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

type ChatMessage = {
  _id: Id<'chatMessages'>
  role: 'user' | 'assistant'
  content: string
  refusal?: boolean
  citations?: Array<{
    title?: string
    uri?: string
    pageNumber?: number
    excerpt?: string
    sourceFileName?: string
    providerUri?: string
  }>
  warning?: string
  model?: string
  latencyMs?: number
  sourceFileName?: string
}

type Invite = {
  _id: Id<'invites'>
  email: string
  role: 'org_admin' | 'member' | 'viewer'
  departmentId?: DepartmentId
  departmentRole?: 'department_admin' | 'member' | 'viewer'
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
}

const maxManualUploadBytes = 25 * 1024 * 1024
const supportedManualExtensions = ['pdf', 'txt', 'md', 'docx']
const supportedManualMimeTypes = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
  const [selectedManualIds, setSelectedManualIds] = useState<ManualId[]>([])
  const [selectedOrganizationId, setSelectedOrganizationId] =
    useState<OrganizationId | null>(() => {
      return window.localStorage.getItem('manualAssistant.activeOrgId') as OrganizationId | null
    })
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
  const organizations = useQuery(api.users.listMyOrganizations, protectedQueryArgs)
  const ensureCurrentUserAccess = useMutation(api.users.ensureCurrentUserAccess)
  const setChatPinned = useMutation(api.chats.setChatPinned)
  const deleteChatMutation = useMutation(api.chats.deleteChat)
  const displayName = useMemo(() => {
    if (clerkUser) {
      return clerkUser.fullName ?? clerkUser.primaryEmailAddress?.emailAddress ?? 'User'
    }
    if (!currentUser) return ''
    return currentUser.name ?? currentUser.email ?? 'User'
  }, [clerkUser, currentUser])

  const activeOrganizationId = useMemo(() => {
    if (!organizations || organizations.length === 0) return selectedOrganizationId
    const selectedIsValid = organizations.some(
      (organization: Organization) => organization._id === selectedOrganizationId,
    )
    return selectedIsValid ? selectedOrganizationId : organizations[0]._id
  }, [organizations, selectedOrganizationId])
  const activeOrganizationArgs =
    isAuthenticated && accessState === 'ready' && activeOrganizationId
      ? { organizationId: activeOrganizationId }
      : 'skip'
  const uploadInfo = useQuery(api.users.getCurrentUserUploadInfo, activeOrganizationArgs)
  const chatSessions = useQuery(api.chats.listChatSessions, activeOrganizationArgs)
  const activeOrganization = useMemo(() => {
    return (organizations ?? []).find(
      (organization: Organization) => organization._id === activeOrganizationId,
    ) ?? null
  }, [organizations, activeOrganizationId])
  const canAccessAdmin = Boolean(activeOrganizationId) && (isAdmin || (uploadInfo?.canUpload ?? false))
  const activeView = !canAccessAdmin && view === 'admin' ? 'chat' : view

  const clerkEmail = clerkUser?.primaryEmailAddress?.emailAddress
  const clerkReady = isAuthenticated && isClerkUserLoaded && !!clerkEmail

  useEffect(() => {
    if (!clerkReady || accessState !== 'idle') return

    let cancelled = false

    void ensureCurrentUserAccess({
      email: clerkEmail,
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
    clerkReady,
    clerkEmail,
    clerkUser?.fullName,
  ])

  function switchOrganization(organizationId: OrganizationId) {
    if (organizationId === activeOrganizationId) return
    setSelectedOrganizationId(organizationId)
    window.localStorage.setItem('manualAssistant.activeOrgId', organizationId)
    setSelectedChatId(null)
    setSelectedManualIds([])
    setView('chat')
  }

  function startNewChat() {
    setView('chat')
    setSelectedChatId(null)
  }

  function openNewChatWithSelectedManuals() {
    setSelectedChatId(null)
    setView('chat')
  }

  function openChat(session: ChatSession) {
    setView('chat')
    setSelectedChatId(session._id)
  }

  function togglePinned(session: ChatSession) {
    if (!activeOrganizationId) return
    void setChatPinned({
      organizationId: activeOrganizationId,
      chatSessionId: session._id,
      pinned: !session.pinned,
    })
  }

  function deleteChat(session: ChatSession) {
    if (!activeOrganizationId) return
    void deleteChatMutation({ organizationId: activeOrganizationId, chatSessionId: session._id })
    if (selectedChatId === session._id) {
      setSelectedChatId(null)
    }
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
          <button
            type="button"
            className="btn"
            onClick={() => {
              setAccessState('idle')
              setAccessError(null)
            }}
          >
            Try again
          </button>
        </div>
      </section>
    )
  }

  if (organizations !== undefined && organizations.length === 0) {
    return (
      <section className="entry-layout">
        <div className="entry-card">
          <BrandMark />
          <h1>No organization access</h1>
          <p>Your account is active, but it is not assigned to an organization.</p>
        </div>
      </section>
    )
  }

  if (organizations === undefined || !activeOrganizationId || !activeOrganization) {
    return (
      <div className="loading-screen">
        <BrandMark />
        <span>Loading organization...</span>
      </div>
    )
  }

  return (
    <section
      className="console"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
    >
      <aside className="sidebar">
        <div className="sidebar-topbar">
          <BrandMark
            compact={sidebarCollapsed}
            organizationSlug={activeOrganization.slug}
          />
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
        <OrganizationSwitcher
          activeOrganizationId={activeOrganizationId}
          organizations={organizations}
          collapsed={sidebarCollapsed}
          onSwitch={switchOrganization}
        />
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
                    sessions={(chatSessions ?? []).filter((session: ChatSession) => session.pinned)}
                    selectedChatId={selectedChatId}
                    onOpenChat={openChat}
                    onTogglePinned={togglePinned}
                    onDeleteChat={deleteChat}
                  />
                  <ChatSessionGroup
                    label="Recent"
                    sessions={(chatSessions ?? []).filter((session: ChatSession) => !session.pinned)}
                    selectedChatId={selectedChatId}
                    onOpenChat={openChat}
                    onTogglePinned={togglePinned}
                    onDeleteChat={deleteChat}
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

      <div className="main-panel" data-view={activeView}>
        {activeView === 'chat' ? (
          <ChatWorkspace
            organizationId={activeOrganizationId}
            selectedChatId={selectedChatId}
            onSelectChat={setSelectedChatId}
            canQuery={accessState === 'ready'}
            selectedManualIds={selectedManualIds}
            lockedManualTitles={
              selectedChatId
                ? ((chatSessions ?? []).find((s: ChatSession) => s._id === selectedChatId)?.manualTitles ?? null)
                : null
            }
          />
        ) : activeView === 'documents' ? (
          <DocumentsWorkspace
            organizationId={activeOrganizationId}
            canQuery={accessState === 'ready'}
            selectedManualIds={selectedManualIds}
            onSelectedManualIdsChange={setSelectedManualIds}
            onStartChat={openNewChatWithSelectedManuals}
          />
        ) : (
          <AdminWorkspace
            organizationId={activeOrganizationId}
            activeOrganization={activeOrganization}
            canQuery={accessState === 'ready'}
            isOrgAdmin={!!isAdmin || uploadInfo?.role === 'org_admin'}
            isSystemAdmin={!!isAdmin}
            uploadInfo={uploadInfo}
          />
        )}
      </div>
    </section>
  )
}

function OrganizationSwitcher({
  activeOrganizationId,
  organizations,
  collapsed,
  onSwitch,
}: {
  activeOrganizationId: OrganizationId
  organizations: Organization[]
  collapsed: boolean
  onSwitch: (organizationId: OrganizationId) => void
}) {
  const activeOrganization = organizations.find((org) => org._id === activeOrganizationId)
  const activeIndex = organizations.findIndex((org) => org._id === activeOrganizationId)
  const nextOrganization = activeIndex >= 0
    ? organizations[(activeIndex + 1) % organizations.length]
    : organizations[0]
  const activeIsDemoOrganization = activeOrganization?.slug === demoOrganizationSlug
  const organizationScopeLabel = activeIsDemoOrganization
    ? 'Demo data only'
    : 'Organization data only'

  if (collapsed) {
    const canCycleOrganizations = organizations.length > 1 && nextOrganization

    return (
      <button
        type="button"
        className={activeIsDemoOrganization ? 'org-switcher-collapsed demo' : 'org-switcher-collapsed'}
        title={canCycleOrganizations
          ? `${activeOrganization?.name ?? 'Organization'} - switch to ${nextOrganization.name}`
          : activeOrganization?.name}
        aria-label={canCycleOrganizations
          ? `Active organization: ${activeOrganization?.name ?? 'Organization'}. Switch to ${nextOrganization.name}.`
          : `Active organization: ${activeOrganization?.name ?? 'Organization'}.`}
        onClick={() => {
          if (!canCycleOrganizations) return
          onSwitch(nextOrganization._id)
        }}
      >
        {getOrganizationInitials(activeOrganization?.name)}
      </button>
    )
  }

  return (
    <section
      className={activeIsDemoOrganization ? 'org-switcher demo' : 'org-switcher'}
      aria-label="Organization context"
    >
      <div className="org-switcher-kicker">
        <span>Active workspace</span>
        <span>{organizationScopeLabel}</span>
      </div>
      <div className="org-switcher-current">
        <span className="org-switcher-mark" aria-hidden="true">
          {getOrganizationInitials(activeOrganization?.name)}
        </span>
        <div>
          <strong>{activeOrganization?.name ?? 'Organization'}</strong>
          <span>{activeIsDemoOrganization ? 'Cohort demo isolation is on' : 'Private tenant boundary'}</span>
        </div>
      </div>
      {organizations.length > 1 ? (
        <div
          className="org-switcher-options"
          role="radiogroup"
          aria-label="Active organization"
        >
          {organizations.map((organization) => (
            <button
              type="button"
              role="radio"
              aria-checked={organization._id === activeOrganizationId}
              className={[
                'org-switcher-option',
                organization._id === activeOrganizationId ? 'active' : '',
                organization.slug === demoOrganizationSlug ? 'demo' : '',
              ].filter(Boolean).join(' ')}
              key={organization._id}
              onClick={() => onSwitch(organization._id)}
            >
              <span className="org-switcher-option-mark" aria-hidden="true">
                {getOrganizationInitials(organization.name)}
              </span>
              <span>{organization.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <span className="org-switcher-static">Only workspace available</span>
      )}
    </section>
  )
}

function getOrganizationInitials(name?: string): string {
  if (!name) return 'O'

  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean)

  if (words.length === 0) return 'O'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()

  return `${words[0][0]}${words[1][0]}`.toUpperCase()
}

type SelectableManual = {
  _id: ManualId
  title: string
  visibility: string
  departmentName?: string
}

const MAX_SELECTED_MANUALS = 30
// TODO: Long-term UX should support document collections/folders so users can
// select a folder instead of 30 individual PDFs.

function ChatWorkspace({
  organizationId,
  selectedChatId,
  onSelectChat,
  canQuery,
  selectedManualIds,
  lockedManualTitles,
}: {
  organizationId: OrganizationId
  selectedChatId: ChatSessionId | null
  onSelectChat: (chatSessionId: ChatSessionId | null) => void
  canQuery: boolean
  selectedManualIds: ManualId[]
  lockedManualTitles: string[] | null
}) {
  const queryArgs = canQuery ? { organizationId } : 'skip'
  const selectableManuals = useQuery(api.manuals.listSelectableManuals, queryArgs)
  const messages = useQuery(
    api.chats.listChatMessages,
    canQuery
      ? {
          organizationId,
          chatSessionId: selectedChatId ?? undefined,
        }
      : 'skip',
  )
  const askMultiManualQuestion = useAction(api.gemini.askMultiManualQuestion)
  const [question, setQuestion] = useState('')
  const [isAsking, setIsAsking] = useState(false)
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, pendingQuestion])

  const scopeLocked = selectedChatId !== null
  const manualsList: SelectableManual[] = selectableManuals ?? []
  const manualsLoading = selectableManuals === undefined
  const displayedMessages = messages ?? []
  const hasSelectedManuals = selectedManualIds.length > 0
  const selectedManualReady = !manualsLoading && (hasSelectedManuals || scopeLocked)

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
        organizationId,
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
            ? lockedManualTitles && lockedManualTitles.length > 0
              ? `Scope locked — ${lockedManualTitles.join(', ')}`
              : 'Scope locked for this chat.'
            : hasSelectedManuals
              ? `Searching: ${selectedTitles.join(', ')}`
              : manualsLoading
                ? 'Loading manuals...'
                : manualsList.length > 0
                  ? 'Choose manuals on the Documents page'
                  : 'No manuals available for search'}
        </p>
      </div>

      <div className="connection-status chat-scope-status">
        <span className={selectedManualReady ? 'status-dot' : 'status-dot status-idle'} />
        {manualsLoading
          ? 'Loading manuals'
          : selectedManualReady
            ? scopeLocked
              ? lockedManualTitles && lockedManualTitles.length > 0
                ? `Scope locked · ${lockedManualTitles.length} manual${lockedManualTitles.length !== 1 ? 's' : ''}`
                : 'Scope locked'
              : `${selectedManualIds.length} manual${selectedManualIds.length !== 1 ? 's' : ''} selected`
            : 'No manuals selected'}
      </div>

      {scopeLocked ? (
        <div className="scope-locked-notice">
          {lockedManualTitles && lockedManualTitles.length > 0
            ? <>Searching: <strong>{lockedManualTitles.join(', ')}</strong>. Start a new chat to change manuals.</>
            : 'Scope locked for this chat. Start a new chat to change manuals.'}
        </div>
      ) : !hasSelectedManuals && !manualsLoading && manualsList.length > 0 ? (
        <div className="scope-locked-notice">
          Select one or more manuals on the Documents page, then start a new chat.
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
              {scopeLocked || hasSelectedManuals
                ? 'Ask a question'
                : 'Select manuals on the Documents page'}
            </div>
          ) : (
            <>
              {displayedMessages.map((message: ChatMessage) => (
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
                  {message.role === 'assistant' ? (
                    <MarkdownMessage content={message.content} />
                  ) : (
                    <p>{message.content}</p>
                  )}
                  {message.role === 'assistant' ? (
                    <>
                      <div className="answer-meta">
                        {message.model ?? 'manual answer'}
                        {message.latencyMs ? ` / ${message.latencyMs}ms` : ''}
                        {message.sourceFileName ? ` / ${message.sourceFileName}` : ''}
                      </div>
                      {!message.refusal && message.citations && message.citations.length > 0 ? (
                        <CitationList
                          citations={message.citations}
                          fallbackSourceFileName={message.sourceFileName}
                        />
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
          <div ref={messagesEndRef} />
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

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-message">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

function CitationList({
  citations,
  fallbackSourceFileName,
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
  fallbackSourceFileName?: string
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, { label: string; items: typeof citations }>()
    for (const citation of citations) {
      const label =
        citation.sourceFileName ??
        fallbackSourceFileName ??
        citation.title ??
        'Unknown source'
      const key =
        citation.manualVersionId ??
        citation.manualId ??
        citation.sourceFileName ??
        fallbackSourceFileName ??
        citation.title ??
        'unknown'
      const existing = groups.get(key)
      if (existing) {
        existing.items.push(citation)
      } else {
        groups.set(key, { label, items: [citation] })
      }
    }
    return groups
  }, [citations, fallbackSourceFileName])

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

function DocumentsWorkspace({
  organizationId,
  canQuery,
  selectedManualIds,
  onSelectedManualIdsChange,
  onStartChat,
}: {
  organizationId: OrganizationId
  canQuery: boolean
  selectedManualIds: ManualId[]
  onSelectedManualIdsChange: (manualIds: ManualId[]) => void
  onStartChat: () => void
}) {
  const manuals = useQuery(
    api.manuals.listManuals,
    canQuery ? { organizationId } : 'skip',
  )
  const selectableManuals = useQuery(
    api.manuals.listSelectableManuals,
    canQuery ? { organizationId } : 'skip',
  )
  const [manualSearch, setManualSearch] = useState('')
  const manualsList: SelectableManual[] = useMemo(
    () => selectableManuals ?? [],
    [selectableManuals],
  )

  const filteredManuals = useMemo(() => {
    const q = manualSearch.trim().toLowerCase()
    if (!q) return manualsList
    return manualsList.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        (m.departmentName ?? '').toLowerCase().includes(q),
    )
  }, [manualsList, manualSearch])

  const orgManuals = useMemo(
    () => filteredManuals.filter((m) => m.visibility !== 'department'),
    [filteredManuals],
  )
  const deptManuals = useMemo(
    () => filteredManuals.filter((m) => m.visibility === 'department'),
    [filteredManuals],
  )

  const selectedManuals = manualsList.filter((m) => selectedManualIds.includes(m._id))
  const selectedCount = selectedManuals.length
  const atCap = selectedCount >= MAX_SELECTED_MANUALS

  const visibleIds = filteredManuals.map((m) => m._id)
  const visibleUnselectedCount = visibleIds.filter(
    (id) => !selectedManualIds.includes(id),
  ).length
  const canSelectAllVisible = visibleUnselectedCount > 0 && !atCap

  function toggleManual(manualId: ManualId) {
    onSelectedManualIdsChange(
      selectedManualIds.includes(manualId)
        ? selectedManualIds.filter((id) => id !== manualId)
        : atCap
          ? selectedManualIds
          : [...selectedManualIds, manualId],
    )
  }

  function selectAllVisible() {
    const toAdd = visibleIds.filter((id) => !selectedManualIds.includes(id))
    const slots = MAX_SELECTED_MANUALS - selectedCount
    const adding = toAdd.slice(0, slots)
    onSelectedManualIdsChange([...selectedManualIds, ...adding])
  }

  function clearSelectedManuals() {
    onSelectedManualIdsChange([])
  }

  function renderManualGroup(label: string, items: SelectableManual[]) {
    if (items.length === 0) return null
    return (
      <div className="manual-group" key={label}>
        <div className="manual-group-label">{label}</div>
        {items.map((manual) => {
          const isChecked = selectedManualIds.includes(manual._id)
          const isDisabled = !isChecked && atCap
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
                  : 'Org-wide'}
              </span>
            </label>
          )
        })}
      </div>
    )
  }

  return (
    <>
      <div className="page-header">
        <h1>Documents</h1>
        <p>Select manuals here, then ask questions in a new chat</p>
      </div>

      <div className="documents-layout">
        <section className="document-selection-panel" aria-label="Manuals selected for chat">
          <div>
            <h2>Chat sources</h2>
            <p>
              {selectedCount} / {MAX_SELECTED_MANUALS} selected
            </p>
          </div>
          {selectableManuals === undefined ? (
            <span className="history-empty">Loading manuals...</span>
          ) : manualsList.length === 0 ? (
            <span className="history-empty">No active manuals available</span>
          ) : (
            <>
              <div className="document-selection-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={!canSelectAllVisible}
                  onClick={selectAllVisible}
                  title={atCap ? `Cap of ${MAX_SELECTED_MANUALS} reached` : undefined}
                >
                  Select all visible
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={selectedCount === 0}
                  onClick={clearSelectedManuals}
                >
                  Clear selection
                </button>
              </div>
              <input
                type="search"
                className="manual-search-input"
                placeholder="Filter manuals…"
                value={manualSearch}
                onChange={(e) => setManualSearch(e.target.value)}
                aria-label="Filter manuals"
              />
              {atCap ? (
                <p className="document-selection-note document-selection-cap-notice">
                  {MAX_SELECTED_MANUALS} manuals selected — deselect some to add others.
                </p>
              ) : null}
              <div className="manual-selector document-manual-selector">
                {filteredManuals.length === 0 ? (
                  <span className="history-empty">No manuals match filter</span>
                ) : (
                  <>
                    {renderManualGroup('Org-wide', orgManuals)}
                    {renderManualGroup('Department', deptManuals)}
                  </>
                )}
              </div>
            </>
          )}
          <div className="document-selection-footer">
            <span>
              {selectedCount === 0
                ? 'No manuals selected'
                : `${selectedCount} / ${MAX_SELECTED_MANUALS} selected`}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={selectedCount === 0}
              onClick={onStartChat}
            >
              Ask with selected
            </button>
          </div>
        </section>

        <ManualStatusList manuals={manuals} />
      </div>
    </>
  )
}

type UploadInfo = {
  canUpload: boolean
  role: 'org_admin' | 'department_admin' | 'member'
  departments: Array<{ _id: DepartmentId; name: string; slug: string }>
}

function AdminWorkspace({
  organizationId,
  activeOrganization,
  canQuery,
  isOrgAdmin,
  isSystemAdmin,
  uploadInfo,
}: {
  organizationId: OrganizationId
  activeOrganization: Organization
  canQuery: boolean
  isOrgAdmin: boolean
  isSystemAdmin: boolean
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
  const [showAllManuals, setShowAllManuals] = useState(false)
  const ensureCohortDemoOrganization = useMutation(api.users.ensureCohortDemoOrganization)
  const manuals = useQuery(
    api.manuals.listManuals,
    canQuery ? { organizationId } : 'skip',
  )
  const departments = useQuery(
    api.departments.listDepartments,
    canQuery && isOrgAdmin ? { organizationId } : 'skip',
  )
  const users = useQuery(
    api.users.listExistingUsersForAdmin,
    canQuery && isOrgAdmin ? { organizationId } : 'skip',
  )
  const departmentMembers = useQuery(
    api.departments.listDepartmentMembers,
    canQuery && isOrgAdmin && selectedDepartmentId
      ? { organizationId, departmentId: selectedDepartmentId }
      : 'skip',
  )
  const debugState = useQuery(
    api.manuals.debugManualState,
    canQuery && isOrgAdmin ? { organizationId } : 'skip',
  )
  const [showDebug, setShowDebug] = useState(false)
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
  const invites = useQuery(
    api.invitesQueries.listInvites,
    canQuery ? { organizationId } : 'skip',
  )
  const inviteUser = useAction(api.invites.inviteUser)
  const revokeInviteAction = useAction(api.invites.revokeInvite)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'org_admin' | 'viewer'>('member')
  const [inviteDepartmentId, setInviteDepartmentId] = useState<DepartmentId | ''>('')
  const [inviteDepartmentRole, setInviteDepartmentRole] = useState<'member' | 'department_admin' | 'viewer'>('member')
  const [isInviting, setIsInviting] = useState(false)
  const effectiveInviteDepartmentId = inviteDepartmentId
    || (!isOrgAdmin && uploadInfo?.departments?.length === 1 ? uploadInfo.departments[0]._id : '')
  const canUploadOrgWide = isOrgAdmin || uploadInfo?.role === 'org_admin'
  const uploadDepartments = isOrgAdmin ? (departments ?? []) : (uploadInfo?.departments ?? [])
  const fixedUploadDepartment = !canUploadOrgWide ? uploadDepartments[0] : undefined
  const effectiveUploadVisibility = canUploadOrgWide ? uploadVisibility : 'department'
  const effectiveUploadDepartmentId =
    effectiveUploadVisibility === 'department'
      ? uploadDepartmentId ||
        (!canUploadOrgWide && fixedUploadDepartment
          ? fixedUploadDepartment._id
          : '')
      : ''

  async function handleInviteUser() {
    const email = inviteEmail.trim()
    if (!email || isInviting) return

    setIsInviting(true)
    setMessage(null)
    setError(null)

    try {
      const result = await inviteUser({
        organizationId,
        email,
        role: inviteRole,
        departmentId: effectiveInviteDepartmentId || undefined,
        departmentRole: effectiveInviteDepartmentId ? inviteDepartmentRole : undefined,
      })
      setInviteEmail('')
      setMessage(
        result.userAlreadyExists
          ? `${email} already has an account — they can sign in now to get access.`
          : `Invitation sent to ${email}`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite failed')
    } finally {
      setIsInviting(false)
    }
  }

  async function handleIngest() {
    setIsIngesting(true)
    setMessage(null)
    setError(null)

    try {
      const result = await ingestDummyManual({ organizationId })
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
      const uploadUrl = await generateManualUploadUrl({
        organizationId,
        visibility: effectiveUploadVisibility,
        departmentId: effectiveUploadVisibility === 'department' && effectiveUploadDepartmentId
          ? effectiveUploadDepartmentId
          : undefined,
      })
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
        organizationId,
        storageId,
        title,
        sourceFileName: selectedFile.name,
        mimeType: selectedFile.type || '',
        sizeBytes: selectedFile.size,
        visibility: effectiveUploadVisibility,
        departmentId: effectiveUploadVisibility === 'department' && effectiveUploadDepartmentId
          ? effectiveUploadDepartmentId
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
      await createDepartment({ organizationId, name })
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
        organizationId,
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
        <p>Managing {activeOrganization.name}</p>
      </div>

      {isSystemAdmin ? (
        <div className="admin-demo-banner">
          <div>
            <strong>Cohort demo workspace</strong>
            <span>Create the isolated demo organization and sample departments.</span>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void ensureCohortDemoOrganization()
                .then((result) => {
                  setMessage(`Ready: ${result.organization.name}`)
                })
                .catch((err) =>
                  setError(err instanceof Error ? err.message : 'Demo setup failed'),
                )
            }}
          >
            Create demo org
          </button>
        </div>
      ) : null}

      {showAllManuals ? (
        <AllManualsModal
          manuals={manuals}
          onClose={() => setShowAllManuals(false)}
          onRetry={(ingestionJobId) => {
            void retryIndexing({ organizationId, ingestionJobId }).then(() => setMessage('Retry indexing queued')).catch((err) => setError(err instanceof Error ? err.message : 'Retry failed'))
          }}
          onArchive={(manualId) => {
            void archiveManual({ organizationId, manualId }).then(() => setMessage('Manual archived')).catch((err) => setError(err instanceof Error ? err.message : 'Archive failed'))
          }}
          onRestore={(manualId) => {
            void restoreManual({ organizationId, manualId }).then(() => setMessage('Manual restored')).catch((err) => setError(err instanceof Error ? err.message : 'Restore failed'))
          }}
        />
      ) : null}

      <div className="admin-grid">
        <div className="admin-left">
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
              <span className="file-types">PDF, TXT, MD, or DOCX up to 25 MB</span>
              <input
                type="file"
                accept=".pdf,.txt,.md,.docx,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
              value={effectiveUploadVisibility}
              onChange={(event) => {
                const v = event.target.value as 'org' | 'department'
                setUploadVisibility(v)
                if (v === 'org') setUploadDepartmentId('')
              }}
              disabled={isUploading || !canUploadOrgWide}
            >
              {canUploadOrgWide ? <option value="org">Organization-wide</option> : null}
              <option value="department">Department only</option>
            </select>
          </label>
          {effectiveUploadVisibility === 'department' && !canUploadOrgWide ? (
            <label className="field-label">
              Department
              <div className="field-static">
                {fixedUploadDepartment?.name ?? 'No department assigned'}
              </div>
            </label>
          ) : effectiveUploadVisibility === 'department' ? (
            <label className="field-label">
              Department
              <select
                value={effectiveUploadDepartmentId}
                onChange={(event) =>
                  setUploadDepartmentId(event.target.value as DepartmentId | '')
                }
                disabled={isUploading}
              >
                <option value="">Select department</option>
                {uploadDepartments.map(
                  (dept: Department) => (
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
              (effectiveUploadVisibility === 'org' && !canUploadOrgWide) ||
              (effectiveUploadVisibility === 'department' && !effectiveUploadDepartmentId)
            }
            onClick={() => void handleUploadManual()}
          >
            {isUploading ? 'Uploading...' : 'Upload and index manual'}
          </button>
          <div className="admin-divider">Test fixture</div>
          <button
            type="button"
            className="btn"
            disabled={isIngesting || isUploading || !canUploadOrgWide}
            onClick={() => void handleIngest()}
          >
            {isIngesting ? 'Indexing...' : 'Ingest dummy manual'}
          </button>
          {message ? <div className="inline-success">{message}</div> : null}
          {error ? <div className="inline-error">{error}</div> : null}
          {isOrgAdmin ? (
            <>
              <div className="admin-divider">Debug</div>
              <button
                type="button"
                className="btn"
                onClick={() => setShowDebug((v) => !v)}
              >
                {showDebug ? 'Hide manual state' : 'Show manual state'}
              </button>
              {showDebug && debugState ? (
                <pre className="debug-output">{JSON.stringify(debugState, null, 2)}</pre>
              ) : null}
            </>
          ) : null}
        </section>

        <section className="manual-panel admin-org-panel">
          <div>
            <h2>Invite user</h2>
            <p>Send an invitation email. Users appear after sign-up.</p>
          </div>
          <label className="field-label">
            Email
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="user@example.com"
              disabled={isInviting}
            />
          </label>
          {isOrgAdmin ? (
            <label className="field-label">
              Org role
              <select
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as 'member' | 'org_admin' | 'viewer')
                }
                disabled={isInviting}
              >
                <option value="member">Member</option>
                <option value="org_admin">Org admin</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
          ) : null}
          <label className="field-label">
            Department (optional)
            <select
              value={effectiveInviteDepartmentId}
              onChange={(event) =>
                setInviteDepartmentId(event.target.value as DepartmentId | '')
              }
              disabled={isInviting || (!isOrgAdmin && (uploadInfo?.departments ?? []).length <= 1)}
            >
              <option value="">No department</option>
              {(isOrgAdmin ? (departments ?? []) : (uploadInfo?.departments ?? [])).map(
                (dept: Department) => (
                  <option value={dept._id} key={dept._id}>
                    {dept.name}
                  </option>
                ),
              )}
            </select>
          </label>
          {effectiveInviteDepartmentId && isOrgAdmin ? (
            <label className="field-label">
              Department role
              <select
                value={inviteDepartmentRole}
                onChange={(event) =>
                  setInviteDepartmentRole(
                    event.target.value as 'member' | 'department_admin' | 'viewer',
                  )
                }
                disabled={isInviting}
              >
                <option value="member">Member</option>
                <option value="department_admin">Department admin</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!inviteEmail.trim() || isInviting}
            onClick={() => void handleInviteUser()}
          >
            {isInviting ? 'Sending...' : 'Send invitation'}
          </button>
          {(invites ?? []).length > 0 ? (
            <div className="compact-list-scroll" aria-label="Pending invites">
              <div className="history-group-label">Invitations</div>
              {(invites ?? []).map((invite: Invite) => (
                <div className="compact-row" key={invite._id}>
                  <div>
                    <strong>{invite.email}</strong>
                    <span>
                      {invite.role}
                      {invite.departmentRole ? ` / ${invite.departmentRole}` : ''}
                      {' — '}
                      {invite.status}
                    </span>
                  </div>
                  {invite.status === 'pending' ? (
                    <button
                      type="button"
                      className="btn-small btn-danger"
                      onClick={() => {
                        if (confirm(`Revoke invite for ${invite.email}?`)) {
                          void revokeInviteAction({ organizationId, inviteId: invite._id })
                            .then(() => setMessage('Invite revoked'))
                            .catch((err) =>
                              setError(err instanceof Error ? err.message : 'Revoke failed'),
                            )
                        }
                      }}
                    >
                      Revoke
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>
        </div>{/* end admin-left */}

        <div className="admin-right">
        <RecentManualsList
          manuals={manuals}
          onViewAll={() => setShowAllManuals(true)}
          onRetry={(ingestionJobId) => {
            void retryIndexing({ organizationId, ingestionJobId }).then(() => {
              setMessage('Retry indexing queued')
            }).catch((err) => {
              setError(err instanceof Error ? err.message : 'Retry failed')
            })
          }}
          onArchive={(manualId) => {
            void archiveManual({ organizationId, manualId }).then(() => {
              setMessage('Manual archived')
            }).catch((err) => {
              setError(err instanceof Error ? err.message : 'Archive failed')
            })
          }}
          onRestore={(manualId) => {
            void restoreManual({ organizationId, manualId }).then(() => {
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
                void archiveDepartment({ organizationId, departmentId }).then(() => {
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
                void suspendUser({ organizationId, userId }).then(() => {
                  setMessage('User suspended')
                }).catch((err) => {
                  setError(err instanceof Error ? err.message : 'Suspend failed')
                })
              }}
              onUnsuspend={(userId) => {
                void unsuspendUser({ organizationId, userId }).then(() => {
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
                  organizationId,
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
        </div>{/* end admin-right */}
      </div>{/* end admin-grid */}
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
    return <div className="compact-list-scroll"><span className="compact-empty">Select a department to view members</span></div>
  }

  return (
    <div className="compact-list-scroll" aria-label="Department members">
      {members.length === 0 ? (
        <span className="compact-empty">No members assigned to this department</span>
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
    <div className="compact-list-scroll" aria-label="Departments">
      {departments === undefined ? (
        <span className="compact-empty">Loading departments...</span>
      ) : rows.length === 0 ? (
        <span className="compact-empty">No departments yet</span>
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
      <div className="compact-list-scroll">
      {users === undefined ? (
        <span className="compact-empty">Loading users...</span>
      ) : filtered.length === 0 ? (
        <span className="compact-empty">{search ? 'No matching users' : 'No users yet'}</span>
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
      </div>{/* end compact-list-scroll */}
    </div>
  )
}

const RECENT_MANUALS_LIMIT = 6

function RecentManualsList({
  manuals,
  onViewAll,
  onRetry,
  onArchive,
  onRestore,
}: {
  manuals: ManualListItem[] | undefined
  onViewAll: () => void
  onRetry: (ingestionJobId: Id<'ingestionJobs'>) => void
  onArchive: (manualId: Id<'manuals'>) => void
  onRestore: (manualId: Id<'manuals'>) => void
}) {
  const recent = useMemo(() => (manuals ?? []).slice(0, RECENT_MANUALS_LIMIT), [manuals])
  const total = manuals?.length ?? 0

  return (
    <section className="manual-panel admin-org-panel" aria-label="Recent manuals">
      <div className="admin-card-header">
        <div>
          <h2>Recent manuals</h2>
          <p>Latest uploads and their indexing status.</p>
        </div>
      </div>
      {manuals === undefined ? (
        <div className="manual-row muted-row">Loading manuals...</div>
      ) : recent.length === 0 ? (
        <div className="manual-row muted-row">No manuals uploaded yet</div>
      ) : (
        <div className="recent-manual-rows">
          {recent.map((manual) => (
            <ManualRow
              key={manual._id}
              manual={manual}
              onRetry={onRetry}
              onArchive={onArchive}
              onRestore={onRestore}
            />
          ))}
        </div>
      )}
      <div className="admin-card-footer">
        {total > 0 ? (
          <span className="admin-card-count">
            Showing {Math.min(RECENT_MANUALS_LIMIT, total)} of {total}
          </span>
        ) : null}
        <button
          type="button"
          className="btn-link"
          onClick={onViewAll}
        >
          View all manuals →
        </button>
      </div>
    </section>
  )
}

const STATUS_FILTERS = ['all', 'active', 'indexing', 'failed', 'archived'] as const
type StatusFilter = typeof STATUS_FILTERS[number]

function AllManualsModal({
  manuals,
  onClose,
  onRetry,
  onArchive,
  onRestore,
}: {
  manuals: ManualListItem[] | undefined
  onClose: () => void
  onRetry: (ingestionJobId: Id<'ingestionJobs'>) => void
  onArchive: (manualId: Id<'manuals'>) => void
  onRestore: (manualId: Id<'manuals'>) => void
}) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = useMemo(() => {
    const rows = manuals ?? []
    const term = search.trim().toLowerCase()
    return rows.filter((manual) => {
      const matchesSearch = !term || manual.title.toLowerCase().includes(term)
      // manual.status is the source of truth for archived/active.
      // latestIngestionJob.status reflects indexing progress (queued/indexing/active/failed)
      // and never transitions to 'archived', so using it for the filter would hide
      // archived manuals entirely.
      const displayStatus =
        manual.status === 'archived'
          ? 'archived'
          : (manual.latestIngestionJob?.status ?? manual.status)
      const matchesStatus = statusFilter === 'all' || displayStatus === statusFilter
      return matchesSearch && matchesStatus
    })
  }, [manuals, search, statusFilter])

  const total = manuals?.length ?? 0

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-panel" role="dialog" aria-label="All manuals" aria-modal="true">
        <div className="modal-header">
          <div>
            <h2>All manuals</h2>
            <p>{total} {total === 1 ? 'manual' : 'manuals'} total</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-controls">
          <input
            type="text"
            className="user-search"
            placeholder="Search manuals..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="modal-filter-pills">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={`filter-pill${statusFilter === f ? ' filter-pill-active' : ''}`}
                onClick={() => setStatusFilter(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-list">
          {manuals === undefined ? (
            <div className="manual-row muted-row">Loading manuals...</div>
          ) : filtered.length === 0 ? (
            <div className="manual-row muted-row">
              {search || statusFilter !== 'all' ? 'No matching manuals' : 'No manuals uploaded yet'}
            </div>
          ) : (
            filtered.map((manual) => (
              <ManualRow
                key={manual._id}
                manual={manual}
                onRetry={onRetry}
                onArchive={onArchive}
                onRestore={onRestore}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function ManualRow({
  manual,
  onRetry,
  onArchive,
  onRestore,
}: {
  manual: ManualListItem
  onRetry?: (ingestionJobId: Id<'ingestionJobs'>) => void
  onArchive?: (manualId: Id<'manuals'>) => void
  onRestore?: (manualId: Id<'manuals'>) => void
}) {
  return (
    <div className="manual-row">
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
        <mark>{manual.status === 'archived' ? 'archived' : (manual.latestIngestionJob?.status ?? manual.status)}</mark>
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
          <ManualRow
            key={manual._id}
            manual={manual}
            onRetry={onRetry}
            onArchive={onArchive}
            onRestore={onRestore}
          />
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
  onDeleteChat,
}: {
  label: string
  sessions: ChatSession[]
  selectedChatId: ChatSessionId | null
  onOpenChat: (session: ChatSession) => void
  onTogglePinned: (session: ChatSession) => void
  onDeleteChat: (session: ChatSession) => void
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
            <span>{session.title || 'New chat'}</span>
            {session.manualTitles && session.manualTitles.length > 0 ? (
              <span className="history-scope">
                {formatScopeLabel(session.manualTitles)}
              </span>
            ) : null}
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
          <button
            type="button"
            className="delete-button"
            aria-label="Delete chat"
            title="Delete chat"
            onClick={(event) => {
              event.stopPropagation()
              onDeleteChat(session)
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4h6v2" />
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
    return 'Only PDF, TXT, MD, and DOCX manuals are supported.'
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


function formatScopeLabel(titles: string[]): string {
  if (titles.length === 0) return ''
  if (titles.length === 1) return titles[0]
  const first = titles[0]
  const rest = titles.length - 1
  const candidate = `${first} + ${rest} document${rest !== 1 ? 's' : ''}`
  return candidate.length <= 38 ? candidate : `${first.slice(0, 22)}… + ${rest} document${rest !== 1 ? 's' : ''}`
}

function BrandMark({
  compact = false,
  organizationSlug,
}: {
  compact?: boolean
  organizationSlug?: string
}) {
  const useExecuJetLogo = organizationSlug !== undefined && organizationSlug !== demoOrganizationSlug
  const logoUrl = useExecuJetLogo ? execuJetLogoUrl : prettiflowLogoUrl
  const logoAlt = useExecuJetLogo ? 'ExecuJet' : 'Prettiflow'

  return (
    <div className={compact ? 'brand-mark compact' : 'brand-mark'}>
      <img src={logoUrl} alt={logoAlt} />
      <span>Manual Assistant</span>
    </div>
  )
}

export default App
