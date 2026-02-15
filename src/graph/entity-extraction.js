const { PRODUCT_TYPES, FINANCIAL_CONCEPTS, BRANDS, CATEGORIES } = require('../domain-constants');

function extractEntities(text) {
  const lower = text.toLowerCase();
  const entities = new Set();

  for (const product of PRODUCT_TYPES) {
    if (lower.includes(product)) entities.add(`product:${product}`);
  }
  for (const concept of FINANCIAL_CONCEPTS) {
    if (lower.includes(concept)) entities.add(`concept:${concept}`);
  }

  return [...entities];
}

function extractDocMeta(filePath) {
  const parts = filePath.split('/');
  const meta = { brand: null, brandName: null, category: null, categoryName: null };

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (BRANDS[lower]) {
      meta.brand = lower;
      meta.brandName = BRANDS[lower];
    }
    if (CATEGORIES[lower]) {
      meta.category = lower;
      meta.categoryName = CATEGORIES[lower];
    }
  }

  return meta;
}

module.exports = { extractEntities, extractDocMeta };
