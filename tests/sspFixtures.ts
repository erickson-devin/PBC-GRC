import JSZip from 'jszip';

/** Minimal PDF and DOCX documents for the SSP import tests. */

const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
/** A minimal valid PDF; each inner array is one page, one string per line. */
export function makePdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  const n = pages.length;
  objs.push('<</Type/Catalog/Pages 2 0 R>>');
  objs.push(`<</Type/Pages/Kids[${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}]/Count ${n}>>`);
  pages.forEach((lines, i) => {
    const content = `BT /F1 11 Tf 72 740 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${4 + i * 2} 0 R/Resources<</Font<</F1 ${3 + n * 2} 0 R>>>>>>`);
    objs.push(`<</Length ${content.length}>>\nstream\n${content}\nendstream`);
  });
  objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  const body = objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('');
  return Buffer.from(`%PDF-1.4\n${body}trailer\n<</Root 1 0 R/Size ${objs.length + 1}>>\n%%EOF`);
}

export async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${xmlEsc(p)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
