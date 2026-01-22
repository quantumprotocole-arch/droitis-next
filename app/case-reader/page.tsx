'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import BrandBackground from '@/components/ui/BrandBackground'
import DroitisLogo from '@/components/ui/DroitisLogo'
import Accordion from '@/components/ui/Accordion'

// Client-side PDF text fallback (si déjà présent dans ton code)
import { extractPdfTextFromFile } from '@/lib/case-reader/pdfText.client'

export const dynamic = 'force-dynamic'

type Clarify = {
  type: 'clarify'
  output_mode: 'fiche' | 'analyse_longue'
  clarification_questions: string[]
}

type Answer = {
  type: 'answer'
  output_mode: 'fiche' | 'analyse_longue'
  title?: string
  content_markdown: string
  sources?: { title?: string; citation?: string; jurisdiction?: string }[]
  limits?: string[]
}

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

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function CaseReaderPage() {
  const [file, setFile] = useState<File | null>(null)
  const [outputMode, setOutputMode] = useState<'fiche' | 'analyse_longue'>('fiche')
  const [extractMethod, setExtractMethod] = useState<'server' | 'client'>('server')
  const [caseText, setCaseText] = useState('')
  const [status, setStatus] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [result, setResult] = useState<Clarify | Answer | null>(null)
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<number, string>>({})

  const canAnalyze = Boolean(caseText.trim().length > 50)

  const fileLabel = useMemo(() => (file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} Mo` : 'Aucun fichier'), [file])

  async function extract() {
    if (!file) return
    setBusy(true)
    setError(null)
    setResult(null)
    setStatus(null)

    try {
      if (extractMethod === 'client' && file.type === 'application/pdf') {
        const txt = await extractPdfTextFromFile(file)
        setCaseText(txt || '')
        setStatus(200)
        return
      }

      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/case-reader/extract', { method: 'POST', body: fd })
      setStatus(res.status)

      const text = await res.text()
      let json: any
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error('Réponse non-JSON (extract): ' + text.slice(0, 300))
      }

      if (!res.ok) throw new Error(json?.error ?? `Extraction error (${res.status})`)
      setCaseText(json.extracted_text ?? '')
    } catch (e: any) {
      setError(e?.message ?? 'Erreur extraction.')
    } finally {
      setBusy(false)
    }
  }

  async function analyze() {
    if (!canAnalyze) return
    setBusy(true)
    setError(null)
    setResult(null)
    setStatus(null)

    try {
      const res = await fetch('/api/case-reader/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extracted_text: caseText,
          output_mode: outputMode,
          clarification_answers: {},
        }),
      })
      setStatus(res.status)
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `Analyse error (${res.status})`)
      setResult(json)
    } catch (e: any) {
      setError(e?.message ?? 'Erreur analyse.')
    } finally {
      setBusy(false)
    }
  }

  async function analyzeWithClarifications() {
    if (!result || result.type !== 'clarify') return
    setBusy(true)
    setError(null)
    setStatus(null)

    try {
      const res = await fetch('/api/case-reader/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extracted_text: caseText,
          output_mode: result.output_mode,
          clarification_answers: clarifyAnswers,
        }),
      })
      setStatus(res.status)
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `Analyse error (${res.status})`)
      setResult(json)
    } catch (e: any) {
      setError(e?.message ?? 'Erreur analyse.')
    } finally {
      setBusy(false)
    }
  }

  async function exportDocx() {
    if (!result || result.type !== 'answer') return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/case-reader/export-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: result.title ?? 'Fiche', markdown: result.content_markdown }),
      })
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Erreur export DOCX.')
      const blob = await res.blob()
      downloadBlob(blob, 'droitis-case-reader.docx')
    } catch (e: any) {
      setError(e?.message ?? 'Erreur export DOCX.')
    } finally {
      setBusy(false)
    }
  }

  async function exportPdf() {
    if (!result || result.type !== 'answer') return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/case-reader/export-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: result.title ?? 'Fiche', markdown: result.content_markdown }),
      })
      if (!res.ok) throw new Error((await res.json())?.error ?? 'Erreur export PDF.')
      const blob = await res.blob()
      downloadBlob(blob, 'droitis-case-reader.pdf')
    } catch (e: any) {
      setError(e?.message ?? 'Erreur export PDF.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <BrandBackground className="pb-10">
      <div className="mx-auto max-w-6xl px-4 py-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/app" className="flex items-center gap-2">
            <span className="h-8 w-8">
              <DroitisLogo className="h-8 w-8" />
            </span>
            <div>
              <div className="text-sm font-extrabold tracking-wide text-droitis-ink2">Case Reader</div>
              <div className="text-xs text-droitis-ink/70">Analyse un PDF/DOCX et génère une fiche exportable.</div>
            </div>
          </Link>

          <Link href="/app" className="droitis-btn-secondary px-3 py-2">
            Retour au Chat
          </Link>
        </header>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Left: upload + controls */}
          <div className="rounded-xl2 border border-white/50 bg-white/55 p-4 shadow-soft lg:col-span-1">
            <div className="flex items-center gap-2">
              <DocIcon className="h-5 w-5 text-droitis-ink" />
              <div className="text-sm font-extrabold tracking-wide text-droitis-ink2">Document</div>
            </div>

            <div className="mt-3">
              <div className="text-xs font-semibold text-droitis-ink/70">Fichier</div>
              <label className="mt-2 block cursor-pointer rounded-xl2 border border-droitis-stroke bg-white/65 p-4 text-sm shadow-sm transition hover:bg-white">
                <input
                  type="file"
                  className="hidden"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <div className="font-semibold">{file ? 'Changer le fichier' : 'Téléverser PDF/DOCX'}</div>
                <div className="mt-1 text-xs text-droitis-ink/70">{fileLabel}</div>
                <div className="mt-2 text-[11px] text-droitis-ink/65">IP : le document n’est pas ingéré globalement.</div>
              </label>
            </div>

            <div className="mt-4">
              <div className="text-xs font-semibold text-droitis-ink/70">Extraction</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="droitis-chip"
                  data-active={String(extractMethod === 'server')}
                  onClick={() => setExtractMethod('server')}
                >
                  Serveur (recommandé)
                </button>
                <button
                  type="button"
                  className="droitis-chip"
                  data-active={String(extractMethod === 'client')}
                  onClick={() => setExtractMethod('client')}
                >
                  Client (PDF)
                </button>
              </div>
            </div>

            <div className="mt-4">
              <div className="text-xs font-semibold text-droitis-ink/70">Sortie</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="droitis-chip"
                  data-active={String(outputMode === 'fiche')}
                  onClick={() => setOutputMode('fiche')}
                >
                  Fiche
                </button>
                <button
                  type="button"
                  className="droitis-chip"
                  data-active={String(outputMode === 'analyse_longue')}
                  onClick={() => setOutputMode('analyse_longue')}
                >
                  Analyse longue
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <button className="droitis-btn" disabled={!file || busy} onClick={extract}>
                {busy ? '...' : 'Extraire le texte'}
              </button>
              <button className="droitis-btn-secondary" disabled={!canAnalyze || busy} onClick={analyze}>
                {busy ? '...' : 'Analyser'}
              </button>
            </div>

            {status !== null && <div className="mt-3 text-xs text-droitis-ink/70">HTTP: {status}</div>}

            {error && (
              <div className="mt-3 rounded-xl2 border border-droitis-stroke bg-white/65 p-3 text-sm">
                <div className="font-semibold">Erreur</div>
                <div className="mt-1 text-xs text-droitis-ink/75">{error}</div>
              </div>
            )}
          </div>

          {/* Right: text + result */}
          <div className="rounded-xl2 border border-white/50 bg-white/55 p-4 shadow-soft lg:col-span-2">
            <div className="text-sm font-extrabold tracking-wide text-droitis-ink2">Texte extrait</div>
            <div className="mt-2 text-xs text-droitis-ink/70">
              Vérifie l’extraction avant l’analyse (titres, paragraphes, pagination).
            </div>

            <textarea
              className="droitis-input mt-3 min-h-[180px] resize-y"
              value={caseText}
              onChange={(e) => setCaseText(e.target.value)}
              placeholder="Le texte extrait apparaîtra ici…"
            />

            <div className="mt-4 border-t border-white/50 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-extrabold tracking-wide text-droitis-ink2">Résultat</div>
                  <div className="mt-1 text-xs text-droitis-ink/70">
                    Export DOCX/PDF disponible après une réponse (fiche ou analyse).
                  </div>
                </div>

                <div className="flex gap-2">
                  <button className="droitis-btn-secondary px-3 py-2" disabled={busy || !result || result.type !== 'answer'} onClick={exportDocx}>
                    Export DOCX
                  </button>
                  <button className="droitis-btn-secondary px-3 py-2" disabled={busy || !result || result.type !== 'answer'} onClick={exportPdf}>
                    Export PDF
                  </button>
                </div>
              </div>

              {!result && (
                <div className="mt-3 rounded-xl2 border border-droitis-stroke bg-white/65 p-4 text-sm text-droitis-ink/80">
                  Lance l’analyse pour générer une fiche (ou une analyse longue).
                </div>
              )}

              {result?.type === 'clarify' && (
                <div className="mt-3 space-y-3">
                  <div className="rounded-xl2 border border-droitis-stroke bg-white/65 p-4 text-sm">
                    <div className="font-semibold">Questions de clarification</div>
                    <div className="mt-1 text-xs text-droitis-ink/70">
                      Pour améliorer la fiche, réponds brièvement (une phrase suffit).
                    </div>
                  </div>

                  {result.clarification_questions.map((q, i) => (
                    <div key={i} className="rounded-xl2 border border-droitis-stroke bg-white/65 p-4">
                      <div className="text-sm font-semibold">{q}</div>
                      <textarea
                        className="droitis-input mt-2 min-h-[70px] resize-y"
                        value={clarifyAnswers[i] ?? ''}
                        onChange={(e) => setClarifyAnswers((m) => ({ ...m, [i]: e.target.value }))}
                        placeholder="Ta réponse…"
                      />
                    </div>
                  ))}

                  <button className="droitis-btn" disabled={busy} onClick={analyzeWithClarifications}>
                    Relancer avec clarifications
                  </button>
                </div>
              )}

              {result?.type === 'answer' && (
                <div className="mt-3 space-y-3">
                  <div className="rounded-xl2 border border-droitis-stroke bg-droitis-paper p-4">
                    <div className="text-sm font-extrabold tracking-wide text-droitis-ink2">
                      {result.title ?? (result.output_mode === 'fiche' ? 'Fiche' : 'Analyse')}
                    </div>
                    <div className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed">
                      {result.content_markdown}
                    </div>
                  </div>

                  <Accordion title="Sources utilisées" defaultOpen={false}>
                    {result.sources && result.sources.length > 0 ? (
                      <ul className="list-disc pl-5">
                        {result.sources.map((s, i) => (
                          <li key={i}>
                            <span className="font-semibold">{s.title ?? 'Source'}</span>
                            {s.jurisdiction ? <span className="text-droitis-ink/70"> — {s.jurisdiction}</span> : null}
                            {s.citation ? <span className="text-droitis-ink/70"> — {s.citation}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-sm text-droitis-ink/75">Aucune source structurée fournie.</div>
                    )}
                  </Accordion>

                  <Accordion title="Rappel IP" defaultOpen={false}>
                    <div className="text-sm text-droitis-ink/80">
                      Le document sert uniquement à générer ta fiche/analyse. Il n’est pas “ingéré” pour entraîner un modèle
                      global. (UI uniquement : le détail dépend de ton infra.)
                    </div>
                  </Accordion>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </BrandBackground>
  )
}
