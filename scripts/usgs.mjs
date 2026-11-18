// Small client for the USGS Water Data APIs (api.waterdata.usgs.gov).
// The legacy waterservices.usgs.gov API is being shut down in early 2027, so this uses the new one.
// An API key is optional. Set USGS_API_KEY to get higher rate limits.

const BASE = 'https://api.waterdata.usgs.gov/ogcapi/v0/collections';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const headers = { Accept: 'application/json' };
  if (process.env.USGS_API_KEY) headers['X-Api-Key'] = process.env.USGS_API_KEY;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return await res.json();
      lastError = new Error(`USGS ${res.status} for ${url}`);
      if (res.status !== 429 && res.status < 500) throw lastError;
    } catch (err) {
      lastError = err;
    }
    await sleep(1500 * (attempt + 1));
  }
  throw lastError;
}

function buildUrl(collection, params) {
  const url = new URL(`${BASE}/${collection}/items`);
  const all = { f: 'json', skipGeometry: 'true', ...params };
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, String(v));
  return url;
}

// Fetch every page of a collection query, following "next" links.
export async function getAll(collection, params, { maxPages = 50 } = {}) {
  let url = buildUrl(collection, params);
  const features = [];
  for (let page = 0; page < maxPages && url; page++) {
    const data = await fetchJson(url);
    features.push(...(data.features || []));
    const next = (data.links || []).find((l) => l.rel === 'next');
    url = next ? next.href : null;
  }
  return features;
}

// Run async tasks with limited concurrency.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export const MONTANA_BBOX = '-116.05,44.36,-104.04,49.0';
