# Redline

A minimalist travel map inspired by the red routes in Indiana Jones: parchment, city stops, a moving red line, and photos that turn into postcards.

[Open Redline](https://marcusjmccarty.github.io/Redline/)

## Travel

The planner at the bottom of the map shows the trip name, Logbook, Album, and Save. Type a destination and press Enter to add it. Open the logbook to reorder or remove stops.

- **Trace route / Return / Space:** start or resume the trace. Hold Return or Space for 2× travel speed; the button pauses.
- **Click a city** (on the map or in the list): look at it within the whole trip, with every leg still drawn.
- **Arrow buttons or keys:** sail one leg, continuing from a port you clicked. Press again during travel to arrive instantly. Navigation loops through the overview in both directions.
- **Backspace (Delete on a Mac), Home, or the globe:** glide back to the whole-trip overview.
- **Full playback:** reveals each port on arrival, then smoothly returns to the complete world overview.
- **Scroll or + / −:** zoom with continuous easing. During travel, the chosen zoom persists across legs; the camera follows the tracer and adjusts its visible speed for close views.
- **H:** hide the controls. H, Escape, or a double-click on the map restores them.
- **Undo / Ctrl or Command + Z:** restore a cleared route, removed or added city, or changed stop order. Add Shift to redo. History lasts for the current trip in this tab; text fields keep their own Undo.
- **L / S / A:** open the logbook, save the trip, or open the album. Escape closes whichever is open.

The original rectangular world map fills the screen, including New Zealand and the reduced-height Antarctica. Geographic shapes are intentionally stretched to fit. Country names, cities, and regional boundaries appear as you zoom. Geometry and labels are bundled; there are no map-tile requests. Route port names are placed so they never overlap, and a port visited twice is named once. City labels are limited to 115 visible items to keep movement responsive.

## Trips, photos, and postcards

**Logbook** opens a lightly textured parchment sheet on the left, with a brief settling animation. The trip name sits above stops on ruled lines: drag a city to reorder it, use Alt + arrow keys when it has focus, click it to visit, or use × to remove it. Use **Switch trip** at the top to open another trip or use its ⋯ menu to rename, export, or delete it. The lower **Backed-up trips** list shows trips exported or imported since this version began tracking backups, with their last export or import dates. It records a backup action, not the current availability of the downloaded file; earlier downloads cannot be detected automatically. Deleting a trip also deletes its photos and postcards, so export it first if you might want it later. With more than six saved trips, a search field finds one by name. Escape, the close button, or working elsewhere on the map closes the logbook.

No ChatGPT account, subscription, server, or sign-in is required. Trips, photos, and postcard notes are saved privately in this browser using IndexedDB. They are not uploaded to GitHub or synced automatically between devices. Use **Logbook → Back up all** regularly and **Logbook → Import backup** to restore a backup on another device. **Export trip** (or ⋯ → Export) saves just one trip. Imports add copies and never overwrite existing trips.

Browser storage is not a permanent backup: clearing site data, private browsing, browser removal, or device loss can erase it. The app requests persistent storage where available, but that does not replace a downloaded backup. Backups contain your private photos and notes; do not commit them to this repository.

To move from the original website: sign in there, open **Trips → Back up all**, then use **Logbook → Import backup** on this website. Existing hosted records remain on the original website until you export them; they are not transferred automatically.

**Album** opens a leather-bound book over the dimmed map. Every visit opens its cover to the remembered page; clicking outside, pressing Escape, or using Close dismisses it in one short animation. An open spread folds shut; All Photos keeps the current prints visible as the book leaves, avoiding a flash of unrelated pages. The book stays centered, with divider tabs to its right. The first visit opens to an endpaper and title page with the route, followed by contents and city chapters in route order. Photos are mounted as prints in photo corners, with any postcard message beneath them. Turn pages with the arrow buttons, keyboard arrows, page corners, a swipe, or the slider; Home and End close the book on either cover. Contents and the coloured tabs attached to the book's edge jump to a city. The pin beside a city's name closes the album and finds that city on the map. **All photos** shows small, spaced photographic prints grouped by city. **Select** there moves photos to another city or deletes them; Shift-click selects everything between two photos. Reduced-motion preferences skip the book animations.

Use **Add photos** or drag image files anywhere onto the page. In import review, every new photo starts selected: pick a city for the selection at once, or choose one under each photo. Photos are matched to a nearby trip stop or indexed city using GPS metadata, when available, and marked with a GPS label. Unassigned or failed photos stay in review for correction or retry. Cancelling an import does not change saved photos.

Photos are re-encoded in the browser and their metadata is stripped again before local storage; original filenames and precise photo GPS are not retained. Each photo also stores a small preview and its pixel size; photos saved by earlier versions get theirs the first time the album shows them. Previews are rebuilt rather than included in backups.

Click a photo to expand it; it grows out of its print and shrinks back when closed. Browse that city's photos (in import review, the photos being imported) with the arrows at the photo's edges, keyboard left/right, or a swipe. The arrows fade after 1.8 seconds of pointer inactivity and return with movement; keyboard-focused arrows and touch controls stay visible. When browsing, postcard edits are saved first, and a failed save keeps the current photo and draft open. The photo toolbar has Postcard and a bin (or use Delete) to remove the photo. Move photos between cities from All photos → Select. Click outside or press Escape to close the viewer. Choose **Postcard**, press F, or click the photo to turn the entire viewer over. Write on the postcard back; edits save automatically, and **Save** commits them immediately. The back groups **← Photo**, **Print**, **Share**, and **Save** together on the right. **← Photo**, F, or a click on the paper turns it back. Editing fields and pressing buttons do not flip the card.

**Print** or Ctrl/Command + P prints two 6 × 4 inch pages. **Share** prepares one JPEG containing the photograph and written back, then opens the device's available share menu. If file sharing is unavailable, it downloads the image. The share file contains pixels, not a private photo URL.

Limits include 100 stops and 300 photos per trip, 200 trips in this browser, 30 images per import, and 4 MB per processed image. Browser support for HEIC/HEIF varies.

## Development

Use Node.js 24 or a compatible version satisfying `package.json`.

```sh
npm ci
npm test
npm run dev
```

`npm run build` creates a complete static website in `dist/`; `npm start` builds and serves it locally. The build itself uses only Node built-ins. Development dependencies fake-indexeddb and jsdom exercise storage transactions and gallery interactions, including failed saves and backup recovery. Browser image decoding and native print/share dialogs are mocked in those tests. `node scripts/validate-world.mjs` validates the bundled geography. Tests do not require old Git history, live accounts, or production data.

The built website is on the `gh-pages` branch, which GitHub Pages publishes automatically. Run `npm run publish:site` after committing a source change; it tests, builds, and updates that branch. Optional GitHub Actions templates are in `docs/workflows/`; they are inactive because the current publication token cannot write workflow files.

## Structure

- `map.html`, `public/app.js`, `public/style.css`: interface and interaction.
- `public/labels.js`: placement of route city names so they never overlap.
- `public/map-layout.js`, `public/world.js`: projection and geography.
- `scripts/build-atlas.mjs`, `scripts/atlas-geometry.mjs`: dissolve shared national edges at build time while preserving coastlines, lakes, and islands. The generated `public/atlas-geography.js` supplies continuous landmass fills, separate boundary groups, and the original label data; `public/map-paint.js` skips offscreen geometry.
- `scripts/atlas-paper.mjs`, `scripts/build-paper.mjs`: bake one faint transparent PNG wash before publication. The map uses plain vector land fills and a single raster image; it does not repeat image-backed SVG patterns or load nested SVG image documents. `public/album-motion.js` turns the Album / All Photos faces independently to avoid nested double-sided 3D layers.
- `public/trace.js`: route geometry, timing, camera framing, and damped zoom.
- `public/trips.js`: the logbook, the photo album and its page turns, All photos and selection, and import review.
- `public/gallery.css`: the album, All photos, import review, and the photo viewer and postcard. `public/style.css` holds the map, the trip planner, the logbook, and printing.
- `public/postcards.js`, `public/postcard-export.js`: editing, print, and share.
- `public/storage.js`: private IndexedDB library with atomic saves and revision checks.
- `public/archive.js`: portable binary backups containing routes, postcards, and JPEG blobs.
- `public/jpeg.js`, `server/jpeg.mjs`: metadata removal (browser and source module).
- `scripts/build-static.mjs`: host-independent static build.

The current app is entirely static. [Hosting notes](docs/HOSTING.md) cover GitHub Pages and alternative static hosts. The previous server-backed implementation remains in the original Site repository; this build does not contain or call it. The repository contains source and synthetic test fixtures, not personal trips, photos, tokens, or local database files.

## Data and libraries

- [Natural Earth](https://www.naturalearthdata.com/): world outlines, labels, and administrative boundaries; public domain.
- [GeoNames](https://www.geonames.org/): bundled city data; CC BY 4.0.
- [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api): live destination search, based on GeoNames.
- D3 Geo and D3 Array: ISC license. Exifr: MIT license. Included notices are in `public/vendor/`.

Routes illustrate great-circle travel, not road directions. The GPS JPEG in `test/fixtures/` is a generated test image.
