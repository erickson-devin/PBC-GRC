const fs = require('fs');
let file = fs.readFileSync('scripts/seed80053Objectives.ts', 'utf8');

['PE', 'MP', 'SR', 'PS'].forEach(f => {
  let matches = file.match(new RegExp("controlNumber: '" + f + "-[^']+'[\\s\\S]*?(?=controlNumber: '[A-Z]+-)", 'g'));
  if (matches) {
    console.log(matches.join('\\n'));
  }
});
