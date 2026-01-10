// lib/case-reader/pdfText.client.ts
// Client-only PDF text extraction with robust imports across pdfjs-dist versions.
// We disable worker to avoid Next/Vercel Terser issues with pdf.worker.mjs.

type PdfJsModule = {
  getDocument?: (args: any) => any;
};

async function loadPdfJs(): Promise<PdfJsModule> {
  // Try the most common entrypoints across versions/bundlers.
  // Order matters: we prefer stable entrypoints first.
  const candidates = [
    "pdfjs-dist", // official entry
    "pdfjs-dist/legacy/build/pdf", // older legacy path (some versions)
    "pdfjs-dist/legacy/build/pdf.mjs", // ESM legacy path (some versions)
    "pdfjs-dist/build/pdf", // older path
    "pdfjs-dist/build/pdf.mjs", // ESM path
  ] as const;

  let lastErr: any = null;

  for (const spec of candidates) {
    try {
      const mod: any = await import(/* webpackIgnore: true */ spec);
      const m: any = mod?.default ?? mod;
      if (m?.getDocument) return m as PdfJsModule;
      // Some builds export getDocument at top-level even if default exists
      if (mod?.getDocument) return mod as PdfJsModule;
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(
    "Impossible de charger pdfjs-dist (getDocument introuvable). " +
      "Vérifie que 'pdfjs-dist' est bien installé. " +
      (lastErr ? `Dernière erreur: ${String(lastErr?.message ?? lastErr)}` : "")
  );
}

export async function extractPdfTextFromFile(file: File): Promise<string> {
  const pdfjs = await loadPdfJs();
  if (!pdfjs.getDocument) throw new Error("pdfjs-dist: getDocument introuvable.");

  const ab = await file.arrayBuffer();
  const data = new Uint8Array(ab);

  // ✅ IMPORTANT: disableWorker avoids bundling pdf.worker.mjs => fixes Terser import.meta/export build failure
  const loadingTask = pdfjs.getDocument({ data, disableWorker: true });
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
