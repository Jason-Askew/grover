const { PRODUCT_TYPES, FINANCIAL_CONCEPTS, BRANDS, CATEGORIES } = require('../domain-constants');
const { PAYMENT_TYPES, GOVERNMENT_CONCEPTS, SA_BRANDS, SA_CATEGORIES } = require('../domain-constants-sa');

const DOMAINS = {
  Westpac: {
    products: PRODUCT_TYPES,
    concepts: FINANCIAL_CONCEPTS,
    brands: BRANDS,
    categories: CATEGORIES,
  },
  ServicesAustralia: {
    products: PAYMENT_TYPES,
    concepts: GOVERNMENT_CONCEPTS,
    brands: SA_BRANDS,
    categories: SA_CATEGORIES,
  },
};

function extractEntities(text, domain = 'Westpac') {
  const lower = text.toLowerCase();
  const entities = new Set();
  const d = DOMAINS[domain] || DOMAINS.Westpac;

  for (const product of d.products) {
    if (lower.includes(product)) entities.add(`product:${product}`);
  }
  for (const concept of d.concepts) {
    if (lower.includes(concept)) entities.add(`concept:${concept}`);
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
