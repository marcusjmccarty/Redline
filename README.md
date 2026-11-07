# Redline

A minimalist travel map inspired by the red routes in Indiana Jones: parchment, city stops, a moving red line, and photos that turn into postcards.

[Open Redline](https://marcusjmccarty.github.io/Redline/)

## Travel

The planner at the bottom of the map shows the trip name, Logbook, Album, and Save. Type a destination and press Enter to add it. Open the logbook to reorder or remove stops.

- **Trace route / Space:** pause or resume the original flowing trace. Return starts or resumes. Ink and camera zoom share one smooth clock, with continuous arrivals between legs. Hold Return or Space for 2× speed; release to return to normal speed. The final leg eases back to the world overview.
- **Click a city** (on the map or in the list): look at it within the whole trip, with every leg still drawn.
- **Arrow buttons or keys:** trace one leg, continuing from a port you clicked. Press again during travel to arrive instantly. Navigation loops through the overview in both directions.
- **Backspace (Delete on a Mac), Home, or the globe:** glide back to the whole-trip overview.
- **Full playback:** reveals each port on arrival, then smoothly returns to the complete world overview. With reduced motion it lands on the last port with the route drawn.
- **Scroll, pinch, or + / −:** zoom with continuous easing, up to 240×. A touch or trackpad pinch zooms around your fingers. Double-click zooms in on that point, and Shift + double-click zooms out. The chosen zoom persists across legs, including one chosen while paused or at rest before a trace; the camera follows the tracer and adjusts its visible speed for close views.
- **Drag:** pan when zoomed in. A flick coasts briefly to a stop.
- **H:** hide the controls. H, Escape, or a double-click on the map restores them.
- **Undo / Ctrl or Command + Z:** restore a cleared route, removed or added city, or changed stop order. Add Shift to redo. History lasts for the current trip in this tab; text fields keep their own Undo.
- **L / S / A:** open the logbook, save the trip, or open the album. Escape closes whichever is open.

The rectangular world map fills the screen, including New Zealand and the reduced-height Antarctica. Geographic shapes are intentionally stretched to fit. The map is painted, and runs to the window's edge with no frame. A baked picture of the whole sheet appears at once; workers ink detail tiles onto canvases only when you zoom in with a watercolour sea, land washes modelled by real hillshade, snow on the high ranges and the polar ice, rivers, lakes, dotted borders, forests, peaks, and ornaments, and the page only moves those bitmaps. Finer coasts, regional boundaries, and terrain appear as you zoom, without existing peaks and trees shifting. See [the atlas notes](docs/ATLAS.md).

Names are lettered onto a clear canvas above the painted tiles, and country and city names appear as you come closer. Continents retain Redline Hand, a typeface drawn for this map, and oceans use IM Fell English. Smaller names use clear Georgia lettering; cities stay at least 13 CSS pixels tall and capitals 14, including on narrow screens. Ocean labels stay within defined areas of water, and South America uses two horizontal lines. Everything the map needs is on this site, and there are no third-party map-tile requests: the finer geography, the full land plate, and close-up relief load from it as you zoom. Route port names are placed so they never overlap, and a port visited twice is named once. Atlas names are limited to 130 visible items to keep movement responsive.

## Trips, photos, and postcards

**Logbook** opens a lightly textured parchment sheet on the left, with a brief settling animation. The trip name sits above stops on ruled lines: drag a city to reorder it (on a touch screen, drag its number, so a swipe still scrolls the list), use Alt + arrow keys when it has focus, click it to visit, or use × to remove it. Use **Switch trip** at the top to open another trip or use its ⋯ menu to rename, export, or delete it. The lower **Backed-up trips** list shows trips exported or imported since this version began tracking backups, with their last export or import dates. It records a backup action, not the current availability of the downloaded file; earlier downloads cannot be detected automatically. A row says “changed since” once the trip, its photos, or their notes have changed after that date. Deleting a trip also deletes its photos and postcards, so export it first if you might want it later. With more than six saved trips, a search field finds one by name. Escape, the close button, or working elsewhere on the map closes the logbook.

No ChatGPT account, subscription, server, or sign-in is required. Trips, photos, and postcard notes are saved privately in this browser using IndexedDB. They are not uploaded to GitHub or synced automatically between devices. Opening or switching a map reads only the saved route and an indexed photo count; image records and notes load when the album opens. Text you type into the destination box (two or more letters) is sent to Open-Meteo to find places, even when the place is also bundled. Use **Logbook → Back up all** regularly and **Logbook → Import backup** to restore a backup on another device. **Export trip** (or ⋯ → Export) saves just one trip. Imports add copies and never overwrite existing trips.

Browser storage is not a permanent backup: clearing site data, private browsing, browser removal, or device loss can erase it. The app requests persistent storage where available, but that does not replace a downloaded backup. Backups contain your private photos and notes; do not commit them to this repository.

To move from the original website: sign in there, open **Trips → Back up all**, then use **Logbook → Import backup** on this website. Existing hosted records remain on the original website until you export them; they are not transferred automatically.

**Album** opens a leather-bound book over the dimmed map. Every visit opens its cover to the remembered page; clicking outside, pressing Escape, or using Close dismisses it in one short animation. An open spread folds shut; All Photos keeps the current prints visible as the book leaves, avoiding a flash of unrelated pages. A two-page book stays centered; a one-page book sits to the left of its tabs. The first visit opens to an endpaper and title page with the route, followed by contents and city chapters in route order. Photos are mounted as prints in photo corners, with any caption beneath them. Turn pages with the arrow buttons, keyboard arrows, page corners, a swipe, or the slider; Home and End close the book on either cover. The pin beside a city's name closes the album and finds that city on the map. **All photos** shows small, spaced photographic prints grouped by city. **Select** there moves photos to another city or deletes them; Shift-click selects everything between two photos. Reduced-motion preferences skip the book animations.

Contents and the city tabs jump to a city. The tabs are layered cloth dividers on the book's right edge, with names lettered clockwise down the edge. They step out from behind one another in staggered columns and are as tall as the longest name needs. A long list gets more columns, normally up to six beside a two-page book and three beside one page, and then shorter tabs. Past that the rail scrolls, fading at an end with more tabs past it. From the keyboard, the rail is one Tab stop and the up and down arrows move between tabs.

**F** or the button beside Close fills the window with the album. In this window view the window's top edge brings up the toolbar and its right edge the city tabs and an exit button; on a touch screen small handles mark both edges. Press F or use the exit button to return to the regular view.

Use **Add photos** or drag image files anywhere onto the page. In import review, every new photo starts selected: pick a city for the selection at once, or choose one under each photo. The tick only chooses photos for that bulk city; every photo with a city is saved. Photos are matched to a nearby trip stop or indexed city using GPS metadata, when available, and marked with a GPS label. Photos taken around one city share one new stop. Unassigned photos and photos that fail to save stay in review for correction or retry; files that cannot be read are named in a message and not added. Cancelling an import does not change saved photos.

Photos are re-encoded in the browser and their metadata is stripped again before local storage; original filenames and precise photo GPS are not retained. Each photo also stores a small preview and its pixel size; photos saved by earlier versions get theirs the first time the album shows them. Previews are rebuilt rather than included in backups.

Click a photo to expand it; it grows out of its print and shrinks back when closed. Browse that city's photos (in import review, the photos being imported) with the arrows at the photo's edges, keyboard left/right, or a swipe. The arrows fade after 0.7 seconds of pointer inactivity and return with movement; keyboard-focused arrows and touch controls stay visible. When browsing, postcard edits are saved first, and a failed save keeps the current photo and draft open. The photo toolbar has Caption, for the line shown beneath the print and saved separately from the postcard; Postcard; and a bin (or use Delete) to remove the photo. Move photos between cities from All photos → Select. Click outside or press Escape to close the viewer. Choose **Postcard**, press F, or click the photo to turn the entire viewer over. Write on the postcard back; edits save automatically, and **Save** commits them immediately. The back groups **← Photo**, **Print**, **Share**, and **Save** together on the right. **← Photo**, F, or a click on the paper turns it back. Editing fields and pressing buttons do not flip the card.

**Print** or Ctrl/Command + P prints two 6 × 4 inch pages. **Share** prepares one JPEG containing the photograph and written back, then opens the device's available share menu. If file sharing is unavailable, it downloads the image. The share file contains pixels, not a private photo URL.

Select or drop as many photos as you like in one import. Large selections appear on review pages. Select all, city assignment, and Save work across those pages. Trips have no photo-count limit. Capacity depends on available browser storage. Each processed image can be up to 4 MB. The existing limits of 100 stops per trip, 200 trips per browser, and 2 GB per backup file still apply. A backup over 2 GB comes as several files, offered one per click, and is not recorded as done until the last. Import each file: a trip split across files comes back as separate trips, the later ones named “(part 2)” and so on, each with the full route. Browser support for HEIC/HEIF varies.

## Development

Use Node.js 24 or a compatible version satisfying `package.json`.

```sh
npm ci
npm test
npm run dev
```

`npm run build` creates a complete static website in `dist/`; `npm start` builds and serves it locally. The build regenerates `public/atlas-geography.js`, copies everything else under `public/` except its source, `public/world.js`, and uses only Node built-ins. Development dependencies fake-indexeddb and jsdom exercise storage transactions and gallery interactions, including failed saves and backup recovery. Browser image decoding and native print/share dialogs are mocked in those tests. `node scripts/validate-world.mjs` validates the bundled geography. Tests do not require old Git history, live accounts, or production data.

The built website is on the `gh-pages` branch, which GitHub Pages publishes automatically. Run `npm run publish:site` after committing a source change; it tests, builds, and updates that branch. Optional GitHub Actions templates are in `docs/workflows/`; they are inactive because the current publication token cannot write workflow files.

## Structure

- `map.html`, `public/app.js`, `public/style.css`: interface and interaction.
- `public/map-intro.js`: the opening fold, once per page load.
- `public/labels.js`: the one occupancy grid every name on the map is placed into, and the placement of route city names in it.
- `public/map-layout.js`: projection and route curves.
- `public/world.js`: source geography for the build. No page loads it, and it is not published.
- `scripts/build-atlas.mjs`, `scripts/atlas-geometry.mjs`: dissolve shared national edges at build time while preserving coastlines, lakes, and islands. The generated `public/atlas-geography.js` supplies the route thumbnails' simple land shapes and the country and city label data.
- `public/atlas-painter.js`, `public/atlas-worker.js`, `public/atlas-view.js`: the painted map, inked tile by tile in a small crew of workers from baked local assets. `scripts/build-atlas-art.mjs`, `scripts/build-atlas-sheet.mjs`, and `scripts/build-lettering.mjs` rebuild those assets; see `docs/ATLAS.md`.
- `public/atlas-names.js`: the mountain ranges, deserts, plains, and seas to letter.
- `public/album-motion.js`: the book's motion: the cover opening and closing, turning leaves, and the change between Album and All Photos, which carries both views on one leaf with a face on either side.
- `public/trace.js`: route geometry, timing, camera framing, and damped zoom.
- `public/trips.js`: the logbook, the photo album and its page turns, All photos and selection, and import review.
- `public/gallery.css`: the album, All photos, import review, and the photo viewer and postcard. `public/style.css` holds the map, the trip planner, the logbook, and printing.
- `public/postcards.js`, `public/postcard-export.js`: editing, print, and share.
- `public/storage.js`: private IndexedDB library with atomic saves and revision checks.
- `public/archive.js`: portable binary backups containing routes, postcards, and JPEG blobs.
- `public/jpeg.js`: metadata removal.
- `scripts/build-static.mjs`: host-independent static build.
- `scripts/check-names.mjs`: authoring tool, not part of `npm test`. Finds names that collide, clip, go missing or flicker, from the built page in one headless Chrome.
- `scripts/build-photo-cities.mjs`: authoring step, not part of the build. Writes `public/photo-cities.json`, which names a photo's city from its GPS position, without the sections of cities that GeoNames also lists.

The current app is entirely static. [Hosting notes](docs/HOSTING.md) cover GitHub Pages and alternative static hosts. The previous server-backed implementation remains in the original Site repository; this build does not contain or call it. The repository contains source and synthetic test fixtures, not personal trips, photos, tokens, or local database files.

## Data and libraries

- Redline Hand (`public/fonts/redline-hand.woff`, `public/fonts/redline-hand-bold.woff`) is drawn for this project by `scripts/build-lettering.mjs`.
- [IM Fell English](https://iginomarini.com/fell/), Igino Marini's revival of the Fell types, is hosted locally for the chart's small text and the album's cover title. It is licensed under the SIL Open Font License; see `public/fonts/OFL.txt`.
- The locally hosted album script is a medium-weight instance of [Dancing Script](https://github.com/google/fonts/tree/main/ofl/dancingscript), renamed Redline Album Script. Its SIL Open Font License is `public/fonts/DancingScript-OFL.txt`.
- [Natural Earth](https://www.naturalearthdata.com/) rasters, public domain: the 1:50m shaded relief and hypsometric plates give the land washes and terrain in `public/atlas/`, and the [shaded relief plate](https://www.naturalearthdata.com/downloads/10m-raster-data/10m-shaded-relief/) gives the close-up WebP tiles in `public/relief/`, which load only for close-ups.
- [Natural Earth](https://www.naturalearthdata.com/) vectors, public domain: world outlines, rivers, lakes, labels, and administrative boundaries.
- [GeoNames](https://www.geonames.org/): bundled city data; CC BY 4.0.
- [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api): live destination search, based on GeoNames.
- D3 Geo and D3 Array: ISC license. Exifr: MIT license. Included notices are in `public/vendor/`.

Routes illustrate great-circle travel, not road directions. The GPS JPEG in `test/fixtures/` is a generated test image.
