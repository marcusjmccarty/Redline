# The atlas

The map is painted, not drawn by the browser's SVG engine. Workers ink tiles; the page hands each to the browser's compositor as a layer of its own and moves whole levels of them with one style write, which is why zooming and tracing stay fast however rich the map is.

## At runtime

- `public/atlas/sheet-small.webp` is preloaded in HTML and shown as a native image before the app or any worker starts. The larger `sheet.webp` replaces it at low priority without repainting the artwork. `atlas.ready` means the sheet is up, and the opening fold in `public/map-intro.js` unfolds it. Only if it cannot be fetched does the map paint a whole sheet at run time.
- `public/atlas-painter.js` draws one tile: watercolour sea, rhumb lines, ink waterlines, land with its pigment, hillshade, snow and stipple, rivers, lakes, dotted borders, forests and peaks, all cut crisply at the coast in one go, then the coast's ink and the ornaments. It has no DOM dependencies and runs in the worker.
- `public/atlas-worker.js` loads the assets and paints tiles on request. The first paint uses `geo0.bin` and the small land plate; `geo1.bin` and the full plate follow and sharpen the map in place.
- `public/atlas-view.js` puts the sheet and tiles in layers behind the `#map` canvas, with nothing around them, so the map runs to the window's edge. `#map` itself is clear: it holds only the lettered names and title plate, and stays the target for the pointer and wheel. Lettering is rendered once into sprites. It starts a crew only on zoom or a requested region, at most two painters and never more than the cores allow, because each decodes the land plate for itself. Each tile goes to a free worker, regions for the album first; a change of camera drops what is still waiting. The world view uses the baked image exclusively: no terrain downloads or tile paints. Intermediate camera views reuse the sheet and cached tiles: new painting waits until the camera has rested for 160 ms and its zoom level has held for 140 ms. Explicit destination prefetch begins immediately, so a trace can prepare its arrival in advance.
- `public/app.js` decides which names to letter and where (`renderLabels`, and see Names below) and hands them to the view with the camera on every frame. The route's line, dots and port names stay in SVG above the canvas.
- `public/trips.js` lays the route maps in the logbook and album on the baked sheet, an SVG image of the whole sheet under the view box, so they appear at once and never wait. Only when a route is zoomed in past what the sheet holds, and the album has settled and is idle, does it ask the worker for a sharper cut (`paintedSheet`).

The page needs `Worker`, `OffscreenCanvas` and `DecompressionStream` to paint. Without them the route still draws over the baked preview image.

## Moving fast in Safari

Safari replays every `drawImage` on the CPU in its GPU process, so redrawing dozens of 514-pixel tiles each frame held a 3360×1728 canvas to about 30 frames a second, with script taking 1 ms of each. Moving a layer costs it almost nothing, so nothing is redrawn:

- `.atlas-layers`, inside the map shell and before `#map`, holds the sheet and one `.atlas-level` for each zoom level, in order. A level holds its tiles at their place in that level.
- Each level has one `transform`, written once a frame and only if it changed. The sheet follows the same way. Layer pixels are device pixels (a 514-pixel tile is 257 CSS pixels at twice the density), because WebKit would otherwise hold each tile enlarged at the screen's scale.
- Each tile is its own composited layer, `will-change: transform`, or WebKit would paint them all into their parent. It is a 2D canvas: WebKit shows such a canvas's surface as the layer, while a `bitmaprenderer` canvas is painted again into a layer of its own whenever it is attached, which measured longer frames in Safari. A worker's bitmap is drawn in once and closed. If the browser takes back a canvas's surface, `contextlost` drops the tile and the workers paint it again.
- Only tiles the view can see stay attached. `maxTiles` is the most kept in all. Eviction takes the least recently used first and never one the view is waiting for, which would be painted again and again.
- New tiles fade up with a compositor animation. Coarser tiles stand in, and the sheet lies under them, only until the view is covered and has settled. Then they leave: stand-ins are detached, and the sheet goes to `opacity: 0`, which keeps its pixels, where `visibility` would have WebKit paint it again. The 2-pixel gutter between tiles keeps joins closed at any position and scale, and z-order is fixed by place, so the same tile lies on top in a gutter whichever arrived first.
- While the album is open only the picture showing through its backdrop stays, with the sheet and the world's own tiles.

Names cost the most once tiles stopped. `measure` lays a name out without painting it, because most candidates are never shown, and at most four new sprites are lettered a frame; the rest wait and then fade up. The canvas clears and letters only when a name moved, changed or is fading.

The level rule stays as it was: a tile may be minified to 0.54 and enlarged to 1.08. The compositor has no mipmaps, so below about 0.75 the map at rest is a little crisper than `drawImage` left it, with finer grain in the sea. A later switch to the next level would not soften that gently: the marks are drawn for their level, so ships and peaks would come out visibly larger.

## Painting fast in Safari

Every WebKit browser's canvases are drawn by one GPU process shared with the page, so a worker painting there used to hold up the page's own frames. There the view asks for software canvases (`alpha:false, willReadFrequently:true`); Chrome and Firefox keep their GPU painting.

Canvas calls in Safari return at once and the work happens later, so timing around a call says nothing: read a pixel back with `getImageData` before stopping the clock. CoreGraphics draws the rest, one call at a time, and the costs are not what they are in Chrome. Three things were ruinous, and the painter avoids each:

- **Wide strokes over busy coasts**, up to two seconds a tile, whatever the join. Waterlines, pigment and the soft edge of the ink all lie at a set distance from the coast, so `traceShore` measures that distance on a small grid and looks up what lies there. Its cost does not depend on the coast.
- **Drawing under a clip.** Land, water and terrain are painted whole on a scratch canvas and cut once with `destination-in`. A tile no coast comes near needs no cut.
- **Thousands of small draws.** A forest is up to 20,000 marks in a tile. Each peak, hill and tree is drawn once for its kind, one of a few shapes, size in eighths of an octave, device scale and detail, read back, and then copied into a layer by plain arithmetic at a rounded pixel, back to front. The cache holds 32 MB per worker and lets the oldest go. Sand stipple and flecks of snow are written into a layer the same way.


Detail is procedural and stable. Up to 16× each zoom step doubles the terrain grid. Marks never move and new ones appear between them; past that no new peaks arrive, and foothills and groves thin out at 6× and 2.4×, so the ground shows through. The same cell always hashes to the same drawing, so neighbouring tiles always line up.

Snow follows the same rule of stable cells. A peak's cap comes from `coldness`: ruggedness and latitude, lifted over the ranges that stand higher than their ruggedness suggests, with a few high peaks left bare by hash. Greenland and Antarctica are white with fine blue-grey hatching. The high Arctic is dusted, along a line wandering at several scales that breaks into flecks toward its edge. Far northern conifers and foothills carry a little too. It lies on the land under names, which are lettered afterwards.

Nothing is fetched from a tile server. Every asset is in `public/atlas/`, `public/relief/` and `public/fonts/`. `geo1.bin` and the full land plate load when zoomed detail, a destination prefetch, or an album region is requested. A relief tile loads when a tile painted at 4.5× or closer needs it, in a 1440-wide window; one that fails to load has a 30-second cooldown shared by neighboring tiles in that worker. Incomplete visible tiles schedule up to three retries while retaining their existing artwork.

## Names

Small geographic names use Georgia with minimum sizes of 12 CSS pixels for countries and land features, 13 for cities, and 14 for capitals. Decorative lettering remains on continents and oceans. Route names have six pixels of separation when placed and four when retained. Ocean headings must also fit their water bounds. The baked sheet already contains its paper texture, so no full-screen grain layer covers the labels.

Everything lettered on the map goes into one occupancy grid each frame (`RedlineLabels.occupancy`), in this order: the dock, the controls and an open logbook; the route's dots; its port names (`RedlineLabels.place`), the active port first, then the ports on show, then ports the trace has yet to reach, which hold what is left unseen so nothing has to move when they arrive; the title plate; continents and oceans; then names already lettered, best rank first; then new ones, in the same order of countries, then seas, ranges and regions, then cities. A question costs the few cells a box touches, however many names there are. `atlas-view.js` measures names by the letter: `outline` is one box a letter, `footprint` a few boxes along a slanted or curved name, so another may lie in its corners.

- **Hysteresis.** A name lettered last frame keeps its place on a slacker rule than a new arrival's, 4 pixels of air against 9, and its zoom limits widen by 3%. One crowded out rests for 0.7 seconds and a doubling of zoom, a port's name for 0.35, because what crowded it may be about to go. A timer lays out again when a rest ends, since a camera at rest lays out nothing. A camera that jumped owes nothing to where names were, and starts afresh.
- **The red line.** Names keep off the whole route from the start, drawn or not, so nothing has to leave as the ink reaches it, and the index is built once per route rather than every frame of a trace.
- **Steering.** Continents, oceans, countries and the larger regions try small steps off their home point before giving up; cities and small regions do not. Port names try eight near places, then rings with a short leader, and a name crosses the line only from a near place, and only if nothing else is left. Leaders go into the grid as a row of small marks, and may not cross a name, a dot, the dock or the line.
- **The plate** tries a list of places in open water on the sheet (`PLATE_SPOTS`), sliding up from the far south as a short window's dock comes up to meet it, and over to the south Indian Ocean in a window too narrow for the Pacific.
- **The window edge.** A name stays inside it whole or not at all, and a port's name goes when its dot leaves.

The previous atlas layout measured 0.7 ms per frame at the median and 1.1 ms at the 95th percentile in Chrome on an M1. Those are historical figures, not timings of the current changes; current browser timing and visual verification are still required.

`scripts/check-names.mjs` is the test for all of it. It is an authoring tool, not part of `npm test`:

```sh
npm run build && node scripts/check-names.mjs --trace
```

It drives one headless Chrome against `dist/` through four windows, four routes, the whole world and 2× to 64× over four regions, each port on arrival, zoom and pan sweeps and a real trace, and reads the final box of every name. It counts name-on-name overlaps by kind, names under the plate, dock and controls, names cut by the window, port names missing with room to spare or more than 24 pixels from their dot, names on the line or on a dot, leaders across names, a city named twice, world views without the plate or a great name, and names that flicker in a sweep. It also checks its own boxes against the pixels: lettering ink outside every box means the boxes are wrong. Add `--shots DIR` to photograph the worst samples, because the eye catches what boxes miss.

## Assets, and how to rebuild them

These are generated once and committed. `npm run build` copies them; it does not regenerate them. The exception is `public/atlas-geography.js`, the route thumbnails' land shapes and the country and city names, which `scripts/build-atlas.mjs` rewrites from `public/world.js` on every build. `public/world.js` itself is not published.

| File | Contents |
| --- | --- |
| `public/atlas/sheet.webp`, `sheet-small.webp` | The whole sheet, 2880 and 1440 wide, without lettering. `scripts/atlas-sheet.json` records what it was painted from |
| `public/atlas/geo0.bin` | Coarse coasts, major rivers and lakes, borders, and the terrain grid (deflated) |
| `public/atlas/geo1.bin` | Fine coasts, all rivers and lakes, fine borders, first-level regions (deflated) |
| `public/atlas/land.jpg`, `land-small.jpg` | Land washes modelled by real hillshade |
| `public/atlas/sea.jpg` | Sea pigment pooled against the coasts |
| `public/atlas-names.js` | Mountain ranges, deserts, plains and seas to letter |
| `public/relief/` | Close-up hillshade from Natural Earth's shaded relief plate, as 90-unit square WebP tiles, with `index.js` listing which exist |
| `public/fonts/redline-hand.woff`, `redline-hand-bold.woff` | Redline Hand, drawn by `scripts/build-lettering.mjs` |
| `public/fonts/im-fell-english.woff2`, `im-fell-english-italic.woff2` | IM Fell English, roman and italic |

No script in this repository rebuilds `public/relief/`. To rebuild the geography and plates, download these public-domain [Natural Earth](https://www.naturalearthdata.com/) files into one directory:

- `vector/land-10m.json`, `vector/countries-10m.json`, from the [world-atlas](https://www.npmjs.com/package/world-atlas) package
- `vector/ne_10m_rivers_lake_centerlines.geojson`, `vector/ne_10m_lakes.geojson`, `vector/ne_10m_geography_regions_polys.geojson`, `vector/ne_10m_geography_marine_polys.geojson`, from [natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
- `raster/SR_50M.tif`, `raster/HYP_50M_SR.tif`, unzipped from Natural Earth's 1:50m raster downloads

Then run:

```sh
node scripts/build-atlas-art.mjs <that-directory>
```

Plates are converted to JPEG with macOS `sips`, so that step needs a Mac. Pass `geo` or `plates` to rebuild only one half.

## The baked sheet

Rebake it after any change to the painter, the geometry or the plates, and last, once the art is final. A test fails when it is stale:

```sh
node scripts/build-atlas-sheet.mjs
```

It paints the sheet with the real painter in one headless Chrome with a temporary profile, encodes it as finely as the size limits in `scripts/atlas-sheet.mjs` allow, and writes the record of what it was painted from. Set `CHROME` to the browser's path if it is not in the usual Mac place.

Map tile detail stops at level 4 (16×). Deeper camera zooms enlarge and reuse those tiles; destination prefetch obeys the same ceiling. Inland water is composited after terrain marks so forests cannot cover lakes. Background city names use a short recognizable-place selection; all route stops and the full search index remain available.

## Lettering

Redline Hand is generated: `scripts/build-lettering.mjs` holds a skeleton for each glyph, runs it through a simulated broad nib, adds small pen serifs and a slow wobble, and writes a WOFF using only Node built-ins. Change a stroke there and rerun it, once plain and once with `bold` for the heavier weight.

The chart's small text uses [IM Fell English](https://iginomarini.com/fell/), the types John Fell gathered for Oxford in the 1670s. It is licensed under the SIL Open Font License; see `public/fonts/OFL.txt`.

## The album

Type lives in `public/gallery.css`, and `test/gallery.test.mjs` holds it to these rules:

- `--album-text` is a warm book face from the system, "Iowan Old Style", then Palatino, then Georgia, for everything anyone reads: 15px for reading text, 13px at the very least, lining figures for counts and page numbers, and no tracking wider than .08em under 14px.
- Redline Hand letters the large titles, IM Fell English only the cover title and the toolbar's heading, and the album script only what is handwritten at a generous size: the postcard message, captions and "No photos yet".
- Contrast is at least 4.5:1 everywhere, read from pixels, including on the leather and on disabled controls.
- The city tabs keep their own lettering and are not part of this.

The first opening must move within about 100 ms, so nothing slow lies between the click and the cover. `showPhotos` opens the dialog and starts the cover's rise in the click itself: `RedlineAlbumMotion.create` with `late` needs only the book's size and tabs, which come from the photo list `restore()` read at startup, or from the route if that has not arrived. The rise is then the compositor's. After the first frame `fill` brings the real pages in behind the shut cover, from a fresh read, and the leaf starts turning on the common clock. If the read is late the leaf starts from the end of its hold and never jumps. Prints still decoding fade in on the copies. The whole opening or closing takes one second.

`warmAlbum` runs once the map has its first picture and has been quiet for 2.5 seconds: the fonts, the sheet, and the first prints, one small step per idle callback, or every 200 ms in Safari, which has no `requestIdleCallback`. It stops as soon as the album opens.

## Restored trace and controls

The trace uses the pre-atlas journey clock and camera easing from `208f21e`: continuous arrivals, smooth zoom pacing and a 2× held-key boost. Keep the newer date-line, reduced-motion and interrupted-overview fixes. The compact logbook is 320 px wide and the desktop planner 640 px, with Georgia typography and tighter stop rows. Tap Space to pause or resume; a hold over 180 ms gives 2× speed without pausing. Route ink is 3.4 CSS px over a 6 px pale under-stroke; both paths remain in screen coordinates at all zooms. South America and Atlantic Ocean use stacked, level names with measured collision bounds.

## Loading recovery and memory

The texture cache targets 96 tiles on desktop and 48 on small screens, preserving the current view even if it needs more. Worker startup and detailed asset requests have an eight-second network deadline; failed workers restart at most twice. A failed visible tile retries up to three times with backoff. Coarse results still in flight when detailed terrain arrives remain marked for replacement, preventing permanent mismatched patches. Detailed plate loading is deduplicated within each worker.

Canvas restoration and late font arrivals invalidate the name sprites and collision measurements. Resizing also schedules a fresh name layout, even when the camera stays still.
