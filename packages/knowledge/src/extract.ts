import { knowledgeLimits } from './limits';

export interface ExtractedDocument {
  text: string;
  pageCount: number | null;
  pageText: Array<{ pageNumber: number; text: string }>;
}

const textTypes = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/csv',
]);

export async function extractDocument(input: { mimeType: string; buffer: Buffer }): Promise<ExtractedDocument> {
  if (input.buffer.byteLength > knowledgeLimits.maxFileBytes) {
    throw Object.assign(new Error('file_too_large'), { code: 'file_too_large', retryable: false });
  }
  const mimeType = input.mimeType.toLowerCase();
  if (textTypes.has(mimeType) || mimeType.endsWith('+markdown')) {
    return capText(input.buffer.toString('utf8'), null, []);
  }
  if (mimeType === 'application/pdf') {
    return extractPdf(input.buffer);
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return extractDocx(input.buffer);
  }
  throw Object.assign(new Error('unsupported_file_type'), { code: 'unsupported_file_type', retryable: false });
}

async function extractPdf(buffer: Buffer): Promise<ExtractedDocument> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  if (pdf.numPages > knowledgeLimits.maxPdfPages) {
    throw Object.assign(new Error('too_many_pages'), { code: 'too_many_pages', retryable: false });
  }
  const extracted = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(extracted.text) ? extracted.text : [extracted.text]).map((text, index) => ({
    pageNumber: index + 1,
    text: String(text ?? ''),
  }));
  const combined = pages.map((page) => page.text).join('\n\n').trim();
  if (combined.length < 20) {
    throw Object.assign(new Error('unsupported_scanned_document'), {
      code: 'unsupported_scanned_document',
      retryable: false,
    });
  }
  return capText(combined, pdf.numPages, pages);
}

async function extractDocx(buffer: Buffer): Promise<ExtractedDocument> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.trim();
  if (!text) {
    throw Object.assign(new Error('extraction_failed'), { code: 'extraction_failed', retryable: false });
  }
  return capText(text, null, []);
}

function capText(
  text: string,
  pageCount: number | null,
  pageText: Array<{ pageNumber: number; text: string }>,
): ExtractedDocument {
  if (text.length > knowledgeLimits.maxExtractedCharacters) {
    throw Object.assign(new Error('extracted_text_too_large'), { code: 'extracted_text_too_large', retryable: false });
  }
  return { text, pageCount, pageText };
}

export function safeProcessingMessage(code: string): string {
  if (code === 'unsupported_scanned_document') {
    return 'Extraction failed. This PDF appears to contain only scanned images. OCR is not supported in V1.';
  }
  if (code === 'unsupported_file_type') {
    return 'This file type is not supported. V1 accepts PDF, DOCX, TXT, Markdown, and CSV.';
  }
  if (code === 'file_too_large') {
    return 'This file is larger than the 20 MB upload limit.';
  }
  if (code === 'too_many_pages') {
    return `This PDF has more than ${knowledgeLimits.maxPdfPages} pages.`;
  }
  return 'The document could not be indexed.';
}
