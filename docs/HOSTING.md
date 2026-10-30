# Hosting Redline independently

Live website: https://mmccarty-byte.github.io/Redline/

Source: https://github.com/mmccarty-byte/Redline

## GitHub Pages

The public repository uses GitHub Pages, available on GitHub Free. No ChatGPT subscription or login is involved. Pages publishes the root of the `gh-pages` branch using its built-in pipeline. Only generated public assets are on that branch.

For a fork, enable **Settings → Pages → Source: Deploy from a branch**, choose **gh-pages**, and select **/(root)**. Publish the first build with `npm run publish:site`. The command runs tests and builds, then pushes the generated assets using a disposable checkout; it never force-pushes or changes the source branch. Commit and push source changes to `main` before publishing.

The available GitHub token cannot write custom workflows. Inactive examples live in `docs/workflows/` for a future migration to Actions publishing. Current publication uses no custom workflow or stored deployment secret.

## Data

Only application assets are hosted. Trips, sanitized JPEGs, and postcard notes live in each browser’s IndexedDB database. They are not in the repository, and visitors cannot read someone else’s library through the website. Anyone using the same browser profile can access its saved trips.

Use **Back up all** before clearing browser data and regularly thereafter. **Export trip** makes a smaller backup. **Import** adds copies atomically and validates and sanitizes photo content; it does not overwrite current saves. Backups are private files, not encrypted vaults. Each archive is limited to 2 GB; a photo to 4 MB. Automatic cross-device sync is not included.

The former ChatGPT-hosted website has export buttons for migration. Sign in there, export, and import here. Data is never copied into a public repository or moved automatically across origins.

## Other hosts

Run `npm run build` and upload the contents of `dist/` to any HTTPS static host. For Cloudflare Pages, use build command `npm run build`, output directory `dist`, and Node 24. This version needs no Worker, D1, R2, authentication service, or paid plan. Changing the site origin creates a separate browser library; export before moving and import afterward.

To add automatic cloud syncing later, provide an independently owned authentication and storage service. Do not reuse the former server API’s trusted ChatGPT identity header on a public server.

## Local use

`npm ci`, `npm test`, then `npm run dev`. Open the printed local URL. Development and published origins have separate libraries. The app does not install a service worker or promise offline startup; once loaded, tracing and saved-library operations do not require network access. Live destination search uses Open-Meteo.

See [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) and [usage limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
