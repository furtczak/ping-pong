# 写字 Xiězì — Learn Chinese in your browser

A free, offline-first Chinese learning app that runs **entirely in your browser** — no app store, no account, no server, no payment. Write characters with your finger, hear and speak sentences, and build a real vocabulary with spaced repetition. Add it to your phone's home screen and it works like a native app, even without internet.

**Live app:** https://furtczak.github.io/ping-pong/

> Open it in Safari (iPhone) or Chrome, then **Share → Add to Home Screen** to install it. Everything is cached after the first visit, so it keeps working offline.

## Learning modes

The app has nine modes (the tab bar scrolls sideways on small screens):

- **✍️ Write** — draw a character with your finger and it's recognized on-device. Recognition merges three engines (two stroke-order datasets plus a shape matcher), so **any stroke order works** — great for beginners. Each entry shows tone-colored pinyin, English definitions, HSK badge, the character's **origin story** (pictograph / ideograph / phono-semantic), a **component breakdown**, a **stroke-order animation**, and example sentences. Includes a **search box**: type pinyin (`ai`, `nihao`) or English (`love`) to find a word.
- **🃏 Cards** — Quizlet-style flashcards: swipe right if you know a word, left to see it again; tap to flip.
- **🎯 Quiz** — fill-in-the-blank and sentence-translation questions with four answers, per-answer pinyin and show/hide meanings, plus word-split and full hints. Wrong answers come back later in the session.
- **📝 Sentence** — a live sentence appears with its meaning and pinyin; **write each character by hand** and it fills in as you get it right. Stroke-order hints, then the finished sentence with everything below.
- **💬 Talk** — 12 everyday dialogues (ordering food, taxis, bargaining…) as chat bubbles, plus a **free conversation** with an assistant (小智) that reacts to what you say, at three HSK levels, with speech input and pronunciation feedback.
- **🎵 Tones** — listen to a character and pick its tone (1 flat, 2 rising, 3 dip, 4 falling). Trains the hardest part of Chinese.
- **📚 Words** — the most useful words per HSK level (or overall top 500), with hide-to-test-yourself.
- **🧱 Rules** — the five classic word-building patterns (动宾 verb-object, 偏正 modifier-head, 并列 parallel, 补充 complementary, 主谓 subject-predicate) explained in plain language with generated examples.
- **📈 Review** — one shared memory fed by every mode. **Spaced repetition** (Leitner scheduling) brings each word back right before you'd forget it, with a day streak, daily goal and due-word queue.

## Cross-cutting features

- 🔊 **Speech everywhere** — tap any word, cell or line to hear it (uses your device's Chinese voice).
- 🎤 **Speech recognition** — say sentences and get per-character green/red pronunciation feedback (uses the browser's built-in dictation; on iPhone, enable Dictation and add the Chinese (Pinyin) keyboard in Settings).
- ✂️ **Word split** — see how a sentence breaks into words the way a native reader does, with pinyin and meaning; tap a cell to hear it, long-press to open the dictionary.
- 🌗 **Light & dark** ink-on-paper theme; 📴 **fully offline** after first load via a service worker.

## Running it yourself

No build step — it's plain HTML/CSS/JS. Any static file server works:

```sh
python3 -m http.server   # then open http://localhost:8000
```

### Deploying (GitHub Pages)

The included workflow (`.github/workflows/pages.yml`) deploys to GitHub Pages on every push to `main`. If the first run fails, enable Pages once in **Settings → Pages → Source: “GitHub Actions”**, then re-run the workflow. GitHub Pages requires a **public** repository on the free plan.

## How the data is built

Dictionary, sentence, stroke and etymology data are prepared offline into compact JSON files under `data/` (see the build scripts referenced in the commit history). At runtime everything is loaded and searched in the browser — nothing leaves your device.

## Data & licenses

| Component | Source | License |
|---|---|---|
| Handwriting recognition | [HanziLookupJS](https://github.com/gugray/HanziLookupJS) (`lib/`, `data/mmah.json`, `data/orig.json`) | LGPL 3 |
| Dictionary (`data/dict.json`) | [CC-CEDICT](https://cc-cedict.org/) | CC BY-SA 4.0 |
| Example sentences (`data/sentences.json`) | [Tatoeba](https://tatoeba.org/) | CC BY 2.0 FR |
| Etymology & stroke medians (`data/chars.json`, `data/medians.json`) | [Make Me a Hanzi](https://github.com/skishore/makemeahanzi) | LGPL / Arphic PL |
| HSK levels & character frequency | HSK word lists, Jun Da character-frequency list | — |

App code: MIT. Everyday dialogues and conversation content are original to this project.

---

Nauka chińskiego w ciekawy sposób 🇨🇳
