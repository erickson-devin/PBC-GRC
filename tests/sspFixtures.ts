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

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** A .docx whose body is the given raw WordprocessingML (see wp, wpRuns, wpNum, wtbl), optionally with numbering and styles parts. */
export async function makeDocxBody(bodyXml: string, parts: { numberingXml?: string; stylesXml?: string } = {}): Promise<Buffer> {
  const zip = new JSZip();
  const override = (name: string, type: string) => `<Override PartName="/word/${name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`;
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${override('document', 'document.main')}${parts.numberingXml ? override('numbering', 'numbering') : ''}${parts.stylesXml ? override('styles', 'styles') : ''}</Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  if (parts.numberingXml || parts.stylesXml) {
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.numberingXml ? rel('rId2', 'numbering', 'numbering.xml') : ''}${parts.stylesXml ? rel('rId3', 'styles', 'styles.xml') : ''}</Relationships>`);
  }
  if (parts.numberingXml) zip.file('word/numbering.xml', parts.numberingXml);
  if (parts.stylesXml) zip.file('word/styles.xml', parts.stylesXml);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const wr = (text: string) => `<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
/** One paragraph with one run. */
export const wp = (text: string): string => `<w:p>${wr(text)}</w:p>`;
/** One paragraph whose runs are separated by a line break (<w:br/>) or a page break (<w:br w:type="page"/>). */
export const wpRuns = (parts: string[], sep: 'br' | 'page'): string => {
  const br = sep === 'page' ? '<w:r><w:br w:type="page"/></w:r>' : '<w:r><w:br/></w:r>';
  return `<w:p>${parts.map(wr).join(br)}</w:p>`;
};
/** A numbered list paragraph (auto-numbering; the number itself is not in the text). */
export const wpNum = (text: string, ilvl: number, numId = 1): string => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${wr(text)}</w:p>`;
/** A table; each cell holds one paragraph. */
export const wtbl = (rows: string[][]): string => `<w:tbl><w:tblPr/>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${wp(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
