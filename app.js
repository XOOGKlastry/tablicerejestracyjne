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

const GAME_MODES  = ['quiz', 'wpisz', 'czas'];
const USER_MODE_LABELS = { quiz:'Quiz', wpisz:'Wpisz', czas:'Na czas' };
const GUESS_LABELS = { powiat:'Powiat', kod:'Tablica', mix:'Mix' };
const USER_MODE_DESCS = {
  quiz:'4 odpowiedzi do wyboru. Najszybszy tryb.',
  wpisz:'Wpisujesz odpowiedź z głowy. Podpowiedzi w grze.',
  czas:'60 sek od pierwszej odpowiedzi. Ile zdążysz?',
};
const GUESS_DESCS = {
  powiat:'Widzisz kod tablicy → podajesz nazwę powiatu.',
  kod:'Widzisz powiat → podajesz kod tablicy.',
  mix:'Naprzemiennie obie strony, losowo.',
};
const TIME_TOTAL  = 60;

function emptyStats(){ return { rekord:0, najlSeria:0, pytania:0, trafione:0 }; }
function statsKey(){
  // Stats bucketed by user-facing mode only.
  return state.userMode || 'quiz';
}

/* Resolve (userMode, guess) → internal mode used by the game-flow code.
   Side-effects: updates state.mode and state.timeSubMode. */
function applyMode(){
  const um = state.userMode;
  const g  = state.guess;
  if (um === 'quiz'){
    state.mode = g === 'mix' ? 'quizMix' : g === 'kod' ? 'quizReverse' : 'quiz';
  } else if (um === 'wpisz'){
    state.mode = g === 'mix' ? 'wpiszMix' : g === 'kod' ? 'reverse' : 'classic';
  } else if (um === 'czas'){
    state.mode = 'time';
    state.timeSubMode = g === 'mix' ? 'mix' : g === 'kod' ? 'reverse' : 'classic';
  }
}

/* For mix-style modes, every question randomly picks a direction.
   This resolves the *current question*'s effective internal mode. */
function effectiveMode(){
  if (state.mode === 'quizMix')  return state.quizMixSub  || 'quiz';
  if (state.mode === 'wpiszMix') return state.wpiszMixSub || 'classic';
  return state.mode;
}

/* True when the current question expects the user to give the KOD (tablica). */
function isReverseLike(){
  const m = effectiveMode();
  if (m === 'reverse' || m === 'quizReverse') return true;
  if (state.mode === 'time'){
    if (state.timeSubMode === 'reverse') return true;
    if (state.timeSubMode === 'mix') return state.timeMixSub === 'reverse';
  }
  return false;
}
function isQuizMode(){
  const m = effectiveMode();
  return m === 'quiz' || m === 'quizReverse';
}

const state = {
  // User-facing dimensions:
  userMode:'quiz',                // 'quiz' | 'wpisz' | 'czas'
  guess:'mix',                    // 'powiat' | 'kod' | 'mix'

  // Derived internal mode (set by applyMode()):
  mode:'quizMix',
  timeSubMode:'mix',              // 'classic' | 'reverse' | 'mix' (when mode==='time')
  quizMixSub:'quiz',              // per-question, when mode==='quizMix'
  wpiszMixSub:'classic',          // per-question, when mode==='wpiszMix'
  timeMixSub:'classic',           // per-question, when mode==='time' && timeSubMode==='mix'

  regionWoj:null,
  current:null,
  punkty:0,
  seria:0,
  najlSeria:0,
  pytania:0,
  trafione:0,
  hintsUsed:{ l1:false, l2:false, l3:false },
  perPowiat:{},
  modeStats:{ quiz:emptyStats(), wpisz:emptyStats(), czas:emptyStats() },
  quizOptions:[],
  quizCorrectIdx:-1,
  timer:null,
  timeLeft:0,
  answering:false,
  advancing:false,
  nick:'',
};

/* ─── PERSISTENCE ─── */
function loadState(){
  try{
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state.perPowiat = s.perPowiat || {};
    if (s.modeStats){
      // Merge new keys directly
      for (const m of GAME_MODES){
        state.modeStats[m] = { ...emptyStats(), ...(s.modeStats[m] || {}) };
      }
      // Migrate legacy keys → bucket into new userModes (max-merge records)
      const LEGACY_MAP = {
        classic:'wpisz', reverse:'wpisz',
        time:'czas',
        quiz:'quiz', quizReverse:'quiz', quizMix:'quiz',
      };
      for (const [oldK, newK] of Object.entries(LEGACY_MAP)){
        const o = s.modeStats[oldK];
        if (!o) continue;
        const t = state.modeStats[newK];
        t.rekord    = Math.max(t.rekord    || 0, o.rekord    || 0);
        t.najlSeria = Math.max(t.najlSeria || 0, o.najlSeria || 0);
        t.pytania   = (t.pytania   || 0) + (o.pytania   || 0);
        t.trafione  = (t.trafione  || 0) + (o.trafione  || 0);
      }
    }
    if (s.userMode && GAME_MODES.includes(s.userMode)) state.userMode = s.userMode;
    if (s.guess && ['powiat','kod','mix'].includes(s.guess)) state.guess = s.guess;
    applyMode();
  } catch(e){}
  state.nick = localStorage.getItem(NICK_KEY) || '';
}
function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      perPowiat:state.perPowiat,
      modeStats:state.modeStats,
      userMode:state.userMode,
      guess:state.guess,
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
  const rEl = $('hudRecord');     if (rEl) rEl.textContent = state.modeStats[statsKey()].rekord || 0;

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
  // Legacy hidden element (kept for compat)
  const legacy = $('mapCardSub'); if (legacy) legacy.innerHTML = html;

  // Visible feedback row inside the map card
  const row  = $('mapFeedback');
  const sa   = $('scrollArea');
  if (!row) return;
  const isVerdict = /class="(ok|bad)"/.test(html);
  if (!isVerdict){
    row.classList.remove('show','good','bad');
    if (sa) sa.classList.remove('answered');
    return;
  }
  const good = html.indexOf('class="ok"') !== -1;
  row.classList.toggle('good', good);
  row.classList.toggle('bad', !good);
  row.classList.add('show');
  const txt = $('mapFeedbackText'); if (txt) txt.innerHTML = html;
  const ico = $('mapFeedbackIcon');
  if (ico) ico.innerHTML = good
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>';
  if (sa) sa.classList.add('answered');
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

/* ─── QUIZ DISTRACTORS ─── */
function shuffle(a){
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* Distractors for "Quiz" (kod → nazwa).
   Pick 3 other powiaty whose nazwa starts with the same first letter
   as the correct nazwa (ignoring diacritics).  Avoid duplicates of nazwa. */
function buildQuizDistractors(correct){
  const firstLetter = normalize(correct.nazwa)[0] || '';
  const seenNames = new Set([normalize(correct.nazwa.replace(/\s*\([^)]*\)/g,''))]);
  const pool = [];
  for (const p of POWIATY){
    const nb = normalize(p.nazwa.replace(/\s*\([^)]*\)/g,''));
    if (seenNames.has(nb)) continue;
    if (normalize(p.nazwa)[0] !== firstLetter) continue;
    seenNames.add(nb);
    pool.push(p);
  }
  let picks = shuffle(pool).slice(0, 3);
  // Fallback: if not enough same-letter powiaty, fill with random
  if (picks.length < 3){
    const extras = shuffle(POWIATY.filter(p => {
      const nb = normalize(p.nazwa.replace(/\s*\([^)]*\)/g,''));
      return !seenNames.has(nb);
    })).slice(0, 3 - picks.length);
    extras.forEach(p => {
      seenNames.add(normalize(p.nazwa.replace(/\s*\([^)]*\)/g,'')));
      picks.push(p);
    });
  }
  return picks.map(p => ({ label: p.nazwa.replace(/\s*\([^)]*\)/g,'').trim(), correct:false }));
}

/* Distractors for "Quiz odwrotny" (nazwa → kod).
   Pick 3 other kody that look similar to the correct kod.
   Scoring: # of shared letters with correct kod, then similar length. */
function buildQuizReverseDistractors(correct){
  const target = correct.kod;
  const targetSet = new Set(target.split(''));
  const seen = new Set([target]);
  const scored = [];
  for (const p of POWIATY){
    if (seen.has(p.kod)) continue;
    seen.add(p.kod);
    let shared = 0;
    for (const ch of p.kod) if (targetSet.has(ch)) shared++;
    const lenDelta = Math.abs(p.kod.length - target.length);
    // Prefer codes with multiple shared letters and similar length.
    // Add small randomness so picks vary each round.
    const score = shared * 10 - lenDelta * 2 + Math.random();
    scored.push({ kod: p.kod, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // Take top ~12 then shuffle for variety
  const top = scored.slice(0, 12);
  const picks = shuffle(top).slice(0, 3);
  return picks.map(x => ({ label: x.kod, correct:false }));
}

function buildQuizOptions(){
  const correct = state.current;
  const mode = effectiveMode();
  if (mode === 'quiz'){
    const correctLabel = correct.nazwa.replace(/\s*\([^)]*\)/g,'').trim();
    const opts = [
      { label: correctLabel, correct:true },
      ...buildQuizDistractors(correct),
    ];
    const shuffled = shuffle(opts);
    state.quizOptions = shuffled;
    state.quizCorrectIdx = shuffled.findIndex(o => o.correct);
  } else { // quizReverse
    const opts = [
      { label: correct.kod, correct:true },
      ...buildQuizReverseDistractors(correct),
    ];
    const shuffled = shuffle(opts);
    state.quizOptions = shuffled;
    state.quizCorrectIdx = shuffled.findIndex(o => o.correct);
  }
  renderQuizOptions();
}

function renderQuizOptions(){
  const wrap = $('qOptions');
  if (!wrap) return;
  const isKod = effectiveMode() === 'quizReverse';
  const btns = wrap.querySelectorAll('.q-option');
  btns.forEach((b, i) => {
    b.classList.remove('good','bad','dim');
    b.classList.toggle('kod-style', isKod);
    b.disabled = false;
    const opt = state.quizOptions[i];
    const textEl = b.querySelector('.text');
    if (textEl) textEl.textContent = opt ? opt.label : '—';
  });
}

function pickQuizOption(idx){
  if (!state.current || state.answering) return;
  if (idx < 0 || idx >= state.quizOptions.length) return;
  state.answering = true;
  const opt = state.quizOptions[idx];
  const isCorrect = !!opt.correct;
  const p = state.current;
  state.pytania++;

  const btns = $('qOptions').querySelectorAll('.q-option');
  btns.forEach((b, i) => {
    b.disabled = true;
    if (i === idx) b.classList.add(isCorrect ? 'good' : 'bad');
    else if (i === state.quizCorrectIdx && !isCorrect) b.classList.add('good');
    else b.classList.add('dim');
  });

  $('actionsGame').style.display = 'none';
  $('btnNext').classList.add('show');

  if (isCorrect){
    recordResult(p.kod, true);
    state.trafione++;
    state.seria++;
    if (state.seria > state.najlSeria) state.najlSeria = state.seria;
    const streakBonus = state.seria >= 10 ? 50
                      : state.seria >= 8  ? 30
                      : state.seria >= 5  ? 20
                      : state.seria >= 3  ? 10 : 0;
    // Quiz is multiple-choice → easier → smaller base
    const base = 15;
    const gain = base + streakBonus;
    state.punkty += gain;
    if (state.seria === 3)       flash('⚡ ×3', 'streak');
    else if (state.seria === 5)  flash('🔥 ×5', 'fire');
    else if (state.seria === 8)  flash('💥 ×8', 'fire');
    else if (state.seria === 10) flash('🏆 ×10', 'fire');
    else flash('+' + gain, 'good');
    advanceAfter(p, false);
    setMapSubtitle(`<span class="ok">Dobrze ·</span> <strong>${p.kod}</strong> = <strong>${p.nazwa}</strong> · woj. ${p.woj} · <span class="ok">+${gain} pkt</span>`);
    updateModeStats(1, 1);
  } else {
    recordResult(p.kod, false);
    state.seria = 0;
    flash('BŁĄD', 'bad');
    advanceAfter(p, true);
    setMapSubtitle(`<span class="bad">Błąd ·</span> <strong>${p.kod}</strong> = <strong>${p.nazwa}</strong> · woj. ${p.woj}`);
    updateModeStats(1, 0);
  }
  saveState();
  updateHud();
  // Layout is fixed-height: the map is always fully visible, no scrolling needed.
}

/* ─── QUESTION FLOW ─── */
function nextQuestion(){
  // Guard against rapid double-clicks on Dalej
  if (state.advancing) return;
  state.advancing = true;
  state.answering = false;

  // Pick per-question sub-mode for mix variants BEFORE anything reads effectiveMode()
  if (state.mode === 'quizMix'){
    state.quizMixSub = Math.random() < 0.5 ? 'quiz' : 'quizReverse';
  }
  if (state.mode === 'wpiszMix'){
    state.wpiszMixSub = Math.random() < 0.5 ? 'classic' : 'reverse';
  }
  if (state.mode === 'time' && state.timeSubMode === 'mix'){
    state.timeMixSub = Math.random() < 0.5 ? 'classic' : 'reverse';
  }

  state.current = pickRandom();
  state.hintsUsed = { l1:false, l2:false, l3:false };

  // Ensure scroll-area classes reflect current mode (works on first call too)
  const saEl = $('scrollArea');
  if (saEl){
    saEl.classList.toggle('mode-time', state.mode === 'time');
    saEl.classList.toggle('is-reverse', isReverseLike());
    saEl.classList.toggle('mode-quiz', state.mode === 'quiz' || state.mode === 'quizReverse' || state.mode === 'quizMix');
  }

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

  // Quiz mode UI tweaks
  if (isQuizMode()){
    if (effectiveMode() === 'quiz'){
      $('qPrompt').textContent = 'Wybierz odpowiedź:';
    } else {
      $('qPrompt').innerHTML = `Wybierz kod dla: <b style="color:var(--yellow)">${state.current.nazwa}</b>`;
    }
    $('actionsGame').style.display = 'none';
    buildQuizOptions();
  }

  if (window.matchMedia('(min-width: 480px) and (hover: hover)').matches){
    inp.focus({ preventScroll:true });
  }
  // No scrollTo: the layout never scrolls, every stage fits the viewport.

  // Release the advance lock after the current frame has rendered.
  // Use setTimeout (not rAF) so it still fires when the tab is in the background.
  setTimeout(() => { state.advancing = false; }, 0);
}

function recordResult(kod, good){
  if (!state.perPowiat[kod]) state.perPowiat[kod] = { good:0, bad:0 };
  if (good) state.perPowiat[kod].good++;
  else      state.perPowiat[kod].bad++;
}

function updateModeStats(deltaPytania, deltaTrafione){
  const k = statsKey();
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
  // Map card is always fully on-screen — no scroll needed after answering.
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
function resetSession(){
  state.punkty = 0;
  state.seria = 0;
  state.najlSeria = 0;
  state.pytania = 0;
  state.trafione = 0;
}

function applyModeUI(){
  const sa = $('scrollArea');
  if (sa){
    sa.classList.toggle('mode-time', state.mode === 'time');
    sa.classList.toggle('is-reverse', isReverseLike());
    sa.classList.toggle('mode-quiz', isQuizMode() || state.mode === 'quizMix');
  }
  const hh = document.querySelector('.hints');
  if (hh) hh.classList.toggle('hidden', isReverseLike() || isQuizMode());
  refreshGuessHeader();
}

function setUserMode(um){
  if (!GAME_MODES.includes(um)) return;
  stopTimeUI();
  resetSession();
  state.userMode = um;
  applyMode();
  updateHud();
  applyModeUI();
  saveState();
  if (um === 'czas'){
    startTimeMode();
  } else {
    state.regionWoj = null;
    nextQuestion();
  }
}

function setGuess(g){
  if (!['powiat','kod','mix'].includes(g)) return;
  stopTimeUI();
  resetSession();
  state.guess = g;
  applyMode();
  updateHud();
  applyModeUI();
  saveState();
  if (state.userMode === 'czas'){
    startTimeMode();
  } else {
    nextQuestion();
  }
}

// Back-compat: keep old setMode signature in case anything still calls it.
function setMode(mode, sub){
  // Map legacy modes back to new dimensions.
  if (mode === 'quizMix'){ state.userMode='quiz'; state.guess='mix'; }
  else if (mode === 'quiz'){ state.userMode='quiz'; state.guess='powiat'; }
  else if (mode === 'quizReverse'){ state.userMode='quiz'; state.guess='kod'; }
  else if (mode === 'wpiszMix'){ state.userMode='wpisz'; state.guess='mix'; }
  else if (mode === 'classic'){ state.userMode='wpisz'; state.guess='powiat'; }
  else if (mode === 'reverse'){ state.userMode='wpisz'; state.guess='kod'; }
  else if (mode === 'time'){
    state.userMode='czas';
    state.guess = sub === 'reverse' ? 'kod' : sub === 'mix' ? 'mix' : 'powiat';
  }
  else if (mode === 'region'){ state.userMode='wpisz'; state.guess='powiat'; }
  else if (['quiz','wpisz','czas'].includes(mode)){ state.userMode = mode; }
  setUserMode(state.userMode);
}

/* ─── GUESS HEADER (small icon next to "Tablice") ─── */
const GUESS_ICONS = {
  powiat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  kod:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="18" y2="12"/></svg>',
  mix:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
};

function refreshGuessHeader(){
  // Header subtitle: "Quiz · Mix" etc.
  const sub = $('headerSub');
  if (sub) sub.textContent = (USER_MODE_LABELS[state.userMode] || 'Quiz') + ' · ' + (GUESS_LABELS[state.guess] || 'Mix');
  // Direction segment in modes sheet (if rendered)
  const seg = $('guessSeg');
  if (seg) seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.guess === state.guess));
  const desc = $('guessSegDesc');
  if (desc) desc.innerHTML = GUESS_DESCS[state.guess] || '';
}

function buildGuessSeg(){
  const seg = $('guessSeg');
  if (!seg) return;
  seg.innerHTML = ['powiat','kod','mix'].map(g => {
    const active = state.guess === g ? ' class="active" data-guess="'+g+'"' : ' data-guess="'+g+'"';
    return `<button${active}>${GUESS_ICONS[g]}${GUESS_LABELS[g]}</button>`;
  }).join('');
  seg.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      if (b.dataset.guess === state.guess) return;
      setGuess(b.dataset.guess);   // updates game in the background
      refreshGuessHeader();         // re-highlight without closing the sheet
    });
  });
  refreshGuessHeader();
}

/* ─── MODE QUICK PICKER (3 stacked cards) ─── */
function buildModeGrid(){
  const icons = {
    quiz:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    wpisz:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    czas:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  };
  const CARDS = [
    { mode:'quiz',  ico:icons.quiz,  tit:'Quiz',     desc:'4 odpowiedzi do wyboru. Najszybszy tryb.' },
    { mode:'wpisz', ico:icons.wpisz, tit:'Wpisz',    desc:'Wpisujesz odpowiedź z głowy. Podpowiedzi w grze.' },
    { mode:'czas',  ico:icons.czas,  tit:'Na czas',  desc:'60 sek od pierwszej odpowiedzi.' },
  ];

  const check = '<svg class="mode-quick-check" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  const html = CARDS.map(c => {
    const rec = state.modeStats[c.mode] || emptyStats();
    const active = state.userMode === c.mode ? ' active' : '';
    return `<button class="mode-quick-card${active}" data-mode="${c.mode}">
      <div class="mode-quick-ico">${c.ico}</div>
      <div class="mode-quick-text">
        <div class="mode-quick-tit">${c.tit}</div>
        <div class="mode-quick-desc">${c.desc}</div>
        <div class="mode-quick-rec">Rekord: <b>${rec.rekord || 0}</b> pkt · seria ×${rec.najlSeria || 0}</div>
      </div>
      ${check}
    </button>`;
  }).join('');

  const wrap = $('modeQuick');
  if (wrap){
    wrap.innerHTML = html;
    wrap.querySelectorAll('.mode-quick-card').forEach(b => {
      b.addEventListener('click', () => {
        closeSheet('modesSheet');
        setUserMode(b.dataset.mode);
      });
    });
  }
  buildGuessSeg();
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
  renderRecords();
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

/* ─── RECORDS (inside Statystyki) ─── */
function renderRecords(){
  const el = $('recordsList');
  if (!el) return;
  let q = 0, t = 0;
  for (const m of GAME_MODES){
    q += state.modeStats[m].pytania || 0;
    t += state.modeStats[m].trafione || 0;
  }
  const rows = GAME_MODES.map(m => {
    const s = state.modeStats[m] || emptyStats();
    return `<div class="session-mode-line">
      <span>${USER_MODE_LABELS[m]}</span>
      <span>${s.rekord || 0} pkt · seria ×${s.najlSeria || 0}</span>
    </div>`;
  }).join('');
  const wkSaved = weeklyLoad();
  const wkRow = wkSaved && wkSaved.done
    ? `<div class="session-mode-line"><span>Wyzwanie (${wkSaved.weekKey.replace('-W',' · tydz. ')})</span><span>${wkSaved.score}/10</span></div>`
    : '';
  el.innerHTML = rows + wkRow + `
    <div class="session-stats" style="margin-top:8px">
      <div class="session-stat"><div class="l">Pytania</div><div class="v">${q}</div></div>
      <div class="session-stat"><div class="l">Trafione</div><div class="v">${t}</div></div>
      <div class="session-stat"><div class="l">Trafność</div><div class="v">${q > 0 ? Math.round(t/q*100) + '%' : '—'}</div></div>
    </div>`;
}

/* ─── NAUKA: plate browser with search ─── */
let naukaBuilt = false;
function buildNaukaSheet(){
  if (naukaBuilt) return;
  naukaBuilt = true;

  const list = $('naukaList');
  const wojs = [...new Set(POWIATY.map(p => p.woj))].sort((a,b)=> a.localeCompare(b,'pl'));

  list.innerHTML = wojs.map(w => {
    const items = POWIATY.filter(p => p.woj === w).sort((a,b)=> a.kod.localeCompare(b.kod,'pl'));
    const letter = (items[0] && items[0].kod[0]) || '?';
    const rows = items.map(p => {
      const name = p.nazwa.replace(/\s*\([^)]*\)/g,'').trim();
      const wiki = encodeURIComponent((p.wiki || name).replace(/ /g,'_'));
      return `<a class="nauka-row" data-kod="${p.kod}" data-name="${normalize(p.nazwa)}"
                 href="https://pl.wikipedia.org/wiki/${wiki}" target="_blank" rel="noopener">
        <div class="mini-plate2"><div class="eu"><span>PL</span></div><div class="code">${p.kod}</div></div>
        <div class="n-name">${name}<small>${p.woj}</small></div>
        <span class="nauka-typ ${p.typ}">${p.typ === 'miasto' ? 'Miasto' : 'Ziemski'}</span>
      </a>`;
    }).join('');
    return `<div class="all-section nauka-section" data-woj="${w}">
      <div class="all-section-head">
        <div class="all-section-letter">${letter}</div>
        <div class="all-section-info">
          <div class="all-section-name" style="text-transform:capitalize">${w}</div>
          <div class="all-section-count">${items.length} kodów</div>
        </div>
        <svg class="all-section-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="all-section-body">${rows}</div>
    </div>`;
  }).join('') + `<div class="nauka-empty" id="naukaEmpty" style="display:none">Brak wyników.</div>`;

  // Accordion toggles (sections + "Jak grać")
  $('naukaBody').querySelectorAll('.all-section-head').forEach(h => {
    h.addEventListener('click', () => {
      const sec = h.parentElement;
      sec.classList.toggle('open');
      // "Jak grać" uses inline display:none on body — sync it
      const body = sec.querySelector('.all-section-body');
      if (body && body.style.display !== '') body.style.display = sec.classList.contains('open') ? 'flex' : 'none';
    });
  });

  // Search filter
  const search = $('naukaSearch');
  search.addEventListener('input', () => {
    const q = normalize(search.value);
    const qU = search.value.trim().toUpperCase();
    let any = false;
    list.querySelectorAll('.nauka-section').forEach(sec => {
      let visible = 0;
      sec.querySelectorAll('.nauka-row').forEach(row => {
        const hit = !q
          || row.dataset.kod.startsWith(qU)
          || row.dataset.name.includes(q);
        row.style.display = hit ? '' : 'none';
        if (hit) visible++;
      });
      sec.style.display = visible ? '' : 'none';
      sec.classList.toggle('open', !!q && visible > 0);
      if (visible) any = true;
    });
    const empty = $('naukaEmpty');
    if (empty) empty.style.display = any ? 'none' : 'block';
  });
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
  applyModeUI();
  if (state.userMode === 'czas') startTimeMode();
  else nextQuestion();
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
  if (tab === 'nauka'){ buildNaukaSheet(); openSheet('naukaSheet'); }
  if (tab === 'stats'){ buildStatsSheet(); openSheet('statsSheet'); }
  if (tab === 'weekly'){ openWeekly(); }
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

  // Quiz options
  $('qOptions').addEventListener('click', e => {
    const b = e.target.closest('.q-option');
    if (!b) return;
    const idx = parseInt(b.dataset.opt, 10);
    pickQuizOption(idx);
  });

  // Header: single mode button opens the modes sheet
  $('btnMode').addEventListener('click', () => selectTab('modes'));

  // Reset
  $('btnReset').addEventListener('click', () => {
    if (!confirm('Wyzerować cały zapisany postęp? Tego nie cofniesz.')) return;
    localStorage.removeItem(STORAGE_KEY);
    state.perPowiat = {};
    state.modeStats = { quiz:emptyStats(), wpisz:emptyStats(), czas:emptyStats() };
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
    applyModeUI();
    if (state.userMode === 'czas') startTimeMode();
    else nextQuestion();
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
window.setUserMode = setUserMode;
window.setGuess = setGuess;

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

/* ============================================================
   WEEKLY CHALLENGE (Wyzwanie tygodnia)
   - 10 deterministic questions per ISO week (same for everyone)
   - First completed run is the official result; later runs = training
   ============================================================ */
const WEEKLY_STORAGE = 'tabliceApp_weekly_v1';
const WK_N = 10;
const wk = {
  qs: [], idx: 0, marks: [],
  practice: false, locked: false,
  weekKey: '', label: '',
};

function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function isoWeekInfo(d = new Date()){
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThu = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fDayNum + 3);
  const week = 1 + Math.round((date - firstThu) / (7 * 864e5));
  return { week, year: date.getUTCFullYear() };
}
function seededShuffle(arr, rng){
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--){
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function wkClean(n){ return (n || '').replace(/\s*\([^)]*\)/g, '').trim(); }

function weeklyLoad(){
  try{ return JSON.parse(localStorage.getItem(WEEKLY_STORAGE) || 'null'); }
  catch(e){ return null; }
}
function weeklySave(obj){
  try{ localStorage.setItem(WEEKLY_STORAGE, JSON.stringify(obj)); } catch(e){}
}

function buildWeeklySet(){
  const { week, year } = isoWeekInfo();
  wk.weekKey = year + '-W' + String(week).padStart(2, '0');
  wk.label = 'Tydzień ' + week + '/' + year;
  const rng = mulberry32(year * 1000 + week * 7919);

  const picks = seededShuffle(POWIATY, rng).slice(0, WK_N);
  wk.qs = picks.map((p, i) => {
    const reverse = i % 2 === 1; // even: kod→powiat, odd: powiat→kod
    let opts;
    if (!reverse){
      const correct = wkClean(p.nazwa);
      const seen = new Set([normalize(correct)]);
      let pool = POWIATY.filter(x => {
        const n = normalize(wkClean(x.nazwa));
        if (seen.has(n)) return false;
        return normalize(x.nazwa)[0] === normalize(p.nazwa)[0];
      });
      if (pool.length < 3){
        pool = pool.concat(POWIATY.filter(x => !seen.has(normalize(wkClean(x.nazwa))) && pool.indexOf(x) === -1));
      }
      const dis = [];
      for (const d of seededShuffle(pool, rng)){
        const n = normalize(wkClean(d.nazwa));
        if (seen.has(n)) continue;
        seen.add(n);
        dis.push({ label: wkClean(d.nazwa), correct: false });
        if (dis.length === 3) break;
      }
      opts = seededShuffle([{ label: correct, correct: true }, ...dis], rng);
    } else {
      const targetSet = new Set(p.kod.split(''));
      const scored = [];
      const seen = new Set([p.kod]);
      for (const x of POWIATY){
        if (seen.has(x.kod)) continue;
        seen.add(x.kod);
        let shared = 0;
        for (const ch of x.kod) if (targetSet.has(ch)) shared++;
        scored.push({ kod: x.kod, score: shared * 10 - Math.abs(x.kod.length - p.kod.length) * 2 });
      }
      scored.sort((a, b) => b.score - a.score || a.kod.localeCompare(b.kod));
      const dis = seededShuffle(scored.slice(0, 12), rng).slice(0, 3)
        .map(x => ({ label: x.kod, correct: false }));
      opts = seededShuffle([{ label: p.kod, correct: true }, ...dis], rng);
    }
    return { p, reverse, opts };
  });
}

function wkRenderDots(){
  $('wkDots').innerHTML = wk.qs.map((_, i) => {
    const m = wk.marks[i];
    const cls = m === true ? ' ok' : m === false ? ' bad' : i === wk.idx ? ' cur' : '';
    return `<span class="wk-dot${cls}"></span>`;
  }).join('');
}

function wkRenderQuestion(){
  const q = wk.qs[wk.idx];
  $('wkQNum').textContent = wk.idx + 1;
  wkRenderDots();

  const prefix = $('wkPlatePrefix'), rest = $('wkPlateRest');
  if (q.reverse){
    prefix.textContent = '???'; rest.textContent = '?????';
    $('wkPrompt').innerHTML = `Wybierz kod dla: <b style="color:var(--yellow)">${wkClean(q.p.nazwa)}</b>`;
  } else {
    prefix.textContent = q.p.kod; rest.textContent = '12345';
    $('wkPrompt').textContent = 'Jaki to powiat?';
  }
  const plate = $('wkPlate');
  plate.classList.remove('rolling'); void plate.offsetWidth; plate.classList.add('rolling');

  $('wkOptions').querySelectorAll('.q-option').forEach((b, i) => {
    b.classList.remove('good', 'bad', 'dim');
    b.classList.toggle('kod-style', q.reverse);
    b.disabled = false;
    const t = b.querySelector('.text');
    if (t) t.textContent = q.opts[i] ? q.opts[i].label : '—';
  });
}

function wkPick(idx){
  if (wk.locked) return;
  const q = wk.qs[wk.idx];
  const opt = q.opts[idx];
  if (!opt) return;
  wk.locked = true;
  const correctIdx = q.opts.findIndex(o => o.correct);
  const good = !!opt.correct;
  wk.marks[wk.idx] = good;

  $('wkOptions').querySelectorAll('.q-option').forEach((b, i) => {
    b.disabled = true;
    if (i === idx) b.classList.add(good ? 'good' : 'bad');
    else if (i === correctIdx && !good) b.classList.add('good');
    else b.classList.add('dim');
  });
  wkRenderDots();

  setTimeout(() => {
    wk.locked = false;
    wk.idx++;
    if (wk.idx >= wk.qs.length) wkFinish();
    else wkRenderQuestion();
  }, good ? 650 : 1100);
}

function wkFinish(){
  const score = wk.marks.filter(Boolean).length;
  if (!wk.practice){
    weeklySave({ weekKey: wk.weekKey, score, marks: wk.marks, done: true });
  }
  wkShowSummary(wk.weekKey, score, wk.marks, wk.practice);
}

function wkShowSummary(weekKey, score, marks, practice){
  $('wkGame').style.display = 'none';
  $('wkSummary').style.display = 'block';
  $('wkScore').textContent = score;
  $('wkMeta').innerHTML = (practice ? 'Trening · ' : '') + '<strong>' + wk.label + '</strong>';
  $('wkGrid').textContent = marks.map(m => m ? '🟩' : '🟥').join('');
  const trophy = $('wkSummary').querySelector('.summary-trophy');
  if (trophy) trophy.textContent = score === 10 ? '🏆' : score >= 7 ? '🥇' : score >= 4 ? '💪' : '📚';
}

function wkStart(practice){
  buildWeeklySet();
  wk.idx = 0;
  wk.marks = new Array(WK_N).fill(null);
  wk.practice = !!practice;
  wk.locked = false;
  $('wkSummary').style.display = 'none';
  $('wkGame').style.display = 'flex';
  $('wkSub').textContent = wk.label + (practice ? ' · trening' : '');
  wkRenderQuestion();
}

function openWeekly(){
  buildWeeklySet();
  $('wkSub').textContent = wk.label;
  const saved = weeklyLoad();
  $('weeklyScreen').classList.add('open');
  if (saved && saved.done && saved.weekKey === wk.weekKey){
    // Official result already exists this week → show it
    wkShowSummary(saved.weekKey, saved.score, saved.marks || [], false);
  } else {
    wkStart(false);
  }
}

function closeWeekly(){
  $('weeklyScreen').classList.remove('open');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === 'modes'));
}

async function shareWeeklyResult(){
  const saved = weeklyLoad();
  const marks = (saved && saved.weekKey === wk.weekKey && saved.marks) ? saved.marks : wk.marks;
  const score = (saved && saved.weekKey === wk.weekKey && saved.done) ? saved.score : wk.marks.filter(Boolean).length;
  const grid = (marks || []).map(m => m ? '🟩' : '🟥').join('');
  const text = `Tablice PL — ${wk.label}\n${score}/10\n${grid}`;
  try{
    if (navigator.share){
      await navigator.share({ title: 'Tablice PL — Wyzwanie tygodnia', text });
    } else if (navigator.clipboard){
      await navigator.clipboard.writeText(text);
      flash('Skopiowano!', 'good');
    }
  } catch(e){}
}

function initWeekly(){
  $('btnWeeklyExit').addEventListener('click', closeWeekly);
  $('btnWkShare').addEventListener('click', shareWeeklyResult);
  $('btnWkTrain').addEventListener('click', () => wkStart(true));
  const startBtn = $('btnWeeklyStart');
  if (startBtn) startBtn.addEventListener('click', () => {
    closeSheet('modesSheet');
    selectTab('weekly');
  });
  $('wkOptions').addEventListener('click', e => {
    const b = e.target.closest('.q-option');
    if (!b) return;
    wkPick(parseInt(b.dataset.opt, 10));
  });
}
document.addEventListener('DOMContentLoaded', initWeekly);
