// Tells IndexNow search engines (Bing, Yandex, Seznam, Naver) about the newest river page
// and the home page. The key is public by design: it is served as a file on the site.
// Run after a deploy:  node scripts/indexnow.mjs [all]

import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const config = JSON.parse(await fs.readFile(path.join(root, 'site.config.json'), 'utf8'));
const rivers = JSON.parse(await fs.readFile(path.join(root, 'rivers.json'), 'utf8'));
if (!config.indexNowKey) {
  console.log('No indexNowKey in site.config.json; skipping.');
  process.exit(0);
}

const site = config.siteUrl.replace(/\/$/, '');
const pages = process.argv[2] === 'all' ? rivers : rivers.slice(-1);
const urlList = [`${site}/`, ...pages.map((r) => `${site}/${r.slug}/`)];

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    host: new URL(site).host,
    key: config.indexNowKey,
    keyLocation: `${site}/${config.indexNowKey}.txt`,
    urlList,
  }),
});
console.log(`IndexNow ${res.status} for ${urlList.length} URLs: ${urlList.join(' ')}`);
if (res.status >= 400 && res.status !== 429) process.exit(1);
