const fs = require('fs');
const s = fs.readFileSync('server/gameLoop.js', 'utf8');
const tokens = ['{','}','(',')','[',']','`','"',"'"];
const counts = {};
for (const t of tokens) counts[t] = 0;
for (let i = 0; i < s.length; i++) {
  const c = s[i];
  if (counts.hasOwnProperty(c)) counts[c]++;
}
console.log('counts:', counts);
// Also show last 40 chars of file
console.log('--- tail ---');
console.log(s.slice(-200));
