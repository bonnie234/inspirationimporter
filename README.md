# Inspiration Importer v14

A Figma plugin MVP for importing website inspiration assets, now with a local scraper/proxy backend.

## What this version does

- Direct image URLs still work inside the plugin.
- Full website URLs are sent to a local Node backend at `http://localhost:8787`.
- The backend uses `cheerio` to extract:
  - `<img>` sources
  - `<source srcset>` / picture assets
  - inline `<svg>` elements
  - favicon/apple-touch/OG/Twitter images
  - CSS `url(...)` assets from inline styles and a limited number of stylesheets
- Remote assets are proxied through `/asset?url=...` so the Figma plugin can download bytes without most browser CORS failures.
- The plugin still supports selection, favorites, filters, quality scaling, and Figma canvas import.

## Files

- `manifest.json` — Figma plugin manifest
- `ui.html` — bundled plugin UI with inline JS/CSS
- `ui.js` — source copy of the UI script
- `code.js` — Figma plugin main logic
- `server.js` — local scraper/proxy backend
- `package.json` — backend dependencies and scripts
- `.env.example` — optional backend config

## Start the scraper backend

Open Terminal in this folder and run:

```bash
npm install
npm run dev
```

You should see:

```text
Inspiration Importer scraper running at http://localhost:8787
```

Leave that Terminal window running while testing the plugin.

## Load the Figma plugin

1. Open Figma Desktop.
2. Go to **Plugins > Development > Import plugin from manifest...**
3. Select this folder's `manifest.json`.
4. Run **Plugins > Development > Inspiration Importer**.

## Test order

1. Click **Self Test**.
2. Try a direct image URL.
3. Try a simple public website URL.
4. Try a real brand/marketing site.

Direct image URLs should work without the backend. Website URLs require the backend to be running.

## Notes and limitations

This is still an MVP scraper. It will catch many normal HTML/CSS assets, but some websites may still hide assets behind JavaScript rendering, authentication, bot protection, signed image URLs, or restrictive anti-scraping rules. A hosted production version should deploy `server.js` or equivalent server-side logic to a trusted backend domain and then update `SCRAPER_BACKEND_URL` in `ui.js` and the manifest network domains.

## v12 large-site UI note
This build improves large extraction sets such as nba.com by using a full-width results grid, visible checkboxes, fixed-height cards, and a default “Hide tiny” filter for tracking pixels/spacers/micro-icons. Uncheck “Hide tiny” to inspect every raw extracted asset.


## v14 notes

This build adds a backend `/asset-data` route. During import, the plugin asks the local backend to fetch selected remote assets server-side and return data URLs. This reduces browser-side CORS/hotlinking failures on large commercial sites.

For large sites like NBA.com, keep **Hide tiny** enabled first. Many extracted assets are tracking pixels, responsive duplicates, or tiny SVG UI controls rather than useful design assets.

## v16 notes

This build improves large JavaScript-heavy sites such as NBA.com. The backend now scans regular HTML, data attributes, srcset values, inline scripts, escaped JSON URLs, inline styles, linked CSS, favicons, Open Graph images, and video posters. Asset proxy requests also pass the original page URL as a referer when possible, which helps some CDN-hosted thumbnails and imports.

When testing sites with many assets, keep **Hide tiny** enabled first. Some boxes may still say “Preview unavailable” when the site exposes a technical asset that the browser cannot render as a normal thumbnail, but the backend should now find more real page images than v14.


## v20 polish

Asset cards now use clearer compact metadata: format label, dimensions in pixels, file size availability, and a direct Open source link for quality checking.


## v23 polish

- Added plain-language blocked-site messaging for HTTP 401/402/403/429-style responses.
- Replaced developer-style extraction error details with user-friendly guidance.
