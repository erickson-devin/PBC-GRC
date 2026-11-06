/**
 * Operator script: prints structure and recall COUNTS for a .docx System Security Plan, to see why the rule-based import finds few
 * controls in it (line breaks, auto-numbering, tables, glued or differently formatted identifiers).
 *
 *   npx tsx scripts/sspDiagnose.ts <path-to.docx>
 *
 * Output is a JSON object of counts only, never any text of the document. Writes nothing. Exit code 0 = ok, 1 = usage or read error.
 */
import fs from 'fs';
import { diagnoseDocx } from '../server/ssp/docxDiagnostics';

const file = process.argv[2];
if (!file) {
  console.error('Usage: sspDiagnose.ts <path-to.docx>');
  process.exit(1);
}

diagnoseDocx(new Uint8Array(fs.readFileSync(file)))
  .then((counts) => {
    console.log(JSON.stringify(counts, null, 2));
    process.exit(0);
  })
  .catch(() => {
    console.error('Could not read the file as a .docx.');
    process.exit(1);
  });
