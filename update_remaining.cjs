const fs = require('fs');

function processFile(path) {
  let text = fs.readFileSync(path, 'utf8');

  // Physical Security (PE)
  text = text.replace(/encrypted RFID badge readers/gi, '**RFID badges**');
  text = text.replace(/90-day video retention/gi, '**90-day CCTV retention**');
  text = text.replace(/\[ODP: 90-day video retention\]/gi, '[ODP: **90-day CCTV retention**]');
  text = text.replace(/defaultValue: '90-day video retention'/g, "defaultValue: '**90-day CCTV retention**'");

  // Media Sanitization (MP)
  text = text.replace(/NIST SP 800-88 Rev\. 1 guidelines \(cryptographic erase or degaussing\/physical degaussing and shredding to <2mm particles\)/gi, '**NIST SP 800-88 Rev 1 crypto-wipe**');

  // Supply Chain (SR)
  text = text.replace(/federal NDAA Section 889 and Section 5949 prohibitions/gi, '**NDAA 889/5949 compliance**');
  // Add SBOM generation to SR-2 plan
  text = text.replace(/third-party dependency scanning, and hardware provenance verification/gi, 'third-party dependency scanning, **SBOM generation**, and hardware provenance verification');

  // Personnel Screening (PS)
  text = text.replace(/Tier 3 \(Secret\) or Tier 5 \(Top Secret\) federal background investigations, while moderate positions require Tier 1 checks/gi, '**Tier 1/3/5 background checks**');

  fs.writeFileSync(path, text);
}

processFile('src/data/frameworks/assessmentObjectives.ts');
processFile('scripts/seed80053Objectives.ts');
