Great — let’s make the tester README / instructions. You can paste this into the ZIP, GitHub README, or an email to testers.

Inspiration Importer — Private Beta

Inspiration Importer is a Figma plugin that helps designers pull visual assets from public websites into Figma.

Paste a website URL, extract images/SVGs/icons/logos, preview the results, select what you want, and import selected assets directly onto the Figma canvas.

What to test

Please test the plugin with a few public website URLs and let me know what works, what feels confusing, and what breaks.

Good test URLs:

https://www.wikipedia.org
https://www.nba.com
https://tasteofhome.com

You can also test a direct image URL, like:

https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg
How to install
Download and unzip the beta folder.
Open Figma Desktop.
Go to Plugins → Development → Import plugin from manifest…
Select the manifest.json file from the unzipped folder.
Run Plugins → Development → Inspiration Importer.
How to use
Paste a public website URL.
Click Extract Assets.
Review the asset grid.
Use filters like SVG, PNG, JPG, WEBP, Hide tiny, or Hide unavailable.
Select the assets you want.
Click Import Selected.
The selected assets should appear on the Figma canvas.
What “Open source” means

Each asset card includes an Open source link.

Use this to:

view the original image/icon file
check image quality
copy the direct image URL
see if a larger version exists
Known limitations

Some websites block extraction. If that happens, the plugin will show:

This site blocks extraction.
Try another public page or use a direct image URL instead.

This means the site does not allow the plugin/backend to access its assets. The plugin is still working.

Some assets may show Preview unavailable. This usually means the asset was detected, but the site blocked preview loading or the file is more technical than visual.

Feedback questions

Please send feedback on:

1. Were you able to install the plugin?
2. Was the purpose clear?
3. What URLs did you test?
4. Did assets appear in the grid?
5. Were the filters useful?
6. Did “Open source” make sense?
7. Were you able to import selected assets into Figma?
8. Did any sites block extraction?
9. What felt confusing?
10. Would this be useful in your design workflow?
Beta note

This is an early beta. It works best with public websites and direct image URLs. Some sites may block extraction.
