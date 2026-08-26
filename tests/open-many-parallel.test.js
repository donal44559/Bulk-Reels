// Unit test: verifies the browser:openMany parallel runner semantics
// (pattern copied verbatim from main.js) against a simulated openProfile.
const fs = require('fs');
const path = require('path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'BulkReelsBot', 'main.js'), 'utf8');
const start = mainSrc.indexOf('const list = Array.isArray(uids)');
const endMarker = 'return results;';
const end = mainSrc.indexOf(endMarker, start);
if (start < 0 || end < 0) { console.error('FATAL: openMany runner not found in main.js'); process.exit(1); }
const runnerCode = mainSrc.slice(start, end + endMarker.length);

// Wrap the extracted code in a function with injectable getProfile/openProfile
const runnerFactory = new Function(
  'getProfile', 'openProfile',
  `return async function handler(uids) {\n${runnerCode}\n};`
);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  let passed = 0, failed = 0;
  const check = (name, cond, extra) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
  };

  console.log('— bulk open: 10 profiles, cap 10 → all parallel —');
  {
    let inFlight = 0, maxInFlight = 0, startOrder = [];
    const getProfile = async (uid) => ({ uid, name: 'P' + uid });
    const openProfile = async (p) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      startOrder.push(p.uid);
      await sleep(30 + Math.random() * 60);
      inFlight--;
      return { success: true };
    };
    const handler = runnerFactory(getProfile, openProfile);
    const t0 = Date.now();
    const res = await handler(['a','b','c','d','e','f','g','h','i','j']);
    const ms = Date.now() - t0;
    check('all 10 results returned', res.length === 10, res.length);
    check('result slots keep request order', res.every((r, i) => r.uid === ['a','b','c','d','e','f','g','h','i','j'][i]), res.map(r => r.uid));
    check('ALL 10 opened SIMULTANEOUSLY (max in-flight = 10)', maxInFlight === 10, maxInFlight);
    check('total time ≈ single open (parallel, not sequential)', ms < 200, ms + 'ms');
    check('all succeeded', res.every(r => r.success === true));
  }

  console.log('— no cap: 25 profiles → ALL 25 open simultaneously —');
  {
    let inFlight = 0, maxInFlight = 0, completed = 0;
    const getProfile = async (uid) => ({ uid, name: 'P' + uid });
    const openProfile = async (p) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(15);
      inFlight--; completed++;
      return { success: true };
    };
    const handler = runnerFactory(getProfile, openProfile);
    const res = await handler(Array.from({ length: 25 }, (_, i) => 'u' + i));
    check('all 25 processed', res.length === 25 && completed === 25);
    check('ALL 25 opened SIMULTANEOUSLY (no cap — user decides)', maxInFlight === 25, maxInFlight);
  }

  console.log('— one bad profile must not break the batch —');
  {
    const getProfile = async (uid) => uid === 'bad' ? null : { uid, name: 'P' + uid };
    const openProfile = async (p) => {
      if (p.uid === 'crash') throw new Error('boom');
      await sleep(20);
      return { success: true };
    };
    const handler = runnerFactory(getProfile, openProfile);
    const res = await handler(['ok1', 'bad', 'crash', 'ok2']);
    check('missing profile → isolated error result', res[1].success === false && res[1].error === 'Profile not found', res[1]);
    check('throwing profile → isolated error result', res[2].success === false && /boom/.test(res[2].error), res[2]);
    check('other profiles still opened fine', res[0].success === true && res[3].success === true);
  }

  console.log('— edge inputs —');
  {
    const handler = runnerFactory(async () => ({}), async () => ({ success: true }));
    check('non-array uids → empty result', (await handler('nope')).length === 0);
    check('empty array → empty result', (await handler([])).length === 0);
    const res = await handler(['only1']);
    check('single uid works', res.length === 1 && res[0].success === true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
