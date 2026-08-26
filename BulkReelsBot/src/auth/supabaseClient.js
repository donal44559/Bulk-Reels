// ============================================================
// Supabase REST client for Bulk Reels Upload Pro
//
// We DO NOT use @supabase/supabase-js because it tries to instantiate a
// realtime WebSocket on every createClient() call, which fails inside
// Electron 30's bundled Node.js 20 (no global WebSocket). We only need
// simple REST — so we talk directly to Supabase's PostgREST endpoint
// using fetch, which is available in Electron/Node 20+.
//
// - `anon` requests use the publishable key (safe to ship)
// - `admin` requests use the secret key (XOR-obfuscated in source,
//    decoded only at runtime)
// ============================================================

const SUPABASE_URL     = 'https://tcfpfvzjhguxpdhncnel.supabase.co';
const PUBLISHABLE_KEY  = 'sb_publishable_kPQOVKFTdiV6gNmLkwSJpQ_PzBl77bX';

// XOR-encoded secret key.
const _K = 'BRUP-2026-EusufHasan-Munna-BulkReels-Pro-Automation-Tools-Secret';
const _S = [49,48,10,35,72,81,66,87,66,114,28,88,64,50,5,101,86,24,80,92,79,11,30,32,6,8,96,51,23,0,13,53,58,13,21,1,104,19,26,66,0];
function _decode() {
  let out = '';
  for (let i = 0; i < _S.length; i++) out += String.fromCharCode(_S[i] ^ _K.charCodeAt(i % _K.length));
  return out;
}

const REST = SUPABASE_URL + '/rest/v1';

async function _req(key, method, path, { params, body, prefer } = {}) {
  const url = new URL(REST + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
    }
  }
  const headers = {
    'apikey':        key,
    'Authorization': `Bearer ${key}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg = (data && data.message) || (data && data.error) || res.statusText || 'request failed';
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ---------- Public API ----------
// PostgREST-style query API. Returns { data, error } like supabase-js so
// authService.js can stay largely unchanged.

function _client(key) {
  return {
    from(table) {
      return new QueryBuilder(key, `/${table}`);
    },
  };
}

class QueryBuilder {
  constructor(key, path) {
    this._key = key;
    this._path = path;
    this._params = {};
    this._body = undefined;
    this._method = 'GET';
    this._prefer = null;
    this._single = false;
    this._maybeSingle = false;
  }
  select(cols = '*') { this._params.select = cols; return this; }
  eq(col, val) { this._params[col] = `eq.${val}`; return this; }
  order(col, { ascending = true } = {}) {
    this._params.order = `${col}.${ascending ? 'asc' : 'desc'}`;
    return this;
  }
  limit(n) { this._params.limit = n; return this; }
  single() { this._single = true; return this._exec(); }
  maybeSingle() { this._maybeSingle = true; return this._exec(); }

  insert(obj) {
    this._method = 'POST';
    this._body = Array.isArray(obj) ? obj : [obj];
    this._prefer = 'return=representation';
    return this;
  }
  update(obj) {
    this._method = 'PATCH';
    this._body = obj;
    this._prefer = 'return=representation';
    return this;
  }
  upsert(obj) {
    this._method = 'POST';
    this._body = Array.isArray(obj) ? obj : [obj];
    this._prefer = 'return=representation,resolution=merge-duplicates';
    return this;
  }
  delete() {
    this._method = 'DELETE';
    return this;
  }

  // Await-like: `await qb.select().eq(...)` should work. `then` makes it thenable.
  then(resolve, reject) { return this._exec().then(resolve, reject); }

  async _exec() {
    try {
      const data = await _req(this._key, this._method, this._path, {
        params: this._params,
        body: this._body,
        prefer: this._prefer,
      });
      let out = data;
      if (this._single) {
        if (Array.isArray(data)) {
          if (data.length === 0) return { data: null, error: { message: 'no rows' } };
          out = data[0];
        }
      } else if (this._maybeSingle) {
        if (Array.isArray(data)) out = data.length ? data[0] : null;
      }
      return { data: out, error: null };
    } catch (e) {
      return { data: null, error: { message: e.message, status: e.status } };
    }
  }
}

let _anonClient = null;
let _adminClient = null;

function getAnonClient() {
  if (!_anonClient) _anonClient = _client(PUBLISHABLE_KEY);
  return _anonClient;
}
function getAdminClient() {
  if (!_adminClient) _adminClient = _client(_decode());
  return _adminClient;
}

module.exports = { getAnonClient, getAdminClient, SUPABASE_URL };
