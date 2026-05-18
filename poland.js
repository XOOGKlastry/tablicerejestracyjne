/* ============================================================
   Poland map — loads real voivodeship boundaries from
   waszkiewiczja/GeoJSON-Polska-Wojewodztwa-Powiaty-Gminy
   at runtime, projects to SVG viewBox.

   Exposes:
     window.PolandMap.load(svgEl, onReady) — fetches + renders
     window.PolandMap.highlight(svgEl, wojName, isWrong)
     window.PolandMap.clearHighlight(svgEl)
     window.PolandMap.placeMarker(svgEl, lat, lng)
   ============================================================ */

(function () {
  const GEOJSON_URL =
    'https://cdn.jsdelivr.net/gh/waszkiewiczja/GeoJSON-Polska-Wojewodztwa-Powiaty-Gminy@main/wojewodztwa.json';

  // Bounding box of mainland Poland — used as fallback if data not yet loaded.
  // Recalculated after geojson loads, but useful for early marker calls.
  let bbox = { minLat: 49.0, maxLat: 54.85, minLng: 14.1, maxLng: 24.15 };
  const VIEW_W = 1000;
  const VIEW_H = 920;

  // Normalize voivodeship name: lowercase, replace polish chars to match POWIATY.woj
  function normalizeName(s) {
    return (s || '').toLowerCase().trim();
  }

  function project(lat, lng) {
    // Equirectangular projection — fine for the area of Poland.
    // X: linear in longitude
    // Y: linear in latitude with slight Mercator-y scaling for "tall" look at this latitude.
    // We multiply latitude span by cos(midLat) to keep aspect right.
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const lngScale = Math.cos((midLat * Math.PI) / 180);
    const xRange = (bbox.maxLng - bbox.minLng) * lngScale;
    const yRange = bbox.maxLat - bbox.minLat;
    // Fit longest dimension into viewBox (with padding)
    const padding = 20;
    const w = VIEW_W - 2 * padding;
    const h = VIEW_H - 2 * padding;
    const scale = Math.min(w / xRange, h / yRange);
    const offX = padding + (w - xRange * scale) / 2;
    const offY = padding + (h - yRange * scale) / 2;
    const x = offX + (lng - bbox.minLng) * lngScale * scale;
    const y = offY + (bbox.maxLat - lat) * scale;
    return { x, y };
  }

  function ringToPath(ring) {
    // ring: array of [lng, lat]
    let d = '';
    for (let i = 0; i < ring.length; i++) {
      const [lng, lat] = ring[i];
      const { x, y } = project(lat, lng);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
    }
    return d + 'Z';
  }

  function featureToPathD(feature) {
    const g = feature.geometry;
    if (!g) return '';
    if (g.type === 'Polygon') {
      return g.coordinates.map(ringToPath).join(' ');
    }
    if (g.type === 'MultiPolygon') {
      let out = '';
      for (const poly of g.coordinates) {
        for (const ring of poly) {
          out += ringToPath(ring) + ' ';
        }
      }
      return out;
    }
    return '';
  }

  function computeBBox(features) {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const f of features) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
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
    }
    return { minLat, maxLat, minLng, maxLng };
  }

  async function load(svgEl, onReady) {
    // Show loading placeholder
    svgEl.innerHTML = `
      <rect width="${VIEW_W}" height="${VIEW_H}" fill="transparent"/>
      <text x="${VIEW_W / 2}" y="${VIEW_H / 2}" text-anchor="middle"
            fill="#5f6678" font-family="Inter,system-ui" font-size="32"
            font-weight="600">Wczytywanie mapy…</text>
    `;
    try {
      const res = await fetch(GEOJSON_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const gj = await res.json();
      const features = gj.features || [];

      bbox = computeBBox(features);

      let pathsHtml = '';
      let labelsHtml = '';
      for (const f of features) {
        const name = (f.properties && (f.properties.JPT_NAZWA_ || f.properties.nazwa || f.properties.name)) || '';
        const key = normalizeName(name);
        const d = featureToPathD(f);
        if (!d) continue;
        pathsHtml += `<path class="woj" data-woj="${key}" d="${d}"></path>`;

        // Centroid label (bbox center is good enough for Polish voivodeships)
        const fb = computeBBox([f]);
        const cLat = (fb.minLat + fb.maxLat) / 2;
        const cLng = (fb.minLng + fb.maxLng) / 2;
        const { x, y } = project(cLat, cLng);

        // Width of bbox in SVG units — determines max font size
        const p1 = project(fb.maxLat, fb.minLng);
        const p2 = project(fb.maxLat, fb.maxLng);
        const widthSvg = Math.abs(p2.x - p1.x);

        // Compute font size: longest token width should fit in ~80% of bbox width.
        // SVG font ~0.55em wide per char on average for Inter weight 600.
        const display = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
        const isHyphen = display.includes('-');
        let lines = [display];
        if (isHyphen) {
          // Split on hyphen for two-line layout
          lines = display.split('-').map((s, i) => i === 0 ? s + '-' : s);
        }
        const longest = lines.reduce((m, s) => Math.max(m, s.length), 0);
        // Try to make the longest line fit within ~85% of bbox width
        const targetWidth = widthSvg * 0.85;
        const computed = targetWidth / (longest * 0.55);
        // Clamp to readable bounds: 12-30px
        const fontSize = Math.max(12, Math.min(30, Math.round(computed)));

        // Vertical layout: center stack of lines
        const lineHeight = fontSize * 1.05;
        const totalH = lineHeight * lines.length;
        const yStart = y - (totalH / 2) + (lineHeight / 2);
        const tspans = lines.map((s, i) => {
          const ly = yStart + i * lineHeight;
          return `<tspan x="${x.toFixed(1)}" y="${ly.toFixed(1)}">${s}</tspan>`;
        }).join('');

        labelsHtml += `<text class="woj-label" data-woj="${key}" font-size="${fontSize}">${tspans}</text>`;
      }
      svgEl.innerHTML = pathsHtml + labelsHtml + `
        <g id="mapMarker" style="display:none">
          <circle id="mapPulse" cx="0" cy="0" r="14" fill="#fff" class="marker-pulse" opacity=".55"/>
          <circle id="mapDot"   cx="0" cy="0" r="7" fill="#fff" stroke="#0a0e16" stroke-width="2.5"/>
          <text id="mapPinLabel" x="0" y="0" fill="#fff" font-family="Inter,system-ui" font-weight="700" text-anchor="middle" font-size="18" style="paint-order:stroke;stroke:#0a0e16;stroke-width:4px;stroke-linejoin:round"></text>
        </g>
        <g id="powiatPin" style="display:none">
          <g class="pin-body">
            <rect class="pin-rect" x="-60" y="-54" width="120" height="24" rx="12"
              fill="#f5c33a" stroke="#5a4400" stroke-width="1.2"/>
            <text id="powiatLabel" x="0" y="-38" text-anchor="middle"
              font-family="Inter, system-ui, sans-serif"
              font-size="14" font-weight="800" fill="#0a0e16">Powiat</text>
          </g>
        </g>
      `;
      if (onReady) onReady(true);
    } catch (e) {
      console.warn('[PolandMap] load failed', e);
      svgEl.innerHTML = `
        <text x="${VIEW_W / 2}" y="${VIEW_H / 2}" text-anchor="middle"
              fill="#5f6678" font-family="Inter,system-ui" font-size="26">
          Mapa niedostępna (offline)
        </text>
      `;
      if (onReady) onReady(false);
    }
  }

  function clearHighlight(svgEl) {
    svgEl.querySelectorAll('.woj, .woj-label').forEach(el => el.classList.remove('active', 'wrong'));
    const m = svgEl.querySelector('#mapMarker');
    if (m) m.style.display = 'none';
  }

  function highlight(svgEl, wojName, isWrong) {
    clearHighlight(svgEl);
    const key = normalizeName(wojName);
    const cls = isWrong ? 'wrong' : 'active';
    svgEl.querySelectorAll(`[data-woj="${key}"]`).forEach(el => el.classList.add(cls));
  }

  function placeMarker(svgEl, lat, lng, labelText) {
    const m = svgEl.querySelector('#mapMarker');
    if (!m) return;
    const { x, y } = project(lat, lng);
    svgEl.querySelector('#mapDot').setAttribute('cx', x);
    svgEl.querySelector('#mapDot').setAttribute('cy', y);
    svgEl.querySelector('#mapPulse').setAttribute('cx', x);
    svgEl.querySelector('#mapPulse').setAttribute('cy', y);
    const lab = svgEl.querySelector('#mapPinLabel');
    if (lab) {
      lab.setAttribute('x', x);
      lab.setAttribute('y', y + 24); // below the dot
      lab.textContent = labelText || '';
    }
    m.style.display = '';
  }

  // ─────────── POWIAT LAYER (lazy-loaded) ───────────
  let _powiatsPromise = null;
  const _powiatFeatures = [];

  function loadPowiatsOnce() {
    if (_powiatsPromise) return _powiatsPromise;
    _powiatsPromise = (async () => {
      try {
        const res = await fetch(
          'https://cdn.jsdelivr.net/gh/waszkiewiczja/GeoJSON-Polska-Wojewodztwa-Powiaty-Gminy@main/powiaty.json'
        );
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const gj = await res.json();
        for (const f of gj.features) {
          const name = (f.properties && (f.properties.JPT_NAZWA_ || f.properties.nazwa || f.properties.name)) || '';
          const bb = computeBBox([f]);
          const pathD = featureToPathD(f);
          if (!pathD) continue;
          _powiatFeatures.push({
            name,
            cLat: (bb.minLat + bb.maxLat) / 2,
            cLng: (bb.minLng + bb.maxLng) / 2,
            pathD,
          });
        }
      } catch (e) {
        console.warn('[PolandMap] powiat load failed', e);
      }
    })();
    return _powiatsPromise;
  }

  function normalizeNameStrict(s) {
    return (s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/ł/g,'l').replace(/Ł/g,'l')
      .replace(/^powiat\s+/i,'')
      .replace(/^m\.\s*/i,'')
      .replace(/\s*\([^)]*\)\s*/g,'')
      .replace(/[^a-z0-9 ]/g,'')
      .trim();
  }

  function findPowiatFeature(target) {
    if (!_powiatFeatures.length) return null;
    const POWIATY = window.POWIATY || [];
    const targetIsRural = target.typ === 'ziemski';

    // Build a set of "city" feature names (miasta na prawach powiatu) so we can
    // exclude them when matching a rural (ziemski) powiat.
    const cityNames = new Set(
      POWIATY.filter(p => p.typ === 'miasto' && p.woj === target.woj)
             .map(p => normalizeNameStrict(p.nazwa))
    );

    const tName = normalizeNameStrict(target.nazwa);

    // 1) For city-on-rights ('miasto'): prefer exact name match.
    if (!targetIsRural) {
      const m = _powiatFeatures.find(f => normalizeNameStrict(f.name) === tName);
      if (m) return m;
    }

    // 2) For rural ('ziemski'): exclude features whose stripped name matches a city
    //    in the same voivodeship. Among the rest, pick nearest by centroid.
    let pool = _powiatFeatures;
    if (targetIsRural) {
      pool = _powiatFeatures.filter(f => !cityNames.has(normalizeNameStrict(f.name)));
      if (pool.length === 0) pool = _powiatFeatures;
    }
    let best = null, bestD = Infinity;
    for (const p of pool) {
      const d = (p.cLat - target.lat) ** 2 + (p.cLng - target.lng) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function findNearestPowiat(lat, lng) {
    let best = null, bestD = Infinity;
    for (const p of _powiatFeatures) {
      const d = (p.cLat - lat) ** 2 + (p.cLng - lng) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function showPowiatLayer(svgEl, wojBbox, currentPowiat) {
    let layer = svgEl.querySelector('#powiatLayer');
    if (!layer) {
      layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      layer.id = 'powiatLayer';
      // Insert below mapMarker / powiatPin (so they render on top)
      const marker = svgEl.querySelector('#mapMarker');
      if (marker) svgEl.insertBefore(layer, marker);
      else svgEl.appendChild(layer);
    }
    const target = findPowiatFeature(currentPowiat) || findNearestPowiat(currentPowiat.lat, currentPowiat.lng);
    const pad = 40;
    let html = '';
    for (const p of _powiatFeatures) {
      const pt = project(p.cLat, p.cLng);
      if (pt.x >= wojBbox.x - pad && pt.x <= wojBbox.x + wojBbox.width + pad &&
          pt.y >= wojBbox.y - pad && pt.y <= wojBbox.y + wojBbox.height + pad) {
        const isTarget = p === target;
        html += `<path class="powiat${isTarget ? ' target' : ''}" d="${p.pathD}"></path>`;
      }
    }
    layer.innerHTML = html;
    layer.style.display = '';
  }

  function hidePowiatLayer(svgEl) {
    const layer = svgEl.querySelector('#powiatLayer');
    if (layer) { layer.innerHTML = ''; layer.style.display = 'none'; }
  }

  // ─────────── ZOOM ANIMATION ───────────
  function animateViewBox(svgEl, target, durationMs) {
    const cur = svgEl.getAttribute('viewBox').split(/\s+/).map(Number);
    const tgt = target.split(/\s+/).map(Number);
    const startT = performance.now();
    svgEl._anim = (svgEl._anim || 0) + 1;
    const myToken = svgEl._anim;
    return new Promise(resolve => {
      function step(now) {
        if (svgEl._anim !== myToken) { resolve(); return; }
        const k = Math.min(1, (now - startT) / durationMs);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        const vb = cur.map((c, i) => c + (tgt[i] - c) * e);
        svgEl.setAttribute('viewBox', `${vb[0].toFixed(2)} ${vb[1].toFixed(2)} ${vb[2].toFixed(2)} ${vb[3].toFixed(2)}`);
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function getWojBboxStr(svgEl, wojName, padFrac) {
    const node = svgEl.querySelector(`.woj[data-woj="${normalizeName(wojName)}"]`);
    if (!node) return null;
    const b = node.getBBox();
    const pf = padFrac || 0.12;
    const padX = b.width * pf;
    const padY = b.height * pf;
    let w = b.width + padX * 2;
    let h = b.height + padY * 2;
    const targetRatio = VIEW_W / VIEW_H;
    let x = b.x - padX, y = b.y - padY;
    if (w / h > targetRatio) {
      const newH = w / targetRatio;
      y -= (newH - h) / 2;
      h = newH;
    } else {
      const newW = h * targetRatio;
      x -= (newW - w) / 2;
      w = newW;
    }
    return `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`;
  }
  function makePowiatBoxStr(lat, lng, halfWidth) {
    const { x, y } = project(lat, lng);
    const w = halfWidth * 2;
    const h = w * (VIEW_H / VIEW_W);
    return `${(x - w / 2).toFixed(2)} ${(y - h / 2).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`;
  }

  function reset(svgEl) {
    svgEl._anim = (svgEl._anim || 0) + 1;
    svgEl._zoomSession = (svgEl._zoomSession || 0) + 1;
    svgEl.setAttribute('viewBox', '0 0 1000 920');
    svgEl.classList.remove('zoomed', 'zoomed-deep');
    const lifted = svgEl.querySelector('.woj.lifted');
    if (lifted) lifted.classList.remove('lifted');
    const pin = svgEl.querySelector('#powiatPin');
    if (pin) { pin.style.display = 'none'; pin.classList.remove('show'); }
    hidePowiatLayer(svgEl);
  }

  function showPowiatPin(svgEl, lat, lng, label) {
    const pin = svgEl.querySelector('#powiatPin');
    if (!pin) return;
    const { x, y } = project(lat, lng);
    pin.setAttribute('transform', `translate(${x.toFixed(2)},${y.toFixed(2)})`);
    pin.style.display = '';
    pin.classList.remove('show');
    void pin.getBoundingClientRect();

    const lblText = pin.querySelector('#powiatLabel');
    if (lblText) lblText.textContent = label;

    // Dynamically size the rect so the text fits with padding on all sides
    const rect = pin.querySelector('.pin-rect');
    if (rect && lblText) {
      try {
        const bbox = lblText.getBBox();
        const padX = 14;
        const padY = 6;
        const rectW = Math.max(60, bbox.width + padX * 2);
        const rectH = bbox.height + padY * 2;
        rect.setAttribute('x', (-rectW / 2).toFixed(2));
        rect.setAttribute('width', rectW.toFixed(2));
        rect.setAttribute('y', (bbox.y - padY).toFixed(2));
        rect.setAttribute('height', rectH.toFixed(2));
      } catch (e) { /* getBBox can fail in some cases; keep defaults */ }
    }

    pin.classList.add('show');
  }
  function hidePowiatPin(svgEl) {
    const pin = svgEl.querySelector('#powiatPin');
    if (pin) pin.classList.remove('show');
  }

  async function playZoom(svgEl, powiat, isWrong, labelOverride) {
    const fullBox = '0 0 1000 920';
    const wojBoxStr = getWojBboxStr(svgEl, powiat.woj, 0.12);
    if (!wojBoxStr) return;
    const powBoxStr = makePowiatBoxStr(powiat.lat, powiat.lng, 110);
    const wojNode = svgEl.querySelector(`.woj[data-woj="${normalizeName(powiat.woj)}"]`);

    // Session token — uses a SEPARATE counter from animateViewBox's _anim.
    // (animateViewBox bumps _anim every time it starts, which would falsely
    // trigger our abort check after every stage.)
    svgEl._zoomSession = (svgEl._zoomSession || 0) + 1;
    const sessionToken = svgEl._zoomSession;
    const aborted = () => svgEl._zoomSession !== sessionToken;
    const cleanup = () => {
      if (wojNode) { wojNode.classList.remove('lifted'); }
      hidePowiatPin(svgEl);
      hidePowiatLayer(svgEl);
      svgEl.classList.remove('zoomed', 'zoomed-deep');
    };

    // Kick off powiat load in parallel with stage 1
    const powiatsP = loadPowiatsOnce();

    svgEl.classList.add('zoomed');
    clearHighlight(svgEl);
    if (wojNode) wojNode.classList.add(isWrong ? 'wrong' : 'active');

    // Stage 1: zoom to voivodeship
    await animateViewBox(svgEl, wojBoxStr, 600);
    if (aborted()) { cleanup(); return; }
    if (wojNode) wojNode.classList.add('lifted');
    await sleep(250);
    if (aborted()) { cleanup(); return; }

    // Ensure powiats data is ready, then render boundaries within the voivodeship
    await powiatsP;
    if (aborted()) { cleanup(); return; }
    if (wojNode) {
      const bbox = wojNode.getBBox();
      showPowiatLayer(svgEl, bbox, powiat);
    }

    // Stage 2: zoom deeper to the powiat
    svgEl.classList.add('zoomed-deep');
    await animateViewBox(svgEl, powBoxStr, 600);
    if (aborted()) { cleanup(); return; }

    // Stage 3: show powiat pin + name (or kod, in reverse mode)
    showPowiatPin(svgEl, powiat.lat, powiat.lng, labelOverride || powiat.nazwa);
    await sleep(1400);
    if (aborted()) { cleanup(); return; }

    // Stage 4: zoom back out
    hidePowiatPin(svgEl);
    hidePowiatLayer(svgEl);
    svgEl.classList.remove('zoomed-deep');
    if (wojNode) wojNode.classList.remove('lifted');
    await animateViewBox(svgEl, fullBox, 750);
    svgEl.classList.remove('zoomed');
  }

  window.PolandMap = { load, clearHighlight, highlight, placeMarker, playZoom, reset, VIEW_W, VIEW_H };
})();
