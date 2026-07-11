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
      '<div class="say-heard">We heard: ' + esc(best.t || '…') + '</div>';
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

  // tap a word chip in a dialogue -> look it up in the dictionary tab
  $('dlgLines').addEventListener('click', function (ev) {
    var chip = ev.target.closest('.hint-chip');
    if (!chip) return;
    var hz = chip.querySelector('.hz');
    if (!hz || !/[㐀-鿿]/.test(hz.textContent)) return;
    setWord(hz.textContent);
    showTab('dict');
  });

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

  var GENERIC_REACTIONS = ['好的，我明白了。', '真的吗？有意思！', '嗯嗯，我知道了。', '哈哈，不错！'];
  var prax = { scen: null, step: 0, scores: [], answered: 0, busy: false, lvl: 1, last: null };

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
    u.lang = 'zh-CN';
    u.rate = 0.85;
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

  function startPractice() {
    var pool = PRACTICE.filter(function (s) { return s.lvl === prax.lvl; });
    if (pool.length > 1 && prax.last) {
      var narrowed = pool.filter(function (s) { return s !== prax.last; });
      if (narrowed.length) pool = narrowed;
    }
    prax.scen = pick(pool);
    prax.last = prax.scen;
    prax.step = 0;
    prax.scores = [];
    prax.answered = 0;
    prax.busy = false;
    $('dlgList').hidden = true;
    $('dlgView').hidden = true;
    $('praxView').hidden = false;
    $('praxTitle').textContent = '🤖 ' + prax.scen.e + ' ' + prax.scen.t + ' · HSK ' + (prax.scen.lvl === 3 ? '3+' : prax.scen.lvl);
    $('praxLines').innerHTML = '';
    $('praxText').value = '';
    applyDlgToggles();
    botAsk();
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
        (prax.scores.length ? ' — average match ' + avg + '%.' : '.') + ' 加油！ Tap “New topic” to keep practicing.';
    } else {
      msg = 'Conversation finished. Tap “New topic” to try another one!';
    }
    var div = document.createElement('div');
    div.className = 'muted';
    div.style.padding = '10px 2px';
    div.textContent = msg;
    $('praxLines').appendChild(div);
  }

  function praxAnswer(zhRaw) {
    var step = prax.scen.steps[prax.step];
    if (!step || step.end || prax.busy) return;
    var zh = zhRaw.trim();
    if (!zh) return;
    prax.busy = true;
    var bubble = praxBubble(zh, null, 'me');
    prax.answered++;
    // compare with the suggested answers: best pinyin-syllable match
    var best = null;
    step.s.forEach(function (sug) {
      var r = matchSpeech(sug[0], zh);
      if (!best || r.score > best.score) best = { sug: sug, score: r.score };
    });
    var reaction;
    if (best && best.score >= 45) {
      prax.scores.push(best.score);
      var fb = document.createElement('div');
      fb.className = 'dlg-en';
      fb.innerHTML = '≈ „' + esc(best.sug[0]) + '” · match ' + best.score + '%';
      bubble.appendChild(fb);
      reaction = best.score >= 60 ? best.sug[2] : pick(GENERIC_REACTIONS);
    } else {
      reaction = pick(GENERIC_REACTIONS);
    }
    prax.step++;
    // conversational pacing: think → react (spoken) → pause → next question
    var t1 = typingBubble();
    setTimeout(function () {
      t1.remove();
      praxBubble(reaction, null, 'bot');
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

  // ---------------------------------------------------------------- PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  step(); // count app boot as one step
})();
