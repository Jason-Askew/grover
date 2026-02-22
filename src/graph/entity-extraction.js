const { PRODUCT_TYPES, FINANCIAL_CONCEPTS, BRANDS, CATEGORIES } = require('../domain-constants');
const { PAYMENT_TYPES, GOVERNMENT_CONCEPTS, SA_BRANDS, SA_CATEGORIES } = require('../domain-constants-sa');

function compilePatterns(terms) {
  return terms.map(t => ({
    term: t,
    pattern: new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
  }));
}

const DOMAINS = {
  Westpac: {
    products: compilePatterns(PRODUCT_TYPES),
    concepts: compilePatterns(FINANCIAL_CONCEPTS),
    brands: BRANDS,
    categories: CATEGORIES,
  },
  ServicesAustralia: {
    products: compilePatterns(PAYMENT_TYPES),
    concepts: compilePatterns(GOVERNMENT_CONCEPTS),
    brands: SA_BRANDS,
    categories: SA_CATEGORIES,
  },
};

function extractEntities(text, domain = 'Westpac') {
  const entities = new Set();
  const d = DOMAINS[domain] || DOMAINS.Westpac;

  for (const { term, pattern } of d.products) {
    if (pattern.test(text)) entities.add(`product:${term}`);
  }
  for (const { term, pattern } of d.concepts) {
    if (pattern.test(text)) entities.add(`concept:${term}`);
  }

  return [...entities];
}

function extractDocMeta(filePath, domain = 'Westpac') {
  const parts = filePath.split('/');
  const meta = { brand: null, brandName: null, category: null, categoryName: null };
  const d = DOMAINS[domain] || DOMAINS.Westpac;

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (d.brands[lower]) {
      meta.brand = lower;
      meta.brandName = d.brands[lower];
    }
    if (d.categories[lower]) {
      meta.category = lower;
      meta.categoryName = d.categories[lower];
    }
  }

  return meta;
}

module.exports = { extractEntities, extractDocMeta, DOMAINS };
