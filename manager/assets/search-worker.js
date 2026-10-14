/* JSON-lines adapter for the local mobile reader; shares the UI search engine. */
const engine = require('./search-engine.js');
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  try {
    const request = JSON.parse(line);
    if (request.action === 'classify') {
      process.stdout.write(JSON.stringify({ids:(request.groups || []).filter(engine.isCharacterGroup).map(g=>g.id)})+'\n');
      return;
    }
    const terms = engine.terms(request.query || '');
    const indices = [];
    (request.rows || []).forEach((row, index) => {
      if (request.kind === 'models') {
        if(engine.matchesModel(row,request.query))indices.push(index);
      } else {
        const tag = {...row, tag_cn:row.cn, tag_cn_long:row.description};
        if(engine.visible(tag,request.groups || [],request.options || {}) && engine.matches(tag,terms,request.options || {}))indices.push(index);
      }
    });
    process.stdout.write(JSON.stringify({indices})+'\n');
  } catch(error) {
    process.stdout.write(JSON.stringify({error:error.message})+'\n');
  }
});
