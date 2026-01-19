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


type CourseOption = {
  course_slug: string;
  course_title: string;
  scope: "all" | "institution_specific";
  institution_note: string | null;
  tags: string[];
  aliases: string[];
};

type CoursesApiResponse =
  | { courses: CourseOption[] }
  | { error: string; details?: string };

type Props = {
  isActive: boolean
  status: string
}

const LOCK_EVERY_NTH_SEND = 4
const FREE_SENDS_KEY = 'droitis_free_send_count_v1'

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

  const [courseSlug, setCourseSlug] = useState<string>('general');
  const [courses, setCourses] = useState<CourseOption[]>([])
  const [coursesLoading, setCoursesLoading] = useState<boolean>(false)
  const [coursesError, setCoursesError] = useState<string | null>(null)

  const [loading, setLoading] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const [answer, setAnswer] = useState<string>('')
  const [sources, setSources] = useState<Source[]>([])
  const [usage, setUsage] = useState<{ top_k?: number; rpcOk?: boolean } | undefined>(undefined)

  // Compteur “mode gratuit”
  const [freeSendsUsed, setFreeSendsUsed] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    const raw = window.localStorage.getItem(FREE_SENDS_KEY)
    return raw ? Number(raw) || 0 : 0
  })

  const canSend = useMemo(() => message.trim().length > 0 && courseSlug.trim().length > 0 && !loading, [message, courseSlug, loading])


  useEffect(() => {
    let alive = true
    ;(async () => {
      setCoursesLoading(true)
      setCoursesError(null)
      try {
        const res = await fetch('/api/courses', { method: 'GET' })
        const data: CoursesApiResponse = await res.json()
        if (!res.ok) {
          const msg = 'error' in data && data.error ? data.error : `Erreur API (${res.status})`
          throw new Error(`${msg}${'details' in data && data.details ? `: ${data.details}` : ''}`)
        }
        if (alive) {
          const list = 'courses' in data ? (data.courses ?? []) : []
          setCourses(list)
        }
      } catch (e: any) {
        if (alive) setCoursesError(e?.message ?? 'Failed to load courses')
      } finally {
        if (alive) setCoursesLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const gatingCheck = () => {
    // Si actif: pas de limite
    if (isActive) return { ok: true, locked: false }

    // Mode gratuit: 1 envoi sur N verrouillé
    const locked = (freeSendsUsed + 1) % LOCK_EVERY_NTH_SEND === 0
    return { ok: !locked, locked }
  }

  const bumpFreeSend = () => {
    const next = freeSendsUsed + 1
    setFreeSendsUsed(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(FREE_SENDS_KEY, String(next))
    }
  }

  const send = useCallback(async () => {
    if (!canSend) return

    // gating
    const gate = gatingCheck()
    if (!gate.ok) {
      setServerError(
        `Mode gratuit : cette tentative est verrouillée (1 sur ${LOCK_EVERY_NTH_SEND}). Abonne-toi pour lever la limite.`
      )
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
          course_slug: courseSlug,
          profile: profile || null,
          top_k: Math.max(1, Math.min(Number(topK) || 5, 20)),
          mode,
        }),
      })

      const data: ApiResponse = await res.json()

      if (!res.ok) {
        const msg = 'error' in data && data.error ? data.error : `Erreur API (${res.status})`
        setServerError(`${msg}${'details' in data && data.details ? `: ${data.details}` : ''}`)
        return
      }

      if ('answer' in data) {
        setAnswer(data.answer)
        setSources(data.sources || [])
        setUsage(data.usage)
      }

      // compteur gratuit
      if (!isActive) bumpFreeSend()
    } catch (e: any) {
      setServerError(e?.message ?? 'Erreur réseau')
    } finally {
      setLoading(false)
    }
  }, [canSend, courseSlug, isActive, message, mode, profile, topK])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        void send()
      }
    },
    [send]
  )

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0 }}>Droitis</h1>
            <div style={{ opacity: 0.75, marginTop: 6, fontSize: 13 }}>
              Statut: <strong>{status}</strong>
            </div>
          </div>
          {!isActive ? <PaywallBanner /> : null}
        </div>

        {!isActive ? (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
            Mode gratuit : certaines tentatives sont verrouillées.
            {' '}— 1 tentative sur {LOCK_EVERY_NTH_SEND} est verrouillée.
          </div>
        ) : null}

        <div style={styles.formRow}>
          <label htmlFor="courseSlug" style={styles.label}>
            Cours (obligatoire)
          </label>

          {coursesError ? (
            <div style={{ fontSize: 12, marginTop: 6, color: '#b00020' }}>
              Impossible de charger la liste des cours: {coursesError}
            </div>
          ) : null}

          <select
            id="courseSlug"
            value={courseSlug}
            onChange={(e) => setCourseSlug(e.target.value)}
            style={styles.input}
            disabled={coursesLoading}
          >
            <option value="">{coursesLoading ? 'Chargement…' : 'Sélectionner un cours…'}</option>
            {courses.map((c) => {
              const note =
                c.scope === 'institution_specific' && c.institution_note
                  ? ` (uniquement ${c.institution_note})`
                  : ''
              return (
                <option key={c.course_slug} value={c.course_slug}>
                  {c.course_title}
                  {note}
                </option>
              )
            })}
          </select>
        </div>

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
              <option value="prod">prod</option>
              <option value="dev">dev</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            onClick={() => void send()}
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
              setUsage(undefined)
            }}
            style={styles.buttonAlt}
          >
            Effacer
          </button>
        </div>

        {serverError ? (
          <div style={styles.errorBox}>
            <strong>Erreur</strong>
            <div style={{ marginTop: 6 }}>{serverError}</div>
          </div>
        ) : null}

        {answer ? (
          <section style={{ marginTop: 18 }}>
            <h2 style={styles.sectionTitle}>Réponse</h2>
            <pre style={styles.answer}>{answer}</pre>

            <div style={{ marginTop: 10 }}>
              <h3 style={styles.sectionTitle}>Sources</h3>
              {sources.length ? (
                <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                  {sources.map((s, i) => (
                    <li key={String(s.id ?? i)} style={{ marginBottom: 6 }}>
                      <div style={{ fontWeight: 600 }}>{s.title || `Source ${s.id ?? i + 1}`}</div>
                      <div style={{ opacity: 0.85 }}>{s.citation}</div>
                      {s.url ? (
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                          <a href={s.url} target="_blank" rel="noreferrer">
                            {s.url}
                          </a>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div style={{ opacity: 0.75, marginTop: 6 }}>(aucune)</div>
              )}
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
              usage: {usage ? JSON.stringify(usage) : '(n/a)'}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: 24,
    background: '#0b1020',
    color: '#e8eaf6',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  },
  card: {
    width: 'min(100%, 1100px)',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 14,
    padding: 18,
    boxShadow: '0 20px 50px rgba(0,0,0,0.35)',
  },
  formRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginTop: 14,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 12,
    marginTop: 14,
  },
  formCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  label: {
    fontSize: 12,
    opacity: 0.85,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(0,0,0,0.25)',
    color: '#fff',
    outline: 'none',
  },
  textarea: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(0,0,0,0.25)',
    color: '#fff',
    outline: 'none',
    resize: 'vertical',
  },
  button: {
    padding: '10px 14px',
    borderRadius: 10,
    border: 'none',
    background: '#4f7cff',
    color: '#fff',
    fontWeight: 700,
  },
  buttonAlt: {
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.2)',
    background: 'transparent',
    color: '#fff',
    fontWeight: 600,
  },
  answer: {
    whiteSpace: 'pre-wrap',
    background: 'rgba(0,0,0,0.25)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 12,
    padding: 12,
    lineHeight: 1.45,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 14,
    opacity: 0.9,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  errorBox: {
    marginTop: 14,
    padding: 12,
    borderRadius: 12,
    border: '1px solid rgba(255,0,0,0.35)',
    background: 'rgba(255,0,0,0.08)',
  },
  paywall: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 12,
    padding: 12,
    background: 'rgba(255,255,255,0.05)',
  },
  subscribeBtn: {
    border: 'none',
    borderRadius: 10,
    padding: '10px 12px',
    background: '#ffd166',
    fontWeight: 800,
    cursor: 'pointer',
  },
}
