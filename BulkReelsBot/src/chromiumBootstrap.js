// ============================================================
// Chromium Bootstrap
//
// Playwright ships its own Chromium binary (~170 MB). We DO NOT bundle
// it inside the installer to keep the .exe small. Instead:
//
//   1. On first launch, check if Chromium exists in userData folder
//   2. If not, download it silently in the background via Playwright's CLI
//   3. All subsequent launches reuse the cached copy
//
// The browser lives in <userData>/pw-browsers so it survives app updates
// (userData folder is untouched by installer). Playwright is told about
// this location via PLAYWRIGHT_BROWSERS_PATH env var, which MUST be set
// BEFORE require('playwright') anywhere in the codebase.
// ============================================================

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs   = require('fs');

// We can't call app.getPath('userData') at require-time because Electron's
// `app` object might not be ready yet (main.js requires this module at the
// very top of the file, before app.whenReady()). Instead we resolve the path
// lazily and set PLAYWRIGHT_BROWSERS_PATH the moment it's needed.
//
// SAFE fallback: use a well-known Windows path derived from environment
// variables so PLAYWRIGHT_BROWSERS_PATH is set immediately (bot.js might
// require playwright at module-load time too). We overwrite with the real
// userData path once app is ready — both paths resolve to the same folder
// in practice for a single-user install.
let BROWSERS_DIR = null;

function _appDataRoot() {
  return process.env.APPDATA
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'AppData', 'Roaming');
}

// Candidate userData folder names. Electron derives userData from app.getName(),
// which is the package.json "name" field ("bulk-reels-upload-pro") — NOT the
// electron-builder "productName". We check every plausible spelling so we never
// download a second 170 MB copy into a folder that doesn't match.
function _candidateBrowserDirs() {
  const root = _appDataRoot();
  const names = [];
  try { const n = app.getName(); if (n) names.push(n); } catch {}
  names.push('bulk-reels-upload-pro', 'Bulk Reels Upload Pro');
  const out = [];
  for (const n of names) {
    const d = path.join(root, n, 'pw-browsers');
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

function _resolveBrowsersDir() {
  if (BROWSERS_DIR) return BROWSERS_DIR;

  // Prefer the canonical Electron userData path when the app is ready.
  try {
    const p = path.join(app.getPath('userData'), 'pw-browsers');
    BROWSERS_DIR = p;
    return BROWSERS_DIR;
  } catch (_) { /* app not ready yet */ }

  // Not ready: pick an existing candidate if one already has a browser,
  // otherwise fall back to the package-name folder Electron will actually use.
  for (const d of _candidateBrowserDirs()) {
    try { if (fs.existsSync(d)) { BROWSERS_DIR = d; return BROWSERS_DIR; } } catch {}
  }
  BROWSERS_DIR = path.join(_appDataRoot(), 'bulk-reels-upload-pro', 'pw-browsers');
  return BROWSERS_DIR;
}

// Once the app IS ready, re-resolve so the env var points at the canonical path.
function refreshBrowsersDir() {
  BROWSERS_DIR = null;
  const dir = _resolveBrowsersDir();
  process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
  return dir;
}

// The chromium revision that the CURRENT Playwright version expects, e.g.
// "chromium-1217" for Playwright 1.59.0. We must check for this EXACT revision,
// not just any "chromium-*" folder. This app pins a specific Playwright version,
// and a left-over folder from an older/newer Playwright (e.g. one left by a
// previous install or a different tool) would otherwise make us incorrectly
// think Chromium is installed — which is exactly what caused the first-time
// setup/download popup to be skipped while the required revision was still
// missing (and browsers then failed to launch).
function _expectedChromiumFolderName() {
  try {
    const registry = _resolveRegistry();
    const exec = registry.findExecutable('chromium');
    if (exec && exec.directory) return path.basename(exec.directory);
    if (exec && exec.executablePath) return path.basename(path.dirname(exec.executablePath));
  } catch (_) { /* registry not resolvable yet */ }
  return null;
}

// Returns true only when `folder` actually contains the real Chromium/Chrome
// executable. A folder that merely carries the "chromium-<rev>" name but whose
// download was interrupted/partial (no chrome binary) does NOT count as
// installed — that partial folder is exactly what made the first-time setup
// popup disappear while browser launch still failed.
function _hasChromeExecutable(folder) {
  if (!folder || !fs.existsSync(folder)) return false;
  const candidates = [
    path.join(folder, 'chrome.exe'),
    path.join(folder, 'chrome'),
    path.join(folder, 'chrome-win64', 'chrome.exe'),
    path.join(folder, 'chrome-win', 'chrome.exe'),
    path.join(folder, 'chrome-linux', 'chrome'),
    path.join(folder, 'chrome-linux64', 'chrome'),
    path.join(folder, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    path.join(folder, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  ];
  return candidates.some(p => { try { return fs.existsSync(p); } catch { return false; } });
}

function _hasChromium(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    const expected = _expectedChromiumFolderName();
    if (expected) {
      // Exact-revision check, AND the real binary must be present (not just the
      // folder name). Otherwise a partial download silently skips the setup
      // popup yet still fails to launch.
      return _hasChromeExecutable(path.join(dir, expected));
    }
    // Fallback (registry unavailable): accept any chromium folder that actually
    // holds a chrome binary.
    for (const n of fs.readdirSync(dir)) {
      if (/^chromium(-|_)/i.test(n) && _hasChromeExecutable(path.join(dir, n))) return true;
    }
    return false;
  } catch { return false; }
}

function isChromiumInstalled() {
  const primary = _resolveBrowsersDir();
  if (_hasChromium(primary)) return true;
  // A previous version of this app may have written to a differently-named
  // userData folder. Reuse it INSTEAD of re-downloading 170 MB — but only if
  // it holds the SAME exact revision the current Playwright version needs.
  for (const d of _candidateBrowserDirs()) {
    if (d !== primary && _hasChromium(d)) {
      BROWSERS_DIR = d;
      process.env.PLAYWRIGHT_BROWSERS_PATH = d;
      return true;
    }
  }
  return false;
}


// ------------------------------------------------------------------
// Resolve Playwright's internal browser registry.
//
// playwright-core ships an "exports" map in its package.json which BLOCKS
// deep requires like require('playwright-core/lib/server'). Node throws:
//   Package subpath './lib/server' is not defined by "exports"
// So we must locate playwright-core's folder on disk and require the file
// by ABSOLUTE path — absolute paths bypass the exports map entirely.
// ------------------------------------------------------------------
function _playwrightCoreRoots() {
  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };

  // 1. Normal resolution (main entry is always allowed by exports)
  try { push(path.dirname(require.resolve('playwright-core'))); } catch {}
  // 2. Via the playwright wrapper package
  try {
    const pw = path.dirname(require.resolve('playwright'));
    push(path.join(pw, '..', 'playwright-core'));
    push(path.join(pw, 'node_modules', 'playwright-core'));
  } catch {}
  // 3. Packaged app (asar / asar.unpacked) locations
  try {
    const appPath = app.getAppPath(); // ...\resources\app.asar
    push(path.join(appPath, 'node_modules', 'playwright-core'));
    push(path.join(appPath + '.unpacked', 'node_modules', 'playwright-core'));
    const resDir = path.dirname(appPath); // ...\resources
    push(path.join(resDir, 'app.asar.unpacked', 'node_modules', 'playwright-core'));
    push(path.join(resDir, 'app', 'node_modules', 'playwright-core'));
  } catch {}
  // 4. Relative to this very file
  push(path.join(__dirname, '..', 'node_modules', 'playwright-core'));
  push(path.join(__dirname, '..', '..', 'node_modules', 'playwright-core'));

  return roots.filter(r => { try { return fs.existsSync(r); } catch { return false; } });
}

function _resolveRegistry() {
  const attempts = [];
  const candidates = [
    // Newest layouts first
    ['lib', 'server', 'registry', 'index.js'],
    ['lib', 'server', 'index.js'],
    ['lib', 'server', 'registry.js'],
    ['lib', 'utils', 'registry.js'],
  ];

  const roots = _playwrightCoreRoots();
  if (!roots.length) attempts.push('playwright-core folder not found on disk');

  for (const root of roots) {
    for (const rel of candidates) {
      const file = path.join(root, ...rel);
      if (!fs.existsSync(file)) continue;
      try {
        const mod = require(file);
        const reg = mod.registry || (mod.default && mod.default.registry);
        if (reg && typeof reg.findExecutable === 'function') return reg;
        attempts.push(file + ' -> loaded but no usable registry');
      } catch (e) {
        attempts.push(file + ' -> ' + (e.message || e));
      }
    }
  }

  // Last resort: plain subpath requires (works if exports map allows it)
  for (const sub of ['playwright-core/lib/server/registry/index', 'playwright-core/lib/server', 'playwright-core/lib/server/registry', 'playwright-core/lib/utils/registry']) {
    try {
      const mod = require(sub);
      const reg = mod.registry;
      if (reg && typeof reg.findExecutable === 'function') return reg;
    } catch (e) { attempts.push(sub + ' -> ' + (e.message || e)); }
  }

  throw new Error(
    'Could not locate Playwright browser registry.\n' +
    'Roots checked: ' + (roots.join(' | ') || 'none') + '\n' +
    attempts.slice(0, 6).join('\n')
  );
}

async function installChromium(onProgress = () => {}) {
  const dir = _resolveBrowsersDir();
  fs.mkdirSync(dir, { recursive: true });
  // Ensure Playwright uses our download folder
  process.env.PLAYWRIGHT_BROWSERS_PATH = dir;

  onProgress({ status: 'starting', message: 'Preparing Chromium download...' });

  // We use Playwright's INTERNAL registry API directly instead of spawning
  // the CLI. This avoids the ELECTRON_RUN_AS_NODE subprocess dance which is
  // unreliable in portable Electron apps (process.execPath points at the
  // portable .exe extracted in %TEMP%, whose asar layout doesn't match what
  // Node expects).
  //
  // The API is technically private, but it's what the CLI uses under the
  // hood and it's stable across Playwright 1.x versions.
  const registry = _resolveRegistry();

  // Find the chromium executable descriptor
  const chromiumExec = registry.findExecutable('chromium');
  if (!chromiumExec) throw new Error('Playwright registry has no "chromium" entry');

  // Progress reporting — Playwright emits console/log calls internally.
  // The simplest reliable signal is a ticking heartbeat message; the actual
  // percentage isn't exposed through the public API. We poll folder size
  // for a rough visual.
  const targetDir = chromiumExec.directory ? path.dirname(chromiumExec.directory) : dir;
  const EXPECTED_MB = 170;
  let ticker = setInterval(() => {
    try {
      // Rough byte count of the browsers dir
      let bytes = 0;
      const stack = [dir];
      while (stack.length) {
        const p = stack.pop();
        let entries;
        try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
          const full = path.join(p, ent.name);
          if (ent.isDirectory()) stack.push(full);
          else {
            try { bytes += fs.statSync(full).size; } catch {}
          }
        }
      }
      const mb = Math.round(bytes / (1024 * 1024));
      const pct = Math.min(99, Math.round((mb / EXPECTED_MB) * 100));
      onProgress({ status: 'downloading', percent: pct, message: `Downloaded ${mb} MB / ~${EXPECTED_MB} MB` });
    } catch {}
  }, 750);

  try {
    // The install() call downloads whatever executables you pass, into the
    // PLAYWRIGHT_BROWSERS_PATH directory.
    await registry.install([chromiumExec], false /* forceReinstall */);
    clearInterval(ticker);
    onProgress({ status: 'done', percent: 100, message: 'Chromium ready' });
  } catch (err) {
    clearInterval(ticker);
    throw err;
  }
}

// Show a modal window during download so the user isn't confused
async function ensureChromiumWithUi() {
  if (isChromiumInstalled()) return true;

  // Write the progress-UI HTML to a temp file and load via file:// — this
  // is more robust than data: URLs (which Electron 30's stricter URL parser
  // sometimes rejects with ERR_FAILED for longer payloads).
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Setting up</title>
<style>
  body { margin:0; padding:32px; background:linear-gradient(135deg,#0b1220,#1e293b);
         color:#e2e8f0; font-family:Segoe UI,Roboto,sans-serif;
         height:100vh; box-sizing:border-box; display:flex; flex-direction:column; }
  h2 { margin:0 0 8px; font-size:20px; }
  .sub { color:#94a3b8; font-size:13px; margin-bottom:24px; }
  .bar-wrap { background:rgba(255,255,255,.06); border-radius:8px; height:12px; overflow:hidden; margin-bottom:12px; }
  .bar { height:100%; width:0%; background:linear-gradient(90deg,#06b6d4,#a855f7);
         transition:width .3s ease; border-radius:8px; }
  .pct { text-align:right; font-size:12px; color:#67e8f9; font-weight:600; margin-bottom:16px; }
  .msg { font-size:11px; color:#64748b; font-family:Consolas,monospace;
         white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .footer { margin-top:auto; font-size:11px; color:#475569; text-align:center; }
</style></head><body>
  <h2>🚀 First-time Setup</h2>
  <div class="sub">Downloading browser engine (~170 MB). This happens only once.</div>
  <div class="bar-wrap"><div class="bar" id="bar"></div></div>
  <div class="pct" id="pct">0%</div>
  <div class="msg" id="msg">Preparing...</div>
  <div class="footer">Do not close this window. Requires internet.</div>
  <script>
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('progress', (_e, p) => {
      if (typeof p.percent === 'number') {
        document.getElementById('bar').style.width = p.percent + '%';
        document.getElementById('pct').textContent = p.percent + '%';
      }
      if (p.message) document.getElementById('msg').textContent = p.message;
      if (p.status === 'done') {
        document.getElementById('pct').textContent = 'Ready!';
        document.getElementById('msg').textContent = 'Starting app...';
      }
    });
  </script>
</body></html>`;

  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brp-boot-'));
  const htmlPath = path.join(tmpDir, 'progress.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  const win = new BrowserWindow({
    width: 480, height: 320,
    resizable: false, minimizable: false, maximizable: false,
    frame: false, backgroundColor: '#0f172a',
    center: true, alwaysOnTop: true, skipTaskbar: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  try {
    await win.loadFile(htmlPath);
  } catch (e) {
    // If even the progress window fails, fall back to headless download so
    // the user isn't stuck. We still report failure via dialog on error.
    try { if (!win.isDestroyed()) win.destroy(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return await _headlessInstall();
  }

  try {
    await installChromium((p) => {
      try { if (!win.isDestroyed()) win.webContents.send('progress', p); } catch {}
    });
    // Small delay so user sees the "Ready!" message
    await new Promise(r => setTimeout(r, 700));
    try { if (!win.isDestroyed()) win.destroy(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return true;
  } catch (e) {
    try { if (!win.isDestroyed()) win.destroy(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'Setup Failed',
      'Could not download the browser engine.\n\n' +
      'Please check your internet connection and restart the app.\n\n' +
      'Error: ' + (e.message || e)
    );
    app.quit();
    return false;
  }
}

// Fallback if the progress window fails to load — just download headlessly.
async function _headlessInstall() {
  try {
    await installChromium(() => {});
    return true;
  } catch (e) {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'Setup Failed',
      'Could not download the browser engine.\n\n' +
      'Please check your internet connection and restart the app.\n\n' +
      'Error: ' + (e.message || e)
    );
    app.quit();
    return false;
  }
}

module.exports = {
  ensureChromiumWithUi,
  refreshBrowsersDir,
  isChromiumInstalled,
  get BROWSERS_DIR() { return _resolveBrowsersDir(); },
};
