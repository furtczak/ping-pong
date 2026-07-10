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
    return s.replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
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
    setWord(this.value.trim());
  });
  $('speakWord').addEventListener('click', function () { speak(word); });

  function speak(text) {
    if (!text || !window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.85;
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
  }

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

  // ---------------------------------------------------------------- talk: everyday dialogues
  function renderDlgList() {
    var box = $('dlgList');
    box.innerHTML = '';
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
    $('dlgView').hidden = false;
    $('dlgTitle').textContent = dlg.e + ' ' + dlg.t;
    var box = $('dlgLines');
    box.innerHTML = '';
    dlg.lines.forEach(function (line) {
      var who = line[0], zh = line[1], en = line[2];
      var div = document.createElement('div');
      div.className = 'bubble' + (who === 'B' ? ' b' : '');
      div.innerHTML = '<span class="who">' + (who === 'B' ? '乙 B' : '甲 A') + '</span>' +
        '<button class="speak" data-say="' + esc(zh) + '">🔊</button>' +
        '<div class="zh">' + rubyHtml(zh, null) + '</div>' +
        '<div class="dlg-split">' + hintChipsHtml(zh, true) + '</div>' +
        '<div class="dlg-en">' + esc(en) + '</div>';
      box.appendChild(div);
    });
    bindSpeakButtons(box);
    applyDlgToggles();
  }

  $('dlgBack').addEventListener('click', function () {
    $('dlgView').hidden = true;
    $('dlgList').hidden = false;
  });

  function applyDlgToggles() {
    var lines = $('dlgLines');
    lines.classList.toggle('nopy', !$('dlgPinyin').checked);
    lines.classList.toggle('split', $('dlgSplit').checked);
    lines.classList.toggle('noen', !$('dlgEn').checked);
  }
  ['dlgPinyin', 'dlgSplit', 'dlgEn'].forEach(function (id) {
    $(id).addEventListener('change', applyDlgToggles);
  });

  // tap a word chip in a dialogue -> look it up in the dictionary tab
  $('dlgLines').addEventListener('click', function (ev) {
    var chip = ev.target.closest('.hint-chip');
    if (!chip) return;
    var hz = chip.querySelector('.hz');
    if (!hz || !/[㐀-鿿]/.test(hz.textContent)) return;
    setWord(hz.textContent);
    showTab('dict');
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

  // ---------------------------------------------------------------- PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  step(); // count app boot as one step
})();
