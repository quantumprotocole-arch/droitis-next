// app/api/chat/route.ts
/* eslint-disable no-console */
export const runtime = 'nodejs';            // Service Role -> Node runtime (pas Edge)
export const dynamic = 'force-dynamic';     // éviter tout cache côté Vercel

// ------------------------------
// Types & helpers
// ------------------------------
type VectorHit = {
  id?: string | number;
  document_id?: string | number;
  content?: string;
  metadata?: Record<string, any> | null;
  similarity?: number | null; // si ton RPC la renvoie
};

type ChatRequest = {
  message?: string;
  profile?: string | null;
  top_k?: number | null;
  mode?: string | null;
};

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

function json(data: any, init?: number | ResponseInit) {
  return new Response(JSON.stringify(data, null, 2), {
    status: typeof init === 'number' ? init : init?.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(typeof init !== 'number' ? init?.headers : undefined),
    },
  });
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ------------------------------
// OpenAI REST (sans SDK)
// ------------------------------
async function createEmbedding(input: string) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquant');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small', // embeddings RAG économiques
      input,
    }),
  });
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error(`OpenAI embeddings error: ${res.status} ${res.statusText} — ${JSON.stringify(err)}`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data?.[0]?.embedding as number[] | undefined;
}

async function createChatCompletion(messages: Array<{ role: 'system'|'user'|'assistant'; content: string }>) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquant');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error(`OpenAI chat error: ${res.status} ${res.statusText} — ${JSON.stringify(err)}`);
  }
  const data = (await res.json()) as any;
  return (data.choices?.[0]?.message?.content as string | undefined) ?? '';
}

async function safeJson(res: Response) {
  try { return await res.json(); } catch { return { error: 'non-json response' }; }
}

// ------------------------------
// Route POST
// ------------------------------
export async function POST(req: Request) {
  try {
    // 0) Validation env
    if (!OPENAI_API_KEY) return json({ error: 'OPENAI_API_KEY manquant' }, 500);
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: 'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant' }, 500);
    }

    // 1) Lire le corps
    const body = (await req.json()) as ChatRequest;
    const message = (body.message ?? '').trim();
    const profile = body.profile ?? null;
    const top_k = Math.max(1, Math.min(body.top_k ?? 5, 20));
    const mode = body.mode ?? 'default';
    if (!message) return json({ error: 'message vide' }, 400);

    // 2) Embedding
    const queryEmbedding = await createEmbedding(message);
    if (!queryEmbedding) return json({ error: 'Échec embedding' }, 500);

    // 3) D’abord RPC Supabase
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/search_legal_vector`;
    let hits: VectorHit[] | null = null;
    let rpcOk = true;

    try {
      const rpcRes = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'count=none',
        },
        body: JSON.stringify({
          query_embedding: queryEmbedding,
          top_k,
          mode,
          profile,
        }),
      });

      if (!rpcRes.ok) {
        rpcOk = false;
      } else {
        hits = (await rpcRes.json()) as VectorHit[];
      }
    } catch (e) {
      rpcOk = false;
      console.warn('RPC search_legal_vector a échoué:', e);
    }

    // 4) Fallback REST (ilike) si RPC KO
    if (!rpcOk || !Array.isArray(hits) || hits.length === 0) {
      const q = encodeURIComponent(message.slice(0, 200));
      const restUrl =
        `${SUPABASE_URL}/rest/v1/legal_vectors` +
        `?select=id,document_id,content,metadata&content=ilike.*${q}*&limit=${top_k * 2}`;
      const restRes = await fetch(restUrl, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (restRes.ok) {
        const rows = (await restRes.json()) as VectorHit[];
        hits = rows?.slice(0, top_k) ?? [];
      } else {
        hits = [];
      }
    }

    // 5) Contexte (priorité QC > CA > autres, puis similarité)
    const sorted = (hits ?? []).slice().sort((a, b) => {
      const aj = (a.metadata?.jurisdiction ?? a.metadata?.province ?? '').toString().toLowerCase();
      const bj = (b.metadata?.jurisdiction ?? b.metadata?.province ?? '').toString().toLowerCase();

      const scoreJur = (j: string) =>
        j.includes('québec') || j.includes('quebec') || j.includes('qc')
          ? 2
          : (j.includes('canada') || j.includes('ca'))
          ? 1
          : 0;

      const ja = scoreJur(aj);
      const jb = scoreJur(bj);
      if (ja !== jb) return jb - ja; // QC (2) > CA (1) > autres (0)

      const as = typeof a.similarity === 'number' ? a.similarity : 999999;
      const bs = typeof b.similarity === 'number' ? b.similarity : 999999;
      return as - bs;
    });

    const topContext = sorted.slice(0, top_k);

    const sources = topContext.map((h, idx) => {
      const m = h.metadata ?? {};
      return {
        id: h.id ?? h.document_id ?? `S${idx + 1}`,
        title: m.title ?? m.citation ?? m.name ?? null,
        citation: m.citation ?? null,
        jurisdiction: m.jurisdiction ?? m.province ?? null,
        url: m.url ?? m.link ?? null,
      };
    });

    const contextText = topContext
      .map((h, i) => {
        const m = h.metadata ?? {};
        const head = m.citation || m.title || m.name || `Source ${i + 1}`;
        const jur = m.jurisdiction || m.province || '';
        return `• [${head}] (${jur})\n${(h.content ?? '').slice(0, 1200)}`;
      })
      .join('\n\n');

    // 6) Génération (IRAC/ILAC)
    const systemPrompt = [
      'Tu es Droitis, un tuteur IA spécialisé en droit québécois.',
      'Formate en IRAC/ILAC (Issue/Rule/Application/Conclusion).',
      'Toujours préciser la juridiction (prioriser Québec) et citer les sources fournies.',
      'Si le contexte est faible, expliquer les limites et proposer des pistes.',
      'Langue: la même que la question (français).',
    ].join(' ');

    const userPrompt = [
      `Question: ${message}`,
      '',
      'Contexte (extraits, priorité Québec):',
      contextText || '— Aucun extrait disponible (le RAG a échoué/fallback minimal).',
      '',
      'Consignes:',
      '- Identifier la question juridique.',
      '- Énoncer les règles pertinentes (C.c.Q., jurisprudence) avec la juridiction.',
      '- Appliquer aux faits implicites.',
      '- Conclure clairement.',
      '- Lister les sources citées (titre/citation + lien).',
    ].join('\n');

    const answer = await createChatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    // 7) Logs (mapping conforme à public.logs)
    const path =
      rpcOk && Array.isArray(hits) && hits.length > 0
        ? 'rpc'
        : Array.isArray(hits) && hits.length > 0
          ? 'fallback'
          : 'llm_only';

    try {
      const logBody = {
        created_at: new Date().toISOString(), // timestamp
        question: message,                    // text
        profile_slug: profile ?? null,        // text
        top_k,                                // int
        top_ids: null,                        // si tu n’as pas la liste des ids
        response: { answer, sources, path },  // jsonb
        usage: { rpcOk, mode },               // jsonb
        // user_id: null,                     // si nullable
      };

      const logRes = await fetch(`${SUPABASE_URL}/rest/v1/logs`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation', // utile pour lire l'erreur si 4xx
        },
        body: JSON.stringify(logBody),
      });

      if (!logRes.ok) {
        const errTxt = await logRes.text().catch(() => '');
        console.warn('Insertion logs échouée:', logRes.status, errTxt);
      }
    } catch (e) {
      console.warn('Erreur log (non bloquant):', e);
    }

    // 8) Réponse
    return json(
      {
        answer: answer?.trim() || 'Je n’ai pas pu générer une réponse.',
        sources,
        path, // "rpc" | "fallback" | "llm_only"
        usage: { top_k, rpcOk },
      },
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err: any) {
    console.error(err);
    return json(
      { error: 'Erreur serveur inattendue', details: err?.message ?? String(err) },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
