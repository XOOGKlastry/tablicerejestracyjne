/* ============================================================
   NAUKA — Interactive Poland map for learning plate codes.

   Loads powiat boundaries (GeoJSON) and renders one SVG path
   per powiat, color-coded by voivodeship. Hovering reveals the
   plate code in a floating tooltip; clicking pins the selection
   and shows a big plate card at the bottom.
   ============================================================ */
'use strict';

(function () {
  const GEOJSON_URL =
    'https://cdn.jsdelivr.net/gh/waszkiewiczja/GeoJSON-Polska-Wojewodztwa-Powiaty-Gminy@main/powiaty.json';
  const WOJ_URL =
    'https://cdn.jsdelivr.net/gh/waszkiewiczja/GeoJSON-Polska-Wojewodztwa-Powiaty-Gminy@main/wojewodztwa.json';

  const VIEW_W = 1000;
  const VIEW_H = 920;
  let bbox = { minLat: 49.0, maxLat: 54.85, minLng: 14.1, maxLng: 24.15 };

  // Stable hue per voivodeship — same saturation/lightness so they harmonize.
  const WOJ_HUE = {
    'dolnośląskie': 158,
    'kujawsko-pomorskie': 282,
    'lubelskie': 28,
    'lubuskie': 92,
    'łódzkie': 340,
    'małopolskie': 210,
    'mazowieckie': 8,
    'opolskie': 188,
    'podkarpackie': 50,
    'podlaskie': 258,
    'pomorskie': 170,
    'śląskie': 12,
    'świętokrzyskie': 232,
    'warmińsko-mazurskie': 70,
    'wielkopolskie': 318,
    'zachodniopomorskie': 128,
  };

  function nrm(s) {
    return (s || '').toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/ł/g, 'l').replace(/Ł/g, 'l')
      .replace(/^powiat\s+/, '')
      .replace(/^m\.\s*/, '')
      .replace(/\s*\([^)]*\)\s*/g, '')
      .replace(/[^a-z0-9 -]/g, '')
      .trim();
  }

  function project(lat, lng) {
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const lngScale = Math.cos((midLat * Math.PI) / 180);
    const xRange = (bbox.maxLng - bbox.minLng) * lngScale;
    const yRange = bbox.maxLat - bbox.minLat;
    const padding = 20;
    const w = VIEW_W - 2 * padding;
    const h = VIEW_H - 2 * padding;
    const scale = Math.min(w / xRange, h / yRange);
    const offX = padding + (w - xRange * scale) / 2;
    const offY = padding + (h - yRange * scale) / 2;
    return {
      x: offX + (lng - bbox.minLng) * lngScale * scale,
      y: offY + (bbox.maxLat - lat) * scale,
    };
  }

  function ringPath(ring) {
    let d = '';
    for (let i = 0; i < ring.length; i++) {
      const [lng, lat] = ring[i];
      const { x, y } = project(lat, lng);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
    }
    return d + 'Z';
  }
  function featurePath(f) {
    const g = f.geometry;
    if (!g) return '';
    if (g.type === 'Polygon') return g.coordinates.map(ringPath).join(' ');
    if (g.type === 'MultiPolygon') {
      let out = '';
      for (const poly of g.coordinates)
        for (const ring of poly) out += ringPath(ring) + ' ';
      return out;
    }
    return '';
  }
  function computeFeatureCentroid(f) {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      for (const ring of poly) {
        for (const [lng, lat] of ring) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
        }
      }
    }
    return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
  }
  function computeBBoxAll(features) {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const f of features) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys)
        for (const ring of poly)
          for (const [lng, lat] of ring) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
          }
    }
    return { minLat, maxLat, minLng, maxLng };
  }

  /* Match every powiat-feature to a POWIATY entry.
     Strategy: name match dominates, then nearest centroid. */
  function matchFeatures(features) {
    const POWIATY = window.POWIATY || [];
    // Build (kod → entry) for assignment tracking + name index.
    const byName = new Map();
    for (const p of POWIATY) {
      const key = nrm(p.nazwa);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(p);
    }
    const used = new Set();
    const matched = [];
    // Pass 1: features with unique exact-name candidate
    for (const f of features) {
      const fname = nrm(f.properties.JPT_NAZWA_ || f.properties.nazwa || f.properties.name || '');
      const c = computeFeatureCentroid(f);
      const candList = byName.get(fname) || [];
      let pick = null;
      if (candList.length === 1) pick = candList[0];
      else if (candList.length > 1) {
        // pick closest by centroid among same-name candidates
        let best = null, bd = Infinity;
        for (const cand of candList) {
          if (used.has(cand.kod)) continue;
          const d = (cand.lat - c.lat) ** 2 + (cand.lng - c.lng) ** 2;
          if (d < bd) { bd = d; best = cand; }
        }
        pick = best;
      }
      matched.push({ feature: f, centroid: c, pick });
      if (pick) used.add(pick.kod);
    }
    // Pass 2: unmatched features → nearest still-unused by centroid
    for (const m of matched) {
      if (m.pick) continue;
      let best = null, bd = Infinity;
      for (const p of POWIATY) {
        if (used.has(p.kod)) continue;
        const d = (p.lat - m.centroid.lat) ** 2 + (p.lng - m.centroid.lng) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      if (best) { m.pick = best; used.add(best.kod); }
    }
    return matched.filter(m => m.pick);
  }

  const FULL_VB = [0, 0, VIEW_W, VIEW_H];
  let _state = {
    loaded: false,
    selected: null,       // POWIATY entry
    hover: null,
    mounted: false,
    wojOutlineHtml: '',
    powiatPaths: [],      // { kod, d, woj, centroid, p }
    seenCodes: new Set(),
    currentWoj: null,     // string or null (filter / zoom focus)
    viewBox: FULL_VB.slice(),
    animToken: 0,
  };

  async function ensureLoaded() {
    if (_state.loaded) return;
    const [wojRes, powRes] = await Promise.all([
      fetch(WOJ_URL).then(r => r.json()),
      fetch(GEOJSON_URL).then(r => r.json()),
    ]);
    const allFeatures = [...(wojRes.features || []), ...(powRes.features || [])];
    bbox = computeBBoxAll(allFeatures);

    // Voivodeship outlines (drawn on top, transparent fill)
    const wojParts = [];
    for (const f of (wojRes.features || [])) {
      const d = featurePath(f);
      if (!d) continue;
      const name = (f.properties && (f.properties.JPT_NAZWA_ || f.properties.nazwa || f.properties.name)) || '';
      const key = (name || '').toLowerCase().trim();
      wojParts.push(`<path class="nm-woj-outline" data-woj="${key}" d="${d}"></path>`);
    }
    _state.wojOutlineHtml = wojParts.join('');

    const matched = matchFeatures(powRes.features || []);
    _state.powiatPaths = matched.map(m => ({
      kod: m.pick.kod,
      nazwa: m.pick.nazwa,
      typ: m.pick.typ,
      woj: m.pick.woj,
      d: featurePath(m.feature),
      centroid: m.centroid,
      p: m.pick,
    }));
    _state.seenCodes = new Set(_state.powiatPaths.map(x => x.kod));
    _state.loaded = true;
  }

  function renderMap() {
    const svg = document.getElementById('naukaMapSvg');
    if (!svg) return;
    let parts = '';
    for (const p of _state.powiatPaths) {
      const hue = WOJ_HUE[p.woj] ?? 200;
      // Two-letter codes = miasto-style emphasis, slightly different fill.
      const isMiasto = p.typ === 'miasto';
      const fillL = isMiasto ? 38 : 27;
      const fill = `hsl(${hue} 26% ${fillL}%)`;
      parts += `<path class="nm-pow" data-kod="${p.kod}"
        fill="${fill}" d="${p.d}"></path>`;
    }
    svg.innerHTML = parts + _state.wojOutlineHtml;
    setViewBox(FULL_VB, false);
    buildWojChips();
    wireMap();
    wireZoomControls();
    wireSearch();
    refreshBackButton();
  }

  /* ───────── SEARCH ───────── */
  let _searchHl = -1;
  let _searchResults = [];

  function searchPowiaty(query, limit = 8) {
    const q = nrm(query);
    if (!q) return [];
    const out = [];
    for (const p of (window.POWIATY || [])) {
      const nn = nrm(p.nazwa);
      const kk = (p.kod || '').toLowerCase();
      let score = -1;
      // exact kod match → top
      if (kk === q) score = 0;
      else if (kk.startsWith(q)) score = 1;
      else if (nn.startsWith(q)) score = 2;
      else if (nn.includes(q)) score = 3;
      else if (kk.includes(q)) score = 4;
      if (score >= 0) out.push({ p, score });
    }
    out.sort((a, b) => a.score - b.score || a.p.nazwa.localeCompare(b.p.nazwa, 'pl'));
    return out.slice(0, limit).map(x => x.p);
  }

  function renderSearchResults(query) {
    const results = document.getElementById('naukaSearchResults');
    const wrap = document.querySelector('.nm-search');
    if (!results || !wrap) return;
    wrap.classList.toggle('has-value', !!query);
    if (!query) {
      results.classList.remove('open');
      results.innerHTML = '';
      _searchResults = [];
      _searchHl = -1;
      return;
    }
    _searchResults = searchPowiaty(query, 8);
    if (_searchResults.length === 0) {
      results.innerHTML = `<div class="nm-search-empty">Nic nie znaleziono dla „${escapeHtml(query)}”</div>`;
      results.classList.add('open');
      _searchHl = -1;
      return;
    }
    const nq = nrm(query);
    const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';
    results.innerHTML = _searchResults.map((p, i) => {
      const nn = p.nazwa.replace(/\s*\([^)]*\)/g, '');
      // Bold matching portion in name
      const idx = nrm(nn).indexOf(nq);
      let nameHtml = escapeHtml(nn);
      if (idx >= 0 && nq.length > 0) {
        const end = idx + nq.length;
        nameHtml = escapeHtml(nn.slice(0, idx)) +
          '<b>' + escapeHtml(nn.slice(idx, end)) + '</b>' +
          escapeHtml(nn.slice(end));
      }
      const typLabel = p.typ === 'miasto' ? 'miasto na pr. powiatu' : 'powiat ziemski';
      const cls = i === _searchHl ? ' hl' : '';
      return `<button type="button" class="nm-search-result${cls}" data-kod="${p.kod}" data-idx="${i}">
        <div class="nm-sr-plate"><div class="eu"></div><div class="kod">${escapeHtml(p.kod)}</div></div>
        <div class="nm-sr-info">
          <div class="nm-sr-name">${nameHtml}</div>
          <div class="nm-sr-meta">${typLabel} · woj. ${escapeHtml(p.woj)}</div>
        </div>
        <span class="nm-sr-arrow">${arrow}</span>
      </button>`;
    }).join('');
    results.classList.add('open');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function pickSearchResult(idx) {
    if (idx < 0 || idx >= _searchResults.length) return;
    const p = _searchResults[idx];
    closeSearch();
    focusPowiat(p.kod);
  }

  function closeSearch() {
    const inp = document.getElementById('naukaSearch');
    const results = document.getElementById('naukaSearchResults');
    const wrap = document.querySelector('.nm-search');
    if (inp) inp.value = '';
    if (wrap) wrap.classList.remove('has-value');
    if (results) { results.classList.remove('open'); results.innerHTML = ''; }
    _searchResults = [];
    _searchHl = -1;
  }

  function focusPowiat(kod) {
    const entry = _state.powiatPaths.find(p => p.kod === kod);
    if (!entry) return;
    // Clear voivodeship dim filter so the result is fully visible
    _state.currentWoj = null;
    document.querySelectorAll('#naukaWojStrip .nm-chip').forEach(b => {
      b.classList.toggle('active', b.dataset.woj === '');
    });
    document.querySelectorAll('#naukaMapSvg .nm-pow.dim').forEach(el => el.classList.remove('dim'));

    // Zoom to the powiat's path bbox with generous padding (≈ 6x its size for context)
    const svg = document.getElementById('naukaMapSvg');
    const node = svg && svg.querySelector(`.nm-pow[data-kod="${kod}"]`);
    if (node) {
      try {
        const b = node.getBBox();
        const size = Math.max(b.width, b.height);
        const pad = Math.max(size * 2.5, 60);
        const minX = b.x - pad;
        const minY = b.y - pad;
        const maxX = b.x + b.width + pad;
        const maxY = b.y + b.height + pad;
        const w = maxX - minX, h = maxY - minY;
        const targetRatio = VIEW_W / VIEW_H;
        let nx = minX, ny = minY, nw = w, nh = h;
        if (nw / nh > targetRatio) {
          const newH = nw / targetRatio;
          ny -= (newH - nh) / 2;
          nh = newH;
        } else {
          const newW = nh * targetRatio;
          nx -= (newW - nw) / 2;
          nw = newW;
        }
        // Clamp to FULL_VB bounds (don't pan out of map)
        const clampW = Math.min(nw, VIEW_W);
        const clampH = Math.min(nh, VIEW_H);
        const cx = Math.max(clampW / 2, Math.min(VIEW_W - clampW / 2, nx + nw / 2));
        const cy = Math.max(clampH / 2, Math.min(VIEW_H - clampH / 2, ny + nh / 2));
        setViewBox([cx - clampW / 2, cy - clampH / 2, clampW, clampH], true);
      } catch (e) {}
    }
    selectPowiat(kod);
  }

  function wireSearch() {
    const inp = document.getElementById('naukaSearch');
    const results = document.getElementById('naukaSearchResults');
    const clearBtn = document.getElementById('btnNaukaSearchClear');
    if (!inp || !results) return;
    if (inp._wired) return;
    inp._wired = 1;

    inp.addEventListener('input', e => {
      _searchHl = -1;
      renderSearchResults(e.target.value.trim());
    });
    inp.addEventListener('focus', e => {
      if (e.target.value.trim()) renderSearchResults(e.target.value.trim());
    });
    inp.addEventListener('keydown', e => {
      const open = results.classList.contains('open');
      if (e.key === 'Enter') {
        e.preventDefault();
        if (open && _searchResults.length > 0) {
          pickSearchResult(_searchHl >= 0 ? _searchHl : 0);
        }
      } else if (e.key === 'ArrowDown' && open) {
        e.preventDefault();
        _searchHl = Math.min(_searchHl + 1, _searchResults.length - 1);
        renderSearchResults(inp.value.trim());
      } else if (e.key === 'ArrowUp' && open) {
        e.preventDefault();
        _searchHl = Math.max(_searchHl - 1, 0);
        renderSearchResults(inp.value.trim());
      } else if (e.key === 'Escape') {
        closeSearch();
        inp.blur();
      }
    });
    results.addEventListener('click', e => {
      const b = e.target.closest('.nm-search-result');
      if (!b) return;
      pickSearchResult(parseInt(b.dataset.idx, 10));
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        closeSearch();
        inp.focus();
      });
    }
    // Close dropdown when clicking outside the search area
    document.addEventListener('click', e => {
      if (!e.target.closest('.nm-search-wrap')) {
        results.classList.remove('open');
      }
    });
  }

  /* ───────── VOIVODESHIP CHIPS ───────── */
  function buildWojChips() {
    const strip = document.getElementById('naukaWojStrip');
    if (!strip) return;
    const wojs = [...new Set(_state.powiatPaths.map(p => p.woj))]
      .sort((a, b) => a.localeCompare(b, 'pl'));
    let html = `<button class="nm-chip active" data-woj="" type="button">Wszystkie</button>`;
    for (const w of wojs) {
      const hue = WOJ_HUE[w] ?? 200;
      html += `<button class="nm-chip" data-woj="${w}" type="button"
        style="--chip-hue:${hue}"><span class="nm-chip-dot"></span>${w}</button>`;
    }
    strip.innerHTML = html;
    strip.querySelectorAll('.nm-chip').forEach(b => {
      b.addEventListener('click', () => selectWoj(b.dataset.woj || null));
    });
  }

  function selectWoj(wojName) {
    _state.currentWoj = wojName || null;
    document.querySelectorAll('#naukaWojStrip .nm-chip').forEach(b => {
      b.classList.toggle('active', (b.dataset.woj || '') === (wojName || ''));
    });
    // Scroll active chip into view
    const active = document.querySelector('#naukaWojStrip .nm-chip.active');
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
    // Dim non-matching powiats
    document.querySelectorAll('#naukaMapSvg .nm-pow').forEach(el => {
      const k = el.dataset.kod;
      const entry = _state.powiatPaths.find(p => p.kod === k);
      el.classList.toggle('dim', !!wojName && entry && entry.woj !== wojName);
    });
    // Zoom
    const target = wojName ? computeWojBBox(wojName, 18) : FULL_VB.slice();
    setViewBox(target, true);
    selectPowiat(null);
    refreshBackButton();
  }

  function computeWojBBox(woj, pad) {
    const svg = document.getElementById('naukaMapSvg');
    if (!svg) return FULL_VB.slice();
    // PREFER: voivodeship outline path's own bbox — it's independent of
    // powiat→POWIATY matching, so outliers in that matching can't skew it.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const key = (woj || '').toLowerCase().trim();
    const outline = svg.querySelector(`.nm-woj-outline[data-woj="${key}"]`);
    if (outline) {
      try {
        const b = outline.getBBox();
        if (b && isFinite(b.x) && b.width > 0 && b.height > 0) {
          minX = b.x; minY = b.y;
          maxX = b.x + b.width; maxY = b.y + b.height;
        }
      } catch (e) {}
    }
    // Fallback: aggregate powiat path bboxes (legacy path; only runs if outline missing)
    if (!isFinite(minX)) {
      svg.querySelectorAll('.nm-pow').forEach(el => {
        const k = el.dataset.kod;
        const entry = _state.powiatPaths.find(p => p.kod === k);
        if (!entry || entry.woj !== woj) return;
        try {
          const b = el.getBBox();
          if (b.x < minX) minX = b.x;
          if (b.y < minY) minY = b.y;
          if (b.x + b.width > maxX) maxX = b.x + b.width;
          if (b.y + b.height > maxY) maxY = b.y + b.height;
        } catch (e) {}
      });
    }
    if (!isFinite(minX)) return FULL_VB.slice();
    const w = maxX - minX, h = maxY - minY;
    const targetRatio = VIEW_W / VIEW_H;
    let nx = minX - pad, ny = minY - pad;
    let nw = w + 2 * pad, nh = h + 2 * pad;
    if (nw / nh > targetRatio) {
      const newH = nw / targetRatio;
      ny -= (newH - nh) / 2;
      nh = newH;
    } else {
      const newW = nh * targetRatio;
      nx -= (newW - nw) / 2;
      nw = newW;
    }
    return [nx, ny, nw, nh];
  }

  /* ───────── VIEWBOX ANIMATION ───────── */
  function setViewBox(target, animate) {
    const svg = document.getElementById('naukaMapSvg');
    if (!svg) return;
    const cur = _state.viewBox.slice();
    if (!animate) {
      _state.viewBox = target.slice();
      svg.setAttribute('viewBox', target.map(n => n.toFixed(2)).join(' '));
      refreshBackButton();
      return;
    }
    const startT = performance.now();
    _state.animToken++;
    const myToken = _state.animToken;
    const dur = 450;
    function step(now) {
      if (_state.animToken !== myToken) return;
      const k = Math.min(1, (now - startT) / dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const vb = cur.map((c, i) => c + (target[i] - c) * e);
      _state.viewBox = vb;
      svg.setAttribute('viewBox', vb.map(n => n.toFixed(2)).join(' '));
      if (k < 1) requestAnimationFrame(step);
      else refreshBackButton();
    }
    requestAnimationFrame(step);
  }

  /* ───────── ZOOM CONTROLS ───────── */
  function zoomBy(factor, cx, cy) {
    const [x, y, w, h] = _state.viewBox;
    // clamp scale: never zoom further out than FULL_VB, never further in than 80x80 svg units
    const minW = 60;
    const maxW = VIEW_W;
    let newW = w / factor;
    if (newW > maxW) newW = maxW;
    if (newW < minW) newW = minW;
    const ratio = newW / w;
    const newH = h * ratio;
    const px = cx != null ? cx : x + w / 2;
    const py = cy != null ? cy : y + h / 2;
    const nx = px - (px - x) * ratio;
    const ny = py - (py - y) * ratio;
    setViewBox([nx, ny, newW, newH], true);
  }

  function resetZoom() {
    selectWoj(null);
  }

  function wireZoomControls() {
    const zin = document.getElementById('btnNaukaZoomIn');
    const zout = document.getElementById('btnNaukaZoomOut');
    const zreset = document.getElementById('btnNaukaZoomReset');
    if (zin && !zin._wired) { zin._wired = 1; zin.addEventListener('click', () => zoomBy(1.45)); }
    if (zout && !zout._wired) { zout._wired = 1; zout.addEventListener('click', () => zoomBy(1 / 1.45)); }
    if (zreset && !zreset._wired) { zreset._wired = 1; zreset.addEventListener('click', resetZoom); }

    // Wheel zoom (desktop)
    const wrap = document.getElementById('naukaMapWrap');
    if (wrap && !wrap._wheelWired) {
      wrap._wheelWired = 1;
      wrap.addEventListener('wheel', e => {
        e.preventDefault();
        const svg = document.getElementById('naukaMapSvg');
        const r = svg.getBoundingClientRect();
        const [vx, vy, vw, vh] = _state.viewBox;
        const px = vx + ((e.clientX - r.left) / r.width) * vw;
        const py = vy + ((e.clientY - r.top) / r.height) * vh;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        zoomBy(factor, px, py);
      }, { passive: false });
    }

    // Touch pinch + 1-finger pan
    if (wrap && !wrap._touchWired) {
      wrap._touchWired = 1;
      let pinchStart = null, panStart = null;
      wrap.addEventListener('touchstart', e => {
        if (e.touches.length === 2) {
          const a = e.touches[0], b = e.touches[1];
          const dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
          pinchStart = {
            dist: Math.hypot(dx, dy),
            midX: (a.clientX + b.clientX) / 2,
            midY: (a.clientY + b.clientY) / 2,
            viewBox: _state.viewBox.slice(),
          };
          panStart = null;
        } else if (e.touches.length === 1) {
          panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, viewBox: _state.viewBox.slice() };
          pinchStart = null;
        }
      }, { passive: true });
      wrap.addEventListener('touchmove', e => {
        const svg = document.getElementById('naukaMapSvg');
        const r = svg.getBoundingClientRect();
        if (e.touches.length === 2 && pinchStart) {
          e.preventDefault();
          const a = e.touches[0], b = e.touches[1];
          const dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
          const newDist = Math.hypot(dx, dy);
          const factor = newDist / pinchStart.dist;
          const [vx, vy, vw, vh] = pinchStart.viewBox;
          let newW = vw / factor;
          if (newW > VIEW_W) newW = VIEW_W;
          if (newW < 60) newW = 60;
          const ratio = newW / vw;
          const px = vx + ((pinchStart.midX - r.left) / r.width) * vw;
          const py = vy + ((pinchStart.midY - r.top) / r.height) * vh;
          const nx = px - (px - vx) * ratio;
          const ny = py - (py - vy) * ratio;
          setViewBox([nx, ny, newW, vh * ratio], false);
        } else if (e.touches.length === 1 && panStart) {
          const t = e.touches[0];
          const [vx, vy, vw, vh] = panStart.viewBox;
          const dxPx = t.clientX - panStart.x;
          const dyPx = t.clientY - panStart.y;
          if (Math.hypot(dxPx, dyPx) < 6) return; // small move → likely tap
          e.preventDefault();
          const dxSvg = (dxPx / r.width) * vw;
          const dySvg = (dyPx / r.height) * vh;
          setViewBox([vx - dxSvg, vy - dySvg, vw, vh], false);
        }
      }, { passive: false });
      wrap.addEventListener('touchend', () => {
        pinchStart = null;
        panStart = null;
      });
    }
  }

  /* ───────── SMART BACK BUTTON ───────── */
  function refreshBackButton() {
    const btn = document.getElementById('btnNaukaMapBack');
    if (!btn) return;
    const lbl = btn.querySelector('.nm-back-lbl');
    const hasState = _state.selected || _state.currentWoj ||
      (Math.abs(_state.viewBox[2] - VIEW_W) > 5);
    if (lbl) lbl.textContent = hasState ? 'Pełna mapa' : 'Zamknij';
  }
  // Exposed back behavior — smart: if zoomed/filtered, reset; otherwise let host close screen.
  function handleBack() {
    if (_state.selected) {
      selectPowiat(null);
      return true;
    }
    if (_state.currentWoj || Math.abs(_state.viewBox[2] - VIEW_W) > 5) {
      selectWoj(null);
      return true;
    }
    return false; // host should close the screen
  }

  function wireMap() {
    const svg = document.getElementById('naukaMapSvg');
    const tip = document.getElementById('naukaTooltip');
    const wrap = document.getElementById('naukaMapWrap');
    if (!svg || !tip || !wrap) return;

    function positionTip(clientX, clientY, kod, nazwa) {
      const r = wrap.getBoundingClientRect();
      tip.querySelector('.nm-tip-kod').textContent = kod;
      tip.querySelector('.nm-tip-name').textContent = nazwa;
      tip.classList.add('show');
      // measure after content set
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let x = clientX - r.left;
      let y = clientY - r.top;
      x = Math.max(8, Math.min(r.width - tw - 8, x - tw / 2));
      y = y - th - 14;
      if (y < 8) y = clientY - r.top + 18; // flip below cursor if too high
      tip.style.transform = `translate(${x}px, ${y}px)`;
    }

    svg.addEventListener('pointermove', e => {
      const t = e.target.closest('.nm-pow');
      if (!t) { tip.classList.remove('show'); _state.hover = null; clearHoverClass(); return; }
      const kod = t.dataset.kod;
      const entry = _state.powiatPaths.find(p => p.kod === kod);
      if (!entry) return;
      if (_state.hover !== kod) {
        _state.hover = kod;
        clearHoverClass();
        t.classList.add('hover');
      }
      const nazwa = entry.nazwa.replace(/\s*\([^)]*\)/g, '');
      positionTip(e.clientX, e.clientY, kod, nazwa);
    });
    svg.addEventListener('pointerleave', () => {
      tip.classList.remove('show');
      _state.hover = null;
      clearHoverClass();
    });
    svg.addEventListener('click', e => {
      const t = e.target.closest('.nm-pow');
      if (!t) {
        // tap on empty area → deselect
        selectPowiat(null);
        return;
      }
      selectPowiat(t.dataset.kod);
    });

    // touch: hide tooltip on tap-end (it sticks otherwise on mobile)
    svg.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') {
        const t = e.target.closest('.nm-pow');
        if (t) {
          const kod = t.dataset.kod;
          const entry = _state.powiatPaths.find(p => p.kod === kod);
          if (entry) {
            const nazwa = entry.nazwa.replace(/\s*\([^)]*\)/g, '');
            positionTip(e.clientX, e.clientY, kod, nazwa);
            setTimeout(() => tip.classList.remove('show'), 1200);
          }
        }
      }
    });
  }

  function clearHoverClass() {
    document.querySelectorAll('#naukaMapSvg .nm-pow.hover').forEach(el => el.classList.remove('hover'));
  }

  function selectPowiat(kod) {
    const svg = document.getElementById('naukaMapSvg');
    if (!svg) return;
    document.querySelectorAll('#naukaMapSvg .nm-pow.selected').forEach(el => el.classList.remove('selected'));
    const card = document.getElementById('naukaPlateCard');

    if (!kod) {
      _state.selected = null;
      if (card) card.classList.remove('show');
      refreshBackButton();
      return;
    }

    const entry = _state.powiatPaths.find(p => p.kod === kod);
    if (!entry) return;
    _state.selected = kod;
    const node = svg.querySelector(`.nm-pow[data-kod="${kod}"]`);
    if (node) {
      node.classList.add('selected');
      // raise z-order
      node.parentNode.appendChild(node);
      // re-append outlines on top
      const outlines = svg.querySelectorAll('.nm-woj-outline');
      outlines.forEach(o => svg.appendChild(o));
    }

    // populate the plate card
    fillPlateCard(entry.p);
    if (card) card.classList.add('show');
    refreshBackButton();
  }

  function fillPlateCard(p) {
    const card = document.getElementById('naukaPlateCard');
    if (!card) return;
    const code = card.querySelector('.np-code');
    const name = card.querySelector('.np-name');
    const meta = card.querySelector('.np-meta');
    const wikiBtn = card.querySelector('.np-wiki');
    if (code) code.textContent = p.kod;
    if (name) name.textContent = p.nazwa.replace(/\s*\([^)]*\)/g, '');
    if (meta) {
      const typLabel = p.typ === 'miasto' ? 'miasto na prawach powiatu' : 'powiat ziemski';
      meta.innerHTML = `<span class="np-typ">${typLabel}</span><span class="np-dot">·</span><span class="np-woj">woj. ${p.woj}</span>`;
    }
    if (wikiBtn && p.wiki) {
      wikiBtn.href = `https://pl.wikipedia.org/wiki/${p.wiki}`;
      wikiBtn.style.display = '';
    } else if (wikiBtn) {
      wikiBtn.style.display = 'none';
    }
  }

  function refreshStats() {
    // Stats line removed for compact layout — keep function as a no-op so
    // existing call sites (open() flow) don't break.
  }

  async function open() {
    const screen = document.getElementById('naukaMapScreen');
    if (!screen) return;
    screen.classList.add('open');
    const status = document.getElementById('naukaMapStatus');
    if (!_state.loaded) {
      if (status) status.textContent = 'Wczytywanie map…';
      try {
        await ensureLoaded();
        renderMap();
        refreshStats();
        if (status) status.textContent = '';
      } catch (e) {
        if (status) status.textContent = 'Nie udało się wczytać mapy. Sprawdź połączenie.';
        console.warn('[NaukaMap] load failed', e);
        return;
      }
    } else if (!document.getElementById('naukaMapSvg').children.length) {
      renderMap();
      refreshStats();
    }
  }
  function close() {
    const screen = document.getElementById('naukaMapScreen');
    if (!screen) return;
    screen.classList.remove('open');
    selectPowiat(null);
    // Reset zoom + filter so reopening starts fresh
    _state.currentWoj = null;
    setViewBox(FULL_VB.slice(), false);
    document.querySelectorAll('#naukaWojStrip .nm-chip').forEach(b => {
      b.classList.toggle('active', b.dataset.woj === '');
    });
    document.querySelectorAll('#naukaMapSvg .nm-pow.dim').forEach(el => el.classList.remove('dim'));
    closeSearch();
  }

  window.NaukaMap = { open, close, handleBack, selectWoj, zoomBy, resetZoom };
})();
