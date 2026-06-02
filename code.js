figma.showUI(__html__, { width: 420, height: 720, themeColors: true });

const MAX_ASSETS = 150;
const GRID_GAP = 32;

figma.ui.onmessage = async (message) => {
  try {
    if (message.type === 'extract-url') {
      const assets = await extractAssetsFromUrl(message.url, message.quality || 'high');
      figma.ui.postMessage({ type: 'extraction-success', assets });
      return;
    }

    if (message.type === 'run-self-test') {
      const assets = getSelfTestAssets();
      figma.ui.postMessage({ type: 'extraction-success', assets });
      return;
    }

    if (message.type === 'import-selected') {
      const imported = await importAssets(message.assets || [], message.quality || 'high');
      figma.ui.postMessage({ type: 'import-success', imported });
      figma.notify(`Imported ${imported} asset${imported === 1 ? '' : 's'}.`);
      return;
    }

    if (message.type === 'favorites-load') {
      // Favorites are primarily handled in UI localStorage. clientStorage can fail
      // in some local/dev Figma contexts, so never surface this as a plugin error.
      try {
        const favorites = await figma.clientStorage.getAsync('inspiration-importer:favorites');
        figma.ui.postMessage({ type: 'favorites-loaded', favorites: Array.isArray(favorites) ? favorites : [] });
      } catch (storageError) {
        figma.ui.postMessage({ type: 'favorites-loaded', favorites: [] });
      }
      return;
    }

    if (message.type === 'favorites-save') {
      // Keep this best-effort only. The UI also saves to localStorage.
      try {
        await figma.clientStorage.setAsync('inspiration-importer:favorites', Array.isArray(message.favorites) ? message.favorites : []);
      } catch (storageError) {}
      return;
    }
  } catch (error) {
    if (message && (message.type === 'favorites-load' || message.type === 'favorites-save')) {
      figma.ui.postMessage({ type: 'favorites-loaded', favorites: [] });
      return;
    }
    const payloadType = message.type === 'import-selected' ? 'import-error' : 'extraction-error';
    figma.ui.postMessage({ type: payloadType, message: humanizeError(error) });
  }
};

async function extractAssetsFromUrl(inputUrl, quality) {
  const pageUrl = normalizeUserUrl(inputUrl);

  // Allow immediate testing with direct image URLs. Many real websites block HTML scraping,
  // but direct asset URLs let you verify the plugin import flow without a backend proxy.
  if (isSupportedImageUrl(pageUrl)) {
    return [{
      id: stableAssetId(pageUrl, 0),
      src: pageUrl,
      sourceUrl: pageUrl,
      alt: 'Direct image URL',
      width: null,
      height: null,
      fileSize: null,
      format: detectFormat(pageUrl),
    }];
  }

  const html = await fetchPageHtml(pageUrl);
  const parser = getHtmlParser(html);
  const candidates = parser.kind === 'cheerio'
    ? parseWithCheerio(parser.cheerio, parser.$, pageUrl, quality)
    : parseWithRegexFallback(html, pageUrl, quality);

  return dedupeAssets(candidates)
    .filter(function(asset) { return ['svg', 'png', 'jpg'].includes(asset.format); })
    .slice(0, MAX_ASSETS)
    .map(function(asset, index) {
      var normalized = {};
      for (var key in asset) {
        if (Object.prototype.hasOwnProperty.call(asset, key)) normalized[key] = asset[key];
      }
      normalized.id = stableAssetId(asset.src, index);
      normalized.sourceUrl = asset.sourceUrl || asset.src;
      normalized.width = numericOrNull(asset.width);
      normalized.height = numericOrNull(asset.height);
      normalized.fileSize = numericOrNull(asset.fileSize);
      return normalized;
    });
}


function getSelfTestAssets() {
  const svgOne = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" rx="24" fill="#18A0FB"/><circle cx="72" cy="80" r="34" fill="white" opacity="0.92"/><path d="M124 55h72v18h-72zM124 88h56v18h-56z" fill="white" opacity="0.92"/></svg>';
  const svgTwo = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><rect width="180" height="180" rx="36" fill="#111827"/><path d="M90 34l14 36 38 3-29 25 9 37-32-20-32 20 9-37-29-25 38-3z" fill="#FBBF24"/></svg>';
  return [svgOne, svgTwo].map((svg, index) => ({
    id: stableAssetId(svg, index),
    src: svgToDataUri(svg),
    sourceUrl: `self-test-inline-svg-${index + 1}`,
    alt: `Self-test SVG ${index + 1}`,
    width: extractSvgDimension(svg, 'width'),
    height: extractSvgDimension(svg, 'height'),
    fileSize: svg.length,
    format: 'svg',
    inlineSvg: svg,
  }));
}

function normalizeUserUrl(input) {
  var value = String(input || '').trim();
  value = value.replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (!value) throw new Error('INVALID_URL');
  var withProtocol = /^https?:\/\//i.test(value) ? value : 'https://' + value;

  // Avoid the URL constructor here because some Figma plugin sandboxes report
  // perfectly valid URLs as invalid when URL is unavailable in the main context.
  if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(withProtocol)) {
    throw new Error('INVALID_URL');
  }
  return withProtocol;
}

async function fetchPageHtml(url) {
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
  } catch (error) {
    throw new Error('NETWORK_OR_CORS');
  }

  if (!response.ok) {
    if (response.status === 403 || response.status === 401) throw new Error('BLOCKED_OR_CORS');
    if (response.status === 404) throw new Error('BROKEN_URL');
    throw new Error(`HTTP_${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    throw new Error('NOT_HTML');
  }

  return response.text();
}

function getHtmlParser(html) {
  // Production path: when bundled with cheerio, this parser is used.
  // Fallback path keeps the MVP runnable in Figma even before bundling.
  if (typeof require === 'function') {
    try {
      const cheerio = require('cheerio');
      return { kind: 'cheerio', cheerio, $: cheerio.load(html) };
    } catch (error) {
      // Continue to fallback parser.
    }
  }
  return { kind: 'fallback' };
}

function parseWithCheerio(cheerio, $, pageUrl, quality) {
  const assets = [];

  $('img').each((_, el) => {
    const node = $(el);
    const src = chooseSourceCandidate(node.attr('srcset'), quality) || node.attr('src') || node.attr('data-src') || node.attr('data-original');
    const absolute = toAbsoluteUrl(src, pageUrl);
    if (!absolute) return;
    assets.push({
      src: absolute,
      sourceUrl: absolute,
      alt: node.attr('alt') || '',
      width: node.attr('width'),
      height: node.attr('height'),
      format: detectFormat(absolute),
      fileSize: null,
    });
  });

  $('source').each((_, el) => {
    const src = chooseSourceCandidate($(el).attr('srcset'), quality);
    const absolute = toAbsoluteUrl(src, pageUrl);
    if (!absolute) return;
    assets.push({ src: absolute, sourceUrl: absolute, alt: '', width: null, height: null, format: detectFormat(absolute), fileSize: null });
  });

  $('svg').each((index, el) => {
    const raw = $.html(el);
    const optimized = optimizeSvg(raw);
    if (!optimized) return;
    assets.push({
      src: svgToDataUri(optimized),
      sourceUrl: `${pageUrl}#inline-svg-${index + 1}`,
      alt: 'Inline SVG',
      width: extractSvgDimension(optimized, 'width'),
      height: extractSvgDimension(optimized, 'height'),
      format: 'svg',
      fileSize: optimized.length,
      inlineSvg: optimized,
    });
  });

  $('link[rel*="icon"], link[rel="apple-touch-icon"], meta[property="og:image"], meta[name="twitter:image"], a[href]').each((_, el) => {
    const node = $(el);
    const src = node.attr('href') || node.attr('content');
    const absolute = toAbsoluteUrl(src, pageUrl);
    if (!absolute || !isSupportedImageUrl(absolute)) return;
    assets.push({ src: absolute, sourceUrl: absolute, alt: node.attr('rel') || node.attr('property') || '', width: null, height: null, format: detectFormat(absolute), fileSize: null });
  });

  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    extractCssUrls(style).forEach((src) => {
      const absolute = toAbsoluteUrl(src, pageUrl);
      if (!absolute || !isSupportedImageUrl(absolute)) return;
      assets.push({ src: absolute, sourceUrl: absolute, alt: 'CSS background image', width: null, height: null, format: detectFormat(absolute), fileSize: null });
    });
  });

  return assets;
}

function parseWithRegexFallback(html, pageUrl, quality) {
  const assets = [];

  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const attrs = parseAttributes(tag);
    const src = chooseSourceCandidate(attrs.srcset, quality) || attrs.src || attrs['data-src'] || attrs['data-original'];
    const absolute = toAbsoluteUrl(src, pageUrl);
    if (!absolute) continue;
    assets.push({ src: absolute, sourceUrl: absolute, alt: attrs.alt || '', width: attrs.width, height: attrs.height, format: detectFormat(absolute), fileSize: null });
  }

  for (const tag of html.match(/<source\b[^>]*>/gi) || []) {
    const attrs = parseAttributes(tag);
    const absolute = toAbsoluteUrl(chooseSourceCandidate(attrs.srcset, quality), pageUrl);
    if (!absolute) continue;
    assets.push({ src: absolute, sourceUrl: absolute, alt: '', width: null, height: null, format: detectFormat(absolute), fileSize: null });
  }

  const svgMatches = html.match(/<svg\b[\s\S]*?<\/svg>/gi) || [];
  svgMatches.forEach((raw, index) => {
    const optimized = optimizeSvg(raw);
    if (!optimized) return;
    assets.push({
      src: svgToDataUri(optimized),
      sourceUrl: `${pageUrl}#inline-svg-${index + 1}`,
      alt: 'Inline SVG',
      width: extractSvgDimension(optimized, 'width'),
      height: extractSvgDimension(optimized, 'height'),
      format: 'svg',
      fileSize: optimized.length,
      inlineSvg: optimized,
    });
  });

  for (const tag of html.match(/<(link|meta|a)\b[^>]*>/gi) || []) {
    const attrs = parseAttributes(tag);
    const src = attrs.href || attrs.content;
    const absolute = toAbsoluteUrl(src, pageUrl);
    if (!absolute || !isSupportedImageUrl(absolute)) continue;
    if (tag.startsWith('<meta') && !/og:image|twitter:image/i.test(tag)) continue;
    if (tag.startsWith('<link') && !/icon/i.test(attrs.rel || '')) continue;
    assets.push({ src: absolute, sourceUrl: absolute, alt: attrs.alt || attrs.rel || attrs.property || attrs.name || '', width: null, height: null, format: detectFormat(absolute), fileSize: null });
  }

  extractCssUrls(html).forEach((src) => {
    const absolute = toAbsoluteUrl(src, pageUrl);
    if (!absolute || !isSupportedImageUrl(absolute)) return;
    assets.push({ src: absolute, sourceUrl: absolute, alt: 'CSS image', width: null, height: null, format: detectFormat(absolute), fileSize: null });
  });

  return assets;
}

function parseAttributes(tag) {
  const attrs = {};
  const attrPattern = /([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = attrPattern.exec(tag))) {
    const name = match[1].toLowerCase();
    if (name === tag.replace(/^</, '').toLowerCase()) continue;
    attrs[name] = match[3] || match[4] || match[5] || '';
  }
  return attrs;
}

function chooseSourceCandidate(srcset, quality) {
  if (!srcset) return null;
  const candidates = srcset.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(/\s+/);
      const src = parts[0];
      const descriptor = parts[1] || '1x';
      const score = descriptor.endsWith('w') ? parseFloat(descriptor) : parseFloat(descriptor) * 1000;
      return { src, score: Number.isFinite(score) ? score : 1 };
    })
    .sort((a, b) => a.score - b.score);
  if (!candidates.length) return null;
  if (quality === 'high') return candidates[candidates.length - 1].src;
  if (quality === 'low') return candidates[0].src;
  return candidates[Math.floor((candidates.length - 1) / 2)].src;
}

function toAbsoluteUrl(src, baseUrl) {
  if (!src || /^javascript:/i.test(src)) return null;
  var clean = String(src).trim().replace(/^['"]|['"]$/g, '');
  if (!clean || clean === '#') return null;
  if (/^data:image\//i.test(clean)) return clean;
  if (/^https?:\/\//i.test(clean)) return clean;
  if (/^\/\//.test(clean)) {
    var protoMatch = String(baseUrl).match(/^(https?:)/i);
    return (protoMatch ? protoMatch[1] : 'https:') + clean;
  }

  var originMatch = String(baseUrl).match(/^(https?:\/\/[^\/]+)/i);
  if (!originMatch) return null;
  var origin = originMatch[1];
  if (clean.charAt(0) === '/') return origin + clean;

  var path = String(baseUrl).replace(/[?#].*$/, '');
  path = path.replace(/\/[^\/]*$/, '/');
  return path + clean;
}

function detectFormat(src) {
  const lower = String(src).toLowerCase().split('?')[0].split('#')[0];
  if (lower.startsWith('data:image/svg') || lower.endsWith('.svg')) return 'svg';
  if (lower.startsWith('data:image/png') || lower.endsWith('.png')) return 'png';
  if (lower.startsWith('data:image/jpeg') || lower.startsWith('data:image/jpg') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'jpg';
  if (lower.endsWith('.webp')) return 'jpg';
  return 'png';
}

function isSupportedImageUrl(src) {
  const lower = String(src).toLowerCase().split('?')[0].split('#')[0];
  return /^data:image\/(svg\+xml|png|jpe?g|webp)/i.test(lower) || /\.(svg|png|jpe?g|webp)$/i.test(lower);
}

function extractCssUrls(text) {
  const urls = [];
  const pattern = /url\(([^)]+)\)/gi;
  let match;
  while ((match = pattern.exec(text))) {
    urls.push(match[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return urls;
}

function dedupeAssets(assets) {
  const seen = new Set();
  const out = [];
  for (const asset of assets) {
    if (!asset || !asset.src) continue;
    const key = asset.inlineSvg ? asset.inlineSvg : asset.src.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out;
}

function stableAssetId(src, index) {
  let hash = 0;
  const input = `${src}:${index}`;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return `asset-${Math.abs(hash)}-${index}`;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = parseInt(String(value).replace(/px$/, ''), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function importAssets(assets, quality) {
  if (!Array.isArray(assets) || assets.length === 0) throw new Error('NO_SELECTION');

  var failures = [];
  const frame = figma.createFrame();
  frame.name = frameNameForAssets(assets);
  frame.x = figma.viewport.center.x;
  frame.y = figma.viewport.center.y;
  frame.layoutMode = 'NONE';
  frame.fills = [];
  // Start tiny, then resize to the actual imported content bounds.
  frame.resize(1, 1);
  figma.currentPage.appendChild(frame);

  let imported = 0;
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let contentWidth = 0;

  for (const asset of assets) {
    try {
      const node = await createNodeForAsset(asset, quality);
      const width = Math.max(24, node.width || 120);
      const height = Math.max(24, node.height || 120);

      if (cursorX > 0 && cursorX + width > 1120) {
        cursorX = 0;
        cursorY += rowHeight + GRID_GAP;
        rowHeight = 0;
      }

      node.x = cursorX;
      node.y = cursorY;
      frame.appendChild(node);
      cursorX += width + GRID_GAP;
      rowHeight = Math.max(rowHeight, height);
      contentWidth = Math.max(contentWidth, cursorX - GRID_GAP);
      imported += 1;
    } catch (error) {
      var reason = error && error.message ? error.message : String(error);
      failures.push(reason);
      console.warn('Asset import failed:', asset && (asset.remoteSrc || asset.src), error);
    }
  }

  if (!imported) {
    frame.remove();
    var detail = failures.length ? (': ' + failures.slice(0, 3).join(', ')) : '';
    throw new Error('ALL_IMPORTS_FAILED' + detail);
  }

  var finalWidth = Math.max(1, Math.ceil(contentWidth));
  var finalHeight = Math.max(1, Math.ceil(cursorY + rowHeight));
  frame.resize(finalWidth, finalHeight);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
  return imported;
}

async function createNodeForAsset(asset, quality) {
  if (asset.inlineSvg) {
    return createSvgNode(optimizeSvg(asset.inlineSvg), asset);
  }

  if (asset.format === 'svg' || /^data:image\/svg/i.test(asset.src)) {
    const svg = await fetchSvgText(asset.src);
    return createSvgNode(optimizeSvg(svg), asset);
  }

  const bytes = await fetchImageBytes(asset.src);
  const image = figma.createImage(bytes);
  const rect = figma.createRectangle();
  rect.name = safeNodeName(asset.alt || filenameFromAsset(asset) || asset.format || 'Imported image');

  const display = getDisplaySize(asset.width, asset.height, quality);
  rect.resize(display.width, display.height);
  rect.fills = [{ type: 'IMAGE', scaleMode: 'FIT', imageHash: image.hash }];
  return rect;
}

function createSvgNode(svgText, asset) {
  const node = figma.createNodeFromSvg(svgText);
  node.name = safeNodeName(asset.alt || filenameFromAsset(asset) || 'Imported SVG');
  const display = getDisplaySize(asset.width || node.width, asset.height || node.height, 'high');
  if (node.resize && display.width && display.height) node.resize(display.width, display.height);
  return node;
}

async function fetchSvgText(src) {
  if (/^data:image\/svg/i.test(src)) return decodeDataUri(src);
  let response;
  try {
    response = await fetch(src, { method: 'GET', redirect: 'follow' });
  } catch (error) {
    throw new Error('NETWORK_OR_CORS');
  }
  if (!response.ok) throw new Error(response.status === 404 ? 'BROKEN_IMAGE' : `HTTP_${response.status}`);
  return response.text();
}

async function fetchImageBytes(src) {
  if (/^data:image\//i.test(src)) {
    return dataUriToBytes(src);
  }
  let response;
  try {
    response = await fetch(src, { method: 'GET', redirect: 'follow' });
  } catch (error) {
    throw new Error('NETWORK_OR_CORS');
  }
  if (!response.ok) throw new Error(response.status === 404 ? 'BROKEN_IMAGE' : `HTTP_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function getDisplaySize(width, height, quality) {
  // The UI prepares raster assets at the selected safe size before sending them
  // here, so Figma placement should honor those prepared dimensions instead of
  // shrinking again for grid display. This keeps the canvas result aligned with:
  // Best available default: preserve the largest usable source and only downscale when needed for Figma safety.
  const sourceWidth = numericOrNull(width) || 180;
  const sourceHeight = numericOrNull(height) || 140;
  const maxSide = maxCanvasSideForQuality(quality);
  const fitScale = Math.min(maxSide / sourceWidth, maxSide / sourceHeight, 1);
  return {
    width: Math.max(24, Math.round(sourceWidth * fitScale)),
    height: Math.max(24, Math.round(sourceHeight * fitScale)),
  };
}

function maxCanvasSideForQuality(quality) {
  if (quality === 'high') return 2048;
  if (quality === 'low') return 900;
  return 1400;
}

function optimizeSvg(svg) {
  if (!svg) return '';
  return String(svg)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

function svgToDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function extractSvgDimension(svg, attr) {
  const match = svg.match(new RegExp(`${attr}=["']?([0-9.]+)`, 'i'));
  if (match) return numericOrNull(match[1]);
  const viewBox = svg.match(/viewBox=["']?([0-9.\s-]+)/i);
  if (viewBox) {
    const parts = viewBox[1].trim().split(/\s+/).map(Number);
    if (parts.length === 4) return attr === 'width' ? Math.round(parts[2]) : Math.round(parts[3]);
  }
  return null;
}

function decodeDataUri(uri) {
  const [, meta = '', data = ''] = uri.match(/^data:([^,]*),(.*)$/i) || [];
  if (!data) return '';
  if (/;base64/i.test(meta)) return base64Decode(data);
  return decodeURIComponent(data);
}

function dataUriToBytes(uri) {
  const [, meta = '', data = ''] = uri.match(/^data:([^,]*),(.*)$/i) || [];
  if (!data) throw new Error('BROKEN_IMAGE');
  const binary = /;base64/i.test(meta) ? base64Decode(data) : decodeURIComponent(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Decode(value) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let str = String(value).replace(/=+$/, '');
  let output = '';
  if (str.length % 4 === 1) throw new Error('BROKEN_IMAGE');
  for (let bc = 0, bs = 0, buffer, idx = 0; (buffer = str.charAt(idx++));) {
    buffer = chars.indexOf(buffer);
    if (buffer < 0) continue;
    bs = bc % 4 ? bs * 64 + buffer : buffer;
    if (bc++ % 4) output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
  }
  return output;
}


function frameNameForAssets(assets) {
  var first = Array.isArray(assets) ? assets.find(function(asset) {
    return asset && (asset.pageUrl || asset.sourceUrl || asset.originalSrc || asset.remoteSrc || asset.src);
  }) : null;
  var source = first ? (first.pageUrl || first.sourceUrl || first.originalSrc || first.remoteSrc || first.src) : '';
  var domain = domainFromUrl(source);
  return domain ? ('Site Asset Importer - ' + domain) : 'Site Asset Importer';
}

function domainFromUrl(value) {
  try {
    var match = String(value || '').match(/^https?:\/\/([^\/]+)/i);
    return match && match[1] ? match[1].replace(/^www\./i, '') : '';
  } catch (error) {
    return '';
  }
}

function filenameFromAsset(asset) {
  var source = asset && (asset.originalSrc || asset.sourceUrl || asset.remoteSrc || asset.src) || '';
  try {
    var clean = String(source).split('?')[0].split('#')[0];
    var name = clean.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(name).slice(0, 80);
  } catch (error) {
    return '';
  }
}

function safeNodeName(value) {
  return String(value || 'Imported asset').replace(/[\r\n\t]+/g, ' ').slice(0, 80);
}

function humanizeError(error) {
  const code = String(error && error.message ? error.message : error);
  if (code === 'INVALID_URL') return 'Invalid URL. Use a full website address like https://example.com.';
  if (code === 'NETWORK_OR_CORS') return 'Could not access that site or image. It may block plugin requests, require login, or be blocked by CORS/network policy.';
  if (code === 'BLOCKED_OR_CORS') return 'This site blocked access. Try another public URL or download assets manually.';
  if (code === 'BROKEN_URL') return 'The URL returned 404. Check the website address and try again.';
  if (code === 'NOT_HTML') return 'That URL did not return website HTML. If it is a direct image URL, make sure it ends in .svg, .png, .jpg, .jpeg, or .webp.';
  if (code === 'NO_SELECTION') return 'Select at least one image before importing.';
  if (code.indexOf('ALL_IMPORTS_FAILED') === 0) return 'Images were found, but none could be imported. Details: ' + code.replace('ALL_IMPORTS_FAILED:', '').trim();
  if (code === 'BROKEN_IMAGE') return 'One or more selected images could not be loaded.';
  if (/^HTTP_/.test(code)) return `The server returned ${code.replace('HTTP_', 'HTTP ')}.`;
  return 'Something went wrong while processing this request.';
}
