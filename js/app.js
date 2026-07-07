/* 写字 Xiězì — handwriting → pinyin → sentences. All client-side. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- state
  var dict = null;          // rows: [simp, trad, pinyin, defs, usage, hsk]
  var chars = null;         // char -> [etyType, hint, semantic, phonetic, components, radical]
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
    loadbar.style.width = (loadSteps / 4 * 100) + '%';
    if (loadSteps >= 4) setTimeout(function () { loadbar.remove(); }, 600);
  }

  fetch('data/dict.json')
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      dict = rows;
      buildIndexes();
      step();
      refresh();
      return fetch('data/chars.json');
    })
    .then(function (r) { return r.json(); })
    .then(function (map) {
      chars = map;
      step();
      refresh();
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

  // recognition: two independent stroke datasets, results merged for accuracy
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
    if (!recognizerReady) { setPadStatus('recognizer still loading…'); return; }
    setPadStatus('');
    var seq = ++recogSeq;
    var analyzed = new HanziLookup.AnalyzedCharacter(strokes);
    var pending = loadedSets.length;
    var best = new Map();
    loadedSets.forEach(function (name) {
      new HanziLookup.Matcher(name).match(analyzed, 12, function (matches) {
        (matches || []).forEach(function (m) {
          if (!best.has(m.character) || m.score > best.get(m.character)) {
            best.set(m.character, m.score);
          }
        });
        if (--pending === 0 && seq === recogSeq) showCandidates(best);
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
        noEntry += originHtml(word);
      }
      out.innerHTML = noEntry + (word.length > 1 ? word.split('').map(charRowHtml).join('') : '');
    } else {
      out.innerHTML = idxs.map(function (i) { return entryHtml(dict[i]); }).join('');
      if (word.length > 1) out.innerHTML += word.split('').map(charRowHtml).join('');
    }
    bindSpeakButtons(out);
    bindPartButtons(out);
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
      (simp.length === 1 ? originHtml(simp) : '') +
      '</div>';
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

  // ---------------------------------------------------------------- PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  step(); // count app boot as one step
})();
