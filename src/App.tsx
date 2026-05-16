import { useMemo, useState } from 'react'
import { SignInButton, SignUpButton, UserButton } from '@clerk/react'
import {
  Authenticated,
  AuthLoading,
  useAction,
  Unauthenticated,
  useQuery,
} from 'convex/react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import './App.css'

const execuJetLogoUrl =
  'https://media.licdn.com/dms/image/v2/D560BAQHcWacpdT7w2g/company-logo_200_200/company-logo_200_200/0/1707910055365/execujet_aviation_nigeria_logo?e=1780531200&v=beta&t=yOA5GlxcctMGeHof44i6MrvnIY7oYuplHaAe45MlUS4'

type View = 'chat' | 'documents'

type ManualListItem = {
  _id: string
  title: string
  slug: string
  status: string
}

type ChatSessionId = Id<'chatSessions'>

function App() {
  return (
    <main className="app">
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
    </main>
  )
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
  const [view, setView] = useState<View>('chat')
  const [selectedChatId, setSelectedChatId] = useState<ChatSessionId | null>(null)
  const currentUser = useQuery(api.users.getCurrentUser)
  const chatSessions = useQuery(api.chats.listChatSessions)
  const displayName = useMemo(() => {
    if (!currentUser) return ''
    return currentUser.name ?? currentUser.email ?? 'User'
  }, [currentUser])

  function startNewChat() {
    setView('chat')
    setSelectedChatId(null)
  }

  return (
    <section className="console">
      <aside className="sidebar">
        <BrandMark />
        <nav className="nav-list" aria-label="Navigation">
          <button
            type="button"
            className={view === 'chat' ? 'nav-item active' : 'nav-item'}
            onClick={() => setView('chat')}
          >
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Ask
          </button>
          <button
            type="button"
            className={view === 'documents' ? 'nav-item active' : 'nav-item'}
            onClick={() => setView('documents')}
          >
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            Documents
          </button>
        </nav>
        {view === 'chat' ? (
          <section className="chat-history" aria-label="Previous chats">
            <button type="button" className="new-chat-button" onClick={startNewChat}>
              <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              New chat
            </button>
            <div className="history-list">
              {(chatSessions ?? []).length === 0 ? (
                <span className="history-empty">No previous chats</span>
              ) : (
                chatSessions?.map((session) => (
                  <button
                    type="button"
                    key={session._id}
                    className={
                      selectedChatId === session._id
                        ? 'history-item active'
                        : 'history-item'
                    }
                    onClick={() => {
                      setView('chat')
                      setSelectedChatId(session._id)
                    }}
                  >
                    <span>{session.title}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        ) : null}
        <div className="sidebar-footer">
          <UserButton />
          <div className="sidebar-user">
            <div className="user-name">{displayName}</div>
          </div>
        </div>
      </aside>

      <div className="main-panel">
        {view === 'chat' ? (
          <ChatWorkspace
            selectedChatId={selectedChatId}
            onSelectChat={setSelectedChatId}
          />
        ) : (
          <DocumentsWorkspace />
        )}
      </div>
    </section>
  )
}

function ChatWorkspace({
  selectedChatId,
  onSelectChat,
}: {
  selectedChatId: ChatSessionId | null
  onSelectChat: (chatSessionId: ChatSessionId | null) => void
}) {
  const activeManual = useQuery(api.manuals.getActiveManual)
  const messages = useQuery(api.chats.listChatMessages, {
    chatSessionId: selectedChatId ?? undefined,
  })
  const askManualQuestion = useAction(api.gemini.askManualQuestion)
  const [question, setQuestion] = useState('')
  const [isAsking, setIsAsking] = useState(false)
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const manualReady = Boolean(activeManual)
  const displayedMessages = messages ?? []

  async function handleAsk() {
    const trimmedQuestion = question.trim()
    if (!trimmedQuestion || isAsking) return

    setIsAsking(true)
    setPendingQuestion(trimmedQuestion)
    setQuestion('')
    setError(null)

    try {
      const result = await askManualQuestion({
        question: trimmedQuestion,
        chatSessionId: selectedChatId ?? undefined,
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

  return (
    <>
      <div className="page-header">
        <h1>Ask a question</h1>
        <p>
          {manualReady
            ? `Grounded on ${activeManual?.manual.title}`
            : 'Ingest the dummy manual before asking questions'}
        </p>
      </div>

      <div className="connection-status">
        <span className={manualReady ? 'status-dot' : 'status-dot status-idle'} />
        {activeManual === undefined
          ? 'Checking manual status'
          : manualReady
            ? 'Dummy manual active'
            : 'No active manual'}
      </div>

      <div className="chat-container">
        <div className="messages-area">
          {displayedMessages.length === 0 && !pendingQuestion ? (
            <div className="message-empty">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              Ask: What is the laptop reporting policy?
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
                  <p>{message.content}</p>
                  {message.role === 'assistant' ? (
                    <>
                      <div className="answer-meta">
                        {message.model ?? 'manual answer'}
                        {message.latencyMs ? ` / ${message.latencyMs}ms` : ''}
                        {message.sourceFileName ? ` / ${message.sourceFileName}` : ''}
                      </div>
                      {message.citations && message.citations.length > 0 ? (
                        <div className="citations">
                          {message.citations.map((citation, index) => (
                            <div className="citation" key={`${citation.uri ?? citation.title ?? index}`}>
                              <span>{citation.title ?? 'Manual source'}</span>
                              {citation.pageNumber ? <strong>Page {citation.pageNumber}</strong> : null}
                              {citation.excerpt ? <p>{citation.excerpt}</p> : null}
                            </div>
                          ))}
                        </div>
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
            placeholder={manualReady ? 'Ask about the dummy manual' : 'No active manual yet'}
            rows={1}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void handleAsk()
              }
            }}
            disabled={!manualReady || isAsking}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!manualReady || isAsking || !question.trim()}
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
    </>
  )
}

function DocumentsWorkspace() {
  const manuals = useQuery(api.manuals.listManuals)
  const manualRows: ManualListItem[] = manuals ?? []
  const ingestDummyManual = useAction(api.gemini.ingestDummyManual)
  const [isIngesting, setIsIngesting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <>
      <div className="page-header">
        <h1>Documents</h1>
        <p>Manage the Phase 1 dummy manual for Gemini File Search</p>
      </div>

      <div className="document-grid">
        <section className="manual-panel">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z" />
          </svg>
          <div>
            <h2>Dummy test manual</h2>
            <p>
              A non-confidential fixture with office hours, laptop, password,
              expense, and visitor policies.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={isIngesting}
            onClick={() => void handleIngest()}
          >
            {isIngesting ? 'Indexing...' : 'Ingest dummy manual'}
          </button>
          {message ? <div className="inline-success">{message}</div> : null}
          {error ? <div className="inline-error">{error}</div> : null}
        </section>

        <section className="manual-list" aria-label="Manual status">
          {manualRows.length === 0 ? (
            <div className="manual-row muted-row">No manuals indexed yet</div>
          ) : (
            manualRows.map((manual) => (
              <div className="manual-row" key={manual._id}>
                <div>
                  <strong>{manual.title}</strong>
                  <span>{manual.slug}</span>
                </div>
                <mark>{manual.status}</mark>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  )
}

function BrandMark() {
  return (
    <div className="brand-mark">
      <img src={execuJetLogoUrl} alt="ExecuJet" />
      <span>Manual Assistant</span>
    </div>
  )
}

export default App
