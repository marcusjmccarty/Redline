# Hosting Redline independently

Live website: https://marcusjmccarty.github.io/Redline/

Source: https://github.com/marcusjmccarty/Redline

## GitHub Pages

The public repository uses GitHub Pages, available on GitHub Free. No ChatGPT subscription or login is involved. Pages publishes the root of the `gh-pages` branch using its built-in pipeline. Only generated public assets are on that branch.

To publish, commit and push source changes to `main`, then run `npm run publish:site`. The command refuses local changes, a `HEAD` that differs from `origin/main`, and ignored files under `public/`, so the live site is always exactly `origin/main`. It then runs tests and builds, and pushes the generated assets using a disposable checkout; it never force-pushes or changes the source branch. If `gh-pages` already matches the build, it says so and pushes nothing.

For a fork, enable **Settings → Pages → Source: Deploy from a branch**, choose **gh-pages**, and select **/(root)**. The command only publishes to `marcusjmccarty/Redline`, so either change `repository` and `account` in `scripts/publish-target.mjs` to your own first, or upload `dist/` as described under [Other hosts](#other-hosts).

The prior publication token could not write custom workflows. Inactive examples live in `docs/workflows/` for a future migration to Actions publishing. The branch-based publication setup uses no custom workflow or stored deployment secret. The publishing script verifies the repository owner and authenticated account and refuses publication outside `marcusjmccarty/Redline`.

## Data

Only application assets are hosted. Trips, sanitized JPEGs, and postcard notes live in each browser’s IndexedDB database. They are not in the repository, and visitors cannot read someone else’s library through the website. Anyone using the same browser profile can access its saved trips.

Use **Back up all** before clearing browser data and regularly thereafter. **Export trip** makes a smaller backup. **Import** adds copies atomically and validates each photo, removing every JPEG segment a decoder does not need; it does not overwrite current saves. This is segment-level removal, and photos taken through the app are also redrawn before they are stored. Backups are private files, not encrypted vaults. A photo is limited to 4 MB and each backup file to 2 GB. A larger backup comes as several files, offered one per click: keep them all and import each one. A trip split across files comes back as separate trips, the later ones named “(part 2)” and so on, each with the full route. Automatic cross-device sync is not included.

The former ChatGPT-hosted website has export buttons for migration. Sign in there, export, and import here. Data is never copied into a public repository or moved automatically across origins.

## Other hosts

Run `npm run build` and upload the contents of `dist/` to any HTTPS static host. Everything in `public/` is published except the build's source geography, `public/world.js`, so the build stops if it finds a backup or a stray photo there. For Cloudflare Pages, use build command `npm run build`, output directory `dist`, and Node 24. This version needs no Worker, D1, R2, authentication service, or paid plan. Changing the site origin creates a separate browser library; export before moving and import afterward.

To add automatic cloud syncing later, provide an independently owned authentication and storage service. Do not reuse the former server API’s trusted ChatGPT identity header on a public server.

## Local use

`npm ci`, `npm test`, then `npm run dev`. Open the printed local URL. Development and published origins have separate libraries. The app does not install a service worker or promise offline startup; once loaded, tracing and saved-library operations do not require network access. The finer map detail loads on demand as you zoom, so a trace that closes in while offline still runs, with the coarser coasts and without close-up relief it has not already fetched. Live destination search uses Open-Meteo: text typed into the destination box is sent to it.

See [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) and [usage limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
