/* ============================================================
   QUIZ TYGODNIA — Quiz of the Week
   A fixed set of 10 questions, deterministic per ISO week, so
   everyone gets the same quiz that week and can compare results.
   Self-contained overlay (mirrors the all-plates screen pattern).
   ============================================================ */
'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const WEEKLY_KEY = 'tabliceApp_weekly_v1';
  const N = 10;
  const MONTHS = ['sty','lut','mar','kwi','maj','cze','lip','sie','wrz','paź','lis','gru'];

  /* ─── DATE / WEEK ─── */
  function isoWeek(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = (date.getUTCDay() + 6) % 7;          // Mon=0 … Sun=6
    date.setUTCDate(date.getUTCDate() - dayNum + 3);    // nearest Thursday
    const firstThu = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((date - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return { year: date.getUTCFullYear(), week };
  }
  function curWeek() { return isoWeek(new Date()); }
  function weekId() { const { year, week } = curWeek(); return year * 100 + week; }
  function weekRange() {
    const now = new Date();
    const day = (now.getDay() + 6) % 7;                 // Mon=0
    const mon = new Date(now); mon.setDate(now.getDate() - day); mon.setHours(0, 0, 0, 0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const fmt = d => d.getDate() + ' ' + MONTHS[d.getMonth()];
    return fmt(mon) + ' – ' + fmt(sun);
  }

  /* ─── SEEDED RNG (mulberry32) ─── */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function shuffleRng(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /* ─── TEXT HELPERS ─── */
  function norm(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/ł/g, 'l').replace(/[^a-z0-9 ]/g, '').trim();
  }
  function cleanName(n) { return n.replace(/\s*\([^)]*\)/g, '').trim(); }

  /* ─── DETERMINISTIC QUESTION SET ─── */
  function buildQuestion(correct, rng) {
    const firstLetter = norm(correct.nazwa)[0] || '';
    const seen = new Set([norm(cleanName(correct.nazwa))]);
    const sameLetter = [];
    for (const p of window.POWIATY) {
      const nb = norm(cleanName(p.nazwa));
      if (seen.has(nb)) continue;
      if (norm(p.nazwa)[0] !== firstLetter) continue;
      seen.add(nb); sameLetter.push(p);
    }
    shuffleRng(sameLetter, rng);
    let picks = sameLetter.slice(0, 3);
    if (picks.length < 3) {
      const others = window.POWIATY.filter(p => !seen.has(norm(cleanName(p.nazwa))));
      shuffleRng(others, rng);
      for (const p of others) {
        if (picks.length >= 3) break;
        seen.add(norm(cleanName(p.nazwa)));
        picks.push(p);
      }
    }
    const opts = [{ label: cleanName(correct.nazwa), correct: true }]
      .concat(picks.map(p => ({ label: cleanName(p.nazwa), correct: false })));
    shuffleRng(opts, rng);
    return { correct, options: opts, correctIdx: opts.findIndex(o => o.correct) };
  }
  function buildSet() {
    const rng = mulberry32((weekId() ^ 0x9e3779b9) >>> 0);
    const pool = window.POWIATY.slice();
    shuffleRng(pool, rng);
    return pool.slice(0, N).map(c => buildQuestion(c, rng));
  }

  /* ─── PERSISTENCE ─── */
  function loadAll() { try { return JSON.parse(localStorage.getItem(WEEKLY_KEY) || '{}'); } catch (e) { return {}; } }
  function saveAll(o) { try { localStorage.setItem(WEEKLY_KEY, JSON.stringify(o)); } catch (e) {} }
  function getBest() { return loadAll()[weekId()] || null; }
  function setBest(rec) { const all = loadAll(); all[weekId()] = rec; saveAll(all); }

  /* ─── RUN STATE ─── */
  const wk = { questions: [], idx: 0, results: [], answered: false, score: 0, streak: 0, bestStreak: 0, practice: false, isBest: false };

  /* ─── SCREEN STATE SWITCHER ─── */
  function showState(name) {
    $('wkIntro').hidden = name !== 'intro';
    $('wkQuiz').hidden = name !== 'quiz';
    $('wkResult').hidden = name !== 'result';
    $('wkProgressBar').hidden = name !== 'quiz';
    $('wkCountBadge').hidden = name !== 'quiz';
    // footer buttons
    $('wkStart').hidden = name !== 'intro';
    $('wkNext').hidden = true;
    $('wkShare').hidden = name !== 'result';
    $('wkReplay').hidden = name !== 'result';
    $('wkFooter').hidden = false;
  }

  /* ─── INTRO ─── */
  function renderIntro() {
    const { week } = curWeek();
    $('wkWeekLabel').textContent = 'Tydzień #' + week;
    $('wkHeroWeek').textContent = 'TYDZIEŃ #' + week;
    $('wkHeroDates').textContent = weekRange();

    const best = getBest();
    const bestEl = $('wkBest');
    if (best) {
      bestEl.classList.add('done');
      $('wkBestIco').textContent = best.score >= 8 ? '🏆' : best.score >= 5 ? '✅' : '🎯';
      $('wkBestLabel').textContent = 'Twój najlepszy wynik';
      $('wkBestValue').textContent = best.score + '/10 · trafność ' + Math.round(best.score / N * 100) + '%';
      $('wkBestGrid').textContent = gridStr(best.results);
      $('wkStart').textContent = 'Zagraj ponownie →';
    } else {
      bestEl.classList.remove('done');
      $('wkBestIco').textContent = '🎯';
      $('wkBestLabel').textContent = 'Twój wynik w tym tygodniu';
      $('wkBestValue').textContent = 'Jeszcze nie grałeś';
      $('wkBestGrid').textContent = '';
      $('wkStart').textContent = 'Zacznij quiz →';
    }
    refreshLauncher();
  }

  function gridStr(results) { return (results || []).map(r => r ? '🟩' : '🟥').join(''); }

  /* ─── START ─── */
  function start(practice) {
    wk.questions = buildSet();
    wk.idx = 0;
    wk.results = [];
    wk.score = 0;
    wk.streak = 0;
    wk.bestStreak = 0;
    wk.answered = false;
    wk.practice = !!practice;
    showState('quiz');
    renderQuestion();
  }

  function renderQuestion() {
    const q = wk.questions[wk.idx];
    wk.answered = false;
    $('wkCountBadge').textContent = (wk.idx + 1) + '/' + N;
    $('wkProgressFill').style.width = (wk.idx / N * 100) + '%';
    $('wkQPrompt').innerHTML = 'Jaki to powiat?';

    const plate = $('wkPlate');
    $('wkPlateCode').textContent = q.correct.kod;
    plate.classList.remove('flip'); void plate.offsetWidth; plate.classList.add('flip');

    const btns = $('wkOptions').querySelectorAll('.wk-option');
    btns.forEach((b, i) => {
      b.classList.remove('good', 'bad', 'dim');
      b.disabled = false;
      const t = b.querySelector('.text');
      if (t) t.textContent = q.options[i] ? q.options[i].label : '—';
    });

    const rev = $('wkReveal');
    rev.classList.remove('show', 'good', 'bad');
    $('wkNext').hidden = true;
    $('wkFooter').hidden = true; // no footer button while choosing
  }

  function pick(idx) {
    if (wk.answered) return;
    const q = wk.questions[wk.idx];
    if (idx < 0 || idx >= q.options.length) return;
    wk.answered = true;
    const correct = !!q.options[idx].correct;
    wk.results.push(correct);

    const btns = $('wkOptions').querySelectorAll('.wk-option');
    btns.forEach((b, i) => {
      b.disabled = true;
      if (i === idx) b.classList.add(correct ? 'good' : 'bad');
      else if (i === q.correctIdx && !correct) b.classList.add('good');
      else b.classList.add('dim');
    });

    if (correct) {
      wk.score++;
      wk.streak++;
      if (wk.streak > wk.bestStreak) wk.bestStreak = wk.streak;
      if (typeof flash === 'function') flash(wk.streak >= 3 ? '🔥 ×' + wk.streak : '✓', wk.streak >= 3 ? 'fire' : 'good');
    } else {
      wk.streak = 0;
      if (typeof flash === 'function') flash('BŁĄD', 'bad');
    }

    // reveal
    const p = q.correct;
    const rev = $('wkReveal');
    rev.classList.add('show', correct ? 'good' : 'bad');
    $('wkRevealIco').innerHTML = correct
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const woj = p.woj.charAt(0).toUpperCase() + p.woj.slice(1);
    $('wkRevealText').innerHTML =
      '<span class="v">' + (correct ? 'Dobrze!' : 'Niestety nie') + '</span>' +
      '<strong>' + p.kod + '</strong> = <strong>' + p.nazwa + '</strong> · woj. ' + woj;

    $('wkProgressFill').style.width = ((wk.idx + 1) / N * 100) + '%';

    // footer: Dalej / Zobacz wynik
    const next = $('wkNext');
    next.textContent = wk.idx + 1 >= N ? 'Zobacz wynik →' : 'Dalej →';
    next.hidden = false;
    $('wkFooter').hidden = false;
  }

  function next() {
    if (!wk.answered) return;
    if (wk.idx + 1 >= N) { finish(); return; }
    wk.idx++;
    renderQuestion();
  }

  /* ─── FINISH / RESULT ─── */
  function finish() {
    const best = getBest();
    wk.isBest = !best || wk.score > best.score;
    if (wk.isBest) {
      setBest({ score: wk.score, results: wk.results.slice(), streak: wk.bestStreak, ts: Date.now() });
    }

    showState('result');
    const s = wk.score;
    $('wkResultScore').textContent = s;
    $('wkResultTrophy').textContent = s >= 9 ? '🏆' : s >= 7 ? '🎉' : s >= 5 ? '👍' : '📚';
    $('wkResultLabel').innerHTML = s >= 9 ? 'Mistrz tablic! <b>' + s + '/10</b>'
      : s >= 7 ? 'Świetny wynik!'
      : s >= 5 ? 'Nieźle, idzie ci!'
      : 'Jeszcze poćwicz — dasz radę!';
    $('wkResultGrid').textContent = gridStr(wk.results);
    $('wkResultAcc').textContent = Math.round(s / N * 100) + '%';
    $('wkResultStreak').textContent = '×' + wk.bestStreak;
    $('wkProgressFill').style.width = '100%';

    const nb = $('wkNewBest');
    nb.classList.toggle('show', wk.isBest && !wk.practice ? true : wk.isBest);
    if (s >= 8 && typeof fireConfetti === 'function') fireConfetti(null);

    refreshLauncher();
  }

  /* ─── SHARE ─── */
  function shareText() {
    const { week } = curWeek();
    const grid = gridStr(wk.results);
    const url = (location && location.href ? location.href.split('#')[0] : '');
    return '🚗 Quiz Tygodnia #' + week + ' — Tablice PL\n' +
           'Wynik: ' + wk.score + '/10' + (wk.bestStreak >= 3 ? '  🔥 seria ×' + wk.bestStreak : '') + '\n' +
           grid + '\n' +
           'Ograsz mnie? 👇\n' + url;
  }
  async function share() {
    const text = shareText();
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Quiz Tygodnia — Tablice PL', text });
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        if (typeof flash === 'function') flash('Skopiowano!', 'good');
      } else {
        const t = document.createElement('textarea');
        t.value = text; document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); if (typeof flash === 'function') flash('Skopiowano!', 'good'); } catch (e) {}
        t.remove();
      }
    } catch (e) { /* user cancelled */ }
  }

  /* ─── OPEN / CLOSE ─── */
  function open() {
    renderIntro();
    showState('intro');
    $('weeklyScreen').classList.add('open');
  }
  function close() {
    $('weeklyScreen').classList.remove('open');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === 'modes'));
    refreshLauncher();
  }
  /* "Przejdź dalej" from the result screen → leave the weekly quiz and drop the
     player straight into the normal multiple-choice quiz. */
  function goToQuiz() {
    close();
    if (window.setUserMode) window.setUserMode('quiz');
  }
  function handleBack() {
    // From result/quiz → back to intro; from intro → close.
    if (!$('wkIntro').hidden) { close(); return; }
    if (!$('wkResult').hidden) { renderIntro(); showState('intro'); return; }
    // In the middle of a quiz: confirm to avoid losing progress
    if (wk.idx > 0 && !wk.answered) {
      if (!confirm('Przerwać quiz? Postęp w tej rundzie przepadnie.')) return;
    }
    renderIntro(); showState('intro');
  }

  /* Update the launcher card inside the modes sheet to reflect this week. */
  function refreshLauncher() {
    const badge = $('weeklyLauncherBadge');
    const desc = $('weeklyLauncherDesc');
    if (!badge) return;
    const best = getBest();
    const { week } = curWeek();
    if (best) {
      badge.textContent = best.score + '/10';
      badge.classList.add('done');
      if (desc) desc.textContent = 'Tydzień #' + week + ' · Twój wynik: ' + best.score + '/10. Pobij rekord!';
    } else {
      badge.textContent = 'Nowy';
      badge.classList.remove('done');
      if (desc) desc.textContent = 'Tydzień #' + week + ' · nowy zestaw 10 tablic. Udostępnij wynik znajomym!';
    }
  }

  /* ─── WIRING ─── */
  function init() {
    const launcher = $('btnWeeklyStart');
    if (launcher) launcher.addEventListener('click', () => {
      if (typeof closeSheet === 'function') closeSheet('modesSheet');
      open();
    });

    $('wkBack').addEventListener('click', handleBack);
    $('wkStart').addEventListener('click', () => start(false));
    $('wkNext').addEventListener('click', next);
    $('wkShare').addEventListener('click', share);
    $('wkReplay').addEventListener('click', goToQuiz);

    $('wkOptions').addEventListener('click', e => {
      const b = e.target.closest('.wk-option');
      if (!b) return;
      pick(parseInt(b.dataset.opt, 10));
    });

    document.addEventListener('keydown', e => {
      const scr = $('weeklyScreen');
      if (!scr || !scr.classList.contains('open')) return;
      if (e.key === 'Escape') { e.preventDefault(); handleBack(); }
      else if (e.key === 'Enter' && !$('wkNext').hidden) { e.preventDefault(); next(); }
    });

    refreshLauncher();
  }

  document.addEventListener('DOMContentLoaded', init);
  window.WeeklyQuiz = { open, close, refreshLauncher };
})();
