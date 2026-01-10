// lib/case-reader/pdfText.client.ts
// Client-only: PDF text extraction using pdfjs-dist with NO worker.

import * as pdfjsDist from "pdfjs-dist";

type PdfJsAny = any;

function getPdfJs(): PdfJsAny {
  // pdfjs-dist peut exporter soit en named exports, soit via default selon le bundler
  const m: PdfJsAny = (pdfjsDist as any);
  const pdfjs: PdfJsAny = m?.getDocument ? m : (m?.default ?? m);

  if (!pdfjs?.getDocument) {
    // Message clair pour debug
    const keys = Object.keys(pdfjs ?? {});
    throw new Error(
      "pdfjs-dist chargé mais getDocument est introuvable. " +
        "Exports disponibles: " +
        keys.slice(0, 30).join(", ")
    );
  }

  // On évite tout worker (important pour Next/Vercel)
  if (pdfjs?.GlobalWorkerOptions) {
    // on met une valeur vide, et surtout on passe disableWorker: true plus bas
    pdfjs.GlobalWorkerOptions.workerSrc = "";
  }

  return pdfjs;
}

export async function extractPdfTextFromFile(file: File): Promise<string> {
  const pdfjs = getPdfJs();

  const ab = await file.arrayBuffer();
  const data = new Uint8Array(ab);

  // ✅ IMPORTANT: disableWorker évite d’embarquer/charger pdf.worker.mjs
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
