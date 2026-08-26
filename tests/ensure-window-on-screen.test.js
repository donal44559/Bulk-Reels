// Unit test: extracts ensureWindowOnScreen from src/bot.js and exercises it
// against a mocked Playwright context/page/CDP session covering every branch.
const fs = require('fs');
const path = require('path');

const botSrc = fs.readFileSync(path.join(__dirname, '..', 'BulkReelsBot', 'src', 'bot.js'), 'utf8');
const start = botSrc.indexOf('async function ensureWindowOnScreen');
const end = botSrc.indexOf('async function launchForProfile');
if (start < 0 || end < 0 || end <= start) { console.error('FATAL: helper not found in bot.js'); process.exit(1); }
const fnSrc = botSrc.slice(start, end);
const ensureWindowOnScreen = new Function('return ' + fnSrc)();

// ---- test harness ----
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

function makeEnv({ bounds, screen, evaluateThrows, sendThrows, withCdpSession = true }) {
  const calls = [];
  const session = {
    send: async (method, params) => {
      if (sendThrows) throw new Error('cdp exploded');
      calls.push({ method, params });
      if (method === 'Browser.getWindowForTarget') return { windowId: 7, bounds };
      // emulate: setWindowBounds with windowState normalizes state
      if (method === 'Browser.setWindowBounds' && params.windowState === 'normal') bounds.windowState = 'normal';
      return {};
    },
    detach: async () => { calls.push({ method: 'detach' }); },
  };
  const page = {
    evaluate: async (fn) => {
      if (evaluateThrows) throw new Error('page gone');
      return typeof screen === 'function' ? screen() : screen;
    },
  };
  const context = withCdpSession
    ? { newCDPSession: async () => session }
    : {};
  return { context, page, calls };
}

(async () => {
  const ON = { left: 0, top: 0, width: 1920, height: 1040 };           // primary work area
  const RIGHT_MONITOR = { left: 1920, top: 0, width: 1920, height: 1040 };

  console.log('— on-screen cases (must be a NO-OP) —');
  {
    const e = makeEnv({ bounds: { left: 100, top: 80, width: 1280, height: 800, windowState: 'normal' }, screen: ON });
    await ensureWindowOnScreen(e.context, e.page);
    check('normal on-screen → no setWindowBounds', !e.calls.some(c => c.method === 'Browser.setWindowBounds'), e.calls);
    check('normal on-screen → session detached', e.calls.some(c => c.method === 'detach'), e.calls);
  }
  {
    const e = makeEnv({ bounds: { left: 1920, top: 0, width: 1280, height: 800, windowState: 'normal' }, screen: RIGHT_MONITOR });
    await ensureWindowOnScreen(e.context, e.page);
    check('window on 2nd monitor (availLeft=1920) → no-op', !e.calls.some(c => c.method === 'Browser.setWindowBounds'), e.calls);
  }
  {
    const e = makeEnv({ bounds: { left: 100, top: 80, width: 1280, height: 800, windowState: 'maximized' }, screen: ON });
    await ensureWindowOnScreen(e.context, e.page);
    check('maximized (on-screen) → no-op', !e.calls.some(c => c.method === 'Browser.setWindowBounds'), e.calls);
  }

  console.log('— off-screen cases (must be repositioned) —');
  {
    const e = makeEnv({ bounds: { left: -2000, top: -2000, width: 400, height: 300, windowState: 'normal' }, screen: ON });
    await ensureWindowOnScreen(e.context, e.page);
    const b = e.calls.find(c => c.method === 'Browser.setWindowBounds');
    check('window at (-2000,-2000) → moved', !!b, e.calls);
    check('  → clamped to (0,0)', b && b.params.bounds.left === 0 && b.params.bounds.top === 0, b && b.params);
    check('  → no size/state change', b && b.params.bounds.width === undefined && !b.params.windowState, b && b.params);
  }
  {
    const e = makeEnv({ bounds: { left: 2500, top: 500, width: 400, height: 300, windowState: 'normal' }, screen: ON });
    await ensureWindowOnScreen(e.context, e.page);
    const b = e.calls.find(c => c.method === 'Browser.setWindowBounds');
    check('fully off right edge → pulled back to 1520', b && b.params.bounds.left === 1520 && b.params.bounds.top === 500, b && b.params);
  }
  {
    const e = makeEnv({ bounds: { left: 1800, top: 1000, width: 400, height: 300, windowState: 'normal' }, screen: ON });
    await ensureWindowOnScreen(e.context, e.page);
    const b = e.calls.find(c => c.method === 'Browser.setWindowBounds');
    check('partially off bottom-right → clamped to (1520,740)', b && b.params.bounds.left === 1520 && b.params.bounds.top === 740, b && b.params);
  }
  {
    const e = makeEnv({ bounds: { left: -32000, top: -32000, width: 1280, height: 800, windowState: 'minimized' }, screen: ON });
    await ensureWindowOnScreen(e.context, e.page);
    const norm = e.calls.find(c => c.method === 'Browser.setWindowBounds' && c.params.windowState === 'normal');
    const move = e.calls.filter(c => c.method === 'Browser.setWindowBounds' && c.params.bounds).pop();
    check('minimized → normalized then repositioned', !!norm && !!move, e.calls);
    check('  → moved to (0,0)', move && move.params.bounds.left === 0 && move.params.bounds.top === 0, move && move.params);
  }
  {
    // taskbar on the left edge: work area starts at 40
    const e = makeEnv({ bounds: { left: -2000, top: -2000, width: 400, height: 300, windowState: 'normal' }, screen: { left: 40, top: 0, width: 1880, height: 1040 } });
    await ensureWindowOnScreen(e.context, e.page);
    const b = e.calls.find(c => c.method === 'Browser.setWindowBounds' && c.params.bounds);
    check('left-docked taskbar → clamps to work area (40,0)', b && b.params.bounds.left === 40 && b.params.bounds.top === 0, b && b.params);
  }

  console.log('— hostile / degenerate inputs (must never throw) —');
  {
    const e = makeEnv({ bounds: { left: -2000, top: -2000, width: 400, height: 300, windowState: 'normal' }, screen: ON, evaluateThrows: true });
    let threw = false;
    try { await ensureWindowOnScreen(e.context, e.page); } catch { threw = true; }
    check('page.evaluate throws → no throw', !threw);
    check('  → and no reposition attempted', !e.calls.some(c => c.method === 'Browser.setWindowBounds'), e.calls);
  }
  {
    const e = makeEnv({ bounds: { left: -2000, top: -2000, width: 400, height: 300, windowState: 'normal' }, screen: ON, sendThrows: true });
    let threw = false;
    try { await ensureWindowOnScreen(e.context, e.page); } catch { threw = true; }
    check('CDP send throws → no throw', !threw);
  }
  {
    const e = makeEnv({ bounds: { left: -2000, top: -2000, width: 400, height: 300, windowState: 'normal' }, screen: ON, withCdpSession: false });
    let threw = false;
    try { await ensureWindowOnScreen(e.context, e.page); } catch { threw = true; }
    check('context without newCDPSession → no throw', !threw);
  }
  {
    let threw = false;
    try { await ensureWindowOnScreen(null, null); await ensureWindowOnScreen({}, {}); } catch { threw = true; }
    check('null/empty args → no throw', !threw);
  }
  {
    const e = makeEnv({ bounds: { left: -2000, top: -2000, width: 0, height: 0, windowState: 'normal' }, screen: ON });
    await ensureWindowOnScreen(e.context, e.page);
    const b = e.calls.find(c => c.method === 'Browser.setWindowBounds' && c.params.bounds);
    check('zero-size bounds → fallback size used, still clamped on-screen', b && b.params.bounds.left === 0 && b.params.bounds.top === 0, b && b.params);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
