import { readFile } from "node:fs/promises";

const catalogUrl = new URL("../data/hulianwa-products.json", import.meta.url);
const detailsUrl = new URL("../data/hulianwa-sku-details.json", import.meta.url);

const catalog = JSON.parse(await readFile(catalogUrl, "utf8"));
const details = JSON.parse(await readFile(detailsUrl, "utf8"));
const products = catalog.products || [];
const results = details.results || [];
const catalogIds = products.map(product => String(product.itemId));
const resultIds = results.map(result => String(result.itemId));
const resultById = new Map(results.map(result => [String(result.itemId), result]));
const rows = results.flatMap(result => (result.rows || []).map(row => ({ ...row, itemId: String(result.itemId) })));

const duplicates = values => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
const errors = results.filter(result => result.error).map(result => ({ itemId: String(result.itemId), error: result.error }));
const missingProducts = catalogIds.filter(itemId => !resultById.has(itemId));
const unexpectedProducts = resultIds.filter(itemId => !catalogIds.includes(itemId));
const emptyLabels = rows.filter(row => !String(row.label || "").trim()).map(row => ({ itemId: row.itemId, skuId: row.skuId }));
const invalidPrices = rows.filter(row => !Number.isFinite(row.price) || row.price < 0).map(row => ({ itemId: row.itemId, skuId: row.skuId, price: row.price }));
const emptySkuIds = rows.filter(row => !String(row.skuId || "").trim()).map(row => ({ itemId: row.itemId, label: row.label }));
const invalidMinimums = results.filter(result => {
  if (result.error) return false;
  const activePrices = (result.rows || []).filter(row => !row.disabled).map(row => row.price).filter(Number.isFinite);
  const allPrices = (result.rows || []).map(row => row.price).filter(Number.isFinite);
  const prices = activePrices.length ? activePrices : allPrices;
  return !prices.length || !Number.isFinite(result.minPrice) || result.minPrice !== Math.min(...prices);
}).map(result => String(result.itemId));

const summary = {
  catalogCount: products.length,
  attemptedCount: details.attemptedCount,
  detailCount: details.detailCount,
  skuCount: rows.length,
  soldOutSkuCount: rows.filter(row => row.disabled).length,
  captureMethods: [...new Set(results.filter(result => !result.error).map(result => result.captureMethod))],
  duplicateCatalogIds: duplicates(catalogIds),
  duplicateResultIds: duplicates(resultIds),
  missingProducts,
  unexpectedProducts,
  errors,
  emptyLabels,
  invalidPrices,
  emptySkuIds,
  invalidMinimums
};

console.log(JSON.stringify(summary, null, 2));

const invalid =
  products.length !== catalog.count ||
  details.catalogCount !== products.length ||
  details.attemptedCount !== results.length ||
  details.detailCount !== results.length - errors.length ||
  details.skuCount !== rows.length ||
  Object.entries(summary).some(([key, value]) => key !== "captureMethods" && Array.isArray(value) && value.length);

if (invalid) process.exitCode = 1;
