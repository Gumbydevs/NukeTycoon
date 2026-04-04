const fs = require('fs');
const s = fs.readFileSync('server/gameLoop.js','utf8');
let balance = 0;
let maxBal = {v:-Infinity,line:0,index:0};
const lines = s.split('\n');
for (let i=0;i<lines.length;i++){
  const line=lines[i];
  for (let j=0;j<line.length;j++){
    const c=line[j];
    if (c==='{') balance++;
    else if (c==='}') balance--;
  }
  if (balance>maxBal.v){ maxBal={v:balance,line:i+1,index:balance}; }
}
console.log('final balance:', balance);
console.log('max balance:', maxBal);
// Print surrounding lines near the max balance line
const start = Math.max(0, maxBal.line-5);
const end = Math.min(lines.length, maxBal.line+5);
console.log('--- context around max balance line ---');
for (let k=start;k<end;k++){
  console.log((k+1)+': '+lines[k]);
}
