# Inspiration Importer — Beta

**Collect visual inspiration from public websites and bring selected assets into Figma.**

Inspiration Importer helps designers scan a public webpage, review the visual assets it contains, select useful references, and import them into a clean Figma frame.

## v27 launch-stability update

- Removed the visible **Self Test** development control.
- Added **AVIF** recognition, filtering, direct-image URL support, and raster preparation for Figma import.
- Kept the hosted scraper backend as the single webpage-extraction path.
- Kept the plugin no-build and easy to install from `manifest.json`.
- Preserved the existing favorites storage key and the stable v26 import behavior.
- Imported frames remain named **Inspiration Importer - domain.com**.

## Architecture

```text
Public webpage
      ↓
Inspiration Importer UI
      ↓
Hosted extraction backend
      ↓
Preview / filter / select
      ↓
Backend asset fetch + Figma-safe preparation
      ↓
Figma plugin main process
      ↓
Inspiration Importer frame on canvas
```

Direct image URLs skip webpage extraction and are passed directly into the preview/import flow.

## Files

- `manifest.json` — Figma plugin configuration and network permissions.
- `ui.html` — complete plugin interface and UI-side extraction/preparation logic.
- `code.js` — Figma-side direct-image validation and canvas import logic.
- `README.md` — installation, usage, and architecture notes.

This beta intentionally keeps the UI JavaScript inline in `ui.html` so the plugin remains a simple no-build Figma development plugin.

## Install

1. Download and unzip the plugin folder.
2. Open **Figma Desktop**.
3. Go to **Plugins → Development → Import plugin from manifest…**
4. Select `manifest.json`.
5. Run **Plugins → Development → Inspiration Importer**.

## Use

1. Paste a public website URL or a direct image URL.
2. Click **Extract Assets**.
3. Review the asset grid.
4. Filter by SVG, PNG, JPG, WEBP, or AVIF and optionally hide tiny or unavailable assets.
5. Select the references you want.
6. Click **Import Selected**.
7. Figma creates an **Inspiration Importer - domain.com** frame containing the imported assets.

## Quality behavior

The UI requests the best available image source. Raster assets are resized only when needed to keep the longest side at or below 2048 px before Figma import.

## Backend

Website extraction and protected/hotlinked asset fetching use:

`https://inspirationimporter.onrender.com`

The backend is now the authoritative webpage extraction path. The Figma main process no longer attempts to download and parse webpage HTML itself.

## Known limitation

Some websites block scraping or protect image assets. When that happens, Inspiration Importer keeps the failure understandable and, where possible, leaves the source URL available so the designer can inspect the asset directly.
