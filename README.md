# Interview Transcriber

Drag-and-drop audio transcription built on the [Soniox](https://soniox.com) speech-to-text API,
with an integrated player, a word-level transcript editor, and per-browser session memory.

Two ways to run it:

| Mode | How | API key lives |
|---|---|---|
| **Local** | `node server.js` → http://localhost:4823 | `.env` on your machine (or pasted in the header) |
| **Microsite** | `node build.js` → upload `dist/transcriber.html` via `/publish-page` in Slack | pasted once in the header, kept in that browser |

No dependencies either way — any Node 18+ builds/serves it.

## Use it

1. **Drop** an MP3 / M4A (WAV, FLAC, OGG… also fine) onto the page. Toggle *Speaker labels*
   (diarization) and the *language* dropdown (defaults to Vietnamese) before dropping.
2. Audio is playable immediately; the transcript appears when Soniox finishes
   (model `stt-async-v5`). The play button, ±5 s, speed, and seek bar work as expected.
3. **Click** a word to select it — drag or shift-click to select more, ⌘-click to toggle.
4. A floating toolbar appears: **Edit** rewrites the selection (edited words turn **red**;
   hover shows the original, **Revert** restores it), **Play** starts audio from that word.
5. **Double-click** any word to jump the audio to that exact moment.
6. While playing, the current word is highlighted and kept in view (toggle **Follow**).
7. Click a speaker label to rename it everywhere; **Copy** / **Download .txt** export the
   edited transcript.

Shortcuts: `Space` play/pause · `←` `→` ±5 s · `Enter` edit selection · `Esc` deselect ·
`L` loop the selection (A–B).

## Review loop (A–B)

Select words and hit **A–B** in the floating toolbar (or press `L`): the player docks to
the selection — the seek bar spans **just that section**, the words are tinted in the
transcript, and playback runs A→B and stops. The section bar offers **Play section**,
**Loop**, a **gap** of silence before each repeat (live 0.1 s countdown), and ✕ to clear.
More player niceties: a **volume** slider (persisted), a **cursor** lead field (highlight
runs *x* s ahead/behind the audio — handy for shadowing), and the whole console (file name
+ controls) stays docked at the top while you scroll.

## Dropbox backup (optional)

With `DROPBOX_TOKEN` set in `.env`, every new recording and its finished transcript are
also uploaded to `/interview-transcriber` in that Dropbox app's folder (auto-renamed,
never overwriting; >150 MB files use chunked upload sessions). Failures only toast — they
never block transcription. The token is **never committed**: the local server hands it to
the page via `/api/config`, and `node build.js` embeds it into `dist/transcriber.html`
from `.env` at build time — so treat a token-bearing build as a secret and don't commit it.

## Video

Transcribe the (cheap-to-upload) **audio** first, then drop the **video** of the same
recording anywhere on the page — or use the **＋ Video** button in the player. The video
appears in the sticky console and becomes the playback source: word highlighting follows
it and double-clicking a word seeks the video. Attaching a video **never re-transcribes**.

- Hover the video for **Replace / Remove / Size / PiP / Fullscreen**; click it to
  play/pause. Remove switches playback back to the original audio.
- The video is stored with the session (quota permitting) and restores on resume.
- A warning appears if the video's duration differs from the transcribed audio by more
  than a few seconds.
- Dropping a video *first* (no transcript yet) offers to transcribe its audio track.

## Session memory

Every transcription auto-saves in the browser (IndexedDB): transcript, edits, speaker
names, playback position, **and the audio file itself**. Reopen the page and pick up any
session from **Recent sessions** on the drop screen — playback resumes where you stopped.

- Saves happen automatically on every edit/rename and every few seconds during playback.
- Up to 12 sessions are kept; oldest are evicted. Delete any with the ✕ button.
- If the audio blob couldn't be stored (disk quota) the transcript still restores; drop the
  original file once to re-attach playback — it is **not** re-transcribed.

## Microsite deployment

```bash
node build.js        # → dist/transcriber.html (single self-contained file)
```

Then `/publish-page` in Slack and upload `dist/transcriber.html`. The build flips the app
into **direct mode**: the browser calls `api.soniox.com` itself (CORS is open), so no
server is involved. Upload → transcribe → the file and transcription are deleted from
Soniox storage as soon as the tokens arrive. (`dist/` is a gitignored build artifact —
it may embed your local Dropbox token, so it must never be committed.)

## PWA (GitHub Pages)

`node build.js` also emits **`docs/`** — the same app as an installable PWA: web app
manifest, service worker, icons (regenerate them with `node make-icons.js`). Serve
`docs/` on GitHub Pages or any static host and use the browser's **Install app**: the
shell opens offline (saved sessions included; transcription itself needs the network),
loads are instant from cache, and updates arrive on the next visit. This bundle **never
embeds the Dropbox token** — it targets a public host. Paste the Soniox key in the
header, same as the microsite.

**Shared-origin caveat:** all internal microsites share one browser origin, so the saved
API key, transcripts, and audio stored by this app are technically readable by JavaScript
in any other microsite on that domain. Fine for low-confidentiality content (the platform's
own bar); think twice before keeping genuinely sensitive interviews saved there — you can
always delete sessions from the drop screen.

## Obsidian plugin

The same workflow inside Obsidian lives in its own repo:
[obsidian-soniox-transcriber](https://github.com/Tien3991/obsidian-soniox-transcriber)
— no build step, three files, desktop only.

- **Transcribe from the vault**: right-click any audio/video file → *Transcribe with
  Soniox* (also: command palette or the mic ribbon icon). A Markdown note is created next
  to the media (configurable folder) with frontmatter (`media`, `duration`) and
  `**Speaker N** [m:ss]` anchors per speaker turn / pause. The upload is deleted from
  Soniox right after.
- **Stacked layout**: the player console sits directly above the transcript in the main
  area (slim strip for audio, roomier for video; switchable to the right sidebar in
  settings). The console has a **transcript dropdown** — pick any transcript note and it
  opens, editable, right below.
- **Synced playback**: click a `[m:ss]` pill → the player seeks (⌥-click also plays).
  During playback the current segment is highlighted and, with **Follow** on, scrolled
  into view.
- **Media ↔ note links**: every transcription (and manual pick) records the link, so
  opening an audio/video file from the explorer jumps straight to its transcript with the
  player bound. Links also resolve from note frontmatter (`media`/`video`).
- **Attach a video**: the console's **Video** button (or right-click a video file →
  *Link video to a transcript…*) attaches the video of the same recording to a transcript
  — playback switches to it, sync intact, **never re-transcribed** (`video:` frontmatter;
  Remove switches back to the audio).
- **Edit freely**: it's a normal note — the anchors keep sync working after edits.
  Commands: *Play from cursor* (interpolates between anchors), *Insert timestamp at
  playhead*, *Play / pause*, *Attach video* (assign hotkeys as you like).
- **Setup**: Settings → Soniox Transcriber → paste your API key (language defaults to
  Vietnamese; diarization on; a mock mode exists for testing). Install by copying the
  plugin folder to `<vault>/.obsidian/plugins/soniox-transcriber/` and enabling it in
  Community plugins.

## Notes

- Local mode: copy `.env.example` to `.env` and set `SONIOX_API_KEY` (from
  [console.soniox.com](https://console.soniox.com)); the server proxies Soniox so the key
  never ships to the page, and it cleans up Soniox storage after each transcript.
- Try the whole UI without an API key: append `?mock=1` to either version's URL —
  transcription is simulated client-side.
- Override the model/port with `SONIOX_MODEL` / `PORT` in `.env` (local mode).
