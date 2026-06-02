(() => {
  const SCRAPER_BACKEND_URL = 'https://inspirationimporter.onrender.com';

  const state = {
    assets: [],
    selectedIds: new Set(),
    favorites: [],
    activeFormat: 'all',
    hideTiny: true,
    hideUnavailable: false,
    showDuplicateSizes: false,
    busy: false,
  };

  const els = {
    urlInput: document.getElementById('urlInput'),
    extractBtn: document.getElementById('extractBtn'),
    status: document.getElementById('status'),
    grid: document.getElementById('imageGrid'),
    count: document.getElementById('resultCount'),
    selectAllBtn: document.getElementById('selectAllBtn'),
    deselectAllBtn: document.getElementById('deselectAllBtn'),
    importBtn: document.getElementById('importBtn'),
    hideTinyToggle: document.getElementById('hideTinyToggle'),
    hideUnavailableToggle: document.getElementById('hideUnavailableToggle'),
    showDuplicatesToggle: document.getElementById('showDuplicatesToggle'),
    favoritesList: document.getElementById('favoritesList'),
    filterButtons: Array.from(document.querySelectorAll('.filter-btn')),
    selfTestBtn: document.getElementById('selfTestBtn'),
  };

  const post = (message) => parent.postMessage({ pluginMessage: message }, '*');

  function setStatus(text, tone = 'default') {
    els.status.textContent = text;
    els.status.className = `status${tone === 'default' ? '' : ` ${tone}`}`;
  }

  function normalizeUrlInput(raw) {
    const value = raw.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return `https://${value}`;
  }

  function isDirectImageUrl(url) {
    return /\.(svg|png|jpe?g|webp)(?:[?#].*)?$/i.test(String(url || ''));
  }

  function backendExtractUrl(url, quality) {
    return SCRAPER_BACKEND_URL.replace(/\/$/, '') + '/extract?url=' + encodeURIComponent(url) + '&quality=' + encodeURIComponent(quality || 'high');
  }

  function backendAssetDataUrl(url, referer) {
    var out = SCRAPER_BACKEND_URL.replace(/\/$/, '') + '/asset-data?url=' + encodeURIComponent(url);
    if (referer) out += '&referer=' + encodeURIComponent(referer);
    return out;
  }

  function friendlyExtractionError(detail, rawUrl) {
    const message = String(detail || '');
    const blockedMatch = message.match(/HTTP[_ ]?(401|402|403|406|407|409|410|418|429|451|503)/i);
    if (blockedMatch) {
      const code = blockedMatch[1];
      const host = getHostname(rawUrl);
      return 'This site blocks extraction. Try another public page or use a direct image URL instead.';
    }
    if (/HTTP[_ ]?404|404/i.test(message)) {
      return 'Page not found. Check the URL and try again.';
    }
    if (/HTTP[_ ]?500|HTTP[_ ]?502|HTTP[_ ]?504|500|502|504/i.test(message)) {
      return 'The website or scraper had a temporary server error. Try again in a moment, or test a different page.';
    }
    if (/Failed to fetch|BACKEND_UNAVAILABLE|NetworkError|TypeError/i.test(message)) {
      return 'Could not reach the hosted scraper. The service may be waking up or temporarily unavailable. Try again in a moment.';
    }
    return 'Extraction could not complete for this page. Try another public URL or paste a direct image link.';
  }

  function getHostname(url) {
    try {
      return String(url || '').replace(/^https?:\/\//i, '').split('/')[0] || 'This website';
    } catch (error) {
      return 'This website';
    }
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    els.extractBtn.disabled = isBusy;
    els.importBtn.disabled = isBusy || state.selectedIds.size === 0;
  }

  function loadFavoritesLocal() {
    try {
      const stored = localStorage.getItem('inspiration-importer:favorites');
      state.favorites = stored ? JSON.parse(stored) : [];
    } catch (error) {
      state.favorites = [];
    }
    renderFavorites();
    // Do not request figma.clientStorage on startup. In some dev/plugin contexts
    // it causes a generic "Something went wrong" status before the user acts.
  }

  function saveFavorites() {
    localStorage.setItem('inspiration-importer:favorites', JSON.stringify(state.favorites));
    // localStorage is enough for the local MVP. Avoid startup/storage bridge errors.
    renderFavorites();
    renderGrid();
  }

  function isFavorite(idOrUrl) {
    return state.favorites.some((asset) => asset.id === idOrUrl || asset.src === idOrUrl);
  }

  function toggleFavorite(asset) {
    const exists = isFavorite(asset.id) || isFavorite(asset.src);
    if (exists) {
      state.favorites = state.favorites.filter((fav) => fav.id !== asset.id && fav.src !== asset.src);
    } else {
      state.favorites.unshift({
        id: asset.id,
        src: asset.src,
        sourceUrl: asset.sourceUrl,
        format: asset.format,
        width: asset.width,
        height: asset.height,
        fileSize: asset.fileSize,
        alt: asset.alt || '',
      });
      state.favorites = state.favorites.slice(0, 50);
    }
    saveFavorites();
  }

  function isTinyAsset(asset) {
    var width = Number(asset.width || 0);
    var height = Number(asset.height || 0);
    if (!width || !height) return false;
    return width <= 24 || height <= 24;
  }

  function baseFilteredAssets() {
    return state.assets.filter(function(asset) {
      var formatMatches = state.activeFormat === 'all' || asset.format === state.activeFormat;
      var sizeMatches = !state.hideTiny || !isTinyAsset(asset);
      var previewMatches = !state.hideUnavailable || !asset.previewFailed;
      return formatMatches && sizeMatches && previewMatches;
    });
  }

  function visibleAssets() {
    var assets = baseFilteredAssets();
    return state.showDuplicateSizes ? assets : bestVersionOnly(assets).assets;
  }

  function assetArea(asset) {
    var width = Number(asset.width || 0);
    var height = Number(asset.height || 0);
    return width > 0 && height > 0 ? width * height : 0;
  }

  function assetUsefulnessScore(asset) {
    var score = 0;
    var area = assetArea(asset);
    var source = String(asset.originalSrc || asset.sourceUrl || asset.remoteSrc || asset.src || '').toLowerCase();
    var alt = String(asset.alt || '').toLowerCase();
    var text = source + ' ' + alt;

    if (asset.previewFailed) score -= 1000;
    if (isTinyAsset(asset)) score -= 600;

    if (asset.format === 'jpg' || asset.format === 'jpeg' || asset.format === 'png' || asset.format === 'webp') score += 300;
    if (asset.format === 'svg') score += 170;

    if (/logo|hero|banner|product|campaign|photo|image|media|card|thumbnail|og:image/.test(text)) score += 180;
    if (/sprite|pixel|tracker|tracking|beacon|spacer|blank|transparent|favicon/.test(text)) score -= 220;

    score += Math.min(900, area / 1200);
    if (asset.fileSize) score += Math.min(250, Number(asset.fileSize) / 12000);
    return score;
  }

  function sortUsefulAssets(a, b) {
    var scoreDiff = assetUsefulnessScore(b) - assetUsefulnessScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return assetArea(b) - assetArea(a);
  }

  function duplicateKey(asset) {
    var raw = String(asset.originalSrc || asset.sourceUrl || asset.remoteSrc || asset.src || '');
    if (!raw || /^data:/i.test(raw)) return asset.id || raw;
    raw = raw.toLowerCase();
    raw = raw.replace(/\\\//g, '/');
    raw = raw.split('#')[0];

    var query = '';
    var questionIndex = raw.indexOf('?');
    if (questionIndex >= 0) {
      query = raw.slice(questionIndex + 1);
      raw = raw.slice(0, questionIndex);
    }

    raw = raw
      .replace(/%2f/g, '/')
      .replace(/%20/g, '-')
      .replace(/\/\d{2,5}px-/g, '/')
      // Amazon / Shopbop image CDN variants often store the same image with
      // quality/size instructions before the extension, such as
      // ._QL80_UX768_AGcontrast_FMwebp_.jpg, ._SX1500_.jpg, or
      // ._AC_SL1500_.jpg. Strip those modifier blocks so only the largest/best
      // version appears by default.
      .replace(/\._[^/]*?(?:ux|uy|sx|sy|sr|sl|ul|us|ss|ql|fm|ac|agcontrast)[^/]*_\.(?=(?:jpg|jpeg|png|webp|gif)$)/g, '.')
      .replace(/\._[^/]*_\.(?=(?:jpg|jpeg|png|webp|gif)$)/g, '.')
      .replace(/([_-])\d{2,5}x\d{2,5}(?=\.(?:jpg|jpeg|png|webp|gif|svg)(?:$|\?))/g, '')
      .replace(/([_-])\d{2,5}w(?=\.(?:jpg|jpeg|png|webp|gif|svg)(?:$|\?))/g, '')
      .replace(/([_-])(?:small|medium|large|grande|compact|thumb|thumbnail|master|original)(?=\.(?:jpg|jpeg|png|webp|gif|svg)(?:$|\?))/g, '')
      .replace(/@\d+x(?=\.(?:jpg|jpeg|png|webp|gif|svg)(?:$|\?))/g, '');

    // Some CDNs use query params for width/height only. Remove those while keeping
    // potentially identity-bearing parameters.
    if (query) {
      var kept = query.split('&').filter(function(part) {
        return !/^(w|width|h|height|q|quality|fit|crop|auto|format|fm|dpr|scale|size|sizes)=/i.test(part);
      });
      if (kept.length) raw += '?' + kept.join('&');
    }

    // For Amazon/Shopbop CDN media, the ID before the modifier block is the
    // image identity. Treat JPG/WEBP variants of the same ID as duplicates too.
    if (/m\.media-amazon\.com|shopbop/i.test(raw)) {
      raw = raw.replace(/\.(?:jpg|jpeg|png|webp|gif)$/i, '');
    }

    return raw;
  }

  function duplicateRank(asset) {
    return assetArea(asset) + Math.min(5000000, Number(asset.fileSize || 0)) + assetUsefulnessScore(asset) * 1000;
  }

  function bestVersionOnly(assets) {
    var bestByKey = {};
    var order = [];
    var duplicatesHidden = 0;

    assets.forEach(function(asset) {
      var key = duplicateKey(asset);
      if (!key) {
        key = asset.id || createId();
      }
      if (!bestByKey[key]) {
        bestByKey[key] = asset;
        order.push(key);
        return;
      }

      duplicatesHidden += 1;
      var current = bestByKey[key];
      if (duplicateRank(asset) > duplicateRank(current)) {
        bestByKey[key] = asset;
      }
    });

    return {
      assets: order.map(function(key) { return bestByKey[key]; }),
      hiddenCount: duplicatesHidden
    };
  }

  function hiddenDuplicateCount() {
    if (state.showDuplicateSizes) return 0;
    return bestVersionOnly(baseFilteredAssets()).hiddenCount;
  }

  function currentAssets() {
    return visibleAssets().slice().sort(sortUsefulAssets);
  }

  function updateResultsSummary(assets) {
    var shown = assets.length;
    var total = state.assets.length;
    var hiddenTiny = state.hideTiny ? state.assets.filter(isTinyAsset).length : 0;
    var hiddenDuplicates = hiddenDuplicateCount();
    var unavailable = state.assets.filter(function(asset) { return !!asset.previewFailed; }).length;
    var ready = Math.max(0, total - unavailable);
    var pieces = [shown + ' shown', total + ' found'];
    if (ready) pieces.push(ready + ' ready');
    if (unavailable) pieces.push(unavailable + ' unavailable');
    if (hiddenDuplicates) pieces.push(hiddenDuplicates + ' duplicate sizes hidden');
    if (hiddenTiny) pieces.push(hiddenTiny + ' tiny hidden');
    els.count.textContent = total ? pieces.join(' · ') : '0 found';
  }

  function formatBytes(bytes) {
    if (!bytes || Number.isNaN(Number(bytes))) return 'File size unavailable';
    const units = ['B', 'KB', 'MB'];
    let size = Number(bytes);
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function dimensionsText(asset) {
    if (asset.width && asset.height) return `${asset.width} × ${asset.height} px`;
    return 'Dimensions unavailable';
  }

  function displayFormat(asset) {
    var format = String(asset.format || 'asset').toUpperCase();
    return format === 'ASSET' ? 'Asset' : format + ' image';
  }

  function sourceLink(asset) {
    return asset.originalSrc || asset.sourceUrl || asset.remoteSrc || asset.src || '';
  }

  function updateImportButton() {
    els.importBtn.disabled = state.busy || state.selectedIds.size === 0;
    els.importBtn.textContent = state.selectedIds.size > 0 ? `Import Selected (${state.selectedIds.size})` : 'Import Selected';
  }

  function updateAssetDimensions(id, img) {
    const asset = state.assets.find((item) => item.id === id);
    if (!asset) return;
    const width = img.naturalWidth || asset.width;
    const height = img.naturalHeight || asset.height;
    if (width && height && (asset.width !== width || asset.height !== height)) {
      asset.width = width;
      asset.height = height;
      const card = document.querySelector(`[data-asset-id="${CSS.escape(id)}"]`);
      if (card) {
        const dims = card.querySelector('.dimensions');
        if (dims) dims.textContent = dimensionsText(asset);
      }
    }
  }

  function renderGrid() {
    const assets = currentAssets();
    updateResultsSummary(assets);

    if (!assets.length) {
      els.grid.innerHTML = '<div class="empty">No assets match the current filters.</div>';
      updateImportButton();
      return;
    }

    const fragment = document.createDocumentFragment();
    assets.forEach((asset) => {
      const card = document.createElement('article');
      card.className = `asset-card${state.selectedIds.has(asset.id) ? ' selected' : ''}${isTinyAsset(asset) ? ' tiny' : ''}`;
      card.dataset.assetId = asset.id;

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'thumb-wrap';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = asset.alt || asset.format || 'Extracted website asset';
      img.referrerPolicy = 'no-referrer';
      img.src = asset.thumbnail || asset.src;
      img.addEventListener('load', () => updateAssetDimensions(asset.id, img));
      img.addEventListener('error', () => {
        asset.previewFailed = true;
        img.remove();
        if (state.hideUnavailable) {
          renderGrid();
          return;
        }
        var fallback = document.createElement('div');
        card.classList.add('preview-failed');
        fallback.className = 'thumb-fallback';
        fallback.innerHTML = '<strong>' + (asset.format || 'asset').toUpperCase() + '</strong><span>Preview unavailable</span>';
        thumbWrap.appendChild(fallback);
        updateResultsSummary(currentAssets());
      });
      thumbWrap.appendChild(img);

      const actions = document.createElement('div');
      actions.className = 'asset-actions';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selectedIds.has(asset.id);
      checkbox.setAttribute('aria-label', `Select ${asset.format.toUpperCase()} image`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selectedIds.add(asset.id);
        else state.selectedIds.delete(asset.id);
        card.classList.toggle('selected', checkbox.checked);
        updateImportButton();
      });

      const fav = document.createElement('button');
      fav.type = 'button';
      fav.className = `favorite-btn${isFavorite(asset.id) || isFavorite(asset.src) ? ' active' : ''}`;
      fav.title = 'Save favorite';
      fav.textContent = isFavorite(asset.id) || isFavorite(asset.src) ? '★' : '☆';
      fav.addEventListener('click', () => toggleFavorite(asset));

      actions.append(checkbox, fav);

      const meta = document.createElement('div');
      meta.className = 'meta';
      var directUrl = sourceLink(asset);
      var directLink = directUrl && /^https?:\/\//i.test(directUrl)
        ? '<span class="source-actions"><a class="source-link" href="' + escapeHtml(directUrl) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(directUrl) + '">Open source</a><button type="button" class="copy-link" data-copy-url="' + escapeHtml(directUrl) + '">Copy URL</button></span>'
        : '<span class="url" title="' + escapeHtml(directUrl || '') + '">' + escapeHtml(directUrl || 'Source unavailable') + '</span>';
      meta.innerHTML = `
        <strong>${displayFormat(asset)}</strong>
        <span class="dimensions">${dimensionsText(asset)}</span>
        <span>${formatBytes(asset.fileSize)}</span>
        ${directLink}
      `;

      var copyButton = meta.querySelector('[data-copy-url]');
      if (copyButton) {
        copyButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          copyToClipboard(copyButton.getAttribute('data-copy-url') || '');
        });
      }

      card.append(thumbWrap, actions, meta);
      fragment.appendChild(card);
    });

    els.grid.replaceChildren(fragment);
    updateImportButton();
  }

  function renderFavorites() {
    if (!state.favorites.length) {
      els.favoritesList.innerHTML = '<div class="empty">No favorites yet.</div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    state.favorites.forEach((asset) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'favorite-item';
      item.title = asset.src;
      item.addEventListener('click', () => {
        const existing = state.assets.find((candidate) => candidate.src === asset.src || candidate.id === asset.id);
        if (existing) state.selectedIds.add(existing.id);
        else {
          var restoredAsset = {};
          for (var key in asset) {
            if (Object.prototype.hasOwnProperty.call(asset, key)) restoredAsset[key] = asset[key];
          }
          restoredAsset.id = asset.id || createId();
          state.assets.unshift(restoredAsset);
        }
        setStatus('Favorite added to the current selection.', 'success');
        renderGrid();
      });
      const img = document.createElement('img');
      img.src = asset.thumbnail || asset.src;
      img.alt = asset.alt || 'Favorite image';
      img.referrerPolicy = 'no-referrer';
      const label = document.createElement('span');
      label.textContent = asset.format ? asset.format.toUpperCase() : 'Asset';
      item.append(img, label);
      fragment.appendChild(item);
    });
    els.favoritesList.replaceChildren(fragment);
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'asset-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function copyToClipboard(text) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        var textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      setStatus('Source URL copied.', 'success');
    } catch (error) {
      setStatus('Could not copy the URL. Use Open source to view it instead.', 'error');
    }
  }

  async function extract() {
    const url = normalizeUrlInput(els.urlInput.value);
    if (!url) {
      setStatus('Paste a public website URL or direct image URL.', 'error');
      return;
    }
    state.assets = [];
    state.selectedIds.clear();
    renderGrid();
    setBusy(true);

    if (isDirectImageUrl(url)) {
      setStatus('Reading direct image URL…', 'busy');
      post({ type: 'extract-url', url, quality: 'high' });
      return;
    }

    setStatus('Extracting website assets…', 'busy');
    try {
      const response = await fetch(backendExtractUrl(url, 'high'), {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-cache'
      });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok) {
        throw new Error(payload.error || ('HTTP_' + response.status));
      }
      state.assets = Array.isArray(payload.assets) ? payload.assets : [];
      state.selectedIds.clear();
      setBusy(false);
      setStatus(state.assets.length ? `Found ${state.assets.length} assets. Best versions are shown first.` : 'No supported images were found on that page.', state.assets.length ? 'success' : 'default');
      renderGrid();
    } catch (error) {
      setBusy(false);
      const detail = error && error.message ? error.message : 'BACKEND_UNAVAILABLE';
      setStatus(friendlyExtractionError(detail, url), 'error');
      renderGrid();
    }
  }

  els.extractBtn.addEventListener('click', extract);
  els.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') extract();
  });

  els.filterButtons.forEach((button) => {
    button.addEventListener('click', () => {
      state.activeFormat = button.dataset.format;
      els.filterButtons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      renderGrid();
    });
  });

  if (els.hideTinyToggle) {
    els.hideTinyToggle.checked = state.hideTiny;
    els.hideTinyToggle.addEventListener('change', function() {
      state.hideTiny = els.hideTinyToggle.checked;
      renderGrid();
      setStatus(state.hideTiny ? 'Tiny tracking pixels and micro-icons are hidden.' : 'Showing all extracted assets, including tiny pixels and micro-icons.');
    });
  }

  if (els.hideUnavailableToggle) {
    els.hideUnavailableToggle.checked = !state.hideUnavailable;
    els.hideUnavailableToggle.addEventListener('change', function() {
      state.hideUnavailable = !els.hideUnavailableToggle.checked;
      renderGrid();
      setStatus(state.hideUnavailable ? 'Unavailable assets are hidden.' : 'Showing unavailable assets with Open source and Copy URL.');
    });
  }

  if (els.showDuplicatesToggle) {
    els.showDuplicatesToggle.checked = state.showDuplicateSizes;
    els.showDuplicatesToggle.addEventListener('change', function() {
      state.showDuplicateSizes = els.showDuplicatesToggle.checked;
      renderGrid();
      setStatus(state.showDuplicateSizes ? 'Showing duplicate responsive sizes.' : 'Showing best available version for duplicate image sizes.');
    });
  }

  els.selectAllBtn.addEventListener('click', () => {
    currentAssets().forEach((asset) => state.selectedIds.add(asset.id));
    setStatus(`Selected ${currentAssets().length} visible asset${currentAssets().length === 1 ? '' : 's'}.`, 'success');
    renderGrid();
  });

  els.deselectAllBtn.addEventListener('click', () => {
    state.selectedIds.clear();
    setStatus('Selection cleared.');
    renderGrid();
  });


  if (els.selfTestBtn) {
    els.selfTestBtn.addEventListener('click', function() {
      state.assets = [
        {
          id: 'self-test-svg-logo',
          src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" rx="24" fill="#18a0fb"/><circle cx="88" cy="80" r="42" fill="white" opacity=".92"/><path d="M152 58h112v18H152V58zm0 32h86v18h-86V90z" fill="white"/></svg>'),
          inlineSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" rx="24" fill="#18a0fb"/><circle cx="88" cy="80" r="42" fill="white" opacity=".92"/><path d="M152 58h112v18H152V58zm0 32h86v18h-86V90z" fill="white"/></svg>',
          sourceUrl: 'Self Test SVG',
          alt: 'Self test SVG',
          width: 320,
          height: 160,
          format: 'svg',
          fileSize: 250
        }
      ];
      state.selectedIds.clear();
      setStatus('Self Test loaded one built-in SVG asset.', 'success');
      renderGrid();
    });
  }

  async function prepareAssetForImport(asset) {
    var prepared = {};
    for (var key in asset) {
      if (Object.prototype.hasOwnProperty.call(asset, key)) prepared[key] = asset[key];
    }

    if (asset.inlineSvg || /^data:image\/svg/i.test(asset.src || '')) {
      return prepared;
    }

    var sourceForBackend = asset.remoteSrc || asset.originalSrc || asset.sourceUrl || asset.src;

    try {
      // Preferred path for website assets: ask the local backend to fetch bytes server-side
      // and return a data URL. This avoids browser-side CORS/hotlink blocks during import.
      if (sourceForBackend && /^https?:\/\//i.test(sourceForBackend) && !/^https?:\/\/localhost:/i.test(sourceForBackend)) {
        var proxyResponse = await fetch(backendAssetDataUrl(sourceForBackend, asset.pageUrl), {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-cache'
        });
        var payload = await proxyResponse.json().catch(function() { return {}; });
        if (!proxyResponse.ok || !payload.dataUrl) throw new Error(payload.error || ('PROXY_HTTP_' + proxyResponse.status));

        if ((payload.format === 'svg') || /svg/i.test(payload.contentType || '') || /^data:image\/svg/i.test(payload.dataUrl || '')) {
          prepared.inlineSvg = dataUrlToText(payload.dataUrl);
          prepared.fileSize = payload.fileSize || prepared.inlineSvg.length;
          prepared.format = 'svg';
          return prepared;
        }

        var proxiedBlob = dataUrlToBlob(payload.dataUrl);
        var proxiedRaster = await rasterBlobToSafeDataUrl(proxiedBlob, asset, 'high');
        prepared.src = proxiedRaster.dataUrl;
        prepared.remoteSrc = sourceForBackend;
        prepared.fileSize = proxiedRaster.fileSize || payload.fileSize || asset.fileSize || null;
        prepared.width = proxiedRaster.width || asset.width || null;
        prepared.height = proxiedRaster.height || asset.height || null;
        prepared.wasResized = proxiedRaster.wasResized;
        prepared.format = proxiedRaster.format || payload.format || asset.format || 'jpg';
        return prepared;
      }

      // Fallback path for direct image URLs and self-hosted/proxied assets.
      var response = await fetch(asset.src, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-cache' });
      if (!response.ok) throw new Error('HTTP_' + response.status);
      var contentType = response.headers.get('content-type') || '';

      if ((asset.format === 'svg') || /svg/i.test(contentType) || /\.svg(?:[?#]|$)/i.test(asset.src)) {
        var svgText = await response.text();
        prepared.inlineSvg = svgText;
        prepared.fileSize = svgText.length;
        return prepared;
      }

      var blob = await response.blob();
      var raster = await rasterBlobToSafeDataUrl(blob, asset, 'high');
      prepared.src = raster.dataUrl;
      prepared.remoteSrc = asset.src;
      prepared.fileSize = raster.fileSize || blob.size || asset.fileSize || null;
      prepared.width = raster.width || asset.width || null;
      prepared.height = raster.height || asset.height || null;
      prepared.wasResized = raster.wasResized;
      prepared.format = raster.format || asset.format || 'jpg';
      return prepared;
    } catch (error) {
      prepared.importError = error && error.message ? error.message : 'FETCH_FAILED';
      return prepared;
    }
  }

  function maxRasterSideForQuality(quality) {
    if (quality === 'high') return 2048;
    if (quality === 'low') return 900;
    return 1400;
  }

  function jpegQualityForSetting(quality) {
    if (quality === 'high') return 0.92;
    if (quality === 'low') return 0.68;
    return 0.82;
  }

  function rasterBlobToSafeDataUrl(blob, asset, quality) {
    return new Promise(function(resolve, reject) {
      var objectUrl = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function() {
        try {
          var sourceWidth = img.naturalWidth || asset.width || 1;
          var sourceHeight = img.naturalHeight || asset.height || 1;
          var maxSide = maxRasterSideForQuality(quality);
          var scale = Math.min(maxSide / sourceWidth, maxSide / sourceHeight, 1);
          var targetWidth = Math.max(1, Math.round(sourceWidth * scale));
          var targetHeight = Math.max(1, Math.round(sourceHeight * scale));

          var canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          var ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('CANVAS_UNAVAILABLE');
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

          var shouldKeepPng = (asset.format === 'png') || /png/i.test(blob.type || '');
          var mimeType = shouldKeepPng ? 'image/png' : 'image/jpeg';
          var dataUrl = shouldKeepPng
            ? canvas.toDataURL(mimeType)
            : canvas.toDataURL(mimeType, jpegQualityForSetting(quality));

          URL.revokeObjectURL(objectUrl);
          resolve({
            dataUrl: dataUrl,
            width: targetWidth,
            height: targetHeight,
            fileSize: estimateDataUrlBytes(dataUrl),
            wasResized: scale < 1,
            format: shouldKeepPng ? 'png' : 'jpg',
          });
        } catch (error) {
          URL.revokeObjectURL(objectUrl);
          reject(error);
        }
      };
      img.onerror = function() {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('IMAGE_DECODE_FAILED'));
      };
      img.src = objectUrl;
    });
  }

  function dataUrlToBlob(dataUrl) {
    var parts = String(dataUrl || '').split(',');
    if (parts.length < 2) throw new Error('BAD_DATA_URL');
    var header = parts[0];
    var base64 = parts.slice(1).join(',');
    var mimeMatch = header.match(/^data:([^;]+);base64$/i);
    var mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function dataUrlToText(dataUrl) {
    var text = String(dataUrl || '');
    var comma = text.indexOf(',');
    if (comma < 0) return text;
    var header = text.slice(0, comma);
    var payload = text.slice(comma + 1);
    if (/;base64/i.test(header)) return atob(payload);
    return decodeURIComponent(payload);
  }

  function estimateDataUrlBytes(dataUrl) {
    var comma = String(dataUrl).indexOf(',');
    var payload = comma >= 0 ? String(dataUrl).slice(comma + 1) : String(dataUrl);
    return Math.round(payload.length * 0.75);
  }

  function blobToDataUrl(blob) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function() { resolve(String(reader.result || '')); };
      reader.onerror = function() { reject(new Error('BLOB_READ_FAILED')); };
      reader.readAsDataURL(blob);
    });
  }

  els.importBtn.addEventListener('click', async () => {
    const selected = state.assets.filter((asset) => state.selectedIds.has(asset.id));
    if (!selected.length) {
      setStatus('Choose at least one image to import.', 'error');
      return;
    }
    setBusy(true);
    setStatus(`Preparing ${selected.length} selected asset${selected.length === 1 ? '' : 's'} for import…`, 'busy');

    var prepared = [];
    for (var i = 0; i < selected.length; i += 1) {
      setStatus(`Preparing asset ${i + 1} of ${selected.length}…`, 'busy');
      prepared.push(await prepareAssetForImport(selected[i]));
    }

    var blocked = prepared.filter(function(asset) { return asset.importError; }).length;
    if (blocked === prepared.length) {
      setBusy(false);
      setStatus('Images were found, but none of the selected assets could be imported. The backend could not fetch their bytes, or the image host blocked/protected those files.', 'error');
      return;
    }

    setStatus(`Importing ${prepared.length - blocked} prepared asset${prepared.length - blocked === 1 ? '' : 's'}…`, 'busy');
    post({ type: 'import-selected', assets: prepared.filter(function(asset) { return !asset.importError; }), quality: 'high' });
  });

  window.onmessage = (event) => {
    const message = event.data.pluginMessage;
    if (!message) return;

    if (message.type === 'extraction-success') {
      setBusy(false);
      state.assets = message.assets || [];
      state.selectedIds.clear();
      setStatus(state.assets.length ? `Found ${state.assets.length} assets. Best versions are shown first.` : 'No supported images were found on that page.', state.assets.length ? 'success' : 'default');
      renderGrid();
      return;
    }

    if (message.type === 'extraction-error') {
      setBusy(false);
      setStatus(message.message || 'Unable to extract images from this URL.', 'error');
      renderGrid();
      return;
    }

    if (message.type === 'import-success') {
      setBusy(false);
      setStatus(`Imported ${message.imported} asset${message.imported === 1 ? '' : 's'} to the Figma canvas.`, 'success');
      return;
    }

    if (message.type === 'import-error') {
      setBusy(false);
      setStatus(message.message || 'Import failed.', 'error');
      return;
    }

    if (message.type === 'favorites-loaded') {
      if (Array.isArray(message.favorites) && message.favorites.length) {
        state.favorites = message.favorites;
        localStorage.setItem('inspiration-importer:favorites', JSON.stringify(state.favorites));
        renderFavorites();
        renderGrid();
      }
    }
  };

  loadFavoritesLocal();
})();
