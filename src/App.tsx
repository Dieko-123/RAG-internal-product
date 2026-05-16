import { useMemo, useState } from 'react'
import { SignInButton, SignUpButton, UserButton } from '@clerk/react'
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useQuery,
} from 'convex/react'
import { api } from '../convex/_generated/api'
import './App.css'

const execuJetLogoUrl =
  'https://media.licdn.com/dms/image/v2/D560BAQHcWacpdT7w2g/company-logo_200_200/company-logo_200_200/0/1707910055365/execujet_aviation_nigeria_logo?e=1780531200&v=beta&t=yOA5GlxcctMGeHof44i6MrvnIY7oYuplHaAe45MlUS4'

type View = 'chat' | 'documents'

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
  const currentUser = useQuery(api.users.getCurrentUser)
  const displayName = useMemo(() => {
    if (!currentUser) return ''
    return currentUser.name ?? currentUser.email ?? 'User'
  }, [currentUser])

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
        <div className="sidebar-footer">
          <UserButton />
          <div>
            <div className="user-name">{displayName}</div>
          </div>
        </div>
      </aside>

      <div className="main-panel">
        {view === 'chat' ? <ChatWorkspace /> : <DocumentsWorkspace />}
      </div>
    </section>
  )
}

function ChatWorkspace() {
  return (
    <>
      <div className="page-header">
        <h1>Ask a question</h1>
        <p>Search across your uploaded manuals and documents</p>
      </div>

      <div className="connection-status">
        <span className="status-dot" />
        Connected
      </div>

      <div className="chat-container">
        <div className="messages-area">
          <div className="message-empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            Ask anything about your internal documentation
          </div>
        </div>

        <div className="composer">
          <textarea
            aria-label="Ask a question"
            placeholder="What would you like to know?"
            rows={1}
            disabled
          />
          <button type="button" className="btn btn-primary" disabled>
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
  return (
    <>
      <div className="page-header">
        <h1>Documents</h1>
        <p>Upload and manage manuals for the knowledge base</p>
      </div>

      <div className="upload-zone">
        <div className="drop-area">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <p>
            Drop files here or <strong>browse</strong>
          </p>
          <span className="file-types">PDF, DOCX, TXT</span>
        </div>
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
