const { loadIndexWithFallback } = require('../src/persistence/index-persistence');
const { resolveIndex } = require('../src/config');
const { inferCategoryFromFilename } = require('../src/graph/entity-extraction');

const paths = resolveIndex('ServicesAustralia');
const index = loadIndexWithFallback(paths, 'ServicesAustralia');
const graph = index.graph;

const generalCatId = 'category:general';
const filenames = [];
for (const [sourceId, edges] of graph.edges) {
  for (const e of edges) {
    if (e.target === generalCatId && e.type === 'in_category') {
      const node = graph.nodes.get(sourceId);
      if (node && node.type === 'document') {
        const basename = node.label.split('/').pop().replace(/\.md$/, '');
        if (!inferCategoryFromFilename(node.label.split('/').pop())) {
          filenames.push(basename);
        }
      }
    }
  }
}

// Detect clusters
const formCodes = filenames.filter(f => /^(fa|mo|pb|sa|ss|su|cs|db|hw|im|ip|ci|ma|ms|si|sy)\d/i.test(f) || /^mod-/i.test(f));

const languages = [
  'afaan-oromoo','amharic','anindilyakwa','arabic','assyrian','bembe','bengali','bislama','bosnian',
  'burarra','burmese','chaldean','chin-haka','chinese','croatian','czech','danish','dari','dinka',
  'djambarrpuyngu','dutch','eastern-arrernte','eastside-kriol','estonian','falam-chin','fijian',
  'finnish','french','german','gilbertese','greek','hazaragi','hindi','hungarian','indonesian',
  'italian','japanese','karen','khmer','kimberley-kriol','kinyarwanda','kirundi','korean','kunwinjku',
  'kurdish-kurmanji','kurdish-sorani','lao','latvian','macedonian','malay','maltese','nauruan','nepali',
  'norwegian','pashto','persian-farsi','pitjantjatjara','polish','portuguese','punjabi','rarotongan',
  'rohingya','russian','samoan','serbian','sinhalese','slovak','slovene','solomon-islands-pidgin','somali',
  'spanish','swahili','swedish','tagalog','tamil','tedim-chin','tetum','thai','tibetan','tigrinya',
  'tiwi','tok-pisin','tongan','turkish','tuvaluan','ukrainian','urdu','vietnamese','warlpiri',
  'western-arrernte','yumplatok',
];
const langSet = new Set(languages);
const langFiles = filenames.filter(f => langSet.has(f));
const translationFiles = filenames.filter(f => /translation/.test(f) || /information-your-language|help-your-language/.test(f));

const medicalTerms = /arthritis|spondylitis|cancer|carcinoma|leukaemia|lymphoma|myeloma|tumour|syndrome|disease|deficiency|fibrosis|anaemia|sclerosis|psoriasis|colitis|uveitis|hypertension|amyloidosis|cholestasis|haemoglobinuria|thrombocytopenic|angioedema|uraemic|narcolepsy|atrophy|acromegaly|hidradenitis|neuroblastoma|pouchitis|rhinosinusitis|retinopathy|oedema|neovascularisation|polycythemia|hyperoxaluria|ossificans|hypophosphataemia|opioid-treatment|toxicity-and-severity/i;
const medicalFiles = filenames.filter(f => medicalTerms.test(f) && !formCodes.includes(f) && !langSet.has(f));

const identified = new Set([...formCodes, ...langFiles, ...translationFiles, ...medicalFiles]);
const remaining = filenames.filter(f => !identified.has(f));

console.log('=== CLUSTER SIZES ===');
console.log('Form codes:', formCodes.length);
console.log('Languages:', langFiles.length);
console.log('Translations:', translationFiles.length);
console.log('Medical conditions:', medicalFiles.length);
console.log('Identified total:', identified.size);
console.log('Still remaining:', remaining.length);

// Try to find patterns in remaining
const keywords = {};
for (const f of remaining) {
  const words = f.split('-');
  for (const w of words) {
    if (w.length > 3) {
      keywords[w] = (keywords[w] || 0) + 1;
    }
  }
}

console.log('\n=== TOP KEYWORDS IN REMAINING ===');
Object.entries(keywords)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 60)
  .forEach(([k, v]) => console.log(`  ${k}: ${v}`));

console.log('\n=== REMAINING FILENAMES ===');
remaining.sort().forEach(f => console.log(f));
