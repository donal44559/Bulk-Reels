# Bulk Reels Upload Pro — V1.5.0

Multi-profile Facebook/Reels automation desktop app.
**Electron + React + Tailwind + Playwright + SQLite**.

## Screens
- **Dashboard & Filters** — Profile Status (5 cards), Page Status (5 cards), Group Name cards, Import History. Click any tile to jump to a filtered Profile Management view.
- **Live Terminal** — Total Active / Remaining / Success / Failed counters, real-time colored logs, Stop / Pause / Resume / Copy Log, last-10 results table.
- **Profile Management** — Full profile table (No, UID, Profile Status, Page Status, Page Name, Pages, Upload Status, Group, Actions). Multi-select + bulk **Add To Group / Open / Close / Delete / Start Task / Stop**. Filter chips + search.
- **Account Management** — Import from Excel/CSV, Add Account (manual login), Import history.
- **Settings** — Manage Group Names (add/edit/delete), System Preferences (Headless, Page Load Timeout, Concurrency, Delay, Username, License days), Export CSV.

## Automation tasks (all 11)
1. Check Profiles Status
2. Auto Upload Reels
3. Auto Page Creation
4. Page Create & Reels
5. Auto Interaction
6. Auto Upload Story
7. Story and Reels Upload
8. Auto Join Groups
9. Auto Post to Groups
10. Auto Comments (Random)
11. Auto Comments (Targeted)

Each task runs on selected profiles with configurable concurrency and delay. Progress streams live to **Live Terminal**.

## Setup

```bash
npm install
```

> **Playwright 1.59.0** is pinned. It downloads Chromium revision **`chromium-1217`**
> (Chrome for Testing 147.0.7727.15) which includes the H.264/AAC media codecs
> needed for Facebook/Reels video to play. The Chromium engine is **NOT** downloaded
> by `postinstall`; it is fetched on the app's very first launch via Playwright's
> registry API and stored in `<userData>/pw-browsers`. Do **not** bump Playwright
> above 1.59.0 (1.60+ removed the internal registry API this app relies on).
> On first launch the app shows a short "First-time Setup" window while it
> downloads the ~170 MB engine.

## Run in development

```bash
npm run dev
```

This builds the renderer with Vite in watch mode and launches Electron.

## Build a production bundle

```bash
npm run build
npm start
```

## Package a Windows .exe

```bash
npm run pack:win
```

Or simply double-click **`BUILD_EXE.bat`** on a Windows PC (it runs
`npm install` + `npm run pack:win` automatically). The output is a portable
standalone EXE at `release\BulkReelsUploadPro-1.5.0.exe`.

## Excel import columns

**Minimum format (matches your sheet):**

| Uid | Pass | Cookies |
|---|---|---|
| 100013793623381 | masum@03 | c_user=...; xs=...; datr=...; sb=...; ... |

Header names are case-insensitive. All these are accepted:
- **UID column:** `Uid`, `UID`, `uid`, `id`, `user_id`, `facebook_uid`
- **Password column:** `Pass`, `Password`, `pass`, `pwd`
- **Cookies column:** `Cookies`, `cookie`, `cookie_string`
- Optional: `name`, `group`, `2fa`, `proxy`, `notes`

**Auto-login flow when opening a profile / running a task:**
1. If cookies exist → inject cookies, visit facebook.com, if session valid → ✅ done
2. Else if password exists → fill login form, submit
3. Else → open login page for manual login (session persists for next time)

## Data location
Everything is stored inside the Electron `userData` folder:
- `bulkreels.db` — SQLite database
- `profiles/<uid>/` — each profile's persistent browser data

## Important
The task executors in `src/bot.js` include working scaffolding (launch, navigate, upload input) but Facebook's DOM changes frequently. Adjust the selectors inside `executeTask()` for whichever site/flow you target — the concurrency, pause/resume/stop, logging, and state machine will work as-is.

---
Developed by: **MUNNA** · V1.5.0
