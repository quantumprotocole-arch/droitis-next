// lib/case-reader/pdfText.client.ts
// Client-only helper: PDF text extraction in the browser (no server canvas needed)

import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Important: configure worker for bundlers (Next)
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url
).toString();

export async function extractPdfTextFromFile(file: File): Promise<string> {
  const ab = await file.arrayBuffer();
  const data = new Uint8Array(ab);

  const loadingTask = getDocument({ data });
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
