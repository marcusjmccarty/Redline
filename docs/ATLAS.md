# The atlas

The map is painted, not drawn by the browser's SVG engine. A worker inks tiles onto canvases; the page moves those bitmaps, which is why zooming and tracing stay fast however rich the map is.

## At runtime

- `public/atlas-painter.js` draws one tile: watercolour sea, rhumb lines, ink waterlines, land cut crisply from its plate, rivers, lakes, dotted borders, then forests, peaks and ornaments. It has no DOM dependencies and runs in the worker.
- `public/atlas-worker.js` loads the assets and paints tiles on request. The first paint uses `geo0.bin` and the small land plate; `geo1.bin` and the full plate follow and sharpen the map in place.
- `public/atlas-view.js` composites tiles, lettered names and the graduated border onto one canvas. Lettering is rendered once into sprites.
- `public/app.js` decides which names to letter (`renderLabels`) and hands them to the view with the camera on every frame. The route's line, dots and port names stay in SVG above the canvas.
- `public/trips.js` asks the same worker for painted thumbnails of the sheet (`paintedSheet`), for the route maps in the logbook and album.

The page needs `Worker`, `OffscreenCanvas` and `DecompressionStream` to paint. Without them the route still draws over a plain sheet.

Detail is procedural and stable. Up to 16× each zoom step doubles the terrain grid. Marks never move and new ones appear between them; past that no new peaks arrive, and foothills and groves thin out at 6× and 2.4×, so the ground shows through. The same cell always hashes to the same drawing, so neighbouring tiles always line up.

Nothing is fetched from a tile server. Every asset is in `public/atlas/`, `public/relief/` and `public/fonts/`. `geo1.bin` and the full land plate load once the view zooms in, or at once on a canvas over 1700 device pixels wide. A relief tile loads when a tile painted at 4.5× or closer needs it, in a 1440-wide window; one that fails to load is asked for again by the next painted tile that needs it.

## Assets, and how to rebuild them

These are generated once and committed. `npm run build` copies them; it does not regenerate them. The exception is `public/atlas-geography.js`, the route thumbnails' land shapes and the country and city names, which `scripts/build-atlas.mjs` rewrites from `public/world.js` on every build. `public/world.js` itself is not published.

| File | Contents |
| --- | --- |
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

## Lettering

Redline Hand is generated: `scripts/build-lettering.mjs` holds a skeleton for each glyph, runs it through a simulated broad nib, adds small pen serifs and a slow wobble, and writes a WOFF using only Node built-ins. Change a stroke there and rerun it, once plain and once with `bold` for the heavier weight.

Small text uses [IM Fell English](https://iginomarini.com/fell/), the types John Fell gathered for Oxford in the 1670s. It is licensed under the SIL Open Font License; see `public/fonts/OFL.txt`.
