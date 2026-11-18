// Builds the static site into dist/.
// Pulls the latest USGS readings, compares each river with its normal flow for the date,
// makes a fishable call, and writes one page per river plus the index.
// Run:  node scripts/build.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { getAll, mapLimit, MONTANA_BBOX } from './usgs.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
const rivers = JSON.parse(await fs.readFile(path.join(root, 'rivers.json'), 'utf8'));
const config = JSON.parse(await fs.readFile(path.join(root, 'site.config.json'), 'utf8'));
// Path prefix when the site is served from a sub-folder (e.g. user.github.io/isitfishable).
const BASE = new URL(config.siteUrl).pathname.replace(/\/$/, '');
const TZ = 'America/Denver';
const HOUR = 3600 * 1000;
const STALE_HOURS = 12;
const WARM_F = 70;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtFlow = (n) => (n == null ? '–' : n >= 100 ? fmtInt(n) : (Math.round(n * 10) / 10).toString());
const cToF = (c) => (c * 9) / 5 + 32;

const dateParts = (ms) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return p;
};
const mmdd = (ms) => {
  const p = dateParts(ms);
  return `${p.month}-${p.day}`;
};
const ymd = (ms) => {
  const p = dateParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
};
const fmtDay = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(new Date(ms));
const fmtWeekday = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date(ms));
const fmtStamp = (ms) =>
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms));
const monthYear = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const titleCase = (slug) => slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const theRiver = (name) => (/Creek$/.test(name) ? name : `the ${name}`);

// ---------- data ----------
async function loadStats(site) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, 'data', 'stats', `${site}.json`), 'utf8'));
  } catch {
    return null;
  }
}

// Latest reading per site for one parameter, from a single statewide query.
async function latestByParam(parameterCode) {
  const features = await getAll('latest-continuous', {
    parameter_code: parameterCode,
    bbox: MONTANA_BBOX,
    limit: 2000,
    properties: 'monitoring_location_id,time,value,qualifier',
  });
  const out = {};
  for (const f of features) {
    const p = f.properties;
    const site = p.monitoring_location_id.replace('USGS-', '');
    const t = Date.parse(p.time);
    if (!out[site] || t > out[site].t) {
      out[site] = { t, v: p.value == null ? null : Number(p.value), qualifier: p.qualifier };
    }
  }
  return out;
}

// Last 7 days of flow for every gauge. One batched request first (keeps the whole build to a
// handful of calls, well inside the no-key USGS limit); one request per gauge if that fails.
async function lastWeeks(sites) {
  const wanted = new Set(sites.map((s) => `USGS-${s}`));
  const common = { parameter_code: '00060', time: 'P7D', limit: 10000, properties: 'monitoring_location_id,time,value' };
  let features = [];
  try {
    features = await getAll(
      'continuous',
      { ...common, filter: `monitoring_location_id IN (${[...wanted].map((s) => `'${s}'`).join(',')})`, 'filter-lang': 'cql-text' },
      { maxPages: 6 },
    );
    if (!features.length || features.some((f) => !wanted.has(f.properties.monitoring_location_id))) {
      throw new Error('filter not applied');
    }
  } catch (err) {
    console.warn(`Batched 7-day fetch failed (${err.message}); fetching one gauge at a time.`);
    features = [];
    await mapLimit(sites, 3, async (s) => {
      try {
        features.push(...(await getAll('continuous', { ...common, monitoring_location_id: `USGS-${s}` })));
      } catch (e) {
        console.warn(`7-day fetch failed for ${s}: ${e.message}`);
      }
    });
  }
  const bySite = {};
  for (const f of features) {
    const p = f.properties;
    if (p.value == null) continue;
    const v = Number(p.value);
    if (!Number.isFinite(v)) continue;
    (bySite[p.monitoring_location_id.replace('USGS-', '')] ||= []).push({ t: Date.parse(p.time), v });
  }
  const out = {};
  for (const s of sites) {
    // One point per hour (last reading in each hour) keeps the chart light.
    const hourly = new Map();
    for (const p of (bySite[s] || []).sort((a, b) => a.t - b.t)) hourly.set(Math.floor(p.t / HOUR), p);
    out[s] = [...hourly.values()];
  }
  return out;
}

function change24(week) {
  if (week.length < 2) return null;
  const now = week[week.length - 1];
  const target = now.t - 24 * HOUR;
  let best = null;
  for (const p of week) if (!best || Math.abs(p.t - target) < Math.abs(best.t - target)) best = p;
  if (!best || Math.abs(best.t - target) > 3 * HOUR || best.v <= 0) return null;
  return (now.v - best.v) / best.v;
}

// ---------- the call ----------
function makeCall({ flow, flowTime, normal, chg, tempF, buildTime }) {
  const day = fmtDay(flowTime ?? buildTime);
  if (flow == null) {
    return { status: 'unknown', word: 'No live reading', reason: 'USGS has no current flow for this gauge. It may be off for the season or iced over.' };
  }
  if (buildTime - flowTime > STALE_HOURS * HOUR) {
    return { status: 'unknown', word: 'Gauge is quiet', reason: `This gauge has not reported since ${fmtStamp(flowTime)}.` };
  }
  let band = null;
  if (normal) {
    const [p10, p25, , p75, p90] = normal;
    band = flow < p10 ? 'very-low' : flow < p25 ? 'low' : flow <= p75 ? 'normal' : flow <= p90 ? 'high' : 'very-high';
  }
  const rising = chg != null && chg > 0.1;
  const risingFast = chg != null && chg > 0.25;
  let call;
  if (band === 'very-high' && rising) {
    call = { status: 'no', word: 'Blown out', reason: `Flow is higher than 90% of past years on ${day} and still rising. Expect muddy water.` };
  } else if (band === 'very-high') {
    call = { status: 'maybe', word: 'High water', reason: `Flow is higher than 90% of past years on ${day}. Wade with care and fish the edges.` };
  } else if (risingFast) {
    call = { status: 'maybe', word: 'Rising fast', reason: `Flow is up ${Math.round(chg * 100)}% in 24 hours. Expect some color.` };
  } else if (band === 'very-low') {
    call = { status: 'yes', word: 'Fishable, low water', reason: `Flow is lower than 90% of past years on ${day}. Expect clear water and spooky fish.` };
  } else if (band === 'low') {
    call = { status: 'yes', word: 'Fishable', reason: `Flow is on the low side of normal for ${day}.` };
  } else if (band === 'high') {
    call = { status: 'yes', word: 'Fishable', reason: `Flow is on the high side of normal for ${day}.` };
  } else if (band === 'normal') {
    call = { status: 'yes', word: 'Fishable', reason: `Flow is inside the normal range for ${day}.` };
  } else {
    call = { status: 'unknown', word: 'No history for this date', reason: 'This gauge does not have enough past years for this date to compare against.' };
  }
  if (tempF != null && tempF >= WARM_F && call.status !== 'no') {
    call = { status: 'maybe', word: 'Warm water', reason: `Water is ${Math.round(tempF)}°F. Trout get stressed above ${WARM_F}°F. Fish early mornings or give the river a rest.` };
  }
  call.band = band;
  return call;
}

// ---------- chart ----------
function niceStep(max) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function chartSvg(week, stats, riverName) {
  if (week.length < 6) return '<p class="muted">Not enough readings in the last 7 days to draw a chart.</p>';
  const W = 720, H = 240, L = 52, R = 12, T = 12, B = 30;
  const t0 = week[0].t, t1 = week[week.length - 1].t;
  const norms = week.map((p) => stats?.normals?.[mmdd(p.t)] || null);
  let max = Math.max(...week.map((p) => p.v), ...norms.filter(Boolean).map((n) => n[3]));
  const step = niceStep(max * 1.08);
  max = Math.ceil((max * 1.08) / step) * step;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / max) * (H - T - B);

  let band = '';
  let median = '';
  const withNorm = week.map((p, i) => ({ p, n: norms[i] })).filter((d) => d.n);
  if (withNorm.length > 2) {
    const top = withNorm.map((d) => `${x(d.p.t).toFixed(1)},${y(d.n[3]).toFixed(1)}`);
    const bot = withNorm.map((d) => `${x(d.p.t).toFixed(1)},${y(d.n[1]).toFixed(1)}`).reverse();
    band = `<polygon class="band" points="${[...top, ...bot].join(' ')}"/>`;
    median = `<polyline class="median" points="${withNorm.map((d) => `${x(d.p.t).toFixed(1)},${y(d.n[2]).toFixed(1)}`).join(' ')}"/>`;
  }
  const line = `<polyline class="flow" points="${week.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}"/>`;

  let grid = '';
  for (let v = 0; v <= max + 1e-9; v += step) {
    grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="tick" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmtInt(v)}</text>`;
  }
  let days = '';
  let prev = null;
  for (const p of week) {
    const d = ymd(p.t);
    if (prev && d !== prev) {
      days += `<line class="grid day" x1="${x(p.t).toFixed(1)}" x2="${x(p.t).toFixed(1)}" y1="${T}" y2="${H - B}"/><text class="tick" x="${(x(p.t) + 4).toFixed(1)}" y="${H - 10}">${fmtWeekday(p.t)}</text>`;
    }
    prev = d;
  }
  const last = week[week.length - 1];
  const dot = `<circle class="dot" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4"/>`;
  return `<figure class="chart">
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chart-title">
    <title id="chart-title">${esc(riverName)} flow over the last 7 days compared with the normal range for those dates</title>
    ${grid}${days}${band}${median}${line}${dot}
    <text class="tick" x="${L}" y="${T + 2}" dy="-2">cfs</text>
  </svg>
  <figcaption><span class="key flow"></span>Flow, last 7 days <span class="key band"></span>Normal range (middle half of past years) <span class="key median"></span>Median</figcaption>
</figure>`;
}

// ---------- page shell ----------
function page({ title, description, canonical, body, jsonLd }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M2 20c5-6 9-6 14 0s9 6 14 0' fill='none' stroke='%231f6f8b' stroke-width='3' stroke-linecap='round'/></svg>">
<link rel="stylesheet" href="${BASE}/style.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="${BASE}/">Is It Fishable?</a><nav><a href="${BASE}/">Rivers</a><a href="${BASE}/how-it-works/">How it works</a></nav></div></header>
<main class="wrap">
${body}
</main>
<footer class="wrap foot">
<p>Flow and temperature data: U.S. Geological Survey. Recent USGS data is provisional and can be revised. This site is not affiliated with USGS.</p>
<p>A flow-based call, not a fishing report. Check with a local fly shop before you go.</p>
</footer>
</body>
</html>
`;
}

const chip = (call) => `<span class="chip ${call.status}">${esc(call.word)}</span>`;

// ---------- river page ----------
function riverPage(r, d, all) {
  const url = `${config.siteUrl}/${r.slug}/`;
  const name = `${r.river} ${r.stretch}`;
  const n = d.normal;
  const pct = n && d.flow != null ? Math.round((d.flow / n[2]) * 100) : null;
  const chgTxt = d.chg == null ? '–' : Math.abs(d.chg) < 0.03 ? 'Steady' : `${d.chg > 0 ? 'Up' : 'Down'} ${Math.round(Math.abs(d.chg) * 100)}%`;
  const day = fmtDay(d.flowTime ?? d.buildTime);

  const stats = [
    ['Flow now', d.flow == null ? '–' : `${fmtFlow(d.flow)} cfs`],
    [`Normal for ${day}`, n ? `${fmtFlow(n[2])} cfs` : '–'],
    ['Versus normal', pct == null ? '–' : `${pct}%`],
    ['Last 24 hours', chgTxt],
  ];
  if (d.tempF != null) stats.push(['Water temp', `${Math.round(d.tempF)}°F`]);

  const guide = r.guideTown
    ? `<section class="card guide">
  <h2>Fish it with a guide</h2>
  <p>Guided trips leaving from ${esc(titleCase(r.guideTown))} are listed on FishingBooker.</p>
  <p><a class="button" rel="sponsored noopener" href="https://fishingbooker.com/destinations/location/us/MT/${esc(r.guideTown)}${esc(config.fishingbookerAffiliateParam || '')}">See guided trips near ${esc(titleCase(r.guideTown))}</a></p>
  <p class="fine">We may earn a commission if you book through this link. It costs you nothing extra.</p>
</section>`
    : '';

  const s = d.stats;
  const peak = s ? Object.entries(s.normals).reduce((a, b) => (b[1][2] > a[1][2] ? b : a)) : null;
  const low = s ? Object.entries(s.normals).reduce((a, b) => (b[1][2] < a[1][2] ? b : a)) : null;
  const md = (k) => fmtDay(Date.parse(`2024-${k}T18:00:00Z`));
  const about = s
    ? `<ul class="facts">
  <li>Gauge: ${esc(s.name)} (USGS ${esc(r.site)})${s.county ? `, ${esc(s.county)}` : ''}</li>
  ${s.drainageAreaSqMi ? `<li>Drains ${fmtInt(s.drainageAreaSqMi)} square miles above the gauge</li>` : ''}
  <li>Normals use daily flows from ${esc(monthYear(s.historyFrom))} to ${esc(monthYear(s.historyTo))}</li>
  ${peak ? `<li>Typical peak: about ${fmtFlow(peak[1][2])} cfs around ${md(peak[0])}</li>` : ''}
  ${low ? `<li>Typical low: about ${fmtFlow(low[1][2])} cfs around ${md(low[0])}</li>` : ''}
  <li><a href="https://waterdata.usgs.gov/monitoring-location/USGS-${esc(r.site)}/" rel="noopener">Raw gauge data on USGS</a></li>
</ul>`
    : '<p class="muted">No history file for this gauge yet.</p>';

  const nearby = all
    .filter((o) => o.r.region === r.region && o.r.slug !== r.slug)
    .map((o) => `<li><a href="${BASE}/${o.r.slug}/">${esc(o.r.river)} ${esc(o.r.stretch)}</a> ${chip(o.d.call)}</li>`)
    .join('');

  const description =
    d.flow != null && n
      ? `${r.river} ${r.stretch} is running ${fmtFlow(d.flow)} cfs, ${pct}% of normal for ${day}. Live USGS flows, a 7-day chart and a fishable call, updated every few hours.`
      : `${r.river} ${r.stretch}: live USGS flows, a 7-day chart and a fishable call, updated every few hours.`;

  const body = `
<p class="crumb"><a href="${BASE}/">Montana rivers</a> / ${esc(r.region)}</p>
<h1>Is ${esc(theRiver(r.river))} fishable today?</h1>
<p class="sub">${esc(r.river)} ${esc(r.stretch)} · USGS gauge ${esc(r.site)}</p>

<section class="verdict ${d.call.status}">
  <p class="word">${esc(d.call.word)}</p>
  <p class="reason">${esc(d.call.reason)}</p>
  <p class="stamp">${d.flowTime ? `Reading from ${fmtStamp(d.flowTime)}` : ''}</p>
</section>

<dl class="stats">${stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>

<section>
  <h2>Last 7 days against normal</h2>
  ${chartSvg(d.week, d.stats, r.river)}
</section>

${guide}

<section>
  <h2>About this gauge</h2>
  ${about}
</section>

${nearby ? `<section><h2>Other rivers in ${esc(r.region)}</h2><ul class="nearby">${nearby}</ul></section>` : ''}

<p class="fine"><a href="${BASE}/how-it-works/">How we make the call</a></p>
`;
  return page({
    title: `${r.river} Flows Today, ${r.stretch} | Is It Fishable?`,
    description,
    canonical: url,
    body,
  });
}

// ---------- index ----------
function indexPage(all, buildTime) {
  const regions = [...new Set(rivers.map((r) => r.region))];
  const counts = { yes: 0, maybe: 0, no: 0, unknown: 0 };
  for (const o of all) counts[o.d.call.status]++;
  const groups = regions
    .map((reg) => {
      const rows = all
        .filter((o) => o.r.region === reg)
        .map((o) => {
          const n = o.d.normal;
          const pct = n && o.d.flow != null ? `${Math.round((o.d.flow / n[2]) * 100)}%` : '–';
          return `<tr>
  <td><a href="${BASE}/${o.r.slug}/">${esc(o.r.river)}</a><span class="stretch">${esc(o.r.stretch)}</span></td>
  <td>${chip(o.d.call)}</td>
  <td class="num">${o.d.flow == null ? '–' : fmtFlow(o.d.flow)}</td>
  <td class="num">${pct}</td>
</tr>`;
        })
        .join('');
      return `<section><h2>${esc(reg)}</h2>
<table class="rivers"><thead><tr><th>River</th><th>Call</th><th class="num">Flow (cfs)</th><th class="num">Vs normal</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    })
    .join('');

  const body = `
<h1>Montana river flows today</h1>
<p class="sub">${all.length} rivers checked against up to 20 years of flow history for today's date. Updated ${fmtStamp(buildTime)}.</p>
<p class="tally"><span class="chip yes">${counts.yes} fishable</span> <span class="chip maybe">${counts.maybe} use care</span> <span class="chip no">${counts.no} blown out</span> <span class="chip unknown">${counts.unknown} no reading</span></p>
${groups}
<p class="fine"><a href="${BASE}/how-it-works/">How we make the call</a></p>
`;
  return page({
    title: 'Montana River Flows Today | Is It Fishable?',
    description: `Live flows for ${all.length} Montana trout rivers, each compared with its normal for today's date. A fishable call for every river, updated every few hours.`,
    canonical: `${config.siteUrl}/`,
    body,
  });
}

function howPage() {
  const body = `
<h1>How we make the call</h1>
<p>Every river page compares the latest USGS flow reading with the same date in past years.</p>
<h2>Normal range</h2>
<p>For each gauge we take daily flows from water years 2006 to 2025 (October 2005 to September 2025), using every day within three days of today's date. The normal range is the middle half of those days: the 25th to 75th percentile. The median is the middle value. Gauges with a shorter record use what they have, and dates with fewer than five years of data get no call.</p>
<h2>The call</h2>
<table class="rivers how">
<thead><tr><th>Call</th><th>When</th></tr></thead>
<tbody>
<tr><td><span class="chip no">Blown out</span></td><td>Flow above the 90th percentile for the date and up more than 10% in 24 hours</td></tr>
<tr><td><span class="chip maybe">High water</span></td><td>Flow above the 90th percentile for the date</td></tr>
<tr><td><span class="chip maybe">Rising fast</span></td><td>Flow up more than 25% in 24 hours</td></tr>
<tr><td><span class="chip yes">Fishable, low water</span></td><td>Flow below the 10th percentile for the date</td></tr>
<tr><td><span class="chip maybe">Warm water</span></td><td>Water temperature at or above ${WARM_F}°F, where the gauge measures it</td></tr>
<tr><td><span class="chip yes">Fishable</span></td><td>Everything else with a current reading</td></tr>
<tr><td><span class="chip unknown">No live reading</span></td><td>No reading in the last ${STALE_HOURS} hours, often because the gauge is off for winter</td></tr>
</tbody></table>
<h2>What it does not know</h2>
<p>Flow is the biggest single factor in whether a river fishes, but it is not the only one. Clarity after a storm, hatches, wind and fishing closures are not in the call. Check Montana Fish, Wildlife and Parks for closures and a local fly shop for conditions.</p>
<h2>Data and updates</h2>
<p>Readings come from the USGS Water Data API and refresh every three hours. Recent USGS data is provisional and can be revised.</p>
<h2>How the site is paid for</h2>
<p>Some pages link to guided trips on FishingBooker. If you book through one of those links we may earn a commission, at no extra cost to you. The call on each river is made the same way whether or not a guide link appears.</p>
`;
  return page({
    title: 'How the Fishable Call Works | Is It Fishable?',
    description: 'How Is It Fishable? compares live USGS river flows with 20 years of history to make a fishable call for each Montana river.',
    canonical: `${config.siteUrl}/how-it-works/`,
    body,
  });
}

// ---------- main ----------
const buildTime = Date.now();
const latestFlow = await latestByParam('00060');
const latestTemp = await latestByParam('00010');
const weeks = await lastWeeks(rivers.map((r) => r.site));

const all = await mapLimit(rivers, 4, async (r) => {
  const stats = await loadStats(r.site);
  const lf = latestFlow[r.site];
  const week = weeks[r.site] || [];
  const flow = lf?.v ?? null;
  const flowTime = lf?.t ?? null;
  const lt = latestTemp[r.site];
  const tempF = lt && lt.v != null && buildTime - lt.t < STALE_HOURS * HOUR ? cToF(lt.v) : null;
  const normal = flowTime || buildTime ? stats?.normals?.[mmdd(flowTime ?? buildTime)] || null : null;
  const chg = change24(week);
  const call = makeCall({ flow, flowTime, normal, chg, tempF, buildTime });
  return { r, d: { stats, week, flow, flowTime, tempF, normal, chg, call, buildTime } };
});

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });
await fs.copyFile(path.join(root, 'src', 'style.css'), path.join(dist, 'style.css'));
await fs.writeFile(path.join(dist, 'index.html'), indexPage(all, buildTime));
await fs.mkdir(path.join(dist, 'how-it-works'), { recursive: true });
await fs.writeFile(path.join(dist, 'how-it-works', 'index.html'), howPage());
for (const o of all) {
  await fs.mkdir(path.join(dist, o.r.slug), { recursive: true });
  await fs.writeFile(path.join(dist, o.r.slug, 'index.html'), riverPage(o.r, o.d, all));
}

const lastmod = new Date(buildTime).toISOString();
const urls = ['/', '/how-it-works/', ...all.map((o) => `/${o.r.slug}/`)];
await fs.writeFile(
  path.join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `<url><loc>${config.siteUrl}${u}</loc><lastmod>${lastmod}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`,
);
await fs.writeFile(path.join(dist, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${config.siteUrl}/sitemap.xml\n`);
await fs.writeFile(path.join(dist, '.nojekyll'), '');
if (config.customDomain) await fs.writeFile(path.join(dist, 'CNAME'), `${config.customDomain}\n`);
if (config.indexNowKey) await fs.writeFile(path.join(dist, `${config.indexNowKey}.txt`), config.indexNowKey);

// Snapshot for reporting.
const snapshot = all.map((o) => ({
  slug: o.r.slug,
  site: o.r.site,
  flow: o.d.flow,
  flowTime: o.d.flowTime ? new Date(o.d.flowTime).toISOString() : null,
  normalMedian: o.d.normal?.[2] ?? null,
  change24h: o.d.chg,
  tempF: o.d.tempF,
  call: o.d.call.word,
  status: o.d.call.status,
}));
await fs.mkdir(path.join(dist, 'data'), { recursive: true });
await fs.writeFile(path.join(dist, 'data', 'latest.json'), JSON.stringify({ builtAt: lastmod, rivers: snapshot }, null, 1));

const tally = snapshot.reduce((a, s) => ((a[s.status] = (a[s.status] || 0) + 1), a), {});
console.log(`Built ${all.length} river pages at ${lastmod}:`, tally);
for (const s of snapshot) console.log(`${s.status.padEnd(7)} ${s.slug.padEnd(30)} ${String(s.flow).padStart(7)} cfs  median ${String(s.normalMedian).padStart(7)}  24h ${s.change24h == null ? '-' : (s.change24h * 100).toFixed(1) + '%'}  ${s.tempF ? s.tempF.toFixed(0) + 'F' : ''}  ${s.call}`);
