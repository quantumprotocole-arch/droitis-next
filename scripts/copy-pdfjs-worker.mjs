// scripts/copy-pdfjs-worker.mjs
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const publicDir = path.join(root, "public");

const candidates = [
  // pdfjs-dist v4/v5 (ESM worker)
  path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
  path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.mjs"),

  // fallback older/legacy (classic worker)
  path.join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.js"),
  path.join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.js"),
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, dest);
  return true;
}

ensureDir(publicDir);

let copied = false;

// On préfère .mjs (worker module) si disponible
for (const src of candidates) {
  const ext = path.extname(src); // .mjs ou .js
  const dest = path.join(publicDir, `pdf.worker${ext}`);

  if (copyIfExists(src, dest)) {
    console.log(`[pdfjs] copied worker: ${src} -> ${dest}`);
    copied = true;
    break;
  }
}

if (!copied) {
  console.warn(
    "[pdfjs] WARNING: No pdf.worker found in pdfjs-dist. PDF extraction may fail. " +
      "Check pdfjs-dist installation."
  );
}
