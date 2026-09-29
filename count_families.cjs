const fs = require('fs');
let file1 = fs.readFileSync('src/data/frameworks/assessmentObjectives.ts', 'utf8');
let families = ['AT', 'CA', 'MA', 'MP', 'PE', 'PL', 'PM', 'PS', 'PT', 'RA', 'SA', 'SR'];
let found1 = {};
families.forEach(f => {
  let matches = file1.match(new RegExp("family: '" + f + "'", 'g'));
  found1[f] = matches ? matches.length : 0;
});
console.log('171 matches:', found1);

let file2 = fs.readFileSync('scripts/seed80053Objectives.ts', 'utf8');
let found2 = {};
families.forEach(f => {
  let matches = file2.match(new RegExp("family: '" + f + "'", 'g'));
  found2[f] = matches ? matches.length : 0;
});
console.log('53 matches:', found2);
