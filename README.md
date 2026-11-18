# Is It Fishable?

Live flow pages for Montana trout rivers. Each page compares the latest USGS reading with the same date over the past 20 water years and makes a fishable call.

## How it runs

- `rivers.json` lists the live rivers: page slug, USGS gauge number, region, and the FishingBooker town page for the guide link (`null` when FishingBooker has no guides nearby).
- `queue.json` lists rivers waiting to go live. Every night at 2:07am Montana time the workflow moves the next one into `rivers.json`, builds its history, commits, and publishes. It skips a gauge if it has fewer than 5 years of history.
- `scripts/build-stats.mjs` pulls daily flow history and saves "normal for this date" percentiles to `data/stats/`. Rerun it once a year: `node scripts/build-stats.mjs`.
- `scripts/build.mjs` pulls the latest readings and writes the site to `dist/`. Four USGS calls per build.
- `.github/workflows/refresh.yml` rebuilds and deploys to GitHub Pages every 3 hours, and adds a river nightly.

## Settings

- `site.config.json`: `siteUrl` (include any sub-folder), `customDomain` (writes the CNAME file), `fishingbookerAffiliateParam` (appended to every FishingBooker link once the affiliate account is approved).
- Repo secret `USGS_API_KEY` (optional): free key from https://api.waterdata.usgs.gov/signup/. Without it USGS allows 1,000 calls an hour per IP address.

## Adding a river by hand

1. Find the gauge on https://waterdata.usgs.gov and add a row to `queue.json` (front of the list to go next) or straight to `rivers.json`.
2. `node scripts/build-stats.mjs <site number>`
3. `node scripts/build.mjs`, check the page, commit.

## Gotchas

- GitHub turns off scheduled workflows in public repos after 60 days with no commits. The nightly river keeps it active until the queue runs out.
- Some gauges switch off for winter (USGS marks them seasonal). Their pages show "No live reading" until spring.
- USGS recent data is provisional and can be revised.
