#!/usr/bin/env node
/**
 * zoom_bots.js
 * ---------------------------------------------------------------------------
 * Spawns N mock participants into a Zoom meeting using the Zoom Web Client
 * (https://zoom.us/wc/join/{MEETING_ID}) for load / QA testing.
 *
 * Only use against meetings you host or are explicitly authorized to test.
 *
 * Configuration (precedence: CLI flag > environment variable > default):
 *   --join-url=...          JOIN_URL           (full Zoom link; supplies ID + pwd hash)
 *   --meeting-id=...        MEETING_ID         (required unless JOIN_URL given)
 *   --meeting-pwd-hash=...  MEETING_PWD_HASH   (encrypted ?pwd= value from invite links)
 *   --meeting-passcode=...  MEETING_PASSCODE   (optional)
 *   --bot-count=5           BOT_COUNT
 *   --names-file=names.txt  NAMES_FILE         (one display name per line; optional)
 *   --shuffle-names=false   SHUFFLE_NAMES
 *   --bot-name-prefix=...   BOT_NAME_PREFIX    (fallback names: "TestBot_N")
 *   --duration-minutes=10   DURATION_MINUTES
 *   --headless=false        HEADLESS
 *   --shared-browser=true   SHARED_BROWSER     (one Chrome, isolated context per bot; less RAM)
 *   --launch-stagger-ms=5000 LAUNCH_STAGGER_MS (delay between bot launches)
 *   --join-timeout-ms=120000 JOIN_TIMEOUT_MS
 *   --max-retries=2         MAX_RETRIES
 *   --join-audio=true       JOIN_AUDIO         (click "Join Audio by Computer")
 *   --min-free-mem-mb=1500  MIN_FREE_MEM_MB    (pause/stop launching below this free RAM)
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

// ============================================================================
// Configuration
// ============================================================================
function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1].toUpperCase().replace(/-/g, '_')] = m[2] ?? 'true';
  }
  return out;
}

const ARGS = parseArgs(process.argv);
const get = (key, def) => ARGS[key] ?? process.env[key] ?? def;
const toBool = (v) => /^(1|true|yes|on)$/i.test(String(v));
const toInt = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

/** Extract { id, pwd } from any Zoom link (/j/ID, /wc/ID/join, /wc/join/ID). */
function parseJoinUrl(raw) {
  if (!raw) return {};
  try {
    const u = new URL(raw);
    const m = u.pathname.match(/\/(?:j|wc(?:\/join)?|s)\/(\d{9,11})/);
    return { id: m ? m[1] : '', pwd: u.searchParams.get('pwd') || '' };
  } catch {
    return {};
  }
}
const FROM_URL = parseJoinUrl(get('JOIN_URL', ''));

const DEFAULT_NAMES_FILE = path.join(__dirname, 'names.txt');

const CONFIG = Object.freeze({
  MEETING_ID: String(get('MEETING_ID', FROM_URL.id || '')).replace(/\D/g, ''),
  MEETING_PWD_HASH: String(get('MEETING_PWD_HASH', FROM_URL.pwd || '')),
  MEETING_PASSCODE: String(get('MEETING_PASSCODE', '')),
  BOT_COUNT: toInt(get('BOT_COUNT', 5), 5),
  NAMES_FILE: String(get('NAMES_FILE', fs.existsSync(DEFAULT_NAMES_FILE) ? DEFAULT_NAMES_FILE : '')),
  SHUFFLE_NAMES: toBool(get('SHUFFLE_NAMES', 'false')),
  BOT_NAME_PREFIX: String(get('BOT_NAME_PREFIX', 'TestBot_')),
  DURATION_MINUTES: parseFloat(get('DURATION_MINUTES', 10)) || 10,
  HEADLESS: toBool(get('HEADLESS', 'false')),
  SHARED_BROWSER: toBool(get('SHARED_BROWSER', 'true')),
  LAUNCH_STAGGER_MS: toInt(get('LAUNCH_STAGGER_MS', 6000), 6000),
  JOIN_TIMEOUT_MS: toInt(get('JOIN_TIMEOUT_MS', 120000), 120000),
  MAX_RETRIES: toInt(get('MAX_RETRIES', 2), 2),
  JOIN_AUDIO: toBool(get('JOIN_AUDIO', 'false')), // Default to false for lightweight population
  LOW_MEMORY: toBool(get('LOW_MEMORY', 'true')),  // Drastically reduce RAM & CPU
  MIN_FREE_MEM_MB: toInt(get('MIN_FREE_MEM_MB', 100), 100),
  SCREENSHOT_DIR: String(get('SCREENSHOT_DIR', path.join(__dirname, 'screenshots'))),
});

/** Build the display-name list from NAMES_FILE, falling back to PREFIX + N. */
function loadNames() {
  let names = [];
  if (CONFIG.NAMES_FILE) {
    try {
      names = fs
        .readFileSync(CONFIG.NAMES_FILE, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim()) // tolerate "1. Name"
        .filter((s) => s && !s.startsWith('#'));
    } catch (e) {
      console.warn(`Could not read NAMES_FILE (${CONFIG.NAMES_FILE}): ${e.message}`);
    }
  }
  if (CONFIG.SHUFFLE_NAMES) {
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
  }
  return Array.from({ length: CONFIG.BOT_COUNT }, (_, i) => names[i] || `${CONFIG.BOT_NAME_PREFIX}${i + 1}`);
}
const BOT_NAMES = loadNames();

// Selectors for Zoom's web client. Zoom changes its DOM periodically, so each
// target has several fallbacks. Update here if Zoom ships a redesign.
const SEL = {
  webclientIframe: 'iframe#webclient',
  cookieAccept: ['#onetrust-accept-btn-handler'],
  tosAgree: ['#wc_agree1', 'button#wc_agree1'],
  nameInput: ['#input-for-name', 'input#inputname', 'input[placeholder*="name" i]'],
  passInput: ['#input-for-pwd', 'input#inputpasscode', 'input[type="password"]'],
  joinButton: [
    'button.preview-join-button',
    'button.zm-btn.preview-join-button',
    'button#joinBtn',
  ],
  joinAudio: [
    'button.join-audio-by-voip__join-btn',
    'button[class*="join-audio-by-voip"]',
  ],
  inMeeting: [
    '#wc-footer',
    '.footer__btns-container',
    '#foot-bar',
    '.meeting-client-inner',
    '.meeting-client',
    '#wc-container-left',
    '.sharing-layout',
  ],
  waitingRoom: ['.wr-content', '.waiting-room-container', '.wr-default__content'],
  errorDialog: ['.zm-modal-body-title', '.error-message', '.zm-modal-legacy .content'],
  leaveButton: ['button.footer__leave-btn', 'button[aria-label^="Leave" i]'],
  leaveConfirm: ['button.leave-meeting-options__btn', 'button.zm-btn--danger'],
};

// ============================================================================
// Utilities
// ============================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const freeMemMb = () => Math.round(os.freemem() / 1024 / 1024);
const safeFile = (s) => s.replace(/[^\w.-]+/g, '_');

const LOG_FILE = path.join(__dirname, 'zoom_bots.log');
try { fs.writeFileSync(LOG_FILE, ''); } catch {}
function writeLog(line) {
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function makeLogger(tag) {
  const fmt = (lvl, m) => `[${ts()}] [${tag}]${lvl ? ' ' + lvl : ''} ${m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  return {
    info: (...m) => writeLog(fmt('', m)),
    warn: (...m) => writeLog(fmt('WARN', m)),
    error: (...m) => writeLog(fmt('ERROR', m)),
  };
}
const mainLog = makeLogger('main');

/** Global run state (shared across bots, used for graceful shutdown). */
const state = {
  shuttingDown: false,
  browsers: new Set(),
  bots: [], // { name, session, page, status }
  sharedBrowserPromise: null,
  _wakers: new Set(),
};

/** Sleep that resolves early when shutdown is requested. */
function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    if (state.shuttingDown) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      state._wakers.delete(done);
      resolve();
    }
    state._wakers.add(done);
  });
}
function wakeAll() {
  for (const w of [...state._wakers]) w();
}

/** Reject if `promise` doesn't settle within `ms` (so retries can kick in). */
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/** Frames ordered so the #webclient iframe (if any) is searched first. */
function orderedFrames(page, preferFrame) {
  const frames = page.frames().filter((f) => !f.isDetached?.());
  if (!preferFrame) return frames;
  return [preferFrame, ...frames.filter((f) => f !== preferFrame)];
}

async function isVisible(el) {
  try {
    const box = await el.boundingBox();
    return !!box && box.width > 0 && box.height > 0;
  } catch {
    return false;
  }
}

/**
 * Poll all frames (preferring the #webclient iframe) for the first visible
 * element matching any of the given selectors.
 */
async function findElement(page, selectors, { timeout = 30000, preferFrame, visible = true } = {}) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const deadline = Date.now() + timeout;
  do {
    for (const frame of orderedFrames(page, preferFrame)) {
      for (const sel of list) {
        try {
          const el = await frame.$(sel);
          if (!el) continue;
          if (!visible || (await isVisible(el))) return { frame, el, sel };
          await el.dispose();
        } catch {
          /* frame navigated/detached mid-query — ignore and retry */
        }
      }
    }
    if (state.shuttingDown) return null;
    await sleep(400);
  } while (Date.now() < deadline);
  return null;
}

/** Find a visible, enabled button whose text matches `regex`, across frames. */
async function findButtonByText(page, regex, { timeout = 5000, preferFrame } = {}) {
  const deadline = Date.now() + timeout;
  do {
    for (const frame of orderedFrames(page, preferFrame)) {
      try {
        const handle = await frame.evaluateHandle(
          (src, flags) => {
            const re = new RegExp(src, flags);
            return (
              [...document.querySelectorAll('button, [role="button"]')].find(
                (b) =>
                  re.test((b.innerText || b.textContent || '').trim()) &&
                  !b.disabled &&
                  b.offsetParent !== null
              ) || null
            );
          },
          regex.source,
          regex.flags
        );
        const el = handle.asElement();
        if (el) return { frame, el };
        await handle.dispose();
      } catch {
        /* ignore */
      }
    }
    await sleep(400);
  } while (Date.now() < deadline);
  return null;
}

async function clickIfPresent(page, selectors, opts = {}) {
  const res = await findElement(page, selectors, { timeout: 3000, ...opts });
  if (!res) return false;
  try {
    await res.el.click();
    return true;
  } catch {
    return false;
  }
}

/** Clear a (React-controlled) input and type a value with human-ish delay. */
async function typeInto(el, value) {
  await el.click({ clickCount: 3 });
  await el.press('Backspace');
  await el.type(value, { delay: 40 + Math.floor(Math.random() * 40) });
}

/** Wait for the #webclient iframe and return its Frame (or null if not used). */
async function getWebclientFrame(page, timeout, log) {
  try {
    const handle = await page.waitForSelector(SEL.webclientIframe, { timeout });
    const frame = await handle.contentFrame();
    if (frame) {
      log.info('Found #webclient iframe.');
      return frame;
    }
  } catch {
    /* not found within timeout */
  }
  log.info('No #webclient iframe detected; searching all frames instead.');
  return null;
}

/** Save screenshot + HTML + URL for post-mortem debugging. */
async function saveDiagnostics(page, name, label) {
  try {
    fs.mkdirSync(CONFIG.SCREENSHOT_DIR, { recursive: true });
    const base = path.join(CONFIG.SCREENSHOT_DIR, `${safeFile(name)}_${label}_${Date.now()}`);
    await withTimeout(page.screenshot({ path: `${base}.png`, fullPage: true }), 10000, 'screenshot');
    const parts = [`<!-- URL: ${page.url()} -->`];
    for (const f of page.frames()) {
      try {
        parts.push(`<!-- FRAME: ${f.url()} -->`, await withTimeout(f.content(), 5000, 'frame.content'));
      } catch {
        /* ignore */
      }
    }
    fs.writeFileSync(`${base}.html`, parts.join('\n'));
    return base;
  } catch {
    return null;
  }
}

async function safeClose(browser) {
  if (!browser) return;
  state.browsers.delete(browser);
  try {
    await Promise.race([browser.close(), sleep(10000)]);
  } catch {
    /* already closed */
  }
  try {
    if (browser.process()) browser.process().kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

/** Pause launches while free RAM is low; return false if it never recovers. */
async function waitForMemory(log) {
  const deadline = Date.now() + 60000;
  let warned = false;
  while (freeMemMb() < CONFIG.MIN_FREE_MEM_MB) {
    if (state.shuttingDown || Date.now() > deadline) return false;
    if (!warned) {
      log.warn(`Free RAM ${freeMemMb()} MB < ${CONFIG.MIN_FREE_MEM_MB} MB; pausing launches...`);
      warned = true;
    }
    await interruptibleSleep(5000);
  }
  return true;
}

// ============================================================================
// Browser / session management
// ============================================================================
async function launchChrome(index) {
  const w = 1100;
  const h = 760;
  const offset = ((index - 1) % 10) * 40;

    const extraLowMemArgs = CONFIG.LOW_MEMORY
      ? [
          // Disable GPU process
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-accelerated-2d-canvas',
          '--disable-dev-shm-usage',
          // Spread 30 tabs across 8 renderer processes (matching 8 CPU cores) inside defaultBrowserContext
          '--renderer-process-limit=8',
        ]
      : [];

    const browser = await puppeteer.launch({
      headless: CONFIG.HEADLESS,
      protocolTimeout: 60000,
      defaultViewport: CONFIG.HEADLESS ? { width: 300, height: 300 } : null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        // Fake camera/mic + auto-accept permission prompts.
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        // Don't blast the fake 440Hz tone through your speakers.
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-notifications',
        '--disable-blink-features=AutomationControlled',
        // Enable background tab throttling to let idle tabs sleep and free RAM
        '--enable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
        '--no-first-run',
        '--no-default-browser-check',
        '--lang=en-US',
        `--window-size=${w},${h}`,
        `--window-position=${offset},${offset}`,
        ...extraLowMemArgs,
      ],
    });
  state.browsers.add(browser);
  return browser;
}

async function grantPermissions(context) {
  // Belt-and-braces: the fake-media flags already handle this, so never block on it.
  for (const origin of ['https://zoom.us', 'https://app.zoom.us']) {
    try {
      await withTimeout(
        context.overridePermissions(origin, ['camera', 'microphone', 'notifications']),
        5000,
        `overridePermissions(${origin})`
      );
    } catch {
      /* ignore */
    }
  }
}

function getSharedBrowser() {
  if (!state.sharedBrowserPromise) {
    state.sharedBrowserPromise = launchChrome(1).then(
      (browser) => {
        browser.on('disconnected', () => {
          state.sharedBrowserPromise = null;
          if (!state.shuttingDown) mainLog.warn('Shared browser disconnected!');
        });
        return browser;
      },
      (err) => {
        state.sharedBrowserPromise = null;
        throw err;
      }
    );
  }
  return state.sharedBrowserPromise;
}

/**
 * A "session" is an isolated browser identity for one bot: either its own
 * Chrome process, or an incognito-style context inside a shared Chrome.
 */
const CONTEXT_POOL_SIZE = 8; // 8 BrowserContexts = 8 renderer processes (1 per CPU core, ~3-4 bots each)

async function getPooledContext(index) {
  const browser = await getSharedBrowser();
  if (!state.contextPool) state.contextPool = [];
  const slot = (index - 1) % CONTEXT_POOL_SIZE;
  if (!state.contextPool[slot]) {
    state.contextPool[slot] = (async () => {
      const ctx =
        slot === 0
          ? browser.defaultBrowserContext()
          : await withTimeout(browser.createBrowserContext(), 15000, 'createBrowserContext()');
      await grantPermissions(ctx);
      return ctx;
    })();
  }
  return { browser, context: await state.contextPool[slot] };
}

async function openSession(index) {
  if (CONFIG.SHARED_BROWSER) {
    const { browser, context } = await getPooledContext(index);
    const sess = {
      browser,
      context,
      page: null,
      isAlive: (page) => browser.connected && !!page && !page.isClosed(),
      close: async () => {
        try {
          if (sess.page && !sess.page.isClosed()) {
            await withTimeout(sess.page.close(), 10000, 'page.close()');
          }
        } catch {
          /* ignore */
        }
      },
    };
    return sess;
  }
  const browser = await launchChrome(index);
  const context = browser.defaultBrowserContext();
  await grantPermissions(context);
  return {
    browser,
    context,
    page: null,
    isAlive: (page) => browser.connected && !!page && !page.isClosed(),
    close: () => safeClose(browser),
  };
}

// ============================================================================
// Join flow
// ============================================================================
async function joinMeeting(session, botName, log) {
  log.info('Session ready; preparing page...');
  const page = await withTimeout(session.context.newPage(), 30000, 'newPage()');
  session.page = page;
  page.setDefaultTimeout(CONFIG.JOIN_TIMEOUT_MS);
  if (!CONFIG.HEADLESS && CONFIG.SHARED_BROWSER) await page.setViewport({ width: 1100, height: 700 });

  // Give every tab its own isolated in-memory localStorage & sessionStorage so all 30 tabs
  // can live inside defaultBrowserContext and share renderer processes without colliding!
  await page.evaluateOnNewDocument((lowMem) => {
    const makeStore = () => {
      const data = new Map();
      return {
        getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
        setItem: (k, v) => data.set(String(k), String(v)),
        removeItem: (k) => data.delete(String(k)),
        clear: () => data.clear(),
        key: (i) => [...data.keys()][i] ?? null,
        get length() {
          return data.size;
        },
      };
    };
    try {
      Object.defineProperty(window, 'localStorage', { value: makeStore(), configurable: true });
      Object.defineProperty(window, 'sessionStorage', { value: makeStore(), configurable: true });
    } catch {}

    if (lowMem) {
      HTMLVideoElement.prototype.play = function () {
        return Promise.resolve();
      };
      HTMLAudioElement.prototype.play = function () {
        return Promise.resolve();
      };
      if (window.VideoDecoder) {
        window.VideoDecoder.prototype.decode = function () {};
      }
      // Track heavy media Web Workers (audio/video/sharing Wasm) so we can terminate them once joined
      const OrigWorker = window.Worker;
      window.__mediaWorkers = [];
      window.Worker = function (url, opts) {
        const w = new OrigWorker(url, opts);
        if (/web-media|video|audio|sharing/i.test(String(url))) {
          window.__mediaWorkers.push(w);
        }
        return w;
      };
    }
  }, CONFIG.LOW_MEMORY);

  // Strip "HeadlessChrome" from UA — Zoom may serve an unsupported-browser page.
  const ua = (await withTimeout(session.browser.userAgent(), 10000, 'userAgent()')).replace(
    'HeadlessChrome',
    'Chrome'
  );
  await withTimeout(page.setUserAgent(ua), 10000, 'setUserAgent()');
  await withTimeout(
    page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }),
    10000,
    'setExtraHTTPHeaders()'
  );

  try {
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    if (CONFIG.LOW_MEMORY) {
      await client.send('Network.setBlockedURLs', {
        urls: [
          '*.png', '*.jpg', '*.jpeg', '*.gif',
          '*.woff', '*.woff2', '*.ttf',
          '*google-analytics.com*', '*onetrust.com*', '*bugsnag.com*'
        ]
      });
    }
  } catch {
    /* ignore */
  }

  // With an encrypted pwd hash, use the app.zoom.us join URL so the passcode is pre-filled.
  const url = CONFIG.MEETING_PWD_HASH
    ? `https://app.zoom.us/wc/${CONFIG.MEETING_ID}/join?pwd=${encodeURIComponent(CONFIG.MEETING_PWD_HASH)}`
    : `https://zoom.us/wc/join/${CONFIG.MEETING_ID}`;
  log.info('Navigating to Zoom web client...');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.JOIN_TIMEOUT_MS });
  } catch (e) {
    e.page = page;
    throw e;
  }

  try {
    // Only wait for #webclient iframe if we are on zoom.us/wc/join wrapper (app.zoom.us/wc is already the inner frame).
    const wc = url.includes('app.zoom.us/wc/') ? null : await getWebclientFrame(page, 8000, log);

    // Quick non-blocking check for cookie banner / ToS before polling for nameInput
    if (await clickIfPresent(page, SEL.cookieAccept, { timeout: 1000 })) log.info('Accepted cookies.');
    if (await clickIfPresent(page, SEL.tosAgree, { timeout: 1000, preferFrame: wc })) log.info('Accepted ToS.');

    // ---- Name -----------------------------------------------------------
    const nameRes = await findElement(page, SEL.nameInput, {
      timeout: CONFIG.JOIN_TIMEOUT_MS,
      preferFrame: wc,
    });
    if (!nameRes) throw new Error('Name input not found (Zoom DOM may have changed).');
    await typeInto(nameRes.el, botName);
    log.info(`Entered name "${botName}".`);

    // ---- Passcode (preview screen) --------------------------------------
    let passcodeEntered = false;
    if (CONFIG.MEETING_PASSCODE) {
      const pwdRes = await findElement(page, SEL.passInput, { timeout: 5000, preferFrame: wc });
      if (pwdRes) {
        await typeInto(pwdRes.el, CONFIG.MEETING_PASSCODE);
        passcodeEntered = true;
        log.info('Entered passcode.');
      }
    }

    // ---- Join -----------------------------------------------------------
    await clickJoin(page, wc, log);

    // Some flows ask for the passcode on a second screen after "Join".
    if (CONFIG.MEETING_PASSCODE && !passcodeEntered) {
      const pwdRes = await findElement(page, SEL.passInput, { timeout: 10000, preferFrame: wc });
      if (pwdRes) {
        await typeInto(pwdRes.el, CONFIG.MEETING_PASSCODE);
        log.info('Entered passcode (second screen).');
        await clickJoin(page, wc, log);
      }
    }

    // ---- Outcome --------------------------------------------------------
    const status = await waitForOutcome(page, wc, log);

    if (status === 'in-meeting' && CONFIG.JOIN_AUDIO) {
      const audio =
        (await findElement(page, SEL.joinAudio, { timeout: 15000, preferFrame: wc })) ||
        (await findButtonByText(page, /join audio by computer/i, { timeout: 3000, preferFrame: wc }));
      if (audio) {
        try {
          await audio.el.click();
          log.info('Joined computer audio.');
        } catch {
          /* ignore */
        }
      }
    }

    if (CONFIG.LOW_MEMORY) {
      // Deallocate video/canvas compositor buffers and terminate heavy media Web Workers once in meeting
      await page.evaluate(() => {
        const s = document.createElement('style');
        s.textContent = 'canvas, video, .gallery-video-container, .speaker-active-container { display: none !important; }';
        document.head.appendChild(s);
        if (window.__mediaWorkers) {
          for (const w of window.__mediaWorkers) {
            try { w.terminate(); } catch {}
          }
          window.__mediaWorkers.length = 0;
        }
      }).catch(() => {});
    }

    return { page, status };
  } catch (e) {
    e.page = page;
    throw e;
  }
}

async function clickJoin(page, wc, log) {
  let btn = await findElement(page, SEL.joinButton, { timeout: 15000, preferFrame: wc });
  if (!btn) btn = await findButtonByText(page, /^join$/i, { timeout: 5000, preferFrame: wc });
  if (!btn) throw new Error('Join button not found.');

  // Wait for the button to become enabled (it's disabled until name is valid).
  try {
    await btn.frame.waitForFunction(
      (el) => !el.disabled && !el.classList.contains('disabled'),
      { timeout: 10000 },
      btn.el
    );
  } catch {
    log.warn('Join button still looks disabled; clicking anyway.');
  }
  await btn.el.click();
  log.info('Clicked Join.');
}

/** Resolve to 'in-meeting' | 'waiting-room'; throw on error/timeout. */
async function waitForOutcome(page, wc, log) {
  const deadline = Date.now() + CONFIG.JOIN_TIMEOUT_MS;
  while (Date.now() < deadline && !state.shuttingDown) {
    if (await findElement(page, SEL.inMeeting, { timeout: 0, preferFrame: wc, visible: false })) {
      await clickIfPresent(page, ['button.zm-btn--primary', '.zm-modal button'], { timeout: 1000, preferFrame: wc });
      log.info('✅ In meeting.');
      return 'in-meeting';
    }
    if (await findElement(page, SEL.waitingRoom, { timeout: 0, preferFrame: wc })) {
      log.info('⏳ In waiting room (host must admit).');
      return 'waiting-room';
    }
    const err = await findElement(page, SEL.errorDialog, { timeout: 0, preferFrame: wc });
    if (err) {
      const text = (await err.frame.evaluate((e) => e.innerText, err.el).catch(() => '')).trim();
      // "This meeting is being transcribed / recorded / AI Companion" is an in-meeting notice, not an error!
      if (/transcribed|recorded|ai companion|livestreamed|got it/i.test(text)) {
        await clickIfPresent(page, ['button.zm-btn--primary', '.zm-modal button'], { timeout: 2000, preferFrame: wc });
        log.info(`✅ In meeting (dismissed notice: "${text}").`);
        return 'in-meeting';
      }
      if (text) throw new Error(`Zoom error: ${text}`);
    }
    await sleep(1000);
  }
  if (state.shuttingDown) throw new Error('Shutdown requested during join.');
  throw new Error('Timed out waiting to enter meeting / waiting room.');
}

// ============================================================================
// Bot lifecycle
// ============================================================================
async function runBot(index) {
  const name = BOT_NAMES[index - 1];
  const log = makeLogger(`#${index} ${name}`);

  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES + 1; attempt++) {
    if (state.shuttingDown) break;
    let session;
    try {
      log.info(`Starting (attempt ${attempt}/${CONFIG.MAX_RETRIES + 1})...`);
      session = await openSession(index);
      const { page, status } = await joinMeeting(session, name, log);

      const bot = { name, session, page, status };
      page.on('close', () => {
        if (!state.shuttingDown) log.warn('Page closed unexpectedly.');
        bot.status = 'disconnected';
      });
      state.bots.push(bot);
      return bot;
    } catch (err) {
      log.error(err.message);
      if (err.page) {
        const base = await saveDiagnostics(err.page, name, `fail_attempt${attempt}`);
        if (base) log.info(`Saved diagnostics: ${base}.png/.html`);
      }
      if (session) await session.close();
      if (attempt <= CONFIG.MAX_RETRIES && !state.shuttingDown) {
        const backoff = 5000 * attempt;
        log.info(`Retrying in ${backoff / 1000}s...`);
        await interruptibleSleep(backoff);
      }
    }
  }
  const failed = { name, session: null, page: null, status: 'failed' };
  state.bots.push(failed);
  return failed;
}

async function leaveMeeting(bot) {
  if (!bot.session || !bot.session.isAlive(bot.page)) return;
  try {
    const leave =
      (await findElement(bot.page, SEL.leaveButton, { timeout: 3000 })) ||
      (await findButtonByText(bot.page, /^leave$/i, { timeout: 2000 }));
    if (leave) {
      await leave.el.click();
      const confirm =
        (await findElement(bot.page, SEL.leaveConfirm, { timeout: 3000 })) ||
        (await findButtonByText(bot.page, /leave meeting/i, { timeout: 2000 }));
      if (confirm) await confirm.el.click();
      makeLogger(bot.name).info('Left meeting.');
      await sleep(1000);
    }
  } catch {
    /* best effort */
  }
}

async function shutdownAll(reason) {
  if (state._closing) return;
  state._closing = true;
  state.shuttingDown = true;
  wakeAll();
  mainLog.info(`Shutting down (${reason})...`);

  await Promise.allSettled(
    state.bots
      .filter((b) => b.session)
      .map(async (b) => {
        await Promise.race([leaveMeeting(b), sleep(8000)]);
        await b.session.close();
      })
  );
  // Close any browsers still open (shared browser, or bots mid-launch/join).
  await Promise.allSettled([...state.browsers].map(safeClose));
  mainLog.info('All browsers closed.');
}

// ============================================================================
// Main
// ============================================================================
function validateConfig() {
  const errors = [];
  if (!/^\d{9,11}$/.test(CONFIG.MEETING_ID)) errors.push('MEETING_ID must be 9–11 digits.');
  if (!(CONFIG.BOT_COUNT >= 1)) errors.push('BOT_COUNT must be >= 1.');
  if (!(CONFIG.DURATION_MINUTES > 0)) errors.push('DURATION_MINUTES must be > 0.');
  if (errors.length) {
    errors.forEach((e) => mainLog.error(e));
    mainLog.info('Example: node zoom_bots.js --join-url="https://app.zoom.us/wc/123.../join?pwd=..." --bot-count=5');
    process.exit(1);
  }
  const estGb = (CONFIG.BOT_COUNT * (CONFIG.SHARED_BROWSER ? 0.5 : 0.75)).toFixed(1);
  const totalGb = (os.totalmem() / 1024 ** 3).toFixed(1);
  mainLog.info(
    `Estimated RAM for ${CONFIG.BOT_COUNT} bots: ~${estGb} GB (machine: ${totalGb} GB total, ${freeMemMb()} MB free).`
  );
}

function installSignalHandlers() {
  let count = 0;
  const handler = async (sig) => {
    count++;
    if (count > 1) {
      mainLog.warn('Forced exit.');
      for (const b of state.browsers) {
        try { b.process()?.kill('SIGKILL'); } catch { /* ignore */ }
      }
      process.exit(130);
    }
    mainLog.info(`Received ${sig}. Press Ctrl+C again to force quit.`);
    await shutdownAll(sig);
    process.exit(130);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  process.on('unhandledRejection', (e) => mainLog.error('Unhandled rejection:', e?.message || e));
}

async function main() {
  validateConfig();
  installSignalHandlers();

  mainLog.info('Config:', {
    ...CONFIG,
    MEETING_PASSCODE: CONFIG.MEETING_PASSCODE ? '***' : '(none)',
    MEETING_PWD_HASH: CONFIG.MEETING_PWD_HASH ? '***' : '(none)',
  });

  // Launch bots using a bounded concurrency pool (max 3 joining simultaneously)
  // so the CPU and renderer threads never get saturated during page compilation.
  const MAX_CONCURRENT_JOINS = 3;
  const results = [];
  let nextIndex = 1;
  async function joinWorker(workerId) {
    await interruptibleSleep((workerId - 1) * 2500);
    while (!state.shuttingDown) {
      const i = nextIndex++;
      if (i > CONFIG.BOT_COUNT) break;
      const res = await runBot(i);
      results.push(res);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_JOINS, CONFIG.BOT_COUNT) }, (_, k) => joinWorker(k + 1))
  );

  const joined = results.filter((r) => r.status === 'in-meeting').length;
  const waiting = results.filter((r) => r.status === 'waiting-room').length;
  const failed = results.filter((r) => r.status === 'failed');
  mainLog.info(
    `Join summary: ${joined} in meeting, ${waiting} in waiting room, ${failed.length} failed, ` +
      `${CONFIG.BOT_COUNT - results.length} not launched.`
  );
  if (failed.length) mainLog.info(`Failed: ${failed.map((f) => f.name).join(', ')}`);

  if (joined + waiting === 0) {
    await shutdownAll('no bots joined');
    process.exit(1);
  }

  // Keep sessions alive for the configured duration, with periodic heartbeat.
  const durationMs = CONFIG.DURATION_MINUTES * 60 * 1000;
  const endAt = Date.now() + durationMs;
  mainLog.info(`Keeping sessions alive for ${CONFIG.DURATION_MINUTES} minute(s). Ctrl+C to stop early.`);

  while (!state.shuttingDown && Date.now() < endAt) {
    await interruptibleSleep(Math.min(60000, endAt - Date.now()));
    if (state.shuttingDown) break;
    const alive = state.bots.filter((b) => b.session && b.session.isAlive(b.page)).length;
    const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    mainLog.info(
      `Heartbeat: ${alive}/${results.length} bots alive, ${freeMemMb()} MB free RAM, ${remaining}s remaining.`
    );
    if (alive === 0) {
      mainLog.warn('All bots disconnected; ending early.');
      break;
    }
  }

  await shutdownAll('duration elapsed');
  process.exit(0);
}

main().catch(async (err) => {
  mainLog.error('Fatal:', err);
  await shutdownAll('fatal error');
  process.exit(1);
});
