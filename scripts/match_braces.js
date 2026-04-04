const fs = require('fs');
const s = fs.readFileSync('server/gameLoop.js','utf8');
const lines = s.split('\n');
const stack = [];
for (let i=0;i<lines.length;i++){
  const line = lines[i];
  for (let j=0;j<line.length;j++){
    const c = line[j];
    if (c === '{') stack.push({line:i+1,col:j+1});
    else if (c === '}') stack.pop();
  }
}
if (stack.length===0) console.log('All braces matched');
else { console.log('Unmatched opening braces count:', stack.length); console.log(stack); }
