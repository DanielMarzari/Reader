// Text extraction for PDF, EPUB, and plain text uploads.
// Runs server-side. Returns a single normalized text string.

import JSZip from "jszip";

export type ParsedDoc = {
  title: string;
  content: string;
};

/** Normalize whitespace, collapse runs, and preserve paragraph breaks. */
export function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // Join soft-wrapped lines inside a paragraph (common in PDFs)
    .replace(/([^\n])\n(?!\n)/g, "$1 ")
    // Collapse excessive whitespace
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function countWords(text: string): number {
  const m = text.match(/\b[\p{L}\p{N}'-]+\b/gu);
  return m ? m.length : 0;
}

/** PDF: use pdfjs-dist legacy build in Node. */
export async function parsePdf(buffer: Buffer): Promise<string> {
  // @ts-expect-error legacy build
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Point pdfjs at the worker file we bundled via outputFileTracingIncludes.
  // In standalone mode this resolves to node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs
  // relative to process.cwd().
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const workerPath = req.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = workerPath;
  } catch {
    // Fall back to whatever the default fake-worker resolution gives.
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let lastY: number | null = null;
    let pageText = "";
    for (const item of content.items as Array<{ str: string; transform: number[]; hasEOL?: boolean }>) {
      const y = item.transform?.[5];
      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
        pageText += "\n";
      }
      pageText += item.str;
      if (item.hasEOL) pageText += "\n";
      lastY = y ?? lastY;
    }
    pages.push(pageText);
  }
  await pdf.destroy();
  return normalize(pages.join("\n\n"));
}

/** Strip HTML/XHTML → plain text, preserving paragraph breaks and headings. */
function htmlToText(html: string): string {
  let s = html;
  // Remove script/style blocks
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Block-level → newlines
  s = s.replace(/<\/(p|div|section|article|li|br|h[1-6]|pre|blockquote)>/gi, "\n\n");
  s = s.replace(/<br\s*\/?\s*>/gi, "\n");
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, "");
  // Decode common entities
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)));
  return s;
}

/** EPUB: unzip, find spine order from OPF, concat chapter HTMLs. */
export async function parseEpub(buffer: Buffer): Promise<{ title: string; content: string }> {
  const zip = await JSZip.loadAsync(buffer);

  // 1. container.xml → rootfile (the .opf)
  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("EPUB missing META-INF/container.xml");
  const opfPath = /full-path="([^"]+)"/.exec(containerXml)?.[1];
  if (!opfPath) throw new Error("EPUB container missing rootfile path");
  const opfDir = opfPath.includes("/") ? opfPath.replace(/\/[^/]+$/, "/") : "";
  const opfXml = await zip.file(opfPath)?.async("string");
  if (!opfXml) throw new Error(`EPUB missing OPF at ${opfPath}`);

  // 2. title
  const titleMatch = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opfXml);
  const title = titleMatch ? htmlToText(titleMatch[1]).trim() : "Untitled";

  // 3. manifest id → href
  const idToHref = new Map<string, string>();
  const itemRe = /<item\b[^>]*\/>/gi;
  for (const m of opfXml.matchAll(itemRe)) {
    const tag = m[0];
    const id = /id="([^"]+)"/.exec(tag)?.[1];
    const href = /href="([^"]+)"/.exec(tag)?.[1];
    if (id && href) idToHref.set(id, href);
  }

  // 4. spine order
  const spineIds: string[] = [];
  const spineRe = /<itemref\b[^>]*\/>/gi;
  for (const m of opfXml.matchAll(spineRe)) {
    const id = /idref="([^"]+)"/.exec(m[0])?.[1];
    if (id) spineIds.push(id);
  }

  // 5. read each chapter in order
  const chapters: string[] = [];
  for (const id of spineIds) {
    const href = idToHref.get(id);
    if (!href) continue;
    const full = (opfDir + href).replace(/\\/g, "/");
    const file = zip.file(full);
    if (!file) continue;
    const xhtml = await file.async("string");
    chapters.push(htmlToText(xhtml));
  }

  return { title, content: normalize(chapters.join("\n\n")) };
}

export async function parseText(buffer: Buffer): Promise<string> {
  return normalize(buffer.toString("utf8"));
}
