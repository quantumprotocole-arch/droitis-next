// app/app/AppClient.tsx
'use client'

import React, { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import Accordion from '@/components/ui/Accordion'
import Toggle from '@/components/ui/Toggle'

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
  course_slug: string
  course_title: string
  scope: 'all' | 'institution_specific'
}

const LOCK_EVERY_NTH_SEND = 4
const FREE_SENDS_KEY = 'droitis_free_send_count_v1'
const MEMORY_WINDOW = 12 // 6 user + 6 Droitis (UI)

function DocIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        d="M7 3h7l3 3v15a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M14 3v4h4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 11h8M8 15h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        d="M7 10l5 5 5-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-droitis-stroke bg-white/60 px-3 py-1 text-xs font-semibold text-droitis-ink2">
      {children}
    </span>
  )
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function readFreeCount() {
  try {
    const raw = window.localStorage.getItem(FREE_SENDS_KEY)
    return raw ? clamp(parseInt(raw, 10) || 0, 0, 1_000_000) : 0
  } catch {
    return 0
  }
}
function writeFreeCount(n: number) {
  try {
    window.localStorage.setItem(FREE_SENDS_KEY, String(n))
  } catch {}
}

type ChatMsg = { id: string; role: 'user' | 'assistant'; content: string; sources?: Source[] }

const GOALS = [
  { key: 'comprendre', label: 'Comprendre' },
  { key: 'cas_pratique', label: 'Cas pratique' },
  { key: 'examen', label: 'Examen / plan de réponse' },
  { key: 'fiche', label: 'Fiche synthèse' },
  { key: 'reformuler', label: 'Reformuler / simplifier' },
] as const

const LEVELS = ['Débutant', 'Intermédiaire', 'Avancé'] as const

export default function AppClient({ isActive, status }: { isActive: boolean; status: string | null }) {
  // ⚠️ UI only (pas d'impact backend)
  const [courseQuery, setCourseQuery] = useState('')
  const [courseSlug, setCourseSlug] = useState('general')
  const [userGoal, setUserGoal] = useState<(typeof GOALS)[number]['key']>('comprendre')
  const [level, setLevel] = useState<(typeof LEVELS)[number] | ''>('')
  const [memoryEnabled, setMemoryEnabled] = useState(true)

  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const [thread, setThread] = useState<ChatMsg[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Je suis Droitis. Dis-moi ce que tu veux comprendre (ou colle un extrait de cours / décision) et je te réponds de façon claire et structurée.',
    },
  ])

  // --- Cours: mock typeahead (UI only). Tu pourras brancher sur tes vrais profils.
  const courseOptions: CourseOption[] = useMemo(
    () => [
      { course_slug: 'general', course_title: 'Général', scope: 'all' },
      { course_slug: 'responsabilite_civile', course_title: 'Responsabilité civile', scope: 'all' },
      { course_slug: 'procedure_civile', course_title: 'Procédure civile', scope: 'all' },
      { course_slug: 'droit_des_obligations', course_title: 'Droit des obligations', scope: 'all' },
      { course_slug: 'biens', course_title: 'Droit des biens', scope: 'all' },
    ],
    []
  )

  const filteredCourses = useMemo(() => {
    const q = courseQuery.trim().toLowerCase()
    if (!q) return courseOptions
    return courseOptions.filter((c) => c.course_title.toLowerCase().includes(q) || c.course_slug.includes(q))
  }, [courseOptions, courseQuery])

  const planLabel = isActive ? 'Premium' : 'Gratuit'

  const resetConversation = useCallback(() => {
    setThread([
      {
        id: 'welcome',
        role: 'assistant',
        content:
          'Conversation réinitialisée. Dis-moi ce que tu veux travailler (notions, cas pratique, plan, etc.).',
      },
    ])
    setServerError(null)
    setMessage('')
  }, [])

  const buildFollowUps = useCallback(() => {
    // Simple suggestions UI (pas d'invention de sources)
    const base =
      userGoal === 'cas_pratique'
        ? ['Identifie les enjeux juridiques', 'Propose un plan IRAC', 'Quelles exceptions possibles ?']
        : userGoal === 'examen'
          ? ['Donne un plan en 3 parties', 'Fais une checklist de points à couvrir', 'Exemples de formulations']
          : userGoal === 'fiche'
            ? ['Fais une fiche (définitions + conditions)', 'Ajoute les pièges fréquents', 'Fais un tableau comparatif']
            : userGoal === 'reformuler'
              ? ['Simplifie encore', 'Explique comme à un débutant', 'Donne un exemple concret']
              : ['Donne un exemple', 'Résume en 5 lignes', 'Qu’est-ce qui pourrait changer la réponse ?']

    return base.slice(0, 3)
  }, [userGoal])

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || loading) return

      setServerError(null)

      // Paywall soft (déjà présent avant) — UI only
      if (!isActive) {
        const count = readFreeCount() + 1
        writeFreeCount(count)
        if (count % LOCK_EVERY_NTH_SEND === 0) {
          setServerError(
            `Mode gratuit : cette tentative est verrouillée (1 sur ${LOCK_EVERY_NTH_SEND}). Abonne-toi pour lever la limite.`
          )
          return
        }
      }

      const userMsg: ChatMsg = { id: crypto.randomUUID(), role: 'user', content: trimmed }
      setThread((t) => [...t, userMsg].slice(-50))
      setMessage('')
      setLoading(true)

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: trimmed,
            course_slug: courseSlug,
            user_goal: userGoal,
            top_k: 5,
            mode: 'prod',
            // mémoire: UI only pour l'instant
          }),
        })

        const data: ApiResponse = await res.json()

        if (!res.ok) {
          const msg = 'error' in data && data.error ? data.error : `Erreur API (${res.status})`
          setServerError(msg)
          return
        }

        if (!('answer' in data)) {
          setServerError('Réponse inattendue.')
          return
        }

        const aiMsg: ChatMsg = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.answer,
          sources: data.sources || [],
        }

        setThread((t) => {
          const next = [...t, aiMsg]
          if (!memoryEnabled) return [next[0], ...next.slice(-2)] // welcome + dernier échange
          return next.slice(-50)
        })
      } catch (e: any) {
        setServerError(e?.message ?? 'Erreur réseau.')
      } finally {
        setLoading(false)
      }
    },
    [loading, isActive, courseSlug, userGoal, memoryEnabled]
  )

  const visibleThread = useMemo(() => {
    if (!memoryEnabled) return thread
    return thread.slice(-MEMORY_WINDOW - 1) // welcome + fenêtre
  }, [thread, memoryEnabled])

  return (
    <div className="space-y-4">
      {/* Header of page */}
      <div className="flex flex-col gap-3 rounded-xl2 border border-white/50 bg-white/55 p-4 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-extrabold tracking-wide text-droitis-ink2">Assistance juridique</div>
            <div className="mt-1 text-xs text-droitis-ink/70">Réponses structurées, style examen, avec prudence sur les sources.</div>
          </div>

          <div className="flex items-center gap-2">
            <Badge>{planLabel}</Badge>
            {!isActive && (
              <Badge>
                {(() => {
                  const c = typeof window !== 'undefined' ? readFreeCount() : 0
                  return `Quota: ${c}/${LOCK_EVERY_NTH_SEND}`
                })()}
              </Badge>
            )}
            <Link href="/case-reader" className="droitis-btn">
              <DocIcon className="h-5 w-5" />
              <span>Case Reader</span>
            </Link>
          </div>
        </div>

        {/* Context panel */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="rounded-xl2 border border-droitis-stroke bg-white/55 p-4 lg:col-span-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-extrabold tracking-wide text-droitis-ink2">Contexte de ton cours</div>
                <div className="mt-1 text-xs text-droitis-ink/70">
                  Le cours améliore la précision. <span className="font-semibold">Général</span> répond quand même mais moins ciblé.
                </div>
              </div>
              <Link href="/case-reader" className="droitis-btn-secondary px-3 py-2">
                <DocIcon className="h-5 w-5" />
                <span className="hidden sm:inline">Analyser une décision</span>
              </Link>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="relative">
                <label className="droitis-label">COURS</label>
                <div className="mt-2 rounded-md border border-droitis-stroke bg-white/70 p-2">
                  <div className="flex items-center gap-2">
                    <input
                      value={courseQuery}
                      onChange={(e) => setCourseQuery(e.target.value)}
                      placeholder="Rechercher un cours…"
                      className="w-full bg-transparent text-sm outline-none"
                    />
                    <Chevron className="h-5 w-5 text-droitis-ink/60" />
                  </div>
                  <div className="mt-2 max-h-40 overflow-auto rounded-md border border-droitis-stroke bg-white/70">
                    {filteredCourses.map((c) => (
                      <button
                        key={c.course_slug}
                        type="button"
                        onClick={() => {
                          setCourseSlug(c.course_slug)
                          setCourseQuery('')
                        }}
                        className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-white ${
                          courseSlug === c.course_slug ? 'font-semibold' : ''
                        }`}
                      >
                        <span>{c.course_title}</span>
                        {courseSlug === c.course_slug && <span aria-hidden="true">✓</span>}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label className="droitis-label">OBJECTIF</label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {GOALS.map((g) => (
                    <button
                      key={g.key}
                      type="button"
                      className="droitis-chip"
                      data-active={String(userGoal === g.key)}
                      onClick={() => setUserGoal(g.key)}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>

                <div className="mt-3">
                  <label className="droitis-label">NIVEAU (OPTIONNEL)</label>
                  <select
                    className="droitis-input mt-2"
                    value={level}
                    onChange={(e) => setLevel(e.target.value as any)}
                  >
                    <option value="">—</option>
                    {LEVELS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-xl2 border border-droitis-stroke bg-white/55 p-3">
                <Toggle
                  checked={memoryEnabled}
                  onChange={setMemoryEnabled}
                  label="Mémoriser le contexte de cette conversation"
                  description="Conserve les 12 derniers messages (6 user + 6 Droitis)"
                />
              </div>

              <div className="flex items-center justify-between rounded-xl2 border border-droitis-stroke bg-white/55 p-3">
                <div>
                  <div className="text-sm font-semibold text-droitis-ink">Réinitialiser la conversation</div>
                  <div className="mt-1 text-xs text-droitis-ink/70">Remet la discussion à zéro (UI).</div>
                </div>
                <button type="button" onClick={resetConversation} className="droitis-btn-secondary px-3 py-2">
                  Reset
                </button>
              </div>
            </div>

            {/* Case Reader CTA card */}
            <div className="mt-4 rounded-xl2 border border-droitis-stroke bg-white/65 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-extrabold tracking-wide text-droitis-ink2">Analyse une décision (PDF/DOCX)</div>
                  <div className="mt-1 text-xs text-droitis-ink/70">Génère une fiche d’examen téléchargeable.</div>
                  <div className="mt-2 text-xs text-droitis-ink/65">IP : le document n’est pas ingéré globalement.</div>
                </div>
                <Link href="/case-reader" className="droitis-btn">
                  <DocIcon className="h-5 w-5" />
                  Ouvrir Case Reader
                </Link>
              </div>
            </div>
          </div>

          {/* Right rail: status / help */}
          <div className="rounded-xl2 border border-droitis-stroke bg-white/55 p-4">
            <div className="text-sm font-extrabold tracking-wide text-droitis-ink2">Statut</div>
            <div className="mt-2 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-droitis-ink/70">Compte</span>
                <span className="font-semibold">{planLabel}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-droitis-ink/70">Abonnement</span>
                <span className="font-semibold">{status ?? '—'}</span>
              </div>
            </div>

            {!isActive && (
              <div className="mt-4 rounded-xl2 border border-droitis-stroke bg-white/65 p-3 text-sm">
                <div className="font-semibold">Mode gratuit</div>
                <div className="mt-1 text-xs text-droitis-ink/70">
                  Une requête sur {LOCK_EVERY_NTH_SEND} est verrouillée. Upsell léger toutes les 2 requêtes (Phase 5).
                </div>
              </div>
            )}

            <div className="mt-4 rounded-xl2 border border-droitis-stroke bg-white/65 p-3 text-sm">
              <div className="font-semibold">Conseil</div>
              <div className="mt-1 text-xs text-droitis-ink/70">
                Pour une décision, utilise Case Reader (meilleure extraction + export PDF/DOCX).
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Conversation */}
      <div className="rounded-xl2 border border-white/50 bg-white/55 p-4 shadow-soft">
        <div className="max-h-[55vh] space-y-4 overflow-auto pr-1">
          {visibleThread.map((m) => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`droitis-bubble ${m.role === 'user' ? 'droitis-bubble-user' : 'droitis-bubble-ai'}`}>
                <div className="whitespace-pre-wrap">{m.content}</div>

                {m.role === 'assistant' && (
                  <div className="mt-3 space-y-2">
                    <Accordion title="Sources utilisées">
                      {m.sources && m.sources.length > 0 ? (
                        <ul className="list-disc pl-5">
                          {m.sources.map((s, i) => (
                            <li key={(s.id ?? i).toString()}>
                              <span className="font-semibold">{s.title ?? 'Source'}</span>
                              {s.jurisdiction ? <span className="text-droitis-ink/70"> — {s.jurisdiction}</span> : null}
                              {s.citation ? <span className="text-droitis-ink/70"> — {s.citation}</span> : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-sm text-droitis-ink/75">
                          Aucune source structurée n’a été fournie par le serveur pour cette réponse.
                        </div>
                      )}
                    </Accordion>

                    <Accordion title="Limites / À vérifier">
                      <ul className="list-disc pl-5 text-sm">
                        <li>Vérifie les articles/citations exacts dans le recueil applicable (QC/CA selon ton cours).</li>
                        <li>Si tu as un extrait de décision ou d’énoncé, colle-le pour une réponse plus précise.</li>
                        <li>Je peux me tromper sur les détails factuels si le contexte est incomplet.</li>
                      </ul>
                    </Accordion>

                    <div className="flex flex-wrap gap-2 pt-1">
                      {buildFollowUps().map((s) => (
                        <button
                          key={s}
                          type="button"
                          className="droitis-chip"
                          onClick={() => setMessage((prev) => (prev ? prev + '\n' + s : s))}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="droitis-bubble droitis-bubble-ai">
                <div className="text-sm font-semibold text-droitis-ink">Droitis réfléchit…</div>
              </div>
            </div>
          )}

          {serverError && (
            <div className="rounded-xl2 border border-droitis-stroke bg-white/65 p-3 text-sm">
              <div className="font-semibold text-droitis-ink">Erreur</div>
              <div className="mt-1 text-droitis-ink/80">{serverError}</div>
              <div className="mt-3 flex items-center gap-2">
                <button type="button" className="droitis-btn-secondary px-3 py-2" onClick={() => send(message)}>
                  Réessayer
                </button>
                <div className="text-xs text-droitis-ink/70">
                  Si ça time-out, réduis l’extrait ou envoie une question plus ciblée.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="mt-4 border-t border-white/50 pt-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="droitis-label">MESSAGE</label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Ex: Explique la différence entre obligation de moyens et de résultat, avec un mini plan d’examen."
                rows={3}
                className="droitis-input mt-2 min-h-[92px] resize-y"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Link href="/case-reader" className="droitis-btn-secondary px-3 py-2">
                  <DocIcon className="h-5 w-5" />
                  Analyser une décision
                </Link>
                <button
                  type="button"
                  className="droitis-btn-secondary px-3 py-2"
                  onClick={() => setMessage((p) => (p ? p + '\n\n[Extrait]\n' : '[Extrait]\n'))}
                >
                  Joindre un extrait
                </button>
              </div>
            </div>

            <div className="flex gap-2">
              <button type="button" className="droitis-btn" disabled={loading} onClick={() => send(message)}>
                Envoyer
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
