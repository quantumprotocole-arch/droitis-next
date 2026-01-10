"use client";

// lib/case-reader/pdfText.client.ts
// Client-only PDF text extraction. Important: pdfjs-dist must NOT be imported at module top-level,
// otherwise Next prerender/Node may execute it and crash on DOMMatrix.

type PdfJsAny = any;

let cachedPdfJs: PdfJsAny | null = null;

async function loadPdfJs(): Promise<PdfJsAny> {
  // Prevent accidental server/Node execution (build/prerender)
  if (typeof window === "undefined") {
    throw new Error("PDF extraction is browser-only (window is undefined).");
  }

  if (cachedPdfJs) return cachedPdfJs;

  // ✅ Dynamic import inside function => not executed during build/prerender
  const mod: any = await import("pdfjs-dist");
  const pdfjs: any = mod?.getDocument ? mod : (mod?.default ?? mod);

  if (!pdfjs?.getDocument) {
    const keys = Object.keys(pdfjs ?? {});
    throw new Error(
      "pdfjs-dist chargé mais getDocument introuvable. Exports: " + keys.slice(0, 40).join(", ")
    );
  }

  // ✅ Avoid worker usage (prevents worker-related build issues)
  if (pdfjs?.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = "";
  }

  cachedPdfJs = pdfjs;
  return pdfjs;
}

export async function extractPdfTextFromFile(file: File): Promise<string> {
  const pdfjs = await loadPdfJs();

  const ab = await file.arrayBuffer();
  const data = new Uint8Array(ab);

  // ✅ disableWorker is critical for stability in Next/Vercel
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
