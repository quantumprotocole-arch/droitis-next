"use client";

// lib/case-reader/pdfText.client.ts
// Robust in Next/Vercel:
// - pdfjs-dist is dynamically imported ONLY in browser (prevents DOMMatrix crash during prerender)
// - worker is served from /public to avoid bundling/Terser issues
// - GlobalWorkerOptions.workerSrc is set explicitly

type PdfJsAny = any;

let cachedPdfJs: PdfJsAny | null = null;

async function loadPdfJs(): Promise<PdfJsAny> {
  if (typeof window === "undefined") {
    throw new Error("PDF extraction is browser-only (window is undefined).");
  }

  if (cachedPdfJs) return cachedPdfJs;

  const mod: any = await import("pdfjs-dist");
  const pdfjs: any = mod?.getDocument ? mod : (mod?.default ?? mod);

  if (!pdfjs?.getDocument) {
    const keys = Object.keys(pdfjs ?? {});
    throw new Error(
      "pdfjs-dist chargé mais getDocument est introuvable. Exports: " +
        keys.slice(0, 40).join(", ")
    );
  }

  // ✅ IMPORTANT: worker statique (évite import.meta et évite que Next bundle le worker)
  // Le script postinstall copie soit /public/pdf.worker.mjs soit /public/pdf.worker.js
  if (pdfjs?.GlobalWorkerOptions) {
    // On tente d'abord .mjs, puis fallback .js (les deux peuvent exister selon version)
    // Note: pdfjs choisira le bon type de Worker selon son build.
    pdfjs.GlobalWorkerOptions.workerSrc =
      typeof window !== "undefined" ? "/pdf.worker.mjs" : "";
  }

  cachedPdfJs = pdfjs;
  return pdfjs;
}

export async function extractPdfTextFromFile(file: File): Promise<string> {
  const pdfjs = await loadPdfJs();

  const ab = await file.arrayBuffer();
  const data = new Uint8Array(ab);

  // Si jamais le worker .mjs n’existe pas (fallback), on bascule sur .js
  if (pdfjs?.GlobalWorkerOptions?.workerSrc === "/pdf.worker.mjs") {
    // Petite vérif runtime sans casser : si le fetch échoue, on retombe sur .js
    try {
      const r = await fetch("/pdf.worker.mjs", { method: "HEAD" });
      if (!r.ok) pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.js";
    } catch {
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.js";
    }
  }

  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;

  let fullText = "";

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    const pageText = (content.items as any[])
      .map((it) => (typeof it?.str === "string" ? it.str : ""))
      .filter(Boolean)
      .join(" ");

    if (pageText.trim().length > 0) {
      fullText += pageText.trim() + "\n\n";
    }
  }

  return fullText.trim();
}
