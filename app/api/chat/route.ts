// app/api/chat/route.ts
/* eslint-disable no-console */
export const runtime = 'nodejs';            // service key -> Node runtime (pas Edge)
export const dynamic = 'force-dynamic';     // évite le cache côté Vercel pour ce handler

import OpenAI from 'openai';

// Types simples pour les retours/fetch Supabase
type VectorHit = {
  id?: string | number;
  document_id?: string | number;
  content?: string;
  metadata?: Record<string, any> | null;
  similarity?: number | null;
};

type ChatRequest = {
  message?: string;
  profile?: string | null;
  top_k?: number | null;
  mode?: string | null;
};

// Helpers env
const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

function json(data: any, init?: number | ResponseInit) {
  return new Response(JSON.stringify(data), {
    status: typeof init === 'number' ? init : init?.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(typeof init !== 'number' ? init?.headers : undefined),
    },
  });
}

// CORS (au cas où vous appelez depuis un autre domaine)
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: Request) {
  try {
    // 0) Validations env
    if (!OPENAI_API_KEY) {
      return json({ error: 'OPENAI_API_KEY manquant' }, 500);
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: 'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant' }, 500);
    }

    // 1) Lire le corps
    const body = (await req.json()) as ChatRequest;
    const message = (body.message ?? '').trim();
    const profile = body.profile ?? null;
    const top_k = Math.max(1, Math.min(body.top_k ?? 5, 20)); // borne simple 1..20
    const mode = body.mode ?? 'default';

    if (!message) {
      return json({ error: 'message vide' }, 400);
    }

    // 2) Embedding OpenAI
    // OpenAI embeddings: https://platform.openai.com/docs/guides/embeddings
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const embeddingResp = await openai.embeddings.create({
      model: 'text-embedding-3-small', // https://platform.openai.com/docs/models/text-embedding-3-small
      input: message,
      encoding_format: 'float',
    });
    const queryEmbedding = embeddingResp.data[0]?.embedding;
    if (!queryEmbedding) {
      return json({ error: 'Échec embedding' }, 500);
    }

    // 3) Appel RPC Supabase (prioritaire)
    // Supabase REST & RPC: https://supabase.com/docs/guides/api
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/search_legal_vector`;
    let hits: VectorHit[] | null = null;
    let rpcOk = true;

    try {
      const rpcRes = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'count=none',
        },
        body: JSON.stringify({
          // ⚠️ adaptez les noms de paramètres à votre RPC côté DB
          query_embedding: queryEmbedding,
          top_k,
          // facultatif selon votre RPC
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

    // 4) Fallback REST sur legal_vectors si le RPC échoue
    if (!rpcOk || !Array.isArray(hits)) {
      // NOTE: Sans RPC, la similarité vectorielle via REST pur peut être compliquée.
      // On fait un fallback "best-effort" basé sur ILIKE plein-texte.
      // À améliorer en Phase 2 (exposer une view ou un RPC simple).
      const q = encodeURIComponent(message.slice(0, 200));
      const restUrl =
        `${SUPABASE_URL}/rest/v1/legal_vectors` +
        `?select=id,document_id,content,metadata&content=ilike.*${q}*&limit=${top_k * 2}`;

      const restRes = await fetch(restUrl, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });

      if (restRes.ok) {
        const rows = (await restRes.json()) as VectorHit[];
        hits = rows?.slice(0, top_k) ?? [];
      } else {
        // Dernier filet de sécurité: renvoyer une réponse utile même sans contexte
        hits = [];
      }
    }

    // 5) Construire le contexte priorisant Québec (QC)
    const sorted = (hits ?? []).slice().sort((a, b) => {
      const aj = (a.metadata?.jurisdiction ?? a.metadata?.province ?? '').toString().toUpperCase();
      const bj = (b.metadata?.jurisdiction ?? b.metadata?.province ?? '').toString().toUpperCase();
      const aIsQC = aj.includes('QC') || aj.includes('QUÉBEC') || aj.includes('QUEBEC');
      const bIsQC = bj.includes('QC') || bj.includes('QUÉBEC') || bj.includes('QUEBEC');
      if (aIsQC && !bIsQC) return -1;
      if (!aIsQC && bIsQC) return 1;
      // ensuite trier par similarité (plus petit distance = plus pertinent si dispo)
      const as = typeof a.similarity === 'number' ? a.similarity : 999;
      const bs = typeof b.similarity === 'number' ? b.similarity : 999;
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

    // 6) Appel OpenAI Chat: réponse en droit (IRAC/ILAC)
    // Chat Completions: https://platform.openai.com/docs/api-reference/chat
    const systemPrompt = [
      'Tu es Droitis, un tuteur IA spécialisé en droit québécois.',
      'Formate systématiquement en IRAC/ILAC (Issue/Rule/Application/Conclusion).',
      'Toujours préciser la juridiction (prioriser Québec) et citer les sources du contexte fourni.',
      'Si le contexte est faible, expliquer les limites et suggérer des pistes de recherche.',
      'Langue: la même que la question (ici: français).',
    ].join(' ');

    const userPrompt = [
      `Question: ${message}`,
      '',
      'Contexte (extraits, priorité Québec):',
      contextText || '— Aucun extrait disponible (le RAG a échoué/fallback minimal).',
      '',
      'Consignes:',
      '- Identifier la question juridique.',
      '- Énoncer les règles pertinentes (C.c.Q., jurisprudence), en précisant la juridiction.',
      '- Appliquer les règles aux faits supposés de la question.',
      '- Conclure clairement.',
      '- Lister les sources citées (titre/citation + hyperlien si disponible).',
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // modèle léger & économique pour phase 1
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      'Je n’ai pas pu générer une réponse. Réessaie avec une question plus précise.';

    // 7) Log minimal (best-effort) dans logs
    try {
      const logRes = await fetch(`${SUPABASE_URL}/rest/v1/logs`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          created_at: new Date().toISOString(),
          profile,
          message,
          mode,
          meta: { top_k, rpcOk },
        }),
      });
      if (!logRes.ok) {
        console.warn('Insertion logs échouée (non bloquant).');
      }
    } catch (e) {
      console.warn('Erreur log (non bloquant):', e);
    }

    return json(
      {
        answer,
        sources,
        usage: {
          top_k,
          rpcOk,
        },
      },
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err: any) {
    console.error(err);
    return json(
      {
        error: 'Erreur serveur inattendue',
        details: err?.message ?? String(err),
      },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
