#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────────

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';
const SITE_URL = 'https://www.servicesaustralia.gov.au';
const SOURCE_ID = 'servicesaustralia.gov.au';

const CORPUS_DIR = path.join(__dirname, '..', 'corpus', 'ServicesAustralia');
const MANIFEST_PATH = path.join(__dirname, '..', 'corpus', '.crawl-manifest.json');

const SCRAPE_DELAY_MS = 1000;
const BACKOFF_DELAY_MS = 5000;
const MAP_LIMIT = 500;

// Path prefixes to include (matched against pathname start)
const INCLUDE_PREFIXES = [
  '/age-pension', '/jobseeker-payment', '/youth-allowance',
  '/disability-support-pension', '/carer-payment', '/carer-allowance',
  '/parenting-payment', '/family-tax-benefit', '/child-care-subsidy',
  '/austudy', '/abstudy', '/rent-assistance',
  '/medicare-card', '/medicare-safety-net', '/pharmaceutical-benefits',
  '/get-centrelink-payment', '/centrelink-online-account',
  '/mygov', '/manage-your-money',
];

// Keywords anywhere in the path also qualify a URL
const INCLUDE_KEYWORDS = [
  'payment', 'pension', 'allowance', 'benefit', 'eligibility', 'claim',
];

// Patterns to always exclude
const EXCLUDE_PATTERNS = [
  '/forms',
];

// Binary file extensions to skip (PDFs are allowed — Firecrawl extracts text)
const EXCLUDE_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp',
  '.zip', '.gz', '.tar', '.docx', '.xlsx', '.pptx',
];

// ── CLI args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { maxPages: Infinity, force: false, dryRun: false, singleUrl: null, reorganise: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--max-pages':
        opts.maxPages = parseInt(args[++i], 10);
        break;
      case '--force':
        opts.force = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--url':
        opts.singleUrl = args[++i];
        break;
      case '--reorganise':
      case '--reorganize':
        opts.reorganise = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: node scripts/crawl.js [options]

Options:
  --max-pages N   Limit number of pages scraped (default: unlimited)
  --force         Re-scrape everything, ignoring manifest
  --dry-run       Discover URLs only, don't scrape
  --url URL       Scrape a single specific URL
  --reorganise    Move existing files into category subfolders
  -h, --help      Show this help

Environment:
  FIRECRAWL_API_KEY   Required. Your Firecrawl API key (fc-...)
`);
        process.exit(0);
    }
  }
  return opts;
}

// ── Firecrawl helpers ───────────────────────────────────────────────────────

function getApiKey() {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    console.error('Error: FIRECRAWL_API_KEY environment variable is required.');
    console.error('Get a key at https://firecrawl.dev and export it.');
    process.exit(1);
  }
  return key;
}

async function firecrawlMap(apiKey) {
  console.log(`Mapping ${SITE_URL} (limit ${MAP_LIMIT})...`);
  const res = await fetch(`${FIRECRAWL_BASE}/map`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: SITE_URL, limit: MAP_LIMIT }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Map request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const urls = data.links || data.urls || [];
  console.log(`Map returned ${urls.length} URLs.`);
  return urls;
}

async function firecrawlScrape(apiKey, url) {
  const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
    }),
  });

  if (res.status === 402) {
    return { error: 'credits_exhausted', status: 402 };
  }
  if (res.status === 429) {
    return { error: 'rate_limited', status: 429 };
  }
  if (!res.ok) {
    const body = await res.text();
    return { error: `HTTP ${res.status}: ${body}`, status: res.status };
  }

  const data = await res.json();
  const md = data.data?.markdown || '';
  const title = data.data?.metadata?.title || '';
  const statusCode = data.data?.metadata?.statusCode || res.status;
  return { markdown: md, title, statusCode };
}

// ── URL filtering ───────────────────────────────────────────────────────────

function shouldIncludeUrl(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { return false; }

  // Must be same host
  if (!parsed.hostname.endsWith('servicesaustralia.gov.au')) return false;

  const pathname = parsed.pathname.toLowerCase();

  // Exclude binary file extensions (but not PDFs)
  for (const ext of EXCLUDE_EXTENSIONS) {
    if (pathname.endsWith(ext)) return false;
  }

  // Exclude patterns
  for (const ex of EXCLUDE_PATTERNS) {
    if (pathname.startsWith(ex) || pathname.includes(ex)) return false;
  }

  // Exclude context= query params (duplicate views)
  if (parsed.searchParams.has('context')) return false;

  // Always include PDFs (Firecrawl extracts text from them)
  if (pathname.endsWith('.pdf')) return true;

  // Include by prefix
  for (const prefix of INCLUDE_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }

  // Include by keyword
  for (const kw of INCLUDE_KEYWORDS) {
    if (pathname.includes(kw)) return true;
  }

  return false;
}

// ── Manifest ────────────────────────────────────────────────────────────────

function loadManifest() {
  if (fs.existsSync(MANIFEST_PATH)) {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  }
  return { source: SOURCE_ID, lastRun: null, pages: {} };
}

function saveManifest(manifest) {
  manifest.lastRun = new Date().toISOString();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

// ── Categorisation ──────────────────────────────────────────────────────────

// Priority-ordered: first match wins
const CATEGORIES = [
  { folder: 'documents',  test: (p) => p.endsWith('.pdf') },
  { folder: 'medicare',   test: (p) => p.includes('medicare') || p.includes('pharmaceutical-benefits') || p.includes('child-dental-benefits') },
  { folder: 'pensions',   test: (p) => p.includes('pension') },
  { folder: 'allowances', test: (p) => p.includes('allowance') || p.includes('austudy') || p.includes('abstudy') || p.includes('rent-assistance') },
  { folder: 'payments',   test: (p) => p.includes('payment') || p.includes('supplement') || p.includes('benefit') },
  { folder: 'centrelink', test: (p) => p.includes('centrelink') || p.includes('mygov') },
  { folder: 'eligibility', test: (p) => p.includes('eligibility') || p.includes('claim') || p.includes('who-can-get') },
];

function categorise(urlStr) {
  let pathname;
  try { pathname = new URL(urlStr).pathname.toLowerCase(); } catch { return 'general'; }
  for (const cat of CATEGORIES) {
    if (cat.test(pathname)) return cat.folder;
  }
  return 'general';
}

// ── File helpers ────────────────────────────────────────────────────────────

function urlToFilePath(urlStr) {
  const parsed = new URL(urlStr);
  const category = categorise(urlStr);
  // Strip leading slash, replace remaining slashes with --
  let slug = parsed.pathname.replace(/^\//, '').replace(/\/+/g, '--');
  // Remove trailing slashes
  slug = slug.replace(/--$/, '');
  // Default to 'index' for root
  if (!slug) slug = 'index';
  return path.join(category, slug + '.md');
}

function contentHash(content) {
  return 'sha256-' + crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function buildMarkdown(url, title, content, scrapedAt) {
  const frontMatter = [
    '---',
    `url: ${url}`,
    `title: ${title}`,
    `scrapedAt: ${scrapedAt}`,
    `source: ${SOURCE_ID}`,
    '---',
    '',
  ].join('\n');
  return frontMatter + content;
}

// ── Sleep ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Reorganise existing files ───────────────────────────────────────────────

function reorganise() {
  const manifest = loadManifest();
  let moved = 0;

  for (const [url, entry] of Object.entries(manifest.pages)) {
    const newRelPath = urlToFilePath(url);
    const newManifestPath = `ServicesAustralia/${newRelPath}`;

    if (entry.file === newManifestPath) continue; // already in correct place

    const oldAbsPath = path.join(__dirname, '..', 'corpus', entry.file);
    const newAbsPath = path.join(CORPUS_DIR, newRelPath);

    if (!fs.existsSync(oldAbsPath)) {
      console.log(`  Skip (missing): ${entry.file}`);
      continue;
    }

    fs.mkdirSync(path.dirname(newAbsPath), { recursive: true });
    fs.renameSync(oldAbsPath, newAbsPath);
    entry.file = newManifestPath;
    moved++;
    console.log(`  ${entry.file}`);
  }

  saveManifest(manifest);
  console.log(`\nReorganised ${moved} files. Manifest updated.`);

  // Clean up empty directories left behind
  cleanEmptyDirs(CORPUS_DIR);
}

function cleanEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = path.join(dir, entry.name);
      cleanEmptyDirs(sub);
      if (fs.readdirSync(sub).length === 0) fs.rmdirSync(sub);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  if (opts.reorganise) {
    console.log('Reorganising existing files into category subfolders...');
    reorganise();
    return;
  }

  const apiKey = getApiKey();
  const manifest = opts.force ? { source: SOURCE_ID, lastRun: null, pages: {} } : loadManifest();

  // Discover URLs
  let urls;
  if (opts.singleUrl) {
    urls = [opts.singleUrl];
  } else {
    const allUrls = await firecrawlMap(apiKey);
    urls = allUrls.filter(shouldIncludeUrl);
    console.log(`${urls.length} URLs match filter criteria.`);
  }

  // Filter out already-scraped URLs (unless --force)
  const newUrls = opts.force ? urls : urls.filter(u => !manifest.pages[u]);
  console.log(`${newUrls.length} new URLs to scrape (${urls.length - newUrls.length} already in manifest).`);

  if (opts.dryRun) {
    console.log('\n-- Dry run: URLs that would be scraped --');
    const toShow = newUrls.slice(0, opts.maxPages);
    toShow.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
    if (newUrls.length > opts.maxPages) {
      console.log(`  ... and ${newUrls.length - opts.maxPages} more`);
    }
    console.log(`\nTotal: ${newUrls.length} pages would be scraped.`);
    return;
  }

  // Ensure output directory
  fs.mkdirSync(CORPUS_DIR, { recursive: true });

  const toScrape = newUrls.slice(0, opts.maxPages);
  let scraped = 0;
  let errors = 0;

  for (let i = 0; i < toScrape.length; i++) {
    const url = toScrape[i];
    const fileName = urlToFilePath(url);
    console.log(`[${i + 1}/${toScrape.length}] Scraping: ${fileName.replace('.md', '')}...`);

    let result = await firecrawlScrape(apiKey, url);

    // Handle rate limiting with one retry
    if (result.error === 'rate_limited') {
      console.log(`  Rate limited — waiting ${BACKOFF_DELAY_MS / 1000}s and retrying...`);
      await sleep(BACKOFF_DELAY_MS);
      result = await firecrawlScrape(apiKey, url);
    }

    // Handle credits exhausted — stop gracefully
    if (result.error === 'credits_exhausted') {
      console.error(`\nCredits exhausted after ${scraped} pages. Saving manifest and stopping.`);
      saveManifest(manifest);
      process.exit(1);
    }

    // Handle other errors
    if (result.error) {
      console.error(`  Error: ${result.error}`);
      errors++;
      await sleep(SCRAPE_DELAY_MS);
      continue;
    }

    // Save markdown file
    const scrapedAt = new Date().toISOString();
    const fullMarkdown = buildMarkdown(url, result.title, result.markdown, scrapedAt);
    const filePath = path.join(CORPUS_DIR, fileName);

    // Ensure subdirectory exists for nested paths
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, fullMarkdown);

    // Update manifest
    manifest.pages[url] = {
      file: `ServicesAustralia/${fileName}`,
      title: result.title,
      scrapedAt,
      contentHash: contentHash(result.markdown),
      statusCode: result.statusCode,
    };

    scraped++;

    // Delay between requests
    if (i < toScrape.length - 1) {
      await sleep(SCRAPE_DELAY_MS);
    }
  }

  // Save manifest
  saveManifest(manifest);

  console.log(`\nDone. Scraped ${scraped} pages, ${errors} errors.`);
  console.log(`Manifest: ${MANIFEST_PATH}`);
  console.log(`Corpus:   ${CORPUS_DIR}/`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
