#!/usr/bin/env node

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'ingest':
    require('./src/commands/ingest').ingest().catch(console.error);
    break;
  case 'update':
    require('./src/commands/update').update().catch(console.error);
    break;
  case 'search':
    require('./src/commands/search').search(
      args.join(' '),
      parseInt(args.find((_, i) => args[i - 1] === '--k') || '5')
    ).catch(console.error);
    break;
  case 'ask':
    require('./src/commands/ask').ask(
      args.join(' '),
      parseInt(args.find((_, i) => args[i - 1] === '--k') || '8')
    ).catch(console.error);
    break;
  case 'interactive':
  case 'i':
    require('./src/commands/interactive').interactive().catch(console.error);
    break;
  case 'serve':
  case 'web':
    require('./src/commands/serve').serve(parseInt(args[0]) || 3000).catch(console.error);
    break;
  case 'stats':
    require('./src/commands/stats').stats();
    break;
  default:
    console.log(`
Usage: node search.js <command>

Commands:
  ingest              Scan ./corpus, build vector index + knowledge graph
  update              Only process new/modified/deleted PDFs, rebuild graph
  search "query"      Retrieve matching chunks (add --k 10 for more)
  ask "question"      RAG: retrieve chunks + generate LLM answer
  interactive         Interactive mode — RAG if LLM configured (alias: i)
  serve [port]        Web UI with graph visualization + chat (alias: web)
  stats               Show index and graph statistics

Environment:
  OPENAI_API_KEY      Required for RAG (ask command and interactive mode)
  OPENAI_BASE_URL     Override API endpoint (default: https://api.openai.com/v1)
  LLM_MODEL           Override model (default: gpt-4o-mini)
`);
}
