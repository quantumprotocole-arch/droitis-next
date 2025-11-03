// app/page.tsx
'use client';

import React, { useCallback, useMemo, useState } from 'react';

type Source = {
  id?: string | number;
  title?: string | null;
  citation?: string | null;
  jurisdiction?: string | null;
  url?: string | null;
};

type ApiResponse =
  | {
      answer: string;
      sources: Source[];
      usage?: { top_k?: number; rpcOk?: boolean };
    }
  | {
      error: string;
      details?: string;
    };

export default function HomePage() {
  const [message, setMessage] = useState('Explique l’art. 1457 C.c.Q.');
  const [profile, setProfile] = useState<string>('');
  const [topK, setTopK] = useState<number>(5);
  const [mode, setMode] = useState<string>('default');

  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const [answer, setAnswer] = useState<string>('');
  const [sources, setSources] = useState<Source[]>([]);
  const [usage, setUsage] = useState<{ top_k?: number; rpcOk?: boolean } | undefined>(undefined);

  const canSend = useMemo(() => message.trim().length > 0 && !loading, [message, loading]);

  const send = useCallback(async () => {
    if (!canSend) return;
    setLoading(true);
    setServerError(null);
    setAnswer('');
    setSources([]);
    setUsage(undefined);

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
      });

      const data: ApiResponse = await res.json();

      if (!res.ok) {
        const msg =
          'error' in data && data.error
            ? data.error
            : `Erreur API (${res.status})`;
        setServerError(`${msg}${'details' in data && data.details ? ` — ${data.details}` : ''}`);
        return;
      }

      if ('answer' in data) {
        setAnswer(data.answer || '');
        setSources(Array.isArray(data.sources) ? data.sources : []);
        setUsage(data.usage);
      } else {
        setServerError('Réponse inattendue du serveur.');
      }
    } catch (err: any) {
      setServerError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, [canSend, message, profile, topK, mode]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  };

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <h1 style={{ margin: 0 }}>Droitis — Phase 1</h1>
        <p style={{ marginTop: 8, opacity: 0.8 }}>
          Next.js → /api/chat → Supabase (RAG) → OpenAI → JSON
        </p>

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
            <select
              id="mode"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              style={styles.input}
            >
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
              setMessage('');
              setAnswer('');
              setSources([]);
              setServerError(null);
            }}
            style={{ ...styles.button, background: '#e5e7eb', color: '#111827' }}
          >
            Réinitialiser
          </button>
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
          Front = clé anonyme uniquement. La Service Role Key reste strictement côté serveur
          (/api/chat).
        </small>
      </footer>
    </main>
  );
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
    boxShadow:
      '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05)',
  },
  formRow: {
    marginTop: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: 600,
  },
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
  formCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
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
  },
  errorBox: {
    marginTop: 16,
    padding: 12,
    borderRadius: 8,
    background: '#fee2e2',
    color: '#7f1d1d',
    border: '1px solid #fecaca',
  },
  result: {
    marginTop: 18,
    paddingTop: 8,
    borderTop: '1px solid #e5e7eb',
  },
  answer: {
    whiteSpace: 'pre-wrap',
    fontSize: 15,
    lineHeight: 1.5,
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    padding: 12,
  },
  footer: {
    marginTop: 18,
    opacity: 0.7,
    textAlign: 'center',
  },
};
