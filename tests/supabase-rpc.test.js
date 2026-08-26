// Verifies the REAL supabaseClient.rpc() implementation (network shape)
// with a stubbed global.fetch — no actual network calls.
const path = require('path');

let captured = null;
global.fetch = async (url, opts = {}) => {
  captured = { url: String(url), method: opts.method, headers: opts.headers, body: opts.body };
  return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'abc', username: 'u' }]) };
};

const { getAnonClient, getAdminClient } = require('/home/user/Bulk-Reels/BulkReelsBot/src/auth/supabaseClient.js');

let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };

(async () => {
  const anon = getAnonClient();
  const { data, error } = await anon.rpc('activate_license', { p_username: 'u', p_key: 'k', p_machine_id: 'm' });

  check('rpc returns data on success', error === null && Array.isArray(data) && data[0].username === 'u', { data, error });
  check('POSTs to /rest/v1/rpc/<fn>', captured.url.endsWith('/rest/v1/rpc/activate_license'), captured.url);
  check('method = POST', captured.method === 'POST');
  check('named args sent as JSON body', JSON.parse(captured.body).p_username === 'u' && JSON.parse(captured.body).p_machine_id === 'm', captured.body);
  check('uses the anon (publishable) key', captured.headers.apikey.startsWith('sb_publishable_'), captured.headers.apikey);
  check('Authorization bearer = apikey', captured.headers.Authorization === 'Bearer ' + captured.headers.apikey);

  // error path
  global.fetch = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ message: 'function not found' }) });
  const bad = await anon.rpc('nope', {});
  check('PostgREST error → { data:null, error:{message} } shape', bad.data === null && /function not found/.test(bad.error.message), bad);

  // admin client still separate (C3 stopgap intact — admin ops keep working)
  const admin = getAdminClient();
  let adminKeyUsed = null;
  global.fetch = async (url, opts = {}) => { adminKeyUsed = opts.headers.apikey; return { ok: true, status: 200, text: async () => '[]' }; };
  await admin.rpc('refresh_license_seen', { p_id: 'x' });
  check('admin client rpc does NOT use the anon key', adminKeyUsed !== null && !adminKeyUsed.startsWith('sb_publishable_'), adminKeyUsed);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
