# Reader

A self-hosted text-to-speech reader inspired by Speechify. Upload PDFs, EPUBs, or paste text, then have them read aloud with word-level highlighting, playback controls, voice selection, and persistent reading position.

Live at: https://reader.danmarzari.com

## Stack

- Next.js 16 (App Router, standalone output)
- React 19
- Tailwind v4
- better-sqlite3 (per-app SQLite file at `reader.db`)
- pdfjs-dist for PDF extraction
- JSZip for EPUB extraction
- Web Speech API (browser) for TTS with `onboundary` word highlighting
- Optional: ElevenLabs API for premium neural voices (server-side, Speechify-style chunking with `previous_text`/`next_text` context)

## Features (v1)

- Library view: grid/list, search, sort by recent/title/type, user-created collections
- Upload: PDF, EPUB, TXT/MD, or pasted text (auto-title)
- Reader view: click-to-jump, word highlighting as it reads, paragraph scroll-follow
- Playback: play/pause, ±10s skip, 0.5×–3× speed, voice selection
- Progress tracking: per-document char position, resumed on next visit

## Environment variables

| Variable             | Required | Purpose |
|----------------------|----------|---------|
| `DATABASE_PATH`      | no       | Path to SQLite file. Defaults to `./reader.db`. |
| `ELEVENLABS_API_KEY` | no       | Enables `/api/tts` proxy for ElevenLabs neural voices. |
| `ELEVENLABS_VOICE_ID`| no       | Default voice ID for ElevenLabs (falls back to Adam). |

## Local dev

```bash
npm install
npm run dev
```

The database is created at `./reader.db` on first run.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`: builds the standalone output, rsyncs to `/var/www/apps/reader/` on the Oracle box, and PM2-restarts the `reader` entry.

Required GitHub Secrets on this repo:

- `DEPLOY_SSH_KEY` — private key authorized on the Oracle server
- `DEPLOY_HOST` — server IP/hostname
- `DEPLOY_USER` — SSH user (e.g. `ubuntu`)

## Server-side prep (run once)

```bash
sudo mkdir -p /var/www/apps/reader
sudo chown -R ubuntu:ubuntu /var/www/apps/reader
```

Add to `/var/www/apps/ecosystem.config.js`:

```js
{
  name: "reader",
  cwd: "/var/www/apps/reader",
  script: "server.js",
  env: {
    NODE_ENV: "production",
    PORT: 3006,
    HOSTNAME: "0.0.0.0",
    DATABASE_PATH: "/var/www/apps/reader/reader.db",
    // ELEVENLABS_API_KEY: "sk_...",
    // ELEVENLABS_VOICE_ID: "pNInz6obpgDQGcFmaJgB",
  },
}
```

Add to `/etc/caddy/Caddyfile`:

```
reader.danmarzari.com {
    reverse_proxy localhost:3006
    encode gzip
}
```

Then:

```bash
sudo systemctl reload caddy
pm2 start /var/www/apps/ecosystem.config.js --only reader
pm2 save
```

Point `reader.danmarzari.com` DNS at the server and you're live.
