/* 写字 Xiězì — handwriting → pinyin → sentences. All client-side. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- state
  var dict = null;          // rows: [simp, trad, pinyin, defs, usage, hsk]
  var dialogs = null;       // everyday dialogues [{e, t, d, lines: [[who, zh, en]]}]
  var chars = null;         // char -> [etyType, hint, semantic, phonetic, components, radical]
  var medians = null;       // char -> encoded stroke medians (shape matching + stroke-order animation)
  var shapeBuckets = null;  // strokeCount -> [[char, normalized strokes], ...]
  var sentences = null;     // rows: [zh(simplified), en]
  var exactIndex = null;    // word (simp or trad) -> [row indices]
  var t2s = null;           // traditional char -> simplified char
  var charPinyin = null;    // simplified word -> pinyin (best entry), for ruby
  var maxWordLen = 1;
  var word = '';            // composer buffer
  var sentMatches = [];
  var sentShown = 0;
  var recognizerReady = false;

  // ---------------------------------------------------------------- pinyin
  var TONE_VOWELS = { a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', 'ü': 'ǖǘǚǜ' };

  function syllableToMark(syl) {
    var tone = 0;
    var m = syl.match(/([1-5])$/);
    if (m) { tone = +m[1]; syl = syl.slice(0, -1); }
    syl = syl.replace(/u:/g, 'ü').replace(/U:/g, 'Ü');
    if (tone >= 1 && tone <= 4) {
      var lower = syl.toLowerCase(), idx = -1;
      if (lower.indexOf('a') >= 0) idx = lower.indexOf('a');
      else if (lower.indexOf('e') >= 0) idx = lower.indexOf('e');
      else if (lower.indexOf('ou') >= 0) idx = lower.indexOf('ou');
      else {
        for (var i = lower.length - 1; i >= 0; i--) {
          if ('iouü'.indexOf(lower[i]) >= 0) { idx = i; break; }
        }
      }
      if (idx >= 0) {
        var ch = syl[idx], base = ch.toLowerCase();
        var marked = (TONE_VOWELS[base] || base)[tone - 1] || ch;
        if (ch !== base) marked = marked.toUpperCase();
        syl = syl.slice(0, idx) + marked + syl.slice(idx + 1);
      }
    }
    return { text: syl, tone: tone };
  }

  // "ai4 qing2" -> html spans colored by tone
  function pinyinHtml(numbered) {
    return numbered.split(/\s+/).map(function (syl) {
      if (!/[a-zA-ZüÜ]/.test(syl)) return esc(syl);
      var r = syllableToMark(syl);
      return '<span class="t' + r.tone + '">' + esc(r.text) + '</span>';
    }).join(' ');
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------------------------------------------------------- data loading
  var loadbar = document.createElement('div');
  loadbar.className = 'loadbar';
  document.body.appendChild(loadbar);
  var loadSteps = 0;
  function step() {
    loadSteps++;
    loadbar.style.width = (loadSteps / 6 * 100) + '%';
    if (loadSteps >= 6) setTimeout(function () { loadbar.remove(); }, 600);
  }

  fetch('data/dict.json')
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      dict = rows;
      buildIndexes();
      renderRules();
      step();
      refresh();
      return fetch('data/medians.json');
    })
    .then(function (r) { return r.json(); })
    .then(function (map) {
      medians = map;
      buildShapeIndex();
      step();
      refresh();
      return fetch('data/chars.json');
    })
    .then(function (r) { return r.json(); })
    .then(function (map) {
      chars = map;
      step();
      refresh();
      return fetch('data/dialogs.json');
    })
    .then(function (r) { return r.json(); })
    .then(function (list) {
      dialogs = list;
      renderDlgList();
      step();
      return fetch('data/sentences.json');
    })
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      sentences = rows;
      step();
      refresh();
      buildDataReady();
    })
    .catch(function (e) {
      $('sentStatus').textContent = 'Failed to load data: ' + e;
    });

  function buildIndexes() {
    exactIndex = new Map();
    t2s = new Map();
    charPinyin = new Map();
    var best = new Map(); // word -> usage of entry that provided its pinyin
    for (var i = 0; i < dict.length; i++) {
      var row = dict[i];
      var simp = row[0], trad = row[1];
      push(exactIndex, simp, i);
      if (trad && trad !== simp) push(exactIndex, trad, i);
      if (simp.length > maxWordLen) maxWordLen = Math.min(4, simp.length);
      if (trad.length === 1 && simp.length === 1 && !t2s.has(trad)) t2s.set(trad, simp);
      var u = row[4];
      if (!best.has(simp) || u > best.get(simp)) {
        best.set(simp, u);
        charPinyin.set(simp, row[2]);
      }
    }
    function push(map, k, v) {
      var a = map.get(k);
      if (a) a.push(v); else map.set(k, [v]);
    }
  }

  function toSimp(s) {
    if (!t2s) return s;
    var out = '';
    for (var i = 0; i < s.length; i++) out += t2s.get(s[i]) || s[i];
    return out;
  }

  // ---------------------------------------------------------------- handwriting pad
  var pad = $('pad');
  var ctx = pad.getContext('2d');
  var strokes = [];       // finished strokes (arrays of [x,y] in canvas css px)
  var current = null;
  var drawing = false;

  function sizePad() {
    var cssW = pad.clientWidth || 300;
    var dpr = window.devicePixelRatio || 1;
    pad.height = pad.width = Math.round(cssW * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  window.addEventListener('resize', sizePad);

  function inkStyle() {
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = getComputedStyle(document.body).color;
  }

  function redraw() {
    ctx.clearRect(0, 0, pad.width, pad.height);
    inkStyle();
    strokes.concat(current ? [current] : []).forEach(function (st) {
      ctx.beginPath();
      ctx.moveTo(st[0][0], st[0][1]);
      for (var i = 1; i < st.length; i++) ctx.lineTo(st[i][0], st[i][1]);
      ctx.stroke();
    });
  }

  function pos(ev) {
    var r = pad.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  pad.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    pad.setPointerCapture(ev.pointerId);
    drawing = true;
    current = [pos(ev)];
    inkStyle();
  });
  pad.addEventListener('pointermove', function (ev) {
    if (!drawing) return;
    var p = pos(ev);
    var last = current[current.length - 1];
    current.push(p);
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  });
  function endStroke() {
    if (!drawing) return;
    drawing = false;
    if (current && current.length > 1) {
      strokes.push(current);
      recognize();
    }
    current = null;
  }
  pad.addEventListener('pointerup', endStroke);
  pad.addEventListener('pointercancel', endStroke);

  $('undoStroke').addEventListener('click', function () {
    strokes.pop();
    redraw();
    if (strokes.length) recognize(); else clearCandidates();
  });
  $('clearPad').addEventListener('click', clearPad);

  function clearPad() {
    strokes = [];
    current = null;
    redraw();
    clearCandidates();
  }
  function clearCandidates() {
    $('candidates').innerHTML = '';
    setPadStatus(recognizerReady ? '' : 'loading recognizer…');
  }
  function setPadStatus(msg) {
    var el = $('padStatus');
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }

  // ---- shape matcher: order- and direction-independent stroke matching ----
  var ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-';
  var ALPHA_IDX = {};
  for (var ai = 0; ai < ALPHA.length; ai++) ALPHA_IDX[ALPHA[ai]] = ai;
  var SHAPE_K = 10; // points per stroke in medians data

  function decodeMedians(str) {
    var per = SHAPE_K * 2;
    var n = str.length / per;
    var strokes = [];
    for (var s = 0; s < n; s++) {
      var arr = new Float32Array(per);
      for (var i = 0; i < per; i++) arr[i] = ALPHA_IDX[str[s * per + i]] / 63;
      strokes.push(arr);
    }
    return strokes;
  }

  // uniform scale to bounding box, centered in unit square
  function normalizeShape(strokes) {
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    strokes.forEach(function (st) {
      for (var i = 0; i < st.length; i += 2) {
        if (st[i] < minX) minX = st[i];
        if (st[i] > maxX) maxX = st[i];
        if (st[i + 1] < minY) minY = st[i + 1];
        if (st[i + 1] > maxY) maxY = st[i + 1];
      }
    });
    var scale = Math.max(maxX - minX, maxY - minY, 1e-6);
    var ox = (scale - (maxX - minX)) / 2, oy = (scale - (maxY - minY)) / 2;
    return strokes.map(function (st) {
      var out = new Float32Array(st.length);
      for (var i = 0; i < st.length; i += 2) {
        out[i] = (st[i] - minX + ox) / scale;
        out[i + 1] = (st[i + 1] - minY + oy) / scale;
      }
      return out;
    });
  }

  function buildShapeIndex() {
    shapeBuckets = {};
    for (var ch in medians) {
      var strokes = normalizeShape(decodeMedians(medians[ch]));
      var n = strokes.length;
      (shapeBuckets[n] = shapeBuckets[n] || []).push([ch, strokes]);
    }
  }

  function resamplePoints(pts, k) {
    if (pts.length === 1) pts = [pts[0], pts[0]];
    var dists = [0];
    for (var i = 1; i < pts.length; i++) {
      dists.push(dists[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    var total = dists[dists.length - 1] || 1;
    var out = new Float32Array(k * 2);
    var j = 0;
    for (var t = 0; t < k; t++) {
      var target = total * t / (k - 1);
      while (j < dists.length - 2 && dists[j + 1] < target) j++;
      var seg = dists[j + 1] - dists[j] || 1;
      var f = (target - dists[j]) / seg;
      out[t * 2] = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f;
      out[t * 2 + 1] = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f;
    }
    return out;
  }

  // mean squared point distance, direction-independent
  function strokeDist(a, b) {
    var fwd = 0, rev = 0, K = SHAPE_K;
    for (var i = 0; i < K; i++) {
      var ax = a[i * 2], ay = a[i * 2 + 1];
      var dxf = ax - b[i * 2], dyf = ay - b[i * 2 + 1];
      fwd += dxf * dxf + dyf * dyf;
      var ri = K - 1 - i;
      var dxr = ax - b[ri * 2], dyr = ay - b[ri * 2 + 1];
      rev += dxr * dxr + dyr * dyr;
    }
    return Math.min(fwd, rev) / K;
  }

  // greedy stroke-to-stroke assignment cost, order-independent
  function assignCost(drawn, ref) {
    var m = drawn.length, n = ref.length;
    var pairs = [];
    for (var i = 0; i < m; i++) {
      for (var j = 0; j < n; j++) pairs.push([strokeDist(drawn[i], ref[j]), i, j]);
    }
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    var usedD = new Array(m), usedR = new Array(n);
    var total = 0, matched = 0;
    for (var p = 0; p < pairs.length && matched < Math.min(m, n); p++) {
      var pr = pairs[p];
      if (usedD[pr[1]] || usedR[pr[2]]) continue;
      usedD[pr[1]] = usedR[pr[2]] = true;
      total += pr[0];
      matched++;
    }
    total += 0.12 * (m + n - 2 * matched); // unmatched stroke penalty
    return total / Math.max(m, n);
  }

  function shapeMatch(rawStrokes, limit) {
    var drawn = normalizeShape(rawStrokes.map(function (st) { return resamplePoints(st, SHAPE_K); }));
    var m = drawn.length;
    var results = [];
    for (var n = Math.max(1, m - 1); n <= m + 1; n++) {
      var bucket = shapeBuckets[n];
      if (!bucket) continue;
      for (var b = 0; b < bucket.length; b++) {
        results.push([bucket[b][0], assignCost(drawn, bucket[b][1])]);
      }
    }
    results.sort(function (a, b) { return a[1] - b[1]; });
    return results.slice(0, limit).map(function (r) { return r[0]; });
  }

  // recognition: two stroke-order engines + the shape matcher, merged by vote
  var DATASETS = [['mmah', 'data/mmah.json'], ['orig', 'data/orig.json']];
  var loadedSets = [];
  var initDone = 0;
  DATASETS.forEach(function (ds) {
    HanziLookup.init(ds[0], ds[1], function (ok) {
      initDone++;
      if (ok) loadedSets.push(ds[0]);
      recognizerReady = loadedSets.length > 0;
      if (recognizerReady) setPadStatus(strokes.length ? '' : '');
      else if (initDone === DATASETS.length) setPadStatus('recognizer failed to load');
      if (recognizerReady && strokes.length) recognize();
    });
  });

  var recogSeq = 0;
  function recognize() {
    if (!recognizerReady && !shapeBuckets) { setPadStatus('recognizer still loading…'); return; }
    setPadStatus('');
    var seq = ++recogSeq;
    var votes = new Map();
    function addVotes(list, weight) {
      list.forEach(function (ch, i) {
        votes.set(ch, (votes.get(ch) || 0) + (14 - i) * weight);
      });
    }
    // shape matcher: order/direction independent, double weight so beginners
    // with unconventional stroke order still get the right character on top
    if (shapeBuckets) addVotes(shapeMatch(strokes, 12), 2);
    var pending = loadedSets.length;
    if (!pending) { if (seq === recogSeq) showCandidates(votes); return; }
    var analyzed = new HanziLookup.AnalyzedCharacter(strokes);
    loadedSets.forEach(function (name) {
      new HanziLookup.Matcher(name).match(analyzed, 12, function (matches) {
        addVotes((matches || []).map(function (m) { return m.character; }), 1);
        if (--pending === 0 && seq === recogSeq) showCandidates(votes);
      });
    });
  }

  function showCandidates(best) {
    var ranked = Array.from(best.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 10);
    var box = $('candidates');
    box.innerHTML = '';
    ranked.forEach(function (entry) {
      var b = document.createElement('button');
      b.textContent = entry[0];
      b.addEventListener('click', function () {
        setWord(word + entry[0]);
        clearPad();
      });
      box.appendChild(b);
    });
    if (!ranked.length) setPadStatus('no match — try again');
  }

  sizePad();

  // reusable: rank candidate characters for a set of strokes (used by the
  // sentence-writing pad too) — same merged shape + stroke-order engines
  function rankStrokes(rawStrokes, limit, cb) {
    var votes = new Map();
    function addVotes(list, weight) {
      list.forEach(function (ch, i) { votes.set(ch, (votes.get(ch) || 0) + (14 - i) * weight); });
    }
    if (shapeBuckets) addVotes(shapeMatch(rawStrokes, 12), 2);
    var pending = loadedSets.length;
    function done() {
      cb(Array.from(votes.entries()).sort(function (a, b) { return b[1] - a[1]; })
        .slice(0, limit).map(function (e) { return e[0]; }));
    }
    if (!pending) { done(); return; }
    var analyzed = new HanziLookup.AnalyzedCharacter(rawStrokes);
    loadedSets.forEach(function (name) {
      new HanziLookup.Matcher(name).match(analyzed, 12, function (matches) {
        addVotes((matches || []).map(function (m) { return m.character; }), 1);
        if (--pending === 0) done();
      });
    });
  }

  // ---------------------------------------------------------------- composer
  function setWord(w) {
    word = w;
    if ($('typeInput').value !== w) $('typeInput').value = w;
    renderComposer();
    refresh();
  }

  function renderComposer() {
    var el = $('composedWord');
    el.innerHTML = '';
    if (!word) {
      el.innerHTML = '<span class="placeholder">Draw a character below ↓</span>';
      return;
    }
    word.split('').forEach(function (ch, i) {
      var s = document.createElement('span');
      s.className = 'cchar';
      s.textContent = ch;
      s.title = 'Remove';
      s.addEventListener('click', function () {
        setWord(word.slice(0, i) + word.slice(i + 1));
      });
      el.appendChild(s);
    });
  }

  $('backspace').addEventListener('click', function () { setWord(word.slice(0, -1)); });
  $('clearWord').addEventListener('click', function () { setWord(''); });
  $('typeInput').addEventListener('input', function () {
    setWord(this.value.trim().slice(0, 20));
  });
  $('speakWord').addEventListener('click', function () { speak(word); });

  // voice + speed preference (shared by all speech in the app)
  var voiceCfg = (function () {
    var c;
    try { c = JSON.parse(localStorage.getItem('xiezi.voice')) || {}; } catch (e) { c = {}; }
    if (typeof c.rate !== 'number') c.rate = 0.85;
    c.uri = c.uri || '';
    return c;
  })();
  function saveVoiceCfg() { try { localStorage.setItem('xiezi.voice', JSON.stringify(voiceCfg)); } catch (e) {} }
  function pickedVoice() {
    if (!voiceCfg.uri || !window.speechSynthesis) return null;
    var vs = speechSynthesis.getVoices();
    for (var i = 0; i < vs.length; i++) if (vs[i].voiceURI === voiceCfg.uri) return vs[i];
    return null;
  }
  function applyVoice(u) {
    u.lang = 'zh-CN';
    u.rate = voiceCfg.rate || 0.85;
    var v = pickedVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
  }

  function speak(text) {
    if (!text || !window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text);
    applyVoice(u);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  // ---------------------------------------------------------------- dictionary view
  function refresh() {
    renderDict();
    renderSentences();
  }

  function hskBadge(lvl) {
    return lvl ? ' <span class="badge">HSK ' + lvl + '</span>' : '';
  }

  function renderDict() {
    var card = $('dictCard');
    if (!word || !dict) { card.hidden = true; return; }
    card.hidden = false;
    var out = $('dictResults');
    var idxs = exactIndex.get(word) || exactIndex.get(toSimp(word)) || [];
    if (!idxs.length) {
      var noEntry = '<p class="muted">No exact dictionary entry for “' + esc(word) + '”.' +
        (word.length > 1 ? ' See sentences below, or check the character breakdown:' : '') + '</p>';
      if (word.length === 1) {
        var info = charInfo(word);
        if (info && info[6]) noEntry += '<div class="entry"><div class="head"><span class="hz">' + esc(word) + '</span></div><p class="def">' + esc(info[6]) + '</p></div>';
        noEntry += howtoHtml(word) + originHtml(word);
      }
      out.innerHTML = noEntry + (word.length > 1 ? word.split('').map(charRowHtml).join('') : '');
    } else {
      out.innerHTML = idxs.map(function (i) { return entryHtml(dict[i]); }).join('');
      if (word.length > 1) out.innerHTML += word.split('').map(charRowHtml).join('');
    }
    bindSpeakButtons(out);
    bindPartButtons(out);
    initAnims(out);
    renderSuggestions();
  }

  function charRowHtml(ch) {
    var idxs = exactIndex.get(ch) || exactIndex.get(toSimp(ch)) || [];
    if (!idxs.length) return '';
    return entryHtml(dict[idxs[0]]);
  }

  function entryHtml(row) {
    var simp = row[0], trad = row[1], pin = row[2], defs = row[3], hsk = row[5];
    return '<div class="entry"><div class="head">' +
      '<span class="hz">' + esc(simp) + '</span>' +
      (trad ? '<span class="trad">(' + esc(trad) + ')</span>' : '') +
      '<span class="py">' + pinyinHtml(pin) + '</span>' +
      hskBadge(hsk) +
      '<button class="speak" data-say="' + esc(simp) + '" title="Speak">🔊</button>' +
      '</div><p class="def">' + esc(defs) + '</p>' +
      (simp.length === 1 ? howtoHtml(simp) + originHtml(simp) : '') +
      '</div>';
  }

  // --- stroke order animation (medians data) ---
  function howtoChar(ch) {
    if (!medians) return null;
    if (medians[ch]) return ch;
    var s = toSimp(ch);
    return medians[s] ? s : null;
  }

  function howtoHtml(ch) {
    var target = howtoChar(ch);
    if (!target) return '';
    return '<div class="howto">' +
      '<canvas class="stroke-anim" data-char="' + esc(target) + '"></canvas>' +
      '<div class="howto-note">How to write it<br><span>stroke by stroke — tap to replay</span></div>' +
      '</div>';
  }

  function initAnims(scope) {
    scope.querySelectorAll('canvas.stroke-anim').forEach(function (cv) {
      var animate = makeStrokeAnimator(cv, cv.getAttribute('data-char'));
      cv.addEventListener('click', animate);
      animate();
    });
  }

  function makeStrokeAnimator(canvas, ch) {
    var CSS = 108;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.height = Math.round(CSS * dpr);
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var strokes = decodeMedians(medians[ch]);
    var pad = 6, size = CSS - 2 * pad;
    var pts = strokes.map(function (st) {
      var p = [];
      for (var i = 0; i < st.length; i += 2) p.push([pad + st[i] * size, pad + st[i + 1] * size]);
      return p;
    });
    var lens = pts.map(function (p) {
      var acc = [0];
      for (var i = 1; i < p.length; i++) {
        acc.push(acc[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
      }
      return acc;
    });

    function path(p, upto) {
      g.beginPath();
      g.moveTo(p[0][0], p[0][1]);
      var end = upto === undefined ? p.length : upto;
      for (var i = 1; i < end; i++) g.lineTo(p[i][0], p[i][1]);
    }

    function drawPartial(s, dist) {
      var p = pts[s], acc = lens[s];
      g.beginPath();
      g.moveTo(p[0][0], p[0][1]);
      for (var i = 1; i < p.length; i++) {
        if (acc[i] <= dist) { g.lineTo(p[i][0], p[i][1]); continue; }
        var seg = acc[i] - acc[i - 1] || 1;
        var f = (dist - acc[i - 1]) / seg;
        if (f > 0) g.lineTo(p[i - 1][0] + (p[i][0] - p[i - 1][0]) * f, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * f);
        break;
      }
      g.stroke();
    }

    function frame(done, cur, dist) {
      g.clearRect(0, 0, CSS, CSS);
      var style = getComputedStyle(document.body);
      // ghost
      g.lineWidth = 3; g.lineCap = g.lineJoin = 'round';
      g.strokeStyle = style.getPropertyValue('--line').trim() || '#ddd';
      pts.forEach(function (p) { path(p); g.stroke(); });
      // finished + current strokes in ink
      g.strokeStyle = style.color;
      g.lineWidth = 6;
      for (var s = 0; s < done; s++) { path(pts[s]); g.stroke(); }
      if (cur >= 0) drawPartial(cur, dist);
      // number the finished strokes
      g.fillStyle = style.getPropertyValue('--muted').trim() || '#888';
      g.font = '9px sans-serif';
      for (var s2 = 0; s2 < done; s2++) {
        g.fillText(String(s2 + 1), pts[s2][0][0] - 3, pts[s2][0][1] - 4);
      }
    }

    return function run() {
      if (canvas._raf) cancelAnimationFrame(canvas._raf);
      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) { frame(pts.length, -1, 0); return; }
      var s = 0, start = null;
      var SPEED = 0.22; // px per ms
      function tick(ts) {
        if (start === null) start = ts;
        var total = lens[s][lens[s].length - 1];
        var dist = (ts - start) * SPEED;
        if (dist >= total + 40) { // small pause between strokes
          s++;
          start = ts;
          if (s >= pts.length) { frame(pts.length, -1, 0); canvas._raf = null; return; }
          dist = 0;
        }
        frame(s, s, Math.min(dist, total));
        canvas._raf = requestAnimationFrame(tick);
      }
      canvas._raf = requestAnimationFrame(tick);
    };
  }

  // --- character origin story + component breakdown (makemeahanzi data)
  var ETY_LABEL = {
    pictographic: 'Pictograph — a drawing of the thing itself',
    ideographic: 'Ideograph — meanings combined into a new idea',
    pictophonetic: 'Phono-semantic — one part gives the meaning, the other the sound'
  };

  function charInfo(ch) {
    if (!chars) return null;
    return chars[ch] || chars[toSimp(ch)] || null;
  }

  function gloss(ch) {
    var idxs = exactIndex.get(ch) || exactIndex.get(toSimp(ch)) || [];
    if (idxs.length) {
      var row = dict[idxs[0]];
      for (var i = 0; i < idxs.length; i++) {
        if (!/[A-Z]/.test(dict[idxs[i]][2])) { row = dict[idxs[i]]; break; }
      }
      var py = row[2].split(/\s+/).map(function (s) { return syllableToMark(s).text; }).join(' ');
      var parts = row[3].split(';');
      var d = parts[0];
      for (var j = 0; j < parts.length; j++) {
        if (!/^\s*(surname |CL:|old variant|variant of)/.test(parts[j])) { d = parts[j].trim(); break; }
      }
      if (d.length > 28) d = d.slice(0, 28) + '…';
      return py + ' · ' + d;
    }
    var info = charInfo(ch);
    if (info && info[6]) return info[6].split(';')[0];
    return '';
  }

  function originHtml(ch) {
    var info = charInfo(ch);
    if (!info) return '';
    var ety = info[0], hint = info[1], sem = info[2], pho = info[3], comps = info[4];
    var html = '';
    if (ety) {
      html += '<p class="origin-story"><span class="origin-type">' + esc(ETY_LABEL[ety] || ety) + '</span>';
      if (hint) html += '<br>' + esc(hint);
      if (ety === 'pictophonetic' && (sem || pho)) {
        html += '<br>' +
          (sem ? '<b>' + esc(sem) + '</b> gives the meaning' : '') +
          (sem && pho ? ', ' : '') +
          (pho ? '<b>' + esc(pho) + '</b> gives the sound' : '') + '.';
      }
      html += '</p>';
    }
    if (comps && comps.length > 1) {
      html += '<div class="origin-parts"><span class="origin-eq">' + esc(ch) + ' =</span>';
      for (var i = 0; i < comps.length; i++) {
        html += '<button class="part" data-part="' + esc(comps[i]) + '">' +
          '<span class="part-hz">' + esc(comps[i]) + '</span>' +
          '<span class="part-gloss">' + esc(gloss(comps[i]) || '') + '</span></button>';
      }
      html += '</div>';
    }
    if (!html) return '';
    return '<div class="origin">' + html + '</div>';
  }

  function bindPartButtons(scope) {
    scope.querySelectorAll('.part').forEach(function (b) {
      b.addEventListener('click', function () { setWord(b.getAttribute('data-part')); });
    });
  }

  function bindSpeakButtons(scope) {
    scope.querySelectorAll('.speak').forEach(function (b) {
      b.addEventListener('click', function () { speak(b.getAttribute('data-say')); });
    });
  }

  function renderSuggestions() {
    var wrap = $('suggestWrap');
    var q = toSimp(word);
    if (!q || q.length > 3) { wrap.hidden = true; return; }
    var found = [];
    for (var i = 0; i < dict.length; i++) {
      var s = dict[i][0];
      if (s.length > q.length && s.lastIndexOf(q, 0) === 0) found.push(i);
    }
    found.sort(function (a, b) {
      var ra = dict[a], rb = dict[b];
      var ha = ra[5] || 9, hb = rb[5] || 9;
      if (ha !== hb) return ha - hb;
      return rb[4] - ra[4];
    });
    found = found.slice(0, 12).filter(function (i) { return dict[i][4] > 0 || dict[i][5] > 0; });
    if (!found.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    $('suggestKey').textContent = q;
    var box = $('suggestions');
    box.innerHTML = '';
    found.forEach(function (i) {
      var row = dict[i];
      var b = document.createElement('button');
      b.innerHTML = esc(row[0]) + '<span class="spy">' +
        row[2].split(/\s+/).map(function (s) { return syllableToMark(s).text; }).join(' ') + '</span>';
      b.addEventListener('click', function () { setWord(row[0]); });
      box.appendChild(b);
    });
  }

  // ---------------------------------------------------------------- sentences
  function renderSentences() {
    var card = $('sentCard');
    if (!word) { card.hidden = true; return; }
    card.hidden = false;
    var status = $('sentStatus');
    if (!sentences) {
      status.textContent = 'Loading sentence database…';
      $('sentences').innerHTML = '';
      $('moreSents').hidden = true;
      return;
    }
    var q = toSimp(word);
    sentMatches = [];
    for (var i = 0; i < sentences.length && sentMatches.length < 300; i++) {
      if (sentences[i][0].indexOf(q) >= 0) sentMatches.push(i);
    }
    sentShown = 0;
    $('sentences').innerHTML = '';
    if (!sentMatches.length) {
      status.textContent = 'No example sentences found for “' + q + '”.';
      $('moreSents').hidden = true;
      return;
    }
    status.textContent = sentMatches.length + (sentMatches.length === 300 ? '+' : '') + ' sentence' + (sentMatches.length > 1 ? 's' : '') + ' with “' + q + '”';
    showMoreSentences();
  }

  function showMoreSentences() {
    var list = $('sentences');
    var q = toSimp(word);
    var end = Math.min(sentShown + 15, sentMatches.length);
    for (var k = sentShown; k < end; k++) {
      var row = sentences[sentMatches[k]];
      var li = document.createElement('li');
      li.innerHTML = '<div class="zh">' + rubyHtml(row[0], q) + ' <button class="speak" data-say="' + esc(row[0]) + '">🔊</button></div>' +
        '<div class="en">' + esc(row[1]) + '</div>';
      list.appendChild(li);
      bindSpeakButtons(li);
    }
    sentShown = end;
    $('moreSents').hidden = sentShown >= sentMatches.length;
  }
  $('moreSents').addEventListener('click', showMoreSentences);

  // segment sentence with longest-match against dict, add ruby pinyin, highlight query
  function rubyHtml(zh, hl) {
    var pieces = [];
    var i = 0;
    while (i < zh.length) {
      var matched = null;
      for (var L = Math.min(4, zh.length - i); L >= 1; L--) {
        var w = zh.substr(i, L);
        if (charPinyin.has(w)) { matched = w; break; }
      }
      if (matched) {
        pieces.push({ w: matched, py: charPinyin.get(matched) });
        i += matched.length;
      } else {
        pieces.push({ w: zh[i], py: null });
        i += 1;
      }
    }
    var html = pieces.map(function (p) {
      if (!p.py) return esc(p.w);
      var syls = p.py.split(/\s+/);
      return p.w.split('').map(function (ch, j) {
        var syl = syls[j] ? syllableToMark(syls[j]) : null;
        return '<ruby>' + esc(ch) + (syl ? '<rt class="t' + syl.tone + '">' + esc(syl.text) + '</rt>' : '') + '</ruby>';
      }).join('');
    }).join('');
    // highlight the query chars (works because ruby wraps each char separately)
    if (hl) {
      var hlRe = hl.split('').map(function (c) {
        return '(<ruby>' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '<rt[^>]*>[^<]*</rt></ruby>|<ruby>' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</ruby>|' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')';
      }).join('');
      try { html = html.replace(new RegExp(hlRe, 'g'), '<mark>$&</mark>'); } catch (e) {}
    }
    return html;
  }

  $('pinyinToggle').addEventListener('change', function () {
    document.body.classList.toggle('nopinyin', !this.checked);
  });

  // ---------------------------------------------------------------- tabs
  var TABS = Array.prototype.map.call(document.querySelectorAll('.tabs button'), function (b) {
    return b.getAttribute('data-tab');
  });
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });
  function showTab(tab) {
    document.querySelectorAll('.tabs button').forEach(function (x) {
      x.classList.toggle('active', x.getAttribute('data-tab') === tab);
    });
    TABS.forEach(function (t) { $('tab-' + t).hidden = t !== tab; });
    if (tab === 'words') renderWords(false);
    if (tab === 'rules' && dict) renderRules();
    if (tab === 'review') renderReview();
  }

  // about / licenses panel
  $('aboutToggle').addEventListener('click', function () {
    var p = $('aboutPanel');
    p.hidden = !p.hidden;
    if (!p.hidden) p.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // voice & speed settings
  function chineseVoices() {
    if (!window.speechSynthesis) return [];
    return speechSynthesis.getVoices().filter(function (v) {
      var l = (v.lang || '').toLowerCase();
      return l.indexOf('zh') === 0 || l.indexOf('cmn') === 0 || /chinese|mandarin|中文|普通话|國語|国语/i.test(v.name || '');
    });
  }
  function populateVoices() {
    var sel = $('voiceSelect');
    var voices = chineseVoices();
    if (!window.speechSynthesis) {
      $('voiceNote').textContent = 'This browser has no speech support, so voice can’t be changed here.';
      sel.disabled = true;
      return;
    }
    if (!voices.length) {
      $('voiceNote').textContent = 'No dedicated Chinese voice found on this device — your system default is used. Add a Chinese voice or keyboard in your device settings for the clearest pronunciation.';
    } else {
      $('voiceNote').textContent = voices.length + ' Chinese voice' + (voices.length > 1 ? 's' : '') + ' available. Pick the one you like best.';
    }
    sel.innerHTML = '<option value="">System default</option>';
    voices.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = v.name + ' (' + v.lang + ')';
      if (v.voiceURI === voiceCfg.uri) o.selected = true;
      sel.appendChild(o);
    });
  }
  if (window.speechSynthesis) {
    populateVoices();
    speechSynthesis.onvoiceschanged = populateVoices;
  } else {
    populateVoices();
  }
  $('voiceRate').value = voiceCfg.rate;
  $('voiceRateVal').textContent = (+voiceCfg.rate).toFixed(2) + '×';
  $('voiceToggle').addEventListener('click', function () {
    var p = $('voicePanel');
    p.hidden = !p.hidden;
    if (!p.hidden) { populateVoices(); p.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  });
  $('voiceSelect').addEventListener('change', function () {
    voiceCfg.uri = this.value;
    saveVoiceCfg();
    speak('你好');
  });
  $('voiceRate').addEventListener('input', function () {
    voiceCfg.rate = +this.value;
    $('voiceRateVal').textContent = voiceCfg.rate.toFixed(2) + '×';
    saveVoiceCfg();
  });
  $('voiceTest').addEventListener('click', function () { speak('你好，我在学中文'); });

  // ---------------------------------------------------------------- learn: shared helpers
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  function pinyinMarked(numbered) {
    return numbered.split(/\s+/).map(function (s) { return syllableToMark(s).text; }).join(' ');
  }

  // best dictionary row for a word (prefers non-proper-noun reading)
  function bestRow(w) {
    var idxs = exactIndex.get(w) || exactIndex.get(toSimp(w)) || [];
    if (!idxs.length) return null;
    for (var i = 0; i < idxs.length; i++) {
      if (!/[A-Z]/.test(dict[idxs[i]][2])) return dict[idxs[i]];
    }
    return dict[idxs[0]];
  }

  // segment a sentence into dictionary words (longest match) — "as a Chinese reader sees it"
  function segmentZh(zh) {
    var out = [];
    var i = 0;
    while (i < zh.length) {
      var matched = null;
      for (var L = Math.min(4, zh.length - i); L >= 1; L--) {
        var w = zh.substr(i, L);
        if (charPinyin.has(w)) { matched = w; break; }
      }
      out.push(matched || zh[i]);
      i += (matched || zh[i]).length;
    }
    return out;
  }

  function hintChipsHtml(zh, withGloss, skipWord) {
    return segmentZh(zh).map(function (w) {
      if (skipWord && w === skipWord) {
        return '<span class="hint-chip"><span class="hz">？</span><span class="py">…</span></span>';
      }
      if (!/[㐀-鿿]/.test(w)) {
        return '<span class="hint-chip"><span class="hz">' + esc(w) + '</span></span>';
      }
      var row = bestRow(w);
      var py = row ? pinyinHtml(row[2]) : (charPinyin.has(w) ? pinyinHtml(charPinyin.get(w)) : '');
      var gl = '';
      if (withGloss && row) {
        gl = row[3].split(';')[0].trim();
        if (gl.length > 26) gl = gl.slice(0, 26) + '…';
      }
      return '<span class="hint-chip"><span class="hz">' + esc(w) + '</span>' +
        '<span class="py">' + py + '</span>' +
        (gl ? '<span class="gl">' + esc(gl) + '</span>' : '') + '</span>';
    }).join('');
  }

  function hskPool(level) {
    var best = new Map(); // word -> row with the richest definition (main reading)
    for (var i = 0; i < dict.length; i++) {
      var row = dict[i];
      if (row[5] !== level || /[A-Z]/.test(row[2])) continue;
      var cur = best.get(row[0]);
      if (!cur || row[3].length > cur[3].length) best.set(row[0], row);
    }
    return Array.from(best.values());
  }

  function levelButtons(containerId, def) {
    var box = $(containerId);
    for (var l = 1; l <= 6; l++) {
      var b = document.createElement('button');
      b.textContent = 'HSK ' + l;
      b.setAttribute('data-v', l);
      if (l === def) b.classList.add('sel');
      box.appendChild(b);
    }
    selectable(box);
  }

  function countButtons(containerId, counts, def) {
    var box = $(containerId);
    counts.forEach(function (c) {
      var b = document.createElement('button');
      b.textContent = c;
      b.setAttribute('data-v', c);
      if (c === def) b.classList.add('sel');
      box.appendChild(b);
    });
    selectable(box);
  }

  function selectable(box) {
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      box.querySelectorAll('button').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
    });
  }

  function selectedVal(containerId) {
    var b = $(containerId).querySelector('button.sel');
    return b ? +b.getAttribute('data-v') : 1;
  }

  levelButtons('cardsLevel', 1);
  countButtons('cardsCount', [10, 20, 40], 10);
  levelButtons('quizLevel', 1);
  countButtons('quizCount', [5, 10, 15], 10);

  // ---------------------------------------------------------------- flashcards
  var fc = { deck: [], i: 0, known: 0, missed: [], seen: 0, total: 0, flipped: false };

  $('cardsStart').addEventListener('click', function () {
    if (!dict) { $('cardsSetupNote').hidden = false; return; }
    var pool = hskPool(selectedVal('cardsLevel'));
    if (!pool.length) return;
    startDeck(shuffle(pool.slice()).slice(0, selectedVal('cardsCount')));
  });

  function startDeck(rows) {
    fc.deck = rows.slice();
    fc.total = rows.length;
    fc.i = 0; fc.known = 0; fc.seen = 0; fc.missed = [];
    $('cardsSetup').hidden = true; $('cardsDone').hidden = true; $('cardsPlay').hidden = false;
    showCard();
  }

  function showCard() {
    var row = fc.deck[fc.i];
    fc.flipped = false;
    $('cardsProgress').textContent = fc.known + ' / ' + fc.total + ' known · ' + fc.deck.length + ' left';
    $('fcFront').hidden = false;
    $('fcBack').hidden = true;
    $('fcFront').innerHTML = esc(row[0]) + (row[1] ? '<span class="fc-trad">(' + esc(row[1]) + ')</span>' : '');
    var defs = row[3]; if (defs.length > 120) defs = defs.slice(0, 120) + '…';
    $('fcBack').innerHTML = '<div class="fc-hz">' + esc(row[0]) + '</div>' +
      '<div class="fc-py">' + pinyinHtml(row[2]) + '</div>' +
      '<div class="fc-def">' + esc(defs) + '</div>';
    var card = $('fcCard');
    card.style.transform = '';
    card.classList.remove('dragging');
  }

  function flipCard() {
    fc.flipped = !fc.flipped;
    $('fcFront').hidden = fc.flipped;
    $('fcBack').hidden = !fc.flipped;
    if (fc.flipped) speak(fc.deck[fc.i][0]);
  }

  function answerCard(know) {
    var row = fc.deck[fc.i];
    srsGrade(row[0], know);
    if (know) {
      fc.known++;
      fc.deck.splice(fc.i, 1);
    } else {
      if (fc.missed.indexOf(row) < 0) fc.missed.push(row);
      // move it back into the deck a few cards later
      fc.deck.splice(fc.i, 1);
      fc.deck.splice(Math.min(fc.i + 3, fc.deck.length), 0, row);
    }
    if (!fc.deck.length || fc.known >= fc.total) return endDeck();
    if (fc.i >= fc.deck.length) fc.i = 0;
    showCard();
  }

  function endDeck() {
    $('cardsPlay').hidden = true;
    $('cardsDone').hidden = false;
    var missed = fc.missed.length;
    $('cardsStats').textContent = missed
      ? 'You knew ' + (fc.total - missed) + ' of ' + fc.total + ' right away. ' + missed + ' needed another look.'
      : 'Perfect — you knew all ' + fc.total + ' cards! 🎉';
    $('cardsRedo').hidden = !missed;
  }

  $('cardsQuit').addEventListener('click', endDeck);
  $('cardsRedo').addEventListener('click', function () { startDeck(shuffle(fc.missed.slice())); });
  $('cardsNew').addEventListener('click', function () {
    $('cardsDone').hidden = true; $('cardsSetup').hidden = false;
  });
  $('fcYes').addEventListener('click', function () { answerCard(true); });
  $('fcNo').addEventListener('click', function () { answerCard(false); });

  // swipe gestures
  (function () {
    var card = $('fcCard');
    var startX = null, dx = 0;
    card.addEventListener('pointerdown', function (ev) {
      startX = ev.clientX; dx = 0;
      card.setPointerCapture(ev.pointerId);
      card.classList.add('dragging');
    });
    card.addEventListener('pointermove', function (ev) {
      if (startX === null) return;
      dx = ev.clientX - startX;
      card.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 18) + 'deg)';
      card.querySelector('.fc-badge.know').style.opacity = Math.min(1, Math.max(0, dx / 70));
      card.querySelector('.fc-badge.dunno').style.opacity = Math.min(1, Math.max(0, -dx / 70));
    });
    function up() {
      if (startX === null) return;
      card.classList.remove('dragging');
      card.querySelector('.fc-badge.know').style.opacity = 0;
      card.querySelector('.fc-badge.dunno').style.opacity = 0;
      if (Math.abs(dx) > 80) {
        var know = dx > 0;
        card.style.transform = 'translateX(' + (know ? 500 : -500) + 'px) rotate(' + (know ? 30 : -30) + 'deg)';
        setTimeout(function () { answerCard(know); }, 150);
      } else {
        card.style.transform = '';
        if (Math.abs(dx) < 8) flipCard();
      }
      startX = null;
    }
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', up);
  })();

  // ---------------------------------------------------------------- quiz
  var qz = { queue: [], planned: 0, solved: 0, firstTry: 0, asked: 0, missedWords: [], cur: null, answered: false };

  $('quizStart').addEventListener('click', function () {
    if (!dict || !sentences) { $('quizSetupNote').hidden = false; return; }
    var level = selectedVal('quizLevel');
    var n = selectedVal('quizCount');
    var qs = buildQuiz(level, n);
    if (!qs.length) return;
    qz.queue = qs;
    qz.planned = qs.length;
    qz.solved = 0; qz.firstTry = 0; qz.asked = 0; qz.missedWords = [];
    $('quizSetup').hidden = true; $('quizDone').hidden = true; $('quizPlay').hidden = false;
    nextQuestion();
  });

  function sentencesWith(word, maxLen) {
    var out = [];
    for (var i = 0; i < sentences.length && out.length < 25; i++) {
      var zh = sentences[i][0];
      if (zh.length <= maxLen && zh.indexOf(word) >= 0) out.push(sentences[i]);
    }
    return out;
  }

  function buildQuiz(level, n) {
    var pool = shuffle(hskPool(level).slice());
    var questions = [];
    var usedEn = {};
    for (var p = 0; p < pool.length && questions.length < n; p++) {
      var row = pool[p];
      var word = row[0];
      var sents = sentencesWith(word, 22);
      if (!sents.length) continue;
      var sent = pick(sents);
      var type = Math.random() < 0.5 ? 'blank' : 'translate';
      if (type === 'blank') {
        // distractors: same level, prefer same length
        var others = pool.filter(function (r) {
          return r[0] !== word && r[0].length === word.length && sent[0].indexOf(r[0]) < 0;
        });
        if (others.length < 3) {
          others = pool.filter(function (r) { return r[0] !== word && sent[0].indexOf(r[0]) < 0; });
        }
        if (others.length < 3) continue;
        var opts = shuffle([word].concat(shuffle(others.slice()).slice(0, 3).map(function (r) { return r[0]; })));
        questions.push({ type: 'blank', word: word, row: row, zh: sent[0], en: sent[1], options: opts, correct: word });
      } else {
        if (usedEn[sent[1]]) continue;
        usedEn[sent[1]] = true;
        var distr = [];
        var guard = 0;
        while (distr.length < 3 && guard++ < 400) {
          var s2 = pick(sentences);
          if (s2[1] === sent[1] || s2[1].length > sent[1].length * 2 + 20) continue;
          if (distr.indexOf(s2[1]) >= 0) continue;
          distr.push(s2[1]);
        }
        if (distr.length < 3) continue;
        questions.push({ type: 'translate', word: word, row: row, zh: sent[0], en: sent[1], options: shuffle([sent[1]].concat(distr)), correct: sent[1] });
      }
    }
    return questions;
  }

  function nextQuestion() {
    if (!qz.queue.length) return endQuiz();
    qz.cur = qz.queue.shift();
    qz.answered = false;
    qz.asked++;
    var q = qz.cur;
    $('quizProgress').textContent = 'Solved ' + qz.solved + ' / ' + qz.planned + (q.retry ? ' · repeat' : '');
    $('quizType').textContent = q.type === 'blank' ? 'Fill in the blank' : 'What does this sentence mean?';
    if (q.type === 'blank') {
      var zhBlank = esc(q.zh).replace(esc(q.word), '<span class="blank">＿＿</span>');
      $('quizQ').innerHTML = zhBlank + '<span class="quiz-en">' + esc(q.en) + '</span>';
    } else {
      $('quizQ').innerHTML = esc(q.zh);
    }
    $('quizHint').hidden = true;
    $('quizHint').innerHTML = '';
    $('quizNext').hidden = true;
    var box = $('quizAnswers');
    box.innerHTML = '';
    q.options.forEach(function (opt) {
      var b = document.createElement('button');
      b.className = 'opt-main';
      b.setAttribute('data-v', opt);
      var r = q.type === 'blank' ? bestRow(opt) : null;
      if (r) {
        // Chinese word answer: hanzi + pinyin, meaning behind a show/hide toggle
        b.innerHTML = '<span class="opt-hz">' + esc(opt) + '</span>' +
          '<span class="opt-py">' + pinyinHtml(r[2]) + '</span>' +
          '<span class="opt-gloss" hidden>— ' + esc(rowGloss(r)) + '</span>';
      } else {
        b.textContent = opt;
      }
      b.addEventListener('click', function () { answerQuiz(b, opt); });
      if (r) {
        var rowEl = document.createElement('div');
        rowEl.className = 'quiz-opt';
        rowEl.appendChild(b);
        var ib = document.createElement('button');
        ib.className = 'opt-info';
        ib.textContent = 'show';
        ib.title = 'Show / hide what this answer means';
        ib.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var g = b.querySelector('.opt-gloss');
          g.hidden = !g.hidden;
          ib.textContent = g.hidden ? 'show' : 'hide';
        });
        rowEl.appendChild(ib);
        box.appendChild(rowEl);
      } else {
        box.appendChild(b);
      }
    });
  }

  function rowGloss(row) {
    var parts = row[3].split(';');
    var d = parts[0];
    for (var j = 0; j < parts.length; j++) {
      if (!/^\s*(surname |CL:|old variant|variant of)/.test(parts[j])) { d = parts[j].trim(); break; }
    }
    if (d.length > 42) d = d.slice(0, 42) + '…';
    return d;
  }

  function answerQuiz(btn, opt) {
    if (qz.answered) return;
    qz.answered = true;
    var q = qz.cur;
    var good = opt === q.correct;
    if (!q.retry) srsGrade(q.word, good);
    $('quizAnswers').querySelectorAll('button[data-v]').forEach(function (b) {
      b.disabled = true;
      if (b.getAttribute('data-v') === q.correct) b.classList.add('good');
    });
    // reveal every answer's meaning once answered
    $('quizAnswers').querySelectorAll('.opt-gloss').forEach(function (g) { g.hidden = false; });
    $('quizAnswers').querySelectorAll('.opt-info').forEach(function (ib) { ib.textContent = 'hide'; });
    if (good) {
      qz.solved++;
      if (!q.retry) qz.firstTry++;
    } else {
      btn.classList.add('bad');
      if (qz.missedWords.indexOf(q.word) < 0) qz.missedWords.push(q.word);
      // the question comes back later in the session
      var copy = {};
      for (var k in q) copy[k] = q[k];
      copy.retry = true;
      copy.options = shuffle(q.options.slice());
      qz.queue.splice(Math.min(2 + Math.floor(Math.random() * 3), qz.queue.length), 0, copy);
    }
    $('quizProgress').textContent = 'Solved ' + qz.solved + ' / ' + qz.planned;
    $('quizNext').hidden = false;
  }

  $('quizNext').addEventListener('click', nextQuestion);
  $('quizQuit').addEventListener('click', endQuiz);
  $('quizSpeak').addEventListener('click', function () { if (qz.cur) speak(qz.cur.zh); });

  // hint: how the sentence splits into words (pinyin only)
  $('hintSplit').addEventListener('click', function () {
    if (!qz.cur) return;
    var q = qz.cur;
    $('quizHint').hidden = false;
    $('quizHint').innerHTML = hintChipsHtml(q.zh, false, q.type === 'blank' && !qz.answered ? q.word : null);
  });

  // full hint: split + pinyin + meaning of every word
  $('hintFull').addEventListener('click', function () {
    if (!qz.cur) return;
    var q = qz.cur;
    $('quizHint').hidden = false;
    $('quizHint').innerHTML = hintChipsHtml(q.zh, true, q.type === 'blank' && !qz.answered ? q.word : null);
  });

  function endQuiz() {
    $('quizPlay').hidden = true;
    $('quizDone').hidden = false;
    var pct = qz.planned ? Math.round(100 * qz.firstTry / qz.planned) : 0;
    $('quizStats').textContent = 'First-try score: ' + qz.firstTry + ' / ' + qz.planned + ' (' + pct + '%)' +
      (qz.asked > qz.planned ? ' · ' + (qz.asked - qz.planned) + ' repeats needed' : '');
    var rev = $('quizReview');
    rev.innerHTML = '';
    if (qz.missedWords.length) {
      rev.innerHTML = '<h3>Worth another look</h3>' + qz.missedWords.map(function (w) {
        var row = bestRow(w);
        if (!row) return '';
        var d = row[3].split(';')[0];
        return '<div class="quiz-review-item"><b>' + esc(w) + '</b> ' + pinyinHtml(row[2]) + ' — ' + esc(d) + '</div>';
      }).join('');
    }
  }

  $('quizNew').addEventListener('click', function () {
    $('quizDone').hidden = true; $('quizSetup').hidden = false;
  });

  // ---------------------------------------------------------------- speech recognition (say it like Duolingo)
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  // iOS Safari quirks: results often arrive only as interim, and recognition
  // may never end on its own — so collect partials, stop on silence, and
  // fall back to the last partial when no final result ever comes.
  function listenZh(onResult, onError, onPartial) {
    if (window.speechSynthesis) speechSynthesis.cancel(); // free the audio session
    var rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    var finished = false;
    var lastText = '';
    var silenceTimer = null;
    var hardTimer = setTimeout(function () { stopRec(); }, 8000);
    function stopRec() { try { rec.stop(); } catch (e) {} }
    function finish(alts) {
      if (finished) return;
      finished = true;
      clearTimeout(silenceTimer);
      clearTimeout(hardTimer);
      stopRec();
      if (alts && alts.length) onResult(alts);
      else if (lastText) onResult([lastText]);
      else onError('no-speech');
    }
    rec.onresult = function (ev) {
      if (finished) return;
      var interim = '';
      var finals = [];
      for (var i = 0; i < ev.results.length; i++) {
        var res = ev.results[i];
        if (res.isFinal) {
          for (var j = 0; j < res.length; j++) {
            if (res[j] && res[j].transcript) finals.push(res[j].transcript);
          }
        }
        if (res[0] && res[0].transcript) interim += res[0].transcript;
      }
      if (interim) {
        lastText = interim;
        if (onPartial) onPartial(interim);
      }
      if (finals.length) { finish(finals); return; }
      // stop ~1.6s after speech stops changing
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(stopRec, 1600);
    };
    rec.onerror = function (ev) {
      if (finished) return;
      if (lastText) { finish(null); return; }
      finished = true;
      clearTimeout(silenceTimer);
      clearTimeout(hardTimer);
      onError(ev.error || 'error');
    };
    rec.onend = function () { finish(null); };
    try { rec.start(); } catch (e) { finished = true; onError('busy'); }
    return rec;
  }

  // pinyin syllables (with tone) for the Chinese characters of a string
  function sylsOf(zh) {
    var out = [];
    for (var i = 0; i < zh.length; i++) {
      var ch = zh[i];
      if (!/[㐀-鿿]/.test(ch)) continue;
      var py = charPinyin.get(ch) || charPinyin.get(toSimp(ch)) || '';
      out.push({ ch: ch, py: py.split(/\s+/)[0].toLowerCase() });
    }
    return out;
  }

  // longest common subsequence over pinyin syllables -> which target chars were said right
  function matchSpeech(target, heard) {
    var a = sylsOf(target), b = sylsOf(heard);
    var n = a.length, m = b.length;
    var dp = [];
    for (var i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); }
    for (i = 1; i <= n; i++) {
      for (var j = 1; j <= m; j++) {
        dp[i][j] = a[i - 1].py && a[i - 1].py === b[j - 1].py
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var ok = new Array(n).fill(false);
    i = n; var j2 = m;
    while (i > 0 && j2 > 0) {
      if (a[i - 1].py && a[i - 1].py === b[j2 - 1].py && dp[i][j2] === dp[i - 1][j2 - 1] + 1) {
        ok[i - 1] = true; i--; j2--;
      } else if (dp[i - 1][j2] >= dp[i][j2 - 1]) i--;
      else j2--;
    }
    return { syls: a, ok: ok, score: n ? Math.round(100 * dp[n][m] / n) : 0 };
  }

  // the characters marked red, each with pinyin and meaning — so even a
  // failed attempt teaches you the characters you missed
  function missedCharsHtml(syls, ok) {
    var seen = {};
    var chips = '';
    for (var i = 0; i < syls.length; i++) {
      var ch = syls[i].ch;
      if (ok[i] || seen[ch]) continue;
      seen[ch] = true;
      var row = bestRow(ch);
      var py = row ? pinyinHtml(row[2]) : (charPinyin.has(ch) ? pinyinHtml(charPinyin.get(ch)) : '');
      var gl = row ? rowGloss(row) : (charInfo(ch) && charInfo(ch)[6] ? charInfo(ch)[6].split(';')[0] : '');
      chips += '<span class="hint-chip"><span class="hz">' + esc(ch) + '</span>' +
        (py ? '<span class="py">' + py + '</span>' : '') +
        (gl ? '<span class="gl">' + esc(gl) + '</span>' : '') + '</span>';
    }
    if (!chips) return '';
    return '<div class="say-missed"><span class="say-missed-label">The red characters mean:</span>' + chips + '</div>';
  }

  function speechFeedbackHtml(target, alts) {
    var best = null;
    alts.forEach(function (t) {
      var r = matchSpeech(target, t);
      if (!best || r.score > best.r.score) best = { t: t, r: r };
    });
    if (!best) return '';
    var r = best.r;
    var colored = r.syls.map(function (s, i) {
      return '<span class="' + (r.ok[i] ? 'say-ok' : 'say-bad') + '">' + esc(s.ch) + '</span>';
    }).join('');
    var verdict = r.score >= 90 ? 'Excellent! 🎉' : r.score >= 70 ? 'Good! 👍' : r.score >= 40 ? 'Keep practicing 💪' : 'Try again 🙂';
    return '<div class="say-score">' + r.score + '% — ' + verdict + '</div>' +
      '<div class="say-target">' + colored + '</div>' +
      '<div class="say-heard">We heard: ' + esc(best.t || '…') + '</div>' +
      missedCharsHtml(r.syls, r.ok);
  }

  var IOS_DICTATION_TIP = 'We didn’t hear anything. On iPhone, Chinese speech needs the Chinese ' +
    'dictation keyboard: Settings → General → Keyboard → turn on Dictation, then ' +
    'Keyboards → Add New Keyboard → Chinese, Simplified (Pinyin — QWERTY). Then try again.';

  function attachMic(btn, getTarget, fbBox) {
    var current = null;
    btn.addEventListener('click', function () {
      if (!SR) {
        fbBox.hidden = false;
        fbBox.innerHTML = '<div class="say-heard">' + esc(NO_SR_MSG) + '</div>';
        return;
      }
      if (current) { try { current.stop(); } catch (e) {} return; } // second tap = stop
      btn.classList.add('listening');
      btn.textContent = '⏹';
      fbBox.hidden = false;
      fbBox.innerHTML = '<div class="say-heard">Listening… 🎙️ speak, then pause or tap ⏹ to finish</div>';
      function reset() {
        current = null;
        btn.classList.remove('listening');
        btn.textContent = '🎤';
      }
      current = listenZh(function (alts) {
        reset();
        fbBox.innerHTML = speechFeedbackHtml(getTarget(), alts);
      }, function (err) {
        reset();
        fbBox.innerHTML = '<div class="say-heard">' +
          (err === 'not-allowed' || err === 'service-not-allowed'
            ? 'Microphone access was blocked — allow it in your browser settings.'
            : err === 'no-speech' ? esc(IOS_DICTATION_TIP)
            : 'Speech recognition failed (' + esc(String(err)) + '). Try again.') + '</div>';
      }, function (partial) {
        fbBox.innerHTML = '<div class="say-heard">👂 ' + esc(partial) + '</div>';
      });
    });
  }

  var NO_SR_MSG = 'Speech recognition is not available here. On iPhone open ' +
    'the site directly in the Safari app (speaking does not work in the home-screen app) — ' +
    'on desktop use Chrome or Safari.';

  // mic in the dictionary tab: speak a word instead of typing it
  var micRec = null;
  $('micInput').hidden = false;
  $('micInput').addEventListener('click', function () {
    var btn = $('micInput');
    if (!SR) { alert(NO_SR_MSG); return; }
    if (micRec) { try { micRec.stop(); } catch (e) {} return; } // second tap = stop
    btn.classList.add('listening');
    btn.textContent = '⏹';
    function reset() {
      micRec = null;
      btn.classList.remove('listening');
      btn.textContent = '🎤';
    }
    micRec = listenZh(function (alts) {
      reset();
      var zh = (alts[0] || '').replace(/[^㐀-鿿]/g, '');
      if (zh) setWord(zh.slice(0, 8));
    }, function () { reset(); },
    function (partial) {
      $('typeInput').value = partial;
    });
  });
  if (!SR) $('srNote').hidden = false;

  // ---------------------------------------------------------------- talk: everyday dialogues
  function renderDlgList() {
    var box = $('dlgList');
    box.innerHTML = '';
    var pb = document.createElement('button');
    pb.className = 'dlg-item prax-item';
    pb.innerHTML = '<span class="em">🤖</span><span><b>Free conversation</b><small>Talk with the assistant — answer yourself, suggestions on tap</small></span>';
    pb.addEventListener('click', function () {
      if (!dict) return;
      startPractice();
    });
    box.appendChild(pb);
    dialogs.forEach(function (dlg, i) {
      var b = document.createElement('button');
      b.className = 'dlg-item';
      b.innerHTML = '<span class="em">' + dlg.e + '</span><span><b>' + esc(dlg.t) + '</b><small>' + esc(dlg.d) + '</small></span>';
      b.addEventListener('click', function () { openDlg(i); });
      box.appendChild(b);
    });
  }

  function openDlg(i) {
    var dlg = dialogs[i];
    $('dlgList').hidden = true;
    $('praxView').hidden = true;
    $('dlgView').hidden = false;
    $('dlgTitle').textContent = dlg.e + ' ' + dlg.t;
    var box = $('dlgLines');
    box.innerHTML = '';
    dlg.lines.forEach(function (line) {
      var who = line[0], zh = line[1], en = line[2];
      var div = document.createElement('div');
      div.className = 'bubble' + (who === 'B' ? ' b' : '');
      div.innerHTML = '<span class="who">' + (who === 'B' ? '乙 B' : '甲 A') + '</span>' +
        '<button class="speak mic">🎤</button>' +
        '<button class="speak" data-say="' + esc(zh) + '">🔊</button>' +
        '<div class="zh">' + rubyHtml(zh, null) + '</div>' +
        '<div class="dlg-split">' + hintChipsHtml(zh, true) + '</div>' +
        '<div class="dlg-en">' + esc(en) + '</div>' +
        '<div class="say-fb" hidden></div>';
      box.appendChild(div);
      attachMic(div.querySelector('.mic'), function () { return zh; }, div.querySelector('.say-fb'));
    });
    bindSpeakButtons(box);
    applyDlgToggles();
  }

  $('dlgBack').addEventListener('click', function () {
    $('dlgView').hidden = true;
    $('dlgList').hidden = false;
  });

  function applyDlgToggles() {
    ['dlgLines', 'praxLines'].forEach(function (id) {
      var lines = $(id);
      lines.classList.toggle('nopy', !$('dlgPinyin').checked);
      lines.classList.toggle('split', $('dlgSplit').checked);
      lines.classList.toggle('noen', !$('dlgEn').checked);
    });
  }
  ['dlgPinyin', 'dlgSplit', 'dlgEn'].forEach(function (id) {
    $(id).addEventListener('change', applyDlgToggles);
  });

  // tap any word chip (dialogues, quiz hints, practice splits, missed chars)
  // to hear how that word is pronounced; long-press opens it in the dictionary
  (function () {
    var main = document.querySelector('main');
    var pressTimer = null, longPressed = false;
    function chipOf(ev) { return ev.target.closest('.hint-chip'); }
    function wordOf(chip) {
      var hz = chip.querySelector('.hz');
      return hz && /[㐀-鿿]/.test(hz.textContent) ? hz.textContent : null;
    }
    main.addEventListener('pointerdown', function (ev) {
      var chip = chipOf(ev);
      if (!chip) return;
      longPressed = false;
      pressTimer = setTimeout(function () {
        var w = wordOf(chip);
        if (w) { longPressed = true; setWord(w); showTab('dict'); }
      }, 550);
    });
    function cancelPress() { clearTimeout(pressTimer); }
    main.addEventListener('pointerup', cancelPress);
    main.addEventListener('pointercancel', cancelPress);
    main.addEventListener('pointermove', cancelPress);
    main.addEventListener('click', function (ev) {
      var chip = chipOf(ev);
      if (!chip) return;
      if (longPressed) { longPressed = false; return; }
      var w = wordOf(chip);
      if (!w) return;
      speak(w);
      chip.classList.add('chip-tapped');
      setTimeout(function () { chip.classList.remove('chip-tapped'); }, 320);
    });
  })();

  // ---------------------------------------------------------------- free conversation practice
  // steps: q = assistant's question [zh, en]; s = suggested answers [zh, en, assistant reaction]
  // lvl: 1 = HSK 1 vocabulary, 2 = HSK 2, 3 = HSK 3+
  var PRACTICE = [
    { e: '👋', t: 'First meeting', lvl: 1, steps: [
      { q: ['你好！你叫什么名字？', 'Hello! What is your name?'], s: [
        ['我叫安娜。', 'My name is Anna.', '你好，安娜！'],
        ['我叫马克。', 'My name is Marek.', '你好，马克！'],
        ['你好，我叫小王。', 'Hi, my name is Xiao Wang.', '小王，很高兴认识你！']] },
      { q: ['你是哪国人？', 'Which country are you from?'], s: [
        ['我是波兰人。', 'I am Polish.', '波兰很漂亮！'],
        ['我是中国人。', 'I am Chinese.', '太好了！'],
        ['我是美国人。', 'I am American.', '很好！']] },
      { q: ['你多大了？', 'How old are you?'], s: [
        ['我二十岁。', 'I am twenty.', '你很年轻！'],
        ['我三十岁。', 'I am thirty.', '很好的年纪！'],
        ['我十八岁。', 'I am eighteen.', '真年轻！']] },
      { q: ['你是学生吗？', 'Are you a student?'], s: [
        ['是，我是学生。', 'Yes, I am a student.', '学习加油！'],
        ['不是，我工作。', 'No, I work.', '工作辛苦了！'],
        ['我是老师。', 'I am a teacher.', '老师好！']] },
      { q: ['认识你很高兴！再见！', 'Nice to meet you! Goodbye!'], end: true }] },
    { e: '🍎', t: 'Eating & drinking', lvl: 1, steps: [
      { q: ['你好！你喜欢吃什么？', 'Hi! What do you like to eat?'], s: [
        ['我喜欢吃米饭。', 'I like rice.', '我也喜欢！'],
        ['我喜欢吃苹果。', 'I like apples.', '苹果很好吃！'],
        ['我喜欢吃菜。', 'I like vegetables.', '很健康！']] },
      { q: ['你喜欢喝茶吗？', 'Do you like drinking tea?'], s: [
        ['喜欢，我喜欢喝茶。', 'Yes, I like tea.', '中国茶很有名！'],
        ['不喜欢，我喜欢喝水。', 'No, I like water.', '多喝水很好！'],
        ['我喜欢喝咖啡。', 'I like coffee.', '我也爱喝咖啡！']] },
      { q: ['你今天吃饭了吗？', 'Have you eaten today?'], s: [
        ['吃了。', 'Yes, I have.', '很好！'],
        ['还没吃。', 'Not yet.', '快去吃饭吧！'],
        ['我在吃饭。', 'I am eating now.', '慢慢吃！']] },
      { q: ['你会做饭吗？', 'Can you cook?'], s: [
        ['我会做饭。', 'I can cook.', '真棒！'],
        ['我不会做饭。', 'I cannot cook.', '没关系！'],
        ['我妈妈会做饭。', 'My mum can cook.', '哈哈，妈妈做的饭最好吃！']] },
      { q: ['好，我们下次一起吃饭！再见！', 'OK, let us eat together next time! Bye!'], end: true }] },
    { e: '🏠', t: 'Family & every day', lvl: 1, steps: [
      { q: ['你好！你家有几口人？', 'Hi! How many people are in your family?'], s: [
        ['我家有三口人。', 'There are three people in my family.', '很好！'],
        ['我家有四口人。', 'There are four people in my family.', '真好！'],
        ['我家有五口人。', 'There are five people in my family.', '大家庭！']] },
      { q: ['你有猫吗？', 'Do you have a cat?'], s: [
        ['有，我有一只猫。', 'Yes, I have a cat.', '小猫很可爱！'],
        ['没有，我有一只狗。', 'No, I have a dog.', '小狗也很可爱！'],
        ['我没有猫。', 'I do not have a cat.', '好的！']] },
      { q: ['你几点睡觉？', 'What time do you go to sleep?'], s: [
        ['我十一点睡觉。', 'I go to sleep at eleven.', '早点儿睡！'],
        ['我十点睡觉。', 'I go to sleep at ten.', '很好！'],
        ['我十二点睡觉。', 'I go to sleep at twelve.', '太晚了！']] },
      { q: ['你喜欢看书吗？', 'Do you like reading books?'], s: [
        ['喜欢，我喜欢看书。', 'Yes, I like reading.', '看书很好！'],
        ['不喜欢，我喜欢看电视。', 'No, I like watching TV.', '哈哈，好的！'],
        ['我喜欢看电影。', 'I like watching movies.', '我也是！']] },
      { q: ['今天很开心！再见！', 'That was fun! Goodbye!'], end: true }] },
    { e: '💼', t: 'Work & plans', lvl: 3, steps: [
      { q: ['你好！最近工作忙不忙？', 'Hi! Has work been busy lately?'], s: [
        ['很忙，每天都要加班。', 'Very busy — I work overtime every day.', '那要注意休息啊！'],
        ['还好，不太忙。', 'It is OK, not too busy.', '那挺好的。'],
        ['我最近在找工作。', 'I am looking for a job at the moment.', '祝你早日找到好工作！']] },
      { q: ['你以后有什么打算？', 'What are your plans for the future?'], s: [
        ['我打算换一个工作。', 'I plan to change jobs.', '换个环境也许更好。'],
        ['我想继续学习中文。', 'I want to keep studying Chinese.', '太好了，坚持就是胜利！'],
        ['我打算去国外工作。', 'I plan to work abroad.', '很勇敢的决定！']] },
      { q: ['你觉得你的工作有意思吗？', 'Do you find your work interesting?'], s: [
        ['有意思，我很喜欢。', 'Yes, I really like it.', '喜欢自己的工作最幸福了。'],
        ['一般，有时候很累。', 'So-so — sometimes it is tiring.', '辛苦了，记得休息。'],
        ['没意思，我想换工作。', 'Not really, I want to change.', '那就勇敢地去找新机会吧！']] },
      { q: ['工作和生活，哪个更重要？', 'Which is more important — work or life?'], s: [
        ['我觉得生活更重要。', 'I think life is more important.', '同意，身体和家人最重要。'],
        ['工作更重要，因为要赚钱。', 'Work, because you need to earn money.', '有道理，不过也要照顾自己。'],
        ['都很重要，要平衡。', 'Both matter — you need balance.', '说得好，平衡最难也最重要。']] },
      { q: ['说得真好！祝你工作顺利！再见！', 'Well said! Good luck with work! Bye!'], end: true }] },
    { e: '🧳', t: 'Travel stories', lvl: 3, steps: [
      { q: ['你好！你最近去哪儿旅游了？', 'Hi! Where have you travelled recently?'], s: [
        ['我上个月去了北京。', 'I went to Beijing last month.', '北京怎么样？给我讲讲！'],
        ['我去了海边。', 'I went to the seaside.', '海边最舒服了！'],
        ['我最近没去旅游。', 'I have not travelled recently.', '那下次一定要出去走走！']] },
      { q: ['你旅游的时候遇到过什么问题吗？', 'Have you run into any problems while travelling?'], s: [
        ['我丢过护照，特别麻烦。', 'I once lost my passport — a real hassle.', '天啊，那真的很麻烦！'],
        ['有一次我坐错了火车。', 'Once I took the wrong train.', '哈哈，这也是一种经历！'],
        ['没有，一切都很顺利。', 'No, everything went smoothly.', '你运气真好！']] },
      { q: ['你喜欢一个人旅游还是跟朋友一起？', 'Do you prefer travelling alone or with friends?'], s: [
        ['我喜欢一个人，比较自由。', 'Alone — it is more free.', '一个人旅行确实很自由。'],
        ['我喜欢跟朋友一起，更热闹。', 'With friends — it is livelier.', '和朋友一起更有意思！'],
        ['都可以，看情况。', 'Either, depending on the situation.', '你很灵活嘛！']] },
      { q: ['如果有时间和钱，你最想去哪儿？', 'If you had time and money, where would you go?'], s: [
        ['我最想去中国的西部。', 'I would love to see western China.', '那里的风景美极了！'],
        ['我想环游世界。', 'I want to travel around the world.', '好大的梦想，加油！'],
        ['我想去一个安静的小城市。', 'I would go to a quiet little town.', '安静的地方最适合休息。']] },
      { q: ['希望你的梦想能实现！再见！', 'I hope your dream comes true! Bye!'], end: true }] },
    { e: '🥗', t: 'Health & habits', lvl: 3, steps: [
      { q: ['你好！你平时几点起床？', 'Hi! What time do you usually get up?'], s: [
        ['我六点半起床，然后去跑步。', 'I get up at 6:30 and go running.', '这么早！你真自律！'],
        ['我八点起床。', 'I get up at eight.', '不早不晚，刚刚好。'],
        ['周末我睡到十点。', 'On weekends I sleep till ten.', '哈哈，周末就要好好睡！']] },
      { q: ['你觉得自己健康吗？', 'Do you think you are healthy?'], s: [
        ['还可以，我常常锻炼。', 'Quite healthy — I exercise a lot.', '坚持锻炼真不容易！'],
        ['不太健康，我总是坐着。', 'Not really — I sit all day.', '那要多站起来活动活动。'],
        ['我在努力变得更健康。', 'I am working on getting healthier.', '加油，一点一点来！']] },
      { q: ['你晚上一般做什么？', 'What do you usually do in the evening?'], s: [
        ['我看看书，早点儿睡觉。', 'I read a bit and go to bed early.', '很健康的习惯！'],
        ['我喜欢看电视或者上网。', 'I like watching TV or going online.', '别看得太晚哦。'],
        ['我常常学习中文。', 'I often study Chinese.', '哇，太用功了！']] },
      { q: ['你觉得健康最重要的是什么？', 'What do you think matters most for health?'], s: [
        ['我觉得是睡觉。', 'I think it is sleep.', '睡得好，一切都好。'],
        ['是运动和吃得好。', 'Exercise and eating well.', '说得对，两个都重要。'],
        ['心情好最重要。', 'A good mood matters most.', '同意！开心最重要。']] },
      { q: ['说得对！祝你身体健康！再见！', 'Right you are! Stay healthy! Bye!'], end: true }] },
    { e: '🎨', t: 'Colours & favourites', lvl: 1, steps: [
      { q: ['你好！你喜欢什么颜色？', 'Hi! What colour do you like?'], s: [
        ['我喜欢红色。', 'I like red.', '红色很漂亮！'],
        ['我喜欢蓝色。', 'I like blue.', '蓝色像天空！'],
        ['我喜欢黑色和白色。', 'I like black and white.', '黑白很酷！']] },
      { q: ['你的衣服是什么颜色的？', 'What colour are your clothes?'], s: [
        ['我的衣服是白色的。', 'My clothes are white.', '白色很好看！'],
        ['是黑色的。', 'They are black.', '黑色很酷！'],
        ['是蓝色的。', 'They are blue.', '蓝色很好看！']] },
      { q: ['你喜欢猫还是狗？', 'Do you like cats or dogs?'], s: [
        ['我喜欢猫。', 'I like cats.', '小猫很可爱！'],
        ['我喜欢狗。', 'I like dogs.', '小狗是好朋友！'],
        ['都喜欢。', 'I like both.', '哈哈，我也是！']] },
      { q: ['你今天高兴吗？', 'Are you happy today?'], s: [
        ['我很高兴。', 'I am very happy.', '太好了！'],
        ['我有点儿累。', 'I am a bit tired.', '那要好好休息！'],
        ['我不太高兴。', 'Not really.', '别难过，明天会更好！']] },
      { q: ['谢谢你和我聊天！再见！', 'Thanks for chatting with me! Bye!'], end: true }] },
    { e: '🏫', t: 'Learning Chinese', lvl: 2, steps: [
      { q: ['你学中文多长时间了？', 'How long have you been learning Chinese?'], s: [
        ['我学了一年了。', 'I have been learning for a year.', '一年就说得这么好！'],
        ['我学了三个月。', 'Three months.', '三个月？很不错了！'],
        ['我刚开始学。', 'I have just started.', '万事开头难，加油！']] },
      { q: ['你觉得中文难吗？', 'Do you find Chinese hard?'], s: [
        ['有点儿难，但是很有意思。', 'A bit hard, but very interesting.', '有兴趣就不怕难！'],
        ['汉字很难，说话不难。', 'Characters are hard, speaking is not.', '很多人都这么说，哈哈。'],
        ['不太难。', 'Not too hard.', '哇，你很有语言天赋！']] },
      { q: ['你每天学习多长时间？', 'How long do you study every day?'], s: [
        ['我每天学习一个小时。', 'One hour every day.', '每天一小时，很棒的习惯！'],
        ['我每天学三十分钟。', 'Thirty minutes a day.', '坚持最重要！'],
        ['我周末学习。', 'I study on weekends.', '周末学习也很好！']] },
      { q: ['你会写汉字吗？', 'Can you write characters?'], s: [
        ['会写一点儿。', 'A little bit.', '一点儿一点儿来！'],
        ['我觉得写汉字很难。', 'I find writing characters hard.', '多练习就不难了。'],
        ['我每天练习写字。', 'I practise writing every day.', '太用功了，佩服！']] },
      { q: ['你一定会学得很好！加油！再见！', 'You will learn it well for sure! Keep going! Bye!'], end: true }] },
    { e: '⚽', t: 'Sports', lvl: 2, steps: [
      { q: ['你好！你喜欢运动吗？', 'Hi! Do you like sports?'], s: [
        ['喜欢，我常常跑步。', 'Yes, I often run.', '跑步对身体最好了！'],
        ['我喜欢打篮球。', 'I like playing basketball.', '打篮球很帅！'],
        ['不太喜欢，哈哈。', 'Not really, haha.', '哈哈，散步也是运动！']] },
      { q: ['你会游泳吗？', 'Can you swim?'], s: [
        ['会，我游得很好。', 'Yes, I swim well.', '真厉害！'],
        ['会一点儿。', 'A little.', '会一点儿就很好了！'],
        ['不会，我想学。', 'No, but I want to learn.', '学游泳很有意思！']] },
      { q: ['你常常看足球比赛吗？', 'Do you often watch football matches?'], s: [
        ['常常看，我很喜欢足球。', 'Often — I love football.', '你最喜欢哪个队？下次告诉我！'],
        ['有时候看。', 'Sometimes.', '大比赛的时候看最有意思！'],
        ['不看，我觉得没意思。', 'No, I find it boring.', '哈哈，每个人爱好不同。']] },
      { q: ['周末我们一起去打球，怎么样？', 'Shall we go play ball this weekend?'], s: [
        ['好啊，去哪儿打？', 'Sure — where shall we play?', '学校旁边有个球场！'],
        ['好主意！', 'Good idea!', '太好了，周末见！'],
        ['这个周末我没有时间。', 'I have no time this weekend.', '没关系，下次吧！']] },
      { q: ['运动让人健康！再见！', 'Sport keeps you healthy! Bye!'], end: true }] },
    { e: '🎊', t: 'Festivals', lvl: 3, steps: [
      { q: ['你好！你知道中国的春节吗？', 'Hi! Do you know about Chinese New Year?'], s: [
        ['知道，就是中国新年。', 'Yes — it is the Chinese New Year.', '对！春节是最重要的节日。'],
        ['听说过，但是不太了解。', 'I have heard of it but do not know much.', '那我以后慢慢给你介绍！'],
        ['我很想体验一次春节。', 'I would love to experience it once.', '春节的时候到处都很热闹！']] },
      { q: ['你们国家最重要的节日是什么？', 'What is the most important holiday in your country?'], s: [
        ['是圣诞节。', 'It is Christmas.', '圣诞节的气氛一定很温暖。'],
        ['是新年。', 'It is New Year.', '新年新希望！'],
        ['我们有很多传统节日。', 'We have many traditional holidays.', '真想都了解一下！']] },
      { q: ['过节的时候你们一般做什么？', 'What do you usually do during holidays?'], s: [
        ['我们全家人一起吃饭。', 'The whole family eats together.', '和中国的春节一样！'],
        ['我们互相送礼物。', 'We give each other presents.', '收礼物最开心了！'],
        ['我们放假休息，看电视。', 'We take time off and watch TV.', '哈哈，放松也很重要。']] },
      { q: ['如果你来中国过春节，你想做什么？', 'If you spent Chinese New Year in China, what would you do?'], s: [
        ['我想吃饺子，看烟花。', 'I would eat dumplings and watch fireworks.', '春节的饺子特别好吃！'],
        ['我想去看舞龙舞狮。', 'I would watch the dragon and lion dances.', '舞狮特别精彩！'],
        ['我想体验放鞭炮。', 'I would try setting off firecrackers.', '噼里啪啦，特别热闹！']] },
      { q: ['欢迎你来中国过春节！再见！', 'Come spend Chinese New Year in China! Bye!'], end: true }] },
    { e: '🌆', t: 'City or countryside', lvl: 3, steps: [
      { q: ['你好！你住在大城市还是小城市？', 'Hi! Do you live in a big city or a small one?'], s: [
        ['我住在大城市。', 'I live in a big city.', '大城市一定很热闹！'],
        ['我住在一个小城市。', 'I live in a small city.', '小城市生活很舒服。'],
        ['我住在农村，很安静。', 'I live in the countryside — very quiet.', '农村的空气一定很好！']] },
      { q: ['你喜欢城市生活吗？', 'Do you like city life?'], s: [
        ['喜欢，城市里什么都有。', 'Yes — the city has everything.', '确实，生活很方便。'],
        ['不太喜欢，人太多了。', 'Not really — too many people.', '人多的时候确实很累。'],
        ['还行，有好有坏。', 'It is OK — good and bad sides.', '说得很客观！']] },
      { q: ['大城市最大的问题是什么？', 'What is the biggest problem of big cities?'], s: [
        ['我觉得是堵车。', 'I think it is traffic jams.', '堵车真的让人头疼。'],
        ['是房子太贵了。', 'Housing is too expensive.', '是啊，房价越来越高。'],
        ['是空气不太好。', 'The air is not so good.', '所以周末要去公园呼吸新鲜空气！']] },
      { q: ['以后你想住在哪儿？', 'Where would you like to live in the future?'], s: [
        ['我想住在海边。', 'I want to live by the sea.', '每天看海，太浪漫了！'],
        ['我想住在安静的小镇。', 'I want to live in a quiet town.', '安静的生活很幸福。'],
        ['我想一直住在大城市。', 'I want to stay in a big city.', '城市的机会确实更多！']] },
      { q: ['希望你住得开心！再见！', 'I hope you live happily! Bye!'], end: true }] },
    { e: '☀️', t: 'Weather & plans', lvl: 2, steps: [
      { q: ['你好！今天天气怎么样？', 'Hi! How is the weather today?'], s: [
        ['今天天气很好，很暖和。', 'The weather is great today, nice and warm.', '太好了！我们出去走走吧。'],
        ['今天很冷，还刮风。', 'It is cold today, and windy too.', '那多穿一点儿衣服吧。'],
        ['今天下雨了。', 'It is raining today.', '别忘了带伞！']] },
      { q: ['你喜欢什么样的天气？', 'What kind of weather do you like?'], s: [
        ['我喜欢晴天。', 'I like sunny days.', '我也是！晴天心情好。'],
        ['我喜欢下雪的天气。', 'I like snowy weather.', '下雪的时候真漂亮。'],
        ['我喜欢凉快的秋天。', 'I like the cool autumn.', '秋天不冷也不热，很舒服。']] },
      { q: ['周末你想做什么？', 'What do you want to do this weekend?'], s: [
        ['我想去公园。', 'I want to go to the park.', '好主意！公园里人很多。'],
        ['我想在家休息。', 'I want to rest at home.', '休息也很重要。'],
        ['我想和朋友见面。', 'I want to meet my friends.', '和朋友在一起最开心了。']] },
      { q: ['你常常运动吗？', 'Do you exercise often?'], s: [
        ['我每天都跑步。', 'I run every day.', '哇，你真棒！'],
        ['我有时候游泳。', 'I sometimes swim.', '游泳对身体很好。'],
        ['我不太喜欢运动。', 'I do not really like sports.', '哈哈，没关系，散散步也好。']] },
      { q: ['今天聊得很开心！再见！', 'It was fun talking today! Goodbye!'], end: true }] },
    { e: '🍜', t: 'Food', lvl: 2, steps: [
      { q: ['你好！你吃饭了吗？', 'Hi! Have you eaten?'], s: [
        ['吃了，我吃了米饭。', 'Yes, I had rice.', '吃饱了就好。'],
        ['还没吃，我有点儿饿。', 'Not yet, I am a bit hungry.', '那快去吃点儿东西吧！'],
        ['我刚喝了咖啡。', 'I just had a coffee.', '我也爱喝咖啡。']] },
      { q: ['你最喜欢吃什么菜？', 'What is your favourite dish?'], s: [
        ['我最喜欢吃饺子。', 'I like dumplings the most.', '饺子太好吃了！'],
        ['我喜欢吃面条。', 'I like noodles.', '面条又快又好吃。'],
        ['我爱吃中国菜。', 'I love Chinese food.', '中国菜的种类特别多。']] },
      { q: ['你会做饭吗？', 'Can you cook?'], s: [
        ['会，我常常做饭。', 'Yes, I cook often.', '真厉害！下次做给我吃吧。'],
        ['不会，我不会做饭。', 'No, I cannot cook.', '没关系，可以慢慢学。'],
        ['会一点儿。', 'A little bit.', '一点儿也很好！']] },
      { q: ['你想不想去饭馆吃饭？', 'Do you want to go eat at a restaurant?'], s: [
        ['好啊，我们走吧！', 'Sure, let us go!', '太好了，我知道一家很好吃的店。'],
        ['今天不行，明天怎么样？', 'Not today — how about tomorrow?', '好，那明天见！'],
        ['我想在家吃。', 'I would rather eat at home.', '在家吃也很舒服。']] },
      { q: ['好，下次一起吃饭！再见！', 'OK, let us eat together next time! Bye!'], end: true }] },
    { e: '🙋', t: 'About you', lvl: 2, steps: [
      { q: ['你好！你叫什么名字？', 'Hello! What is your name?'], s: [
        ['我叫安娜。', 'My name is Anna.', '安娜，很高兴认识你！'],
        ['我叫马克。', 'My name is Marek.', '马克，很高兴认识你！'],
        ['我的名字是李明。', 'My name is Li Ming.', '李明，名字真好听！']] },
      { q: ['你是哪国人？', 'Which country are you from?'], s: [
        ['我是波兰人。', 'I am Polish.', '波兰很漂亮！'],
        ['我是德国人。', 'I am German.', '我有朋友也住在德国。'],
        ['我是美国人。', 'I am American.', '美国很大！']] },
      { q: ['你做什么工作？', 'What do you do for work?'], s: [
        ['我是学生。', 'I am a student.', '学习加油！'],
        ['我是老师。', 'I am a teacher.', '老师的工作很有意义。'],
        ['我在公司工作。', 'I work at a company.', '工作忙不忙？']] },
      { q: ['你为什么学中文？', 'Why are you learning Chinese?'], s: [
        ['因为我喜欢中国文化。', 'Because I like Chinese culture.', '中国文化很有意思！'],
        ['因为工作需要。', 'Because I need it for work.', '会中文对工作很有帮助。'],
        ['因为我想去中国旅游。', 'Because I want to travel to China.', '欢迎你来中国玩！']] },
      { q: ['你的中文很好！加油！再见！', 'Your Chinese is great! Keep it up! Bye!'], end: true }] },
    { e: '🎬', t: 'Hobbies', lvl: 2, steps: [
      { q: ['你好！你有什么爱好？', 'Hi! What are your hobbies?'], s: [
        ['我喜欢看电影。', 'I like watching movies.', '我也喜欢！你常去电影院吗？'],
        ['我喜欢听音乐。', 'I like listening to music.', '音乐能让人放松。'],
        ['我喜欢打篮球。', 'I like playing basketball.', '打篮球对身体好！']] },
      { q: ['你周末常常做什么？', 'What do you usually do on weekends?'], s: [
        ['我常常看书。', 'I often read books.', '你最近在看什么书？有意思吗？'],
        ['我跟朋友一起玩。', 'I hang out with friends.', '和朋友一起总是很开心。'],
        ['我在家睡觉。', 'I sleep at home.', '哈哈，好好休息也不错！']] },
      { q: ['你喜欢什么样的电影？', 'What kind of movies do you like?'], s: [
        ['我喜欢有意思的电影。', 'I like interesting movies.', '那我们爱好一样！'],
        ['我爱看中国电影。', 'I love Chinese movies.', '看电影学中文，真聪明！'],
        ['我不常看电影。', 'I do not watch movies often.', '没关系，每个人爱好不一样。']] },
      { q: ['我们下个周末一起去看电影，好吗？', 'Shall we go see a movie next weekend?'], s: [
        ['好啊，几点见？', 'Sure, what time shall we meet?', '晚上七点，怎么样？'],
        ['不好意思，我没有时间。', 'Sorry, I do not have time.', '没关系，下次吧！'],
        ['好主意！', 'Good idea!', '太好了，到时候见！']] },
      { q: ['今天聊得真开心！再见！', 'That was a nice chat! Bye!'], end: true }] },
    { e: '✈️', t: 'Travel', lvl: 2, steps: [
      { q: ['你好！你去过中国吗？', 'Hi! Have you been to China?'], s: [
        ['去过，我去过北京。', 'Yes, I have been to Beijing.', '北京怎么样？好玩吗？'],
        ['没去过，但是我很想去。', 'No, but I really want to go.', '有机会一定要去看看！'],
        ['我明年想去。', 'I want to go next year.', '太好了！要好好准备哦。']] },
      { q: ['你想去哪个城市？', 'Which city do you want to visit?'], s: [
        ['我想去上海。', 'I want to go to Shanghai.', '上海很现代，晚上特别漂亮。'],
        ['我想去北京。', 'I want to go to Beijing.', '北京有长城和故宫。'],
        ['我想去很多地方。', 'I want to go to many places.', '中国很大，值得慢慢玩。']] },
      { q: ['你喜欢坐飞机还是坐火车？', 'Do you prefer flying or taking the train?'], s: [
        ['我喜欢坐火车。', 'I prefer the train.', '坐火车可以看风景。'],
        ['我喜欢坐飞机。', 'I prefer flying.', '坐飞机又快又方便。'],
        ['都可以。', 'Either is fine.', '你真随和！']] },
      { q: ['旅行的时候你喜欢做什么？', 'What do you like doing when you travel?'], s: [
        ['我喜欢吃当地的菜。', 'I like eating the local food.', '我也是！吃是旅行最重要的事，哈哈。'],
        ['我喜欢照相。', 'I like taking photos.', '照片能留下美好的回忆。'],
        ['我喜欢认识新朋友。', 'I like meeting new people.', '旅行认识的朋友很特别。']] },
      { q: ['祝你旅行愉快！再见！', 'Have a great trip! Bye!'], end: true }] }
  ];

  // three extra, livelier questions per topic — merged before the end step
  var PRACTICE_EXTRA = {
    'First meeting': [
      { q: ['你有中文名字吗？', 'Do you have a Chinese name?'], s: [
        ['有，我的中文名字很好听。', 'Yes, and it sounds nice.', '下次告诉我你的中文名字！'],
        ['还没有，你帮我起一个吧！', 'Not yet — pick one for me!', '好啊！我觉得「乐乐」很适合你！'],
        ['我不需要中文名字。', 'I do not need one.', '哈哈，好吧！']] },
      { q: ['你喜欢学中文吗？', 'Do you like learning Chinese?'], s: [
        ['喜欢，很有意思。', 'Yes, it is interesting.', '太好了！'],
        ['喜欢，但是有点儿难。', 'Yes, but it is a bit hard.', '难的东西才有意思！'],
        ['我妈妈让我学的，哈哈。', 'My mum makes me learn it, haha.', '哈哈，妈妈说得对！']] },
      { q: ['你今天做什么了？', 'What did you do today?'], s: [
        ['我去上班了。', 'I went to work.', '辛苦了！'],
        ['我在家学习了。', 'I studied at home.', '真用功！'],
        ['我和朋友出去玩了。', 'I went out with friends.', '听起来很开心！']] }],
    'Eating & drinking': [
      { q: ['你早上喝咖啡还是喝茶？', 'Coffee or tea in the morning?'], s: [
        ['我喝咖啡，不喝咖啡我睡不醒。', 'Coffee — without it I cannot wake up.', '哈哈，很多人都这样！'],
        ['我喝茶。', 'I drink tea.', '喝茶很健康！'],
        ['我只喝水。', 'I only drink water.', '水最健康了！']] },
      { q: ['你吃过中国菜吗？', 'Have you tried Chinese food?'], s: [
        ['吃过，很好吃！', 'Yes — delicious!', '中国菜有八大菜系呢！'],
        ['没吃过，我很想试试。', 'Not yet, but I want to.', '一定要试试饺子！'],
        ['我常常吃中国菜。', 'I eat it often.', '你真有口福！']] },
      { q: ['甜的和辣的，你喜欢哪个？', 'Sweet or spicy — which do you like?'], s: [
        ['我喜欢甜的。', 'I like sweet.', '甜的让人开心！'],
        ['我喜欢辣的。', 'I like spicy.', '那你一定要去四川！'],
        ['都喜欢，哈哈。', 'Both, haha.', '哈哈，什么都吃最幸福！']] }],
    'Family & every day': [
      { q: ['你有哥哥姐姐吗？', 'Do you have older brothers or sisters?'], s: [
        ['有，我有一个哥哥。', 'Yes, one older brother.', '有哥哥真好！'],
        ['有，我有一个姐姐。', 'Yes, one older sister.', '姐姐一定很照顾你！'],
        ['没有，就我一个。', 'No, it is just me.', '一个人也很好！']] },
      { q: ['你们家谁做饭？', 'Who cooks in your family?'], s: [
        ['我妈妈做饭。', 'My mum cooks.', '妈妈做的饭最好吃！'],
        ['我做饭。', 'I cook.', '你真能干！'],
        ['我们一起做。', 'We cook together.', '一起做饭很开心！']] },
      { q: ['周末你和家人做什么？', 'What do you do with your family on weekends?'], s: [
        ['我们一起看电视。', 'We watch TV together.', '很温馨！'],
        ['我们出去吃饭。', 'We eat out.', '吃什么好吃的？哈哈！'],
        ['我们去公园。', 'We go to the park.', '散步聊天，真好！']] }],
    'Colours & favourites': [
      { q: ['你喜欢什么动物？', 'What animal do you like?'], s: [
        ['我喜欢熊猫。', 'I like pandas.', '熊猫是中国的国宝！'],
        ['我喜欢马。', 'I like horses.', '马很漂亮！'],
        ['我喜欢鸟。', 'I like birds.', '小鸟会唱歌！']] },
      { q: ['你喜欢什么水果？', 'What fruit do you like?'], s: [
        ['我喜欢苹果。', 'I like apples.', '每天一个苹果，身体好！'],
        ['我喜欢西瓜。', 'I like watermelon.', '夏天吃西瓜最舒服！'],
        ['我什么水果都爱吃。', 'I love all fruit.', '水果都很健康！']] },
      { q: ['你喜欢白天还是晚上？', 'Do you prefer day or night?'], s: [
        ['我喜欢白天。', 'I prefer daytime.', '白天有太阳，心情好！'],
        ['我喜欢晚上，很安静。', 'Night — it is quiet.', '晚上确实很安静。'],
        ['都喜欢。', 'I like both.', '哈哈，你真随和！']] }],
    'Weather & plans': [
      { q: ['你喜欢下雪吗？', 'Do you like snow?'], s: [
        ['喜欢，下雪很漂亮。', 'Yes, snow is beautiful.', '下雪的时候可以堆雪人！'],
        ['不喜欢，太冷了。', 'No, it is too cold.', '那冬天要多穿衣服！'],
        ['我没见过雪。', 'I have never seen snow.', '真的吗？希望你有一天能看到雪！']] },
      { q: ['夏天和冬天，你喜欢哪个？', 'Summer or winter?'], s: [
        ['我喜欢夏天。', 'I like summer.', '夏天可以游泳！'],
        ['我喜欢冬天。', 'I like winter.', '冬天喝热茶最舒服！'],
        ['我最喜欢春天和秋天。', 'I like spring and autumn most.', '不冷不热，聪明的选择！']] },
      { q: ['明天你打算做什么？', 'What are your plans for tomorrow?'], s: [
        ['我要上班。', 'I have to work.', '工作加油！'],
        ['我想去买东西。', 'I want to go shopping.', '买点儿什么好东西？'],
        ['还没想好呢。', 'I have not decided yet.', '随心情也很好！']] }],
    'Food': [
      { q: ['你吃过火锅吗？', 'Have you tried hot pot?'], s: [
        ['吃过，太好吃了！', 'Yes — so good!', '冬天吃火锅最幸福了！'],
        ['没吃过，火锅是什么？', 'No — what is hot pot?', '就是把菜放进热汤里煮，特别好吃！'],
        ['我想和朋友一起去吃。', 'I want to try it with friends.', '火锅就要很多人一起吃才热闹！']] },
      { q: ['你会用筷子吗？', 'Can you use chopsticks?'], s: [
        ['会，我用得很好。', 'Yes, quite well.', '真厉害！'],
        ['会一点儿，有时候用不好。', 'A little — not always well.', '多练习就好了！'],
        ['不会，太难了！', 'No — too hard!', '哈哈，先从夹花生开始练！']] },
      { q: ['如果只能吃一种菜，你选什么？', 'If you could eat only one dish forever, which one?'], s: [
        ['我选饺子！', 'Dumplings!', '饺子什么馅儿都有，聪明！'],
        ['我选面条。', 'Noodles.', '长长的面条，长长的人生！'],
        ['太难选了，哈哈。', 'Too hard to choose, haha.', '哈哈，我也选不出来！']] }],
    'About you': [
      { q: ['你会说几种语言？', 'How many languages do you speak?'], s: [
        ['我会说两种。', 'Two.', '两种已经很棒了！'],
        ['我会说三种语言。', 'Three languages.', '哇，语言天才！'],
        ['只会一种，现在学中文。', 'Just one — now learning Chinese.', '中文会是你的第二种！']] },
      { q: ['你喜欢你的城市吗？', 'Do you like your city?'], s: [
        ['喜欢，我的城市很漂亮。', 'Yes, it is beautiful.', '真想去看看！'],
        ['还行吧。', 'It is OK.', '哈哈，平平淡淡也是生活。'],
        ['不太喜欢，我想搬家。', 'Not really — I want to move.', '那要找一个喜欢的地方！']] },
      { q: ['五年以后，你想做什么？', 'Where do you see yourself in five years?'], s: [
        ['我想说一口流利的中文！', 'Speaking fluent Chinese!', '一定可以的，加油！'],
        ['我想去很多国家旅游。', 'Travelling to many countries.', '世界那么大，都去看看！'],
        ['我想有自己的房子。', 'Having my own home.', '梦想会实现的！']] }],
    'Hobbies': [
      { q: ['你喜欢听什么音乐？', 'What music do you listen to?'], s: [
        ['我喜欢流行音乐。', 'Pop music.', '中文流行歌也很好听！'],
        ['我喜欢安静的音乐。', 'Quiet music.', '安静的音乐让人放松。'],
        ['什么都听。', 'A bit of everything.', '音乐不分种类，好听就行！']] },
      { q: ['你玩游戏吗？', 'Do you play games?'], s: [
        ['玩，我常常玩手机游戏。', 'Yes, mobile games a lot.', '别玩太久，眼睛要休息！'],
        ['我喜欢下棋。', 'I like chess.', '下棋的人都很聪明！'],
        ['我不玩游戏。', 'I do not play games.', '每个人放松的方式不同！']] },
      { q: ['如果有一天假期，你做什么？', 'If you had a day off, what would you do?'], s: [
        ['我想睡一整天！', 'Sleep the whole day!', '哈哈，睡觉也是爱好！'],
        ['我去爬山。', 'Go hiking.', '山上的空气特别好！'],
        ['我在家看电影。', 'Watch movies at home.', '记得准备好吃的！']] }],
    'Travel': [
      { q: ['你旅行的时候喜欢照相吗？', 'Do you like taking photos when travelling?'], s: [
        ['喜欢，我照了很多照片。', 'Yes, I take lots of photos.', '照片是最好的纪念！'],
        ['不太照，我喜欢用眼睛看。', 'Not much — I prefer to just look.', '用心记住也很美！'],
        ['我喜欢给朋友照相。', 'I like taking photos of my friends.', '你真是好朋友！']] },
      { q: ['坐飞机你害怕吗？', 'Are you afraid of flying?'], s: [
        ['不怕，我喜欢坐飞机。', 'No, I like flying.', '从天上看云很美！'],
        ['有一点儿怕。', 'A little.', '没关系，飞机很安全！'],
        ['我没坐过飞机。', 'I have never flown.', '第一次坐要靠窗户坐！']] },
      { q: ['长城和熊猫，你想先看哪个？', 'The Great Wall or pandas — which first?'], s: [
        ['先看长城！', 'The Great Wall first!', '不到长城非好汉！'],
        ['先看熊猫！', 'Pandas first!', '熊猫真的太可爱了！'],
        ['都想看，哈哈。', 'Both, haha.', '那要多来中国几次！']] }],
    'Learning Chinese': [
      { q: ['你觉得声调难吗？', 'Do you find the tones hard?'], s: [
        ['很难，我常常说错。', 'Very — I often get them wrong.', '声调要多听多说，慢慢就好了！'],
        ['还好，我慢慢习惯了。', 'OK — I am getting used to them.', '习惯了就自然了！'],
        ['第三声最难！', 'The third tone is the hardest!', '哈哈，第三声确实最难！']] },
      { q: ['你用什么方法学中文？', 'How do you study Chinese?'], s: [
        ['我用手机软件学习。', 'With a phone app.', '哈哈，就像现在这样！'],
        ['我看中国电影。', 'I watch Chinese movies.', '看电影学得最自然！'],
        ['我跟老师学。', 'With a teacher.', '有老师进步会很快！']] },
      { q: ['你最喜欢哪个汉字？', 'What is your favourite character?'], s: [
        ['我喜欢「爱」。', 'I like 爱 (love).', '爱是最美的字！'],
        ['我喜欢「笑」。', 'I like 笑 (smile).', '常常笑的人运气不会差！'],
        ['我喜欢「龙」。', 'I like 龙 (dragon).', '龙在中国文化里很重要！']] }],
    'Sports': [
      { q: ['你喜欢看奥运会吗？', 'Do you like watching the Olympics?'], s: [
        ['喜欢，特别是游泳比赛。', 'Yes — especially the swimming.', '游泳比赛很精彩！'],
        ['有时候看。', 'Sometimes.', '大决赛最好看！'],
        ['不太看。', 'Not really.', '没关系，自己运动更重要！']] },
      { q: ['你每天走路多吗？', 'Do you walk a lot every day?'], s: [
        ['多，我每天走一万步。', 'Yes — ten thousand steps a day.', '一万步！太厉害了！'],
        ['不多，我常常坐车。', 'Not much — I usually ride.', '有时间可以多走走！'],
        ['还行。', 'It is OK.', '走路是最简单的运动！']] },
      { q: ['你想学什么新运动？', 'What new sport would you like to learn?'], s: [
        ['我想学太极拳。', 'Tai chi.', '太极拳又健康又放松！'],
        ['我想学滑雪。', 'Skiing.', '滑雪特别爽！'],
        ['我想学功夫！', 'Kung fu!', '哈哈，中国功夫，好样的！']] }],
    'Festivals': [
      { q: ['你喜欢收礼物还是送礼物？', 'Do you prefer getting or giving presents?'], s: [
        ['我喜欢收礼物，哈哈。', 'Getting them, haha.', '哈哈，谁不喜欢呢！'],
        ['我更喜欢送礼物。', 'I prefer giving.', '送礼物的快乐更长久！'],
        ['都喜欢！', 'Both!', '诚实，哈哈！']] },
      { q: ['新年的时候你有什么愿望？', 'What is your New Year wish?'], s: [
        ['我希望家人身体健康。', 'Good health for my family.', '健康最重要！'],
        ['我希望中文越说越好。', 'Better and better Chinese.', '这个愿望一定会实现！'],
        ['我希望去中国旅游。', 'To travel to China.', '中国欢迎你！']] },
      { q: ['你知道红包吗？', 'Do you know about red envelopes?'], s: [
        ['知道，里面有钱！', 'Yes — there is money inside!', '对！过年的时候长辈给孩子红包。'],
        ['听说过，但不太清楚。', 'I have heard of them, but not sure.', '红包是装着钱的红色小信封，代表祝福！'],
        ['我也想收红包，哈哈。', 'I want one too, haha.', '哈哈，那先说「新年快乐」！']] }],
    'Travel stories': [
      { q: ['旅行的时候你丢过东西吗？', 'Have you ever lost something while travelling?'], s: [
        ['丢过手机，太伤心了。', 'My phone — so sad.', '天啊，那真的很难受！'],
        ['丢过雨伞，不过没关系。', 'An umbrella, but no big deal.', '雨伞是最容易丢的东西，哈哈。'],
        ['没有，我很小心。', 'No, I am careful.', '你真细心！']] },
      { q: ['你更喜欢计划好还是随便走走？', 'Do you plan everything or just wander?'], s: [
        ['我喜欢把一切都计划好。', 'I plan everything.', '有计划就不会慌！'],
        ['我喜欢随便走走，更自由。', 'I like to wander — more freedom.', '意外的风景往往最美！'],
        ['一半一半吧。', 'Half and half.', '灵活又安心，聪明！']] },
      { q: ['说说你最难忘的一次旅行吧！', 'Tell me about your most memorable trip!'], s: [
        ['我在海边看了日出，美极了。', 'I watched a sunrise by the sea — stunning.', '海边的日出真的难忘！'],
        ['我在山上迷路了，现在想想很好笑。', 'I got lost in the mountains — funny now.', '哈哈，迷路也是故事！'],
        ['我认识了很好的朋友。', 'I met wonderful friends.', '旅行中的朋友最珍贵！']] }],
    'Work & plans': [
      { q: ['你工作的时候喝咖啡吗？', 'Do you drink coffee while working?'], s: [
        ['喝，不喝咖啡没法工作。', 'Yes — I cannot work without it.', '咖啡就是打工人的朋友！'],
        ['偶尔喝。', 'Occasionally.', '偶尔喝提神刚刚好。'],
        ['不喝，我喝茶。', 'No — I drink tea.', '喝茶更健康！']] },
      { q: ['你喜欢在家工作还是去办公室？', 'Do you prefer working from home or at the office?'], s: [
        ['在家，很自由。', 'From home — freedom.', '在家穿睡衣工作，哈哈！'],
        ['办公室，效率高。', 'The office — more focus.', '办公室还有同事可以聊天！'],
        ['都可以。', 'Either.', '灵活最好！']] },
      { q: ['如果不用工作，你想做什么？', 'If you never had to work, what would you do?'], s: [
        ['我想环游世界。', 'Travel around the world.', '这是很多人的梦想！'],
        ['我想天天睡觉，哈哈。', 'Sleep every day, haha.', '哈哈，一个星期就无聊了！'],
        ['我想开一家小咖啡馆。', 'Open a little café.', '到时候我去你的咖啡馆坐坐！']] }],
    'Health & habits': [
      { q: ['你喝水喝得多吗？', 'Do you drink enough water?'], s: [
        ['多，我每天喝八杯水。', 'Yes — eight glasses a day.', '好习惯！'],
        ['不多，我总是忘。', 'Not much — I keep forgetting.', '设个提醒吧！多喝热水！'],
        ['还行。', 'It is OK.', '记得多喝一点儿！']] },
      { q: ['你睡觉前看手机吗？', 'Do you look at your phone before sleeping?'], s: [
        ['看，我知道不好，哈哈。', 'Yes — I know it is bad, haha.', '哈哈，我们都一样！'],
        ['不看，我早早睡觉。', 'No — I go to sleep early.', '太自律了，佩服！'],
        ['有时候看。', 'Sometimes.', '睡前看书更好哦！']] },
      { q: ['压力大的时候你做什么？', 'What do you do when you are stressed?'], s: [
        ['我去跑步。', 'I go running.', '跑完一身汗，烦恼都没了！'],
        ['我听音乐。', 'I listen to music.', '音乐最治愈了。'],
        ['我吃好吃的，哈哈。', 'I eat something tasty, haha.', '哈哈，美食解千愁！']] }],
    'City or countryside': [
      { q: ['你的城市有什么好玩的地方？', 'What is fun to see in your city?'], s: [
        ['有一个很漂亮的老城区。', 'A beautiful old town.', '老城区最有味道了！'],
        ['有很多好吃的饭馆。', 'Lots of good restaurants.', '那我一定要去尝尝！'],
        ['有一个大公园。', 'A big park.', '公园散步最舒服！']] },
      { q: ['你喜欢晚上的城市吗？', 'Do you like the city at night?'], s: [
        ['喜欢，灯光很漂亮。', 'Yes — the lights are beautiful.', '夜景确实很美！'],
        ['不喜欢，太吵了。', 'No — too noisy.', '安静的晚上更舒服。'],
        ['喜欢安静的晚上。', 'I like quiet evenings.', '安静的夜晚适合想事情。']] },
      { q: ['如果朋友来你的城市，你带他去哪儿？', 'If a friend visited, where would you take them?'], s: [
        ['我带他去吃最好吃的东西。', 'To eat the best food.', '好朋友就要一起吃好吃的！'],
        ['我带他看老城。', 'To see the old town.', '边走边讲故事，真好！'],
        ['我带他去我最喜欢的咖啡馆。', 'To my favourite café.', '一定是个特别的地方！']] }]
  };

  PRACTICE.forEach(function (scen) {
    var extra = PRACTICE_EXTRA[scen.t];
    if (extra) {
      var args = [scen.steps.length - 1, 0].concat(extra);
      Array.prototype.splice.apply(scen.steps, args);
    }
  });

  var GENERIC_REACTIONS = ['好的，我明白了。', '真的吗？有意思！', '嗯嗯，我知道了。', '哈哈，不错！'];
  var prax = { scen: null, step: 0, scores: [], answered: 0, busy: false, lvl: 1, last: null, mode: 'guided', tries: 0 };

  // the assistant can answer the user's own questions, like a real chat partner
  var CN_NUM = ['日', '一', '二', '三', '四', '五', '六'];
  var QA_RULES = [
    [/(.{1,6})是什么意思/, function (x) {
      var row = bestRow(cleanFrag(x));
      if (row) {
        return '「' + cleanFrag(x) + '」(' + pinyinMarked(row[2]) + ') 的意思是: ' + rowGloss(row) + '。';
      }
      return '这个词我也不认识，我们一起查词典吧！';
    }],
    [/你叫什么|你的名字|你是谁/, function () { return '我叫小智，是你的中文练习伙伴！'; }],
    [/你(?:今年)?(?:多大|几岁)/, function () { return '哈哈，我是电脑程序，没有年龄！'; }],
    [/你是哪国人|你(?:住|)在哪/, function () { return '我住在你的手机里，哈哈！'; }],
    [/现在几点|几点了/, function () {
      var d = new Date();
      return '现在' + d.getHours() + '点' + (d.getMinutes() < 10 ? '零' : '') + d.getMinutes() + '分。';
    }],
    [/今天(?:是)?星期几/, function () { return '今天星期' + CN_NUM[new Date().getDay()] + '。'; }],
    [/今天(?:是)?几号/, function () {
      var d = new Date();
      return '今天是' + (d.getMonth() + 1) + '月' + d.getDate() + '号。';
    }],
    [/天气怎么样/, function () { return '我看不到窗外，你告诉我吧！'; }],
    [/你喜欢什么|你有什么爱好/, function () { return '我最喜欢跟你用中文聊天！'; }],
    [/你会(.{1,6})吗/, function (x) { return '我会一点儿' + x + '，不过我们还是说中文吧！'; }],
    [/你喜欢(.{1,8})吗/, function (x) { return '我很喜欢' + x + '！'; }],
    [/(?:吗|呢)[？?]?$/, function () { return '好问题！不过我只是个小程序，说说你自己吧！'; }],
    [/[？?]$|为什么|怎么|什么|谁|哪/, function () { return '这个问题很有意思！我还在学习，你觉得呢？'; }]
  ];

  function qaAnswer(zh) {
    if (!/[？?吗呢]|什么|为什么|怎么|几点|几号|星期几|多大|几岁|谁|哪/.test(zh)) return null;
    for (var i = 0; i < QA_RULES.length; i++) {
      var m = zh.match(QA_RULES[i][0]);
      if (m) {
        var frag = m.length > 1 ? cleanFrag(m[1]) : '';
        if (m.length > 1 && !frag) continue;
        return QA_RULES[i][1](frag);
      }
    }
    return null;
  }

  // did we "understand"? (real mode only) — needs a clean match, a known
  // pattern, or at least one solid dictionary word in a long-enough answer
  function understood(zh, sugScore) {
    if (sugScore >= 45) return true;
    for (var i = 0; i < SMART_RULES.length; i++) {
      var m = zh.match(SMART_RULES[i][0]);
      if (m && (m.length === 1 || cleanFrag(m[1]))) return true;
    }
    var han = zh.replace(/[^㐀-鿿]/g, '');
    if (han.length < 3) return false;
    return segmentZh(zh).some(function (w) { return w.length >= 2 && /[㐀-鿿]/.test(w) && charPinyin.has(w); });
  }

  var RETRY_PROMPTS = [
    '不好意思，我没听懂。请再说一遍，好吗？',
    '什么？你说得有点儿快，再说一次吧。',
    '嗯……我没明白你的意思，可以再说一遍吗？'
  ];

  // bot replies without moving to the next question (questions, retries)
  function botReply(text) {
    prax.busy = true;
    var t = typingBubble();
    setTimeout(function () {
      t.remove();
      praxBubble(text, reactionGloss(text), 'bot');
      speakThen(text, function () { prax.busy = false; });
    }, 800);
  }

  // conversation mode picker: guided (forgiving) vs real (must be understood)
  (function () {
    var box = $('praxMode');
    [['guided', '🎓 Guided'], ['real', '💬 Real talk']].forEach(function (o, i) {
      var b = document.createElement('button');
      b.textContent = o[1];
      b.setAttribute('data-v', o[0]);
      if (i === 0) b.classList.add('sel');
      box.appendChild(b);
    });
    selectable(box);
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      prax.mode = b.getAttribute('data-v');
      updateModeNote();
    });
    updateModeNote();
  })();

  function updateModeNote() {
    $('praxModeNote').textContent = prax.mode === 'real'
      ? 'Real talk: if you speak unclearly, Xiao Zhi won’t understand and will ask you to repeat — just like a real person. You can also ask questions!'
      : 'Guided: every answer is accepted. You can also ask Xiao Zhi questions (现在几点？…是什么意思？).';
  }

  // level picker: the conversation vocabulary range
  (function () {
    var box = $('praxLevel');
    [[1, 'HSK 1'], [2, 'HSK 2'], [3, 'HSK 3+']].forEach(function (o, i) {
      var b = document.createElement('button');
      b.textContent = o[1];
      b.setAttribute('data-v', o[0]);
      if (i === 0) b.classList.add('sel');
      box.appendChild(b);
    });
    selectable(box);
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      prax.lvl = +b.getAttribute('data-v');
      startPractice(); // new topic from the chosen level
    });
  })();

  // speak and call done when the utterance finishes (with a time fallback,
  // since iOS sometimes never fires onend)
  function speakThen(text, done) {
    var called = false;
    function fire() { if (!called) { called = true; done(); } }
    var fallback = Math.min(6000, Math.max(1400, 320 * text.length));
    setTimeout(fire, fallback);
    if (!window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text);
    applyVoice(u);
    u.onend = fire;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function typingBubble() {
    var div = document.createElement('div');
    div.className = 'bubble typing';
    div.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    $('praxLines').appendChild(div);
    div.scrollIntoView({ block: 'nearest' });
    return div;
  }

  function startPractice(keepChat) {
    var pool = PRACTICE.filter(function (s) { return s.lvl === prax.lvl; });
    if (pool.length > 1 && prax.last) {
      var narrowed = pool.filter(function (s) { return s !== prax.last; });
      if (narrowed.length) pool = narrowed;
    }
    prax.scen = pick(pool);
    prax.last = prax.scen;
    prax.step = 0;
    prax.busy = false;
    if (!keepChat) {
      prax.scores = [];
      prax.answered = 0;
      $('praxLines').innerHTML = '';
    }
    $('dlgList').hidden = true;
    $('dlgView').hidden = true;
    $('praxView').hidden = false;
    $('praxTitle').textContent = '🤖 ' + prax.scen.e + ' ' + prax.scen.t + ' · HSK ' + (prax.scen.lvl === 3 ? '3+' : prax.scen.lvl);
    $('praxText').value = '';
    applyDlgToggles();
    if (keepChat) {
      // seamless topic change inside the same chat
      var t = typingBubble();
      setTimeout(function () {
        t.remove();
        var opener = pick(['我们换个话题吧！', '再聊点儿别的！', '好，下一个话题！']);
        praxBubble(opener, 'Let’s switch topics!', 'bot');
        setTimeout(botAsk, 900);
      }, 900);
    } else {
      botAsk();
    }
  }

  // rough English gloss for generated assistant reactions (which have no
  // pre-written translation) — word by word from the dictionary, so every
  // assistant bubble shows what it means, like the questions do
  function reactionGloss(zh) {
    var parts = segmentZh(zh).map(function (w) {
      if (!/[㐀-鿿]/.test(w)) return '';
      var row = bestRow(w);
      if (!row) return '';
      // prefer a plain word over bracketed grammar notes like "(adverb of degree)"
      var defs = row[3].split(';');
      for (var i = 0; i < defs.length; i++) {
        var d = defs[i].trim();
        if (!d || d.charAt(0) === '(' || /^(surname |CL:|old variant|variant of|abbr)/i.test(d)) continue;
        return d.split(/[,、]/)[0].trim();
      }
      return rowGloss(row).replace(/^\([^)]*\)\s*/, '');
    }).filter(Boolean);
    return parts.join(' · ');
  }

  function praxBubble(zh, en, who) {
    var div = document.createElement('div');
    div.className = 'bubble' + (who === 'me' ? ' b' : '');
    div.innerHTML = '<span class="who">' + (who === 'me' ? '你 you' : '🤖 assistant') + '</span>' +
      '<button class="speak" data-say="' + esc(zh) + '">🔊</button>' +
      '<div class="zh">' + rubyHtml(zh, null) + '</div>' +
      '<div class="dlg-split">' + hintChipsHtml(zh, true) + '</div>' +
      (en ? '<div class="dlg-en">' + esc(en) + '</div>' : '');
    $('praxLines').appendChild(div);
    bindSpeakButtons(div);
    div.scrollIntoView({ block: 'nearest' });
    return div;
  }

  function botAsk() {
    var step = prax.scen.steps[prax.step];
    praxBubble(step.q[0], step.q[1], 'bot');
    speak(step.q[0]);
    prax.busy = false;
    prax.tries = 0;
    $('praxSuggBox').hidden = true;
    $('praxSuggBox').innerHTML = '';
    if (step.end) {
      finishPractice();
      return;
    }
    $('praxInput').hidden = false;
    $('praxSugg').parentElement.hidden = false;
  }

  function finishPractice() {
    $('praxInput').hidden = true;
    $('praxSugg').parentElement.hidden = true;
    var msg;
    if (prax.answered) {
      var avg = Math.round(prax.scores.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, prax.scores.length));
      msg = 'You answered ' + prax.answered + ' question' + (prax.answered > 1 ? 's' : '') +
        (prax.scores.length ? ' — average match ' + avg + '%.' : '.') + ' 加油！';
    } else {
      msg = 'Topic finished!';
    }
    var div = document.createElement('div');
    div.className = 'muted';
    div.style.padding = '10px 2px';
    div.textContent = msg;
    $('praxLines').appendChild(div);
    var cont = document.createElement('button');
    cont.className = 'primary wide';
    cont.textContent = '💬 Keep chatting — next topic';
    cont.addEventListener('click', function () {
      cont.remove();
      startPractice(true);
    });
    $('praxLines').appendChild(cont);
    cont.scrollIntoView({ block: 'nearest' });
  }

  // "understanding" layer: build a reaction from what the user actually said.
  // Ordered patterns — first match wins; captured fragment is echoed back.
  var SMART_RULES = [
    [/我叫(.{1,7}?)[。！？，]?$/, function (x) { return x + '，这个名字真好听！'; }],
    [/我(?:的名字)?是(.{1,6})人/, function (x) { return x + '！我听说' + x + '很漂亮。'; }],
    [/不喜欢(.{1,8}?)[。！？，]?$/, function (x) { return '哦，原来你不喜欢' + x + '。每个人口味不一样嘛。'; }],
    [/喜欢(.{1,8}?)[。！？，]?$/, function (x) { return '你喜欢' + x + '！我也觉得' + x + '很不错。'; }],
    [/不想(.{1,8}?)[。！？，]?$/, function (x) { return '不想' + x + '也没关系。'; }],
    [/想(.{1,8}?)[。！？，]?$/, function (x) { return '希望你能' + x + '！'; }],
    [/不会(.{1,6}?)[。！？，]?$/, function (x) { return '不会' + x + '没关系，可以慢慢学！'; }],
    [/会(.{1,6}?)[。！？，]?$/, function (x) { return '你会' + x + '，真厉害！'; }],
    [/去过(.{1,6}?)[。！？，]?$/, function (x) { return x + '？听起来很好玩！'; }],
    [/我是(.{1,6}?)[。！？，]?$/, function (x) { return '原来你是' + x + '！'; }],
    [/我有(.{1,7}?)[。！？，]?$/, function (x) { return '你有' + x + '，真好！'; }],
    [/没有|没去过|还没/, function () { return '没关系，以后有机会的！'; }],
    [/下雨|下雪/, function () { return '这样的天气记得多穿点儿，出门带伞哦。'; }],
    [/很冷|太冷/, function () { return '冷的话要注意保暖啊！'; }],
    [/很热|太热/, function () { return '热的话要多喝水哦！'; }],
    [/很忙|太忙|很累|太累/, function () { return '辛苦了，要好好休息。'; }],
    [/谢谢/, function () { return '不客气！'; }]
  ];
  var ECHO_TEMPLATES = [
    function (w) { return '你说到“' + w + '”，很有意思！'; },
    function (w) { return '“' + w + '”，嗯，我记住了！'; },
    function (w) { return '原来是“' + w + '”啊，明白了！'; }
  ];

  function cleanFrag(x) {
    return (x || '').replace(/^[的了吧呢啊哦]+|[。！？，、的了吧呢啊哦]+$/g, '');
  }

  function smartReaction(zh) {
    for (var i = 0; i < SMART_RULES.length; i++) {
      var m = zh.match(SMART_RULES[i][0]);
      if (m) {
        var frag = cleanFrag(m[1]);
        if (m.length > 1 && !frag) continue; // capture required but empty
        return SMART_RULES[i][1](frag);
      }
    }
    // echo the longest dictionary word from the answer
    var words = segmentZh(zh).filter(function (w) { return /[㐀-鿿]/.test(w) && w.length >= 2; });
    if (words.length) {
      words.sort(function (a, b) { return b.length - a.length; });
      return pick(ECHO_TEMPLATES)(words[0]);
    }
    return null;
  }

  function praxAnswer(zhRaw) {
    var step = prax.scen.steps[prax.step];
    if (!step || step.end || prax.busy) return;
    var zh = zhRaw.trim();
    if (!zh) return;
    prax.busy = true;
    var bubble = praxBubble(zh, null, 'me');
    // compare with the suggested answers: best pinyin-syllable match
    var best = null;
    step.s.forEach(function (sug) {
      var r = matchSpeech(sug[0], zh);
      if (!best || r.score > best.score) best = { sug: sug, score: r.score };
    });
    // not an answer but the user's own question? answer it and stay on this step
    if (!(best && best.score >= 45)) {
      var qa = qaAnswer(zh);
      if (qa) { botReply(qa); return; }
      // real talk: unclear speech is genuinely not understood
      if (prax.mode === 'real' && !understood(zh, best ? best.score : 0)) {
        prax.tries++;
        if (prax.tries >= 2) {
          if ($('praxSuggBox').hidden) renderPraxSuggestions();
          botReply('没关系，慢慢来！你可以看看下面的建议，再试一次。');
        } else {
          botReply(pick(RETRY_PROMPTS));
        }
        return;
      }
    }
    prax.answered++;
    prax.tries = 0;
    var reaction;
    if (best && best.score >= 45) {
      prax.scores.push(best.score);
      // per-character feedback against the closest suggestion: green = said
      // right, red = pronunciation to fix — not just an overall percentage
      var m = matchSpeech(best.sug[0], zh);
      var colored = m.syls.map(function (s, i) {
        return '<span class="' + (m.ok[i] ? 'say-ok' : 'say-bad') + '">' + esc(s.ch) + '</span>';
      }).join('');
      var fb = document.createElement('div');
      fb.className = 'say-fb';
      fb.innerHTML = '<div class="say-target">' + colored + '</div>' +
        '<div class="say-heard">' + best.score + '% — ' +
        (best.score >= 90 ? 'excellent pronunciation! 🎉'
          : best.score >= 70 ? 'good — the red characters need work'
          : 'practice the red characters and try again') + '</div>' +
        missedCharsHtml(m.syls, m.ok);
      bubble.appendChild(fb);
      reaction = best.score >= 60 ? best.sug[2] : (smartReaction(zh) || pick(GENERIC_REACTIONS));
    } else {
      reaction = smartReaction(zh) || pick(GENERIC_REACTIONS);
    }
    prax.step++;
    // conversational pacing: think → react (spoken) → pause → next question
    var t1 = typingBubble();
    setTimeout(function () {
      t1.remove();
      praxBubble(reaction, reactionGloss(reaction), 'bot');
      speakThen(reaction, function () {
        var t2 = typingBubble();
        setTimeout(function () {
          t2.remove();
          botAsk();
        }, 1100);
      });
    }, 1000);
  }

  function renderPraxSuggestions() {
    var step = prax.scen.steps[prax.step];
    if (!step || step.end) return;
    var box = $('praxSuggBox');
    box.hidden = !box.hidden;
    if (box.hidden) return;
    box.innerHTML = '<p class="muted" style="margin:0 0 6px">You could answer for example… (tap 🔊, then say it yourself)</p>';
    step.s.forEach(function (sug) {
      var row = document.createElement('div');
      row.className = 'sug-row';
      row.innerHTML = '<button class="speak" data-say="' + esc(sug[0]) + '">🔊</button>' +
        '<div><div class="zh">' + rubyHtml(sug[0], null) + '</div>' +
        '<div class="dlg-en">' + esc(sug[1]) + '</div></div>';
      box.appendChild(row);
    });
    bindSpeakButtons(box);
  }

  $('praxBack').addEventListener('click', function () {
    $('praxView').hidden = true;
    $('dlgList').hidden = false;
  });
  $('praxNew').addEventListener('click', function () { startPractice(); });
  $('praxSugg').addEventListener('click', renderPraxSuggestions);
  $('praxSkip').addEventListener('click', function () {
    var step = prax.scen.steps[prax.step];
    if (!step || step.end || prax.busy) return;
    prax.step++;
    botAsk();
  });
  $('praxSend').addEventListener('click', function () {
    var v = $('praxText').value;
    $('praxText').value = '';
    praxAnswer(v);
  });
  $('praxText').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); $('praxSend').click(); }
  });
  $('praxMic').addEventListener('click', function () {
    var btn = $('praxMic');
    if (!SR) { alert(NO_SR_MSG); return; }
    if (prax.rec) { try { prax.rec.stop(); } catch (e) {} return; }
    btn.classList.add('listening');
    btn.textContent = '⏹';
    function reset() {
      prax.rec = null;
      btn.classList.remove('listening');
      btn.textContent = '🎤';
    }
    prax.rec = listenZh(function (alts) {
      reset();
      $('praxText').value = '';
      praxAnswer((alts[0] || '').replace(/[^㐀-鿿。！？，]/g, ''));
    }, function () { reset(); },
    function (partial) { $('praxText').value = partial; });
  });

  // ---------------------------------------------------------------- words list
  var wl = { rows: [], shown: 0 };

  (function () {
    var box = $('wordsLevel');
    var opts = [['0', 'Top'], ['1', 'HSK 1'], ['2', 'HSK 2'], ['3', 'HSK 3'], ['4', 'HSK 4'], ['5', 'HSK 5'], ['6', 'HSK 6']];
    opts.forEach(function (o, i) {
      var b = document.createElement('button');
      b.textContent = o[1];
      b.setAttribute('data-v', o[0]);
      if (i === 0) b.classList.add('sel');
      box.appendChild(b);
    });
    selectable(box);
    box.addEventListener('click', function (ev) {
      if (ev.target.closest('button')) renderWords(true);
    });
  })();

  function wordPool(level) {
    if (level > 0) {
      return hskPool(level).sort(function (a, b) { return b[4] - a[4]; });
    }
    // Top: most frequent words in the sentence corpus
    var seen = {};
    var rows = [];
    for (var i = 0; i < dict.length; i++) {
      var r = dict[i];
      if (r[4] > 0 && !seen[r[0]] && !/[A-Z]/.test(r[2])) {
        seen[r[0]] = true;
        rows.push(r);
      }
    }
    rows.sort(function (a, b) { return b[4] - a[4]; });
    return rows.slice(0, 500);
  }

  function renderWords(reset) {
    if (!dict) return;
    if (reset || !wl.rows.length) {
      wl.rows = wordPool(selectedVal('wordsLevel'));
      wl.shown = 0;
      $('wordsList').innerHTML = '';
    }
    var box = $('wordsList');
    var end = Math.min(wl.shown + 40, wl.rows.length);
    for (var i = wl.shown; i < end; i++) {
      box.appendChild(wordRowEl(wl.rows[i]));
    }
    wl.shown = end;
    $('wordsMore').hidden = wl.shown >= wl.rows.length;
  }

  function wordRowEl(row) {
    var div = document.createElement('div');
    div.className = 'word-row';
    var main = document.createElement('button');
    main.className = 'opt-main';
    main.innerHTML = '<span class="opt-hz">' + esc(row[0]) + '</span>' +
      '<span class="opt-py">' + pinyinHtml(row[2]) + '</span>' +
      (row[5] ? '<span class="badge">HSK ' + row[5] + '</span>' : '') +
      '<span class="opt-gloss" hidden>— ' + esc(rowGloss(row)) + '</span>';
    main.title = 'Open in dictionary';
    main.addEventListener('click', function () {
      setWord(row[0]);
      showTab('dict');
    });
    var sp = document.createElement('button');
    sp.className = 'speak';
    sp.textContent = '🔊';
    sp.addEventListener('click', function () { speak(row[0]); });
    var ib = document.createElement('button');
    ib.className = 'opt-info';
    ib.textContent = 'show';
    ib.addEventListener('click', function () {
      var g = main.querySelector('.opt-gloss');
      g.hidden = !g.hidden;
      ib.textContent = g.hidden ? 'show' : 'hide';
    });
    div.appendChild(main);
    div.appendChild(sp);
    div.appendChild(ib);
    return div;
  }

  $('wordsMore').addEventListener('click', function () { renderWords(false); });
  $('wordsShowAll').addEventListener('click', function () { setAllGlosses(false); });
  $('wordsHideAll').addEventListener('click', function () { setAllGlosses(true); });
  function setAllGlosses(hide) {
    $('wordsList').querySelectorAll('.opt-gloss').forEach(function (g) { g.hidden = hide; });
    $('wordsList').querySelectorAll('.opt-info').forEach(function (b) { b.textContent = hide ? 'show' : 'hide'; });
  }

  // ---------------------------------------------------------------- rules: how words are built (构词法)
  // examples: [word, per-character glosses joined with |, meaning]
  var RULES = [
    { hz: '动宾式', py: 'dòngbīnshì', name: 'Verb–Object', formula: 'ACTION + THING',
      how: 'The first character is an action, the second is what the action is done to — exactly like “eat dinner” or “sing a song”. Many everyday “verbs” in Chinese are secretly a verb plus its little built-in object.',
      ex: [
        ['吃饭', 'eat|meal', 'to eat, have a meal'],
        ['睡觉', 'sleep|a sleep', 'to sleep'],
        ['唱歌', 'sing|song', 'to sing'],
        ['说话', 'speak|words', 'to talk'],
        ['看书', 'read|book', 'to read'],
        ['开车', 'drive|car', 'to drive'],
        ['跳舞', 'jump|dance', 'to dance'],
        ['见面', 'meet|face', 'to meet up'],
        ['上班', 'go to|work shift', 'to go to work'],
        ['下课', 'finish|class', 'class is over'],
        ['结婚', 'tie|marriage', 'to get married'],
        ['帮忙', 'help|a task', 'to help out'],
        ['照相', 'shoot|image', 'to take a photo'],
        ['洗澡', 'wash|bath', 'to take a shower'],
        ['散步', 'scatter|steps', 'to take a walk'],
        ['游泳', 'swim|swimming', 'to swim']] },
    { hz: '偏正式', py: 'piānzhèngshì', name: 'Modifier–Head', formula: 'DESCRIPTION + THING',
      how: 'The first character describes the second one — like “fire-cart” for train or “electric-brain” for computer. The last character tells you WHAT it is, the first tells you WHAT KIND.',
      ex: [
        ['火车', 'fire|vehicle', 'train'],
        ['飞机', 'flying|machine', 'airplane'],
        ['电脑', 'electric|brain', 'computer'],
        ['手机', 'hand|machine', 'mobile phone'],
        ['黑板', 'black|board', 'blackboard'],
        ['冰箱', 'ice|box', 'fridge'],
        ['眼镜', 'eye|lens', 'glasses'],
        ['牛奶', 'cow|milk', 'milk'],
        ['中文', 'China|writing', 'Chinese language'],
        ['大人', 'big|person', 'adult'],
        ['小说', 'small|talk', 'novel'],
        ['白菜', 'white|vegetable', 'Chinese cabbage'],
        ['课本', 'lesson|book', 'textbook'],
        ['雨衣', 'rain|clothes', 'raincoat'],
        ['夜市', 'night|market', 'night market'],
        ['热水', 'hot|water', 'hot water']] },
    { hz: '并列式', py: 'bìnglièshì', name: 'Parallel', formula: 'TWIN + TWIN',
      how: 'Two characters with similar (or exactly opposite) meanings stand side by side as equals. Two synonyms reinforce one idea — and two opposites melt into a new one: “east-west” becomes “thing”, “buy-sell” becomes “trade”.',
      ex: [
        ['朋友', 'friend|companion', 'friend'],
        ['学习', 'study|practise', 'to learn'],
        ['快乐', 'glad|joyful', 'happy'],
        ['身体', 'body|body', 'body, health'],
        ['声音', 'sound|tone', 'sound, voice'],
        ['语言', 'speech|words', 'language'],
        ['道路', 'road|path', 'road'],
        ['东西', 'east|west', 'thing'],
        ['买卖', 'buy|sell', 'trade, business'],
        ['大小', 'big|small', 'size'],
        ['多少', 'many|few', 'how many?'],
        ['左右', 'left|right', 'approximately'],
        ['开关', 'open|close', 'switch'],
        ['呼吸', 'breathe out|breathe in', 'to breathe'],
        ['父母', 'father|mother', 'parents'],
        ['早晚', 'morning|evening', 'sooner or later']] },
    { hz: '补充式', py: 'bǔchōngshì', name: 'Complementary', formula: 'ACTION + RESULT',
      how: 'The first character is the action, the second tells you how it ends — the result. “Look + perceive” = to see, “study + able” = to master. The second brick answers: and did it work?',
      ex: [
        ['看见', 'look|perceive', 'to see'],
        ['听懂', 'listen|understand', 'to understand (by ear)'],
        ['学会', 'study|be able', 'to master'],
        ['找到', 'search|arrive', 'to find'],
        ['打开', 'strike|open', 'to open'],
        ['提高', 'lift|high', 'to improve, raise'],
        ['说明', 'speak|clear', 'to explain'],
        ['完成', 'finish|become', 'to complete'],
        ['记住', 'note|stay', 'to remember firmly'],
        ['写完', 'write|finish', 'to finish writing'],
        ['吃饱', 'eat|full', 'to eat one’s fill'],
        ['改进', 'change|forward', 'to improve'],
        ['站住', 'stand|halt', 'to stop, halt'],
        ['推翻', 'push|overturn', 'to overthrow'],
        ['看清', 'look|clear', 'to see clearly'],
        ['长大', 'grow|big', 'to grow up']] },
    { hz: '主谓式', py: 'zhǔwèishì', name: 'Subject–Predicate', formula: 'THING + WHAT IT DOES',
      how: 'A tiny sentence frozen into a word: the first character is the subject, the second says what it does or how it is. “Earth shakes” = earthquake, “head aches” = headache. A whole sentence in two bricks!',
      ex: [
        ['地震', 'earth|shakes', 'earthquake'],
        ['头疼', 'head|aches', 'headache'],
        ['心疼', 'heart|aches', 'to feel sorry for, dote on'],
        ['年轻', 'years|light', 'young'],
        ['眼红', 'eyes|red', 'jealous'],
        ['胆小', 'gallbladder|small', 'timid, cowardly'],
        ['嘴硬', 'mouth|hard', 'stubborn (never admits fault)'],
        ['性急', 'temper|quick', 'impatient'],
        ['面熟', 'face|familiar', 'looks familiar'],
        ['手软', 'hand|soft', 'lenient, soft-handed'],
        ['耳鸣', 'ear|rings', 'ringing in the ears'],
        ['眼花', 'eyes|blurred', 'dazzled, seeing stars'],
        ['心细', 'heart|fine', 'careful, attentive'],
        ['嘴甜', 'mouth|sweet', 'sweet-talking'],
        ['命苦', 'fate|bitter', 'ill-fated'],
        ['气短', 'breath|short', 'short of breath, disheartened']] }
  ];

  var rulesBuilt = false;
  function renderRules() {
    if (rulesBuilt) return;
    rulesBuilt = true;
    var wrap = $('rulesList');
    RULES.forEach(function (rule, ri) {
      var card = document.createElement('section');
      card.className = 'card';
      card.innerHTML = '<div class="pad-head"><h2>' + esc(rule.name) + ' — ' + esc(rule.hz) +
        ' <span class="rule-py">' + esc(rule.py) + '</span></h2>' +
        '<button class="ghost small rule-more">🎲 New examples</button></div>' +
        '<p class="def">' + esc(rule.how) + '</p>' +
        '<p class="rule-formula">' + esc(rule.formula) + '</p>' +
        '<div class="rule-ex"></div>';
      wrap.appendChild(card);
      var exBox = card.querySelector('.rule-ex');
      function refill() {
        exBox.innerHTML = '';
        shuffle(rule.ex.slice()).slice(0, 4).forEach(function (ex) {
          exBox.appendChild(ruleExampleEl(ex));
        });
      }
      card.querySelector('.rule-more').addEventListener('click', refill);
      refill();
    });
  }

  function ruleExampleEl(ex) {
    var word = ex[0], glosses = ex[1].split('|'), meaning = ex[2];
    var row = document.createElement('div');
    row.className = 'rule-row';
    var chars = word.split('');
    var literal = chars.map(function (ch, i) {
      return '<span class="rule-chunk"><b>' + esc(ch) + '</b> ' + esc(glosses[i] || '') + '</span>';
    }).join('<span class="rule-plus">+</span>');
    var r = bestRow(word);
    var main = document.createElement('button');
    main.className = 'opt-main';
    main.title = 'Open in dictionary';
    main.innerHTML = '<span class="opt-hz">' + esc(word) + '</span>' +
      (r ? '<span class="opt-py">' + pinyinHtml(r[2]) + '</span>' : '');
    main.addEventListener('click', function () {
      setWord(word);
      showTab('dict');
    });
    var sp = document.createElement('button');
    sp.className = 'speak';
    sp.textContent = '🔊';
    sp.addEventListener('click', function () { speak(word); });
    var top = document.createElement('div');
    top.className = 'word-row';
    top.appendChild(main);
    top.appendChild(sp);
    row.appendChild(top);
    var lit = document.createElement('div');
    lit.className = 'rule-literal';
    lit.innerHTML = literal + '<span class="rule-arrow">→</span>' + esc(meaning);
    row.appendChild(lit);
    return row;
  }

  // ---------------------------------------------------------------- sentence writing (live)
  var build = { pool: [], sent: null, cells: [], idx: 0, written: 0, skipped: 0, lvl: 1,
                strokes: [], drawing: false, current: null, seq: 0, pools: null, ctx: null, hintAnim: null };
  var PUNCT = '。！？，、…';

  (function () {
    var box = $('buildLevel');
    [[1, 'HSK 1'], [2, 'HSK 2'], [3, 'HSK 3+']].forEach(function (o, i) {
      var b = document.createElement('button');
      b.textContent = o[1];
      b.setAttribute('data-v', o[0]);
      if (i === 0) b.classList.add('sel');
      box.appendChild(b);
    });
    selectable(box);
  })();

  function buildPools() {
    if (build.pools) return true;
    if (!dict || !sentences || !medians) return false;
    // min positive HSK per single simplified character
    var charHsk = new Map();
    for (var i = 0; i < dict.length; i++) {
      var r = dict[i];
      if (r[0].length === 1 && r[5]) {
        var cur = charHsk.get(r[0]);
        if (!cur || r[5] < cur) charHsk.set(r[0], r[5]);
      }
    }
    var pools = { 1: [], 2: [], 3: [] };
    var seen = {};
    for (i = 0; i < sentences.length; i++) {
      var zh = sentences[i][0], en = sentences[i][1];
      if (seen[zh]) continue;
      var han = [], ok = true, maxH = 0;
      for (var j = 0; j < zh.length; j++) {
        var ch = zh[j];
        if (/[㐀-鿿]/.test(ch)) {
          if (!medians[ch] && !medians[toSimp(ch)]) { ok = false; break; }
          han.push(ch);
          var h = charHsk.get(ch) || charHsk.get(toSimp(ch)) || 7;
          if (h > maxH) maxH = h;
        } else if (PUNCT.indexOf(ch) < 0) { ok = false; break; }
      }
      if (!ok || han.length < 2 || han.length > 9) continue;
      seen[zh] = true;
      var rec = { zh: zh, en: en, len: han.length };
      if (maxH <= 2 && han.length <= 4) pools[1].push(rec);
      if (maxH <= 4 && han.length <= 6) pools[2].push(rec);
      if (maxH <= 6 && han.length <= 8) pools[3].push(rec);
    }
    build.pools = pools;
    return true;
  }

  $('buildStart').addEventListener('click', function () {
    build.lvl = selectedVal('buildLevel');
    if (!buildPools()) {
      build.pendingStart = true;
      var note = $('buildSetupNote');
      note.hidden = false;
      note.textContent = 'Loading the sentence library… it will start automatically in a moment (first time only).';
      return;
    }
    build.pendingStart = false;
    $('buildSetupNote').hidden = true;
    nextSentence();
  });

  // called when the sentence data finishes loading, in case Start is waiting
  function buildDataReady() {
    if (build.pendingStart && !$('tab-build').hidden && !$('buildSetup').hidden) {
      build.pendingStart = false;
      $('buildSetupNote').hidden = true;
      build.lvl = selectedVal('buildLevel');
      if (buildPools()) nextSentence();
    }
  }

  function nextSentence() {
    var pool = build.pools[build.lvl];
    if (!pool || !pool.length) { pool = build.pools[3]; }
    build.sent = pick(pool);
    build.idx = 0; build.written = 0; build.skipped = 0;
    build.strokes = []; build.current = null;
    $('buildSetup').hidden = true; $('buildDone').hidden = true; $('buildPlay').hidden = false;
    $('buildEn').textContent = build.sent.en;
    renderSlots();
    sizeSpad();
    advanceTarget();
  }

  function renderSlots() {
    var box = $('buildSlots');
    box.innerHTML = '';
    build.cells = [];
    var zh = build.sent.zh;
    for (var i = 0; i < zh.length; i++) {
      var ch = zh[i];
      var isHan = /[㐀-鿿]/.test(ch);
      var slot = document.createElement('div');
      slot.className = 'bslot' + (isHan ? '' : ' punct');
      slot.setAttribute('data-ch', ch);
      if (isHan) {
        var row = bestRow(ch) || bestRow(toSimp(ch));
        var py = row ? row[2].split(/\s+/)[0] : (charPinyin.get(ch) ? charPinyin.get(ch).split(/\s+/)[0] : '');
        slot.innerHTML = '<span class="bslot-py">' + (py ? pinyinHtml(py) : '') + '</span>' +
          '<span class="bslot-hz"></span>';
      } else {
        slot.innerHTML = '<span class="bslot-py"></span><span class="bslot-hz">' + esc(ch) + '</span>';
      }
      box.appendChild(slot);
      build.cells.push({ el: slot, ch: ch, han: isHan, filled: !isHan });
    }
  }

  function advanceTarget() {
    build.cells.forEach(function (c) { c.el.classList.remove('active'); });
    while (build.idx < build.cells.length && build.cells[build.idx].filled) build.idx++;
    if (build.idx >= build.cells.length) { finishBuild(); return; }
    var cell = build.cells[build.idx];
    cell.el.classList.add('active');
    var row = bestRow(cell.ch) || bestRow(toSimp(cell.ch));
    $('buildTargetPy').innerHTML = row ? pinyinHtml(row[2]) : (charPinyin.get(cell.ch) ? pinyinHtml(charPinyin.get(cell.ch)) : cell.ch);
    var done = build.cells.filter(function (c) { return c.filled; }).length;
    $('buildProgress').textContent = 'Sentence · ' + done + ' / ' + build.cells.length + ' written';
    clearSpad();
    cell.el.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function fillCell(cell, skipped) {
    cell.el.querySelector('.bslot-hz').textContent = cell.ch;
    cell.el.classList.remove('active');
    cell.el.classList.add(skipped ? 'skipped' : 'done');
    cell.filled = true;
    if (cell.han) srsGrade(cell.ch, !skipped);
    if (!skipped) { build.written++; speak(cell.ch); } else { build.skipped++; }
    build.idx++;
    setTimeout(advanceTarget, 350);
  }

  function currentTarget() {
    return build.idx < build.cells.length ? build.cells[build.idx] : null;
  }

  function targetStrokeCount(ch) {
    var m = medians[ch] || medians[toSimp(ch)];
    if (!m) return 0;
    return m.length / (10 * 2);
  }

  // ---- spad drawing ----
  var spad = $('spad');
  function sizeSpad() {
    var cssW = spad.clientWidth || 300;
    var dpr = window.devicePixelRatio || 1;
    spad.height = spad.width = Math.round(cssW * dpr);
    build.ctx = spad.getContext('2d');
    build.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawSpad();
  }
  window.addEventListener('resize', function () { if (!$('tab-build').hidden && !$('buildPlay').hidden) sizeSpad(); });

  function spadInk() {
    var g = build.ctx;
    g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = getComputedStyle(document.body).color;
  }
  function redrawSpad() {
    if (!build.ctx) return;
    build.ctx.clearRect(0, 0, spad.width, spad.height);
    spadInk();
    build.strokes.concat(build.current ? [build.current] : []).forEach(function (st) {
      build.ctx.beginPath();
      build.ctx.moveTo(st[0][0], st[0][1]);
      for (var i = 1; i < st.length; i++) build.ctx.lineTo(st[i][0], st[i][1]);
      build.ctx.stroke();
    });
  }
  function spadPos(ev) {
    var r = spad.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }
  spad.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    spad.setPointerCapture(ev.pointerId);
    build.drawing = true;
    build.current = [spadPos(ev)];
    spadInk();
  });
  spad.addEventListener('pointermove', function (ev) {
    if (!build.drawing) return;
    var p = spadPos(ev), last = build.current[build.current.length - 1];
    build.current.push(p);
    build.ctx.beginPath();
    build.ctx.moveTo(last[0], last[1]);
    build.ctx.lineTo(p[0], p[1]);
    build.ctx.stroke();
  });
  function spadEnd() {
    if (!build.drawing) return;
    build.drawing = false;
    if (build.current && build.current.length > 1) {
      build.strokes.push(build.current);
      buildRecognize();
    }
    build.current = null;
  }
  spad.addEventListener('pointerup', spadEnd);
  spad.addEventListener('pointercancel', spadEnd);

  function clearSpad() {
    build.strokes = []; build.current = null;
    redrawSpad();
    $('buildCand').innerHTML = '';
    $('spadStatus').textContent = build.hintAnim ? '' : '';
    $('spadStatus').style.display = 'none';
  }
  $('buildClearPad').addEventListener('click', clearSpad);
  $('buildUndo').addEventListener('click', function () {
    build.strokes.pop();
    redrawSpad();
    if (build.strokes.length) buildRecognize(); else $('buildCand').innerHTML = '';
  });

  function buildRecognize() {
    var target = currentTarget();
    if (!target) return;
    if (!recognizerReady && !shapeBuckets) { return; }
    var seq = ++build.seq;
    rankStrokes(build.strokes, 10, function (ranked) {
      if (seq !== build.seq) return;
      var box = $('buildCand');
      box.innerHTML = '';
      var matched = ranked.some(function (c) { return c === target.ch || toSimp(c) === toSimp(target.ch); });
      ranked.forEach(function (ch) {
        var b = document.createElement('button');
        b.textContent = ch;
        var isTarget = (ch === target.ch || toSimp(ch) === toSimp(target.ch));
        if (isTarget) b.classList.add('cand-ok');
        b.addEventListener('click', function () {
          if (isTarget) fillCell(target, false);
          else { b.classList.add('cand-bad'); setTimeout(function () { b.classList.remove('cand-bad'); }, 500); }
        });
        box.appendChild(b);
      });
      // auto-accept once enough strokes drawn and the target is the top guess
      var need = targetStrokeCount(target.ch);
      if (matched && ranked[0] && (ranked[0] === target.ch || toSimp(ranked[0]) === toSimp(target.ch)) &&
          (!need || build.strokes.length >= need)) {
        setTimeout(function () { if (seq === build.seq && currentTarget() === target) fillCell(target, false); }, 250);
      }
    });
  }

  // hint: animate the stroke order of the current character on the pad
  $('buildHint').addEventListener('click', function () {
    var target = currentTarget();
    if (!target) return;
    var mch = medians[target.ch] ? target.ch : (medians[toSimp(target.ch)] ? toSimp(target.ch) : null);
    if (!mch) return;
    build.strokes = []; build.current = null;
    var animate = makeStrokeAnimator(spad, mch);
    animate();
  });
  $('buildSkipChar').addEventListener('click', function () {
    var target = currentTarget();
    if (target) fillCell(target, true);
  });
  $('buildQuit').addEventListener('click', finishBuild);

  function finishBuild() {
    $('buildPlay').hidden = true;
    $('buildDone').hidden = false;
    var zh = build.sent.zh;
    $('buildResult').innerHTML =
      '<div class="zh">' + rubyHtml(zh, null) + ' <button class="speak" data-say="' + esc(zh) + '">🔊</button></div>' +
      '<div class="dlg-split">' + hintChipsHtml(zh, true) + '</div>' +
      '<div class="dlg-en">' + esc(build.sent.en) + '</div>';
    var res = $('buildResult');
    res.className = 'dlg-lines split';
    bindSpeakButtons(res);
    speak(zh);
    var total = build.cells.filter(function (c) { return c.han; }).length;
    $('buildStats').textContent = build.skipped
      ? 'You wrote ' + build.written + ' of ' + total + ' characters yourself (' + build.skipped + ' shown).'
      : 'You wrote all ' + total + ' characters yourself! 🌟';
  }

  $('buildNext').addEventListener('click', nextSentence);
  $('buildNewLevel').addEventListener('click', function () {
    $('buildDone').hidden = true; $('buildSetup').hidden = false;
  });

  // ---------------------------------------------------------------- dictionary search (pinyin / English)
  var searchPy = null, searchEn = null; // parallel normalized indexes, built lazily
  function buildSearchIndex() {
    if (searchPy) return true;
    if (!dict) return false;
    searchPy = new Array(dict.length);
    searchEn = new Array(dict.length);
    for (var i = 0; i < dict.length; i++) {
      searchPy[i] = dict[i][2].toLowerCase().replace(/u:/g, 'u').replace(/[1-5]/g, '').replace(/\s+/g, '');
      searchEn[i] = dict[i][3].toLowerCase();
    }
    return true;
  }

  function runSearch(qRaw) {
    var box = $('searchResults');
    var q = qRaw.trim().toLowerCase().slice(0, 40);
    if (!q) { box.hidden = true; box.innerHTML = ''; return; }
    if (!buildSearchIndex()) { box.hidden = false; box.innerHTML = '<p class="muted">Loading dictionary…</p>'; return; }
    var han = /[㐀-鿿]/.test(q);
    var qp = q.replace(/\s+/g, '').replace(/[1-5]/g, '');
    var hits = [];
    for (var i = 0; i < dict.length; i++) {
      var row = dict[i], score = 0;
      if (han) {
        if (row[0] === q || row[1] === q) score = 100;
        else if (row[0].lastIndexOf(q, 0) === 0) score = 70;
        else if (row[0].indexOf(q) >= 0) score = 30;
      } else {
        var py = searchPy[i], en = searchEn[i];
        if (py === qp) score = 100;
        else if (py.lastIndexOf(qp, 0) === 0) score = 70;
        else if (en.split(/[^a-z]+/).indexOf(q) >= 0) score = 60;
        else if (q.length >= 3 && en.indexOf(q) >= 0) score = 40;
        else if (qp.length >= 2 && py.indexOf(qp) >= 0) score = 25;
      }
      if (score) hits.push([i, score + Math.min(20, row[4] / 40) - row[0].length]);
    }
    hits.sort(function (a, b) { return b[1] - a[1]; });
    var seen = {}, out = [];
    for (i = 0; i < hits.length && out.length < 30; i++) {
      var r = dict[hits[i][0]];
      if (seen[r[0] + r[2]]) continue;
      seen[r[0] + r[2]] = true;
      out.push(r);
    }
    box.hidden = false;
    if (!out.length) { box.innerHTML = '<p class="muted">No matches for “' + esc(qRaw) + '”.</p>'; return; }
    box.innerHTML = '';
    out.forEach(function (row) {
      var b = document.createElement('button');
      b.className = 'search-hit';
      b.innerHTML = '<span class="opt-hz">' + esc(row[0]) + '</span>' +
        '<span class="opt-py">' + pinyinHtml(row[2]) + '</span>' +
        '<span class="opt-gloss">' + esc(rowGloss(row)) + '</span>';
      b.addEventListener('click', function () {
        setWord(row[0]);
        $('searchInput').value = '';
        box.hidden = true; box.innerHTML = '';
        $('dictCard').scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
      box.appendChild(b);
    });
  }

  var searchTimer = null;
  $('searchInput').addEventListener('input', function () {
    var v = this.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { runSearch(v); }, 120);
  });

  // ---------------------------------------------------------------- tone trainer
  var TONE_INFO = [
    { n: 1, mark: 'ˉ', name: 'high & flat' },
    { n: 2, mark: 'ˊ', name: 'rising' },
    { n: 3, mark: 'ˇ', name: 'dip' },
    { n: 4, mark: 'ˋ', name: 'falling' }
  ];
  var tn = { pool: [], queue: [], cur: null, right: 0, total: 0, planned: 10, answered: false };

  (function () {
    var box = $('tonesLevel');
    [[1, 'HSK 1'], [2, 'HSK 2'], [3, 'HSK 3+']].forEach(function (o, i) {
      var b = document.createElement('button');
      b.textContent = o[1];
      b.setAttribute('data-v', o[0]);
      if (i === 0) b.classList.add('sel');
      box.appendChild(b);
    });
    selectable(box);
  })();

  function tonePool(level) {
    var maxH = level === 1 ? 1 : level === 2 ? 2 : 4;
    var out = [], seen = {};
    for (var i = 0; i < dict.length; i++) {
      var row = dict[i];
      if (row[0].length !== 1 || !row[5] || row[5] > maxH || /[A-Z]/.test(row[2]) || seen[row[0]]) continue;
      var syl = row[2].split(/\s+/)[0];
      var m = syl.match(/[1-4]$/);
      if (!m) continue;
      seen[row[0]] = true;
      out.push({ ch: row[0], tone: +m[0], row: row });
    }
    return out;
  }

  $('tonesStart').addEventListener('click', function () {
    if (!window.speechSynthesis) {
      $('tonesNote').hidden = false;
      $('tonesNote').textContent = 'The tone trainer needs your device to speak Chinese, but no speech support was found here. Try Safari on iPhone or Chrome.';
      return;
    }
    if (!dict) { $('tonesNote').hidden = false; $('tonesNote').textContent = 'Loading dictionary…'; return; }
    tn.pool = tonePool(selectedVal('tonesLevel'));
    if (tn.pool.length < 4) { $('tonesNote').hidden = false; $('tonesNote').textContent = 'Not enough characters at this level.'; return; }
    tn.right = 0; tn.total = 0;
    $('tonesSetup').hidden = true; $('tonesDone').hidden = true; $('tonesPlay').hidden = false;
    toneNext();
  });

  function toneNext() {
    tn.answered = false;
    tn.cur = pick(tn.pool);
    tn.total++;
    $('tonesProgress').textContent = 'Question ' + tn.total + ' / ' + tn.planned + ' · score ' + tn.right;
    $('toneReveal').innerHTML = '<span class="muted">Which tone did you hear?</span>';
    $('tonesNext').hidden = true;
    var grid = $('toneGrid');
    grid.innerHTML = '';
    TONE_INFO.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'tone-opt t' + t.n;
      b.innerHTML = '<span class="tone-num">' + t.n + ' ' + t.mark + '</span><span class="tone-name">' + t.name + '</span>';
      b.addEventListener('click', function () { answerTone(t.n, b); });
      grid.appendChild(b);
    });
    setTimeout(function () { speak(tn.cur.ch); }, 250);
  }

  function answerTone(tone, btn) {
    if (tn.answered) return;
    tn.answered = true;
    var correct = tn.cur.tone;
    var good = tone === correct;
    srsGrade(tn.cur.ch, good);
    if (good) tn.right++;
    $('toneGrid').querySelectorAll('.tone-opt').forEach(function (b, i) {
      if (i + 1 === correct) b.classList.add('good');
    });
    if (!good) btn.classList.add('bad');
    var row = tn.cur.row;
    $('toneReveal').innerHTML = '<span class="tone-hz">' + esc(tn.cur.ch) + '</span>' +
      '<span class="tone-py">' + pinyinHtml(row[2]) + '</span>' +
      '<span class="tone-gloss">' + esc(rowGloss(row)) + '</span>' +
      '<button class="speak" data-say="' + esc(tn.cur.ch) + '">🔊</button>';
    bindSpeakButtons($('toneReveal'));
    $('tonesProgress').textContent = 'Question ' + tn.total + ' / ' + tn.planned + ' · score ' + tn.right;
    if (tn.total >= tn.planned) {
      $('tonesNext').textContent = 'See results →';
    }
    $('tonesNext').hidden = false;
  }

  $('tonesReplay').addEventListener('click', function () { if (tn.cur) speak(tn.cur.ch); });
  $('tonesNext').addEventListener('click', function () {
    if (tn.total >= tn.planned) return endTones();
    toneNext();
  });
  $('tonesQuit').addEventListener('click', endTones);
  function endTones() {
    $('tonesPlay').hidden = true; $('tonesDone').hidden = false;
    var pct = tn.total ? Math.round(100 * tn.right / Math.min(tn.total, tn.planned)) : 0;
    $('tonesStats').textContent = 'You got ' + tn.right + ' of ' + Math.min(tn.total, tn.planned) + ' tones right (' + pct + '%). ' +
      (pct >= 80 ? 'Great ear! 👂' : 'Keep training — tones get easier with practice.');
  }
  $('tonesAgain').addEventListener('click', function () { $('tonesDone').hidden = true; $('tonesStart').click(); });
  $('tonesNewLevel').addEventListener('click', function () { $('tonesDone').hidden = true; $('tonesSetup').hidden = false; });

  // ---------------------------------------------------------------- progress & spaced repetition
  // One memory fed by every mode. Leitner-style boxes; saved in localStorage.
  var SRS_KEY = 'xiezi.srs.v1';
  var DAY = 86400000;
  var BOX_DAYS = [0, 1, 3, 7, 16, 35, 90]; // interval per box after a correct answer
  var srs = (function () {
    var s;
    try { s = JSON.parse(localStorage.getItem(SRS_KEY)) || {}; } catch (e) { s = {}; }
    s.w = s.w || {};        // word -> { b: box, due: ms, seen: n, last: ms }
    s.goal = s.goal || 20;
    s.streak = s.streak || 0;
    s.lastDay = s.lastDay || '';
    s.days = s.days || {};  // 'y-m-d' -> reviews that day
    return s;
  })();
  function saveSrs() { try { localStorage.setItem(SRS_KEY, JSON.stringify(srs)); } catch (e) {} }
  function dayStr(d) { d = d || new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

  function srsGrade(word, good) {
    if (!word || !/[㐀-鿿]/.test(word)) return;
    var rec = srs.w[word] || { b: 0, due: 0, seen: 0 };
    rec.seen++;
    rec.b = good ? Math.min(BOX_DAYS.length - 1, rec.b + 1) : Math.max(0, rec.b - 2);
    rec.due = Date.now() + (good ? BOX_DAYS[rec.b] * DAY : 60000); // wrong: comes back in ~1 min
    rec.last = Date.now();
    srs.w[word] = rec;
    var t = dayStr();
    if (srs.lastDay !== t) {
      srs.streak = (srs.lastDay === dayStr(new Date(Date.now() - DAY))) ? srs.streak + 1 : 1;
      srs.lastDay = t;
    }
    srs.days[t] = (srs.days[t] || 0) + 1;
    saveSrs();
    if (!$('tab-review').hidden && !$('reviewHome').hidden) renderReview();
  }

  function srsDue() {
    var now = Date.now(), out = [];
    for (var w in srs.w) if (srs.w[w].due <= now) out.push(w);
    return out.sort(function (a, b) { return srs.w[a].due - srs.w[b].due; });
  }
  function srsStats() {
    var words = Object.keys(srs.w), learned = 0;
    words.forEach(function (w) { if (srs.w[w].b >= 3) learned++; });
    return { seen: words.length, learned: learned, due: srsDue().length,
             streak: srs.streak, today: srs.days[dayStr()] || 0, goal: srs.goal };
  }

  (function () {
    var box = $('revGoal');
    [10, 20, 30, 50].forEach(function (g) {
      var b = document.createElement('button');
      b.textContent = g;
      b.setAttribute('data-v', g);
      if (g === srs.goal) b.classList.add('sel');
      box.appendChild(b);
    });
    selectable(box);
    box.addEventListener('click', function (ev) {
      if (!ev.target.closest('button')) return;
      srs.goal = selectedVal('revGoal');
      saveSrs();
      renderReview();
    });
  })();

  function renderReview() {
    var st = srsStats();
    $('revStreak').textContent = st.streak;
    $('revLearned').textContent = st.learned;
    $('revSeen').textContent = st.seen;
    $('revToday').textContent = st.today;
    $('revGoalVal').textContent = st.goal;
    $('revBar').style.width = Math.min(100, Math.round(100 * st.today / st.goal)) + '%';
    $('revDueCount').textContent = st.due;
    $('revStart').hidden = st.due === 0;
    $('revEmpty').hidden = st.due > 0;
  }

  var rev = { queue: [], done: 0, flipped: false };
  $('revStart').addEventListener('click', function () {
    var due = srsDue();
    if (!due.length) return;
    rev.queue = due.slice(0, 40);
    rev.done = 0;
    $('reviewHome').hidden = true; $('reviewDone').hidden = true; $('reviewPlay').hidden = false;
    showRevCard();
  });

  function showRevCard() {
    if (!rev.queue.length) return endReview();
    rev.flipped = false;
    var w = rev.queue[0];
    var row = bestRow(w) || bestRow(toSimp(w));
    $('revProgress').textContent = rev.done + ' reviewed · ' + rev.queue.length + ' left';
    $('revFront').hidden = false; $('revBack').hidden = true;
    $('revFront').innerHTML = esc(w);
    if (row) {
      var defs = row[3]; if (defs.length > 120) defs = defs.slice(0, 120) + '…';
      $('revBack').innerHTML = '<div class="fc-hz">' + esc(w) + '</div>' +
        '<div class="fc-py">' + pinyinHtml(row[2]) + '</div><div class="fc-def">' + esc(defs) + '</div>';
    } else {
      $('revBack').innerHTML = '<div class="fc-hz">' + esc(w) + '</div>';
    }
  }
  function flipRev() {
    rev.flipped = !rev.flipped;
    $('revFront').hidden = rev.flipped;
    $('revBack').hidden = !rev.flipped;
    if (rev.flipped) speak(rev.queue[0]);
  }
  function gradeRev(good) {
    var w = rev.queue.shift();
    srsGrade(w, good);
    rev.done++;
    if (!good) rev.queue.push(w); // see it again this session
    if (!rev.queue.length) return endReview();
    showRevCard();
  }
  function endReview() {
    $('reviewPlay').hidden = true; $('reviewDone').hidden = false;
    $('revDoneStats').textContent = 'You reviewed ' + rev.done + ' card' + (rev.done === 1 ? '' : 's') +
      '. Streak: ' + srs.streak + ' day' + (srs.streak === 1 ? '' : 's') + ' 🔥';
    renderReview();
  }
  $('revCard').addEventListener('click', flipRev);
  $('revGood').addEventListener('click', function () { gradeRev(true); });
  $('revAgain').addEventListener('click', function () { gradeRev(false); });
  $('revQuit').addEventListener('click', endReview);
  $('revBackHome').addEventListener('click', function () {
    $('reviewDone').hidden = true; $('reviewHome').hidden = false;
    renderReview();
  });

  // ---------------------------------------------------------------- PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  step(); // count app boot as one step
})();
