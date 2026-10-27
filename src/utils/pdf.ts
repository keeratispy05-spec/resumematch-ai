import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Extract text in approximate visual reading order, preserving line breaks. */
export async function readPdfText(file: File): Promise<string> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('ไฟล์นี้ไม่ใช่ PDF กรุณาเลือกไฟล์ .pdf');
  }
  if (file.size === 0) throw new Error('ไฟล์ว่าง ไม่มีข้อมูลให้อ่าน');
  if (file.size > 20 * 1024 * 1024) throw new Error('ไฟล์มีขนาดเกิน 20 MB กรุณาลดขนาดไฟล์แล้วลองใหม่');

  let pdf;
  try {
    pdf = await getDocument({ data: await file.arrayBuffer(), useSystemFonts: true, isEvalSupported: false }).promise;
  } catch {
    throw new Error('เปิด PDF ไม่สำเร็จ ไฟล์อาจเสียหาย เข้ารหัส หรือใช้รูปแบบที่ไม่รองรับ');
  }
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const items = content.items
        .filter((item): item is typeof item & { str: string; transform: number[]; width: number } => 'str' in item && 'transform' in item && typeof item.str === 'string' && item.str.trim().length > 0)
        .map((item) => ({ text: item.str.trim(), x: item.transform[4] ?? 0, y: item.transform[5] ?? 0, width: item.width ?? 0 }))
        .sort((a, b) => Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x);

      // Group text items on the same visual line; PDF text item order is often fragmented.
      const lines: { y: number; chunks: { x: number; width: number; text: string }[] }[] = [];
      for (const item of items) {
        let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 3);
        if (!line) {
          line = { y: item.y, chunks: [] };
          lines.push(line);
        }
        line.chunks.push({ x: item.x, width: item.width, text: item.text });
      }
      lines.sort((a, b) => b.y - a.y);
      const pageText = lines.map((line) => {
        line.chunks.sort((a, b) => a.x - b.x);
        let output = '';
        let previousRight: number | null = null;
        for (const chunk of line.chunks) {
          const gap = previousRight === null ? 0 : chunk.x - previousRight;
          if (output && gap > 1.5 && !/^[,.;:!?%)\]}]/.test(chunk.text) && !/[([{\/-]$/.test(output)) output += ' ';
          output += chunk.text;
          previousRight = chunk.x + chunk.width;
        }
        return output.trim();
      }).filter(Boolean).join('\n');
      pages.push(pageText);
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  const text = pages.join('\n\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 30) {
    throw new Error('ไม่พบข้อความที่อ่านได้ใน PDF มีแนวโน้มเป็นไฟล์ภาพสแกน ต้องใช้ OCR หรืออัปโหลด PDF ที่เลือกข้อความได้');
  }
  return text;
}

/** OCR fallback for scanned PDFs. The API key remains on the backend. */
export async function readScannedPdfWithAi(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  const pdfBase64 = btoa(binary);
  const backendBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
  const response = await fetch(`${backendBase}/api/read-pdf-ocr`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, pdfBase64 }),
  });
  const payload = await response.json() as { text?: string; error?: string };
  if (!response.ok || !payload.text) throw new Error(payload.error || 'OCR ไม่สำเร็จ กรุณาใช้ PDF ที่มีข้อความ');
  return payload.text;
}
