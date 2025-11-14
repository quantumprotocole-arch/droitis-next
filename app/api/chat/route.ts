// app/api/chat/route.ts
/* eslint-disable no-console */
export const runtime = 'nodejs';            // Service Role -> Node runtime (pas Edge)
export const dynamic = 'force-dynamic';     // éviter tout cache côté Vercel

// ------------------------------
// Types & helpers
// ------------------------------
type VectorHit = {
  id?: number | string;
  code_id?: string | null;
  jurisdiction?: string | null;
  citation?: string | null;
  title?: string | null;
  text?: string | null;
  similarity?: number | null; // renvoyée par le RPC
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
      model: 'text-embedding-3-small',
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

    // 3) D’abord RPC Supabase (DEV)
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/search_legal_vectors_dev`;
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
          query_embedding: queryEmbedding,  // tableau de float
          match_count: top_k,               // signature exacte du RPC
        }),
      });

      if (!rpcRes.ok) {
        rpcOk = false;
      } else {
        hits = (await rpcRes.json()) as VectorHit[];
      }
    } catch (e) {
      rpcOk = false;
      console.warn('RPC search_legal_vectors_dev a échoué:', e);
    }

// 4) Fallback REST (robuste) si RPC KO
if (!rpcOk || !Array.isArray(hits) || hits.length === 0) {
  // 1- on extrait quelques tokens simples (ex: nombres d’article)
  const tokens = (message.match(/\d{2,4}/g) || []).slice(0, 3); // ex: ["1457"]
  const qBasic = encodeURIComponent(message.slice(0, 80));

  // 2- requête OR sur plusieurs colonnes
  //    citation/title/text pour maximiser les chances de match
  const orParts = [
    `citation.ilike.*${qBasic}*`,
    `title.ilike.*${qBasic}*`,
    `text.ilike.*${qBasic}*`,
    ...tokens.map(t => `citation.ilike.*${t}*`),
    ...tokens.map(t => `text.ilike.*${t}*`),
  ];
  const orParam = encodeURIComponent(orParts.join(','));

  const restUrl =
    `${SUPABASE_URL}/rest/v1/legal_vectors_dev` +
    `?select=id,code_id,jurisdiction,citation,title,text` +
    `&or=(${orParam})` +
    `&limit=${top_k * 4}`;

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
      if (restRes.ok) {
        const rows = (await restRes.json()) as VectorHit[];
        hits = rows?.slice(0, top_k) ?? [];
      } else {
        hits = [];
      }
    }

    // 5) Contexte (priorité QC > CA > autres, puis similarité)
    const sorted = (hits ?? []).slice().sort((a, b) => {
      const aj = (a.jurisdiction ?? '').toUpperCase();
      const bj = (b.jurisdiction ?? '').toUpperCase();

      const aQC = aj.includes('QC') || aj.includes('QUÉBEC') || aj.includes('QUEBEC');
      const bQC = bj.includes('QC') || bj.includes('QUÉBEC') || bj.includes('QUEBEC');
      if (aQC && !bQC) return -1;
      if (!aQC && bQC) return 1;

      const as = typeof a.similarity === 'number' ? a.similarity : 1e9;
      const bs = typeof b.similarity === 'number' ? b.similarity : 1e9;
      return as - bs;
    });

    const topContext = sorted.slice(0, top_k);

    const sources = topContext.map((h, idx) => ({
      id: h.id ?? `S${idx + 1}`,
      title: h.title ?? h.citation ?? null,
      citation: h.citation ?? null,
      jurisdiction: h.jurisdiction ?? null,
      url: null, // liens canlii/doc officiels ajoutés en Phase 4
    }));

    const contextText = topContext
      .map((h, i) => {
        const head = h.citation || h.title || `Source ${i + 1}`;
        const jur = h.jurisdiction || '';
        return `• [${head}] (${jur})\n${(h.text ?? '').slice(0, 1200)}`;
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
      const logRes = await fetch(`${SUPABASE_URL}/rest/v1/logs`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          question: message,
          profile_slug: profile ?? null,
          top_ids: (topContext ?? []).map(h => h.id ?? null),
          response: { answer, sources, path },
          usage:    { rpcOk, mode, top_k },
          // created_at par défaut, user_id nullable
          user_id: null,
        }),
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
