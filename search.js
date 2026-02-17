#!/usr/bin/env node

const [,, cmd, ...rawArgs] = process.argv;

// Extract --index <name> flag from args
let indexName = null;
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--index' && i + 1 < rawArgs.length) {
    indexName = rawArgs[++i];
  } else {
    args.push(rawArgs[i]);
  }
}

// Strip --index from joined query text for search/ask commands
function queryText() {
  return args.filter((a, i) => a !== '--k' && (i === 0 || args[i - 1] !== '--k')).join(' ');
}

function kValue(def) {
  return parseInt(args.find((_, i) => args[i - 1] === '--k') || String(def));
}

switch (cmd) {
  case 'ingest':
    require('./src/commands/ingest').ingest(indexName).catch(console.error);
    break;
  case 'update':
    require('./src/commands/update').update(indexName).catch(console.error);
    break;
  case 'search':
    require('./src/commands/search').search(queryText(), kValue(5), true, indexName).catch(console.error);
    break;
  case 'ask':
    require('./src/commands/ask').ask(queryText(), kValue(8), indexName).catch(console.error);
    break;
  case 'interactive':
  case 'i':
    require('./src/commands/interactive').interactive(indexName).catch(console.error);
    break;
  case 'serve':
  case 'web': {
    const port = parseInt(args[0]) || 3000;
    require('./src/commands/serve').serve(port, indexName).catch(console.error);
    break;
  }
  case 'stats':
    require('./src/commands/stats').stats(indexName);
    break;
  default:
    console.log(`
Usage: node search.js <command> [--index <name>]

Commands:
  ingest              Scan corpus, build vector index + knowledge graph
  update              Only process new/modified/deleted files, rebuild graph
  search "query"      Retrieve matching chunks (add --k 10 for more)
  ask "question"      RAG: retrieve chunks + generate LLM answer
  interactive         Interactive mode — RAG if LLM configured (alias: i)
  serve [port]        Web UI with graph visualization + chat (alias: web)
  stats               Show index and graph statistics

Options:
  --index <name>      Use a named index (e.g. Westpac, ServicesAustralia)
                      Corpus: ./corpus/<name>/  Index: ./index/<name>/

Environment:
  OPENAI_API_KEY      Required for RAG (ask command and interactive mode)
  OPENAI_BASE_URL     Override API endpoint (default: https://api.openai.com/v1)
  LLM_MODEL           Override model (default: gpt-4o-mini)
`);
}
