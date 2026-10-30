# Zoom Web Client Test Bots (Puppeteer)

Spawns N mock participants into a Zoom meeting via the Zoom Web Client (`app.zoom.us/wc/{MEETING_ID}/join` or `zoom.us/wc/join/{MEETING_ID}`) for load and QA testing, using an ultra-low-memory **8-context browser pool** with per-tab isolated in-memory storage.

> ⚠️ Only use this on meetings you host or have explicit permission to test.

## Requirements
- Node.js 18+ (20.6+ if you want to use `.env` files)
- ~60–100 MB RAM per bot in shared low-memory mode

## Install
```powershell
npm install        # also downloads a matching Chrome build for Puppeteer
```

## Run
**Direct Join URL (with encrypted `pwd=` parameter):**
```powershell
node zoom_bots.js "--join-url=https://app.zoom.us/wc/12345678901/join?pwd=..." --bot-count=30 --duration-minutes=240 --headless=true
```

**Meeting ID + Passcode:**
```powershell
node zoom_bots.js --meeting-id=12345678901 --meeting-passcode=abc123 --bot-count=5 --duration-minutes=10
```

**.env file:**
```powershell
copy .env.example .env   # then edit it
npm run start:env
```

## Custom Participant Names (`names.txt`)
Edit `names.txt` (one participant name per line, `#` for comments) to assign custom names to bots in order (or shuffled with `--shuffle-names=true`).

## Options
| Variable / flag | Default | Description |
|---|---|---|
| `JOIN_URL` / `--join-url` | — | Full Zoom invite or web-client URL (auto-extracts meeting ID and `pwd` hash). |
| `MEETING_ID` / `--meeting-id` | — | 9–11 digit meeting ID (if `--join-url` is not used). |
| `MEETING_PASSCODE` / `--meeting-passcode` | empty | Plaintext passcode, typed in if Zoom asks for it. |
| `BOT_COUNT` / `--bot-count` | 5 | Number of participants to spawn. |
| `NAMES_FILE` / `--names-file` | `names.txt` | Path to newline-separated list of display names. |
| `SHUFFLE_NAMES` / `--shuffle-names` | `false` | `true` randomizes the order of names from `names.txt`. |
| `BOT_NAME_PREFIX` / `--bot-name-prefix` | `TestBot_` | Fallback prefix when `names.txt` is empty. |
| `DURATION_MINUTES` / `--duration-minutes` | 10 | How long bots stay in the meeting. |
| `HEADLESS` / `--headless` | `true` | `true` runs headless (`false` shows browser windows). |
| `SHARED_BROWSER` / `--shared-browser` | `true` | Shares a single Chrome instance across an 8-context pool. |
| `LOW_MEMORY` / `--low-memory` | `true` | Disables GPU/video/audio decoding and terminates media Web Workers after join. |
| `JOIN_AUDIO` / `--join-audio` | `false` | Clicks "Join Audio by Computer" after entering the meeting. |
| `MIN_FREE_MEM_MB` / `--min-free-mem-mb` | `100` | Pauses new bot launches if system free RAM drops below this threshold (`0` disables check). |
| `LAUNCH_STAGGER_MS` / `--launch-stagger-ms` | `6000` | Delay between bot launches. |
| `JOIN_TIMEOUT_MS` / `--join-timeout-ms` | `120000` | Timeout (ms) for each join step. |
| `MAX_RETRIES` / `--max-retries` | `2` | Extra attempts allowed per bot. |

Press **Ctrl+C** once to leave the meeting and close all browsers cleanly. Press it twice to force quit.
