// Nightly job: move the next river from queue.json into rivers.json.
// Builds its flow history first and skips gauges without enough years to make a call
// (up to 3 tries a night). Run:  node scripts/add-next-river.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = async (f) => JSON.parse(await fs.readFile(path.join(root, f), 'utf8'));
const write = (f, v) => fs.writeFile(path.join(root, f), JSON.stringify(v, null, 2) + '\n');

const rivers = await read('rivers.json');
const queue = await read('queue.json');
const have = new Set(rivers.map((r) => r.site));
const MIN_YEARS = 5;
const MIN_DATED_NORMALS = 200; // seasonal gauges still qualify if most of the year is covered

let added = null;
for (let tries = 0; tries < 3 && queue.length && !added; tries++) {
  const next = queue.shift();
  if (have.has(next.site)) continue;
  try {
    execFileSync('node', [path.join(root, 'scripts', 'build-stats.mjs'), next.site], { stdio: 'inherit' });
    const stats = await read(path.join('data', 'stats', `${next.site}.json`));
    const dated = Object.keys(stats.normals).length;
    if (stats.yearsWithData >= MIN_YEARS && dated >= MIN_DATED_NORMALS) {
      rivers.push(next);
      added = next;
    } else {
      console.log(`Skipped ${next.slug}: ${stats.yearsWithData} years, ${dated} dated normals`);
      await fs.rm(path.join(root, 'data', 'stats', `${next.site}.json`), { force: true });
    }
  } catch (err) {
    // Network trouble: put it back at the front and stop for tonight.
    console.warn(`Could not build ${next.slug}: ${err.message}`);
    queue.unshift(next);
    break;
  }
}

await write('rivers.json', rivers);
await write('queue.json', queue);
console.log(added ? `Added ${added.river} ${added.stretch} (${added.site}). ${queue.length} left in queue.` : `Nothing added. ${queue.length} left in queue.`);
if (process.env.GITHUB_OUTPUT && added) {
  await fs.appendFile(process.env.GITHUB_OUTPUT, `added=${added.river} ${added.stretch}\n`);
}
