/* ============================================================
   TABLICE PL — App logic (reference-style design)
   Data:
     window.POWIATY      from powiaty.js
     window.POLAND_SVG   from poland.js
     window.latLngToSvg  from poland.js
   ============================================================ */
'use strict';

const $ = id => document.getElementById(id);

const STORAGE_KEY = 'tabliceApp_v2';
const NICK_KEY    = 'tabliceApp_nick_v1';

const GAME_MODES  = ['classic', 'reverse', 'time', 'region'];
const MODE_LABELS = { classic:'Klasyk', reverse:'Odwrotny', time:'Na czas', region:'Region' };
const MODE_DESCS  = {
  classic:'Widzisz tablicę, wpisujesz powiat.',
  reverse:'Widzisz powiat, wpisujesz kod tablicy.',
  time:'60 sek od pierwszej odpowiedzi.',
  region:'Pytania tylko z jednego województwa.',
};
const TIME_TOTAL  = 60;

function emptyStats(){ return { rekord:0, najlSeria:0, pytania:0, trafione:0 }; }
function statsKey(mode){ return mode === 'region' ? 'classic' : mode; }

/* True when the current mode behaves like "reverse" (powiat → wpisz kod). */
function isReverseLike(){
  return state.mode === 'reverse' || (state.mode === 'time' && state.timeSubMode === 'reverse');
}

const state = {
  mode:'classic',
  timeSubMode:'classic',          // 'classic' | 'reverse' (active only when mode==='time')
  regionWoj:null,
  current:null,
  punkty:0,
  seria:0,
  najlSeria:0,
  pytania:0,
  trafione:0,
  hintsUsed:{ l1:false, l2:false, l3:false },
  perPowiat:{},
  modeStats:{ classic:emptyStats(), reverse:emptyStats(), time:emptyStats() },
  timer:null,
  timeLeft:0,
  answering:false,
  nick:'',
};

/* ─── PERSISTENCE ─── */
function loadState(){
  try{
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state.perPowiat = s.perPowiat || {};
    if (s.modeStats){
      for (const m of ['classic','reverse','time']){
        state.modeStats[m] = { ...emptyStats(), ...(s.modeStats[m] || {}) };
      }
    }
  } catch(e){}
  state.nick = localStorage.getItem(NICK_KEY) || '';
}
function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      perPowiat:state.perPowiat,
      modeStats:state.modeStats,
    }));
  } catch(e){}
}

/* ─── TEXT HELPERS ─── */
function normalize(s){
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/ł/g,'l').replace(/Ł/g,'l')
    .replace(/[^a-z0-9 ]/g,'')
    .trim();
}
function levenshtein(a,b){
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = Array.from({ length:a.length+1 },(_,i)=>[i]);
  for (let j=1;j<=b.length;j++) m[0][j]=j;
  for (let i=1;i<=a.length;i++){
    for (let j=1;j<=b.length;j++){
      const c = a[i-1]===b[j-1]?0:1;
      m[i][j] = Math.min(m[i-1][j]+1, m[i][j-1]+1, m[i-1][j-1]+c);
    }
  }
  return m[a.length][b.length];
}
function matches(input, powiat){
  const ni = normalize(input);
  const nn = normalize(powiat.nazwa);
  if (ni === nn) return 'exact';
  const nnBase = normalize(powiat.nazwa.replace(/\s*\([^)]*\)/g,''));
  if (ni === nnBase) return 'exact';
  if (powiat.nazwa.startsWith('Warszawa') && ni === 'warszawa') return 'exact';
  const dist = levenshtein(ni, nnBase);
  if (dist <= 1) return 'fuzzy';
  if (nnBase.length > 8 && dist <= 2) return 'fuzzy';
  return null;
}

/* ─── ADAPTIVE RANDOM ─── */
function getWeight(kod){
  const s = state.perPowiat[kod];
  if (!s) return 1.0;
  const t = s.good + s.bad;
  if (!t) return 1.0;
  const acc = s.good / t;
  return Math.max(0.25, 1 + (1 - acc) * 3);
}
function pickRandom(){
  const pool = state.mode === 'region' && state.regionWoj
    ? POWIATY.filter(p => p.woj === state.regionWoj)
    : POWIATY;
  const weights = pool.map(p => getWeight(p.kod));
  const sum = weights.reduce((a,b)=>a+b,0);
  let r = Math.random() * sum;
  for (let i=0;i<pool.length;i++){
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length-1];
}

/* ─── SUGGESTIONS ─── */
function findSuggestions(query, limit=6){
  const nq = normalize(query);
  if (nq.length < 3) return [];
  const pool = state.mode === 'region' && state.regionWoj
    ? POWIATY.filter(p => p.woj === state.regionWoj) : POWIATY;
  const seen = new Set();
  const results = [];
  for (const p of pool){
    const nn = normalize(p.nazwa);
    if (nn.startsWith(nq) || nn.includes(nq)){
      if (!seen.has(p.nazwa)){
        seen.add(p.nazwa);
        results.push({ p, score: nn.startsWith(nq) ? 0 : 1 });
      }
    }
  }
  results.sort((a,b)=> a.score - b.score || a.p.nazwa.localeCompare(b.p.nazwa,'pl'));
  return results.slice(0, limit).map(r => r.p);
}

/* ─── HUD ─── */
function updateHud(){
  const sEl = $('hudStreak');     if (sEl) sEl.textContent = state.seria;
  const bEl = $('hudBest');       if (bEl) bEl.textContent = state.najlSeria;
  const rEl = $('hudRecord');     if (rEl) rEl.textContent = state.modeStats[statsKey(state.mode)].rekord || 0;

  const sCell = $('hudStreakCell');
  if (sCell){
    sCell.classList.remove('hot','fire');
    if (state.seria >= 5) sCell.classList.add('fire');
    else if (state.seria >= 3) sCell.classList.add('hot');
  }

  const bCell = $('hudBestCell');
  if (bCell) bCell.classList.toggle('hot', state.najlSeria >= 3);
}

/* ─── PLATE ─── */
function setPlate(prefix, rest='12345'){
  $('platePrefix').textContent = prefix;
  $('plateRest').textContent = rest;
  const p = $('plate');
  p.classList.remove('rolling');
  void p.offsetWidth;
  p.classList.add('rolling');
}

/* ─── FLASH POPUP ─── */
function flash(text, kind='good'){
  const el = $('flash');
  el.textContent = text;
  el.className = 'flash show ' + (kind === 'bad' ? 'bad' : kind === 'streak' ? 'streak' : kind === 'fire' ? 'fire' : '');
  setTimeout(() => el.classList.remove('show'), 900);
}

/* ─── POLAND MAP ─── */
function loadPolandMap() {
  window.PolandMap.load($('polandMap'));
}

function clearMapHighlight(){
  window.PolandMap.clearHighlight($('polandMap'));
}

function highlightOnMap(powiat, isWrong=false){
  const svg = $('polandMap');
  if (window.PolandMap && window.PolandMap.reset) window.PolandMap.reset(svg);
  // In "reverse" mode the question is the powiat NAME → answer is the KOD.
  // So on the map pin, show the kod (e.g. "ST") instead of the powiat name.
  const labelOverride = isReverseLike() ? powiat.kod : null;
  if (window.PolandMap && window.PolandMap.playZoom){
    return window.PolandMap.playZoom(svg, powiat, isWrong, labelOverride);
  } else {
    window.PolandMap.highlight(svg, powiat.woj, isWrong);
    const shortName = labelOverride || (powiat.nazwa || '').replace(/\s*\([^)]*\)/g, '').trim();
    window.PolandMap.placeMarker(svg, powiat.lat, powiat.lng, shortName);
    return Promise.resolve();
  }
}

function setMapSubtitle(html){
  $('mapCardSub').innerHTML = html;
}

/* Post-answer auto-advance.
   - Time mode: no map animation, short pause before next question (timer keeps running).
   - Other modes: wait for map zoom-in animation, then advance. */
function advanceAfter(p, isWrong){
  if (state.mode === 'time'){
    setTimeout(() => { if (state.answering) nextQuestion(); }, 700);
  } else {
    highlightOnMap(p, isWrong).then(() => {
      if (state.answering) nextQuestion();
    });
  }
}

/* ─── QUESTION FLOW ─── */
function nextQuestion(){
  state.answering = false;
  state.current = pickRandom();
  state.hintsUsed = { l1:false, l2:false, l3:false };

  // Reset map to full Poland (cancel any running zoom animation)
  if (window.PolandMap && window.PolandMap.reset){
    window.PolandMap.reset($('polandMap'));
  }
  const sa = $('scrollArea'); if (sa) sa.classList.remove('answered');

  document.querySelectorAll('.hint-btn').forEach(b => b.disabled = false);
  $('hintReveal').style.display = 'none';
  $('hintReveal').innerHTML = '';

  const inp = $('guessInput');
  inp.value = '';
  inp.disabled = false;

  $('actionsGame').style.display = 'flex';
  $('btnNext').classList.remove('show');

  clearMapHighlight();
  setMapSubtitle('Odpowiedz, aby zobaczyć lokalizację na mapie.');
  hideSuggestions();

  if (isReverseLike()){
    setPlate('???', '?????');
    $('qTitle').innerHTML = `Jaki to <strong>kod</strong>?`;
    $('qPrompt').innerHTML = `Powiat: <b style="color:var(--yellow)">${state.current.nazwa}</b>`;
    inp.placeholder = 'np. KR, WPI, KLI…';
    document.querySelector('.hints').classList.add('hidden');
  } else {
    setPlate(state.current.kod);
    $('qTitle').innerHTML = `Jaki to powiat?`;
    $('qPrompt').textContent = 'Wpisz nazwę powiatu lub miasta.';
    inp.placeholder = 'np. Kraków, Wałbrzych…';
    document.querySelector('.hints').classList.remove('hidden');
  }

  if (window.matchMedia('(min-width: 480px) and (hover: hover)').matches){
    inp.focus({ preventScroll:true });
  }
  setTimeout(()=> $('scrollArea').scrollTo({ top:0, behavior:'smooth' }), 50);
}

function recordResult(kod, good){
  if (!state.perPowiat[kod]) state.perPowiat[kod] = { good:0, bad:0 };
  if (good) state.perPowiat[kod].good++;
  else      state.perPowiat[kod].bad++;
}

function updateModeStats(deltaPytania, deltaTrafione){
  const k = statsKey(state.mode);
  const s = state.modeStats[k];
  s.pytania  = (s.pytania  || 0) + (deltaPytania  || 0);
  s.trafione = (s.trafione || 0) + (deltaTrafione || 0);
  s.rekord    = Math.max(s.rekord    || 0, state.punkty);
  s.najlSeria = Math.max(s.najlSeria || 0, state.najlSeria);
}

function submitAnswer(){
  if (!state.current || state.answering) return;
  const inp = $('guessInput');
  const val = inp.value.trim();
  if (!val) return;
  state.answering = true;

  let correct = false, kind = null;
  if (isReverseLike()){
    const valU = val.toUpperCase().replace(/\s+/g,'');
    if (valU === state.current.kod){ correct = true; kind = 'exact'; }
  } else {
    kind = matches(val, state.current);
    correct = !!kind;
  }
  state.pytania++;
  inp.disabled = true;
  hideSuggestions();

  $('actionsGame').style.display = 'none';
  $('btnNext').classList.add('show');

  const p = state.current;

  if (correct){
    recordResult(p.kod, true);
    state.trafione++;
    state.seria++;
    if (state.seria > state.najlSeria) state.najlSeria = state.seria;

    const streakBonus = state.seria >= 10 ? 50
                      : state.seria >= 8  ? 30
                      : state.seria >= 5  ? 20
                      : state.seria >= 3  ? 10
                      : 0;
    const base = kind === 'fuzzy' ? 20 : 25;
    const gain = base + streakBonus;
    state.punkty += gain;

    if (state.seria === 3)       flash('⚡ ×3', 'streak');
    else if (state.seria === 5)  flash('🔥 ×5', 'fire');
    else if (state.seria === 8)  flash('💥 ×8', 'fire');
    else if (state.seria === 10) flash('🏆 ×10', 'fire');
    else flash('+' + gain, 'good');

    advanceAfter(p, false);
    const fuzzyTag = kind === 'fuzzy' ? ' <span style="color:var(--orange)">(z literówką)</span>' : '';
    const bonus = streakBonus > 0 ? ` <span style="color:var(--orange)">+${streakBonus} seria</span>` : '';
    setMapSubtitle(`<span class="ok">Dobrze ·</span> <strong>${p.kod}</strong> = <strong>${p.nazwa}</strong> · woj. ${p.woj} · <span class="ok">+${gain} pkt</span>${bonus}${fuzzyTag}`);

    if (state.mode === 'time' && !state.timer) startTimeTick();
    updateModeStats(1, 1);
  } else {
    recordResult(p.kod, false);
    state.seria = 0;
    flash('BŁĄD', 'bad');

    advanceAfter(p, true);
    setMapSubtitle(isReverseLike()
      ? `<span class="bad">Błąd ·</span> Prawidłowo: <strong>${p.kod}</strong> dla <strong>${p.nazwa}</strong> · woj. ${p.woj}`
      : `<span class="bad">Błąd ·</span> <strong>${p.kod}</strong> = <strong>${p.nazwa}</strong> · woj. ${p.woj}`);
    if (state.mode === 'time' && !state.timer) startTimeTick();
    updateModeStats(1, 0);
  }

  saveState();
  updateHud();

  // Scroll so map card is visible after answer
  setTimeout(()=>{
    const sa = $('scrollArea');
    const card = document.querySelector('.map-card');
    if (card){
      sa.scrollTo({ top: card.offsetTop - 60, behavior:'smooth' });
    }
  }, 120);
}

function skipQuestion(){
  if (!state.current || state.answering) return;
  state.answering = true;
  state.pytania++;
  state.seria = 0;
  recordResult(state.current.kod, false);
  $('guessInput').disabled = true;
  hideSuggestions();

  const p = state.current;
  advanceAfter(p, true);
  setMapSubtitle(`<span class="bad">Pominięto ·</span> <strong>${p.kod}</strong> = <strong>${p.nazwa}</strong> · woj. ${p.woj}`);
  updateModeStats(1, 0);
  saveState();
  updateHud();

  $('actionsGame').style.display = 'none';
  $('btnNext').classList.add('show');
  setTimeout(()=>{
    const sa = $('scrollArea');
    const card = document.querySelector('.map-card');
    if (card) sa.scrollTo({ top: card.offsetTop - 60, behavior:'smooth' });
  }, 120);
}

/* ─── HINTS ─── */
function useHint(type){
  if (!state.current || state.answering) return;
  if (state.hintsUsed[type]) return;
  if (type === 'l2' && !state.hintsUsed.l1) return;
  if (type === 'l3' && !state.hintsUsed.l2) return;

  const costs = { l1:5, l2:10, l3:15 };
  state.hintsUsed[type] = true;
  state.punkty = Math.max(0, state.punkty - costs[type]);

  const name = state.current.nazwa.toUpperCase();
  const revealed = type === 'l1' ? 1 : type === 'l2' ? 2 : 3;
  const display = name.split('').map((ch, i) => {
    if (ch === ' ') return '·';
    return i < revealed ? `<span style="color:var(--yellow)">${ch}</span>` : '_';
  }).join('');
  const r = $('hintReveal');
  r.style.display = 'block';
  r.innerHTML = display;

  $(`[data-hint="${type}"]`).disabled = true;
  updateHud();
  saveState();
}

/* ─── AUTOCOMPLETE ─── */
let suggHl = -1;
let currentSugg = [];
function renderSuggestions(query){
  if (isReverseLike()){ hideSuggestions(); return; }
  currentSugg = findSuggestions(query, 6);
  if (currentSugg.length === 0){ hideSuggestions(); return; }
  const nq = normalize(query);
  const html = currentSugg.map((p, i) => {
    const nn = normalize(p.nazwa);
    const ix = nn.indexOf(nq);
    let nazwaHtml = p.nazwa;
    if (ix >= 0 && nq.length > 0){
      const end = ix + nq.length;
      nazwaHtml = `<b>${p.nazwa.slice(0, end)}</b>${p.nazwa.slice(end)}`;
    }
    return `<div class="suggestion ${i === suggHl ? 'hl' : ''}" data-idx="${i}">
      <span class="nazwa">${nazwaHtml}</span>
      <span class="meta">${p.woj}</span>
    </div>`;
  }).join('');
  $('suggestions').innerHTML = html;
  $('suggestions').classList.add('open');
}
function hideSuggestions(){ $('suggestions').classList.remove('open'); suggHl = -1; }
function pickSuggestion(idx){
  if (idx < 0 || idx >= currentSugg.length) return;
  $('guessInput').value = currentSugg[idx].nazwa;
  hideSuggestions();
  submitAnswer();
}

/* ─── TIME MODE ─── */
function setTimeBadge(){
  const el = $('timeBadge');
  if (el) el.textContent = state.timeSubMode === 'reverse' ? 'Odwrotny' : 'Klasyk';
}
function startTimeMode(){
  if (state.timer){ clearInterval(state.timer); state.timer = null; }
  state.timeLeft = TIME_TOTAL;
  state.punkty = 0;
  state.seria = 0;
  state.pytania = 0;
  state.trafione = 0;
  state.najlSeria = 0;
  setTimeBadge();
  updateTimeBar();
  updateHud();
  nextQuestion();
}
function startTimeTick(){
  state.timeLeft = TIME_TOTAL;
  updateTimeBar();
  state.timer = setInterval(() => {
    state.timeLeft--;
    // NO point deduction per second (per user spec)
    updateHud();
    updateTimeBar();
    if (state.timeLeft <= 0){
      clearInterval(state.timer);
      state.timer = null;
      endTimeMode();
    }
  }, 1000);
}
function updateTimeBar(){
  const num = $('timeNum');
  if (!num) return;
  num.textContent = Math.max(0, state.timeLeft);
  num.classList.toggle('urgent', state.timeLeft <= 10 && state.timeLeft > 0);
  const pct = Math.max(0, state.timeLeft / TIME_TOTAL);
  const C = 528; // 2π * 84
  const fg = $('ringFg');
  if (fg){
    fg.setAttribute('stroke-dashoffset', (C * (1 - pct)).toFixed(1));
    fg.style.stroke = pct > 0.5 ? '#4ade80' : pct > 0.17 ? '#f5c33a' : '#ff5470';
  }
  const sc = $('timeScore'); if (sc) sc.textContent = state.punkty;
  const ts = $('timeStreak'); if (ts) ts.textContent = state.seria;
}
function endTimeMode(){
  $('guessInput').disabled = true;
  $('actionsGame').style.display = 'none';
  $('btnNext').classList.remove('show');
  // Final stats sync (ensure max captured)
  updateModeStats(0, 0);
  saveState();
  // Populate summary
  const acc = state.pytania > 0 ? Math.round(state.trafione / state.pytania * 100) : 0;
  $('summaryScore').textContent = state.punkty;
  $('summaryMode').textContent = state.timeSubMode === 'reverse' ? 'Na czas · Odwrotny' : 'Na czas · Klasyk';
  $('summaryAcc').textContent = state.pytania > 0 ? acc + '%' : '—';
  $('summaryStreak').textContent = '×' + state.najlSeria;
  $('summaryQ').textContent = state.pytania;
  openSheet('timeSummarySheet');
}
function stopTimeUI(){
  if (state.timer){ clearInterval(state.timer); state.timer = null; }
  const fg = $('ringFg');
  if (fg){ fg.setAttribute('stroke-dashoffset', 0); fg.style.stroke = '#4ade80'; }
  const num = $('timeNum'); if (num){ num.textContent = '60'; num.classList.remove('urgent'); }
}

async function shareTimeResult(){
  const acc = state.pytania > 0 ? Math.round(state.trafione / state.pytania * 100) : 0;
  const subLabel = state.timeSubMode === 'reverse' ? 'Odwrotny' : 'Klasyk';
  const text = `🏁 Tablice PL — Na czas (${subLabel})\n🏆 ${state.punkty} pkt · seria ×${state.najlSeria} · ${acc}% (${state.trafione}/${state.pytania})`;
  try {
    if (navigator.share){
      await navigator.share({ title: 'Tablice PL — wynik', text });
    } else if (navigator.clipboard){
      await navigator.clipboard.writeText(text);
      flash('Skopiowano', 'good');
    } else {
      // Last resort: select text in a textarea
      const t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); flash('Skopiowano', 'good'); } catch(e){}
      t.remove();
    }
  } catch (e) { /* user cancelled */ }
}

/* ─── MODE SWITCH ─── */
function setMode(mode, sub){
  stopTimeUI();
  state.punkty = 0;
  state.seria = 0;
  state.najlSeria = 0;
  state.pytania = 0;
  state.trafione = 0;
  state.mode = mode;
  if (mode === 'time') state.timeSubMode = sub || 'classic';
  updateHud();

  const sa = $('scrollArea');
  if (sa){
    sa.classList.toggle('mode-time', mode === 'time');
    sa.classList.toggle('is-reverse', isReverseLike());
  }
  const hh = document.querySelector('.hints');
  if (hh) hh.classList.toggle('hidden', isReverseLike());

  if (mode === 'time'){
    startTimeMode();
  } else if (mode === 'region'){
    openRegionSheet();
  } else {
    state.regionWoj = null;
    nextQuestion();
  }
}

/* ─── NAUKA SHEET (mode picker + how-to) ─── */
function buildModeGrid(){
  const icons = {
    classic:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="18" y2="12"/></svg>',
    reverse:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    time:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    region:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  };
  // Custom cards: time mode split into two sub-modes
  const CARDS = [
    { key:'classic',       mode:'classic', sub:null,        ico:icons.classic, tit:'Klasyk',           desc:MODE_DESCS.classic },
    { key:'reverse',       mode:'reverse', sub:null,        ico:icons.reverse, tit:'Odwrotny',          desc:MODE_DESCS.reverse },
    { key:'time-classic',  mode:'time',    sub:'classic',   ico:icons.time,    tit:'Na czas · Klasyk',  desc:'60 sek, wpisujesz powiat' },
    { key:'time-reverse',  mode:'time',    sub:'reverse',   ico:icons.time,    tit:'Na czas · Odwrotny', desc:'60 sek, wpisujesz kod' },
    { key:'region',        mode:'region',  sub:null,        ico:icons.region,  tit:'Region',            desc:MODE_DESCS.region },
  ];
  const isActive = c => {
    if (c.mode === 'time') return state.mode === 'time' && state.timeSubMode === c.sub;
    return state.mode === c.mode;
  };
  const html = CARDS.map(c => `<button class="mode-card${isActive(c) ? ' active' : ''}" data-mode="${c.mode}" data-sub="${c.sub || ''}">
      <div class="ico">${c.ico}</div>
      <div class="tit">${c.tit}</div>
      <div class="desc">${c.desc}</div>
    </button>`).join('');
  $('modeGrid').innerHTML = html;
  document.querySelectorAll('#modeGrid .mode-card').forEach(b => {
    b.addEventListener('click', () => {
      const m = b.dataset.mode;
      const s = b.dataset.sub || null;
      closeSheet('modesSheet');
      setMode(m, s);
    });
  });
}

/* ─── REGION SHEET ─── */
function openRegionSheet(){
  const wojs = [...new Set(POWIATY.map(p => p.woj))].sort((a,b)=> a.localeCompare(b,'pl'));
  $('regionGrid').innerHTML = wojs.map(w => {
    const count = POWIATY.filter(p => p.woj === w).length;
    const active = w === state.regionWoj ? ' active' : '';
    return `<button class="region-btn${active}" data-woj="${w}">${w}<small>${count} powiatów</small></button>`;
  }).join('');
  document.querySelectorAll('#regionGrid .region-btn').forEach(b => {
    b.addEventListener('click', () => {
      state.regionWoj = b.dataset.woj;
      closeSheet('regionSheet');
      nextQuestion();
    });
  });
  openSheet('regionSheet');
}

/* ─── STATS SHEET ─── */
function buildStatsSheet(){
  const sess = $('sessionStats');
  sess.innerHTML = `
    <div class="session-stat"><div class="l">Pytania</div><div class="v">${state.pytania}</div></div>
    <div class="session-stat"><div class="l">Trafność</div><div class="v">${state.pytania > 0 ? Math.round(state.trafione/state.pytania*100) + '%' : '—'}</div></div>
    <div class="session-stat"><div class="l">Najl. seria</div><div class="v">${state.najlSeria}</div></div>
  `;

  const perWoj = {};
  for (const p of POWIATY){
    if (!perWoj[p.woj]) perWoj[p.woj] = { good:0, bad:0 };
    const s = state.perPowiat[p.kod];
    if (s){ perWoj[p.woj].good += s.good; perWoj[p.woj].bad += s.bad; }
  }
  const sortedWoj = Object.entries(perWoj)
    .filter(([_,s]) => s.good + s.bad > 0)
    .sort((a,b) => (b[1].good+b[1].bad) - (a[1].good+a[1].bad));

  if (sortedWoj.length === 0){
    $('wojStatsList').innerHTML = '<p>Zagraj kilka rund, żeby zobaczyć statystyki.</p>';
  } else {
    $('wojStatsList').innerHTML = sortedWoj.map(([woj, s]) => {
      const total = s.good + s.bad;
      const pct = Math.round(s.good / total * 100);
      return `<div class="woj-bar">
        <div class="name">${woj}<div class="track"><div class="fill" style="width:${pct}%;background-position:${100-pct}% 0"></div></div></div>
        <div class="pct">${pct}% <small>(${s.good}/${total})</small></div>
      </div>`;
    }).join('');
  }

  const mistakes = Object.entries(state.perPowiat)
    .map(([kod, s]) => ({ kod, ...s, total:s.good+s.bad, acc:s.good/(s.good+s.bad||1) }))
    .filter(x => x.bad > 0)
    .sort((a,b) => b.bad - a.bad || a.acc - b.acc)
    .slice(0, 5);
  if (mistakes.length === 0){
    $('topWrongList').innerHTML = '<p>Brak błędów. Idealnie!</p>';
  } else {
    $('topWrongList').innerHTML = mistakes.map(m => {
      const p = POWIATY.find(x => x.kod === m.kod);
      if (!p) return '';
      return `<div class="mistake-row">
        <span><span class="kod">${m.kod}</span>${p.nazwa}</span>
        <span class="bad-count">${m.bad}× pomyłka</span>
      </div>`;
    }).join('');
  }
}

/* ─── RANKING SHEET (personal records per mode) ─── */
function buildRankingSheet(){
  const body = $('rankingBody');
  const rows = ['classic','reverse','time'].map(m => {
    const s = state.modeStats[m] || emptyStats();
    return `<div class="session-mode-line">
      <span>${MODE_LABELS[m]}</span>
      <span>${s.rekord || 0} pkt · seria ×${s.najlSeria || 0}</span>
    </div>`;
  }).join('');
  body.innerHTML = `
    <h3>Najlepsze wyniki</h3>
    ${rows}
    <h3>Łącznie</h3>
    ${(() => {
      let q = 0, t = 0;
      for (const m of ['classic','reverse','time']){
        q += state.modeStats[m].pytania || 0;
        t += state.modeStats[m].trafione || 0;
      }
      return `<div class="session-stats">
        <div class="session-stat"><div class="l">Pytania</div><div class="v">${q}</div></div>
        <div class="session-stat"><div class="l">Trafione</div><div class="v">${t}</div></div>
        <div class="session-stat"><div class="l">Trafność</div><div class="v">${q > 0 ? Math.round(t/q*100) + '%' : '—'}</div></div>
      </div>`;
    })()}
    <h3>Tryb online</h3>
    <div class="soon">
      <div class="soon-ico">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      </div>
      <h4>Globalny ranking — wkrótce</h4>
      <p>Na razie rekordy zapisują się lokalnie na tym urządzeniu.</p>
    </div>
  `;
}

/* ─── SHEET HELPERS ─── */
function openSheet(id){ $(id).classList.add('open'); }
function closeSheet(id){ $(id).classList.remove('open'); }

/* ─── NICK ─── */
function tryRegisterNick(){
  const raw = $('nickInput').value.trim();
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9ĄĆĘŁŃÓŚŹŻ_-]/gi,'').trim();
  if (!cleaned){ showNickError('Wpisz nick.'); return; }
  if (cleaned.length < 2){ showNickError('Minimum 2 znaki.'); return; }
  state.nick = cleaned;
  localStorage.setItem(NICK_KEY, cleaned);
  $('nickSheet').style.display = 'none';
  nextQuestion();
}
function showNickError(msg){
  $('nickError').textContent = msg;
  $('nickInput').classList.add('error');
  setTimeout(()=> $('nickInput').classList.remove('error'), 800);
}

/* ─── BOTTOM NAV ─── */
function selectTab(tab){
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === tab));
  if (tab === 'modes'){ buildModeGrid(); openSheet('modesSheet'); }
  if (tab === 'nauka'){ openSheet('naukaSheet'); }
  if (tab === 'stats'){ buildStatsSheet(); openSheet('statsSheet'); }
  if (tab === 'ranking'){ buildRankingSheet(); openSheet('rankingSheet'); }
}

/* ─── INIT ─── */
function init(){
  loadState();
  loadPolandMap();
  updateHud();
  setPlate('CGD', '12345');

  // Bottom nav
  document.querySelectorAll('.nav-item').forEach(n => {
    n.addEventListener('click', () => selectTab(n.dataset.tab));
  });

  // Sheets: when any non-quiz sheet closes, return active tab to Quiz
  document.querySelectorAll('.sheet-bg').forEach(s => {
    if (s.id === 'nickSheet') return;
    const closeAndReset = () => {
      s.classList.remove('open');
      document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === 'modes'));
    };
    s.addEventListener('click', e => { if (e.target === s) closeAndReset(); });
    s.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeAndReset));
  });

  // Input
  const inp = $('guessInput');
  inp.addEventListener('input', e => { suggHl = -1; renderSuggestions(e.target.value); });
  inp.addEventListener('keydown', e => {
    const open = $('suggestions').classList.contains('open');
    if (e.key === 'Enter'){
      e.preventDefault();
      if (open && suggHl >= 0){ pickSuggestion(suggHl); return; }
      submitAnswer();
    } else if (e.key === 'ArrowDown' && open){
      e.preventDefault();
      suggHl = Math.min(suggHl + 1, currentSugg.length - 1);
      renderSuggestions(inp.value);
    } else if (e.key === 'ArrowUp' && open){
      e.preventDefault();
      suggHl = Math.max(suggHl - 1, 0);
      renderSuggestions(inp.value);
    } else if (e.key === 'Tab' && open && currentSugg.length > 0){
      e.preventDefault();
      inp.value = currentSugg[0].nazwa;
      hideSuggestions();
    } else if (e.key === 'Escape'){
      hideSuggestions();
    }
  });
  $('suggestions').addEventListener('click', e => {
    const s = e.target.closest('.suggestion');
    if (s) pickSuggestion(parseInt(s.dataset.idx, 10));
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.input-wrap')) hideSuggestions();
  });

  // Buttons
  $('btnSubmit').addEventListener('click', submitAnswer);
  $('btnSkip').addEventListener('click', skipQuestion);
  $('btnNext').addEventListener('click', nextQuestion);
  document.querySelectorAll('.hint-btn').forEach(b => {
    b.addEventListener('click', () => useHint(b.dataset.hint));
  });

  // Top-right shortcuts
  $('btnRecord').addEventListener('click', () => selectTab('ranking'));
  $('btnProfile').addEventListener('click', () => selectTab('stats'));

  // Reset
  $('btnReset').addEventListener('click', () => {
    if (!confirm('Wyzerować cały zapisany postęp? Tego nie cofniesz.')) return;
    localStorage.removeItem(STORAGE_KEY);
    state.perPowiat = {};
    state.modeStats = { classic:emptyStats(), reverse:emptyStats(), time:emptyStats() };
    state.punkty = 0; state.seria = 0; state.najlSeria = 0;
    state.pytania = 0; state.trafione = 0;
    updateHud();
    buildStatsSheet();
  });

  // Time summary actions
  $('btnTimePlayAgain').addEventListener('click', () => {
    closeSheet('timeSummarySheet');
    setMode('time', state.timeSubMode);
  });
  $('btnTimeShare').addEventListener('click', shareTimeResult);

  // Nick
  if (state.nick){
    $('nickSheet').style.display = 'none';
    nextQuestion();
  } else {
    setTimeout(()=> $('nickInput').focus(), 250);
  }
  $('btnNickOk').addEventListener('click', tryRegisterNick);
  $('nickInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryRegisterNick(); });

  // Spacebar = Dalej (when next button visible & focus not in input)
  document.addEventListener('keydown', e => {
    if (e.key === ' ' && $('btnNext').classList.contains('show') && document.activeElement !== inp){
      e.preventDefault();
      nextQuestion();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
window.setMode = setMode;

/* ============================================================
   ALL-PLATES MODE  (Zgadnij wszystkie 396 tablic)
   ============================================================ */
const ALL_STORAGE = 'tabliceApp_allPlates_v1';
const allState = {
  solved: new Set(),
  startTs: 0,
  elapsedMs: 0,
  ticker: null,
  open: false,
};

function allLoad(){
  try{
    const s = JSON.parse(localStorage.getItem(ALL_STORAGE) || '{}');
    allState.solved = new Set(s.solved || []);
    allState.elapsedMs = s.elapsedMs || 0;
  } catch(e){
    allState.solved = new Set();
    allState.elapsedMs = 0;
  }
}
function allSave(){
  try{
    localStorage.setItem(ALL_STORAGE, JSON.stringify({
      solved: [...allState.solved],
      elapsedMs: allState.elapsedMs,
    }));
  } catch(e){}
}

function allFormatTime(ms){
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function allTick(){
  const now = Date.now();
  const total = allState.elapsedMs + (now - allState.startTs);
  $('allTime').textContent = allFormatTime(total);
}

function allStartTimer(){
  allState.startTs = Date.now();
  if (allState.ticker) clearInterval(allState.ticker);
  allState.ticker = setInterval(allTick, 1000);
  allTick();
}
function allStopTimer(){
  if (!allState.ticker) return;
  const now = Date.now();
  allState.elapsedMs += (now - allState.startTs);
  clearInterval(allState.ticker);
  allState.ticker = null;
  allSave();
}

function allBuild(){
  // Group by first letter
  const groups = {};
  for (const p of POWIATY){
    const letter = p.kod[0];
    if (!groups[letter]) groups[letter] = [];
    groups[letter].push(p);
  }
  // Sort plates within each group alphabetically by kod
  const letters = Object.keys(groups).sort();
  for (const L of letters) groups[L].sort((a, b) => a.kod.localeCompare(b.kod));

  // Voivodeship label per letter (most common one in that group)
  const wojByLetter = {};
  for (const L of letters){
    const counts = {};
    for (const p of groups[L]) counts[p.woj] = (counts[p.woj] || 0) + 1;
    wojByLetter[L] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  let html = `<div class="all-done-banner" id="allDoneBanner">
    <div class="ttl">🏆 Wszystkie 396 tablic!</div>
    <div class="sub">Czas: <span id="allDoneTime">—</span></div>
  </div>`;

  for (const L of letters){
    const items = groups[L];
    const total = items.length;
    const done = items.filter(p => allState.solved.has(p.kod)).length;
    const woj = wojByLetter[L];
    const openClass = done < total ? ' open' : '';
    html += `
      <div class="all-section${openClass}" data-letter="${L}">
        <div class="all-section-head" data-toggle="${L}">
          <div class="all-section-letter">${L}</div>
          <div class="all-section-info">
            <div class="all-section-name">Litera ${L} · ${woj}</div>
            <div class="all-section-count"><span class="done-count" data-letter-done="${L}">${done}</span> / ${total} rozwiązanych</div>
          </div>
          <svg class="all-section-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        <div class="all-section-progress">
          <div class="all-section-progress-fill" data-letter-fill="${L}" style="width:${total > 0 ? (done/total*100) : 0}%"></div>
        </div>
        <div class="all-section-body">
          ${items.map(p => allRowHtml(p)).join('')}
        </div>
      </div>
    `;
  }

  $('allBody').innerHTML = html;
  $('allTotal').textContent = POWIATY.length;
  allUpdateDoneCount();

  // Wire toggles
  document.querySelectorAll('#allBody .all-section-head').forEach(h => {
    h.addEventListener('click', () => {
      h.parentElement.classList.toggle('open');
    });
  });

  // Wire inputs (delegated)
  $('allBody').addEventListener('input', e => {
    const inp = e.target.closest('input[data-kod]');
    if (inp) allCheckInput(inp);
  });
}

function allRowHtml(p){
  const solved = allState.solved.has(p.kod);
  return `<div class="all-row${solved ? ' correct' : ''}" data-row="${p.kod}">
    <div class="mini-plate">
      <div class="mini-plate-eu"><span class="pl">PL</span></div>
      <div class="mini-plate-code">${p.kod}</div>
    </div>
    <div class="mini-input-wrap">
      <span class="ico">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </span>
      <input type="text" data-kod="${p.kod}" autocomplete="off" spellcheck="false"
        placeholder="Wpisz miasto..."
        value="${solved ? p.nazwa : ''}"
        ${solved ? 'disabled' : ''}>
    </div>
    <div class="check-ico">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
  </div>`;
}

/* ─── CONFETTI / VOIVODESHIP COMPLETION ─── */
function fireConfetti(message){
  const host = $('confettiHost');
  if (!host) return;
  const colors = ['#f5c33a','#4ade80','#ff5470','#9b8cff','#ff9e3d','#42cdff','#ffffff'];
  for (let i = 0; i < 50; i++){
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = (Math.random() * 100) + '%';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    const dur = (1.6 + Math.random() * 1.6);
    piece.style.animationDuration = dur + 's';
    piece.style.animationDelay = (Math.random() * 0.4) + 's';
    piece.style.setProperty('--dx', (Math.random() * 200 - 100).toFixed(1) + 'px');
    piece.style.width = (6 + Math.random() * 6) + 'px';
    piece.style.height = (10 + Math.random() * 8) + 'px';
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    host.appendChild(piece);
    setTimeout(() => piece.remove(), (dur + 0.5) * 1000);
  }
  if (message){
    const banner = document.createElement('div');
    banner.className = 'confetti-banner';
    banner.textContent = message;
    host.appendChild(banner);
    setTimeout(() => banner.remove(), 2700);
  }
}

function allCheckInput(inp){
  const kod = inp.dataset.kod;
  if (allState.solved.has(kod)) return;
  const p = POWIATY.find(x => x.kod === kod);
  if (!p) return;
  const kind = matches(inp.value, p);
  if (kind){
    allState.solved.add(kod);
    inp.value = p.nazwa;
    inp.disabled = true;
    inp.closest('.all-row').classList.add('correct');
    allSave();
    allUpdateDoneCount();
    allUpdateLetterCount(kod[0]);
    // Subtle confirm flash
    flash('+1', 'good');

    // Did this complete an entire voivodeship (letter group)? Fire confetti.
    const groupItems = POWIATY.filter(x => x.kod[0] === kod[0]);
    const groupDone = groupItems.filter(x => allState.solved.has(x.kod)).length;
    if (groupDone === groupItems.length && groupItems.length > 0){
      const wojRaw = groupItems[0].woj;
      const wojCap = wojRaw.charAt(0).toUpperCase() + wojRaw.slice(1);
      fireConfetti(`Województwo ${wojCap} ukończone! 🎉`);
    }

    if (allState.solved.size >= POWIATY.length){
      allStopTimer();
      const banner = $('allDoneBanner');
      $('allDoneTime').textContent = allFormatTime(allState.elapsedMs);
      banner.classList.add('show');
      banner.scrollIntoView({ behavior:'smooth', block:'center' });
    }
  }
}

function allUpdateDoneCount(){
  $('allDone').textContent = allState.solved.size;
}
function allUpdateLetterCount(L){
  const items = POWIATY.filter(p => p.kod[0] === L);
  const done = items.filter(p => allState.solved.has(p.kod)).length;
  const doneEl = document.querySelector(`[data-letter-done="${L}"]`);
  const fillEl = document.querySelector(`[data-letter-fill="${L}"]`);
  if (doneEl) doneEl.textContent = done;
  if (fillEl) fillEl.style.width = (done/items.length*100) + '%';
  // Auto-collapse if fully done
  if (done === items.length){
    const sec = document.querySelector(`.all-section[data-letter="${L}"]`);
    if (sec) sec.classList.remove('open');
  }
}

function allOpen(){
  allLoad();
  allBuild();
  $('allScreen').classList.add('open');
  allState.open = true;
  allStartTimer();
}
function allClose(){
  allStopTimer();
  $('allScreen').classList.remove('open');
  allState.open = false;
}

// Wire up entry point + exit + reset (called once during init)
function initAllMode(){
  $('btnAllStart').addEventListener('click', () => {
    closeSheet('modesSheet');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === 'quiz'));
    allOpen();
  });
  $('btnAllExit').addEventListener('click', allClose);
  $('btnAllReset').addEventListener('click', () => {
    if (!confirm('Zresetować postęp i czas w trybie "Wszystkie tablice"?')) return;
    allStopTimer();
    allState.solved = new Set();
    allState.elapsedMs = 0;
    allSave();
    allBuild();
    allStartTimer();
  });
}

// Attach to init flow
const _origInit = window.__origInitGuard;
if (!_origInit){
  window.__origInitGuard = true;
  document.addEventListener('DOMContentLoaded', initAllMode);
}
