/* Site Asset Importer scraper backend
   Run with: npm install && npm run dev
   Then keep http://localhost:8787 running while testing the Figma plugin.
*/
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 8787;
const MAX_ASSETS = Number(process.env.MAX_ASSETS || 200);
const MAX_CSS_FILES = Number(process.env.MAX_CSS_FILES || 8);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 8 * 1024 * 1024);

app.use(cors({ origin: '*', methods: ['GET', 'OPTIONS'] }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'inspiration-importer-scraper' });
});

app.get('/extract', async (req, res) => {
  try {
    const pageUrl = normalizeUrl(req.query.url);
    const quality = normalizeQuality(req.query.quality);
    const response = await fetchWithTimeout(pageUrl, {
      headers: {
        'user-agent': browserUserAgent(),
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9'
      }
    });

    if (!response.ok) return res.status(response.status).json({ error: 'HTTP_' + response.status });
    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return res.status(415).json({ error: 'NOT_HTML', contentType });
    }

    const html = await readLimitedText(response, MAX_BODY_BYTES);
    const assets = await extractAssets(html, pageUrl, quality, req);
    res.json({ pageUrl, count: assets.length, assets });
  } catch (error) {
    const message = error && error.message ? error.message : 'EXTRACT_FAILED';
    const status = message === 'INVALID_URL' ? 400 : 500;
    res.status(status).json({ error: message });
  }
});


app.get('/asset-data', async (req, res) => {
  try {
    const assetUrl = normalizeUrl(req.query.url);
    const response = await fetchWithTimeout(assetUrl, {
      headers: {
        'user-agent': browserUserAgent(),
        'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'referer': safeReferer(req.query.referer, assetUrl)
      }
    });

    if (!response.ok) return res.status(response.status).json({ error: 'HTTP_' + response.status });
    const contentType = response.headers.get('content-type') || contentTypeFromUrl(assetUrl) || 'application/octet-stream';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const format = formatFromContentType(contentType) || detectFormat(assetUrl);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      url: assetUrl,
      contentType,
      format,
      fileSize: buffer.length,
      dataUrl: 'data:' + contentType + ';base64,' + buffer.toString('base64')
    });
  } catch (error) {
    res.status(502).json({ error: error && error.message ? error.message : 'ASSET_DATA_FAILED' });
  }
});

app.get('/asset', async (req, res) => {
  try {
    const assetUrl = normalizeUrl(req.query.url);
    const response = await fetchWithTimeout(assetUrl, {
      headers: {
        'user-agent': browserUserAgent(),
        'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'referer': safeReferer(req.query.referer, assetUrl)
      }
    });

    if (!response.ok) return res.status(response.status).send('HTTP_' + response.status);
    const contentType = response.headers.get('content-type') || contentTypeFromUrl(assetUrl) || 'application/octet-stream';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Type', contentType);
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    res.status(502).send(error && error.message ? error.message : 'ASSET_PROXY_FAILED');
  }
});

async function extractAssets(html, pageUrl, quality, req) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const rawAssets = [];

  $('img').each((_i, el) => {
    const node = $(el);
    const src = chooseSourceCandidate(node.attr('srcset'), quality)
      || node.attr('src')
      || node.attr('data-src')
      || node.attr('data-original')
      || node.attr('data-lazy-src')
      || node.attr('data-srcset');
    pushRemote(rawAssets, src, pageUrl, {
      alt: node.attr('alt') || '',
      width: node.attr('width') || node.attr('data-width') || null,
      height: node.attr('height') || node.attr('data-height') || null
    });
  });

  $('source').each((_i, el) => {
    const node = $(el);
    const src = chooseSourceCandidate(node.attr('srcset'), quality) || node.attr('src');
    pushRemote(rawAssets, src, pageUrl, { alt: 'Picture source' });
  });

  $('svg').each((index, el) => {
    const raw = $.html(el);
    const optimized = optimizeSvg(raw);
    if (!optimized) return;
    rawAssets.push({
      idSeed: pageUrl + '#inline-svg-' + (index + 1),
      src: svgToDataUri(optimized),
      originalSrc: pageUrl + '#inline-svg-' + (index + 1),
      sourceUrl: pageUrl + '#inline-svg-' + (index + 1),
      alt: 'Inline SVG',
      width: extractSvgDimension(optimized, 'width'),
      height: extractSvgDimension(optimized, 'height'),
      format: 'svg',
      fileSize: Buffer.byteLength(optimized),
      inlineSvg: optimized
    });
  });

  $('link[rel*="icon"], link[rel="apple-touch-icon"], meta[property="og:image"], meta[name="twitter:image"], meta[itemprop="image"], a[href], video[poster]').each((_i, el) => {
    const node = $(el);
    const src = node.attr('href') || node.attr('content') || node.attr('poster');
    pushRemote(rawAssets, src, pageUrl, { alt: node.attr('rel') || node.attr('property') || node.attr('name') || node.attr('itemprop') || 'Linked image', pageUrl });
  });

  // Many modern sites keep images in data-* attrs instead of normal src/srcset.
  $('[style]').each((_i, el) => {
    extractCssUrls($(el).attr('style') || '').forEach((src) => pushRemote(rawAssets, src, pageUrl, { alt: 'CSS background image', pageUrl }));
  });

  $('*').each((_i, el) => {
    const attribs = el.attribs || {};
    Object.keys(attribs).forEach((name) => {
      const value = attribs[name];
      if (!value) return;
      if (/srcset/i.test(name)) {
        splitSrcsetCandidates(value).forEach((src) => pushRemote(rawAssets, src, pageUrl, { alt: 'Responsive image', pageUrl }));
        return;
      }
      if (/(src|href|poster|content|image|img|thumbnail|background|logo|url)$/i.test(name) || /^data-/i.test(name)) {
        extractPossibleImageUrls(value).forEach((src) => pushRemote(rawAssets, src, pageUrl, { alt: name, pageUrl }));
      }
    });
  });

  // JavaScript-heavy sites often serialize image URLs inside JSON or script blobs.
  $('script').each((_i, el) => {
    extractPossibleImageUrls($(el).html() || '').forEach((src) => pushRemote(rawAssets, src, pageUrl, { alt: 'Script image', pageUrl }));
  });

  // Last-pass scan over the HTML catches escaped URLs such as https:\/\/cdn.site.com\/image.jpg.
  extractPossibleImageUrls(html).forEach((src) => pushRemote(rawAssets, src, pageUrl, { alt: 'Embedded image', pageUrl }));

  const cssUrls = [];
  $('link[rel="stylesheet"][href]').each((_i, el) => {
    const href = toAbsoluteUrl($(el).attr('href'), pageUrl);
    if (href && cssUrls.length < MAX_CSS_FILES) cssUrls.push(href);
  });

  for (const cssUrl of cssUrls) {
    try {
      const cssResponse = await fetchWithTimeout(cssUrl, {
        headers: { 'user-agent': browserUserAgent(), 'accept': 'text/css,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', 'referer': pageUrl }
      });
      if (!cssResponse.ok) continue;
      const css = await readLimitedText(cssResponse, 1024 * 1024);
      extractCssUrls(css).forEach((src) => pushRemote(rawAssets, src, cssUrl, { alt: 'Stylesheet image' }));
    } catch (_error) {
      // CSS extraction is best-effort.
    }
  }

  const deduped = dedupeAssets(rawAssets)
    .filter((asset) => ['svg', 'png', 'jpg', 'webp'].includes(asset.format))
    .slice(0, MAX_ASSETS);

  return deduped.map((asset, index) => {
    const out = copy(asset);
    out.id = stableAssetId(asset.idSeed || asset.originalSrc || asset.src, index);
    if (!asset.inlineSvg && asset.originalSrc) {
      out.src = proxyAssetUrl(req, asset.originalSrc, pageUrl);
      out.remoteSrc = asset.originalSrc;
      out.sourceUrl = asset.originalSrc;
      out.pageUrl = asset.pageUrl || pageUrl;
      out.thumbnail = out.src;
    }
    out.width = numericOrNull(out.width);
    out.height = numericOrNull(out.height);
    out.fileSize = numericOrNull(out.fileSize);
    return out;
  });
}

function pushRemote(list, src, baseUrl, extra) {
  const absolute = toAbsoluteUrl(src, baseUrl);
  if (!absolute || !isSupportedImageUrl(absolute)) return;
  list.push({
    idSeed: absolute,
    src: absolute,
    originalSrc: absolute,
    sourceUrl: absolute,
    pageUrl: extra && extra.pageUrl ? extra.pageUrl : baseUrl,
    alt: extra && extra.alt ? extra.alt : '',
    width: extra && extra.width ? extra.width : null,
    height: extra && extra.height ? extra.height : null,
    format: detectFormat(absolute),
    fileSize: null
  });
}

function normalizeUrl(value) {
  let url = String(value || '').trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (!url) throw new Error('INVALID_URL');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let parsed;
  try { parsed = new URL(url); } catch (_error) { throw new Error('INVALID_URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('INVALID_URL');
  return parsed.toString();
}

function normalizeQuality(value) {
  return ['high', 'medium', 'low'].includes(String(value)) ? String(value) : 'medium';
}

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const opts = Object.assign({}, options || {}, { signal: controller.signal, redirect: 'follow' });
  return fetch(url, opts).finally(() => clearTimeout(timeout));
}

async function readLimitedText(response, maxBytes) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) return response.text();
  const chunks = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.length;
    if (total > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    chunks.push(result.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function toAbsoluteUrl(src, baseUrl) {
  if (!src) return null;
  let value = String(src).trim().replace(/^url\((.*)\)$/i, '$1').replace(/^['"]|['"]$/g, '');
  if (!value || value.startsWith('#') || /^data:(?!image\/)/i.test(value) || /^blob:/i.test(value) || /^javascript:/i.test(value)) return null;
  if (/^\/\//.test(value)) value = 'https:' + value;
  try { return new URL(value, baseUrl).toString(); } catch (_error) { return null; }
}

function splitSrcsetCandidates(srcset) {
  if (!srcset) return [];
  return String(srcset).split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
}

function chooseSourceCandidate(srcset, quality) {
  if (!srcset) return null;
  const candidates = String(srcset).split(',').map((part) => {
    const pieces = part.trim().split(/\s+/);
    const url = pieces[0];
    const descriptor = pieces[1] || '1x';
    let score = 1;
    if (/w$/i.test(descriptor)) score = parseInt(descriptor, 10) || 1;
    if (/x$/i.test(descriptor)) score = (parseFloat(descriptor) || 1) * 1000;
    return { url, score };
  }).filter((item) => item.url);
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  if (quality === 'low') return candidates[0].url;
  if (quality === 'high') return candidates[candidates.length - 1].url;
  return candidates[Math.floor(candidates.length / 2)].url;
}

function extractCssUrls(cssText) {
  const urls = [];
  const regex = /url\((['"]?)(.*?)\1\)/gi;
  let match;
  while ((match = regex.exec(cssText || ''))) {
    const value = (match[2] || '').trim();
    if (value && !/^data:/i.test(value)) urls.push(value);
  }
  return urls;
}


function extractPossibleImageUrls(text) {
  const out = [];
  if (!text) return out;

  let value = String(text)
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\u002F/g, '/')
    .replace(/\u0026/g, '&');

  // CSS background images inside arbitrary attributes or JSON strings.
  extractCssUrls(value).forEach((url) => out.push(url));

  // Absolute image URLs, including query-string CDN URLs.
  const absoluteRegex = /https?:\/\/[^\s"'<>\\)]+?\.(?:svg|png|jpe?g|webp)(?:\?[^\s"'<>\\)]*)?/gi;
  let match;
  while ((match = absoluteRegex.exec(value))) {
    out.push(cleanCandidateUrl(match[0]));
  }

  // Protocol-relative image URLs.
  const protocolRelativeRegex = /\/\/[^\s"'<>\\)]+?\.(?:svg|png|jpe?g|webp)(?:\?[^\s"'<>\\)]*)?/gi;
  while ((match = protocolRelativeRegex.exec(value))) {
    out.push('https:' + cleanCandidateUrl(match[0]));
  }

  // Relative image paths found inside data attributes / JSON values.
  const relativeRegex = /(?:^|["'(:\s])((?:\.\.\/|\.\/|\/)?[^\s"'<>\\)]*\.(?:svg|png|jpe?g|webp)(?:\?[^\s"'<>\\)]*)?)/gi;
  while ((match = relativeRegex.exec(value))) {
    const candidate = cleanCandidateUrl(match[1]);
    if (candidate && !/^https?:/i.test(candidate) && !/^data:/i.test(candidate)) out.push(candidate);
  }

  // Some Next.js / CDN image URLs hide the real source in url= encoded params.
  const encodedUrlRegex = /(?:url|src|image)=([^&\s"'<>]+)/gi;
  while ((match = encodedUrlRegex.exec(value))) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (isSupportedImageUrl(decoded) || /\.(svg|png|jpe?g|webp)(?:[?#].*)?$/i.test(decoded)) out.push(decoded);
    } catch (_error) {}
  }

  return out.filter(Boolean);
}

function cleanCandidateUrl(value) {
  return String(value || '')
    .trim()
    .replace(/[),.;]+$/g, '')
    .replace(/^['"]|['"]$/g, '');
}

function isSupportedImageUrl(url) {
  return /\.(svg|png|jpe?g|webp)(?:[?#].*)?$/i.test(String(url || '')) || /^data:image\/svg/i.test(String(url || ''));
}

function detectFormat(url) {
  const value = String(url || '').toLowerCase();
  if (/svg/.test(value)) return 'svg';
  if (/png/.test(value)) return 'png';
  if (/webp/.test(value)) return 'webp';
  if (/jpe?g/.test(value)) return 'jpg';
  return 'jpg';
}

function optimizeSvg(svg) {
  if (!svg) return '';
  return String(svg)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

function svgToDataUri(svg) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function extractSvgDimension(svg, attr) {
  const match = String(svg || '').match(new RegExp(attr + "=[\"']?([0-9.]+)", 'i'));
  if (match) return numericOrNull(match[1]);
  const viewBox = String(svg || '').match(/viewBox=["']?([0-9.\s-]+)/i);
  if (viewBox) {
    const parts = viewBox[1].trim().split(/\s+/).map(Number);
    if (parts.length === 4) return attr === 'width' ? Math.round(parts[2]) : Math.round(parts[3]);
  }
  return null;
}

function dedupeAssets(assets) {
  const seen = new Set();
  return assets.filter((asset) => {
    const key = asset.inlineSvg ? asset.inlineSvg : (asset.originalSrc || asset.src || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stableAssetId(value, index) {
  let hash = 0;
  const text = String(value || '') + ':' + index;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return 'asset-' + Math.abs(hash).toString(16) + '-' + index;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/px$/i, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function copy(source) {
  const out = {};
  for (const key in source) if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  return out;
}

function proxyAssetUrl(req, url, referer) {
  let out = req.protocol + '://' + req.get('host') + '/asset?url=' + encodeURIComponent(url);
  if (referer) out += '&referer=' + encodeURIComponent(referer);
  return out;
}

function originOf(url) {
  try { return new URL(url).origin; } catch (_error) { return ''; }
}

function safeReferer(referer, assetUrl) {
  const fallback = originOf(assetUrl) + '/';
  if (!referer) return fallback;
  try {
    const parsed = new URL(String(referer));
    return /^https?:$/.test(parsed.protocol) ? parsed.toString() : fallback;
  } catch (_error) {
    return fallback;
  }
}

function browserUserAgent() {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 InspirationImporter/1.0';
}


function formatFromContentType(contentType) {
  const value = String(contentType || '').toLowerCase();
  if (value.includes('svg')) return 'svg';
  if (value.includes('png')) return 'png';
  if (value.includes('webp')) return 'webp';
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  return '';
}

function contentTypeFromUrl(url) {
  const format = detectFormat(url);
  if (format === 'svg') return 'image/svg+xml';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  if (format === 'jpg') return 'image/jpeg';
  return '';
}

app.listen(PORT, () => {
  console.log('Site Asset Importer scraper running at http://localhost:' + PORT);
});
