/**
 * ValidationAgent — AI chat panel for the Validation page.
 *
 * Design:
 * - Opened via the "AI Assistant" button in the bottom nav bar (no floating button)
 * - externalOpen / onOpenChange for parent-controlled open state
 * - Fix cards collapse as soon as they are applied/rejected
 * - ManualFixCard for when AI asks the user for the correct value
 * - onFixApplied(row, column) so parent can instantly remove the row from the error table
 */

import { useState, useRef, useEffect } from 'react'
import {
  Bot, X, Send, Minimize2, Maximize2, Sparkles,
  CheckCircle, XCircle, Loader2, MessageSquare,
  Lightbulb, Wrench, ChevronDown, Database,
} from 'lucide-react'
import { api } from '../../services/api'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SuggestedFix {
  row_number: number
  column: string
  new_value: string
}

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  suggestedFix?: SuggestedFix | null
  needsUserInput?: boolean   // AI asked a question — show manual input form
  fixApplied?: boolean       // fix was applied — collapse card
  fixRejected?: boolean      // fix was ignored — collapse card
  loading?: boolean
}

interface ValidationAgentProps {
  invalidCount: number
  externalOpen: boolean
  onOpenChange: (open: boolean) => void
  onFixApplied?: (fixedRow: number, fixedColumn: string) => void
}

// ── Quick-prompts ─────────────────────────────────────────────────────────────

const QUICK_PROMPTS = [
  { icon: Lightbulb,     label: 'Explain all errors',     text: 'Can you summarise all the validation errors I have?' },
  { icon: Wrench,        label: 'How do I fix these?',    text: 'What is the best way to fix the validation errors?' },
  { icon: MessageSquare, label: 'Which fields fail most?',text: 'Which fields have the most validation failures and why?' },
  { icon: Sparkles,      label: 'Can I proceed anyway?',  text: 'Can I migrate with these errors or do I need to fix them first?' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return `${Date.now()}-${Math.random().toString(36).slice(2)}` }

function stripFixMarker(text: string) {
  return text.replace(/FIX:\s*\{[^{}]+\}/g, '').trim()
}

function detectNeedsUserInput(text: string): boolean {
  const l = text.toLowerCase()
  return !text.includes('FIX:') && (
    l.includes('what value') || l.includes('what should') || l.includes('please type') ||
    l.includes('what is the') || l.includes('what would') || l.includes("what's the") ||
    l.includes('please provide') || l.includes('can you tell me') || l.includes('could you provide')
  )
}

// ── Manual fix card (when AI asks the user to supply the value) ───────────────

function ManualFixCard({ msg, onSubmit }: {
  msg: Message
  onSubmit: (msgId: string, value: string, row: number, col: string) => void
}) {
  const [value, setValue] = useState('')
  const [row,   setRow  ] = useState('')
  const [col,   setCol  ] = useState('')
  const [done,  setDone ] = useState(false)

  if (done) return (
    <div className="flex items-center gap-1.5 text-xs mt-1" style={{ color: '#059669' }}>
      <CheckCircle size={12} /> Value submitted
    </div>
  )

  const canSubmit = value.trim() && row && col

  return (
    <div className="w-full rounded-xl p-3 space-y-2 mt-1"
      style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)' }}>
      <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: '#6366f1' }}>
        ✏️ Enter the correct value
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs mb-0.5 block" style={{ color: '#64748b' }}>Row #</label>
          <input type="number" value={row} onChange={e => setRow(e.target.value)}
            placeholder="e.g. 3"
            className="w-full rounded-lg px-2 py-1.5 text-xs outline-none"
            style={{ background: '#fff', border: '1px solid #e2e8f0', color: '#0f172a' }} />
        </div>
        <div>
          <label className="text-xs mb-0.5 block" style={{ color: '#64748b' }}>Column</label>
          <input type="text" value={col} onChange={e => setCol(e.target.value)}
            placeholder="e.g. companyname"
            className="w-full rounded-lg px-2 py-1.5 text-xs outline-none"
            style={{ background: '#fff', border: '1px solid #e2e8f0', color: '#0f172a' }} />
        </div>
      </div>
      <div>
        <label className="text-xs mb-0.5 block" style={{ color: '#64748b' }}>New value</label>
        <input type="text" value={value} onChange={e => setValue(e.target.value)}
          placeholder="Type the correct value…"
          className="w-full rounded-lg px-2 py-1.5 text-xs outline-none"
          style={{ background: '#fff', border: '1px solid #e2e8f0', color: '#0f172a' }}
          onKeyDown={e => {
            if (e.key === 'Enter' && canSubmit) {
              setDone(true)
              onSubmit(msg.id, value.trim(), parseInt(row), col.trim())
            }
          }} />
      </div>
      <button disabled={!canSubmit}
        onClick={() => { if (canSubmit) { setDone(true); onSubmit(msg.id, value.trim(), parseInt(row), col.trim()) } }}
        className="w-full py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
        style={{ background: 'linear-gradient(135deg,#6366f1,#06b6d4)', color: '#fff' }}>
        Apply This Fix
      </button>
    </div>
  )
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg, onApplyFix, onRejectFix, onManualFix }: {
  msg: Message
  onApplyFix: (fix: SuggestedFix, msgId: string) => void
  onRejectFix: (msgId: string) => void
  onManualFix: (msgId: string, value: string, row: number, col: string) => void
}) {
  const isUser   = msg.role === 'user'
  const isSystem = msg.role === 'system'

  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs px-3 py-1 rounded-full"
          style={{ background: 'rgba(99,102,241,0.1)', color: '#818cf8' }}>
          {msg.content}
        </span>
      </div>
    )
  }

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          style={{ background: 'linear-gradient(135deg,#6366f1,#06b6d4)' }}>
          <Bot size={13} className="text-white" />
        </div>
      )}
      <div className={`flex flex-col gap-1 max-w-[84%] ${isUser ? 'items-end' : 'items-start'}`}>
        {/* Speech bubble */}
        <div className="px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed"
          style={isUser
            ? { background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', borderBottomRightRadius: 4 }
            : { background: '#f8fafc', border: '1px solid #e2e8f0', color: '#0f172a', borderBottomLeftRadius: 4 }}>
          {msg.loading
            ? <div className="flex items-center gap-2" style={{ color: '#94a3b8' }}>
                <Loader2 size={14} className="animate-spin" />
                <span className="text-xs">Thinking…</span>
              </div>
            : <span style={{ whiteSpace: 'pre-wrap' }}>{stripFixMarker(msg.content)}</span>}
        </div>

        {/* ── AI-suggested fix card — hidden once applied or rejected ── */}
        {msg.suggestedFix && !msg.loading && !msg.fixApplied && !msg.fixRejected && (
          <div className="w-full rounded-xl p-3 space-y-2"
            style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.3)' }}>
            <p className="font-semibold text-xs uppercase tracking-wide" style={{ color: '#f59e0b' }}>
              ✨ Suggested Fix
            </p>
            {[
              { label: 'Row',       val: `#${msg.suggestedFix.row_number}` },
              { label: 'Column',    val: msg.suggestedFix.column },
              { label: 'New value', val: msg.suggestedFix.new_value },
            ].map(({ label, val }) => (
              <div key={label} className="flex justify-between text-xs" style={{ color: '#475569' }}>
                <span>{label}</span>
                <span className="font-mono font-semibold px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(16,185,129,0.1)', color: '#059669' }}>{val}</span>
              </div>
            ))}
            <div className="flex items-center gap-1.5 text-xs py-1 px-2 rounded-lg"
              style={{ background: 'rgba(6,182,212,0.07)', color: '#0891b2' }}>
              <Database size={10} />
              Saves to DuckDB raw_data table
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => onApplyFix(msg.suggestedFix!, msg.id)}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', color: '#059669' }}>
                <CheckCircle size={12} /> Apply Fix
              </button>
              <button onClick={() => onRejectFix(msg.id)}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444' }}>
                <XCircle size={12} /> Ignore
              </button>
            </div>
          </div>
        )}

        {/* ── Manual input form — hidden once submitted ── */}
        {msg.needsUserInput && !msg.loading && !msg.fixApplied && !msg.fixRejected && (
          <ManualFixCard msg={msg} onSubmit={onManualFix} />
        )}

        {/* ── Result badges (replace the card after action) ── */}
        {msg.fixApplied && (
          <div className="flex items-center gap-1.5 text-xs" style={{ color: '#059669' }}>
            <CheckCircle size={12} /> Fixed — row removed from error list
          </div>
        )}
        {msg.fixRejected && (
          <div className="flex items-center gap-1.5 text-xs" style={{ color: '#94a3b8' }}>
            Ignored
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ValidationAgent({
  invalidCount,
  externalOpen,
  onOpenChange,
  onFixApplied,
}: ValidationAgentProps) {
  const [minimised, setMinimised] = useState(false)
  const [input,     setInput    ] = useState('')
  const [sending,   setSending  ] = useState(false)
  const [messages,  setMessages ] = useState<Message[]>([])
  const [pendingExplain, setPendingExplain] = useState<number | null>(null)

  const bottomRef      = useRef<HTMLDivElement>(null)
  const inputRef       = useRef<HTMLTextAreaElement>(null)
  const sendMessageRef = useRef<(text: string) => void>(() => {})

  // Greeting when panel first opens
  useEffect(() => {
    if (externalOpen && messages.length === 0) {
      setMinimised(false)
      setMessages([{
        id: uid(), role: 'assistant',
        content: invalidCount > 0
          ? `Hi! I can see ${invalidCount} invalid record${invalidCount !== 1 ? 's' : ''} in this project.\n\nI can explain each error, suggest a fix, or ask you for the correct value when I don't know it. Fixes are saved directly into your source data and the error row disappears from the table.\n\nWhich row or field would you like to fix first?`
          : `Your data looks clean — no validation errors! 🎉\n\nFeel free to ask me anything about the validation results or how to proceed.`,
      }])
    }
  }, [externalOpen])

  // Expand when re-opened if it was minimised
  useEffect(() => {
    if (externalOpen) setMinimised(false)
  }, [externalOpen])

  // Fire queued explain once panel is open and greeting rendered
  useEffect(() => {
    if (externalOpen && !minimised && pendingExplain !== null && messages.length > 0) {
      const row = pendingExplain
      setPendingExplain(null)
      sendMessageRef.current(`Explain the validation error on row ${row} and tell me how to fix it.`)
    }
  }, [externalOpen, minimised, pendingExplain, messages.length])

  // Listen for inline Explain button events
  useEffect(() => {
    const handler = (e: Event) => {
      const rowNumber = (e as CustomEvent<{ rowNumber: number }>).detail.rowNumber
      onOpenChange(true)
      setMinimised(false)
      setPendingExplain(rowNumber)
    }
    window.addEventListener('databridge:explain-row', handler)
    return () => window.removeEventListener('databridge:explain-row', handler)
  }, [])

  // Auto-scroll to bottom
  useEffect(() => {
    if (externalOpen && !minimised)
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, externalOpen, minimised])

  function buildHistory() {
    return messages
      .filter(m => !m.loading && m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }))
  }

  async function sendMessage(text: string) {
    if (!text.trim() || sending) return

    const userMsg: Message    = { id: uid(), role: 'user',      content: text.trim() }
    const loadingMsg: Message = { id: uid(), role: 'assistant', content: '', loading: true }

    setMessages(prev => [...prev, userMsg, loadingMsg])
    setInput('')
    setSending(true)

    try {
      const history = buildHistory()
      history.push({ role: 'user', content: text.trim() })
      const res = await api.askValidationAgent(text.trim(), history)
      const needsInput = detectNeedsUserInput(res.answer)
      setMessages(prev => prev.map(m =>
        m.id === loadingMsg.id
          ? { ...m, content: res.answer, loading: false, suggestedFix: res.suggested_fix ?? null, needsUserInput: needsInput }
          : m
      ))
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === loadingMsg.id
          ? { ...m, content: `Sorry, I ran into an error: ${err instanceof Error ? err.message : 'Unknown error'}.`, loading: false }
          : m
      ))
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  // Always keep ref fresh so event handlers don't get stale closures
  sendMessageRef.current = sendMessage

  async function handleApplyFix(fix: SuggestedFix, msgId: string) {
    // Immediately collapse the fix card
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, fixApplied: true, suggestedFix: null, needsUserInput: false } : m
    ))

    try {
      const result = await api.applyValidationFix(fix)

      if (result.success) {
        // Confirm message
        setMessages(prev => [...prev, {
          id: uid(), role: 'system',
          content: `✅ Row ${fix.row_number} · "${fix.column}" → "${fix.new_value}" — removed from error list`,
        }])
        // Tell parent to remove the row from the table and refresh counts
        onFixApplied?.(fix.row_number, fix.column)
      } else {
        // Undo the optimistic collapse and show error
        setMessages(prev => prev.map(m =>
          m.id === msgId ? { ...m, fixApplied: false, suggestedFix: fix } : m
        ))
        setMessages(prev => [...prev, {
          id: uid(), role: 'system',
          content: `❌ Fix failed: ${result.message}`,
        }])
      }
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, fixApplied: false, suggestedFix: fix } : m
      ))
      setMessages(prev => [...prev, {
        id: uid(), role: 'system',
        content: `❌ Could not apply fix: ${err instanceof Error ? err.message : 'Unknown error'}`,
      }])
    }
  }

  async function handleManualFix(msgId: string, value: string, row: number, col: string) {
    // Collapse the input card immediately
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, fixApplied: true, needsUserInput: false } : m
    ))
    await handleApplyFix({ row_number: row, column: col, new_value: value }, msgId)
  }

  function handleRejectFix(msgId: string) {
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, fixRejected: true, suggestedFix: null, needsUserInput: false } : m
    ))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) }
  }

  if (!externalOpen) return null

  return (
    <div
      className="fixed bottom-20 right-6 z-50 flex flex-col rounded-2xl shadow-2xl overflow-hidden"
      style={{
        width: 400,
        height: minimised ? 56 : 560,
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        boxShadow: '0 20px 60px rgba(0,0,0,0.15), 0 0 0 1px rgba(99,102,241,0.1)',
      }}
      role="dialog"
      aria-label="AI Validation Assistant"
    >
      {/* Header */}
      <div
        className="flex items-center gap-2.5 px-4 py-3 shrink-0 cursor-pointer"
        style={{ background: 'linear-gradient(135deg,#6366f1,#4f46e5)', borderBottom: minimised ? 'none' : '1px solid rgba(255,255,255,0.1)' }}
        onClick={() => setMinimised(m => !m)}
      >
        <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
          style={{ background: 'rgba(255,255,255,0.2)' }}>
          <Bot size={14} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-sm font-semibold leading-tight">AI Validation Assistant</p>
          <p className="text-xs leading-tight" style={{ color: 'rgba(255,255,255,0.7)' }}>
            Groq · Llama 3.3 · fixes update the error table live
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={e => { e.stopPropagation(); setMinimised(m => !m) }}
            className="p-1.5 rounded-lg hover:bg-white/10"
            aria-label={minimised ? 'Expand' : 'Minimise'}>
            {minimised ? <Maximize2 size={14} className="text-white" /> : <Minimize2 size={14} className="text-white" />}
          </button>
          <button onClick={e => { e.stopPropagation(); onOpenChange(false) }}
            className="p-1.5 rounded-lg hover:bg-white/10" aria-label="Close">
            <X size={14} className="text-white" />
          </button>
        </div>
      </div>

      {!minimised && (
        <>
          {/* Messages area */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" style={{ background: '#fafafa' }}>
            {messages.map(msg => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                onApplyFix={handleApplyFix}
                onRejectFix={handleRejectFix}
                onManualFix={handleManualFix}
              />
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Quick prompts — only before any user message */}
          {messages.length <= 1 && !sending && (
            <div className="px-4 py-3 space-y-2 shrink-0"
              style={{ borderTop: '1px solid #e2e8f0', background: '#fff' }}>
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: '#94a3b8' }}>
                Quick questions
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {QUICK_PROMPTS.map(({ icon: Icon, label, text }) => (
                  <button key={label} onClick={() => sendMessage(text)}
                    className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium text-left"
                    style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)', color: '#4f46e5' }}>
                    <Icon size={11} className="shrink-0" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input bar */}
          <div className="px-3 py-3 shrink-0 flex items-end gap-2"
            style={{ borderTop: '1px solid #e2e8f0', background: '#fff' }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about errors or type a value to fix…"
              rows={1}
              disabled={sending}
              className="flex-1 resize-none rounded-xl px-3 py-2.5 text-sm outline-none"
              style={{ background: '#f8fafc', border: '1px solid #e2e8f0', color: '#0f172a', maxHeight: 100, lineHeight: '1.5', fontFamily: 'var(--font-body)' }}
              onInput={e => {
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, 100)}px`
              }}
              aria-label="Message input"
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || sending}
              className="w-9 h-9 rounded-xl flex items-center justify-center transition-all shrink-0"
              style={input.trim() && !sending
                ? { background: 'linear-gradient(135deg,#6366f1,#06b6d4)', boxShadow: '0 4px 12px rgba(99,102,241,0.35)' }
                : { background: '#e2e8f0', cursor: 'not-allowed' }}
              aria-label="Send message"
            >
              {sending
                ? <Loader2 size={15} className="text-white animate-spin" />
                : <Send size={15} style={{ color: input.trim() ? '#fff' : '#94a3b8' }} />}
            </button>
          </div>
        </>
      )}

      {minimised && (
        <div className="absolute bottom-1 left-1/2 -translate-x-1/2">
          <ChevronDown size={14} style={{ color: 'rgba(255,255,255,0.6)' }} />
        </div>
      )}
    </div>
  )
}

// ── Inline explain button ─────────────────────────────────────────────────────

export function ExplainRowButton({ rowNumber, onExplain }: {
  rowNumber: number
  onExplain: (n: number) => void
}) {
  return (
    <button
      onClick={() => onExplain(rowNumber)}
      className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded transition-all"
      style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', color: '#6366f1' }}
      title={`Ask AI to explain row ${rowNumber}`}
    >
      <Bot size={10} />
      Explain
    </button>
  )
}
