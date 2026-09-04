figma.showUI(__html__, { width: 420, height: 720, themeColors: true });

const GRID_GAP = 32;
const MAX_CANVAS_SIDE = 2048;

figma.ui.onmessage = async (message) => {
  try {
    if (message.type === 'extract-url') {
      const asset = createDirectImageAsset(message.url);
      figma.ui.postMessage({ type: 'extraction-success', assets: [asset] });
      return;
    }

    if (message.type === 'import-selected') {
      const imported = await importAssets(message.assets || []);
      figma.ui.postMessage({ type: 'import-success', imported });
      figma.notify(`Imported ${imported} asset${imported === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    const payloadType = message && message.type === 'import-selected' ? 'import-error' : 'extraction-error';
    figma.ui.postMessage({ type: payloadType, message: humanizeError(error) });
  }
};

function createDirectImageAsset(inputUrl) {
  const url = normalizeUserUrl(inputUrl);
  if (!isSupportedImageUrl(url)) throw new Error('NOT_IMAGE_URL');

  return {
    id: stableAssetId(url),
    src: url,
    sourceUrl: url,
    originalSrc: url,
    alt: 'Direct image URL',
    width: null,
    height: null,
    fileSize: null,
    format: detectFormat(url),
  };
}

function normalizeUserUrl(input) {
  let value = String(input || '').trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (!value) throw new Error('INVALID_URL');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  if (!/^https?:\/\/[^\s]+$/i.test(value)) throw new Error('INVALID_URL');
  return value;
}

function isSupportedImageUrl(src) {
  const clean = String(src || '').toLowerCase().split('?')[0].split('#')[0];
  return /\.(svg|png|jpe?g|webp|avif)$/i.test(clean);
}

function detectFormat(src) {
  const clean = String(src || '').toLowerCase().split('?')[0].split('#')[0];
  if (clean.endsWith('.svg')) return 'svg';
  if (clean.endsWith('.png')) return 'png';
  if (clean.endsWith('.webp')) return 'webp';
  if (clean.endsWith('.avif')) return 'avif';
  return 'jpg';
}

function stableAssetId(src) {
  let hash = 0;
  for (let i = 0; i < src.length; i += 1) {
    hash = ((hash << 5) - hash + src.charCodeAt(i)) | 0;
  }
  return `asset-${Math.abs(hash)}`;
}

async function importAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0) throw new Error('NO_SELECTION');

  const frame = figma.createFrame();
  frame.name = frameNameForAssets(assets);
  frame.x = figma.viewport.center.x;
  frame.y = figma.viewport.center.y;
  frame.layoutMode = 'NONE';
  frame.fills = [];
  frame.resize(1, 1);
  figma.currentPage.appendChild(frame);

  const failures = [];
  let imported = 0;
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let contentWidth = 0;

  for (const asset of assets) {
    try {
      const node = await createNodeForAsset(asset);
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
      failures.push(error && error.message ? error.message : String(error));
      console.warn('Inspiration Importer asset failed:', asset && (asset.remoteSrc || asset.src), error);
    }
  }

  if (!imported) {
    frame.remove();
    const detail = failures.length ? `: ${failures.slice(0, 3).join(', ')}` : '';
    throw new Error(`ALL_IMPORTS_FAILED${detail}`);
  }

  frame.resize(
    Math.max(1, Math.ceil(contentWidth)),
    Math.max(1, Math.ceil(cursorY + rowHeight)),
  );

  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
  return imported;
}

async function createNodeForAsset(asset) {
  if (asset.inlineSvg) return createSvgNode(optimizeSvg(asset.inlineSvg), asset);

  if (asset.format === 'svg' || /^data:image\/svg/i.test(asset.src || '')) {
    const svg = await fetchSvgText(asset.src);
    return createSvgNode(optimizeSvg(svg), asset);
  }

  const bytes = await fetchImageBytes(asset.src);
  const image = figma.createImage(bytes);
  const rect = figma.createRectangle();
  rect.name = safeNodeName(asset.alt || filenameFromAsset(asset) || 'Imported image');

  const display = getDisplaySize(asset.width, asset.height);
  rect.resize(display.width, display.height);
  rect.fills = [{ type: 'IMAGE', scaleMode: 'FIT', imageHash: image.hash }];
  return rect;
}

function createSvgNode(svgText, asset) {
  if (!svgText) throw new Error('BROKEN_IMAGE');
  const node = figma.createNodeFromSvg(svgText);
  node.name = safeNodeName(asset.alt || filenameFromAsset(asset) || 'Imported SVG');

  const display = getDisplaySize(asset.width || node.width, asset.height || node.height);
  if (node.resize && display.width && display.height) node.resize(display.width, display.height);
  return node;
}

async function fetchSvgText(src) {
  if (/^data:image\/svg/i.test(src || '')) return decodeDataUri(src);

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
  if (/^data:image\//i.test(src || '')) return dataUriToBytes(src);

  let response;
  try {
    response = await fetch(src, { method: 'GET', redirect: 'follow' });
  } catch (error) {
    throw new Error('NETWORK_OR_CORS');
  }

  if (!response.ok) throw new Error(response.status === 404 ? 'BROKEN_IMAGE' : `HTTP_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function getDisplaySize(width, height) {
  const sourceWidth = numericOrNull(width) || 180;
  const sourceHeight = numericOrNull(height) || 140;
  const scale = Math.min(MAX_CANVAS_SIDE / sourceWidth, MAX_CANVAS_SIDE / sourceHeight, 1);
  return {
    width: Math.max(24, Math.round(sourceWidth * scale)),
    height: Math.max(24, Math.round(sourceHeight * scale)),
  };
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = parseInt(String(value).replace(/px$/, ''), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
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

function decodeDataUri(uri) {
  const match = String(uri || '').match(/^data:([^,]*),(.*)$/i) || [];
  const meta = match[1] || '';
  const data = match[2] || '';
  if (!data) return '';
  if (/;base64/i.test(meta)) return base64Decode(data);
  return decodeURIComponent(data);
}

function dataUriToBytes(uri) {
  const match = String(uri || '').match(/^data:([^,]*),(.*)$/i) || [];
  const meta = match[1] || '';
  const data = match[2] || '';
  if (!data) throw new Error('BROKEN_IMAGE');

  const binary = /;base64/i.test(meta) ? base64Decode(data) : decodeURIComponent(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Decode(value) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const str = String(value).replace(/=+$/, '');
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
  const first = assets.find((asset) => asset && (asset.pageUrl || asset.sourceUrl || asset.originalSrc || asset.remoteSrc || asset.src));
  const source = first ? (first.pageUrl || first.sourceUrl || first.originalSrc || first.remoteSrc || first.src) : '';
  const domain = domainFromUrl(source);
  return domain ? `Inspiration Importer - ${domain}` : 'Inspiration Importer';
}

function domainFromUrl(value) {
  const match = String(value || '').match(/^https?:\/\/([^/]+)/i);
  return match && match[1] ? match[1].replace(/^www\./i, '') : '';
}

function filenameFromAsset(asset) {
  const source = (asset && (asset.originalSrc || asset.sourceUrl || asset.remoteSrc || asset.src)) || '';
  try {
    const clean = String(source).split('?')[0].split('#')[0];
    return decodeURIComponent(clean.split('/').filter(Boolean).pop() || '').slice(0, 80);
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
  if (code === 'NOT_IMAGE_URL') return 'That direct URL is not a supported SVG, PNG, JPG, JPEG, WEBP, or AVIF image.';
  if (code === 'NETWORK_OR_CORS') return 'Could not access that image. It may block plugin requests or require authentication.';
  if (code === 'NO_SELECTION') return 'Select at least one image before importing.';
  if (code.indexOf('ALL_IMPORTS_FAILED') === 0) return `Images were found, but none could be imported. ${code.replace('ALL_IMPORTS_FAILED:', '').trim()}`.trim();
  if (code === 'BROKEN_IMAGE') return 'One or more selected images could not be loaded.';
  if (/^HTTP_/.test(code)) return `The server returned ${code.replace('HTTP_', 'HTTP ')}.`;
  return 'Something went wrong while processing this request.';
}
