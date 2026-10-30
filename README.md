# Redline

A minimalist travel map inspired by the red routes in Indiana Jones: parchment, city stops, a moving red line, and photos that turn into postcards.

[Open Redline](https://marcusjmccarty.github.io/Redline/)

## Travel

Type a city and press Enter. Click a route city to jump to that point in the journey, or drag its name to reorder the stops. The chevron collapses the city list.

- **Trace route / Space / Enter:** start or resume. Hold Space or Enter for 2× travel speed; the Trace button pauses.
- **Arrow buttons or keys:** travel one leg. Press again during travel to arrive instantly. Navigation loops through the hidden world-overview step in both directions.
- **Full playback:** reveals each destination on arrival, then smoothly returns to the complete world overview.
- **Scroll or + / −:** zoom with continuous easing. During travel, the chosen zoom persists across legs; the camera follows the tracer and adjusts its visible speed for close views.
- **Home / globe:** return to the overview.
- **H:** hide the controls. H, Escape, or a double-click on the map restores them.
- **T / S / P:** toggle Trips, save the trip, or toggle Photos. Escape closes whichever menu or panel is open.

The original rectangular world map fills the screen, including New Zealand and the reduced-height Antarctica. Geographic shapes are intentionally stretched to fit. Country names, cities, and regional boundaries appear as you zoom. Geometry and labels are bundled; there are no map-tile requests. City labels are limited to 115 visible items to keep movement responsive.

## Trips, photos, and postcards

**Trips** opens a menu above the route controls. Name and save the current route, open another saved trip, or use the pencil and bin beside a trip to rename or delete it. Deleting a trip also deletes its photos and postcards, so export it first if you might want it later. The menu closes when you click elsewhere or press Escape.

No ChatGPT account, subscription, server, or sign-in is required. Trips, photos, and postcard notes are saved privately in this browser using IndexedDB. They are not uploaded to GitHub or synced automatically between devices. Use **Trips → Back up all** regularly and **Import** to restore a backup on another device. Export trip saves just the selected trip. Imports add copies and never overwrite existing trips.

Browser storage is not a permanent backup: clearing site data, private browsing, browser removal, or device loss can erase it. The app requests persistent storage where available, but that does not replace a downloaded backup. Backups contain your private photos and notes; do not commit them to this repository.

To move from the original website: sign in there, open **Trips → Back up all**, then use **Trips → Import** on this website. Existing hosted records remain on the original website until you export them; they are not transferred automatically.

The photo gallery is a paper album that slides in beside the map. On wide screens the route controls move aside so both stay usable; on narrower screens they step out of the way until the album closes. Photos are grouped by city in route order, keep their own proportions, and load from small stored previews. City chips filter the album, the pin beside a city finds it on the map, and the camera badge beside a city on the map opens its photos. **Select** lets you move several photos to another city or delete them in one step.

Use **Add photos** or drag image files anywhere onto the page. In import review, every new photo starts selected: pick a city for the selection at once, or choose one under each photo. Photos are matched to a nearby trip stop or indexed city using GPS metadata, when available, and marked with a GPS label. Unassigned or failed photos stay in review for correction or retry. Cancelling an import does not change saved photos.

Photos are re-encoded in the browser and their metadata is stripped again before local storage; original filenames and precise photo GPS are not retained. Each photo also stores a small preview and its pixel size; photos saved by earlier versions get theirs the first time the album shows them. Previews are rebuilt rather than included in backups. Import previews and saved photos can be browsed using the viewer arrows, keyboard left/right, or a touch swipe. Browsing follows the current city filter. Postcard edits are saved before navigation; a failed save keeps the current photo and draft open.

Click a photo to expand it. Browse with the arrows, the edges of the photo, keyboard left/right, or a swipe. Change the city under the photo to move it there, or use the bin (or Delete) to remove it. Choose **Postcard**, press F, or click the photo to turn the entire viewer over. Write on the postcard back; edits save automatically. **← Photo**, F, or a click on the paper turns it back. Editing fields and pressing buttons do not flip the card.

**Print** or Ctrl/Command + P prints two 6 × 4 inch pages. **Share** prepares one JPEG containing the photograph and written back, then opens the device's available share menu. If file sharing is unavailable, it downloads the image. The share file contains pixels, not a private photo URL.

Limits include 100 stops and 300 photos per trip, 200 trips per account, 30 images per import, and 4 MB per processed image. Browser support for HEIC/HEIF varies.

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
- `public/map-layout.js`, `public/world.js`: projection and geography.
- `public/trace.js`: route geometry, timing, camera framing, and damped zoom.
- `public/trips.js`, `public/gallery.css`: the Trips menu, photo album, selection, import review, and viewer styling.
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
