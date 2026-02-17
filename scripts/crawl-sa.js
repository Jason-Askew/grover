#!/usr/bin/env node
/**
 * Crawl Services Australia pages, convert to markdown, save to corpus.
 *
 * Usage:
 *   node scripts/crawl-sa.js                    # crawl from seed URLs
 *   node scripts/crawl-sa.js --max 200          # limit total pages
 *   node scripts/crawl-sa.js --dry-run          # list URLs without saving
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const TurndownService = require('turndown');

const CORPUS_DIR = path.join(__dirname, '..', 'corpus', 'ServicesAustralia');
const BASE = 'https://www.servicesaustralia.gov.au';
const DELAY_MS = 800; // polite crawl delay

// Targeted entry points for underrepresented areas
const EXTRA_SEEDS = [
  // Child Support
  `${BASE}/child-support`,
  `${BASE}/child-support-assessment`,
  `${BASE}/child-support-payments`,
  `${BASE}/separated-parents`,
  `${BASE}/collecting-child-support`,
  `${BASE}/child-support-estimator`,
  `${BASE}/ending-a-child-support-assessment`,
  // myGov
  `${BASE}/mygov`,
  `${BASE}/creating-a-mygov-account`,
  `${BASE}/linking-services-to-mygov`,
  `${BASE}/mygov-help`,
  `${BASE}/digital-identity`,
  `${BASE}/myservice`,
  // Medicare — expanded
  `${BASE}/medicare`,
  `${BASE}/medicare-card`,
  `${BASE}/enrol-in-medicare`,
  `${BASE}/medicare-safety-net`,
  `${BASE}/reciprocal-health-care-agreements`,
  `${BASE}/medicare-benefits-schedule`,
  `${BASE}/bulk-billing`,
  `${BASE}/out-of-pocket-costs`,
  `${BASE}/ambulance-cover`,
  `${BASE}/private-health-insurance-rebate`,
  `${BASE}/australian-immunisation-register`,
  `${BASE}/my-health-record`,
  `${BASE}/organ-donor-register`,
  // Aged care — expanded
  `${BASE}/aged-care`,
  `${BASE}/home-care-packages`,
  `${BASE}/residential-aged-care`,
  `${BASE}/aged-care-assessment`,
  `${BASE}/commonwealth-home-support-programme`,
  `${BASE}/respite-care`,
  `${BASE}/aged-care-means-test`,
  // Employment — expanded
  `${BASE}/looking-for-work`,
  `${BASE}/employment-services`,
  `${BASE}/mutual-obligation-requirements`,
  `${BASE}/workforce-australia`,
  `${BASE}/working-while-getting-a-payment`,
  `${BASE}/reporting-employment-income`,
  `${BASE}/working-credit`,
  // Concessions — expanded
  `${BASE}/concession-and-health-care-cards`,
  `${BASE}/health-care-card`,
  `${BASE}/pensioner-concession-card`,
  `${BASE}/commonwealth-seniors-health-card`,
  `${BASE}/low-income-health-care-card`,
  // Families
  `${BASE}/families`,
  `${BASE}/parental-leave-pay`,
  `${BASE}/dad-and-partner-pay`,
  `${BASE}/child-care-subsidy`,
  `${BASE}/additional-child-care-subsidy`,
  `${BASE}/family-tax-benefit`,
  `${BASE}/immunising-your-children`,
  `${BASE}/helping-families`,
  // Students
  `${BASE}/students-and-trainees`,
  `${BASE}/student-start-up-loan`,
  `${BASE}/relocation-scholarship`,
  // Disability
  `${BASE}/disability-and-carers`,
  `${BASE}/national-disability-insurance-scheme`,
  `${BASE}/ndis`,
  // Bereavement & crisis
  `${BASE}/bereavement`,
  `${BASE}/crisis-and-special-help`,
  `${BASE}/emergency-and-disaster`,
  // Indigenous
  `${BASE}/indigenous-australians`,
  // Migrants & refugees
  `${BASE}/newly-arrived-residents`,
  `${BASE}/newly-arrived-residents-waiting-period`,
  `${BASE}/refugees`,
  // Going overseas
  `${BASE}/travelling-outside-australia`,
  `${BASE}/payment-while-outside-australia`,
  // Veterans / DVA
  `${BASE}/veterans`,
  `${BASE}/veteran-payment-affects-your-income-support-payment`,
  `${BASE}/veterans-supplement`,
  `${BASE}/veteran-gold-card`,
  `${BASE}/veteran-white-card`,
  `${BASE}/veteran-orange-card`,
  `${BASE}/defence-force-income-support-allowance`,
  `${BASE}/service-pension`,
  `${BASE}/income-support-supplement`,
  `${BASE}/veterans-affairs-payments`,
  `${BASE}/dva`,
  `${BASE}/department-of-veterans-affairs`,
  `${BASE}/veteran-healthcare`,
  `${BASE}/veteran-card`,
  `${BASE}/defence-service-homes`,
  `${BASE}/war-widow-pension`,
  `${BASE}/war-widows`,
  `${BASE}/military-rehabilitation`,
  `${BASE}/veteran-carer`,
  `${BASE}/veterans-home-care`,
  `${BASE}/veteran-payment`,
  `${BASE}/veteran-entitlements`,
  `${BASE}/help-for-veterans`,
  `${BASE}/getting-help-from-dva`,
  `${BASE}/dva-payments`,
  `${BASE}/dva-health-card`,
  `${BASE}/partner-service-pension`,
  `${BASE}/totally-permanently-incapacitated-pension`,
  `${BASE}/incapacity-payments`,
  `${BASE}/special-rate-disability-pension`,
  `${BASE}/veteran-disability-pension`,
];

// Category mapping based on URL path patterns
const CATEGORY_MAP = [
  { pattern: /\/(age-pension|disability-support-pension|double-orphan|pension-bonus|pension-supplement|pensioner-)/, dir: 'pensions' },
  { pattern: /\/(jobseeker|parenting-payment|family-tax|crisis-payment|carer-payment|special-benefit|advance-payment|stillborn|newborn|income-support|compensation-affect|education-entry|essential-medical|continence-aids|child-disability|paying-tax|payment-choice|proving-your-identity|income-test|how-much-(carer-payment|family-tax|jobseeker)|how-to-(claim|report|get-your-centrelink)|who-can-get|time-limits|status-resolution|australian-victim|centrelink-payment-summary|parental-leave|dad-and-partner)/, dir: 'payments' },
  { pattern: /\/(austudy|abstudy|youth-allowance|carer-allowance|mobility-allowance|newstart|sickness-allowance|pharmaceutical-allowance|telephone-allowance|utilities-allowance|remote-area|rent-assistance|farm-household|fares-allowance|ex-carer-allowance|how-much-carer-allowance)/, dir: 'allowances' },
  { pattern: /\/(medicare|pharmaceutical-benefits|child-dental|pbs-|bulk-billing|immunisation-register|health-record|organ-donor|medicare-safety|reciprocal-health|ambulance|private-health-insurance-rebate|out-of-pocket)/, dir: 'medicare' },
  { pattern: /\/(centrelink-online|supporting-documents)/, dir: 'centrelink' },
  { pattern: /\/(child-support|separated-parents|collecting-child-support)/, dir: 'child-support' },
  { pattern: /\/(mygov|digital-identity|linking-services|creating-a-mygov|myservice)/, dir: 'mygov' },
  { pattern: /\/(child-care|childcare|additional-child-care|child-care-subsidy)/, dir: 'childcare' },
  { pattern: /\/(job-|employment-|mutual-obligation|workforce|apprentice|jobactive|looking-for-work|working-credit|reporting-employment|working-while)/, dir: 'employment' },
  { pattern: /\/(health-care-card|commonwealth-seniors|concession|low-income)/, dir: 'concessions' },
  { pattern: /\/(aged-care|home-care|residential-care|residential-aged|respite|commonwealth-home-support|aged-care-assessment|aged-care-means)/, dir: 'aged-care' },
  { pattern: /\/(families|helping-families|immunising-your-children)/, dir: 'families' },
  { pattern: /\/(students-and-trainee|student-start-up|relocation-scholarship)/, dir: 'students' },
  { pattern: /\/(disability-and-carer|national-disability|ndis)/, dir: 'disability' },
  { pattern: /\/(bereavement|crisis-and-special|emergency-and-disaster)/, dir: 'crisis' },
  { pattern: /\/(indigenous-australian)/, dir: 'indigenous' },
  { pattern: /\/(newly-arrived|refugee|travelling-outside|payment-while-outside)/, dir: 'migrants' },
  { pattern: /\/(veteran|dva|service-pension|war-widow|war-widows|military-rehabilitation|defence-force-income|defence-service-home|incapacity-payment|totally-permanently-incapacitated|special-rate-disability-pension)/, dir: 'veterans' },
];

function categorise(url) {
  for (const { pattern, dir } of CATEGORY_MAP) {
    if (pattern.test(url)) return dir;
  }
  return 'general';
}

function slugify(url) {
  const u = new URL(url);
  let slug = u.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\//g, '--');
  if (!slug) slug = 'index';
  return slug.replace(/[^a-z0-9_-]/gi, '-').replace(/-+/g, '-');
}

// Load existing URLs to skip
function loadExistingUrls() {
  const urls = new Set();
  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const content = fs.readFileSync(full, 'utf-8');
      const match = content.match(/^url:\s*(.+)$/m);
      if (match) urls.add(match[1].trim());
    }
  }
  scan(CORPUS_DIR);
  return urls;
}

function fetch(url) {
  const { execSync } = require('child_process');
  try {
    const html = execSync(
      `curl -sL --max-time 20 -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" "${url}"`,
      { maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' }
    );
    if (!html || html.length < 100) throw new Error('empty response');
    return Promise.resolve(html);
  } catch (e) {
    return Promise.reject(new Error(e.message.slice(0, 80)));
  }
}

function extractLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = new Set();
  $('a[href]').each((_, el) => {
    let href = $(el).attr('href');
    if (!href) return;
    // Resolve relative URLs
    try {
      const resolved = new URL(href, baseUrl);
      // Only follow servicesaustralia.gov.au links
      if (resolved.hostname !== 'www.servicesaustralia.gov.au') return;
      // Skip non-content paths
      if (/\.(pdf|docx?|xlsx?|zip|png|jpg|gif|csv)$/i.test(resolved.pathname)) return;
      if (/\/(search|login|register|api|sites\/default\/files)\//i.test(resolved.pathname)) return;
      // Clean up — remove query params and fragments
      resolved.search = '';
      resolved.hash = '';
      const clean = resolved.toString().replace(/\/$/, '');
      if (clean !== BASE) links.add(clean);
    } catch (e) {}
  });
  return links;
}

function htmlToMarkdown(html) {
  const $ = cheerio.load(html);

  // Extract title
  const title = $('title').text().trim() || $('h1').first().text().trim();

  // Remove nav, header, footer, script, style, sidebar
  $('nav, header, footer, script, style, noscript, .breadcrumb, .sidebar, .skip-link, .back-to-top, #feedback, .feedback, .alert-banner, form').remove();

  // Get main content area
  let content = $('main').html() || $('[role="main"]').html() || $('article').html() || $('body').html();
  if (!content) return null;

  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  // Keep tables
  td.addRule('table', {
    filter: ['table'],
    replacement: (content, node) => {
      // Let turndown handle it naturally
      return '\n' + content + '\n';
    },
  });

  let md = td.turndown(content);

  // Clean up excessive whitespace
  md = md.replace(/\n{4,}/g, '\n\n\n').trim();

  return { title, markdown: md };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Build seed URLs from existing corpus (follow links from pages we already have)
function buildSeedUrls() {
  const urls = [];
  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const content = fs.readFileSync(full, 'utf-8');
      const match = content.match(/^url:\s*(.+)$/m);
      if (match) urls.push(match[1].trim());
    }
  }
  scan(CORPUS_DIR);
  return urls;
}
const CORPUS_URLS = buildSeedUrls();

async function main() {
  const args = process.argv.slice(2);
  const maxPages = parseInt(args.find((_, i) => args[i - 1] === '--max') || '500');
  const dryRun = args.includes('--dry-run');

  const existingUrls = loadExistingUrls();
  console.log(`Existing corpus: ${existingUrls.size} pages`);
  console.log(`Max new pages: ${maxPages}`);
  if (dryRun) console.log('DRY RUN — not saving files\n');

  const seen = new Set([...existingUrls]);
  const discovered = new Set();
  let saved = 0;
  let errors = 0;

  // Phase 1: Crawl EXTRA_SEEDS (targeted entry points) + a sample of existing corpus for link discovery
  // Don't re-crawl all 379 existing pages — just the new entry points + ~50 random existing ones
  const sampleSize = Math.min(50, CORPUS_URLS.length);
  const shuffled = [...CORPUS_URLS].sort(() => Math.random() - 0.5);
  const sampleUrls = shuffled.slice(0, sampleSize);
  const seedQueue = [...EXTRA_SEEDS, ...sampleUrls];

  // Add EXTRA_SEEDS that haven't been crawled yet
  for (const url of EXTRA_SEEDS) {
    if (!existingUrls.has(url)) discovered.add(url);
  }

  console.log(`\nPhase 1: Crawling ${seedQueue.length} seed pages for link discovery (${EXTRA_SEEDS.length} new entry points + ${sampleSize} sample)...\n`);

  for (const seedUrl of seedQueue) {
    try {
      const html = await fetch(seedUrl);
      const links = extractLinks(html, seedUrl);
      for (const link of links) {
        if (!seen.has(link)) {
          discovered.add(link);
        }
      }
      console.log(`  [seed] ${seedUrl} -> found ${links.size} links`);
      await sleep(DELAY_MS);
    } catch (e) {
      console.log(`  [seed] ${seedUrl} -> ERROR: ${e.message}`);
    }
  }

  // Remove already-crawled URLs
  for (const url of existingUrls) discovered.delete(url);

  console.log(`\nPhase 2: Crawling ${Math.min(discovered.size, maxPages)} new pages...\n`);

  const toProcess = [...discovered].slice(0, maxPages);

  for (let i = 0; i < toProcess.length; i++) {
    const url = toProcess[i];
    if (seen.has(url)) continue;
    seen.add(url);

    try {
      const html = await fetch(url);
      const result = htmlToMarkdown(html);
      if (!result || result.markdown.length < 50) {
        console.log(`  [${i + 1}/${toProcess.length}] SKIP ${url}: too short`);
        continue;
      }

      // Also discover links from this page (breadth-first)
      const links = extractLinks(html, url);
      for (const link of links) {
        if (!seen.has(link) && !discovered.has(link) && toProcess.length < maxPages) {
          toProcess.push(link);
          discovered.add(link);
        }
      }

      const category = categorise(url);
      const slug = slugify(url);
      const filePath = path.join(CORPUS_DIR, category, `${slug}.md`);

      const frontMatter = [
        '---',
        `url: ${url}`,
        `title: ${result.title}`,
        `scrapedAt: ${new Date().toISOString()}`,
        `source: servicesaustralia.gov.au`,
        '---',
      ].join('\n');

      const content = `${frontMatter}\n${result.markdown}\n`;

      if (dryRun) {
        console.log(`  [${i + 1}/${toProcess.length}] ${category}/${slug}.md (${result.markdown.length} chars)`);
      } else {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content);
        saved++;
        console.log(`  [${i + 1}/${toProcess.length}] SAVED ${category}/${slug}.md (${(content.length / 1024).toFixed(1)} KB)`);
      }

      await sleep(DELAY_MS);

    } catch (e) {
      console.log(`  [${i + 1}/${toProcess.length}] ERROR ${url}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n=== Crawl Complete ===`);
  console.log(`Discovered: ${discovered.size} new URLs`);
  console.log(`Saved: ${saved} pages`);
  console.log(`Errors: ${errors}`);
  console.log(`Total corpus: ${existingUrls.size + saved} pages`);
  if (saved > 0) {
    console.log(`\nRun: node search.js ingest --index ServicesAustralia`);
  }
}

main().catch(console.error);
