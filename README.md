# Site Asset Importer — Beta

**Extract images, SVGs, icons, and logos from public websites into Figma.**

Site Asset Importer helps designers pull visual assets from public webpages into a clean Figma asset board. Paste a URL, preview extracted assets, select what you need, and import them directly onto the canvas.

## What changed in v27

- Keeps **best available** image quality by default.
- Hides smaller responsive duplicate image sizes by default, including Amazon/Shopbop CDN size variants like `._QL80_UX768_...jpg`, `._SX1500_.jpg`, and `._AC_SL1500_.jpg`.
- Adds **Show duplicate sizes** for users who want to inspect every version.
- Sorts useful/larger assets first.
- Results summary now includes duplicate sizes hidden, unavailable assets, and tiny hidden assets.
- Keeps **Open source** and **Copy URL** on asset cards.
- Imported frames are named **Site Asset Importer - domain.com**.
- Keeps the hosted backend: `https://inspirationimporter.onrender.com`.

## How to install the beta

1. Download and unzip the beta folder.
2. Open **Figma Desktop**.
3. Go to **Plugins → Development → Import plugin from manifest…**
4. Select the `manifest.json` file from the unzipped folder.
5. Run **Plugins → Development → Site Asset Importer**.

## How to use

1. Paste a public website URL or direct image URL.
2. Click **Extract Assets**.
3. Review the asset grid.
4. Use filters like SVG, PNG, JPG, WEBP, Hide tiny, Show unavailable, or Show duplicate sizes.
5. Select the assets you want.
6. Click **Import Selected**.
7. The selected assets will appear on your Figma canvas.

## Best available behavior

Site Asset Importer automatically prefers the best available image source it can find. If a site provides the same image in multiple responsive sizes, the plugin shows the largest/best version by default and hides smaller duplicate sizes.

Use **Show duplicate sizes** when you want to inspect every responsive version of the same image.

Large images are resized only when needed to keep imports safe for Figma.

## Known limitation

Some websites block extraction. If that happens, the plugin will show:

> This site blocks extraction.  
> Try another public page or use a direct image URL instead.

This means the website refused extraction. The plugin is still working.
