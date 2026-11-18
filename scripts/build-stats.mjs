// Builds "normal for this date" flow statistics for every gauge in rivers.json.
// Pulls daily mean discharge over the history window in site.config.json and stores,
// for each calendar day, the 10th/25th/50th/75th/90th percentile of flow across years
// (using a +/-3 day window around the date so each day has enough samples).
// Run once, then yearly:  node scripts/build-stats.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { getAll, mapLimit } from './usgs.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const rivers = JSON.parse(await fs.readFile(path.join(root, 'rivers.json'), 'utf8'));
const config = JSON.parse(await fs.readFile(path.join(root, 'site.config.json'), 'utf8'));

const only = process.argv[2]; // optional: a single site number

// Day index 0..365 using a leap year so Feb 29 has a slot.
function dayIndex(month, day) {
  const start = Date.UTC(2024, 0, 1);
  return Math.round((Date.UTC(2024, month - 1, day) - start) / 86400000);
}
function keyForIndex(idx) {
  const d = new Date(Date.UTC(2024, 0, 1) + idx * 86400000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round = (v) => (v == null ? null : v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

async function buildOne(r) {
  const site = `USGS-${r.site}`;
  const [meta] = await getAll('monitoring-locations', { id: site, skipGeometry: 'false' });
  const daily = await getAll('daily', {
    monitoring_location_id: site,
    parameter_code: '00060',
    statistic_id: '00003',
    time: `${config.historyStart}/${config.historyEnd}`,
    properties: 'time,value',
    limit: 10000,
  });

  const buckets = Array.from({ length: 366 }, () => []);
  const yearsPerBucket = Array.from({ length: 366 }, () => new Set());
  let first = null;
  let last = null;
  for (const f of daily) {
    const { time, value } = f.properties;
    if (value == null) continue;
    const v = Number(value);
    if (!Number.isFinite(v)) continue;
    const [y, m, d] = time.split('-').map(Number);
    const idx = dayIndex(m, d);
    buckets[idx].push(v);
    yearsPerBucket[idx].add(y);
    if (!first || time < first) first = time;
    if (!last || time > last) last = time;
  }

  const normals = {};
  for (let t = 0; t < 366; t++) {
    const vals = [];
    const years = new Set();
    for (let k = -3; k <= 3; k++) {
      const j = (t + k + 366) % 366;
      vals.push(...buckets[j]);
      for (const y of yearsPerBucket[j]) years.add(y);
    }
    if (years.size < 5) continue; // not enough history for this date
    vals.sort((a, b) => a - b);
    normals[keyForIndex(t)] = [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => round(percentile(vals, p)));
  }

  const yearSet = new Set(daily.filter((f) => f.properties.value != null).map((f) => f.properties.time.slice(0, 4)));
  const props = meta?.properties || {};
  const coords = meta?.geometry?.coordinates || [];
  const out = {
    site: r.site,
    name: props.monitoring_location_name || null,
    county: props.county_name || null,
    drainageAreaSqMi: props.drainage_area ?? null,
    lat: coords[1] ?? null,
    lon: coords[0] ?? null,
    historyFrom: first,
    historyTo: last,
    yearsWithData: yearSet.size,
    dailyValues: daily.length,
    normals,
  };
  await fs.writeFile(path.join(root, 'data', 'stats', `${r.site}.json`), JSON.stringify(out));
  console.log(`${r.site} ${r.river} ${r.stretch}: ${daily.length} days, ${first} to ${last}, ${Object.keys(normals).length} dated normals`);
  return out;
}

await fs.mkdir(path.join(root, 'data', 'stats'), { recursive: true });
let queue = [];
try {
  queue = JSON.parse(await fs.readFile(path.join(root, 'queue.json'), 'utf8'));
} catch {}
const targets = only ? [...rivers, ...queue].filter((r) => r.site === only).slice(0, 1) : rivers;
if (only && !targets.length) throw new Error(`Site ${only} is not in rivers.json or queue.json`);
await mapLimit(targets, 3, buildOne);
