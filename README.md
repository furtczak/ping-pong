# 写字 Xiězì — Chinese Handwriting Dictionary

Nauka chińskiego w ciekawy sposób 🇨🇳

A free, browser-based Chinese dictionary that runs entirely on your device — no app store, no account, no payment. Add it to your iPhone home screen and it works like an app (even offline).

## Features

- ✍️ **Finger handwriting recognition** — draw a Chinese character on the pad and it's recognized instantly, on-device (HanziLookupJS stroke matching, simplified & traditional).
- 🔤 **Pinyin with tones** — every word shows pinyin with tone marks, color-coded by tone (1 red, 2 green, 3 blue, 4 purple, neutral gray), plus English definitions from CC-CEDICT and HSK level badges.
- 📖 **Example sentences** — pick a word (e.g. 我爱) and see real Chinese sentences containing it, with per-character pinyin ruby, English translations, and the word highlighted. 64,000+ sentence pairs from Tatoeba, searched on-device.
- 🧩 **Word suggestions** — after writing a character, see common words that start with it.
- 🔊 **Speech** — tap 🔊 to hear a word or sentence (uses your device's Chinese voice).
- 📴 **Offline** — a service worker caches everything after the first visit.

## Use it on your iPhone

1. Open the GitHub Pages URL for this repo in Safari.
2. Tap **Share → Add to Home Screen**.
3. Launch it from the home screen — it opens full-screen like a native app.

## Hosting (GitHub Pages)

The included workflow (`.github/workflows/pages.yml`) deploys the site to GitHub Pages on every push. If the first run fails with a Pages error, enable Pages once in **Settings → Pages → Source: GitHub Actions**, then re-run the workflow.

No build step — it's plain HTML/CSS/JS. Any static file server works:

```sh
python3 -m http.server   # then open http://localhost:8000
```

## Data & licenses

| Component | Source | License |
|---|---|---|
| Handwriting recognition | [HanziLookupJS](https://github.com/gugray/HanziLookupJS) (`lib/`, `data/mmah.json`) | LGPL 3 |
| Dictionary (`data/dict.json`) | [CC-CEDICT](https://cc-cedict.org/) | CC BY-SA 4.0 |
| Example sentences (`data/sentences.json`) | [Tatoeba](https://tatoeba.org/) | CC BY 2.0 FR |
| HSK levels / frequency | HSK word lists, Jun Da character frequency | — |

App code: MIT.
