// src/bot.js — Playwright browser control + task engine
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  getSettings, updateProfileStatus, markUsed, DB_PATH,
} = require('./database.js');

// Shared data folder (same one that holds the sqlite DB)
const DATA_DIR = path.dirname(DB_PATH);
const MATCHED_REELS_FILE = path.join(DATA_DIR, 'matched_reels.txt');

// ---------- Cookie helpers ----------
/**
 * Parse a Facebook cookie string like:
 *   "c_user=1234; xs=abc%3A...; datr=xyz; sb=..."
 * OR JSON array of {name,value,domain,...}
 * Returns Playwright cookie objects for facebook.com
 */
function normalizeSameSite(v) {
  if (!v) return 'Lax';
  const s = String(v).toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return 'None';
  if (s === 'lax') return 'Lax';
  return 'Lax';
}

function parseCookies(input) {
  if (!input) return [];
  const raw = String(input).trim();
  if (!raw) return [];

  // Try JSON first
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const arr = JSON.parse(raw);
      const list = Array.isArray(arr) ? arr : [arr];
      return list.map(c => {
        const cookie = {
          name: c.name,
          value: String(c.value == null ? '' : c.value),
          domain: c.domain || '.facebook.com',
          path: c.path || '/',
          httpOnly: !!c.httpOnly,
          secure: c.secure !== false,
          sameSite: normalizeSameSite(c.sameSite),
        };
        // Only include expires if it's a valid number in the future/past
        if (typeof c.expires === 'number' && isFinite(c.expires) && c.expires > 0) {
          cookie.expires = c.expires;
        } else if (typeof c.expirationDate === 'number' && isFinite(c.expirationDate) && c.expirationDate > 0) {
          cookie.expires = c.expirationDate;
        }
        return cookie;
      }).filter(c => c.name && c.value);
    } catch (_) { /* fall through */ }
  }

  // Semicolon-separated "name=value; name=value" string
  const cookies = [];
  const parts = raw.split(/;\s*/);
  for (const p of parts) {
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq < 1) continue;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (!name || !value) continue;
    cookies.push({
      name,
      value,
      domain: '.facebook.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    });
  }
  return cookies;
}

/**
 * Real Facebook Account Status checker.
 * Follows the user-specified flow:
 *   1. Load home (session must already exist via cookies/password login)
 *   2. Do 2-3 human-like scrolls to avoid bot detection
 *   3. Open https://www.facebook.com/profile.php?id=<UID>
 *   4. Scroll a bit
 *   5. Open https://www.facebook.com/profile_status/?referrer=profile_settings   (for personal ID)
 *      OR https://www.facebook.com/settings/?tab=profile_quality&show_dialog=0&ref=account_status&referrer=profile_settings (for page)
 *   6. Parse the "Recommendations" / "Account status" row.
 *      Facebook shows one of: Active / Limited / Suspended / At Risk / (No restrictions)
 *
 * Returns { status, raw, url }
 *   status: 'Active' | 'Limited' | 'Suspended' | 'At Risk' | 'No restrictions' | 'Unknown'
 */
async function humanScroll(page, times = 3) {
  for (let i = 0; i < times; i++) {
    try {
      await page.mouse.wheel(0, 600 + Math.floor(Math.random() * 500));
    } catch (_) {
      try { await page.evaluate((y) => window.scrollBy(0, y), 700 + Math.floor(Math.random() * 400)); } catch (_) {}
    }
    await page.waitForTimeout(700 + Math.floor(Math.random() * 700));
  }
}

/**
 * Dismiss any Facebook popup/dialog blocking the page.
 * Handles "What happened", "We added restrictions", cookie banners,
 * "Turn on notifications", "Log in with one tap", etc.
 * Returns the number of popups closed.
 */
async function dismissFacebookPopups(page, log = () => {}) {
  let closed = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    let didClose = false;

    // Is there actually a dialog?
    let dialogHandle = null;
    try {
      const loc = page.locator('[role="dialog"], [aria-modal="true"]').first();
      const visible = await loc.isVisible({ timeout: 400 }).catch(() => false);
      if (visible) dialogHandle = loc;
    } catch (_) {}

    if (!dialogHandle) break;

    // 1) Try 8 different close-button selectors within the dialog
    const closeSelectors = [
      '[role="dialog"] [aria-label="Close"]',
      '[role="dialog"] div[aria-label="Close"][role="button"]',
      '[role="dialog"] div[aria-label="Close"]',
      '[aria-modal="true"] [aria-label="Close"]',
      '[role="dialog"] [aria-label*="Close" i]',
      '[role="dialog"] svg[aria-label="Close"]',
      'div[aria-label="Close"][role="button"]',
      '[role="dialog"] button[aria-label*="Close" i]',
    ];
    for (const sel of closeSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
          await el.click({ timeout: 2000, force: true }).catch(() => {});
          await page.waitForTimeout(600);
          didClose = !(await page.locator('[role="dialog"], [aria-modal="true"]').first().isVisible({ timeout: 300 }).catch(() => false));
          if (didClose) break;
        }
      } catch (_) {}
    }

    // 2) Buttons: "Not now", "Cancel", "Skip", "Maybe later", "Dismiss"
    if (!didClose) {
      const buttonTexts = ['Not now', 'Not Now', 'Cancel', 'Skip', 'Skip for now', 'Maybe later', 'Dismiss', 'No thanks', 'Close', 'OK', 'Got it', 'I understand'];
      for (const bt of buttonTexts) {
        try {
          const btn = page.getByRole('button', { name: new RegExp('^' + bt + '$', 'i') }).first();
          if (await btn.isVisible({ timeout: 250 }).catch(() => false)) {
            await btn.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(500);
            didClose = !(await page.locator('[role="dialog"], [aria-modal="true"]').first().isVisible({ timeout: 300 }).catch(() => false));
            if (didClose) break;
          }
        } catch (_) {}
      }
    }

    // 3) Escape key
    if (!didClose) {
      try {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        didClose = !(await page.locator('[role="dialog"], [aria-modal="true"]').first().isVisible({ timeout: 300 }).catch(() => false));
      } catch (_) {}
    }

    // 4) Coordinate-based click on the dialog's top-right corner (X is usually there)
    if (!didClose) {
      try {
        const box = await dialogHandle.boundingBox().catch(() => null);
        if (box) {
          // Click 22px in from top-right corner
          const cx = box.x + box.width - 22;
          const cy = box.y + 22;
          await page.mouse.click(cx, cy).catch(() => {});
          await page.waitForTimeout(600);
          didClose = !(await page.locator('[role="dialog"], [aria-modal="true"]').first().isVisible({ timeout: 300 }).catch(() => false));
        }
      } catch (_) {}
    }

    // 5) Cookie banner (usually not a dialog but a bar) — allow essential
    if (!didClose) {
      try {
        const cookieBtn = page.getByRole('button', { name: /allow (all )?cookies?|only allow essential|accept/i }).first();
        if (await cookieBtn.isVisible({ timeout: 250 }).catch(() => false)) {
          await cookieBtn.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(500);
          didClose = true;
        }
      } catch (_) {}
    }

    // 6) DOM-remove nuclear option — Facebook dialogs are usually removable safely
    if (!didClose) {
      try {
        const removed = await page.evaluate(() => {
          const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
          let n = 0;
          dialogs.forEach(d => { try { d.remove(); n++; } catch (_) {} });
          // Also remove any dimmer/overlay backdrop that traps clicks
          document.querySelectorAll('div[data-visualcompletion="ignore"]').forEach(d => {
            const s = getComputedStyle(d);
            if (s.position === 'fixed' && parseFloat(s.zIndex || '0') > 100) { try { d.remove(); } catch (_) {} }
          });
          document.body.style.overflow = 'auto';
          return n;
        }).catch(() => 0);
        if (removed > 0) { didClose = true; log(`  · force-removed ${removed} stuck dialog(s)`); }
      } catch (_) {}
    }

    if (didClose) {
      closed++;
      log(`  · dismissed a popup (attempt ${attempt + 1})`);
      await page.waitForTimeout(500);
    } else {
      break;
    }
  }
  return closed;
}


async function checkFacebookAccountStatus(context, page, profile, log = () => {}) {
  const uid = String(profile.uid || '').trim();
  if (!uid) throw new Error('profile.uid required');

  // 1) Home page (should be logged in already from loginProfile)
  log('  · loading facebook.com home');
  await page.goto('https://www.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);
  await dismissFacebookPopups(page, log);

  // Verify session with c_user cookie
  const cookies = await context.cookies(['https://www.facebook.com', 'https://facebook.com']);
  const cUser = cookies.find(c => c.name === 'c_user' && c.value && c.value !== '0');
  if (!cUser) {
    log('  · no c_user cookie → session invalid');
    return { status: 'Login Failed', raw: '', url: page.url() };
  }

  // 2) Scroll a few times (bot avoidance) — dismiss popups between scrolls
  log('  · scrolling home feed (avoid bot detection)');
  await humanScroll(page, 3);
  await dismissFacebookPopups(page, log);

  // 3) Open own profile page
  const profileUrl = `https://www.facebook.com/profile.php?id=${encodeURIComponent(uid)}`;
  log('  · opening ' + profileUrl);
  await page.goto(profileUrl, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);
  await dismissFacebookPopups(page, log);

  // 4) Scroll on profile too
  await humanScroll(page, 2);
  await dismissFacebookPopups(page, log);

  // 5) Open the profile status page (personal ID ONLY — not pages)
  const statusUrl = 'https://www.facebook.com/profile_status/?referrer=profile_settings';
  log('  · opening ' + statusUrl);
  await page.goto(statusUrl, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
  // Wait for the status card to actually render (React SPA)
  await page.waitForTimeout(5000);
  await dismissFacebookPopups(page, log);
  try {
    await page.waitForFunction(() => {
      const t = (document.body && document.body.innerText || '').toLowerCase();
      return t.includes('account status') ||
             t.includes('recommendation') ||
             t.includes('no restriction') ||
             t.includes('at risk') ||
             t.includes('suspend') ||
             t.includes('limited');
    }, { timeout: 15000 });
  } catch (_) {
    log('  · status page didn\'t render expected keywords within 15s');
  }
  await humanScroll(page, 1);
  await page.waitForTimeout(1500);

  // 6) Parse — collect ALL relevant text blocks + the "Recommendations" row specifically
  let bodyText = '';
  try {
    bodyText = await page.evaluate(() => (document.body?.innerText || '').trim());
  } catch (_) {}

  // ============================================================
  //  PRECISE PARSING — Facebook's Profile Status page has 3 rows:
  //     Account status:    "No restrictions" | "Restricted" | ...
  //     Recommendations:   "Active" | "Limited" | "At Risk" | "Suspended"
  //     Monetization:      "Active" | "Not eligible" | "Limited" | "Suspended"
  //     Marketplace:       "Active" | ...
  //  We ONLY care about Recommendations for profile status.
  // ============================================================
  let recommendations = null;
  let accountStatus = null;
  let monetization = null;

  // Strategy 1: line-based scan of the whole body text
  // FB renders each row as multi-line text:  "Recommendations\n<status>\n<description>"
  try {
    const rawLines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      // Find "Recommendations" as its own line
      if (/^Recommendations$/i.test(line) && i + 1 < rawLines.length) {
        const nextLine = rawLines[i + 1];
        // Only take it if next line looks like a status keyword
        if (/^(Active|Limited|At Risk|Suspended|Not eligible)$/i.test(nextLine)) {
          recommendations = nextLine;
        }
      }
      if (/^(Account status)$/i.test(line) && i + 1 < rawLines.length) {
        const nextLine = rawLines[i + 1];
        if (/^(No restrictions|Restricted|Limited|At Risk|Suspended)$/i.test(nextLine)) {
          accountStatus = nextLine;
        } else if (/looks good/i.test(nextLine)) {
          accountStatus = 'No restrictions';
        }
      }
      if (/^Monetization$/i.test(line) && i + 1 < rawLines.length) {
        const nextLine = rawLines[i + 1];
        if (/^(Active|Not eligible|Limited|At Risk|Suspended)$/i.test(nextLine)) {
          monetization = nextLine;
        }
      }
    }
  } catch (_) {}

  // Strategy 2: DOM traversal — find <span>Recommendations</span> and read siblings
  if (!recommendations) {
    try {
      recommendations = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let el;
        while ((el = walker.nextNode())) {
          const own = (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3)
            ? el.childNodes[0].textContent.trim() : '';
          if (own === 'Recommendations') {
            // Read the whole row block (walk up 4 parents and split by lines)
            let row = el;
            for (let i = 0; i < 5 && row.parentElement; i++) {
              row = row.parentElement;
              const rowLines = (row.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
              const idx = rowLines.findIndex(l => l === 'Recommendations');
              if (idx >= 0 && rowLines[idx + 1] && /^(Active|Limited|At Risk|Suspended|Not eligible)$/i.test(rowLines[idx + 1])) {
                return rowLines[idx + 1];
              }
            }
          }
        }
        return null;
      });
    } catch (_) {}
  }

  // Strategy 3: fallback — if page contains explicit phrase "Recommendations suspended" etc.
  if (!recommendations) {
    const lower = bodyText.toLowerCase();
    if (/recommendations?\s+(are\s+)?suspended/.test(lower))     recommendations = 'Suspended';
    else if (/recommendations?\s+(are\s+)?limited/.test(lower))  recommendations = 'Limited';
    else if (/recommendations?\s+(are\s+)?at\s+risk/.test(lower))recommendations = 'At Risk';
  }

  // Decide final status — Recommendations is the primary source of truth
  const decideFromValue = (txt) => {
    if (!txt) return null;
    const t = txt.trim().toLowerCase();
    if (t === 'suspended')      return 'Suspended';
    if (t === 'at risk')        return 'At Risk';
    if (t === 'limited')        return 'Limited';
    if (t === 'active')         return 'Active';
    if (t === 'no restrictions')return 'No restrictions';
    if (t === 'not eligible')   return 'Unknown';   // treat as unknown for profile
    return null;
  };

  let status = decideFromValue(recommendations)
            || decideFromValue(accountStatus)
            || 'Unknown';

  // Safety: even if we picked "Active" from Recommendations, if Account Status says
  // "Restricted" then honour the more restrictive one.
  if (accountStatus) {
    const acc = decideFromValue(accountStatus);
    const rank = { 'Suspended': 5, 'At Risk': 4, 'Limited': 3, 'No restrictions': 1, 'Active': 1, 'Unknown': 0 };
    if (acc && (rank[acc] || 0) > (rank[status] || 0)) status = acc;
  }

  log(`  · parsed → Recommendations="${recommendations || 'n/a'}"`
      + ` · AccountStatus="${accountStatus || 'n/a'}"`
      + ` · Monetization="${monetization || 'n/a'}"`
      + ` → status="${status}"`);

  return {
    status,
    raw: bodyText.slice(0, 1200),
    recommendations,
    accountStatus,
    monetization,
    url: page.url(),
  };
}

/**
 * Detects real Facebook login/session state after navigation.
 * Uses multiple signals — much more reliable than just URL matching.
 * Returns { status, indicators }
 *   status: 'No restrictions' | 'Restricted' | 'Checkpoint' | 'Login Failed' | 'Unknown'
 */
async function detectFacebookState(context, page) {
  const indicators = [];
  const url = page.url() || '';
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();

  // 1) Check the c_user cookie — this is the strongest logged-in signal
  let cUser = '';
  try {
    const cookies = await context.cookies(['https://www.facebook.com', 'https://facebook.com', 'https://m.facebook.com']);
    const c = cookies.find(x => x.name === 'c_user' && x.value && x.value !== '0');
    if (c) { cUser = c.value; indicators.push('c_user cookie present: ' + c.value.slice(0, 6) + '…'); }
    else indicators.push('no c_user cookie');
  } catch (e) { indicators.push('cookie read error'); }

  // 2) URL patterns
  const isCheckpointUrl = /\/checkpoint(\/|\?)/i.test(url) || /\/security\/checkup/i.test(url);
  const isLoginUrl = /\/login(\/|\.php|\?|$)/i.test(url) || /\/recover\//i.test(url);
  if (isCheckpointUrl) indicators.push('URL is /checkpoint');
  if (isLoginUrl) indicators.push('URL is /login');

  // 3) DOM signals — check for login form vs. logged-in shell
  let hasLoginForm = false, hasFeedShell = false, restrictedBanner = false, checkpointHeading = false;
  try {
    hasLoginForm = await page.locator('input[name="email"], input#email, input[name="pass"]').first().isVisible({ timeout: 1500 }).catch(() => false);
  } catch (_) {}
  try {
    // Logged-in Facebook shows the composer / news feed / nav bar with role="navigation"
    hasFeedShell = await page.locator('[role="navigation"], [aria-label="Facebook"], div[role="feed"], [aria-label="Create a post"], [aria-label="What\'s on your mind"]').first().isVisible({ timeout: 1500 }).catch(() => false);
  } catch (_) {}
  try {
    const html = (await page.content()).toLowerCase();
    if (/(your account|you)( is| are) restricted/i.test(html) ||
        /account restriction/i.test(html) ||
        /we suspended/i.test(html) ||
        /you can't post|you cannot post/i.test(html)) restrictedBanner = true;
    if (/enter (the )?(login )?code/i.test(html) ||
        /confirm (it'?s|it is) you/i.test(html) ||
        /security check(point| required)/i.test(html) ||
        /identity confirmation/i.test(html) ||
        /upload.*(id|photo).*to confirm/i.test(html)) checkpointHeading = true;
  } catch (_) {}

  if (hasLoginForm)      indicators.push('login form visible');
  if (hasFeedShell)      indicators.push('feed / nav shell visible');
  if (restrictedBanner)  indicators.push('restricted banner in DOM');
  if (checkpointHeading) indicators.push('checkpoint heading in DOM');

  // 4) Decision tree — priority: real DOM signals > URL > cookies
  let status = 'Unknown';
  if (isCheckpointUrl || checkpointHeading) status = 'Checkpoint';
  else if (restrictedBanner)                status = 'Restricted';
  else if (hasFeedShell && cUser)           status = 'No restrictions';
  else if (cUser && !hasLoginForm)          status = 'No restrictions';
  else if (isLoginUrl || hasLoginForm)      status = 'Login Failed';
  else if (cUser)                            status = 'No restrictions';
  else                                       status = 'Unknown';

  return { status, indicators, url, host, cUser };
}

// ============================================================
// Auto Re-Login Watcher
// Attach to a live browser context. Whenever ANY page in it lands on
// /login or /checkpoint (i.e. FB kicked us out and asked to log in again),
// automatically try cookies-first, then password.
// Also handles the "remembered user" prefilled-password page (login/?next=...).
// ============================================================
function attachAutoLoginWatcher(context, profile, log = () => {}) {
  if (!context || context._autoLoginAttached) return;
  context._autoLoginAttached = true;
  const state = { retries: 0, busy: false, lastAt: 0 };
  const MAX_RETRIES = 3;
  const COOLDOWN_MS = 8000;

  const tryRecover = async (page) => {
    if (state.busy) return;
    const now = Date.now();
    if (now - state.lastAt < COOLDOWN_MS) return;
    if (state.retries >= MAX_RETRIES) return;
    state.busy = true;
    state.lastAt = now;
    state.retries++;

    try {
      const url = (page.url() || '').toLowerCase();
      if (!url.includes('/login') && !url.includes('login.php') && !url.includes('/checkpoint')) {
        state.busy = false;
        state.retries--;
        return;
      }
      if (url.includes('/checkpoint')) {
        log(`  ⚠ ${profile.name} hit checkpoint — cannot auto-recover, human action needed`);
        state.busy = false;
        return;
      }

      log(`  🔄 ${profile.name} was logged out — auto re-login attempt ${state.retries}/${MAX_RETRIES}`);

      // STEP 1: Re-inject cookies and reload
      const cookieList = parseCookies(profile.cookies);
      if (cookieList.length) {
        try {
          await context.addCookies(cookieList);
          log(`     ↳ re-injected ${cookieList.length} cookies`);
          await page.goto('https://www.facebook.com/', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
          await page.waitForTimeout(3000);
          const ctxCookies = await context.cookies('https://www.facebook.com');
          const hasCUser = ctxCookies.some(c => c.name === 'c_user' && c.value && c.value.length > 3);
          const newUrl = (page.url() || '').toLowerCase();
          if (hasCUser && !newUrl.includes('/login')) {
            log(`     ✓ ${profile.name} recovered via cookies`);
            state.retries = 0; // reset on success
            state.busy = false;
            return;
          }
          log(`     ✗ cookies did not recover session`);
        } catch (e) {
          log(`     ✗ cookie re-inject failed: ${e.message}`);
        }
      }

      // STEP 2: Password login fallback
      if (profile.uid && profile.password) {
        try {
          log(`     ↳ trying password login for UID ${profile.uid}`);
          const curUrl = page.url();
          if (!/facebook\.com\/(login|checkpoint)/i.test(curUrl)) {
            await page.goto('https://www.facebook.com/login', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
          }
          await page.waitForTimeout(1500);

          // "Remembered user" page has NO email field — password only. Handle both.
          const emailInput = await page.$('input[name="email"], input#email');
          if (emailInput) {
            await emailInput.fill('').catch(() => {});
            await emailInput.type(String(profile.uid), { delay: 50 }).catch(() => {});
          }
          const passInput = await page.$('input[name="pass"], input#pass');
          if (passInput) {
            await passInput.fill('').catch(() => {});
            await passInput.type(String(profile.password), { delay: 50 }).catch(() => {});
          } else {
            log(`     ✗ no password field found on page`);
            state.busy = false;
            return;
          }

          await Promise.race([
            page.click('button[name="login"], button#loginbutton, button[type="submit"]', { timeout: 10000 }).catch(() => {}),
            page.press('input[name="pass"], input#pass', 'Enter').catch(() => {}),
          ]);
          await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
          await page.waitForTimeout(4000);

          const ctxCookies = await context.cookies('https://www.facebook.com');
          const hasCUser = ctxCookies.some(c => c.name === 'c_user' && c.value && c.value.length > 3);
          const finalUrl = (page.url() || '').toLowerCase();
          if (hasCUser && !finalUrl.includes('/login')) {
            log(`     ✓ ${profile.name} recovered via password login`);
            // Save fresh cookies back to DB so next time we don't need password
            try {
              const freshCookies = JSON.stringify(ctxCookies);
              await updateProfileStatus(profile.uid, { cookies: freshCookies }).catch(() => {});
              log(`     ↳ fresh cookies saved to DB`);
            } catch {}
            state.retries = 0;
          } else if (finalUrl.includes('/checkpoint')) {
            log(`     ⚠ password login hit checkpoint — human action needed`);
          } else {
            log(`     ✗ password login failed (url=${finalUrl})`);
          }
        } catch (e) {
          log(`     ✗ password login error: ${e.message}`);
        }
      } else {
        log(`     ⚠ no password saved for ${profile.name} — cannot auto-recover`);
      }
    } finally {
      state.busy = false;
    }
  };

  // Listen on every page in the context (existing + future pages)
  const wire = (page) => {
    if (page._autoLoginWired) return;
    page._autoLoginWired = true;
    // Debounced framenavigated → checks for login redirect
    page.on('framenavigated', async (frame) => {
      try {
        if (frame !== page.mainFrame()) return;
        const url = (frame.url() || '').toLowerCase();
        if (url.includes('/login') || url.includes('login.php') || url.includes('/checkpoint')) {
          // Give FB a moment to fully render before we try
          setTimeout(() => tryRecover(page).catch(() => {}), 1500);
        }
      } catch {}
    });
  };
  context.pages().forEach(wire);
  context.on('page', wire);
  log(`  🛡  auto re-login watcher armed for ${profile.name}`);
}

async function loginProfile(context, page, profile, log = () => {}) {
  const cookieList = parseCookies(profile.cookies);

  // 1) Cookie login
  if (cookieList.length) {
    try {
      await context.addCookies(cookieList);
      log(`  ↳ injected ${cookieList.length} cookies for ${profile.name}`);
      await page.goto('https://www.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500); // give SPA time to render
      await dismissFacebookPopups(page, log);

      // CRITICAL: verify cookies actually took effect by re-reading them from the context.
      // If c_user is present in the browser context AND the URL isn't /login, cookies WORK.
      // Do NOT fall back to password unless cookies genuinely failed — falling back
      // to password on a "cookie-valid but weird-DOM" account causes FB to show a
      // "remembered user" password prompt, which is what suspends accounts.
      const ctxCookies = await context.cookies('https://www.facebook.com');
      const hasCUserCookie = ctxCookies.some(c => c.name === 'c_user' && c.value && c.value.length > 3);
      const currentUrl = (page.url() || '').toLowerCase();
      const onLoginPage = currentUrl.includes('/login') || currentUrl.includes('login.php');
      const onCheckpointPage = currentUrl.includes('/checkpoint');

      if (onCheckpointPage) {
        log('  ↳ cookies landed on checkpoint — account restricted, NOT trying password');
        return { loggedIn: false, method: 'cookies', status: 'Checkpoint' };
      }

      if (hasCUserCookie && !onLoginPage) {
        // Cookies are alive. Trust them. Even if detectFacebookState is confused
        // by DOM changes, c_user cookie surviving a page load means logged in.
        const state = await detectFacebookState(context, page);
        log(`  ↳ cookie login OK → status: ${state.status} [${state.indicators.join(' · ')}]`);
        if (state.status === 'Restricted') return { loggedIn: true, method: 'cookies', status: 'Restricted' };
        return { loggedIn: true, method: 'cookies', status: state.status === 'No restrictions' ? 'No restrictions' : 'No restrictions' };
      }

      // Genuinely failed: no c_user cookie survived, OR bounced to /login
      log(`  ↳ cookies did NOT work (c_user=${hasCUserCookie}, url=${currentUrl}) — skipping password fallback to protect account`);
      return { loggedIn: false, method: 'cookies', status: 'Login Failed' };
    } catch (e) {
      log('  ↳ cookie inject failed: ' + e.message);
      return { loggedIn: false, method: 'cookies', status: 'Login Failed' };
    }
  }

  // 2) Password login — ONLY when no cookies at all were provided
  if (profile.uid && profile.password) {
    try {
      await page.goto('https://www.facebook.com/login', { timeout: 45000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await page.fill('input#email, input[name="email"]', String(profile.uid), { timeout: 15000 }).catch(() => {});
      await page.fill('input#pass, input[name="pass"]',  String(profile.password), { timeout: 15000 }).catch(() => {});
      await Promise.race([
        page.click('button[name="login"], button#loginbutton, button[type="submit"]', { timeout: 15000 }).catch(() => {}),
        page.press('input[name="pass"], input#pass', 'Enter').catch(() => {}),
      ]);
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(4000);
      await dismissFacebookPopups(page, log);
      const state = await detectFacebookState(context, page);
      log(`  ↳ password login → ${state.status} [${state.indicators.join(' · ')}]`);
      if (state.status === 'No restrictions') return { loggedIn: true,  method: 'password', status: 'No restrictions' };
      if (state.status === 'Checkpoint')     return { loggedIn: false, method: 'password', status: 'Checkpoint' };
      if (state.status === 'Restricted')     return { loggedIn: true,  method: 'password', status: 'Restricted' };
      return { loggedIn: false, method: 'password', status: state.status || 'Login Failed' };
    } catch (e) {
      log('  ↳ password login failed: ' + e.message);
      return { loggedIn: false, method: 'password', status: 'Login Failed' };
    }
  }

  return { loggedIn: false, method: 'none', status: 'Unknown' };
}

const TASK_TYPES = [
  'Check Profiles Status',
  'Check Page Status',
  'Auto Upload Reels',
  'Auto Page Creation',
  'Page Create & Reels',
  'Auto Interaction',
  'Auto Upload Story',
  'Story and Reels Upload',
  'Auto Join Groups',
  'Auto Post to Groups',
  'Auto Comments (Random)',
  'Auto Comments (Targeted)',
];

const openContexts = new Map();   // uid -> BrowserContext
const logListeners = new Set();
const taskListeners = new Set();

// Active browser contexts tracked so Stop can kill them instantly
// (closing a context makes all pending Playwright ops throw → task loop exits)
const activeContexts = new Set();

const taskState = {
  running: false,
  paused: false,
  stopRequested: false,
  totalActive: 0,
  remaining: 0,
  success: 0,
  failed: 0,
  taskName: '',
  currentInfo: '',   // free-form status (e.g. "Targeted Reels Found: 4/10")
  results: [],       // last 10
  workers: {},       // { [wid]: { workerId, profileUid, profileName, status, currentInfo, startedAt, updatedAt } }
};

function onLog(cb) { logListeners.add(cb); return () => logListeners.delete(cb); }
function onTaskUpdate(cb) { taskListeners.add(cb); return () => taskListeners.delete(cb); }

function log(line) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const msg = `[${ts}] ${line}`;
  for (const cb of logListeners) { try { cb(msg); } catch (_) {} }
}
function emitTask() {
  const snap = {
    ...taskState,
    results: taskState.results.slice(-10),
    workers: { ...(taskState.workers || {}) },
  };
  for (const cb of taskListeners) { try { cb(snap); } catch (_) {} }
}

function parseProxy(s) {
  if (!s || !s.trim()) return undefined;
  s = s.trim();
  try {
    if (s.includes('://')) {
      const u = new URL(s);
      return {
        server: `${u.protocol}//${u.host}`,
        username: decodeURIComponent(u.username || '') || undefined,
        password: decodeURIComponent(u.password || '') || undefined,
      };
    }
    const parts = s.split(':');
    if (parts.length === 2) return { server: `http://${parts[0]}:${parts[1]}` };
    if (parts.length === 4) return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
  } catch (_) {}
  return undefined;
}

// ============================================================
// Browser engine — always the app-managed Chromium (chromium-1217).
//
// This app pins Playwright 1.59.0, which downloads Chromium revision
// chromium-1217 (Chrome for Testing 147.0.7727.15). Unlike the older
// Playwright Chromium that 1.45 shipped, this build includes the H.264/AAC
// media codecs, which is required for Facebook/Reels video to play at all
// ("Sorry, we're having trouble playing this video" was the old codec-less
// build). We explicitly pin channel:'chromium' so Playwright always uses this
// exact bundled revision and never falls back to another browser on the PC.
// ============================================================
async function ensureWindowOnScreen(context, page) {
  // Best-effort: move a HEADED browser window back inside the visible display
  // if it opened off-screen (Chromium/Windows cascades parallel launches off the
  // screen, and persistent profiles can restore an old off-screen position).
  // Done via the DevTools protocol AFTER launch — we deliberately do NOT add
  // --window-position/--window-size/--start-maximized launch flags here, because
  // adding those flags previously caused Chromium to open its window minimized /
  // offscreen / not at all. Headless browsers have no OS window → skipped.
  // Never throws: if anything fails the launch result is untouched.
  try {
    if (!context || !page || typeof context.newCDPSession !== 'function') return;
    const session = await context.newCDPSession(page);
    try {
      const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
      if (!windowId || !bounds) return;
      // Visible work area of the display the window belongs to (fallback: primary)
      const area = await page.evaluate(() => {
        const s = (typeof window !== 'undefined' && window.screen) || {};
        return {
          left: typeof s.availLeft === 'number' ? s.availLeft : 0,
          top: typeof s.availTop === 'number' ? s.availTop : 0,
          width: s.availWidth || s.width || 1280,
          height: s.availHeight || s.height || 800,
        };
      });
      const w = bounds.width > 0 ? bounds.width : 400;
      const h = bounds.height > 0 ? bounds.height : 300;
      // Window must sit FULLY inside the visible work area (partially cut-off
      // windows count as "opened outside the display" too)
      const fullyVisible =
        bounds.left >= area.left &&
        bounds.top >= area.top &&
        bounds.left + w <= area.left + area.width &&
        bounds.top + h <= area.top + area.height;
      const minimized = bounds.windowState === 'minimized';
      // Already fully visible and not minimized → leave the window exactly as-is
      if (fullyVisible && !minimized) return;
      // Smallest translation that puts the whole window inside the work area
      const maxLeft = area.left + Math.max(0, area.width - w);
      const maxTop = area.top + Math.max(0, area.height - h);
      const left = Math.min(Math.max(bounds.left, area.left), maxLeft);
      const top = Math.min(Math.max(bounds.top, area.top), maxTop);
      if (bounds.windowState === 'minimized' || bounds.windowState === 'maximized') {
        // bounds can only be set while the window state is 'normal'
        await session.send('Browser.setWindowBounds', { windowId, windowState: 'normal' });
      }
      await session.send('Browser.setWindowBounds', { windowId, bounds: { left, top } });
    } finally {
      try { await session.detach(); } catch (_) {}
    }
  } catch (_) { /* best-effort — a failed reposition must never break a launch */ }
}

async function launchForProfile(profile, headless) {
  // CRITICAL: For the manual "Open" path (headless:false) this MUST match the
  // original options that provably opened a VISIBLE Chromium window. Any extra
  // flag we added (bare channel, chromiumSandbox, ignoreDefaultArgs, window-size,
  // start-maximized) caused Chromium to open its window MINIMIZED / OFFSCREEN or
  // not at all — "Opening..." then "already open — focused window" but nothing
  // visible on the display. So the headed path keeps ONLY the original, proven
  // options.
  const opts = {
    headless: !!headless,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    args: ['--no-default-browser-check'],
  };
  // channel:'chromium' is required ONLY for HEADLESS runs: Playwright 1.57+ new
  // headless mode needs it to use the bundled chromium-1217 instead of a separate
  // chromium-headless-shell binary (without it headless launches fail and imported
  // accounts get marked Dead). For headed launches we do NOT set a channel — that
  // alone caused the invisible-window bug. Playwright 1.59's default managed
  // chromium (chromium-1217) already carries the H.264/AAC codecs, so Reels play
  // without any channel/flag tweaks.
  if (headless) opts.channel = 'chromium';
  const proxy = parseProxy(profile.proxy);
  if (proxy) opts.proxy = proxy;

  const context = await chromium.launchPersistentContext(profile.user_data_dir, opts);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  if (!headless) {
    // Guarantee the OS window sits INSIDE the visible display (a persistent
    // profile can restore a saved off-screen position, and parallel headed
    // launches can be cascaded off-screen by the OS). Launch options above
    // stay exactly the proven set — the reposition happens post-launch.
    const firstPage = context.pages()[0];
    if (firstPage) await ensureWindowOnScreen(context, firstPage);
  }
  return context;
}

async function openProfile(profile) {
  // If a context is remembered, verify it's actually alive.
  // Persistent contexts don't always fire 'close' when the user shuts the browser
  // window, so we defensively probe them and free the slot if dead.
  if (openContexts.has(profile.uid)) {
    const existing = openContexts.get(profile.uid);
    let alive = false;
    try {
      // browser() returns the underlying Browser; isConnected() tells us if it's alive
      const b = existing.browser && existing.browser();
      if (b && typeof b.isConnected === 'function') {
        alive = b.isConnected();
      } else {
        // Fallback: try listing pages — throws if context is closed
        existing.pages();
        alive = true;
      }
    } catch (_) { alive = false; }
    if (alive) {
      // Try to focus the first page so the user actually sees the window on their
      // display (fixes "already open — focused window" but nothing visible).
      try {
        const pg = existing.pages()[0];
        if (pg) await pg.bringToFront();
      } catch (_) {}
      return { success: true, message: 'Already open' };
    }
    // Stale entry — clean up and fall through to a fresh launch
    log(`  · stale context for ${profile.name} — cleaning up and reopening`);
    try { await existing.close(); } catch (_) {}
    openContexts.delete(profile.uid);
  }
  try {
    log(`Opening profile ${profile.name} (${profile.uid})...`);
    const context = await launchForProfile(profile, false);

    // Register 'close' listener + track the context IMMEDIATELY so we never
    // orphan a live browser when errors happen later in this function.
    openContexts.set(profile.uid, context);
    const cleanup = () => openContexts.delete(profile.uid);
    context.on('close', cleanup);
    // Also listen on the underlying browser (persistent contexts sometimes only
    // fire disconnect on the Browser, not the Context, when the window closes).
    try {
      const br = context.browser && context.browser();
      if (br) br.on('disconnected', cleanup);
    } catch (_) {}

    const page = context.pages()[0] || await context.newPage();

    // Make sure the manually-opened browser window comes to the foreground so
    // the user actually sees it on their display (not hidden behind the app or
    // offscreen). Safe no-op if the window is already focused.
    try { await page.bringToFront(); } catch (_) {}

    // Attempt auto-login (cookies first, then password)
    const res = await loginProfile(context, page, profile, log);

    // After login, re-detect state — but ONLY update DB if we got a definitive signal.
    // The Open button must NEVER overwrite a previously-checked status with 'Unknown',
    // because "Check Profiles Status" / "Check Page Status" tasks are the source of truth.
    const state = await detectFacebookState(context, page);
    let profile_status = null;
    if (state.status === 'Checkpoint' || state.status === 'Restricted') profile_status = 'Restricted';
    else if (state.status === 'Login Failed') profile_status = 'Login Failed';

    const patch = {};
    if (profile_status) patch.profile_status = profile_status;
    if (state.status === 'Checkpoint') patch.page_status = 'Checkpoint';
    if (Object.keys(patch).length) {
      await updateProfileStatus(profile.uid, patch).catch(() => {});
    }
    log(`  ✓ opened ${profile.name}${profile_status ? ' — status: ' + profile_status : ' (existing status preserved)'}`);

    // Navigate to user's chosen start URL (per-profile > global default > facebook.com)
    const settings = await getSettings().catch(() => ({}));
    const startUrl = (profile.start_url && String(profile.start_url).trim())
                  || (settings.default_start_url && settings.default_start_url.trim())
                  || 'https://www.facebook.com/';
    if (startUrl && !state.url.startsWith(startUrl)) {
      try { await page.goto(startUrl, { timeout: 20000, waitUntil: 'domcontentloaded' }); } catch (_) {}
      log(`  ↳ navigated to start URL: ${startUrl}`);
    }
    await dismissFacebookPopups(page, log).catch(() => {});

    // Bring the window to the front a second time now that navigation is done,
    // so the user reliably sees it (a fresh Chromium window can end up behind the
    // Electron app or on a background desktop right after it opens).
    try { await page.bringToFront(); } catch (_) {}

    // Arm the auto re-login watcher — if FB logs us out later while user is
    // interacting with this browser, we'll auto re-inject cookies / auto-fill password
    try { attachAutoLoginWatcher(context, profile, log); } catch (_) {}

    markUsed(profile.uid).catch(() => {});
    return { success: true, loggedIn: res.loggedIn, method: res.method, status: profile_status };
  } catch (e) {
    // On any failure, make SURE we don't leave a dead entry blocking future opens
    openContexts.delete(profile.uid);
    log(`  ✗ open failed for ${profile.name}: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function closeProfile(uid) {
  const ctx = openContexts.get(uid);
  if (!ctx) return { success: false, error: 'Not open' };
  try { await ctx.close(); } catch (_) {}
  openContexts.delete(uid);
  log(`Closed profile ${uid}`);
  return { success: true };
}

async function closeAll() {
  for (const [uid, ctx] of openContexts.entries()) {
    try { await ctx.close(); } catch (_) {}
    openContexts.delete(uid);
  }
  return { success: true };
}

// ---------- Task engine ----------
function stopTask() {
  taskState.stopRequested = true;
  log('⛔ Stop requested — force-closing all active browsers...');
  emitTask();
  // Force-close every active browser context so ALL pending Playwright ops
  // (page.goto, waitForSelector, waitForTimeout, etc.) throw immediately.
  // This makes Stop truly instant instead of waiting for the next stop-check.
  for (const ctx of activeContexts) {
    try { ctx.close().catch(() => {}); } catch (_) {}
  }
  activeContexts.clear();
  return { success: true };
}
function pauseTask() { taskState.paused = true; log('⏸ Paused'); emitTask(); return { success: true }; }
function resumeTask() { taskState.paused = false; log('▶ Resumed'); emitTask(); return { success: true }; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitUnpaused() {
  while (taskState.paused && !taskState.stopRequested) await sleep(300);
}

/**
 * runTask({ taskName, profiles: [profileObj...], concurrency?, delayMs?, headless?, url?, script?, mediaPath? })
 */
async function runTask(cfg) {
  if (taskState.running) throw new Error('A task is already running');

  const settings = await getSettings();
  const concurrency = Number(cfg.concurrency || settings.concurrent_profiles || 3);
  const delayMs     = Number(cfg.delayMs || settings.action_delay_ms || 800);
  const headless    = cfg.headless !== undefined ? !!cfg.headless : settings.headless_mode === 'true';
  const profiles    = cfg.profiles || [];

  if (!profiles.length) throw new Error('No profiles');
  if (!TASK_TYPES.includes(cfg.taskName)) throw new Error(`Unknown task: ${cfg.taskName}`);

  Object.assign(taskState, {
    running: true, paused: false, stopRequested: false,
    totalActive: profiles.length, remaining: profiles.length,
    success: 0, failed: 0, taskName: cfg.taskName, results: [],
    workers: {},   // reset per-worker cards
    currentInfo: '',
  });
  emitTask();
  log(`━━━ Starting: ${cfg.taskName} · ${profiles.length} profiles · concurrency=${concurrency} · headless=${headless} ━━━`);
  log(`   ↳ Rolling concurrency: as soon as ANY slot finishes, the next profile starts (no batch waiting).`);

  let idx = 0;
  const worker = async (wid) => {
    while (idx < profiles.length && !taskState.stopRequested) {
      const my = idx++;
      const p = profiles[my];
      await waitUnpaused();
      if (taskState.stopRequested) break;
      const t0 = Date.now();

      // Rolling-concurrency visibility — log queue state when this worker
      // picks up a profile. Uses `my` (this worker's picked index) so the
      // "left" count is stable regardless of concurrent picks by other workers.
      const remainingInQueue = Math.max(0, profiles.length - (my + 1));
      log(`   ⚡ Slot W${wid} → picking profile ${my + 1}/${profiles.length}  (${remainingInQueue} still in queue)`);

      // Wrap log with per-worker prefix so EVERY line shows which browser it belongs to.
      // Uses profile name (truncated to 20 chars) so it's readable when 2+ browsers run in parallel.
      const shortName = (p.name || p.uid || '').toString().slice(0, 20);
      const tag = `[W${wid} · ${shortName}]`;
      const wlog = (msg) => log(`${tag} ${msg}`);

      // Emit per-worker progress so the UI can render separate cards
      const emitWorker = (status, extra = {}) => {
        try {
          taskState.workers = taskState.workers || {};
          taskState.workers[wid] = {
            workerId: wid,
            profileUid: p.uid,
            profileName: p.name,
            status,
            currentInfo: taskState.currentInfo || '',
            startedAt: t0,
            updatedAt: Date.now(),
            ...extra,
          };
          emitTask();
        } catch (_) {}
      };

      wlog(`▶ ${p.name} (${p.uid}) — ${cfg.taskName}`);
      emitWorker('running');

      // Per-worker status setter — routes progress text into workers[wid].currentInfo
      // (instead of the global taskState.currentInfo which parallel workers would clobber)
      const setStatus = (text) => {
        try {
          taskState.workers = taskState.workers || {};
          if (!taskState.workers[wid]) return;
          taskState.workers[wid].currentInfo = text || '';
          taskState.workers[wid].updatedAt = Date.now();
          // Keep the global one as the LAST-updated worker's status (for single-worker case)
          taskState.currentInfo = text || '';
          emitTask();
        } catch (_) {}
      };
      // Attach to log so downstream code can call log.setStatus(text)
      wlog.setStatus = setStatus;
      wlog.workerId = wid;
      wlog.profileName = p.name;

      let ok = false, error = null;
      let context;
      try {
        context = await launchForProfile(p, headless);
        activeContexts.add(context);   // track so Stop can force-close
        const page = context.pages()[0] || await context.newPage();

        // Auto-login before running the task
        // (skip for the two "Check" tasks — they do their own login inside)
        const skipAutoLogin = cfg.taskName === 'Check Profiles Status' || cfg.taskName === 'Check Page Status';
        if (!skipAutoLogin) {
          const lr = await loginProfile(context, page, p, wlog);
          if (!lr.loggedIn) {
            throw new Error(`Login failed (${lr.method || 'no-creds'})`);
          }
        }

        // Arm auto re-login watcher on task browsers too — if FB kicks us out
        // mid-task, cookies re-inject + password auto-fill kicks in
        try { attachAutoLoginWatcher(context, p, wlog); } catch (_) {}

        await executeTask(cfg.taskName, page, p, cfg, wlog);
        ok = true;
        taskState.success++;
        emitWorker('done', { ok: true });
      } catch (e) {
        // If the user pressed Stop, the forced context-close causes any
        // pending Playwright op to throw ("Target page/context has been closed",
        // "waitForTimeout" cancelled, etc.). That is NOT a real failure — the
        // user asked us to stop. Mark it as STOPPED, not FAILED.
        //
        // We also treat our own "Login failed (...)" throw as a stop error
        // WHEN stopRequested is true — because loginProfile() catches the
        // Playwright close-error internally and just returns loggedIn=false,
        // so our wrapper throws "Login failed" without the underlying
        // Playwright error text.
        const errMsg = e.message || String(e);
        const isStopError = taskState.stopRequested && (
          /Target page|context or browser has been closed|Browser has been closed|Execution context was destroyed|has been closed|Login failed/i.test(errMsg)
        );
        if (isStopError) {
          ok = false;
          error = null;
          wlog(`⏹ ${p.name} — stopped by user`);
          emitWorker('stopped', { ok: false, stopped: true });
          // Do NOT increment failed counter for user-initiated stops
        } else {
          ok = false;
          error = errMsg;
          taskState.failed++;
          wlog(`✗ ${p.name} — ${errMsg}`);
          emitWorker('failed', { ok: false, error: errMsg });
        }
      } finally {
        try { if (context) { activeContexts.delete(context); await context.close(); } } catch (_) {}
        markUsed(p.uid).catch(() => {});
        taskState.remaining = Math.max(0, taskState.totalActive - taskState.success - taskState.failed);
        // Store result with a `stopped` flag so UI can render it differently
        taskState.results.push({
          uid: p.uid, name: p.name, ok, error,
          stopped: taskState.stopRequested && !ok && !error,
          ms: Date.now() - t0,
        });
        if (taskState.results.length > 50) taskState.results.shift();
        emitTask();
      }
      if (delayMs) await sleep(delayMs);
    }
    // Worker slot idle — mark it so UI removes the card
    try {
      if (taskState.workers && taskState.workers[wid]) {
        taskState.workers[wid].status = 'idle';
        emitTask();
      }
    } catch (_) {}
  };

  const workers = Array.from({ length: Math.min(concurrency, profiles.length) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  taskState.running = false;
  taskState.paused = false;
  emitTask();
  const stoppedCount = (taskState.results || []).filter(r => r.stopped).length;
  const stoppedNote = stoppedCount > 0 ? `, ${stoppedCount} stopped` : '';
  const doneWord = taskState.stopRequested ? 'Stopped' : 'Finished';
  log(`━━━ ${doneWord}: ${taskState.success} ok, ${taskState.failed} failed${stoppedNote} ━━━`);
  return { success: true, ok: taskState.success, failed: taskState.failed };
}

// ---------- Task executors (safe stubs; edit selectors for your target site) ----------
async function executeTask(name, page, profile, cfg, log) {
  switch (name) {
    case 'Check Profiles Status': return checkProfileStatus(page, profile, log);
    case 'Check Page Status':     return checkPageStatus(page, profile, log);
    case 'Auto Upload Reels':     return autoUploadReels(page, profile, cfg, log);
    case 'Auto Page Creation':    return autoPageCreation(page, profile, cfg, log);
    case 'Page Create & Reels':   { await autoPageCreation(page, profile, cfg, log); return autoUploadReels(page, profile, cfg, log); }
    case 'Auto Interaction':      return autoInteraction(page, profile, cfg, log);
    case 'Auto Upload Story':     return autoUploadStory(page, profile, cfg, log);
    case 'Story and Reels Upload':{ await autoUploadStory(page, profile, cfg, log); return autoUploadReels(page, profile, cfg, log); }
    case 'Auto Join Groups':      return autoJoinGroups(page, profile, cfg, log);
    case 'Auto Post to Groups':   return autoPostToGroups(page, profile, cfg, log);
    case 'Auto Comments (Random)':return autoComments(page, profile, cfg, 'random', log);
    case 'Auto Comments (Targeted)': return autoComments(page, profile, cfg, 'targeted', log);
    default: throw new Error('Unknown task: ' + name);
  }
}

async function checkProfileStatus(page, profile, log) {
  const context = page.context();

  // Step 1: login (cookies first, then password)
  const res = await loginProfile(context, page, profile, log);
  if (!res.loggedIn && res.status === 'Checkpoint') {
    if (taskState.stopRequested) {
      log(`  ⏹ ${profile.name} — stopped by user (checkpoint state not committed)`);
      return;
    }
    await updateProfileStatus(profile.uid, {
      profile_status: 'Restricted',
      page_status: 'Checkpoint',
      pages_count: 0,
    });
    log(`  → ${profile.name} = Restricted / Checkpoint (login blocked)`);
    return;
  }
  if (!res.loggedIn) {
    // If the user pressed Stop, the forced context-close made login throw
    // — that is NOT a real "Login Failed", it's a user-initiated stop.
    // Do NOT overwrite the existing profile_status in the DB, and log it
    // as stopped instead of failed.
    if (taskState.stopRequested) {
      log(`  ⏹ ${profile.name} — stopped by user (login not evaluated)`);
      return;
    }
    // Login genuinely failed → clear page info too (we don't know page state)
    await updateProfileStatus(profile.uid, {
      profile_status: 'Login Failed',
      page_status: 'No Page Create',
      page_name: '',
      pages_count: 0,
    });
    log(`  → ${profile.name} = Login Failed`);
    return;
  }

  // Steps 2-6: run the real Facebook Profile Status flow (PERSONAL ID ONLY)
  let profile_status = 'Unknown';
  let recommendations = null;
  let accountStatus = null;
  let hitCheckpoint = false;

  try {
    const check = await checkFacebookAccountStatus(context, page, profile, log);
    recommendations = check.recommendations || null;
    accountStatus = check.accountStatus || null;

    switch (check.status) {
      case 'Active':                profile_status = 'Active'; break;
      case 'No restrictions':       profile_status = 'No restrictions'; break;
      case 'Limited':               profile_status = 'Limited'; break;
      case 'At Risk':               profile_status = 'At Risk'; break;
      case 'Suspended':             profile_status = 'Suspended'; break;
      case 'Login Failed':          profile_status = 'Login Failed'; break;
      default:                      profile_status = 'Unknown';
    }

    const url = page.url();
    if (/\/checkpoint(\/|\?)/i.test(url)) { profile_status = 'Restricted'; hitCheckpoint = true; }
  } catch (e) {
    // If the user pressed Stop during the check, the forced context-close
    // makes the check throw. That is NOT a real crash — rethrow so the
    // task runner's outer catch classifies this profile as "stopped by
    // user" (not failed, not success, and DO NOT write to DB).
    if (taskState.stopRequested) {
      log(`  ⏹ ${profile.name} — stopped by user (status not committed)`);
      throw e;
    }
    log(`  ✗ profile status check crashed: ${e.message}`);
  }

  // Extra guard: if a stop request arrived after the try-block succeeded
  // but before we write to DB, skip the write and rethrow so outer runner
  // sees it as stopped instead of success.
  if (taskState.stopRequested) {
    log(`  ⏹ ${profile.name} — stopped by user (status not committed)`);
    throw new Error('Target page has been closed (stopped by user)');
  }

  // NOTE: This task ONLY updates profile_status.
  // Page-related fields are handled by the separate "Check Page Status" task
  // so ID and Page checks stay cleanly independent (user's explicit request).
  const patch = {
    profile_status,
    notes: recommendations
      ? `Recommendations: ${recommendations}`
      : (accountStatus ? `Account status: ${accountStatus}` : (profile.notes || '')),
  };

  // Only overwrite page_status if we DEFINITELY hit checkpoint during login flow
  if (hitCheckpoint) {
    patch.page_status = 'Checkpoint';
  }

  await updateProfileStatus(profile.uid, patch);
  log(`  → FINAL: ${profile.name} = ${profile_status}` +
      (recommendations ? ` [FB Recommendations: "${recommendations}"]` : ''));
}

/**
 * Check the PAGE's status.
 *
 * IMPORTANT FLOW (user's explicit requirement):
 *   Before running this task, the user has to:
 *     1. Manually click "Open" on the profile to launch the browser
 *     2. Log in (or the cookies already log in)
 *     3. Manually switch to the Page they want to check (top-right avatar → Switch Profile → pick a page)
 *     4. Close the browser
 *   That page-switched state is saved in the profile's persistent context.
 *   When this task runs, it re-uses that same persistent context — so we
 *   land on Facebook ALREADY IN THE PAGE CONTEXT the user chose.
 *
 * Steps performed by the task:
 *   1. Launch the profile's persistent context (session preserved from user's manual switch)
 *   2. Load home + dismiss popups + scroll (bot avoidance)
 *   3. Detect current context name (which page/profile we're viewing as)
 *   4. Scroll again
 *   5. Open  facebook.com/settings/?tab=profile_quality&show_dialog=0&ref=account_status&referrer=three_dot_menu_settings
 *   6. Parse Account Status + Recommendations rows
 *   7. Save page_status + page_name (detected from context)
 */
async function checkPageStatus(page, profile, log) {
  const context = page.context();

  // Step 0: Check if the persistent context already has a logged-in session
  //   If yes → use it as-is (this is where user's manual page-switch is preserved)
  //   If no  → try cookie login as fallback (but this WON'T preserve page context)
  const preCookies = await context.cookies(['https://www.facebook.com']);
  const preCUser = preCookies.find(c => c.name === 'c_user' && c.value && c.value !== '0');

  if (!preCUser) {
    log('  · no existing session — trying cookie login (note: this loses manual page switch)');
    const res = await loginProfile(context, page, profile, log);
    if (!res.loggedIn && res.status === 'Checkpoint') {
      if (taskState.stopRequested) {
        log(`  ⏹ ${profile.name} — stopped by user (checkpoint state not committed)`);
        return;
      }
      await updateProfileStatus(profile.uid, { page_status: 'Checkpoint' });
      log(`  → ${profile.name}: Page = Checkpoint (login blocked)`);
      return;
    }
    if (!res.loggedIn) {
      // Stop pressed → don't overwrite anything, just log as stopped.
      if (taskState.stopRequested) {
        log(`  ⏹ ${profile.name} — stopped by user (page check not evaluated)`);
        return;
      }
      await updateProfileStatus(profile.uid, {
        page_status: 'No Page Create', page_name: '', pages_count: 0,
      });
      log(`  → ${profile.name}: cannot check page — login failed`);
      return;
    }
  } else {
    log(`  · using existing session (c_user=${preCUser.value.slice(0, 6)}…) — respecting user's manual page switch`);
  }

  // Step 1: home + scroll + popups
  log('  · loading facebook.com home (staying in current page/profile context)');
  await page.goto('https://www.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);
  await dismissFacebookPopups(page, log);
  log('  · scrolling home feed (avoid bot detection)');
  await humanScroll(page, 3);
  await dismissFacebookPopups(page, log);

  // Step 2: (context detection MOVED — now happens on the settings page itself,
  //         where "Page status" heading is followed by the page name)
  let currentContextName = '';

  // Step 3: extra scroll
  await humanScroll(page, 2);
  await dismissFacebookPopups(page, log);

  // Step 4: open the PAGE-STATUS URL (three_dot_menu_settings referrer variant)
  const pageStatusUrl = 'https://www.facebook.com/settings/?tab=profile_quality&show_dialog=0&ref=account_status&referrer=three_dot_menu_settings';
  log('  · opening PAGE status: ' + pageStatusUrl);
  await page.goto(pageStatusUrl, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(5000);
  await dismissFacebookPopups(page, log);

  // Wait for the status card to render
  try {
    await page.waitForFunction(() => {
      const t = (document.body?.innerText || '').toLowerCase();
      return t.includes('account status') ||
             t.includes('recommendation') ||
             t.includes('page quality') ||
             t.includes('no restriction') ||
             t.includes('at risk') ||
             t.includes('suspend') ||
             t.includes('limited') ||
             t.includes('violation');
    }, { timeout: 15000 });
  } catch (_) { log('  · page-status page didn\'t render expected keywords within 15s'); }
  await humanScroll(page, 1);
  await dismissFacebookPopups(page, log);
  await page.waitForTimeout(1500);

  // Step 5: Parse — same structure as personal profile_status
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').trim()).catch(() => '');

  let recommendations = null;
  let accountStatus = null;
  let hasPage = true;

  const rawLines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

  // Blocklist of common UI/menu strings that must NEVER be treated as a page name
  const NAME_BLOCK = /^(page status|account status|profile quality|page quality|recommendations|community standards|extra features|monetization|policy|violation|professional dashboard|meta business|see (all|more)|switch|log ?out|settings|display|help|home|feed|search|marketplace|notifications?|messenger|create|menu|facebook|all|active|inactive|any|other|more|preferences|account|privacy|security|password|language|region|about|contact|blocking|apps and websites|ads|payments|shortcuts|filters?|posts?|photos?|videos?|reels?|stories?|likes?|followers?|following)$/i;
  const NAME_CONTAINS_JUNK = /account controls|profile quality|page quality|controls and settings/i;
  const KNOWN_SUMMARY = /^(page has (no|some) issues?|profile has (no|some) issues?|no issues|some issues|active|restricted|no restrictions|looks good)$/i;

  const cleanName = (s) => {
    if (!s) return null;
    const t = s.replace(/\s+/g, ' ').trim();
    if (!t || t.length < 2 || t.length > 80) return null;
    if (NAME_BLOCK.test(t)) return null;
    if (NAME_CONTAINS_JUNK.test(t)) return null;
    if (!/[a-zA-Z\u00C0-\uFFFF]/.test(t)) return null;
    return t;
  };

  // Recommendations / Account status row parsing (unchanged)
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (/^Recommendations$/i.test(line) && rawLines[i + 1]) {
      const nxt = rawLines[i + 1];
      if (/^(Active|Limited|At Risk|Suspended|Not eligible)$/i.test(nxt)) recommendations = nxt;
    }
    if (/^Account status$/i.test(line) && rawLines[i + 1]) {
      const nxt = rawLines[i + 1];
      if (/^(No restrictions|Restricted|Limited|At Risk|Suspended)$/i.test(nxt)) accountStatus = nxt;
      else if (/looks good/i.test(nxt)) accountStatus = 'No restrictions';
    }
  }

  // ---- Page Name + Page Status Summary — DOM-based (much more reliable than text split) ----
  // The "Page status" section on the settings page has this exact structure:
  //     <heading>Page status</heading>
  //     <row>
  //         <avatar img alt="Page Name"/>
  //         <text> Page Name </text>
  //         <text> Page has some issues </text>
  //     </row>
  // We find the HEADING element that renders "Page status" IN THE MAIN CONTENT (not sidebar),
  // then walk to the next sibling row that contains an <img>. The <img>'s alt is the page name,
  // and the text lines under it give us the summary.
  let pageStatusSummary = null;
  try {
    const dom = await page.evaluate(() => {
      const KNOWN_SUM = /(page has (no|some) issues?)/i;
      const isHeadingText = (el, txt) =>
        el && (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase() === txt.toLowerCase();

      // Find the "Page status" heading. Prefer real heading tags in the main region.
      const main = document.querySelector('div[role="main"]') || document.body;
      const candidates = main.querySelectorAll(
        'h1, h2, h3, h4, span[role="heading"], div[role="heading"], strong, b'
      );
      let heading = null;
      for (const el of candidates) {
        if (isHeadingText(el, 'Page status')) { heading = el; break; }
      }
      // Fallback: find ANY element in main with text === "Page status"
      if (!heading) {
        const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          if (/^\s*Page status\s*$/.test(n.textContent)) {
            heading = n.parentElement;
            break;
          }
        }
      }
      if (!heading) return { name: '', summary: '' };

      // Walk up to find the section container (heading + row)
      let container = heading;
      for (let up = 0; up < 6; up++) {
        if (!container.parentElement) break;
        container = container.parentElement;
        // Once container includes both the heading text AND a status-summary line, stop
        const t = (container.innerText || '').toLowerCase();
        if (t.includes('page status') && KNOWN_SUM.test(t)) break;
      }

      // Extract avatar alt
      let name = '';
      const imgs = container.querySelectorAll('img[alt], image[alt]');
      for (const im of imgs) {
        const alt = (im.getAttribute('alt') || '').trim();
        if (alt && alt.length >= 2 && alt.length <= 80 &&
            !/photo of|profile picture|no photo|^facebook$/i.test(alt)) {
          name = alt;
          break;
        }
      }

      // Extract summary line (the "Page has ... issues" text)
      let summary = '';
      const containerText = (container.innerText || '');
      const m = containerText.match(/Page has (no|some) issues?/i);
      if (m) summary = m[0].replace(/^p/, 'P');

      // If we still didn't get a name from alt, scan text lines AFTER "Page status" heading
      // but only within THIS container (not the whole page)
      if (!name) {
        const lines = containerText.split('\n').map(l => l.trim()).filter(Boolean);
        const idx = lines.findIndex(l => /^Page status$/i.test(l));
        if (idx >= 0) {
          for (let j = idx + 1; j < Math.min(idx + 4, lines.length); j++) {
            const cand = lines[j];
            // Skip if it's a status summary line
            if (/^page has (no|some) issues?$/i.test(cand)) continue;
            // Skip common junk
            if (/^(all|any|other|more|see (all|more)|active|inactive)$/i.test(cand)) continue;
            if (cand.length >= 2 && cand.length <= 80 && /[a-zA-Z\u00C0-\uFFFF]/.test(cand)) {
              name = cand;
              break;
            }
          }
        }
      }

      return { name, summary };
    }).catch(() => ({ name: '', summary: '' }));

    const nm = cleanName(dom.name);
    if (nm) currentContextName = nm;
    if (dom.summary) {
      if (/no issues?/i.test(dom.summary)) pageStatusSummary = 'Page has no issues';
      else if (/some issues?/i.test(dom.summary)) pageStatusSummary = 'Page has some issues';
    }
  } catch (_) {}

  if (currentContextName) log(`  · detected page name: "${currentContextName}"`);
  else log('  · could not detect page name from settings page');
  if (pageStatusSummary) log(`  · found "Page status" summary line: "${pageStatusSummary}"`);

  const lower = bodyText.toLowerCase();
  const noPagePhrases = [
    /you don'?t have any pages/,
    /you do not have any pages/,
    /create (a )?page to (get started|continue)/,
    /you haven'?t created a page/,
    /this account doesn'?t manage any pages/,
    /no pages to manage/,
  ];
  if (noPagePhrases.some(rx => rx.test(lower))) hasPage = false;

  const finalUrl = page.url();
  if (/\/checkpoint(\/|\?)/i.test(finalUrl)) {
    const cpJunk = /account controls|settings|profile quality|page quality|^unknown$|^facebook$/i;
    const cpPrev = (profile.page_name && !cpJunk.test(profile.page_name)) ? profile.page_name : '';
    await updateProfileStatus(profile.uid, {
      page_status: 'Checkpoint',
      page_name: currentContextName || cpPrev || '',
    });
    log(`  → ${profile.name}: Page = Checkpoint (redirected during check)`);
    return;
  }

  // Only trust STRICT signals — no vague keyword fallback (that was causing
  // "Page has some issues" to appear when the page just failed to render).
  let page_status;
  // Clean up any junk previously saved into page_name
  const PAGE_NAME_JUNK = /account controls|settings|profile quality|page quality|^unknown$|^facebook$/i;
  const cleanPrev = (profile.page_name && !PAGE_NAME_JUNK.test(profile.page_name)) ? profile.page_name : '';
  let page_name = currentContextName || cleanPrev || '';
  let pages_count = profile.pages_count || 0;

  const rec = (recommendations || '').toLowerCase();
  const acc = (accountStatus || '').toLowerCase();

  if (!hasPage && !recommendations && !accountStatus && !pageStatusSummary) {
    // Explicit "no pages" message + nothing else → account has no page
    page_status = 'No Page Create';
    page_name = '';
    pages_count = 0;
  } else if (pageStatusSummary) {
    // BEST signal — the "Page status" heading's own summary line
    // (matches exactly what the user sees at the top of the page)
    page_status = pageStatusSummary;
    if (!pages_count) pages_count = 1;
  } else if (recommendations || accountStatus) {
    // Fallback to Recommendations/Account status row from the page-quality card
    if (/suspend/.test(rec) || /suspend/.test(acc)) {
      page_status = 'Page has some issues';
    } else if (/at\s*risk/.test(rec)) {
      page_status = 'Page has some issues';
    } else if (/limit/.test(rec) || /restricted|limited/.test(acc)) {
      page_status = 'Page has some issues';
    } else if (/active/.test(rec) || /no restriction|looks good/.test(acc)) {
      page_status = 'Page has no issues';
    } else {
      page_status = 'Unknown';
    }
    if (!pages_count) pages_count = 1;
  } else {
    // We got NO strict signal AND no "no pages" message.
    // This means: page probably didn't load, or Facebook layout changed,
    // or the account is in a non-standard state. Mark as "Unknown" so the
    // user knows to re-run — do NOT falsely mark as "some issues".
    page_status = 'Unknown';
    log('  · WARNING: no Recommendations/Account status row found — marking Unknown');
  }

  log(`  · parsed → PageStatusSummary="${pageStatusSummary || 'n/a'}"`
    + ` · Recommendations="${recommendations || 'n/a'}"`
    + ` · AccountStatus="${accountStatus || 'n/a'}"`
    + ` · noPagePhrase=${!hasPage}`
    + ` · pageName="${currentContextName || 'unknown'}"`
    + ` → page_status="${page_status}"`);

  // If a stop request arrived before final commit, skip the DB write and
  // rethrow so the task runner classifies this profile as "stopped by user"
  // instead of overwriting the existing page_status with a partial result.
  if (taskState.stopRequested) {
    log(`  ⏹ ${profile.name} — stopped by user (page status not committed)`);
    throw new Error('Target page has been closed (stopped by user)');
  }

  // Page Name detection removed per user request — only update status + count
  await updateProfileStatus(profile.uid, { page_status, pages_count });
  log(`  → ${profile.name}: Page = ${page_status} [pages: ${pages_count}]`);
}
// ============================================================
// AUTO UPLOAD REELS — Meta Business Suite Bulk Upload Flow
// Full flow (mirrors V1.4):
//   1. Go to Meta Business Suite home → detect asset_id from URL
//   2. Navigate to bulk_upload_composer?asset_id=<X>
//   3. Random-pick N videos from user's Reels folder
//   4. Click "Add videos" → setInputFiles(files)
//   5. Poll upload progress bar → wait for 100%
//   6. Fill each description textarea from Discription.txt (random pick)
//   7. Click Publish → wait for "Your bulk upload is processing!" popup
//   8. Click Done → close
// Config:
//   cfg.reelsFolder     — absolute path to folder containing .mp4 files
//   cfg.descriptions    — ARRAY of description strings (from UI Description Pool boxes) [preferred]
//   cfg.descriptionsFile— absolute path to Discription.txt (legacy fallback)
//   cfg.videosPerUpload — default 10
// ============================================================
// ============================================================
// POPUP WATCHDOG for Auto Upload Reels
// Every 3s dismisses any FB modal (violation notices, "What happened",
// cookie banners, save-info prompts, dialog X-close). Skips the "Your bulk
// upload is processing!" popup because that one is handled explicitly by
// the upload flow (click "Done" ourselves). Auto-stops when page closes.
// Non-fatal — errors swallowed silently.
// ============================================================
function installReelsPopupWatchdog(page) {
  if (!page || page._reelsPopupWatchdogInstalled) return () => {};
  page._reelsPopupWatchdogInstalled = true;

  const dismissPopups = async () => {
    for (let round = 0; round < 5; round++) {
      let closedSomething = false;
      try {
        closedSomething = await page.evaluate(() => {
          let didClose = false;

          // 1) Cookie banner buttons
          const cookieBtns = Array.from(document.querySelectorAll(
            '[data-cookiebanner] button, [aria-label*="cookie" i] button'
          ));
          for (const b of cookieBtns) {
            const t = (b.innerText || '').trim().toLowerCase();
            if (['allow all', 'accept all', 'accept', 'only allow essential', 'allow essential cookies'].includes(t)) {
              try { b.click(); didClose = true; } catch {}
            }
          }

          // 2) All [role="dialog"] modals — but SKIP the "bulk upload processing" one
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
          for (const dlg of dialogs) {
            const dlgText = (dlg.innerText || '').toLowerCase();
            // CRITICAL — do NOT close the "bulk upload is processing" popup;
            // upload flow explicitly clicks its "Done" button. Also skip any
            // dialog that looks like the file picker / composer body.
            if (dlgText.includes('processing') ||
                dlgText.includes('bulk upload is processing') ||
                dlgText.includes('add videos') ||
                dlgText.includes('upload up to') ||
                (dlgText.includes('publish') && dlgText.includes('description'))) continue;

            // Prefer aria-label close button (X icon)
            const closeBtn = dlg.querySelector(
              '[aria-label="Close"], [aria-label="close"], ' +
              '[aria-label="Fermer"], [aria-label="Cerrar"], ' +
              '[aria-label="Dismiss"], [aria-label="বন্ধ করুন"], ' +
              '[aria-label="বন্ধ"]'
            );
            if (closeBtn) {
              try { closeBtn.click(); didClose = true; continue; } catch {}
            }

            // Fallback: aria-label containing "close"/"dismiss" in any language
            const allBtns = dlg.querySelectorAll('[role="button"], button, div[tabindex]');
            for (const b of allBtns) {
              const label = (b.getAttribute('aria-label') || '').toLowerCase();
              if (label && (label.includes('close') || label.includes('dismiss') ||
                            label.includes('fermer') || label.includes('cerrar'))) {
                try { b.click(); didClose = true; break; } catch {}
              }
            }
            if (didClose) continue;

            // Fallback: text-button "Not now", "OK", "Got it", etc.
            // AVOID "Publish", "Done" — those are our own action buttons
            const textBtns = dlg.querySelectorAll('button, [role="button"], div[role="button"]');
            const okNeedles = [
              'not now', 'got it', 'dismiss', 'cancel',
              'skip', 'later', 'no thanks', 'maybe later', 'close',
              'plus tard', 'pas maintenant', 'compris', 'annuler',
              'ahora no', 'entendido', 'cancelar',
              'বুঝেছি', 'বাদ দিন', 'পরে',
            ];
            for (const b of textBtns) {
              const t = (b.innerText || '').trim().toLowerCase();
              if (!t || t.length > 40) continue;
              // Skip our own action buttons explicitly
              if (['publish', 'post', 'done', 'ok', 'okay', 'publier', 'publicar'].includes(t)) continue;
              if (okNeedles.some(n => t === n || t.startsWith(n))) {
                try { b.click(); didClose = true; break; } catch {}
              }
            }
          }

          // 3) Top-level notification banners
          const bannerCloses = Array.from(document.querySelectorAll(
            'div[aria-label="Close"], div[aria-label="Dismiss"]'
          ));
          for (const b of bannerCloses) {
            try { b.click(); didClose = true; } catch {}
          }

          return didClose;
        });
      } catch {}

      if (!closedSomething) break;
      await new Promise(r => setTimeout(r, 700 + Math.floor(Math.random() * 500)));
    }
  };

  const interval = setInterval(() => {
    dismissPopups().catch(() => {});
  }, 3000);

  // Auto-stop when page or context closes
  const stop = () => { try { clearInterval(interval); } catch {} };
  try { page.on('close', stop); } catch {}
  try {
    const ctx = page.context && page.context();
    if (ctx) ctx.on('close', stop);
  } catch {}

  return stop;
}

async function autoUploadReels(page, profile, cfg, log) {
  // Set live status "Uploading..." immediately so the browser card shows
  // it right away. On success we set "Upload Success" (already handled at
  // the end). On any failure we catch here and set "Upload Failed" so the
  // status is visible in the profile table even though the task runner
  // outer catch will also see the throw.
  try {
    await updateProfileStatus(profile.uid, { upload_status: 'Uploading...' }).catch(() => {});
    emitTask();   // nudge UI to refresh the profile list right now
  } catch {}

  try {
    return await _autoUploadReelsImpl(page, profile, cfg, log);
  } catch (err) {
    // Mark this profile as failed so the "Upload Status" column shows Upload Failed
    try {
      await updateProfileStatus(profile.uid, { upload_status: 'Upload Failed' }).catch(() => {});
      emitTask();
    } catch {}
    throw err;   // rethrow so task runner counts it as failed
  }
}

async function _autoUploadReelsImpl(page, profile, cfg, log) {
  const fs   = require('fs');
  const path = require('path');

  const reelsFolder  = cfg.reelsFolder || '';
  const descFile     = cfg.descriptionsFile || '';
  // NEW: descriptions can now be passed as an ARRAY directly from the UI
  // (each entry = one full description block). This bypasses the file
  // entirely — user just types/pastes each description into its own box.
  const descArray    = Array.isArray(cfg.descriptions) ? cfg.descriptions.filter(s => (s || '').trim().length > 0) : [];
  const videosPerUpload = Math.max(1, Math.min(50, Number(cfg.videosPerUpload) || 10));

  if (!reelsFolder) throw new Error('reelsFolder required (path to folder with .mp4 files)');

  // Silent popup watchdog — dismisses any FB modal that pops up during upload.
  // Skips the "bulk upload is processing" popup so our own flow can click Done.
  installReelsPopupWatchdog(page);
  if (!fs.existsSync(reelsFolder)) throw new Error(`reelsFolder not found: ${reelsFolder}`);

  // ---------- Pick N random videos ----------
  const allFiles = fs.readdirSync(reelsFolder)
    .filter(f => /\.(mp4|mov|m4v|webm)$/i.test(f))
    .map(f => path.join(reelsFolder, f))
    .filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (!allFiles.length) throw new Error(`No video files found in ${reelsFolder}`);

  // Proper Fisher–Yates shuffle. `sort(() => Math.random() - 0.5)` is
  // biased and often returns near-original order — that's why the same
  // videos kept getting picked. This one is unbiased.
  const shuffled = allFiles.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picked = shuffled.slice(0, Math.min(videosPerUpload, shuffled.length));
  log(`  Starting Reels bulk upload...`);
  log(`  Selected ${picked.length} random videos out of ${allFiles.length} available.`);
  picked.forEach((p, i) => log(`    ${i + 1}. ${path.basename(p)}`));

  // ---------- Load description pool ----------
  // Preferred source: descArray (from the UI "Description Pool" boxes).
  // Fallback: parse descriptionsFile (legacy — one block per blank-line
  // or "."-separated section). Whichever source we get, each entry is
  // one full description block (multi-line, hashtags, emoji preserved).
  let descPool = [];
  if (descArray.length) {
    descPool = descArray.map(s => String(s).replace(/\r\n/g, '\n'));
    log(`  Loaded ${descPool.length} description(s) from UI Description Pool`);
  } else if (descFile && fs.existsSync(descFile)) {
    try {
      const raw = fs.readFileSync(descFile, 'utf8').replace(/\r\n/g, '\n');
      const norm = raw
        .split('\n')
        .map(line => /^\s*\.?\s*$/.test(line) ? '' : line.replace(/\s+$/, ''))
        .join('\n');
      descPool = norm
        .split(/\n{2,}/)
        .map(block => block.replace(/^\n+|\n+$/g, ''))
        .filter(block => block.trim().length > 0);
    } catch {}
    log(`  Loaded ${descPool.length} description block(s) from file`);
  } else {
    log(`  No descriptions provided — fields will stay empty`);
  }
  const pickDescription = () => descPool.length
    ? descPool[Math.floor(Math.random() * descPool.length)]
    : '';

  // ---------- Step 1: Go to Meta Business Suite home, detect asset_id ----------
  log(`  Going to Meta Business Suite Home...`);
  await page.goto('https://business.facebook.com/latest/home', {
    timeout: 60000, waitUntil: 'domcontentloaded',
  }).catch(() => {});
  await page.waitForTimeout(4000);

  // asset_id is a large numeric id present in the URL after navigating any
  // Business Suite sub-page. First try the URL of the home page itself.
  const extractAssetId = async () => {
    const urlAid = (page.url().match(/[?&]asset_id=(\d+)/) || [])[1];
    if (urlAid) return urlAid;
    // Fallback: scan page HTML for asset_id=<digits>
    try {
      const html = await page.content();
      const m = html.match(/asset_id[=":]+(\d{6,20})/);
      if (m) return m[1];
    } catch {}
    return null;
  };

  let assetId = await extractAssetId();
  if (!assetId) {
    // Force navigation to a page that always has asset_id in URL
    await page.goto('https://business.facebook.com/latest/inbox/all', {
      timeout: 45000, waitUntil: 'domcontentloaded',
    }).catch(() => {});
    await page.waitForTimeout(3500);
    assetId = await extractAssetId();
  }
  if (!assetId) throw new Error('Could not detect asset_id — Business Suite may not be set up for this account');
  log(`  Found asset_id: ${assetId}`);

  // ---------- Step 2: Navigate to Bulk Reels Composer ----------
  const composerUrl = `https://business.facebook.com/latest/bulk_upload_composer?asset_id=${assetId}`;
  await page.goto(composerUrl, { timeout: 60000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(5000);

  // ---------- Step 3: Click "Add videos" and upload files ----------
  log(`  Clicking 'Add videos' and uploading files...`);

  // Try direct input first (it usually exists in the DOM). If not found within
  // 8s, click the "Add videos" button to trigger lazy-mount of the input.
  let fileInput = await page.$('input[type="file"]').catch(() => null);
  if (!fileInput) {
    // Click the visible "Add videos" button (mid-page or top-right variant).
    // Use expect_file_chooser pattern so we can intercept the picker.
    try {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15000 }).catch(() => null),
        page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"], a'));
          const needles = ['add videos', 'add video', 'ajouter des vidéos', 'agregar videos', 'ভিডিও যোগ করুন'];
          for (const b of btns) {
            const t = (b.innerText || '').trim().toLowerCase();
            if (needles.some(n => t === n || t.includes(n))) { try { b.click(); return true; } catch {} }
          }
          return false;
        }),
      ]);
      if (fileChooser) {
        await fileChooser.setFiles(picked);
      } else {
        // Retry direct input read after button click
        await page.waitForTimeout(2000);
        fileInput = await page.waitForSelector('input[type="file"]', { timeout: 15000 });
        await fileInput.setInputFiles(picked);
      }
    } catch (e) {
      throw new Error('Could not find "Add videos" button or file input: ' + e.message);
    }
  } else {
    await fileInput.setInputFiles(picked);
  }
  log(`  Waiting for upload to begin...`);
  await page.waitForTimeout(4000);

  // ---------- Step 4: Poll per-row upload progress until ALL rows are 100% ----------
  // MBS bulk composer shows ONE progress bar per video row. We must wait
  // for EVERY row to reach 100%, not just any one. Max wait: 10 minutes.
  // If some rows still incomplete after 10 mins, we delete those rows
  // (click the trash icon on the row) and proceed with the completed ones.
  log(`  Polling per-row upload progress (max 10 mins)...`);
  const startedAt = Date.now();
  const MAX_UPLOAD_MS = 10 * 60 * 1000;
  const targetCount = picked.length;
  let lastLoggedComplete = -1;
  let allDone = false;

  const readRowPercents = async () => await page.evaluate(() => {
    // MBS bulk composer shows the video-upload percent as visible TEXT
    // near each thumbnail (like "100%", "42%", etc.) — NOT reliably as
    // aria-valuenow. The aria-valuenow bars are usually the "Checking for
    // copyrighted content" bars (which we want to ignore).
    //
    // Strategy: scan the whole composer table for TEXT nodes matching
    // /^\s*\d{1,3}\s*%\s*$/ (a percent by itself, not part of a longer
    // sentence). Return each as a number. If the row is fully uploaded,
    // the text shows "100%". This is exactly what the user sees in the UI.
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.nodeValue || '').trim();
      const m = t.match(/^(\d{1,3})\s*%$/);
      if (!m) continue;
      const p = parseInt(m[1], 10);
      if (isNaN(p) || p < 0 || p > 100) continue;
      // Reject if the parent element's context is clearly copyright/checking
      let ctx = '';
      let parent = node.parentElement;
      for (let up = 0; up < 4 && parent; up++) {
        ctx = (parent.innerText || '').toLowerCase();
        if (ctx.length > 30) break;
        parent = parent.parentElement;
      }
      if (ctx.includes('copyright') || ctx.includes('checking for')) continue;
      out.push(p);
    }
    return out;
  }).catch(() => []);

  while (Date.now() - startedAt < MAX_UPLOAD_MS) {
    const percents = await readRowPercents();
    // Complete when we see AT LEAST targetCount percent-labels reading 100.
    // We do not require percents.length == targetCount because FB may
    // render extra percent labels (tooltips, hidden rows) that don't
    // correspond to real videos. What we care about is: at least N of
    // them are at 100%.
    const completeCount = percents.filter(p => p >= 100).length;
    if (completeCount !== lastLoggedComplete) {
      log(`  Upload progress: ${completeCount}/${targetCount} videos at 100% (${percents.length} percent labels found)`);
      lastLoggedComplete = completeCount;
    }
    if (completeCount >= targetCount) {
      allDone = true;
      log(`  ✓ All ${targetCount} videos uploaded 100%!`);
      break;
    }
    await page.waitForTimeout(3000);
  }

  // ---------- Step 4b: If not all done after 10 min, DELETE incomplete rows ----------
  if (!allDone) {
    log(`  ⚠ 10 min timeout reached — deleting rows that are not 100%...`);
    // Loop delete: after each delete the DOM reflows, so we re-query.
    let deleteAttempts = 0;
    while (deleteAttempts < 30) {
      deleteAttempts++;
      const deletedOne = await page.evaluate(() => {
        // Find text nodes containing "NN%" (a percent by itself). If the
        // percent is < 100 AND the surrounding context is NOT copyright/
        // checking, walk up to find the row and click its trash icon.
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let tn;
        while ((tn = walker.nextNode())) {
          const t = (tn.nodeValue || '').trim();
          const m = t.match(/^(\d{1,3})\s*%$/);
          if (!m) continue;
          const p = parseInt(m[1], 10);
          if (isNaN(p) || p >= 100) continue;
          // Skip copyright-check context
          let ctx = '';
          let par = tn.parentElement;
          for (let up = 0; up < 4 && par; up++) {
            ctx = (par.innerText || '').toLowerCase();
            if (ctx.length > 30) break;
            par = par.parentElement;
          }
          if (ctx.includes('copyright') || ctx.includes('checking for')) continue;

          // Walk up to find the row container that also contains a trash button
          let row = tn.parentElement;
          for (let up = 0; up < 14 && row && row.parentElement; up++) {
            row = row.parentElement;
            const cand = row.querySelectorAll('button, [role="button"], div[role="button"], [aria-label]');
            for (const el of cand) {
              const al = (el.getAttribute('aria-label') || '').toLowerCase();
              const tt = (el.getAttribute('title') || '').toLowerCase();
              const tx = (el.innerText || '').trim().toLowerCase();
              if (al.includes('delete') || al.includes('remove') || al.includes('trash') ||
                  tt.includes('delete') || tt.includes('remove') ||
                  tx === 'delete' || tx === 'remove') {
                try { el.click(); return true; } catch {}
              }
            }
            // Fallback: rightmost icon-only button (trash icon)
            const iconBtns = Array.from(row.querySelectorAll('div[role="button"], button'))
              .filter(el => el.querySelector('svg') && !(el.innerText || '').trim());
            if (iconBtns.length >= 2) {
              try { iconBtns[iconBtns.length - 1].click(); return true; } catch {}
            }
          }
        }
        return false;
      }).catch(() => false);

      if (!deletedOne) break;
      log(`  Deleted incomplete row (attempt ${deleteAttempts})`);
      await page.waitForTimeout(1200);

      // Dismiss any "Are you sure?" confirmation
      await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
        for (const d of dialogs) {
          const btns = d.querySelectorAll('button, [role="button"], div[role="button"]');
          for (const b of btns) {
            const t = (b.innerText || '').trim().toLowerCase();
            if (t === 'delete' || t === 'remove' || t === 'confirm' || t === 'yes' || t === 'ok') {
              try { b.click(); return; } catch {}
            }
          }
        }
      }).catch(() => {});
      await page.waitForTimeout(1000);
    }
    log(`  Finished cleaning incomplete rows — proceeding to Publish.`);
  }

  await page.waitForTimeout(2500);

  // ---------- Step 5: Fill description fields ----------
  // Build a large pool of RANDOMLY-PICKED descriptions (one per potential
  // field). We use `picked.length * 5` to safely cover any number of visible
  // description textareas that MBS may render. Each pick is INDEPENDENTLY
  // random so different videos get different descriptions.
  log(`  Filling descriptions...`);
  const descriptionsRandomPool = [];
  const poolSize = Math.max(picked.length * 5, 20);
  for (let i = 0; i < poolSize; i++) descriptionsRandomPool.push(pickDescription());

  // Find all description input targets first (textareas + Lexical/Draft
  // contenteditable role="textbox" divs). We locate them via evaluate so
  // we can compute exact selectors, then use Playwright's native typing
  // API for each one — which properly triggers React state updates that
  // pure DOM manipulation misses (that's why "everything went into one
  // field" — React ignored our innerHTML writes and only kept the last
  // one that got a real input event).
  const descTargets = await page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 20) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && r.top < window.innerHeight * 10;
    };
    // Candidates: textareas + contenteditable elements (Lexical/Draft/plain)
    const raw = Array.from(document.querySelectorAll(
      'textarea, div[contenteditable="true"], div[role="textbox"][contenteditable="true"]'
    ));
    const targets = raw.filter(isVisible);

    // Assign each target a unique id we can grab from Playwright
    const out = [];
    targets.forEach((el, i) => {
      const tag = `__reels_desc_${i}__`;
      el.setAttribute('data-reels-desc-id', tag);
      out.push({ tag, kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable' });
    });
    return out;
  }).catch(() => []);

  log(`  Found ${descTargets.length} description field(s) — pasting each with a RANDOM description...`);

  // Open a CDP session so we can use `Input.insertText` — this is the
  // fastest and most reliable way to insert large text into a focused
  // field in Chromium (behaves exactly like a paste, no typing delay,
  // supports full unicode + newlines instantly). Falls back to a
  // React-safe DOM setter for textareas if CDP is unavailable.
  let cdp = null;
  try { cdp = await page.context().newCDPSession(page); } catch { cdp = null; }

  let filled = 0;
  for (let i = 0; i < descTargets.length; i++) {
    const { tag, kind } = descTargets[i];
    const text = descriptionsRandomPool[i] || descriptionsRandomPool[0] || '';
    if (!text) continue;

    const sel = `[data-reels-desc-id="${tag}"]`;
    try {
      const handle = await page.$(sel);
      if (!handle) continue;

      // Scroll into view + focus (click to place caret inside field)
      await handle.scrollIntoViewIfNeeded().catch(() => {});
      await handle.click({ delay: 30 }).catch(() => {});
      await page.waitForTimeout(120);

      // Clear whatever's there (Ctrl+A + Delete works on both textarea + contenteditable)
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Delete');
      await page.waitForTimeout(60);

      // Paste via CDP Input.insertText — instant, no typing, unicode-safe,
      // works on both textarea and Lexical/Draft contenteditable fields.
      let pasted = false;
      if (cdp) {
        try {
          await cdp.send('Input.insertText', { text: String(text) });
          pasted = true;
        } catch {}
      }

      // Fallback: React-safe DOM setter (only reliable for plain textareas)
      if (!pasted && kind === 'textarea') {
        await page.evaluate(({ s, t }) => {
          const el = document.querySelector(s);
          if (!el) return;
          const proto = window.HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, t);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { s: sel, t: text }).catch(() => {});
        pasted = true;
      }

      if (pasted) filled++;
      await page.waitForTimeout(150);
    } catch (e) {
      // one field failed, keep going
    }
  }

  try { if (cdp) await cdp.detach(); } catch {}

  log(`  Pasted ${filled} description field(s) — each with a random block from your pool.`);
  await page.waitForTimeout(2000);

  // ---------- Step 6: Click Publish ----------
  // FB uses <div role="button"> with a nested <span>Publish</span>, not a
  // plain <button>. Also the button lives in the FOOTER bar (bottom of
  // composer) so we prefer buttons in the lower half of viewport, and
  // filter out any Publish-like text that appears in row-level dropdowns
  // ("Publish now", "Publish later" — those are per-row selectors, NOT
  // the final submit button).
  log(`  Clicking Publish...`);
  let publishClicked = false;
  const publishDeadline = Date.now() + 15000;   // retry up to 15s
  while (!publishClicked && Date.now() < publishDeadline) {
    publishClicked = await page.evaluate(() => {
      const isFinalPublish = (el) => {
        const txt = (el.innerText || '').trim();
        if (!txt) return false;
        // EXACT "Publish" — reject "Publish now", "Publish later", etc.
        const low = txt.toLowerCase();
        const exact = ['publish', 'post', 'publier', 'publicar', 'পোস্ট'];
        if (!exact.includes(low)) return false;
        // Must be in the lower half of viewport (footer bar)
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) return false;
        if (r.top < window.innerHeight * 0.4) return false;
        // Must not be inside a [role="dialog"] (that's a different modal)
        if (el.closest('[role="dialog"]')) return false;
        // Must not be disabled
        if (el.hasAttribute('disabled')) return false;
        if (el.getAttribute('aria-disabled') === 'true') return false;
        return true;
      };
      const all = Array.from(document.querySelectorAll(
        'div[role="button"], [role="button"], button'
      ));
      // Sort by vertical position descending — prefer buttons closer to the bottom
      const cands = all.filter(isFinalPublish).sort((a, b) => {
        return b.getBoundingClientRect().top - a.getBoundingClientRect().top;
      });
      if (cands.length) {
        try { cands[0].click(); return true; } catch {}
      }
      return false;
    }).catch(() => false);
    if (!publishClicked) await page.waitForTimeout(1000);
  }

  if (publishClicked) log(`  ✓ Publish clicked!`);
  else log(`  ⚠ Publish button not found or disabled after 15s`);

  // ---------- Step 7: Handle "Your bulk upload is processing!" popup ----------
  // Screenshot shows: modal title "Your bulk upload is processing!" with a
  // subtitle and a blue "Done" button on the right. We wait up to 60s for
  // it to appear, then click Done. FB uses <div role="button"> with nested
  // spans — same click strategy as Publish (search deep, prefer visible).
  log(`  Waiting up to 90 seconds for 'processing' popup...`);
  const popupStart = Date.now();
  let popupClicked = false;
  while (Date.now() - popupStart < 90000) {
    const clicked = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      for (const dlg of dialogs) {
        const dlgText = (dlg.innerText || '').toLowerCase();
        // Match "Your bulk upload is processing!" OR generic "processing"/"bulk upload"
        if (!(dlgText.includes('processing') || dlgText.includes('bulk upload'))) continue;
        // Find any button whose (deep) text is Done/OK/etc.
        const btns = Array.from(dlg.querySelectorAll(
          'div[role="button"], [role="button"], button, a[role="button"]'
        ));
        for (const b of btns) {
          const t = (b.innerText || '').trim().toLowerCase();
          if (t === 'done' || t === 'ok' || t === 'okay' ||
              t === 'terminé' || t === 'listo' || t === 'ঠিক আছে') {
            const r = b.getBoundingClientRect();
            if (r.width < 20 || r.height < 15) continue;
            try { b.click(); return true; } catch {}
          }
        }
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      popupClicked = true;
      log(`  ✓ 'Your bulk upload is processing!' popup — clicked 'Done'.`);
      break;
    }
    await page.waitForTimeout(1500);
  }

  if (!popupClicked) log(`  ⚠ processing popup did not appear within 90s`);

  // ---------- Step 8: Dismiss any SECOND popup that appears after Done ----------
  // After clicking Done, FB sometimes shows a small confirmation / thank-you
  // popup with a cross (X) icon that must be closed for the flow to finish.
  // We poll for up to 30s and dismiss any remaining dialog.
  log(`  Watching for a follow-up popup (X to close)...`);
  const followUpStart = Date.now();
  let followUpClosed = false;
  while (Date.now() - followUpStart < 30000) {
    const closed = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      for (const dlg of dialogs) {
        // Try the X / Close button first (aria-label based)
        const closers = Array.from(dlg.querySelectorAll(
          '[aria-label="Close"], [aria-label="Dismiss"], [aria-label="close"], [aria-label="dismiss"], [aria-label="বন্ধ করুন"], [aria-label="Fermer"], [aria-label="Cerrar"]'
        ));
        for (const c of closers) {
          const r = c.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          try { c.click(); return true; } catch {}
        }
        // Fallback: any button whose text is "×" / "Close" / "OK" / "Got it"
        const btns = Array.from(dlg.querySelectorAll(
          'div[role="button"], [role="button"], button'
        ));
        for (const b of btns) {
          const t = (b.innerText || '').trim().toLowerCase();
          const al = (b.getAttribute('aria-label') || '').toLowerCase();
          if (t === '×' || t === 'x' || t === 'close' || t === 'ok' ||
              t === 'got it' || t === 'okay' || t === 'dismiss' ||
              al.includes('close') || al.includes('dismiss')) {
            try { b.click(); return true; } catch {}
          }
        }
      }
      return false;
    }).catch(() => false);
    if (closed) {
      followUpClosed = true;
      log(`  ✓ Follow-up popup closed.`);
      await page.waitForTimeout(1500);
      // there may be more — keep trying up to end of window
      continue;
    }
    // If no more dialogs exist at all, we're done
    const anyDialog = await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length).catch(() => 0);
    if (anyDialog === 0 && followUpClosed) break;
    await page.waitForTimeout(1500);
  }

  // Random cool-down before closing (matches V1.4 behavior)
  const waitSec = 5 + Math.floor(Math.random() * 5);   // 5-9 seconds
  log(`  Waiting randomly for ${waitSec} seconds before closing...`);
  await page.waitForTimeout(waitSec * 1000);

  await updateProfileStatus(profile.uid, { upload_status: 'Upload Success' }).catch(() => {});
  log(`  ✓ Video upload flow complete!`);
}

async function autoPageCreation(page, profile, cfg, log) {
  await page.goto('https://www.facebook.com/pages/create', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
  // TODO: fill category & name — selectors vary. Stub only.
  await updateProfileStatus(profile.uid, {
    page_status: 'Page has no issues',
    page_name: cfg.pageName || `${profile.name} Page`,
    pages_count: (profile.pages_count || 0) + 1,
  });
  log('  → Page created (stub)');
}

async function autoInteraction(page, profile, cfg, log) {
  await page.goto('https://www.facebook.com', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 800); await page.waitForTimeout(1200); }
  log('  → Feed scrolled 5x (interaction stub)');
}

async function autoUploadStory(page, profile, cfg, log) {
  const media = cfg.mediaPath;
  if (!media) throw new Error('mediaPath (image/video) required');
  await page.goto('https://www.facebook.com/stories/create', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const input = await page.$('input[type="file"]').catch(() => null);
  if (input) await input.setInputFiles(media);
  await page.waitForTimeout(5000);
  log('  → Story uploaded (stub)');
}

async function autoJoinGroups(page, profile, cfg, log) {
  const groups = cfg.groupLinks || [];
  if (!groups.length) throw new Error('groupLinks array required');
  for (const link of groups) {
    if (taskState.stopRequested) break;
    await page.goto(link, { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: /join group/i }).click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  log(`  → Attempted to join ${groups.length} groups`);
}

async function autoPostToGroups(page, profile, cfg, log) {
  const groups = cfg.groupLinks || [];
  const text = cfg.postText || '';
  if (!groups.length || !text) throw new Error('groupLinks + postText required');
  for (const link of groups) {
    if (taskState.stopRequested) break;
    await page.goto(link, { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(3000);
    // TODO: click composer, type, submit (stub)
  }
  log(`  → Posted (stub) to ${groups.length} groups`);
}

// ============================================================
// POPUP WATCHDOG for Auto Comments (Random + Targeted)
// Every 3s dismisses any FB modal (violation notices, "What happened",
// cookie banners, save-info prompts, dialog X-close). Auto-stops when
// the page closes. Non-fatal — errors are swallowed silently.
// ============================================================
function installCommentPopupWatchdog(page) {
  if (!page || page._popupWatchdogInstalled) return () => {};
  page._popupWatchdogInstalled = true;

  const dismissPopups = async () => {
    for (let round = 0; round < 5; round++) {
      let closedSomething = false;
      try {
        closedSomething = await page.evaluate(() => {
          let didClose = false;

          // 1) Cookie banner buttons
          const cookieBtns = Array.from(document.querySelectorAll(
            '[data-cookiebanner] button, [aria-label*="cookie" i] button'
          ));
          for (const b of cookieBtns) {
            const t = (b.innerText || '').trim().toLowerCase();
            if (['allow all', 'accept all', 'accept', 'only allow essential', 'allow essential cookies'].includes(t)) {
              try { b.click(); didClose = true; } catch {}
            }
          }

          // 2) All [role="dialog"] modals — click their X (close) button
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
          for (const dlg of dialogs) {
            // Prefer aria-label close button (X icon)
            const closeBtn = dlg.querySelector(
              '[aria-label="Close"], [aria-label="close"], ' +
              '[aria-label="Fermer"], [aria-label="Cerrar"], ' +
              '[aria-label="Dismiss"], [aria-label="বন্ধ করুন"], ' +
              '[aria-label="বন্ধ"]'
            );
            if (closeBtn) {
              try { closeBtn.click(); didClose = true; continue; } catch {}
            }

            // Fallback: aria-label containing "close"/"dismiss" in any language
            const allBtns = dlg.querySelectorAll('[role="button"], button, div[tabindex]');
            for (const b of allBtns) {
              const label = (b.getAttribute('aria-label') || '').toLowerCase();
              if (label && (label.includes('close') || label.includes('dismiss') ||
                            label.includes('fermer') || label.includes('cerrar'))) {
                try { b.click(); didClose = true; break; } catch {}
              }
            }
            if (didClose) continue;

            // Fallback: text-button "Not now", "OK", "Got it", etc.
            const textBtns = dlg.querySelectorAll('button, [role="button"], div[role="button"]');
            const okNeedles = [
              'not now', 'ok', 'okay', 'got it', 'dismiss', 'cancel',
              'skip', 'later', 'no thanks', 'maybe later', 'close',
              'plus tard', 'pas maintenant', 'compris', 'annuler',
              'ahora no', 'entendido', 'cancelar',
              'বুঝেছি', 'ঠিক আছে', 'বাদ দিন', 'পরে',
            ];
            for (const b of textBtns) {
              const t = (b.innerText || '').trim().toLowerCase();
              if (!t || t.length > 40) continue;
              if (okNeedles.some(n => t === n || t.startsWith(n))) {
                try { b.click(); didClose = true; break; } catch {}
              }
            }
          }

          // 3) Top-level notification banners
          const bannerCloses = Array.from(document.querySelectorAll(
            'div[aria-label="Close"], div[aria-label="Dismiss"]'
          ));
          for (const b of bannerCloses) {
            try { b.click(); didClose = true; } catch {}
          }

          return didClose;
        });
      } catch {}

      // Safety net — Escape key
      try { await page.keyboard.press('Escape'); } catch {}

      if (!closedSomething) break;
      await new Promise(r => setTimeout(r, 700 + Math.floor(Math.random() * 500)));
    }
  };

  const interval = setInterval(() => {
    dismissPopups().catch(() => {});
  }, 3000);

  // Auto-stop when page closes
  const stop = () => { try { clearInterval(interval); } catch {} };
  try { page.on('close', stop); } catch {}
  try {
    const ctx = page.context && page.context();
    if (ctx) ctx.on('close', stop);
  } catch {}

  return stop;
}

async function autoComments(page, profile, cfg, mode, log) {
  // Set live status "Commenting..." immediately so the profile card shows it.
  // On success we set "Comment Success" at the end of each mode. On any
  // failure the catch wrapper below sets "Comment Failed". This mirrors the
  // Upload Status pattern exactly.
  try {
    await updateProfileStatus(profile.uid, { comment_status: 'Commenting...' }).catch(() => {});
    emitTask();   // nudge UI to refresh the profile list right now
  } catch {}

  try {
    return await _autoCommentsImpl(page, profile, cfg, mode, log);
  } catch (err) {
    // Mark this profile as failed so the "Comment Status" column shows Comment Failed
    try {
      await updateProfileStatus(profile.uid, { comment_status: 'Comment Failed' }).catch(() => {});
      emitTask();
    } catch {}
    throw err;   // rethrow so task runner counts it as failed
  }
}

async function _autoCommentsImpl(page, profile, cfg, mode, log) {
  const comments = (cfg.comments || []).filter(Boolean);
  if (!comments.length) throw new Error('comments pool is empty — provide at least one comment');

  // Silent popup watchdog — auto-dismiss any FB modal that pops up while
  // this account is commenting. Auto-stops when page/context closes.
  installCommentPopupWatchdog(page);

  // ============================================================
  // AUTO COMMENTS (RANDOM) — Reel-based watch-then-comment
  //
  // User's exact spec:
  //   1. Open  https://www.facebook.com/reel/?s=tab
  //   2. Watch 10 reels back-to-back (10 sec each — no commenting)
  //   3. On the 11th reel, post 1 random comment from the pool
  //   4. Then watch another 10 reels, comment on the 22nd
  //   5. Continue until target count (commentsPerProfile) is reached
  //   6. Then close the session/browser
  //
  // Same delay logic + bot-avoidance as Targeted — only difference is
  // WHICH reels get commented (every 11th, not keyword-matched).
  // ============================================================
  if (mode === 'random') {
    const targetCount   = Math.max(1, cfg.commentsPerProfile || 10);
    const watchPerCycle = Math.max(1, cfg.watchPerCycle || 10);  // watch N, then comment on (N+1)th
    const secPerReel    = Math.max(1, cfg.secondsPerReel || 10); // 10 sec per reel
    const minDelayMs    = (Math.max(5, cfg.minDelaySec || 25)) * 1000;   // after-comment cooldown
    const maxDelayMs    = (Math.max(minDelayMs / 1000, cfg.maxDelaySec || 70)) * 1000;

    const REELS_TAB = 'https://www.facebook.com/reel/?s=tab';
    log(`  · RANDOM mode | target=${targetCount} comments | watch ${watchPerCycle} reels → comment on next reel`);
    log(`  · ${secPerReel}s per reel · post-comment cooldown ${cfg.minDelaySec||25}-${cfg.maxDelaySec||70}s`);

    log(`  · Step 1 — opening ${REELS_TAB}`);
    await page.goto(REELS_TAB, { timeout: 60000, waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(5000);
    await dismissFacebookPopups(page, log).catch(() => {});
    try {
      await page.waitForSelector('video, div[data-pagelet*="Reel" i], div[aria-label*="reel" i]',
        { timeout: 20000 });
    } catch (_) { log('  · reels player render timeout — continuing anyway'); }
    await page.waitForTimeout(2000);

    const seenReels = new Set();
    let commented = 0;
    let watchedInCycle = 0;
    let totalScanned = 0;
    let consecutiveEmpty = 0;
    const MAX_EMPTY = 20;

    const emitProgress = () => {
      try {
        const upcomingSlot = commented + 1;
        const inCycle = Math.min(watchedInCycle, watchPerCycle);
        const _msg = `Random Comments Posted: ${commented}/${targetCount} · Watching ${inCycle}/${watchPerCycle} in cycle ${upcomingSlot}`; if (log.setStatus) log.setStatus(_msg); else taskState.currentInfo = _msg;
        emitTask();
      } catch (_) {}
    };
    emitProgress();

    while (commented < targetCount && !taskState.stopRequested) {
      if (taskState.paused) {
        log('  · paused — waiting...');
        while (taskState.paused && !taskState.stopRequested) await page.waitForTimeout(1000);
        if (taskState.stopRequested) break;
      }

      // Identify current reel
      let reelUrl;
      try { reelUrl = page.url(); } catch (_) { reelUrl = ''; }
      const reelId = extractReelId(reelUrl);

      if (!reelId) {
        consecutiveEmpty++;
        if (consecutiveEmpty > MAX_EMPTY) { log(`  · giving up after ${MAX_EMPTY} unresolvable URLs in a row`); break; }
        await advanceToNextReel(page);
        await page.waitForTimeout(1500);
        continue;
      }

      if (seenReels.has(reelId)) {
        consecutiveEmpty++;
        if (consecutiveEmpty > MAX_EMPTY) { log(`  · giving up after ${MAX_EMPTY} duplicates — feed exhausted?`); break; }
        await advanceToNextReel(page);
        await page.waitForTimeout(1500);
        continue;
      }

      seenReels.add(reelId);
      totalScanned++;
      consecutiveEmpty = 0;
      const canonicalReelUrl = `https://www.facebook.com/reel/${reelId}`;

      // Decide: is this a "watch" reel or a "comment" reel?
      // We watched `watchPerCycle` reels, so THIS one (the next one) is the commenting reel.
      const shouldComment = (watchedInCycle >= watchPerCycle);

      if (!shouldComment) {
        // WATCH phase — watch this reel for secPerReel seconds, no interaction
        watchedInCycle++;
        log(`  · [watch ${watchedInCycle}/${watchPerCycle}] reel ${reelId} — watching ${secPerReel}s...`);
        emitProgress();

        // Sleep in slices so Stop/Pause responds quickly
        const end = Date.now() + (secPerReel * 1000);
        while (Date.now() < end) {
          if (taskState.stopRequested) break;
          if (taskState.paused) {
            while (taskState.paused && !taskState.stopRequested) await page.waitForTimeout(500);
          }
          await page.waitForTimeout(Math.min(500, end - Date.now()));
        }
        if (taskState.stopRequested) break;
      } else {
        // COMMENT phase — this is the (watchPerCycle+1)th reel of the cycle
        log(`  · ★ [comment ${commented + 1}/${targetCount}] reel ${reelId} — opening comment section...`);
        const opened = await openReelCommentsPanel(page, log);
        if (!opened) log('  · could not click Comment button — will still try to type');
        // Wait a moment for the comment input to appear
        try {
          await page.waitForSelector('div[aria-label*="Write a comment" i], div[contenteditable="true"][role="textbox"]',
            { timeout: 5000 });
        } catch (_) {}
        await page.waitForTimeout(1000);

        const pick = comments[Math.floor(Math.random() * comments.length)];
        let posted = false;
        try {
          posted = await postCommentOnReel(page, pick, log);
        } catch (e) {
          log(`  · post threw: ${e.message}`);
          posted = false;
        }

        if (posted) {
          commented++;
          log(`  · ✓ Posted "${pick}" · Total: ${commented}/${targetCount}`);
          emitProgress();

          // Reset watch cycle for next round
          watchedInCycle = 0;

          if (commented >= targetCount) {
            log(`  · ✓ REACHED TARGET ${targetCount}/${targetCount} — stopping`);
            break;
          }

          // Bot-avoidance cooldown between comments (interruptible)
          const wait = Math.floor(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
          log(`  · waiting ${Math.round(wait / 1000)}s before starting next watch cycle...`);
          const end = Date.now() + wait;
          while (Date.now() < end) {
            if (taskState.stopRequested) break;
            if (taskState.paused) {
              while (taskState.paused && !taskState.stopRequested) await page.waitForTimeout(500);
            }
            await page.waitForTimeout(Math.min(500, end - Date.now()));
          }
          if (taskState.stopRequested) break;
        } else {
          log('  · ✗ could not post — treating as watched, will retry on next reel');
          // Don't advance the cycle counter — try again on the next reel
        }
      }

      // Advance to next reel (uses same verified-advance logic as Targeted)
      const advanced = await advanceToNextReel(page);
      if (!advanced) log('  · ⚠ could not advance (URL unchanged after retries)');
      await page.waitForTimeout(1500 + Math.random() * 800);
      await dismissFacebookPopups(page, log).catch(() => {});
    }

    const _msgDone = `Random Comments Posted: ${commented}/${targetCount} · Done`; if (log.setStatus) log.setStatus(_msgDone); else taskState.currentInfo = _msgDone;
    emitTask();
    log(`  → FINAL: ${profile.name} — reels-viewed=${totalScanned} · comments-posted=${commented}/${targetCount}`);
    await updateProfileStatus(profile.uid, { comment_status: 'Comment Success' }).catch(() => {});
    emitTask();
    return;
  }

  // ============================================================
  // AUTO COMMENTS (TARGETED) — Targeted Reel Comment Finder
  //
  // User's exact spec:
  //   Loop: Reel → Open comments → Search keyword → Match → POST comment →
  //         SAVE to matched_reels.txt → Update progress → Next reel
  //   The session/browser must NEVER close after 1 match.
  //   It continues until N successful matched-and-commented reels are done
  //   (N = commentsPerProfile, default 10). Then and only then close.
  // ============================================================
  const keywords = (cfg.targetKeywords || []).map(k => (k || '').toLowerCase().trim()).filter(Boolean);
  if (!keywords.length) throw new Error('targetKeywords required — provide at least one keyword/link');

  const targetCount = Math.max(1, cfg.commentsPerProfile || 10);
  const minDelayMs  = (Math.max(5, cfg.minDelaySec || 25)) * 1000;   // post-comment delay
  const maxDelayMs  = (Math.max(minDelayMs / 1000, cfg.maxDelaySec || 70)) * 1000;

  const REELS_TAB = 'https://www.facebook.com/reel/?s=tab';
  log(`  · TARGETED mode | target=${targetCount} matches | keywords=[${keywords.join(', ')}]`);
  log(`  · matched_reels.txt: ${MATCHED_REELS_FILE}`);

  // Step 1: open Reels tab (stable, generous wait — pre-optimization)
  log(`  · Step 1 — opening ${REELS_TAB}`);
  await page.goto(REELS_TAB, { timeout: 60000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(5000);
  await dismissFacebookPopups(page, log).catch(() => {});
  try {
    await page.waitForSelector('video, div[data-pagelet*="Reel" i], div[aria-label*="reel" i]',
      { timeout: 20000 });
  } catch (_) { log('  · reels player render timeout — continuing anyway'); }
  await page.waitForTimeout(2000);

  const seenReels = new Set();
  const matchedQueue = [];  // in-memory list of matched reels for this run
  let scanned = 0;
  let consecutiveEmpty = 0;
  const MAX_EMPTY = 20;

  // Emit progress helper — writes into taskState.currentInfo so the UI can show it
  const emitProgress = () => {
    try {
      const _msgT = `Targeted Reels Found: ${matchedQueue.length}/${targetCount} · Scanning...`; if (log.setStatus) log.setStatus(_msgT); else taskState.currentInfo = _msgT;
      emitTask();
    } catch (_) {}
  };
  emitProgress();

  // ───── Main scanning loop — runs until matched count reaches target ─────
  while (matchedQueue.length < targetCount && !taskState.stopRequested) {
    // Pause support
    if (taskState.paused) {
      log('  · paused — waiting...');
      while (taskState.paused && !taskState.stopRequested) await page.waitForTimeout(1000);
      if (taskState.stopRequested) break;
    }

    // Step 2: identify current reel
    let reelUrl;
    try { reelUrl = page.url(); } catch (_) { reelUrl = ''; }
    const reelId = extractReelId(reelUrl);

    if (!reelId) {
      consecutiveEmpty++;
      log(`  · [skip] no reel id in URL (${reelUrl || 'n/a'}) — advancing`);
      if (consecutiveEmpty > MAX_EMPTY) {
        log(`  · giving up after ${MAX_EMPTY} unresolvable URLs in a row`);
        break;
      }
      await advanceToNextReel(page);
      await page.waitForTimeout(2500);
      continue;
    }

    if (seenReels.has(reelId)) {
      consecutiveEmpty++;
      if (consecutiveEmpty > MAX_EMPTY) {
        log(`  · giving up after ${MAX_EMPTY} duplicate reels — feed exhausted?`);
        break;
      }
      await advanceToNextReel(page);
      await page.waitForTimeout(2500);
      continue;
    }

    seenReels.add(reelId);
    scanned++;
    consecutiveEmpty = 0;
    const canonicalReelUrl = `https://www.facebook.com/reel/${reelId}`;
    log(`  · [scan ${scanned}] Step 2 — current reel: ${canonicalReelUrl}`);

    // Step 3: open comment panel (stable — generous waits)
    log('  · Step 3 — opening comment section...');
    const opened = await openReelCommentsPanel(page, log);
    if (!opened) log('  · could not click a Comment button — will still try to read whatever is visible');
    try {
      await page.waitForSelector('div[role="article"], div[aria-label*="omment" i]', { timeout: 6000 });
    } catch (_) {}
    await page.waitForTimeout(1500);

    // Step 4: scan EACH existing comment for target keyword/link
    log('  · Step 4 — scanning comments for keywords...');
    let commentEntries = [];
    try { commentEntries = await readCommentsList(page); } catch (_) {}
    log(`  · found ${commentEntries.length} visible comments`);
    // Show ALL visible comments in the log so user can verify what's being scanned
    if (commentEntries.length > 0) {
      const preview = commentEntries.map((c, i) =>
        `      [${i + 1}] "${c.replace(/\s+/g, ' ').trim().slice(0, 120)}${c.length > 120 ? '…' : ''}"`
      ).join('\n');
      log(preview);
    }

    let match = null;
    for (const entry of commentEntries) {
      const low = entry.toLowerCase();
      for (const kw of keywords) {
        if (low.includes(kw)) { match = { comment: entry, keyword: kw }; break; }
      }
      if (match) break;
    }

    // Step 5: match found → post + save + emit progress → CONTINUE
    if (match) {
      log(`  · ✓ MATCH — keyword "${match.keyword}" found in a comment`);
      log(`  ·   matched comment: "${truncate(match.comment, 120)}"`);

      const pick = comments[Math.floor(Math.random() * comments.length)];
      let posted = false;
      try {
        posted = await postCommentOnReel(page, pick, log);
      } catch (e) {
        log(`  ·   post threw: ${e.message}`);
        posted = false;
      }

      if (posted) {
        matchedQueue.push({
          reelId,
          reelUrl: canonicalReelUrl,
          keyword: match.keyword,
          matchedComment: match.comment,
          postedReply: pick,
          at: new Date().toISOString(),
        });
        try {
          const line =
            `[${new Date().toISOString()}] profile=${profile.uid}\n` +
            `  Reel URL       : ${canonicalReelUrl}\n` +
            `  Matched Keyword: ${match.keyword}\n` +
            `  Comment Text   : ${match.comment.replace(/\s+/g, ' ').trim().slice(0, 500)}\n` +
            `  Posted Reply   : ${pick}\n` +
            `------------------------------------------------------------\n`;
          fs.appendFileSync(MATCHED_REELS_FILE, line, 'utf8');
        } catch (e) { log(`  ·   ⚠ file write failed: ${e.message}`); }

        log(`  · ★ Targeted Reels Found: ${matchedQueue.length}/${targetCount} · posted "${pick}"`);
        emitProgress();

        // Human-like delay between successful comments (bot avoidance)
        const wait = Math.floor(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
        log(`  · waiting ${Math.round(wait / 1000)}s before next reel (bot avoidance)...`);

        // Sleep in short slices so Stop/Pause responds quickly
        const sliceMs = 500;
        const end = Date.now() + wait;
        while (Date.now() < end) {
          if (taskState.stopRequested) break;
          if (taskState.paused) {
            while (taskState.paused && !taskState.stopRequested) await page.waitForTimeout(500);
          }
          await page.waitForTimeout(Math.min(sliceMs, end - Date.now()));
        }
      } else {
        log('  · ✗ could not post reply — input box not found or rate-limited');
        await page.waitForTimeout(5000);
      }
    } else {
      log('  · no keyword match in any comment — skipping');
      await page.waitForTimeout(1500 + Math.random() * 2000);
    }

    // Guarded exit — only break when matched count reaches target
    if (matchedQueue.length >= targetCount) {
      log(`  · ✓ REACHED TARGET ${targetCount}/${targetCount} — stopping scan for this profile`);
      break;
    }

    // Step 6: advance to next reel (advanceToNextReel verifies URL changed,
    // retries with escalating strategies if the first ArrowDown was swallowed)
    log('  · Step 6 — next reel');
    const advanced = await advanceToNextReel(page);
    if (!advanced) log('  · ⚠ could not advance to next reel (URL unchanged after all retries)');
    await page.waitForTimeout(1500 + Math.random() * 800);
    await dismissFacebookPopups(page, log).catch(() => {});
  }

  // Final summary
  const _msgTd = `Targeted Reels Found: ${matchedQueue.length}/${targetCount} · Done`; if (log.setStatus) log.setStatus(_msgTd); else taskState.currentInfo = _msgTd;
  emitTask();
  log(`  → FINAL: ${profile.name} — scanned=${scanned} reels · matched-and-commented=${matchedQueue.length}/${targetCount}`);
  log(`  → matched_reels.txt: ${MATCHED_REELS_FILE}`);
  await updateProfileStatus(profile.uid, { comment_status: 'Comment Success' }).catch(() => {});
  emitTask();
}

// ---------- Helpers for Targeted Reel Comment Finder ----------

function extractReelId(url) {
  if (!url) return null;
  const m = url.match(/\/reel\/(\d{5,})/i) || url.match(/[?&]v=(\d{5,})/i);
  return m ? m[1] : null;
}

function truncate(s, n) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * Advance to the NEXT reel using ArrowDown once.
 * IMPORTANT: focus must be on the reel player area (video / body),
 * NOT the comment panel — otherwise ArrowDown scrolls comments instead.
 * We ensure this by clicking on the <video> element (or body outside the
 * comment dialog) right before pressing the key.
 */
/**
 * Advance to the NEXT reel. VERIFIES the URL actually changed —
 * if the first ArrowDown was swallowed (comment input focus / panel scroll),
 * it retries with an escalating strategy up to 3 attempts.
 */
async function advanceToNextReel(page) {
  let beforeUrl = '';
  try { beforeUrl = page.url(); } catch (_) {}

  const strategies = [
    // Attempt 1: blur any editable + focus video, then ArrowDown
    async () => {
      await page.evaluate(() => {
        try {
          const a = document.activeElement;
          if (a && typeof a.blur === 'function') a.blur();
          const v = document.querySelector('video');
          if (v && v.offsetParent !== null) v.focus();
          document.body.focus();
        } catch (_) {}
      });
      await page.keyboard.press('ArrowDown');
    },
    // Attempt 2: click on the video element itself, then ArrowDown
    async () => {
      try {
        const v = await page.$('video');
        if (v) {
          const box = await v.boundingBox();
          if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          // Fallback: click far-left of viewport (avoids comment panel on the right)
          await page.mouse.click(200, 400);
        }
      } catch (_) {}
      await page.waitForTimeout(200);
      await page.keyboard.press('ArrowDown');
    },
    // Attempt 3: try the "Next" arrow button on the reel player (right rail down arrow)
    async () => {
      const clicked = await page.evaluate(() => {
        // Facebook's reel player has a "Next" button, sometimes aria-label="Next card"
        const nextSelectors = [
          'div[aria-label="Next card" i][role="button"]',
          'div[aria-label*="Next" i][role="button"]',
          'div[aria-label="Scroll to next reel" i]',
        ];
        for (const sel of nextSelectors) {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) { btn.click(); return true; }
        }
        return false;
      }).catch(() => false);
      if (!clicked) {
        // Last resort: press J (Facebook video shortcut for next)
        try { await page.keyboard.press('KeyJ'); } catch (_) {}
      }
    },
  ];

  for (let i = 0; i < strategies.length; i++) {
    try { await strategies[i](); } catch (_) {}
    // Wait a moment for URL to update
    await page.waitForTimeout(1200);
    let afterUrl = '';
    try { afterUrl = page.url(); } catch (_) {}
    if (afterUrl && afterUrl !== beforeUrl) return true;  // ✓ reel changed
  }
  return false;  // all strategies exhausted — caller will count as empty
}

/**
 * Try to open the reel's Comment panel by clicking the "Comment" icon
 * button that sits in the right-side rail beside the reel.
 * Multiple selector variants because Facebook A/B-tests these constantly.
 * Returns true if a button was actually clicked.
 */
async function openReelCommentsPanel(page, log = () => {}) {
  // If a comment input is already visible, the panel is already open
  const alreadyOpen = await page.$('div[aria-label*="Write a comment" i], div[contenteditable="true"][role="textbox"]');
  if (alreadyOpen && await alreadyOpen.isVisible().catch(() => false)) return true;

  const selectorGroups = [
    'div[aria-label="Comment" i][role="button"]',
    'div[aria-label*="Comment" i][role="button"]',
    'div[role="button"][aria-label*="omment"]',
    '[aria-label="View comments" i]',
    '[aria-label*="View comment" i]',
    // Sometimes the button holds an <svg aria-label="Comment">
    'div[role="button"]:has(svg[aria-label*="Comment" i])',
  ];
  for (const sel of selectorGroups) {
    try {
      const btns = await page.$$(sel);
      for (const btn of btns) {
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;
        // Only click the RIGHT-rail button (skip generic "Comment on this post" toggles elsewhere)
        const box = await btn.boundingBox().catch(() => null);
        const vp = page.viewportSize() || { width: 1280, height: 800 };
        // Prefer buttons on the right half of the viewport (reel rail)
        if (box && box.x < vp.width * 0.4) continue;
        await btn.click({ delay: 80 }).catch(() => {});
        return true;
      }
    } catch (_) {}
  }
  return false;
}

/**
 * Return an array of visible existing comment TEXT strings (one per comment).
 * We walk `div[role="article"]` elements inside any open dialog/panel,
 * because Facebook wraps each comment in its own article node.
 */
async function readCommentsList(page) {
  // Scroll the comment panel to load lazy comments before scanning.
  // Facebook reels: comments live in the right-side panel (NOT a dialog).
  // We identify the panel by proximity to the "Comment as ..." / "Write a comment"
  // placeholder or to any commented-on aria structure, then scroll it up to
  // trigger lazy render, then extract text from likely comment nodes.

  try {
    await page.evaluate(async () => {
      // Find the scrollable container that holds the comments list.
      // Strategy: locate the comment composer placeholder, walk up to a
      // scrollable ancestor, then scroll that ancestor to top+bottom to
      // trigger lazy loading of the comments above.
      const findComposer = () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
        let node;
        while ((node = walker.nextNode())) {
          const aria = (node.getAttribute && node.getAttribute('aria-label') || '').toLowerCase();
          const text = (node.innerText || '').trim().toLowerCase();
          if (aria.startsWith('comment as ') || aria.startsWith('write a comment') ||
              text.startsWith('comment as ') || (text.startsWith('write a comment') && text.length < 40)) {
            return node;
          }
        }
        return null;
      };
      const composer = findComposer();
      if (!composer) return;

      // Walk up and find nearest scrollable ancestor
      let scroller = composer;
      for (let up = 0; up < 20 && scroller; up++) {
        const style = window.getComputedStyle(scroller);
        const oy = style.overflowY;
        if ((oy === 'auto' || oy === 'scroll') && scroller.scrollHeight > scroller.clientHeight + 20) {
          break;
        }
        scroller = scroller.parentElement;
      }
      if (!scroller || scroller === document.body) {
        // Fallback: scroll main window
        window.scrollBy(0, 400);
        await new Promise(r => setTimeout(r, 500));
        window.scrollBy(0, -400);
        return;
      }

      // Scroll to top of comment panel to load older comments
      const originalScroll = scroller.scrollTop;
      scroller.scrollTop = 0;
      await new Promise(r => setTimeout(r, 700));
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise(r => setTimeout(r, 500));
      scroller.scrollTop = originalScroll;
      await new Promise(r => setTimeout(r, 300));
    }).catch(() => {});
  } catch (_) {}

  // Give comments a moment to render after scrolling
  await page.waitForTimeout(800);

  return await page.evaluate(() => {
    const out = [];
    const seen = new Set();

    // Multiple root strategies — try each and merge results
    const collectFrom = (root) => {
      // Strategy 1: role="article" nodes (works on some FB layouts)
      root.querySelectorAll('div[role="article"]').forEach(a => {
        const t = (a.innerText || '').trim();
        if (!t || t.length < 2 || t.length > 4000) return;
        // Skip the reel post itself (usually contains UI chrome text)
        if (/Send message|Log Out|More options|Follow|Notifications/i.test(t)) return;
        if (!seen.has(t)) { seen.add(t); out.push(t); }
      });

      // Strategy 2: comment-item aria-labels
      root.querySelectorAll('[aria-label*="Comment by" i], [aria-label*="Reply by" i]').forEach(el => {
        const t = (el.innerText || '').trim();
        if (t && t.length >= 2 && t.length < 4000 && !seen.has(t)) {
          seen.add(t); out.push(t);
        }
      });

      // Strategy 3: LIST items under any UL that looks like a comment list
      // Facebook often wraps comments in <ul><li>...</li></ul>
      root.querySelectorAll('ul[role="list"] li, ul li[data-visualcompletion]').forEach(li => {
        const t = (li.innerText || '').trim();
        // Comment text is usually 1-500 chars; skip huge UI blocks
        if (!t || t.length < 2 || t.length > 2000) return;
        if (/Send message|Log Out|View \d+ repl/i.test(t.slice(0, 50))) return;
        if (!seen.has(t)) { seen.add(t); out.push(t); }
      });

      // Strategy 4: Any element with dir="auto" that has short text and no UI keywords
      // (Facebook wraps comment text in <div dir="auto">)
      root.querySelectorAll('div[dir="auto"]').forEach(d => {
        const t = (d.innerText || '').trim();
        if (!t || t.length < 5 || t.length > 1500) return;
        // Skip if it's a button/interactive UI text
        if (/^(Like|Reply|Share|Save|Follow|Send|Comment|More|Edit|Delete|Hide|Report|View \d+)/i.test(t)) return;
        // Skip pure "See more"/"Translate" links
        if (/^(See more|See original|Translate|Hide translation|Most relevant)/i.test(t)) return;
        if (!seen.has(t)) { seen.add(t); out.push(t); }
      });
    };

    // Try dialog first (some layouts still use one), then body
    const dialogs = document.querySelectorAll('div[role="dialog"]');
    if (dialogs.length) {
      dialogs.forEach(d => collectFrom(d));
    }
    // ALSO always scan body — reels comments are usually not in a dialog
    collectFrom(document.body);

    return out;
  }).catch(() => []);
}

async function postCommentOnReel(page, text, log) {
  return postCommentOnCurrentPost(page, text, log);
}

async function postCommentOnCurrentPost(page, text, log = () => {}) {
  // Facebook Reels comment UI can be in two states:
  //   State A (open):   a contenteditable div is visible and ready for typing
  //   State B (closed): only a placeholder is visible showing "Comment as <name>"
  //                     or "Write a comment" — clicking it reveals the input
  //
  // The placeholder's clickable node may or may not have an aria-label; the
  // text can live in a nested span. So we scan by BOTH aria-label AND text.

  const contentEditableSelectors = [
    'div[aria-label="Write a comment…" i][contenteditable="true"]',
    'div[aria-label*="Write a comment" i][contenteditable="true"]',
    'div[aria-label*="Comment as" i][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'form div[contenteditable="true"]',
  ];

  const findEditable = async () => {
    for (const sel of contentEditableSelectors) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          if (await el.isVisible().catch(() => false)) return el;
        }
      } catch (_) {}
    }
    return null;
  };

  // Find the placeholder — uses Playwright's text-locator which reliably finds
  // React-rendered nested text. Placeholder text is one of:
  //   "Comment as <anyName>"
  //   "Write a comment"
  //   "Write a public comment"
  // Returns the click-target element (walking up to role=button/tabindex=0).
  const findPlaceholderClickTarget = async () => {
    // Try Playwright's text locator — handles nested spans, React text nodes
    const placeholderPatterns = [
      /^\s*Comment as\b/i,
      /^\s*Write a comment/i,
      /^\s*Write a public comment/i,
    ];

    for (const pattern of placeholderPatterns) {
      try {
        const locator = page.locator(`text=${pattern}`).first();
        const count = await locator.count().catch(() => 0);
        if (count === 0) continue;
        const isVis = await locator.isVisible().catch(() => false);
        if (!isVis) continue;

        // Got the text node — now walk up to find the actual clickable container
        const elHandle = await locator.elementHandle({ timeout: 1000 }).catch(() => null);
        if (!elHandle) continue;

        // Check it's not already inside a contenteditable (which would mean input is already open)
        const inside = await elHandle.evaluate(n => {
          let cur = n;
          while (cur) {
            if (cur.getAttribute && cur.getAttribute('contenteditable') === 'true') return true;
            cur = cur.parentElement;
          }
          return false;
        }).catch(() => false);
        if (inside) continue;

        // Walk up to find click target
        const clickTargetHandle = await elHandle.evaluateHandle(n => {
          let target = n;
          for (let up = 0; up < 10; up++) {
            if (!target) break;
            const role = target.getAttribute && target.getAttribute('role');
            const tabindex = target.getAttribute && target.getAttribute('tabindex');
            const clickable = target.tagName === 'BUTTON' ||
                              role === 'button' || role === 'textbox' ||
                              tabindex === '0';
            if (clickable) return target;
            target = target.parentElement;
          }
          return n; // fallback: return original text node's parent element
        }).catch(() => null);

        if (clickTargetHandle) {
          const el = clickTargetHandle.asElement();
          if (el) return el;
        }
        // Fallback: return the text element itself
        return elHandle;
      } catch (_) {}
    }

    // Last-resort fallback: aria-label based scan (previous behavior)
    const handle = await page.evaluateHandle(() => {
      const all = document.querySelectorAll('div[aria-label], span[aria-label]');
      for (const el of all) {
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        if (!aria.startsWith('comment as ') && !aria.startsWith('write a comment') &&
            !aria.startsWith('write a public comment')) continue;
        if (el.getAttribute('contenteditable') === 'true') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) continue;
        // Walk up to click target
        let t = el;
        for (let up = 0; up < 8; up++) {
          const role = t.getAttribute && t.getAttribute('role');
          const tabindex = t.getAttribute && t.getAttribute('tabindex');
          if (t.tagName === 'BUTTON' || role === 'button' || role === 'textbox' || tabindex === '0') return t;
          t = t.parentElement;
          if (!t) break;
        }
        return el;
      }
      return null;
    }).catch(() => null);
    if (!handle) return null;
    const el = handle.asElement();
    return el || null;
  };

  // ── 1. Already-open input? ──
  let input = await findEditable();
  if (input) {
    log('  · comment input already open');
  } else {
    // ── 2. Find placeholder & click it ──
    const placeholder = await findPlaceholderClickTarget();
    if (!placeholder) {
      log('  · ✗ no comment input or placeholder found on this reel');
      return false;
    }

    // Diagnostic: dump what we're about to click
    try {
      const info = await placeholder.evaluate(n => ({
        tag: n.tagName,
        role: n.getAttribute('role') || '',
        aria: n.getAttribute('aria-label') || '',
        text: ((n.innerText || n.textContent || '').trim()).slice(0, 40),
      })).catch(() => null);
      if (info) log(`  · placeholder found: <${info.tag} role="${info.role}" aria="${info.aria}"> "${info.text}"`);
    } catch (_) {}

    log('  · clicking placeholder to reveal input');
    try { await page.bringToFront(); } catch (_) {}
    try { await placeholder.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (_) {}

    let opened = false;
    for (let attempt = 0; attempt < 4 && !opened; attempt++) {
      try {
        if (attempt === 0) {
          await placeholder.click({ delay: 80, timeout: 3000 });
        } else if (attempt === 1) {
          // Mouse click at centre
          const box = await placeholder.boundingBox();
          if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 80 });
        } else if (attempt === 2) {
          // Force click ignoring overlays
          await placeholder.click({ force: true, delay: 80, timeout: 3000 });
        } else {
          // JS dispatch
          await placeholder.evaluate(n => {
            try {
              n.click();
              const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
              n.dispatchEvent(evt);
            } catch (_) {}
          });
        }
        await page.waitForTimeout(800);
        input = await findEditable();
        if (input) { opened = true; break; }
      } catch (e) {
        log(`  · placeholder click attempt ${attempt + 1} failed: ${e.message}`);
      }
    }

    if (!input) {
      log('  · ✗ clicked placeholder but real contenteditable never appeared');
      return false;
    }
    log('  · ✓ contenteditable revealed after placeholder click');
  }

  try {
    // CRITICAL: bring browser tab to front so click actually registers
    // (background/unfocused tabs can silently swallow click events on Facebook)
    try { await page.bringToFront(); } catch (_) {}
    await page.waitForTimeout(150);

    // Scroll input into view (in case it's below fold)
    try { await input.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (_) {}
    await page.waitForTimeout(150);

    // ============================================================
    // Robust focus: try up to 3 methods to actually focus the input
    // ============================================================
    const readInputText = async (el) => {
      try {
        return await el.evaluate(n => (n.innerText || n.textContent || '').trim()).catch(() => '');
      } catch (_) { return ''; }
    };
    const isFocused = async (el) => {
      try { return await el.evaluate(n => document.activeElement === n).catch(() => false); }
      catch (_) { return false; }
    };

    let focused = false;
    for (let attempt = 0; attempt < 3 && !focused; attempt++) {
      try {
        if (attempt === 0) {
          // Method 1: Playwright click (usually works)
          await input.click({ delay: 80, timeout: 3000 });
        } else if (attempt === 1) {
          // Method 2: mouse click at input's centre coords
          const box = await input.boundingBox();
          if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 80 });
        } else {
          // Method 3: JS focus() call directly on the element
          await input.evaluate(n => { try { n.focus(); n.click(); } catch (_) {} });
        }
        await page.waitForTimeout(400);
        focused = await isFocused(input);
        if (focused) break;
      } catch (e) {
        log(`  · focus attempt ${attempt + 1} threw: ${e.message}`);
      }
    }

    if (!focused) {
      log('  · ⚠ could not focus comment input after 3 attempts — will still try to type');
    }

    // Type with realistic per-char delay.
    // IMPORTANT: Facebook treats Enter as SUBMIT in comment boxes, so calling
    // page.keyboard.type() on multi-line text would submit early and split one
    // comment into multiple. Instead we type line-by-line and use Shift+Enter
    // between lines (Facebook interprets Shift+Enter as a newline, not submit).
    const lines = text.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.length > 0) {
        await page.keyboard.type(line, { delay: 40 + Math.floor(Math.random() * 60) });
      }
      if (li < lines.length - 1) {
        // Insert a literal newline WITHOUT submitting
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        await page.waitForTimeout(50);
      }
    }
    await page.waitForTimeout(700 + Math.random() * 600);

    // Verify text actually appeared in the input
    const beforeText = await readInputText(input);
    if (!beforeText) {
      log('  · ✗ type failed — input still empty after typing (browser tab probably not focused)');
      return false;
    }
    log(`  · typed "${beforeText.slice(0, 60)}${beforeText.length > 60 ? '…' : ''}"`);

    // ───── Submission strategies ─────
    // Facebook Reels: Enter often doesn't work reliably (it can create a newline
    // or be swallowed). The reliable path is clicking the "Post" / "Comment" /
    // send-arrow button. We try the button first, then fall back to keyboard.

    const submitViaButton = async () => {
      // Facebook Reels comment box: the submit button is a small blue paper-plane
      // icon to the RIGHT of the input. It usually has NO aria-label (icon-only).
      // We locate it by DOM proximity to the comment input.
      const clicked = await page.evaluate((typedText) => {
        // Find the visible comment input (contenteditable)
        const inputs = Array.from(document.querySelectorAll(
          'div[contenteditable="true"][role="textbox"], div[contenteditable="true"]'
        )).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 50 && r.height > 10 && r.width < 2000;
        });

        for (const input of inputs) {
          // Walk up 6 levels to find a container that also holds the submit button
          let container = input;
          for (let up = 0; up < 6 && container.parentElement; up++) {
            container = container.parentElement;

            // Look for buttons inside this container that are TO THE RIGHT of the input
            const inputRect = input.getBoundingClientRect();
            const buttons = container.querySelectorAll('div[role="button"], button, [aria-label]');
            for (const btn of buttons) {
              if (btn === input) continue;
              const rect = btn.getBoundingClientRect();
              // Must be to the RIGHT of the input, vertically overlapping, and small (icon-sized)
              const isRightOfInput = rect.left >= inputRect.right - 5;
              const isVerticalOverlap = rect.top < inputRect.bottom && rect.bottom > inputRect.top;
              const isSmall = rect.width < 60 && rect.height < 60 && rect.width > 10;
              if (isRightOfInput && isVerticalOverlap && isSmall) {
                // Skip emoji/gif/camera/sticker pickers by aria-label if present
                const lab = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (/emoji|gif|sticker|camera|photo|attach|record|voice|mention/i.test(lab)) continue;
                // This is likely the send button — click it
                try { btn.click(); return { ok: true, method: 'right-of-input', label: lab || '(no label)' }; }
                catch (_) {}
              }
            }
          }
        }

        // Fallback: any aria-label matching send/post/comment/reply that's visible
        const labeled = document.querySelectorAll('div[role="button"][aria-label], button[aria-label]');
        for (const b of labeled) {
          const lab = (b.getAttribute('aria-label') || '').toLowerCase();
          if (!/^(post|send|comment|reply|submit)$/i.test(lab) &&
              !/(post comment|send comment|reply)/i.test(lab)) continue;
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          try { b.click(); return { ok: true, method: 'aria-label', label: lab }; } catch (_) {}
        }

        return { ok: false };
      }, text).catch(() => ({ ok: false }));

      if (clicked && clicked.ok) {
        log(`  · clicked submit button (${clicked.method}: "${clicked.label || '-'}")`);
        return true;
      }
      return false;
    };

    // Verify submission — Facebook clears the comment input after a successful post.
    // We poll for up to ~4s.
    const verifyPosted = async () => {
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(500);
        const now = await readInputText(input).catch(() => '');
        if (!now || now.length === 0) return true;                 // input cleared → posted ✓
        // Some layouts keep the placeholder — check if our typed text is gone
        if (!now.toLowerCase().includes(text.toLowerCase().slice(0, 15))) return true;
      }
      return false;
    };

    // ATTEMPT 1: plain Enter (this works on Facebook Reels — user confirmed)
    let posted = false;
    try {
      await input.click({ delay: 60 }).catch(() => {});
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
    } catch (_) {}
    posted = await verifyPosted();

    // ATTEMPT 2: click the paper-plane / Post button next to the input
    if (!posted) {
      log('  · Enter did not confirm — trying to click submit button');
      const clickedBtn = await submitViaButton();
      if (clickedBtn) posted = await verifyPosted();
    }

    // ATTEMPT 3: Ctrl+Enter (power-user shortcut)
    if (!posted) {
      log('  · submit button did not confirm — trying Ctrl+Enter');
      try {
        await input.click({ delay: 60 }).catch(() => {});
        await page.waitForTimeout(200);
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');
      } catch (_) {}
      posted = await verifyPosted();
    }

    // CRITICAL: release keyboard focus from the input so the next ArrowDown
    // actually navigates to the next reel (not scrolls the comment panel).
    try {
      await page.evaluate(() => {
        try {
          const active = document.activeElement;
          if (active && typeof active.blur === 'function') active.blur();
          const v = document.querySelector('video');
          if (v) v.focus();
          document.body.focus();
        } catch (_) {}
      });
    } catch (_) {}

    if (posted) {
      log('  · ✓ comment confirmed posted (input cleared)');
      return true;
    }

    log('  · ✗ comment NOT confirmed posted — input still contains typed text after all 3 attempts');
    return false;
  } catch (e) {
    log(`  · type/submit failed: ${e.message}`);
    return false;
  }
}

// ============================================================
// Bulk import validation — spawns headless browsers in parallel,
// tests each cookie set with a real login, returns valid/dead split.
// Concurrency is limited so the OS doesn't crash on 100+ imports.
// ============================================================
async function validateImportedProfiles(rows, opts = {}) {
  const concurrency = Math.max(1, Math.min(10, opts.concurrency || 5));
  const emit = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const emitLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  const results = []; // { row, uid, valid, reason, method, status }
  let done = 0;

  emitLog(`━━━ Validating ${rows.length} accounts with ${concurrency} parallel browsers (headless)... ━━━`);
  emit({ total: rows.length, done: 0, valid: 0, dead: 0 });

  let idx = 0;
  const worker = async (wid) => {
    while (idx < rows.length) {
      const my = idx++;
      const row = rows[my];
      const uid = String(row.uid || '').trim();
      const cookies = String(row.cookies || '').trim();
      const name = String(row.name || '').trim() || `Profile ${uid}`;

      // Quick pre-filter — no uid or no cookies means dead immediately
      if (!uid) {
        results[my] = { row, uid, valid: false, reason: 'missing uid', method: 'skip' };
        done++;
        const validSoFar = results.filter(r => r && r.valid).length;
        const deadSoFar = done - validSoFar;
        emit({ total: rows.length, done, valid: validSoFar, dead: deadSoFar, current: name });
        continue;
      }
      if (!cookies) {
        results[my] = { row, uid, valid: false, reason: 'no cookies', method: 'skip' };
        done++;
        const validSoFar = results.filter(r => r && r.valid).length;
        const deadSoFar = done - validSoFar;
        emit({ total: rows.length, done, valid: validSoFar, dead: deadSoFar, current: name });
        emitLog(`  [W${wid}] ✗ ${uid} — no cookies`);
        continue;
      }

      emitLog(`  [W${wid}] ▶ testing ${uid} (${name})...`);

      let context;
      let valid = false;
      let reason = '';
      let status = '';
      let method = '';

      try {
        // Build a temporary profile-like object for launchForProfile
        const tempProfile = {
          uid, name,
          cookies,
          password: '', // don't try password during import validation — cookies only
          two_fa: '',
          proxy: String(row.proxy || '').trim(),
        };
        // Headless mode: Facebook detects headless and shows checkpoint even for
        // valid cookies. Use non-headless (windowed). We spawn many browsers in
        // parallel but they auto-close so it's fine.
        context = await launchForProfile(tempProfile, false /* NOT headless */);
        activeContexts.add(context);
        const page = context.pages()[0] || await context.newPage();

        const cookieList = parseCookies(cookies);
        if (!cookieList.length) throw new Error('cookie parse failed');
        await context.addCookies(cookieList);

        // Load Facebook — give it enough time for JS/cookies to settle
        await page.goto('https://www.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);
        await dismissFacebookPopups(page, () => {}).catch(() => {});
        await page.waitForTimeout(1000);

        // PRIMARY CHECK: c_user cookie present in the browser context?
        // Facebook only sets c_user for authenticated sessions. If it's there,
        // login is valid regardless of any UI-based state detection.
        const allCookies = await context.cookies('https://www.facebook.com');
        const cUserCookie = allCookies.find(c => c.name === 'c_user');
        const hasCUser = !!(cUserCookie && cUserCookie.value && cUserCookie.value.length > 3);

        method = 'cookies';

        if (hasCUser) {
          // Logged in — now check if account is checkpointed
          const currentUrl = page.url();
          if (/checkpoint|login\.php/i.test(currentUrl)) {
            valid = false;
            reason = 'checkpoint';
            status = 'Checkpoint';
          } else {
            valid = true;
            status = 'Logged in';
            reason = `c_user=${cUserCookie.value.slice(-4)}`;
          }
        } else {
          // No c_user cookie → definitely not logged in
          valid = false;
          status = 'Not logged in';
          reason = 'no c_user cookie after login';
        }
      } catch (e) {
        valid = false;
        reason = e.message || 'validation error';
      } finally {
        try { if (context) { activeContexts.delete(context); await context.close(); } } catch (_) {}
      }

      results[my] = { row, uid, valid, reason, method, status };
      done++;
      const validSoFar = results.filter(r => r && r.valid).length;
      const deadSoFar = done - validSoFar;
      emit({ total: rows.length, done, valid: validSoFar, dead: deadSoFar, current: name });
      emitLog(`  [W${wid}] ${valid ? '✓ VALID' : '✗ DEAD'} ${uid} — ${reason}`);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const validRows = results.filter(r => r && r.valid).map(r => r.row);
  const deadRows = results.filter(r => r && !r.valid).map(r => ({
    ...r.row,
    _dead_reason: r.reason,
    _validation_status: r.status,
  }));

  emitLog(`━━━ Validation done: ${validRows.length} valid · ${deadRows.length} dead ━━━`);
  return { validRows, deadRows, results };
}

// ============================================================
// HTTP-based cookie validator — no browser opens, super fast.
// Uses cookies to make an HTTPS request to facebook.com and detects login
// state from the response (redirects/cookies/body).
// A logged-in session responds with 200 on home page and does NOT redirect
// to /login. Also c_user cookie must be present in the request.
// ============================================================
// Lightweight Playwright validation — real browser (so FB sees legit fingerprint)
// but images/CSS/fonts/media are blocked so each check is 3-4 seconds.
// Uses a shared browser instance with a fresh incognito context per account.
let _validationBrowser = null;
async function getValidationBrowser() {
  if (_validationBrowser && _validationBrowser.isConnected()) return _validationBrowser;
  _validationBrowser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--window-position=20,20',   // keep the window INSIDE the visible display (was -2000,-2000 = offscreen)
      '--window-size=400,300',
    ],
  });
  return _validationBrowser;
}
async function closeValidationBrowser() {
  try { if (_validationBrowser) await _validationBrowser.close(); } catch {}
  _validationBrowser = null;
}

async function quickValidateCookies(cookiesString) {
  const cookieList = parseCookies(cookiesString);
  if (!cookieList.length) return { valid: false, reason: 'no cookies' };

  const cUser = cookieList.find(c => c.name === 'c_user');
  if (!cUser || !cUser.value || cUser.value.length < 3) {
    return { valid: false, reason: 'no c_user in cookies' };
  }

  const browser = await getValidationBrowser();
  let context = null;
  try {
    context = await browser.newContext({
      viewport: { width: 400, height: 300 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    // Inject cookies for facebook.com
    const cookiesForCtx = cookieList
      .filter(c => c.name && c.value)
      .map(c => ({
        name: c.name,
        value: c.value,
        domain: '.facebook.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      }));
    await context.addCookies(cookiesForCtx);

    const page = await context.newPage();

    // Block images/CSS/fonts/media/stylesheets → ~10x faster, no visual cost
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'stylesheet' || t === 'font' || t === 'media') {
        return route.abort();
      }
      return route.continue();
    });

    // Go to /me — logged in → redirects to profile, logged out → /login
    const resp = await page.goto('https://www.facebook.com/me', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    const finalUrl = (page.url() || '').toLowerCase();
    const status = resp ? resp.status() : 0;

    if (finalUrl.includes('/login') || finalUrl.includes('login.php')) {
      return { valid: false, reason: 'redirected to login', status, url: finalUrl };
    }
    if (finalUrl.includes('/checkpoint')) {
      return { valid: false, reason: 'checkpoint', status, url: finalUrl };
    }
    // If we landed anywhere else on facebook.com, cookies worked
    if (finalUrl.includes('facebook.com')) {
      return { valid: true, reason: 'ok', status, url: finalUrl, uid: cUser.value };
    }
    return { valid: false, reason: `unexpected url ${finalUrl}`, status };
  } catch (e) {
    return { valid: false, reason: e.message || 'error' };
  } finally {
    try { if (context) await context.close(); } catch {}
  }
}

// Bulk HTTP validation — parallel, no browser, blazing fast.
async function bulkValidateCookies(rows, opts = {}) {
  // Lightweight-Playwright: 3-4 sec/account, real browser fingerprint (safe for FB)
  const concurrency = Math.max(1, Math.min(6, opts.concurrency || 3));
  const emit = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const emitLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  const results = [];
  let done = 0;
  let idx = 0;

  emitLog(`━━━ Validating ${rows.length} accounts via lightweight browser (images/css blocked) ━━━`);
  emit({ total: rows.length, done: 0, valid: 0, dead: 0 });

  const worker = async () => {
    while (idx < rows.length) {
      const my = idx++;
      const row = rows[my];
      const uid = String(row.uid || '').trim();
      const cookies = String(row.cookies || '').trim();

      let res;
      if (!uid) res = { valid: false, reason: 'missing uid' };
      else if (!cookies) res = { valid: false, reason: 'no cookies' };
      else res = await quickValidateCookies(cookies);

      results[my] = { row, ...res };
      done++;

      const validSoFar = results.filter(r => r && r.valid).length;
      const deadSoFar = done - validSoFar;
      emit({ total: rows.length, done, valid: validSoFar, dead: deadSoFar, current: row.name || uid });
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));
  } finally {
    // Always close the shared validation browser after bulk finishes
    await closeValidationBrowser();
  }

  const validRows = results.filter(r => r && r.valid).map(r => r.row);
  const deadRows = results.filter(r => r && !r.valid).map(r => ({
    ...r.row,
    _dead_reason: r.reason,
  }));

  emitLog(`━━━ Done: ${validRows.length} valid · ${deadRows.length} dead ━━━`);
  return { validRows, deadRows, results };
}

// ============================================================
// Bulk Import with Real Browser Login (like V1.4)
// For each row: spawn a browser → inject cookies → verify login →
// if success, keep in valid list, else discard. Runs N in parallel.
// Each browser closes after its check to free memory.
// ============================================================
async function bulkImportWithBrowserLogin(rows, opts = {}) {
  const concurrency = Math.max(1, Math.min(5, opts.concurrency || 3));
  const headless = opts.headless !== false;   // headless by default = invisible + fast
  const emit = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const emitLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  const results = [];
  let done = 0;
  let idx = 0;

  emitLog(`━━━ Importing ${rows.length} accounts — browser login test (${concurrency} parallel${headless ? ', headless' : ''}) ━━━`);
  emit({ total: rows.length, done: 0, valid: 0, dead: 0 });

  const worker = async () => {
    while (idx < rows.length) {
      const my = idx++;
      const row = rows[my];
      const uid = String(row.uid || '').trim();
      const cookies = String(row.cookies || '').trim();

      emit({
        total: rows.length,
        done,
        valid: results.filter(r => r && r.valid).length,
        dead: done - results.filter(r => r && r.valid).length,
        current: row.name || uid,
      });

      if (!uid) {
        results[my] = { row, valid: false, reason: 'missing uid' };
        done++;
        continue;
      }

      let context = null;
      let page = null;
      let res = { valid: false, reason: 'unknown' };

      try {
        // Build a temp profile object — use in-memory context (no persistent dir)
        // to avoid polluting disk with hundreds of profile folders during import
        const launchOpts = {
          headless,
          viewport: { width: 1280, height: 800 },
          ignoreHTTPSErrors: true,
          locale: 'en-US',
          args: ['--disable-blink-features=AutomationControlled', '--no-default-browser-check'],
        };
        const proxyObj = parseProxy(row.proxy);
        if (proxyObj) launchOpts.proxy = proxyObj;

        // Non-persistent browser for import (faster, no disk clutter)
        // `channel: 'chromium'` → use the already-installed full chromium-1217
        // in the new headless mode. Prevents the chromium-headless-shell
        // "Executable doesn't exist" failure that marked every account as Dead.
        const browser = await chromium.launch({
          headless,
          channel: 'chromium',
          args: ['--disable-blink-features=AutomationControlled', '--no-default-browser-check'],
          proxy: proxyObj,
        });
        try {
          context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            ignoreHTTPSErrors: true,
            locale: 'en-US',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          });
          await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
          });

          page = await context.newPage();
          // Headed run → make sure the window opens INSIDE the visible display
          if (!headless) await ensureWindowOnScreen(context, page);

          // Block images/CSS/fonts to speed up (still real browser, real login)
          await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (t === 'image' || t === 'font' || t === 'media') return route.abort();
            return route.continue();
          });

          // === LOGIN FLOW (mirrors loginProfile, but simpler for import) ===
          const cookieList = parseCookies(cookies);
          let loggedIn = false;
          let method = 'none';
          let reason = '';

          // Cookie login attempt
          if (cookieList.length) {
            try {
              await context.addCookies(cookieList);
              await page.goto('https://www.facebook.com/', { timeout: 30000, waitUntil: 'domcontentloaded' });
              await page.waitForTimeout(2500);

              const ctxCookies = await context.cookies('https://www.facebook.com');
              const hasCUser = ctxCookies.some(c => c.name === 'c_user' && c.value && c.value.length > 3);
              const url = (page.url() || '').toLowerCase();

              if (url.includes('/checkpoint')) {
                reason = 'checkpoint';
              } else if (hasCUser && !url.includes('/login')) {
                loggedIn = true;
                method = 'cookies';
              } else {
                reason = 'cookies not accepted';
              }
            } catch (e) {
              reason = 'cookie error: ' + (e.message || e);
            }
          }

          // Password fallback ONLY if no cookies were provided
          if (!loggedIn && !cookieList.length && row.password) {
            try {
              await page.goto('https://www.facebook.com/login', { timeout: 30000, waitUntil: 'domcontentloaded' });
              await page.waitForTimeout(1500);
              await page.fill('input[name="email"]', String(uid), { timeout: 10000 }).catch(() => {});
              await page.fill('input[name="pass"]', String(row.password), { timeout: 10000 }).catch(() => {});
              await Promise.race([
                page.click('button[name="login"]', { timeout: 10000 }).catch(() => {}),
                page.press('input[name="pass"]', 'Enter').catch(() => {}),
              ]);
              await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
              await page.waitForTimeout(3500);

              const ctxCookies = await context.cookies('https://www.facebook.com');
              const hasCUser = ctxCookies.some(c => c.name === 'c_user' && c.value && c.value.length > 3);
              const url = (page.url() || '').toLowerCase();

              if (url.includes('/checkpoint')) {
                reason = 'checkpoint (password login)';
              } else if (hasCUser && !url.includes('/login')) {
                loggedIn = true;
                method = 'password';
                // Capture fresh cookies for storage
                row._fresh_cookies = JSON.stringify(ctxCookies);
              } else {
                reason = 'password login failed';
              }
            } catch (e) {
              reason = 'password error: ' + (e.message || e);
            }
          }

          if (!loggedIn && !reason) reason = 'no cookies and no password';

          res = loggedIn
            ? { valid: true, reason: 'ok', method }
            : { valid: false, reason };
        } finally {
          try { if (page) await page.close(); } catch {}
          try { if (context) await context.close(); } catch {}
          try { await browser.close(); } catch {}
        }
      } catch (e) {
        res = { valid: false, reason: 'launch error: ' + (e.message || e) };
      }

      results[my] = { row, ...res };
      done++;
      emitLog(`  ${res.valid ? '✓' : '✗'} ${uid} ${row.name || ''} — ${res.reason}`);
      emit({
        total: rows.length,
        done,
        valid: results.filter(r => r && r.valid).length,
        dead: done - results.filter(r => r && r.valid).length,
        current: row.name || uid,
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));

  const validRows = results.filter(r => r && r.valid).map(r => {
    // If password login produced fresh cookies, use them
    if (r.row._fresh_cookies) {
      return { ...r.row, cookies: r.row._fresh_cookies, _fresh_cookies: undefined };
    }
    return r.row;
  });
  const deadRows = results.filter(r => r && !r.valid).map(r => ({
    ...r.row,
    _dead_reason: r.reason,
  }));

  emitLog(`━━━ Done: ${validRows.length} valid · ${deadRows.length} dead ━━━`);
  return { validRows, deadRows, results };
}

// ============================================================
// FACEBOOK LOGIN TOOLS — Standalone Feature
// Totally independent of the rest of the system.
// Reads rows {uid, pass, cookies} → for each:
//   1. Try cookies login
//   2. If cookies fail OR password page shown → try password
//   3. If password login succeeds → capture fresh cookies
//   4. Emits progress + logs
// Returns { successRows: [...], failedRows: [...] }
//   successRows include: uid, pass, cookies (fresh if via password), method
//   failedRows include: uid, pass, cookies, fail_reason
// ============================================================
let _loginToolsStop = false;
function stopLoginTools() { _loginToolsStop = true; }

async function runLoginTools(rows, opts = {}) {
  _loginToolsStop = false;
  const concurrency = Math.max(1, Math.min(20, opts.concurrency || 3));
  const headless = opts.headless !== false;
  // Slow mode: adds human-like delays to avoid FB bot detection
  // 'safe' (default) = randomized 2-5s pauses · 'fast' = old behavior
  const speed = opts.speed === 'fast' ? 'fast' : 'safe';
  const emit = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const emitLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  // Human-like random delay helper
  const humanDelay = async (page, minMs, maxMs) => {
    if (speed === 'fast') { await page.waitForTimeout(Math.min(minMs, 500)); return; }
    const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
    await page.waitForTimeout(ms);
  };
  // Small pre-launch stagger so N browsers don't all hit FB at the exact same ms
  const staggerBeforeLaunch = async () => {
    if (speed === 'fast') return;
    await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random() * 1200)));
  };

  const results = [];
  let done = 0;
  let idx = 0;

  emitLog(`━━━ FB Login Tools: processing ${rows.length} accounts (${concurrency} parallel${headless ? ', headless' : ''}, ${speed} mode) ━━━`);
  emit({ total: rows.length, done: 0, success: 0, failed: 0 });

  const worker = async () => {
    while (idx < rows.length) {
      if (_loginToolsStop) break;
      const my = idx++;
      const row = rows[my];
      const uid = String(row.uid || '').trim();
      const pass = String(row.pass || row.password || '').trim();
      const cookies = String(row.cookies || '').trim();

      emit({
        total: rows.length,
        done,
        success: results.filter(r => r && r.success).length,
        failed: done - results.filter(r => r && r.success).length,
        current: uid || '(no uid)',
      });

      if (!uid) {
        results[my] = { row, success: false, fail_reason: 'missing uid' };
        done++;
        continue;
      }

      let browser = null;
      let context = null;
      let page = null;
      let outcome = { success: false, fail_reason: 'unknown' };
      let freshCookies = null;
      let method = '';
      let popupInterval = null;

      try {
        // Stagger before launch to avoid burst-of-N-browsers signature
        await staggerBeforeLaunch();
        // `channel: 'chromium'` → use the already-installed full chromium-1217
        // in the new headless mode. Prevents the chromium-headless-shell
        // "Executable doesn't exist" failure that failed every login attempt.
        browser = await chromium.launch({
          headless,
          channel: 'chromium',
          args: ['--disable-blink-features=AutomationControlled', '--no-default-browser-check'],
        });
        context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          ignoreHTTPSErrors: true,
          locale: 'en-US',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        page = await context.newPage();
        // Headed run → make sure the window opens INSIDE the visible display
        if (!headless) await ensureWindowOnScreen(context, page);

        // NOTE: no resource blocking — let the page load fully with images/CSS
        // so it looks like a real user session (prevents blank-page detection).

        // Popup killer — click X on any FB modal (violation notices, "What happened",
        // save-info prompt, cookie banner, etc). Repeats a few times to catch popups
        // that appear one after another. Also presses Escape as a safety net.
        const dismissPopups = async () => {
          for (let round = 0; round < 5; round++) {
            let closedSomething = false;
            try {
              closedSomething = await page.evaluate(() => {
                let didClose = false;

                // 1) Cookie banner buttons
                const cookieBtns = Array.from(document.querySelectorAll(
                  '[data-cookiebanner] button, [aria-label*="cookie" i] button'
                ));
                for (const b of cookieBtns) {
                  const t = (b.innerText || '').trim().toLowerCase();
                  if (['allow all', 'accept all', 'accept', 'only allow essential', 'allow essential cookies'].includes(t)) {
                    try { b.click(); didClose = true; } catch {}
                  }
                }

                // 2) All [role="dialog"] modals — click their X (close) button
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
                for (const dlg of dialogs) {
                  // Prefer aria-label close button (X icon)
                  const closeBtn = dlg.querySelector(
                    '[aria-label="Close"], [aria-label="close"], ' +
                    '[aria-label="Fermer"], [aria-label="Cerrar"], ' +
                    '[aria-label="Dismiss"], [aria-label="বন্ধ করুন"], ' +
                    '[aria-label="বন্ধ"]'
                  );
                  if (closeBtn) {
                    try { closeBtn.click(); didClose = true; continue; } catch {}
                  }

                  // Fallback: any div/button in dialog with role=button whose
                  // aria-label contains "close" (case-insensitive)
                  const allBtns = dlg.querySelectorAll('[role="button"], button, div[tabindex]');
                  for (const b of allBtns) {
                    const label = (b.getAttribute('aria-label') || '').toLowerCase();
                    if (label && (label.includes('close') || label.includes('dismiss') ||
                                  label.includes('fermer') || label.includes('cerrar'))) {
                      try { b.click(); didClose = true; break; } catch {}
                    }
                  }
                  if (didClose) continue;

                  // Fallback: text-button "Not now", "OK", "Got it", "Cancel", "Skip"
                  const textBtns = dlg.querySelectorAll('button, [role="button"], div[role="button"]');
                  const okNeedles = [
                    'not now', 'ok', 'okay', 'got it', 'dismiss', 'cancel',
                    'skip', 'later', 'no thanks', 'maybe later', 'close',
                    'plus tard', 'pas maintenant', 'compris', 'annuler',
                    'ahora no', 'entendido', 'cancelar',
                    'বুঝেছি', 'ঠিক আছে', 'বাদ দিন', 'পরে',
                  ];
                  for (const b of textBtns) {
                    const t = (b.innerText || '').trim().toLowerCase();
                    if (!t || t.length > 40) continue;
                    if (okNeedles.some(n => t === n || t.startsWith(n))) {
                      try { b.click(); didClose = true; break; } catch {}
                    }
                  }
                }

                // 3) Top-level notification banners with X icon (not dialogs but banners)
                const bannerCloses = Array.from(document.querySelectorAll(
                  'div[aria-label="Close"], div[aria-label="Dismiss"]'
                ));
                for (const b of bannerCloses) {
                  try { b.click(); didClose = true; } catch {}
                }

                return didClose;
              });
            } catch {}

            // Safety net — press Escape (closes most modals if button click missed)
            try { await page.keyboard.press('Escape'); } catch {}

            if (!closedSomething) break;
            await new Promise(r => setTimeout(r, 700 + Math.floor(Math.random() * 500)));
          }
        };

        // Watchdog — every 3 seconds check for popups and dismiss them.
        // Runs the whole time the browser is alive. Auto-stops in finally.
        popupInterval = setInterval(() => {
          dismissPopups().catch(() => {});
        }, 3000);

        // STEP 1: Cookies login attempt
        let cookieAttemptDone = false;
        let onPasswordPage = false;
        if (cookies) {
          try {
            const cookieList = parseCookies(cookies);
            if (cookieList.length) {
              await context.addCookies(cookieList);
              // Load home + wait until network is mostly idle so images/CSS actually render
              await page.goto('https://www.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' });
              // Then wait for load event too (full images/scripts) — soft, non-fatal
              await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
              await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
              // Extra human-like settle
              await humanDelay(page, 3000, 6000);

              const ctxCookies = await context.cookies('https://www.facebook.com');
              const hasCUser = ctxCookies.some(c => c.name === 'c_user' && c.value && c.value.length > 3);
              const url = (page.url() || '').toLowerCase();

              if (url.includes('/checkpoint')) {
                outcome = { success: false, fail_reason: 'checkpoint (cookies)' };
                cookieAttemptDone = true;
              } else if (hasCUser && !url.includes('/login') && !url.includes('login.php')) {
                outcome = { success: true };
                method = 'cookies';
                cookieAttemptDone = true;
              } else {
                // Cookies didn't work — check if we landed on a password-prompt page
                const passInput = await page.$('input[name="pass"], input#pass');
                onPasswordPage = !!passInput;

                // Deep-inspect what FB is actually showing (suspend/disabled/etc)
                let deepReason = 'cookies not accepted';
                try {
                  const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
                  const txt = String(bodyText).toLowerCase();
                  if (txt.includes('account has been suspended') || txt.includes('votre compte a été suspendu')) {
                    deepReason = 'account suspended';
                  } else if (txt.includes('account has been disabled') || txt.includes('your account is disabled')) {
                    deepReason = 'account disabled';
                  } else if (txt.includes('account has been deactivated') || txt.includes('reactivate your account')) {
                    deepReason = 'account deactivated';
                  } else if (txt.includes('account locked') || txt.includes('temporarily locked')) {
                    deepReason = 'account locked';
                  }
                } catch (_) {}
                outcome = { success: false, fail_reason: deepReason };
              }
            }
          } catch (e) {
            outcome = { success: false, fail_reason: 'cookie error: ' + (e.message || e) };
          }
        }

        // STEP 2: Password login (only if cookies didn't work AND we have a password)
        if (!outcome.success && pass) {
          try {
            // Navigate to login page only if we're not already on a password-prompt
            const curUrl = (page.url() || '').toLowerCase();
            if (!onPasswordPage && !curUrl.includes('/login')) {
              await page.goto('https://www.facebook.com/login', { timeout: 30000, waitUntil: 'domcontentloaded' });
              await humanDelay(page, 1800, 3500);
            } else {
              // Landed on password prompt via cookies → pause briefly like a human noticing it
              await humanDelay(page, 1200, 2500);
            }

            const emailInput = await page.$('input[name="email"], input#email');
            if (emailInput) {
              await emailInput.click({ delay: 50 }).catch(() => {});
              await humanDelay(page, 200, 600);
              await emailInput.fill('').catch(() => {});
              // Slower per-key typing when in safe mode
              const typeDelay = speed === 'fast' ? 40 : (80 + Math.floor(Math.random() * 90));
              await emailInput.type(uid, { delay: typeDelay }).catch(() => {});
              await humanDelay(page, 300, 900);
            }
            const passInput = await page.$('input[name="pass"], input#pass');
            if (passInput) {
              await passInput.click({ delay: 50 }).catch(() => {});
              await humanDelay(page, 200, 600);
              await passInput.fill('').catch(() => {});
              const typeDelay = speed === 'fast' ? 40 : (90 + Math.floor(Math.random() * 100));
              await passInput.type(pass, { delay: typeDelay }).catch(() => {});
              await humanDelay(page, 400, 1200);

              await Promise.race([
                page.click('button[name="login"], button#loginbutton, button[type="submit"]', { timeout: 10000 }).catch(() => {}),
                page.press('input[name="pass"], input#pass', 'Enter').catch(() => {}),
              ]);
              await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
              // Give FB time to redirect / show checkpoint
              await humanDelay(page, 4000, 7000);

              const ctxCookies = await context.cookies('https://www.facebook.com');
              const hasCUser = ctxCookies.some(c => c.name === 'c_user' && c.value && c.value.length > 3);
              const finalUrl = (page.url() || '').toLowerCase();

              if (finalUrl.includes('/checkpoint')) {
                outcome = { success: false, fail_reason: 'checkpoint (password)' };
              } else if (hasCUser && !finalUrl.includes('/login')) {
                outcome = { success: true };
                method = cookieAttemptDone ? 'password' : 'password';
                freshCookies = JSON.stringify(ctxCookies);
              } else {
                outcome = { success: false, fail_reason: 'wrong password or blocked' };
              }
            } else {
              // No password field found — page e ki ache dekhi (suspend / disabled / deactivated?)
              let deepReason = 'no password field on login page';
              try {
                const finalUrl = (page.url() || '').toLowerCase();
                const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
                const txt = String(bodyText).toLowerCase();

                // Suspension / disabled account signals from FB
                if (
                  txt.includes('your account has been suspended') ||
                  txt.includes('account has been suspended') ||
                  txt.includes('votre compte a été suspendu') ||   // French
                  txt.includes('আপনার অ্যাকাউন্ট স্থগিত')       // Bangla
                ) {
                  deepReason = 'account suspended';
                } else if (
                  txt.includes('account has been disabled') ||
                  txt.includes('your account is disabled') ||
                  txt.includes('compte désactivé') ||
                  txt.includes('অ্যাকাউন্ট নিষ্ক্রিয়')
                ) {
                  deepReason = 'account disabled';
                } else if (
                  txt.includes('account has been deactivated') ||
                  txt.includes('account is deactivated') ||
                  txt.includes('reactivate your account')
                ) {
                  deepReason = 'account deactivated';
                } else if (
                  txt.includes('account locked') ||
                  txt.includes('temporarily locked') ||
                  txt.includes('votre compte est verrouillé')
                ) {
                  deepReason = 'account locked';
                } else if (
                  txt.includes('confirm your identity') ||
                  txt.includes('help us confirm') ||
                  txt.includes('two-factor') ||
                  txt.includes('two factor') ||
                  txt.includes('confirmation code') ||
                  finalUrl.includes('/checkpoint') ||
                  finalUrl.includes('/two_step_verification')
                ) {
                  deepReason = '2FA / checkpoint required';
                } else if (
                  txt.includes('page not found') ||
                  txt.includes("this content isn't available") ||
                  txt.includes('content not found')
                ) {
                  deepReason = 'account not found (may be deleted)';
                } else if (finalUrl.includes('/recover') || txt.includes('recover your account')) {
                  deepReason = 'account recovery required';
                } else if (bodyText && bodyText.length > 0) {
                  // Grab first meaningful line for debugging
                  const firstLine = String(bodyText).split('\n').map(s => s.trim()).find(s => s.length > 10 && s.length < 200);
                  deepReason = 'login blocked: ' + (firstLine ? firstLine.slice(0, 120) : 'no password field');
                }
              } catch (_) {}
              outcome = { success: false, fail_reason: deepReason };
            }
          } catch (e) {
            outcome = { success: false, fail_reason: 'password error: ' + (e.message || e) };
          }
        } else if (!outcome.success && !pass) {
          outcome = { success: false, fail_reason: outcome.fail_reason === 'unknown' ? 'no cookies and no password' : outcome.fail_reason + ' + no password to try' };
        }

      } catch (e) {
        outcome = { success: false, fail_reason: 'launch error: ' + (e.message || e) };
      } finally {
        try { if (popupInterval) clearInterval(popupInterval); } catch {}
        try { if (page) await page.close(); } catch {}
        try { if (context) await context.close(); } catch {}
        try { if (browser) await browser.close(); } catch {}
      }

      results[my] = {
        row,
        success: outcome.success,
        fail_reason: outcome.fail_reason || '',
        method,
        freshCookies,
      };
      done++;
      emitLog(`  ${outcome.success ? '✓' : '✗'} ${uid} — ${outcome.success ? ('login OK via ' + method) : outcome.fail_reason}`);
      emit({
        total: rows.length,
        done,
        success: results.filter(r => r && r.success).length,
        failed: done - results.filter(r => r && r.success).length,
        current: uid,
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));

  const successRows = results.filter(r => r && r.success).map(r => ({
    uid: r.row.uid || '',
    pass: r.row.pass || r.row.password || '',
    cookies: r.freshCookies || r.row.cookies || '',
    method: r.method || '',
  }));
  const failedRows = results.filter(r => r && !r.success).map(r => ({
    uid: r.row.uid || '',
    pass: r.row.pass || r.row.password || '',
    cookies: r.row.cookies || '',
    fail_reason: r.fail_reason || 'unknown',
  }));

  emitLog(`━━━ Login Tools Done: ${successRows.length} success · ${failedRows.length} failed ━━━`);
  return { successRows, failedRows, stopped: _loginToolsStop };
}

// ============================================================
// POST-IMPORT RESTRICTION FILTER
// After bulkImportWithBrowserLogin marks an account as "valid" (i.e. c_user
// cookie is present and no /login redirect), some of those accounts are
// actually SUSPENDED / RESTRICTED / CHECKPOINTED — Facebook keeps c_user
// set but shows a "Your account has been suspended" style page at the root.
// bulkImportWithBrowserLogin is LOCKED and can never be modified, so we run
// this ADDITIONAL filter on the validRows it returns, using the existing
// detectFacebookState() helper. Anything not in a clean state gets pulled
// out of validRows and moved into deadRows with a proper reason.
// This function is called by main.js after bulkImportWithBrowserLogin, so
// the LOCKED login flow is untouched.
// ============================================================
async function filterOutRestrictedAccounts(validRows, opts = {}) {
  if (!validRows || !validRows.length) return { keepRows: [], restrictedRows: [] };
  const concurrency = Math.max(1, Math.min(5, opts.concurrency || 3));
  const emitLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const emit    = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  emitLog(`━━━ Post-check: scanning ${validRows.length} logged-in accounts for suspend/checkpoint/restrictions... ━━━`);

  const results = new Array(validRows.length);
  let idx = 0;
  let done = 0;

  const worker = async (wid) => {
    while (idx < validRows.length) {
      const my = idx++;
      const row = validRows[my];
      const uid = String(row.uid || '').trim();
      const name = row.name || `Profile ${uid}`;
      let browser = null, context = null, page = null;
      let state = { status: 'Unknown', indicators: [], url: '' };

      try {
        const proxyObj = parseProxy(row.proxy);
        // `channel: 'chromium'` → use the already-installed full chromium-1217
        // in the new headless mode. Prevents the chromium-headless-shell
        // "Executable doesn't exist" failure during the post-check.
        browser = await chromium.launch({
          headless: true,
          channel: 'chromium',
          args: ['--disable-blink-features=AutomationControlled', '--no-default-browser-check'],
          proxy: proxyObj,
        });
        context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          ignoreHTTPSErrors: true,
          locale: 'en-US',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        const cookieList = parseCookies(row.cookies || '');
        if (cookieList.length) await context.addCookies(cookieList);

        page = await context.newPage();
        // Block heavy resources for speed — same trick as bulkImportWithBrowserLogin
        await page.route('**/*', (route) => {
          const t = route.request().resourceType();
          if (t === 'image' || t === 'font' || t === 'media') return route.abort();
          return route.continue();
        });

        await page.goto('https://www.facebook.com/', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2500);
        await dismissFacebookPopups(page, () => {}).catch(() => {});
        await page.waitForTimeout(800);

        state = await detectFacebookState(context, page);
      } catch (e) {
        state = { status: 'Unknown', indicators: [`error: ${e.message || e}`], url: '' };
      } finally {
        try { if (page)    await page.close();    } catch {}
        try { if (context) await context.close(); } catch {}
        try { if (browser) await browser.close(); } catch {}
      }

      // "Clean" states we keep. Anything else (Checkpoint, Restricted,
      // Suspended, At Risk, Limited, Login Failed, Unknown) → dead.
      const CLEAN = new Set(['No restrictions', 'Active']);
      const keep = CLEAN.has(state.status);
      results[my] = { row, keep, state };
      done++;

      emitLog(`  [W${wid}] ${keep ? '✓ CLEAN' : '✗ RESTRICTED'} ${uid} — ${state.status}${state.indicators.length ? ' [' + state.indicators.slice(0, 2).join(' | ') + ']' : ''}`);
      emit({
        total: validRows.length,
        done,
        current: name,
        stage: 'post-check',
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, validRows.length) }, (_, i) => worker(i + 1))
  );

  const keepRows = [];
  const restrictedRows = [];
  for (const r of results) {
    if (!r) continue;
    if (r.keep) keepRows.push(r.row);
    else restrictedRows.push({
      ...r.row,
      _dead_reason: `restricted: ${r.state.status}`,
      _validation_status: r.state.status,
    });
  }

  emitLog(`━━━ Post-check done: ${keepRows.length} clean · ${restrictedRows.length} restricted/suspended ━━━`);
  return { keepRows, restrictedRows };
}

module.exports = {
  TASK_TYPES,
  onLog, onTaskUpdate,
  openProfile, closeProfile, closeAll,
  runTask, stopTask, pauseTask, resumeTask,
  quickValidateCookies, bulkValidateCookies,
  bulkImportWithBrowserLogin,
  filterOutRestrictedAccounts,
  runLoginTools, stopLoginTools,
};
