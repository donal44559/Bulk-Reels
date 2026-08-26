// Security fix verification for src/auth/authService.js
// electron + supabaseClient are stubbed; the REAL authService code runs.
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- stub 'electron' (authService needs app.getPath only) ----
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'brup-auth-'));
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => TMPDIR } };
  return origLoad.apply(this, arguments);
};

// ---- stub supabaseClient via require.cache BEFORE authService loads ----
const SC_PATH = require.resolve('/home/user/Bulk-Reels/BulkReelsBot/src/auth/supabaseClient.js');
let calls = [];
let rpcHandlers = {};      // fn -> async (params) => {data, error}
let adminConfigResult = null; // what admin_config reads return
function makeClient(name) {
  return {
    from(table) {
      calls.push({ client: name, op: 'from', table });
      if (table === 'admin_config') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => adminConfigResult || { data: null, error: null } }) }) };
      }
      const qb = { select: () => qb, eq: () => qb, maybeSingle: () => ({ data: null, error: null }), update: () => qb, then(r) { return Promise.resolve({ data: null, error: null }).then(r); } };
      return qb;
    },
    async rpc(fn, params) {
      calls.push({ client: name, op: 'rpc', fn, params });
      const h = rpcHandlers[fn];
      if (!h) return { data: null, error: { message: 'no handler for ' + fn } };
      return h(params);
    },
  };
}
require.cache[SC_PATH] = { id: SC_PATH, filename: SC_PATH, loaded: true, exports: {
  getAnonClient: () => makeClient('anon'),
  getAdminClient: () => makeClient('admin'),
  SUPABASE_URL: 'https://example.supabase.co',
}};

const auth = require('/home/user/Bulk-Reels/BulkReelsBot/src/auth/authService.js');

let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
const authFile = () => path.join(TMPDIR, 'auth.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ROW = (over = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  username: 'testuser',
  full_name: 'Test User',
  is_admin: false,
  expires_at: new Date(Date.now() + 30 * 86400e3).toISOString(),
  is_blocked: false,
  machine_id: '',
  ...over,
});

(async () => {
  console.log('— C1/C2: activateUser goes through the activate_license RPC —');
  {
    calls = []; rpcHandlers = {
      activate_license: async (p) => {
        check('rpc params carry username/key/machine_id',
          typeof p.p_username === 'string' && typeof p.p_key === 'string' && typeof p.p_machine_id === 'string', p);
        return { data: [ROW({ machine_id: p.p_machine_id })], error: null };
      },
    };
    const res = await auth.activateUser({ username: 'TestUser', activation_key: 'KEY-1234' });
    check('activation succeeds via RPC', res.success === true, res);
    check('anon client used (never admin)', calls.every(c => c.client === 'anon'), calls.map(c => c.client));
    check('NO direct table read/write anymore (rpc only)', calls.every(c => c.op === 'rpc'), calls);
    check('RPC name = activate_license', calls.some(c => c.fn === 'activate_license'));
    const cache = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    check('C6: auth cache stores NO activation_key', !('activation_key' in cache), Object.keys(cache));
    check('cache has user_id + expiry (verify works by id)', !!cache.user_id && !!cache.expires_at);
    check('cache username preserves server case', cache.username === 'testuser');
  }
  {
    rpcHandlers = { activate_license: async () => ({ data: [], error: null }) };
    const res = await auth.activateUser({ username: 'x', activation_key: 'y' });
    check('wrong key → invalid username/key error', res.success === false && /Invalid username or activation key/.test(res.error), res);
  }
  {
    rpcHandlers = { activate_license: async () => ({ data: [ROW({ is_blocked: true })], error: null }) };
    const res = await auth.activateUser({ username: 'x', activation_key: 'y' });
    check('blocked → blocked error', /has been blocked/.test(res.error || ''), res);
  }
  {
    rpcHandlers = { activate_license: async () => ({ data: [ROW({ expires_at: new Date(Date.now() - 86400e3).toISOString() })], error: null }) };
    const res = await auth.activateUser({ username: 'x', activation_key: 'y' });
    check('expired → expired error', /License expired/.test(res.error || ''), res);
  }
  {
    rpcHandlers = { activate_license: async () => ({ data: [ROW({ machine_id: 'OTHER-DEVICE' })], error: null }) };
    const res = await auth.activateUser({ username: 'x', activation_key: 'y' });
    check('device lock still enforced', /already activated on another device/.test(res.error || ''), res);
  }
  {
    rpcHandlers = { activate_license: async () => ({ data: null, error: { message: 'JWT expired' } }) };
    const res = await auth.activateUser({ username: 'x', activation_key: 'y' });
    check('rpc error → network error surfaced', res.success === false && /Network error/.test(res.error), res);
  }

  console.log('— verifyStoredAuth goes through the verify_license RPC —');
  {
    calls = []; rpcHandlers = {
      verify_license: async (p) => {
        check('verify runs by user_id (no key needed — C6 safe)', typeof p.p_id === 'string' && p.p_id.length > 10, p);
        return { data: [ROW({ machine_id: auth.getMachineId(), expires_at: new Date(Date.now() + 90 * 86400e3).toISOString() })], error: null };
      },
    };
    const res = await auth.verifyStoredAuth();
    check('verify succeeds', res.success === true && res.offline === false, res);
    check('NO direct table SELECT anymore', !calls.some(c => c.op === 'from'), calls);
    const cache = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    check('cache refreshed with server expiry (admin extension propagates)', new Date(cache.expires_at) > Date.now() + 80 * 86400e3, cache.expires_at);
    check('C6: refreshed cache also has NO activation_key (legacy key stripped)', !('activation_key' in cache), Object.keys(cache));
  }
  {
    rpcHandlers = { verify_license: async () => ({ data: null, error: { message: 'network down' } }) };
    const res = await auth.verifyStoredAuth();
    check('network error → offline grace mode (unchanged behaviour)', res.success === true && res.offline === true, res);
  }
  {
    rpcHandlers = { verify_license: async () => ({ data: [], error: null }) };
    const res = await auth.verifyStoredAuth();
    check('deleted user → revoked + cache cleared', res.success === false && /revoked/.test(res.error) && !fs.existsSync(authFile()), res);
  }
  {
    await auth.activateUser({ username: 'x', activation_key: 'y' }); // re-create cache (previous test cleared it)
    rpcHandlers = { activate_license: async () => ({ data: [ROW({ machine_id: auth.getMachineId() })], error: null }) };
    await auth.activateUser({ username: 'x', activation_key: 'y' });
    rpcHandlers = { verify_license: async () => ({ data: [ROW({ machine_id: auth.getMachineId(), is_blocked: true })], error: null }) };
    const res = await auth.verifyStoredAuth();
    check('blocked → cache cleared', /blocked/.test(res.error || '') && !fs.existsSync(authFile()), res);
  }
  {
    rpcHandlers = { verify_license: async () => ({ data: [ROW({ machine_id: 'OTHER-DEVICE' })], error: null }) };
    await auth.activateUser({ username: 'x', activation_key: 'y' }); // re-create cache
    rpcHandlers = { activate_license: async () => ({ data: [ROW({ machine_id: auth.getMachineId() })], error: null }) };
    await auth.activateUser({ username: 'x', activation_key: 'y' });
    rpcHandlers = { verify_license: async () => ({ data: [ROW({ machine_id: 'OTHER-DEVICE' })], error: null }) };
    const res = await auth.verifyStoredAuth();
    check('device moved → cache cleared + reactivation needed', /bound to a different device/.test(res.error || '') && !fs.existsSync(authFile()), res);
  }

  console.log('— C4: adminLogin reads admin_config with the ADMIN client —');
  {
    calls = []; rpcHandlers = {};
    const bcrypt = require('/home/user/Bulk-Reels/BulkReelsBot/node_modules/bcryptjs');
    const hash = bcrypt.hashSync('secret123', 10);
    // Switchable admin_config response: the authService (already loaded) holds
    // our fake client factories, so we control what they return from here.
    adminConfigResult = { data: { value: hash }, error: null };
    const res = await auth.adminLogin({ password: 'secret123' });
    check('adminLogin succeeds via admin client', res.success === true, res);
    check('admin_config read used the ADMIN client only', calls.some(c => c.table === 'admin_config') && calls.every(c => c.client === 'admin'), calls);
    const bad = await auth.adminLogin({ password: 'wrong' });
    check('wrong password still rejected', bad.success === false && /Wrong admin password/.test(bad.error), bad);
    check('C4: no ANON read of admin_config anywhere', !calls.some(c => c.client === 'anon' && c.table === 'admin_config'), calls);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
