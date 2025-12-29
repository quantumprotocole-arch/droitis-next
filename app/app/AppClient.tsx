// app/app/AppClient.tsx
'use client'

import React, { useCallback, useMemo, useState, useEffect } from 'react'

type Source = {
  id?: string | number
  title?: string | null
  citation?: string | null
  jurisdiction?: string | null
  url?: string | null
}

type ApiResponse =
  | {
      answer: string
      sources: Source[]
      usage?: { top_k?: number; rpcOk?: boolean }
    }
  | {
      error: string
      details?: string
    }

type Props = {
  isActive: boolean
  status: string | null
}

const FREE_MODE_ENABLED = true
const FREE_SEND_LIMIT = 3
const LOCK_EVERY_NTH_SEND = 5
const LS_KEY = 'droitis_free_send_count_v1'

function PaywallBanner() {
  return (
    <div style={styles.paywall}>
      <div>
        <strong>Abonnement requis</strong>
        <div style={{ opacity: 0.85, marginTop: 4 }}>
          Tu es en mode gratuit : certaines fonctionnalités sont limitées.
        </div>
      </div>

      <form method="POST" action="/api/stripe/checkout">
        <button type="submit" style={styles.subscribeBtn}>
          S’abonner
        </button>
      </form>
    </div>
  )
}

export default function AppClient({ isActive, status }: Props) {
  const [message, setMessage] = useState('Explique l’art. 1457 C.c.Q.')
  const [profile, setProfile] = useState<string>('')
  const [topK, setTopK] = useState<number>(5)
  const [mode, setMode] = useState<string>('default')

  const [loading, setLoading] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const [answer, setAnswer] = useState<string>('')
  const [sources, setSources] = useState<Source[]>([])
  const [usage, setUsage] = useState<{ top_k?: number; rpcOk?: boolean } | undefined>(undefined)

  // Compteur “mode gratuit”
  const [freeSendsUsed, setFreeSendsUsed] = useState<number>(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const raw = window.localStorage.getItem(LS_KEY)
    const n = raw ? Number(raw) : 0
    setFreeSendsUsed(Number.isFinite(n) ? Math.max(0, n) : 0)
  }, [])

  const persistFreeCount = (n: number) => {
    setFreeSendsUsed(n)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LS_KEY, String(n))
    }
  }

  const canSend = useMemo(() => message.trim().length > 0 && !loading, [message, loading])

  const gatingCheck = () => {
    if (isActive) return { ok: true as const }

    if (!FREE_MODE_ENABLED) {
      return { ok: false as const, reason: 'Mode gratuit désactivé. Abonnement requis.' }
    }

    if (freeSendsUsed >= FREE_SEND_LIMIT) {
      return { ok: false as const, reason: `Limite gratuite atteinte (${FREE_SEND_LIMIT}). Abonnement requis.` }
    }

    // “1 question sur 5 verrouillée” : on verrouille la tentative N si (N % 5 === 0)
    const nextAttemptNumber = freeSendsUsed + 1
    if (nextAttemptNumber % LOCK_EVERY_NTH_SEND === 0) {
      return { ok: false as const, reason: `Cette tentative est verrouillée (1 sur ${LOCK_EVERY_NTH_SEND}). Abonne-toi pour continuer.` }
    }

    return { ok: true as const }
  }

  const send = useCallback(async () => {
    if (!canSend) return

    const gate = gatingCheck()
    if (!gate.ok) {
      setServerError(gate.reason)
      return
    }

    setLoading(true)
    setServerError(null)
    setAnswer('')
    setSources([])
    setUsage(undefined)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          profile: profile || null,
          top_k: Math.max(1, Math.min(Number(topK) || 5, 20)),
          mode,
        }),
      })

      const data: ApiResponse = await res.json()

      if (!res.ok) {
        const msg = 'error' in data && data.error ? data.error : `Erreur API (${res.status})`
        setServerError(`${msg}${'details' in data && data.details ? ` — ${data.details}` : ''}`)
        return
      }

      if ('answer' in data) {
        setAnswer(data.answer || '')
        setSources(Array.isArray(data.sources) ? data.sources : [])
        setUsage(data.usage)

        // Consommer 1 “essai” seulement si réponse OK
        if (!isActive && FREE_MODE_ENABLED) {
          persistFreeCount(freeSendsUsed + 1)
        }
      } else {
        setServerError('Réponse inattendue du serveur.')
      }
    } catch (err: any) {
      setServerError(err?.message ?? String(err))
    } finally {
      setLoading(false)
    }
  }, [canSend, message, profile, topK, mode, isActive, freeSendsUsed])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      send()
    }
  }

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        {!isActive && <PaywallBanner />}

        <h1 style={{ margin: 0 }}>Droitis — /app</h1>
        <p style={{ marginTop: 8, opacity: 0.8 }}>
          Statut abonnement : <b>{status ?? 'none'}</b> — Accès: <b>{isActive ? 'COMPLET' : 'GRATUIT (limité)'}</b>
        </p>

        {!isActive && FREE_MODE_ENABLED && (
          <div style={styles.freeInfo}>
            Mode gratuit : {freeSendsUsed}/{FREE_SEND_LIMIT} requêtes d’essai utilisées.
            {' '}— 1 tentative sur {LOCK_EVERY_NTH_SEND} est verrouillée.
          </div>
        )}

        <div style={styles.formRow}>
          <label htmlFor="message" style={styles.label}>
            Question
          </label>
          <textarea
            id="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Pose ta question (ex: Explique l’art. 1457 C.c.Q.)"
            rows={6}
            style={styles.textarea}
          />
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
            Astuce: <kbd>Ctrl/⌘</kbd> + <kbd>Enter</kbd> pour envoyer
          </div>
        </div>

        <div style={styles.grid}>
          <div style={styles.formCol}>
            <label htmlFor="profile" style={styles.label}>
              Profil (facultatif)
            </label>
            <input
              id="profile"
              type="text"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              placeholder="ex: etudiant_l1"
              style={styles.input}
            />
          </div>

          <div style={styles.formCol}>
            <label htmlFor="topK" style={styles.label}>
              top_k
            </label>
            <input
              id="topK"
              type="number"
              min={1}
              max={20}
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              style={styles.input}
            />
          </div>

          <div style={styles.formCol}>
            <label htmlFor="mode" style={styles.label}>
              mode
            </label>
            <select id="mode" value={mode} onChange={(e) => setMode(e.target.value)} style={styles.input}>
              <option value="default">default</option>
              <option value="concise">concise</option>
              <option value="detailed">detailed</option>
            </select>
          </div>
        </div>

        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button
            onClick={send}
            disabled={!canSend}
            style={{
              ...styles.button,
              opacity: canSend ? 1 : 0.6,
              cursor: canSend ? 'pointer' : 'not-allowed',
            }}
          >
            {loading ? 'Envoi…' : 'Envoyer'}
          </button>

          <button
            onClick={() => {
              setMessage('')
              setAnswer('')
              setSources([])
              setServerError(null)
            }}
            style={{ ...styles.button, background: '#e5e7eb', color: '#111827' }}
          >
            Réinitialiser
          </button>

          {!isActive && (
            <form method="POST" action="/api/stripe/checkout">
              <button type="submit" style={{ ...styles.button, background: '#2563eb' }}>
                S’abonner
              </button>
            </form>
          )}
        </div>

        {serverError && (
          <div style={styles.errorBox}>
            <strong>Erreur :</strong> {serverError}
          </div>
        )}

        {answer && (
          <section style={styles.result}>
            <h2 style={{ marginTop: 0 }}>Réponse</h2>
            <div style={styles.answer}>{answer}</div>

            {Array.isArray(sources) && sources.length > 0 && (
              <>
                <h3>Sources</h3>
                <ul style={{ paddingLeft: 18, marginTop: 8 }}>
                  {sources.map((s, i) => (
                    <li key={`${s.id ?? i}`} style={{ marginBottom: 4 }}>
                      {s.title || s.citation || `Source ${i + 1}`}
                      {s.jurisdiction ? ` — ${s.jurisdiction}` : ''}
                      {s.url ? (
                        <>
                          {' '}
                          —{' '}
                          <a href={s.url} target="_blank" rel="noreferrer">
                            lien
                          </a>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {usage && (
              <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
                Debug: top_k={usage.top_k ?? '-'} | rpcOk={String(usage.rpcOk)}
              </div>
            )}
          </section>
        )}
      </div>

      <footer style={styles.footer}>
        <small>
          Front = clé anonyme uniquement. La Service Role Key reste strictement côté serveur.
        </small>
      </footer>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100dvh',
    display: 'grid',
    placeItems: 'center',
    padding: 16,
    background: '#0b1220',
    color: 'white',
  },
  card: {
    width: '100%',
    maxWidth: 860,
    background: 'white',
    color: '#111827',
    borderRadius: 12,
    padding: 20,
    boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05)',
  },
  paywall: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    border: '1px solid #fecaca',
    background: '#fff1f2',
    color: '#7f1d1d',
    marginBottom: 14,
  },
  subscribeBtn: {
    padding: '10px 14px',
    borderRadius: 8,
    background: '#111827',
    color: 'white',
    border: 'none',
    fontWeight: 700,
    cursor: 'pointer',
  },
  freeInfo: {
    marginTop: 8,
    marginBottom: 12,
    padding: 10,
    borderRadius: 10,
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    fontSize: 13,
    opacity: 0.9,
  },
  formRow: {
    marginTop: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: { fontSize: 14, fontWeight: 600 },
  textarea: {
    width: '100%',
    resize: 'vertical',
    padding: 10,
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 14,
    lineHeight: 1.4,
  },
  grid: {
    display: 'grid',
    gap: 12,
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    marginTop: 12,
  },
  formCol: { display: 'flex', flexDirection: 'column', gap: 6 },
  input: {
    width: '100%',
    padding: 10,
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    fontSize: 14,
  },
  button: {
    padding: '10px 14px',
    borderRadius: 8,
    background: '#111827',
    color: 'white',
    border: 'none',
    fontWeight: 600,
    cursor: 'pointer',
  },
  errorBox: {
    marginTop: 16,
    padding: 12,
    borderRadius: 8,
    background: '#fee2e2',
    color: '#7f1d1d',
    border: '1px solid #fecaca',
  },
  result: { marginTop: 18, paddingTop: 8, borderTop: '1px solid #e5e7eb' },
  answer: {
    whiteSpace: 'pre-wrap',
    fontSize: 15,
    lineHeight: 1.5,
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    padding: 12,
  },
  footer: { marginTop: 18, opacity: 0.7, textAlign: 'center' },
}
