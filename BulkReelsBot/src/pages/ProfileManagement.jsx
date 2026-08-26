import React, { useEffect, useMemo, useState, useRef } from 'react';
import api, { TASK_TYPES } from '../api.js';
import Modal from '../components/Modal.jsx';

const FILTER_MAP = {
  all:           () => true,
  restricted:    (p) => ['Restricted','Limited','At Risk','Suspended'].includes(p.profile_status),
  no_restrict:   (p) => p.profile_status === 'No restrictions' || p.profile_status === 'Active',
  active:        (p) => p.profile_status === 'Active' || p.profile_status === 'No restrictions',
  limited:       (p) => p.profile_status === 'Limited',
  at_risk:       (p) => p.profile_status === 'At Risk',
  suspended:     (p) => p.profile_status === 'Suspended',
  login_failed:  (p) => p.profile_status === 'Login Failed',
  unknown:       (p) => !p.profile_status || p.profile_status === 'Unknown',
};

const FILTER_LABELS = {
  all: 'All', restricted: 'Restricted (any)', no_restrict: 'No Restrictions',
  active: 'Active', limited: 'Limited', at_risk: 'At Risk', suspended: 'Suspended',
  login_failed: 'Login Failed', unknown: 'Unknown',
};

export default function ProfileManagement({ initialFilter = 'all', onNavigate }) {
  const [profiles, setProfiles] = useState([]);
  const [groups, setGroups]     = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [search, setSearch]     = useState('');
  const [filter, setFilter]     = useState(initialFilter);
  const [showTask, setShowTask] = useState(false);
  const [showGroup, setShowGroup] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editProfile, setEditProfile] = useState(null);
  const [toast, setToast] = useState(null);

  const refresh = async () => {
    setProfiles(await api.listProfiles());
    setGroups(await api.listGroups());
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => { setFilter(initialFilter); }, [initialFilter]);

  // Auto-refresh profile list every time a task update arrives (so statuses appear live)
  useEffect(() => {
    const off = api.onTaskUpdate?.(() => {
      // Throttle: only refresh at most every 800ms
      if (Date.now() - (refresh._last || 0) < 800) return;
      refresh._last = Date.now();
      refresh();
    });
    return () => { off && off(); };
  }, []);

  const pushToast = (msg, type='info') => { setToast({ msg, type }); setTimeout(() => setToast(null), 2500); };

  const filtered = useMemo(() => profiles.filter(p => {
    // Group filter is passed as "group:<name>" from Dashboard (or the group
    // chip). It bypasses FILTER_MAP entirely and matches on group_name only.
    if (typeof filter === 'string' && filter.startsWith('group:')) {
      const wantGroup = filter.slice('group:'.length);
      if ((p.group_name || 'Default') !== wantGroup) return false;
    } else {
      if (!FILTER_MAP[filter] || !FILTER_MAP[filter](p)) return false;
    }
    if (search) {
      const s = search.toLowerCase();
      if (!(p.uid || '').toLowerCase().includes(s) &&
          !(p.name || '').toLowerCase().includes(s)) return false;
    }
    return true;
  }), [profiles, filter, search]);

  // Pagination — page size + current page, persisted per-user.
  // Options: 15 / 20 / 50 / 100 per page (screenshot user requested).
  const _savedPageSize = (() => { try { return parseInt(localStorage.getItem('pm_pageSize') || '15', 10); } catch { return 15; } })();
  const [pageSize, setPageSize] = useState([15, 20, 50, 100].includes(_savedPageSize) ? _savedPageSize : 15);
  const [pageSizeOpen, setPageSizeOpen] = useState(false);
  const pageSizeRef = useRef(null);
  useEffect(() => {
    if (!pageSizeOpen) return;
    const onDocClick = (e) => { if (pageSizeRef.current && !pageSizeRef.current.contains(e.target)) setPageSizeOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [pageSizeOpen]);
  const [page, setPage] = useState(1);
  useEffect(() => { try { localStorage.setItem('pm_pageSize', String(pageSize)); } catch {} }, [pageSize]);
  // Reset to page 1 whenever filter/search/pageSize/profiles-length changes
  useEffect(() => { setPage(1); }, [filter, search, pageSize, profiles.length]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const paged = useMemo(() => filtered.slice(pageStart, pageStart + pageSize), [filtered, pageStart, pageSize]);

  const toggle = (uid) => {
    const n = new Set(selected);
    if (n.has(uid)) n.delete(uid); else n.add(uid);
    setSelected(n);
  };
  // "Select all" now targets the CURRENT PAGE — matches what user sees.
  // If every row on this page is already selected → clear only those.
  const toggleAll = () => {
    const pageIds = paged.map(p => p.uid);
    const allOnPageSelected = pageIds.length > 0 && pageIds.every(u => selected.has(u));
    const n = new Set(selected);
    if (allOnPageSelected) pageIds.forEach(u => n.delete(u));
    else pageIds.forEach(u => n.add(u));
    setSelected(n);
  };

  const openSelected  = async () => { if (!selected.size) return; await api.openMany([...selected]);  pushToast(`Opening ${selected.size} browsers...`, 'info'); };
  const closeSelected = async () => { if (!selected.size) return; await api.closeMany([...selected]); pushToast(`Closed ${selected.size} browsers`, 'success'); };
  const deleteSelected = async () => {
    if (!selected.size) return;
    if (!confirm(`Delete ${selected.size} profile(s)?`)) return;
    await api.deleteProfiles([...selected]);
    setSelected(new Set());
    pushToast('Deleted', 'success');
    refresh();
  };
  const stopTask = async () => { await api.stopTask(); pushToast('Stop requested', 'warn'); };

  const startTask = async ({ taskName, options }) => {
    const list = profiles.filter(p => selected.has(p.uid));
    if (!list.length) return pushToast('Select profiles first', 'error');
    setShowTask(false);
    onNavigate && onNavigate('terminal');
    pushToast(`Starting: ${taskName} on ${list.length} profiles`, 'info');
    api.runTask({ taskName, profiles: list, ...options }).catch(e => pushToast(e.message, 'error'));
  };

  const doOpen  = async (p) => {
    pushToast(`Opening ${p.name}...`, 'info');
    const res = await api.openBrowser(p.uid);
    if (res && res.success) {
      if (res.message === 'Already open') pushToast(`${p.name} is already open — focused window`, 'info');
      else pushToast(`Opened ${p.name}`, 'success');
    } else {
      pushToast(res?.error || `Failed to open ${p.name}`, 'error');
    }
  };
  const doClose = async (p) => { await api.closeBrowser(p.uid); pushToast(`Closed ${p.name}`, 'success'); };
  const doDel   = async (p) => { if (!confirm(`Delete ${p.name}?`)) return; await api.deleteProfile(p.uid); pushToast('Deleted', 'success'); refresh(); };

  const filterLabel = FILTER_LABELS[filter];

  return (
    <div className="space-y-4">
      {/* Filter chips */}
      <div className="panel px-5 py-3 flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted">Filter:</span>
        {Object.keys(FILTER_MAP).map(k => (
          <button key={k} onClick={() => setFilter(k)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition
              ${filter===k ? 'bg-cyanx/20 border-cyanx text-cyanx' : 'border-border text-slate-300 hover:bg-white/5'}`}>
            {FILTER_LABELS[k]}
          </button>
        ))}
        {typeof filter === 'string' && filter.startsWith('group:') && (
          <button onClick={() => setFilter('all')}
            className="px-3 py-1.5 rounded-md text-xs font-semibold border transition bg-purplex/20 border-purplex text-purplex hover:bg-purplex/30 inline-flex items-center gap-1"
            title="Clear group filter">
            Group — {filter.slice('group:'.length)}
            <span className="text-sm leading-none">×</span>
          </button>
        )}
        <div className="flex-1" />
        <span className="text-sm text-muted">Selected: <b className="text-cyanx">{selected.size}</b></span>
      </div>

      {/* Toolbar */}
      <div className="panel p-4 flex flex-wrap items-center gap-3">
        <div>
          <div className="text-lg font-bold text-white leading-tight">Profile List</div>
          <div className="text-sm text-muted">({filterLabel})</div>
        </div>
        <span className="chip">{selected.size} Profiles Selected</span>
        <input className="input max-w-[260px]" placeholder="Search UID or No..." value={search} onChange={e => setSearch(e.target.value)} />
        <button className="btn-ghost" onClick={refresh}>🔄 REFRESH</button>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>➕ CREATE PROFILE</button>
        <div className="flex-1" />
        <button className="btn-purple" onClick={() => setShowGroup(true)} disabled={!selected.size}>ADD TO GROUP</button>
        <button className="btn-blue" onClick={openSelected}   disabled={!selected.size}>OPEN SELECTED</button>
        <button className="btn-orange" onClick={closeSelected} disabled={!selected.size}>CLOSE SELECTED</button>
        <button className="btn-red" onClick={deleteSelected} disabled={!selected.size}>DELETE SELECTED</button>
        <button className="btn-green" onClick={() => setShowTask(true)} disabled={!selected.size}>▶ START TASK</button>
        <button className="btn-red" onClick={stopTask}>⏹ STOP</button>
      </div>

      {/* Table */}
      <div className="panel overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-wider text-muted">
            <tr className="border-b border-border">
              <th className="p-3 w-10"><input type="checkbox"
                  checked={paged.length>0 && paged.every(p => selected.has(p.uid))}
                  onChange={toggleAll} title="Select all on this page" /></th>
              <th className="p-3 text-left">NO.</th>
              <th className="p-3 text-left">Profile UID</th>
              <th className="p-3 text-left">Profile Status</th>
              <th className="p-3 text-left">Page Status</th>
              <th className="p-3 text-left">Pages</th>
              <th className="p-3 text-left">Upload Status</th>
              <th className="p-3 text-left">Comment Status</th>
              <th className="p-3 text-left">Group</th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan="10" className="p-10 text-center text-muted">No profiles match this filter.</td></tr>
            ) : paged.map((p, i) => (
              <tr key={p.uid} className="table-row">
                <td className="p-3"><input type="checkbox" checked={selected.has(p.uid)} onChange={() => toggle(p.uid)} /></td>
                <td className="p-3 text-slate-300">{pageStart + i + 1}</td>
                <td className="p-3">
                  <div className="text-redx font-semibold">UID:</div>
                  <div className="text-cyanx font-mono">{p.uid}</div>
                </td>
                <td className="p-3">
                  <span className={
                    p.profile_status === 'Suspended'      ? 'text-redx font-semibold' :
                    p.profile_status === 'At Risk'        ? 'text-orangex font-semibold' :
                    p.profile_status === 'Limited'        ? 'text-pinkx font-semibold' :
                    p.profile_status === 'Restricted'     ? 'status-restricted font-semibold' :
                    p.profile_status === 'No restrictions'|| p.profile_status === 'Active' ? 'status-no-restrict font-semibold' :
                    p.profile_status === 'Login Failed'   ? 'status-login-failed font-semibold' :
                    'status-unknown font-semibold'
                  }>{p.profile_status || 'Unknown'}</span>
                </td>
                <td className="p-3">
                  <span className={
                    p.page_status === 'Page has some issues' ? 'text-orangex font-semibold' :
                    p.page_status === 'Page has no issues' ? 'text-greenx font-semibold' :
                    p.page_status === 'Checkpoint' ? 'text-redx font-semibold' :
                    p.page_status === 'Unknown' ? 'text-yellow-400 font-semibold' :
                    'text-slate-300'
                  }>{p.page_status || 'No Page Create'}</span>
                </td>
                <td className="p-3 text-slate-300">{p.pages_count || 0}</td>
                <td className="p-3">
                  {p.upload_status === 'Upload Success'
                    ? <span className="text-cyanx font-semibold">Upload Success</span>
                    : p.upload_status === 'Upload Failed'
                    ? <span className="text-redx font-semibold">Upload Failed</span>
                    : p.upload_status === 'Uploading...'
                    ? <span className="text-yellow-400 font-semibold inline-flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></span>
                        Uploading...
                      </span>
                    : <span className="text-muted">—</span>}
                </td>
                <td className="p-3">
                  {p.comment_status === 'Comment Success'
                    ? <span className="text-greenx font-semibold">Success</span>
                    : p.comment_status === 'Comment Failed'
                    ? <span className="text-redx font-semibold">Fail</span>
                    : p.comment_status === 'Commenting...'
                    ? <span className="text-yellow-400 font-semibold inline-flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></span>
                        Commenting...
                      </span>
                    : <span className="text-muted">—</span>}
                </td>
                <td className="p-3"><span className="chip text-purplex">{p.group_name || 'Default'}</span></td>
                <td className="p-3 text-right whitespace-nowrap">
                  <button className="btn-blue mr-1 !px-3 !py-1 text-xs" onClick={() => doOpen(p)}>Open</button>
                  <button className="btn-orange mr-1 !px-3 !py-1 text-xs" onClick={() => doClose(p)}>Close</button>
                  <button className="btn-ghost mr-1 !px-3 !py-1 text-xs" onClick={() => setEditProfile(p)}>Edit</button>
                  <button className="btn-red !px-3 !py-1 text-xs" onClick={() => doDel(p)}>Del</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Pagination footer */}
        {filtered.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-black/20">
            <div className="text-xs text-muted">
              Showing <b className="text-white">{pageStart + 1}-{Math.min(pageStart + pageSize, filtered.length)}</b> of{' '}
              <b className="text-white">{filtered.length}</b> profiles
              <span className="text-slate-500"> (Page {safePage} of {totalPages})</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Prev */}
              <button
                type="button"
                className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-white border border-border disabled:opacity-30 disabled:cursor-not-allowed transition flex items-center justify-center"
                disabled={safePage <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
                title="Previous page"
              >‹</button>

              {/* Page numbers — compact: 1 … cur-1 cur cur+1 … last */}
              {(() => {
                const pages = [];
                const push = (n) => pages.push(n);
                if (totalPages <= 7) {
                  for (let i = 1; i <= totalPages; i++) push(i);
                } else {
                  push(1);
                  if (safePage > 4) push('…');
                  const lo = Math.max(2, safePage - 1);
                  const hi = Math.min(totalPages - 1, safePage + 1);
                  for (let i = lo; i <= hi; i++) push(i);
                  if (safePage < totalPages - 3) push('…');
                  push(totalPages);
                }
                return pages.map((n, idx) => n === '…' ? (
                  <span key={`dot-${idx}`} className="px-1 text-slate-500 select-none">…</span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPage(n)}
                    className={`min-w-[32px] h-8 px-2 rounded-lg text-sm font-semibold border transition ${
                      n === safePage
                        ? 'bg-blue-500 border-blue-500 text-white shadow'
                        : 'bg-white/5 hover:bg-white/10 border-border text-slate-200'
                    }`}
                  >{n}</button>
                ));
              })()}

              {/* Next */}
              <button
                type="button"
                className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-white border border-border disabled:opacity-30 disabled:cursor-not-allowed transition flex items-center justify-center"
                disabled={safePage >= totalPages}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                title="Next page"
              >›</button>

              {/* Per page selector — custom dropdown (native <select> option
                  styling is unreliable in Electron dark themes; this gives
                  us full control over the popup look). */}
              <div className="relative ml-2" ref={pageSizeRef}>
                <button
                  type="button"
                  onClick={() => setPageSizeOpen(o => !o)}
                  className="h-8 rounded-lg bg-white/5 border border-border text-sm text-white px-3 hover:bg-white/10 transition cursor-pointer inline-flex items-center gap-2"
                  title="Rows per page"
                >
                  <span>{pageSize} / page</span>
                  <span className={`text-xs transition-transform ${pageSizeOpen ? 'rotate-180' : ''}`}>▾</span>
                </button>
                {pageSizeOpen && (
                  <div
                    className="absolute right-0 bottom-full mb-1 w-32 rounded-lg border border-border shadow-lg overflow-hidden z-50"
                    style={{ background: '#0f172a' }}
                  >
                    {[15, 20, 50, 100].map(n => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => { setPageSize(n); setPageSizeOpen(false); }}
                        className={`block w-full text-left px-3 py-2 text-sm transition ${
                          n === pageSize
                            ? 'bg-blue-500 text-white font-semibold'
                            : 'text-slate-200 hover:bg-white/10'
                        }`}
                      >
                        {n} / page
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {showTask && <StartTaskModal onClose={() => setShowTask(false)} onRun={startTask} count={selected.size} />}
      {showGroup && <AddToGroupModal onClose={() => setShowGroup(false)} groups={groups} onPick={async (g) => {
        await api.setProfilesGroup([...selected], g); setShowGroup(false); pushToast(`Moved to "${g}"`, 'success'); refresh();
      }} />}
      {showCreate && <CreateProfileModal
        groups={groups}
        onClose={() => setShowCreate(false)}
        onSaved={async ({ uid, openNow }) => {
          setShowCreate(false);
          pushToast('Profile saved', 'success');
          await refresh();
          if (openNow) {
            const res = await api.openBrowser(uid);
            pushToast(res.success ? `Opening browser for ${uid}...` : (res.error || 'Failed to open'), res.success ? 'info' : 'error');
          }
        }}
      />}
      {editProfile && <CreateProfileModal
        editing={editProfile}
        groups={groups}
        onClose={() => setEditProfile(null)}
        onSaved={async ({ uid, openNow }) => {
          setEditProfile(null);
          pushToast('Profile updated', 'success');
          await refresh();
          if (openNow) {
            const res = await api.openBrowser(uid);
            pushToast(res.success ? `Opening browser for ${uid}...` : (res.error || 'Failed to open'), res.success ? 'info' : 'error');
          }
        }}
      />}

      {toast && (
        <div className={`fixed bottom-5 right-5 px-4 py-2 rounded-lg shadow-xl text-sm z-50
          ${toast.type==='error' ? 'bg-rose-600' : toast.type==='success' ? 'bg-emerald-600' : toast.type==='warn' ? 'bg-amber-500' : 'bg-slate-700'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function StartTaskModal({ onClose, onRun, count }) {
  const [taskName, setTaskName] = useState('Check Profiles Status');
  const [mediaPath, setMediaPath] = useState('');
  // Auto Upload Reels (Meta Business Suite bulk upload) — persisted
  const _savedReels = (() => { try { return JSON.parse(localStorage.getItem('autoReelsConfig_v1') || '{}'); } catch { return {}; } })();
  const [reelsFolder, setReelsFolder] = useState(_savedReels.reelsFolder || '');
  const [descriptionsFile, setDescriptionsFile] = useState(_savedReels.descriptionsFile || '');
  const [videosPerUpload, setVideosPerUpload] = useState(Number(_savedReels.videosPerUpload) > 0 ? Number(_savedReels.videosPerUpload) : 10);
  // Description boxes — like comment boxes. One box = one full description
  // (multi-line, hashtags, emoji, links — sob preserve). Bot random pick
  // korbe per video. Persisted to localStorage same as comments.
  const [descriptionBoxes, setDescriptionBoxes] = useState(
    Array.isArray(_savedReels.descriptionBoxes) && _savedReels.descriptionBoxes.length
      ? _savedReels.descriptionBoxes
      : ['']
  );
  // Headless toggle for Auto Upload Reels — persisted per user preference.
  // Default: false (visible browser) so user can watch the upload happen.
  // When ON, uploads run silently in background (faster, no window).
  const [reelsHeadless, setReelsHeadless] = useState(
    typeof _savedReels.headless === 'boolean' ? _savedReels.headless : false
  );
  const [pageName, setPageName] = useState('');
  const [groupLinks, setGroupLinks] = useState('');
  const [postText, setPostText] = useState('');
  const [targetUrls, setTargetUrls] = useState('');
  // Comment pool as ARRAY of individual boxes (one comment per box).
  // Submit-time these get joined with \n so backend receives the same
  // newline-separated string it always has — automation logic unchanged.
  // NOTE: comment pool + keywords + delays persisted to localStorage
  // so user doesn't have to re-enter them every time the modal opens.
  const LS_KEY = 'automationTaskComments_v1';
  const _loadSaved = () => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch { return {}; }
  };
  const _saved = _loadSaved();

  const [commentBoxes, setCommentBoxes] = useState(
    Array.isArray(_saved.commentBoxes) && _saved.commentBoxes.length
      ? _saved.commentBoxes
      : ['Nice!', 'Great post', 'Awesome content']
  );
  const [concurrency, setConcurrency] = useState(3);
  const [delayMs, setDelayMs] = useState(800);
  // Auto Comments (Targeted) — keyword-based reel filter
  const [targetKeywords, setTargetKeywords] = useState(
    typeof _saved.targetKeywords === 'string' && _saved.targetKeywords.length
      ? _saved.targetKeywords
      : 'wa.me\nwhatsapp.com\nt.me\n'
  );
  const [commentsPerProfile, setCommentsPerProfile] = useState(
    Number(_saved.commentsPerProfile) > 0 ? Number(_saved.commentsPerProfile) : 10
  );
  const [minDelay, setMinDelay] = useState(
    Number(_saved.minDelay) > 0 ? Number(_saved.minDelay) : 25
  );
  const [maxDelay, setMaxDelay] = useState(
    Number(_saved.maxDelay) > 0 ? Number(_saved.maxDelay) : 70
  );
  // Auto Comments (Random) — watch N reels, comment on the next one
  const [watchPerCycle, setWatchPerCycle] = useState(
    Number(_saved.watchPerCycle) > 0 ? Number(_saved.watchPerCycle) : 10
  );
  const [secondsPerReel, setSecondsPerReel] = useState(
    Number(_saved.secondsPerReel) > 0 ? Number(_saved.secondsPerReel) : 10
  );

  // Inline UI state for the Targeted Reel Comment Finder action buttons.
  // Replaces native confirm/alert (which caused the modal to freeze on Electron
  // after the dialog closed, since focus never returned inside the modal).
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [matchesToast, setMatchesToast] = useState(null);   // { msg, type: 'success'|'error'|'info' }
  const pushMatchesToast = (msg, type = 'info') => {
    setMatchesToast({ msg, type });
    setTimeout(() => setMatchesToast(prev => (prev && prev.msg === msg ? null : prev)), 3500);
  };

  // Persist all Auto-Comments-related settings whenever they change.
  // Debounced through React batching — no performance concern for a few kb.
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        commentBoxes,
        targetKeywords,
        commentsPerProfile,
        minDelay,
        maxDelay,
        watchPerCycle,
        secondsPerReel,
      }));
    } catch {}
  }, [commentBoxes, targetKeywords, commentsPerProfile, minDelay, maxDelay, watchPerCycle, secondsPerReel]);

  // Auto Upload Reels now uses folder+descriptions instead of a single media path
  const needsReels   = ['Auto Upload Reels','Story and Reels Upload','Page Create & Reels'].includes(taskName);
  const needsMedia   = ['Auto Upload Story','Story and Reels Upload'].includes(taskName);   // stories still need mediaPath
  // Persist Auto Reels config
  useEffect(() => {
    try {
      localStorage.setItem('autoReelsConfig_v1', JSON.stringify({ reelsFolder, descriptionsFile, videosPerUpload, descriptionBoxes, headless: reelsHeadless }));
    } catch {}
  }, [reelsFolder, descriptionsFile, videosPerUpload, descriptionBoxes, reelsHeadless]);
  const needsPage    = ['Auto Page Creation','Page Create & Reels'].includes(taskName);
  const needsGroups  = ['Auto Join Groups','Auto Post to Groups'].includes(taskName);
  const needsPost    = ['Auto Post to Groups'].includes(taskName);
  const isTargetedComments = taskName === 'Auto Comments (Targeted)';
  const isRandomComments   = taskName === 'Auto Comments (Random)';

  // Auto-fallback to concurrency=1 whenever an Auto-Comments task is selected
  // (parallel browsers steal keyboard focus → clicks/typing fail on background tabs)
  useEffect(() => {
    if (isTargetedComments || isRandomComments) setConcurrency(1);
  }, [isTargetedComments, isRandomComments]);
  const needsTargets = false; // legacy targetUrls textarea disabled — Targeted now uses keyword scan
  const needsCmts    = ['Auto Comments (Random)','Auto Comments (Targeted)'].includes(taskName);

  const submit = () => {
    onRun({
      taskName,
      options: {
        mediaPath, pageName,
        // Auto Upload Reels — Meta Business Suite bulk
        reelsFolder, descriptionsFile,
        descriptions: descriptionBoxes.map(s => (s || '').replace(/\r\n/g, '\n')).filter(s => s.trim().length > 0),
        videosPerUpload: Math.max(1, Math.min(50, Number(videosPerUpload) || 10)),
        groupLinks: groupLinks.split('\n').map(s => s.trim()).filter(Boolean),
        postText,
        targetUrls: targetUrls.split('\n').map(s => s.trim()).filter(Boolean),
        comments: commentBoxes.map(s => (s || '').trim()).filter(Boolean),
        concurrency: Number(concurrency) || 1,
        delayMs: Number(delayMs) || 0,
        // Headless toggle from the Auto Upload Reels config panel — only
        // sent when Reels-family task is selected. Undefined for others so
        // task runner falls back to global settings.headless_mode.
        ...(needsReels ? { headless: !!reelsHeadless } : {}),
        // Auto Comments (Targeted)
        targetKeywords: targetKeywords.split('\n').map(s => s.trim()).filter(Boolean),
        commentsPerProfile: Math.max(1, Number(commentsPerProfile) || 10),
        minDelaySec: Math.max(5, Number(minDelay) || 25),
        maxDelaySec: Math.max(Number(minDelay) || 25, Number(maxDelay) || 70),
        // Auto Comments (Random)
        watchPerCycle: Math.max(1, Number(watchPerCycle) || 10),
        secondsPerReel: Math.max(1, Number(secondsPerReel) || 10),
      },
    });
  };

  return (
    <Modal title="▶ Start Automation Task" onClose={onClose} wide
      footer={<>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-green" onClick={submit}>▶ Run on {count} profile(s)</button>
      </>}>
      <div>
        <label className="label">Select Task</label>
        <select className="input" value={taskName} onChange={e => setTaskName(e.target.value)}>
          <optgroup label="🔍 Status Checks">
            <option value="Check Profiles Status">Check Profiles Status  (ID only)</option>
            <option value="Check Page Status">Check Page Status  (Page only)</option>
          </optgroup>
          <optgroup label="🎬 Content Upload">
            <option value="Auto Upload Reels">Auto Upload Reels</option>
            <option value="Auto Upload Story">Auto Upload Story</option>
            <option value="Story and Reels Upload">Story and Reels Upload</option>
          </optgroup>
          <optgroup label="📄 Page & Interaction">
            <option value="Auto Page Creation">Auto Page Creation</option>
            <option value="Page Create & Reels">Page Create &amp; Reels</option>
            <option value="Auto Interaction">Auto Interaction</option>
          </optgroup>
          <optgroup label="👥 Groups & Comments">
            <option value="Auto Join Groups">Auto Join Groups</option>
            <option value="Auto Post to Groups">Auto Post to Groups</option>
            <option value="Auto Comments (Random)">Auto Comments (Random)</option>
            <option value="Auto Comments (Targeted)">Auto Comments (Targeted)</option>
          </optgroup>
        </select>
        {(taskName === 'Check Profiles Status' || taskName === 'Check Page Status') && (
          <div className={`mt-2 text-xs px-3 py-2 rounded-lg border ${
            taskName === 'Check Profiles Status'
              ? 'bg-cyanx/5 border-cyanx/30 text-slate-300'
              : 'bg-purplex/5 border-purplex/30 text-slate-300'
          }`}>
            {taskName === 'Check Profiles Status' ? (
              <>
                <b className="text-cyanx">Check Profiles Status:</b> Only checks personal <b>ID status</b> using
                <code className="text-cyanx"> facebook.com/profile_status/</code>. Updates <b>Profile Status</b> column only
                (Active / Limited / At Risk / Suspended). Page columns are untouched.
              </>
            ) : (
              <>
                <b className="text-purplex">Check Page Status:</b> Checks the <b>Page status</b> of whichever
                context (page) the profile is currently switched to.
                <div className="mt-2 p-2 rounded bg-orange-500/10 border border-orange-500/30 text-orange-200">
                  <b>⚠ Required steps before running this task:</b>
                  <ol className="list-decimal ml-5 mt-1 space-y-0.5">
                    <li>Click <b>Open</b> on the profile row to launch the browser</li>
                    <li>Log in (or wait for auto-login)</li>
                    <li>In Facebook, top-right avatar → <b>Switch Profile</b> → select the <b>Page</b> you want to check</li>
                    <li><b>Close the browser</b> (session with page-switch stays saved)</li>
                    <li>Then run this task — it will resume in the page context you chose</li>
                  </ol>
                </div>
                Uses <code className="text-purplex">facebook.com/settings/?tab=profile_quality&amp;referrer=three_dot_menu_settings</code>.
                Updates <b>Page Status, Pages count</b> only. Profile Status is untouched.
              </>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4">
        <div>
          <label className="label">Concurrency (browsers at same time)</label>
          <input className="input" type="number" min="1" max="20" value={concurrency} onChange={e => setConcurrency(e.target.value)} />
        </div>
        <div>
          <label className="label">Delay between profiles (ms)</label>
          <input className="input" type="number" min="0" value={delayMs} onChange={e => setDelayMs(e.target.value)} />
        </div>
      </div>

      {needsMedia && (
        <div className="mt-4">
          <label className="label">Media file path (Story — absolute path to video/image)</label>
          <input className="input" value={mediaPath} onChange={e => setMediaPath(e.target.value)} placeholder="C:\\Users\\you\\Videos\\story.mp4" />
        </div>
      )}
      {needsReels && (
        <div className="mt-4 rounded-xl border border-purplex/40 bg-gradient-to-br from-purplex/10 to-purplex/5 p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">🎬</span>
            <span className="text-sm text-purplex font-bold">Meta Business Suite Bulk Reels Upload</span>
            <span className="text-greenx normal-case tracking-normal font-normal text-[10px] flex items-center gap-1 ml-auto">
              <span className="w-1.5 h-1.5 rounded-full bg-greenx"></span>
              auto-saved
            </span>
          </div>

          <div className="space-y-3">
            <div>
              <label className="label">Reels folder (bot picks N random .mp4 videos)</label>
              <div className="flex gap-2">
                <input className="input flex-1" value={reelsFolder} onChange={e => setReelsFolder(e.target.value)}
                  placeholder="C:\\Users\\you\\Videos\\Reels" />
                <button
                  type="button"
                  className="btn-blue !px-3 !py-2 text-xs whitespace-nowrap"
                  onClick={async () => {
                    try {
                      const picked = await api.pickReelsFolder?.();
                      if (picked) setReelsFolder(picked);
                    } catch {}
                  }}
                >📁 Browse</button>
              </div>
              <div className="text-[11px] text-muted mt-1">
                Folder e joto .mp4 / .mov / .m4v / .webm ache — bot random {videosPerUpload} ta select korbe per profile
              </div>
            </div>

            <div className="rounded-lg border border-cyanx/40 bg-cyanx/5 p-3">
              <div className="flex items-center justify-between mb-2">
                <label className="label flex items-center gap-2 mb-0">
                  <span>📝</span>
                  <span>Description Pool</span>
                  <span className="text-muted normal-case tracking-normal font-normal text-[10px]">
                    ({descriptionBoxes.filter(c => (c || '').trim()).length} description{descriptionBoxes.filter(c => (c || '').trim()).length !== 1 ? 's' : ''} · random pick per video)
                  </span>
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    title="Clear all empty boxes"
                    onClick={() => setDescriptionBoxes(prev => {
                      const kept = prev.filter(c => (c || '').trim());
                      return kept.length ? kept : [''];
                    })}
                  >🧹 Clean Empty</button>
                  <button
                    type="button"
                    className="btn-ghost text-xs text-red-400"
                    title="Remove all descriptions"
                    onClick={() => { if (confirm('Clear all descriptions?')) setDescriptionBoxes(['']); }}
                  >🗑 Clear All</button>
                </div>
              </div>

              <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
                {descriptionBoxes.map((c, i) => (
                  <div key={i} className="flex items-start gap-2 group">
                    <div className="pt-2 text-xs text-muted font-mono select-none w-6 text-right">{i + 1}.</div>
                    <textarea
                      className="input font-mono text-xs flex-1"
                      rows={5}
                      value={c}
                      onChange={e => {
                        const v = e.target.value;
                        setDescriptionBoxes(prev => prev.map((x, idx) => idx === i ? v : x));
                      }}
                      placeholder={`Description #${i + 1} — jekono length, hashtags, emoji, links, multi-line paste supported`}
                      spellCheck={false}
                      style={{ resize: 'vertical', minHeight: 90 }}
                    />
                    <button
                      type="button"
                      className="mt-1.5 w-8 h-8 rounded-lg bg-red-500/10 hover:bg-red-500/25 text-red-400 hover:text-red-300 border border-red-500/30 transition flex items-center justify-center text-lg leading-none shrink-0"
                      title="Delete this description"
                      disabled={descriptionBoxes.length === 1}
                      onClick={() => {
                        setDescriptionBoxes(prev => {
                          const next = prev.filter((_, idx) => idx !== i);
                          return next.length ? next : [''];
                        });
                      }}
                    >×</button>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between">
                <div className="text-xs text-muted">
                  💡 Prottek video er jonno alada random description pick hobe. Bot clipboard paste use korbe — big text instant fill.
                </div>
                <button
                  type="button"
                  className="btn-green text-sm px-4"
                  onClick={() => setDescriptionBoxes(prev => [...prev, ''])}
                >➕ Add Description</button>
              </div>
            </div>

            <div>
              <label className="label">Videos per upload (bulk size)</label>
              <input className="input" type="number" min="1" max="50" value={videosPerUpload}
                onChange={e => setVideosPerUpload(e.target.value)} />
              <div className="text-[11px] text-muted mt-1">
                Prottek profile e ekshathe koto video upload hobe (Meta Business Suite max 10 recommended)
              </div>
            </div>

            {/* Headless mode toggle — background silent run vs visible browser */}
            <div className="rounded-lg border border-purplex/30 bg-black/30 p-3 flex items-center justify-between">
              <div className="flex-1 pr-3">
                <div className="text-sm font-semibold text-white flex items-center gap-2">
                  <span>{reelsHeadless ? '👻' : '🖥'}</span>
                  <span>Headless Mode</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                    reelsHeadless ? 'bg-greenx/20 text-greenx' : 'bg-slate-500/20 text-slate-300'
                  }`}>
                    {reelsHeadless ? 'ON' : 'OFF'}
                  </span>
                </div>
                <div className="text-[11px] text-muted mt-1">
                  {reelsHeadless
                    ? 'Browser background e silent chalbe — kono window dekhabe na, faster + less resource.'
                    : 'Browser visible thakbe — apni upload live dekhte parben (default).'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setReelsHeadless(v => !v)}
                className={`relative w-14 h-7 rounded-full transition-colors shrink-0 ${
                  reelsHeadless ? 'bg-greenx' : 'bg-white/20'
                }`}
                title="Toggle headless mode"
              >
                <div
                  className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${
                    reelsHeadless ? 'translate-x-7' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="mt-3 text-[11px] text-slate-400 bg-black/30 rounded px-3 py-2 border border-border">
            <b className="text-cyanx">Flow:</b> Business Suite Home → asset_id detect → Bulk Reels Composer →
            random N videos upload → progress poll → descriptions fill → Publish → dismiss "processing" popup → close
          </div>
        </div>
      )}
      {needsPage && (
        <div className="mt-4">
          <label className="label">Page name pattern</label>
          <input className="input" value={pageName} onChange={e => setPageName(e.target.value)} placeholder="Optional — defaults to <profile> Page" />
        </div>
      )}
      {needsGroups && (
        <div className="mt-4">
          <label className="label">Group links (one per line)</label>
          <textarea className="input" rows="4" value={groupLinks} onChange={e => setGroupLinks(e.target.value)} placeholder="https://facebook.com/groups/xxx" />
        </div>
      )}
      {needsPost && (
        <div className="mt-4">
          <label className="label">Post text</label>
          <textarea className="input" rows="3" value={postText} onChange={e => setPostText(e.target.value)} />
        </div>
      )}
      {isRandomComments && (
        <div className="mt-4 space-y-3 p-3 rounded-lg border border-cyanx/40 bg-cyanx/5">
          <div className="text-sm text-cyanx font-semibold">🎲 Random Reel Commenter (watch-then-comment)</div>
          <div className="text-xs text-slate-400 leading-relaxed">
            Bot will open <code className="text-cyanx">facebook.com/reel/?s=tab</code>, watch <b>{watchPerCycle} reels</b>
            (each for <b>{secondsPerReel} seconds</b>) with no interaction, then post <b>1 random comment</b>
            from your Comment Pool on the <b>next reel</b>. Repeats until the target count is reached.
          </div>
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="label">Watch N reels per cycle</label>
              <input className="input" type="number" min="1" max="100" value={watchPerCycle}
                onChange={e => setWatchPerCycle(e.target.value)} />
              <div className="text-xs text-muted mt-1">Skip N, then comment on (N+1)th</div>
            </div>
            <div>
              <label className="label">Seconds per reel (watch)</label>
              <input className="input" type="number" min="1" max="120" value={secondsPerReel}
                onChange={e => setSecondsPerReel(e.target.value)} />
              <div className="text-xs text-muted mt-1">How long to watch each reel</div>
            </div>
            <div>
              <label className="label">Total comments per profile</label>
              <input className="input" type="number" min="1" max="500" value={commentsPerProfile}
                onChange={e => setCommentsPerProfile(e.target.value)} />
              <div className="text-xs text-muted mt-1">Stop after N comments</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Min cooldown (s)</label>
                <input className="input" type="number" min="5" value={minDelay}
                  onChange={e => setMinDelay(e.target.value)} />
              </div>
              <div>
                <label className="label">Max cooldown (s)</label>
                <input className="input" type="number" min="5" value={maxDelay}
                  onChange={e => setMaxDelay(e.target.value)} />
              </div>
            </div>
          </div>
        </div>
      )}
      {isTargetedComments && (
        <div className="mt-4 rounded-xl border border-purplex/40 bg-gradient-to-br from-purplex/10 to-purplex/5 overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-purplex/30 bg-purplex/10">
            <div className="flex items-center gap-2">
              <span className="text-lg">🎯</span>
              <span className="text-sm text-purplex font-bold">Targeted Reel Comment Finder</span>
            </div>
          </div>

          {/* Action buttons row — inline confirm + toast (NO native dialogs) */}
          {/* Native confirm/alert froze the modal on Electron after closing,   */}
          {/* so we use React state for both the confirmation and the result.  */}
          <div className="px-4 pt-3 flex flex-wrap gap-2 items-center">
            <button type="button" className="btn-ghost text-xs"
              onClick={async () => {
                const r = await api.matchedOpen();
                pushMatchesToast(r.success ? `Opened folder: ${r.path}` : (r.error || 'Failed'), r.success ? 'success' : 'error');
              }}>
              📂 Open Matches Folder
            </button>
            <button type="button" className="btn-ghost text-xs"
              onClick={async () => {
                const r = await api.matchedRead();
                if (!r.success) { pushMatchesToast(r.error || 'Failed', 'error'); return; }
                if (!r.exists)  { pushMatchesToast('No matches yet — file will be created after first successful match', 'info'); return; }
                const w = window.open('', 'matches', 'width=900,height=700');
                if (w) w.document.write('<pre style="font-family:monospace;padding:12px;background:#0b1220;color:#c8d3e4;white-space:pre-wrap">' +
                  r.content.replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])) + '</pre>');
              }}>
              👁 View Matches
            </button>

            {!confirmingClear ? (
              <button type="button" className="btn-ghost text-xs text-red-400"
                onClick={() => setConfirmingClear(true)}>
                🗑 Clear
              </button>
            ) : (
              <span className="inline-flex items-center gap-1.5 bg-red-500/10 border border-red-500/40 rounded-lg px-2 py-1">
                <span className="text-[11px] text-red-300">Clear all matched reels?</span>
                <button type="button"
                  className="text-[11px] px-2 py-0.5 rounded bg-red-500 hover:bg-red-600 text-white font-semibold"
                  onClick={async () => {
                    setConfirmingClear(false);
                    const r = await api.matchedClear();
                    pushMatchesToast(r.success ? 'Cleared.' : (r.error || 'Failed'), r.success ? 'success' : 'error');
                  }}>
                  Yes
                </button>
                <button type="button"
                  className="text-[11px] px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-slate-200"
                  onClick={() => setConfirmingClear(false)}>
                  No
                </button>
              </span>
            )}

            {/* Inline toast — shows next to the buttons, auto-hides */}
            {matchesToast && (
              <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded ${
                matchesToast.type === 'success' ? 'bg-greenx/15 text-greenx border border-greenx/30' :
                matchesToast.type === 'error'   ? 'bg-red-500/15 text-red-300 border border-red-500/30' :
                                                  'bg-cyanx/15 text-cyanx border border-cyanx/30'
              }`}>
                {matchesToast.type === 'success' ? '✓' : matchesToast.type === 'error' ? '✗' : 'ℹ'}
                <span className="truncate max-w-[380px]">{matchesToast.msg}</span>
              </span>
            )}
          </div>

          {/* Description */}
          <div className="px-4 py-3 text-xs text-slate-400 leading-relaxed">
            Bot will open <code className="text-cyanx bg-black/30 px-1.5 py-0.5 rounded">facebook.com/reel/?s=tab</code>, scroll reel-by-reel,
            and inspect each reel's <b className="text-white">existing comments</b>. If any existing comment contains one of your
            keywords/links below, the bot will post a random comment from your Comment Pool on that reel.
          </div>

          {/* Target keywords textarea */}
          <div className="px-4 pb-3">
            <label className="label flex items-center gap-2">
              <span>🔍</span>
              <span>Target Keywords or Links</span>
              <span className="text-muted normal-case tracking-normal font-normal text-[10px]">(one per line — case-insensitive)</span>
            </label>
            <textarea
              className="input font-mono text-xs"
              rows={5}
              value={targetKeywords}
              onChange={e => setTargetKeywords(e.target.value)}
              placeholder={'wa.me\nwhatsapp.com\nt.me\nmy-keyword'}
              spellCheck={false}
              style={{ resize: 'vertical', minHeight: 100 }}
            />
            <div className="text-xs text-muted mt-1.5">
              💡 Example: <code className="text-cyanx bg-black/30 px-1.5 py-0.5 rounded">wa.me</code> matches any comment containing a WhatsApp link.
            </div>
          </div>

          {/* Delay + target count row */}
          <div className="px-4 pb-4 grid grid-cols-3 gap-3">
            <div>
              <label className="label">🎯 Comments per profile</label>
              <input className="input" type="number" min="1" max="500" value={commentsPerProfile}
                onChange={e => setCommentsPerProfile(e.target.value)} />
              <div className="text-xs text-muted mt-1">Target count</div>
            </div>
            <div>
              <label className="label">⏱ Min delay (sec)</label>
              <input className="input" type="number" min="5" value={minDelay}
                onChange={e => setMinDelay(e.target.value)} />
              <div className="text-xs text-muted mt-1">Between comments</div>
            </div>
            <div>
              <label className="label">⏱ Max delay (sec)</label>
              <input className="input" type="number" min="5" value={maxDelay}
                onChange={e => setMaxDelay(e.target.value)} />
              <div className="text-xs text-muted mt-1">Random min–max</div>
            </div>
          </div>
        </div>
      )}
      {needsCmts && (
        <div className="mt-4 rounded-xl border border-cyanx/40 bg-gradient-to-br from-cyanx/10 to-cyanx/5 p-4">
          <div className="flex items-center justify-between mb-3">
            <label className="label flex items-center gap-2 mb-0">
              <span>💬</span>
              <span>Comment Pool</span>
              <span className="text-muted normal-case tracking-normal font-normal text-[10px]">
                ({commentBoxes.filter(c => (c || '').trim()).length} comment{commentBoxes.filter(c => (c || '').trim()).length !== 1 ? 's' : ''} · random pick per reel)
              </span>
              <span className="text-greenx normal-case tracking-normal font-normal text-[10px] flex items-center gap-1" title="Auto-saved to browser — will remain next time you open this modal">
                <span className="w-1.5 h-1.5 rounded-full bg-greenx"></span>
                auto-saved
              </span>
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost text-xs"
                title="Clear all empty boxes"
                onClick={() => setCommentBoxes(prev => {
                  const kept = prev.filter(c => (c || '').trim());
                  return kept.length ? kept : [''];
                })}
              >
                🧹 Clean Empty
              </button>
              <button
                type="button"
                className="btn-ghost text-xs text-red-400"
                title="Remove all comments"
                onClick={() => { if (confirm('Clear all comments?')) setCommentBoxes(['']); }}
              >
                🗑 Clear All
              </button>
            </div>
          </div>

          <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
            {commentBoxes.map((c, i) => (
              <div key={i} className="flex items-start gap-2 group">
                <div className="pt-2 text-xs text-muted font-mono select-none w-6 text-right">{i + 1}.</div>
                <textarea
                  className="input font-mono text-xs flex-1"
                  rows={2}
                  value={c}
                  onChange={e => {
                    const v = e.target.value;
                    setCommentBoxes(prev => prev.map((x, idx) => idx === i ? v : x));
                  }}
                  placeholder={`Comment #${i + 1} — likhun jekono length er, multi-line paste supported`}
                  spellCheck={false}
                  style={{ resize: 'vertical', minHeight: 44 }}
                />
                <button
                  type="button"
                  className="mt-1.5 w-8 h-8 rounded-lg bg-red-500/10 hover:bg-red-500/25 text-red-400 hover:text-red-300 border border-red-500/30 transition flex items-center justify-center text-lg leading-none shrink-0"
                  title="Delete this comment"
                  disabled={commentBoxes.length === 1}
                  onClick={() => {
                    setCommentBoxes(prev => {
                      const next = prev.filter((_, idx) => idx !== i);
                      return next.length ? next : [''];
                    });
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between">
            <div className="text-xs text-muted">
              💡 Each matched reel gets a random comment from this list. Emoji, links, and multi-line text — all supported.
            </div>
            <button
              type="button"
              className="btn-green text-sm px-4"
              onClick={() => setCommentBoxes(prev => [...prev, ''])}
            >
              ➕ Add Comment
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 text-xs text-muted">
        💡 The task runs against <b className="text-white">{count}</b> selected profile(s). Live progress will appear in <b className="text-cyanx">Live Terminal</b>.
      </div>
    </Modal>
  );
}

function CreateProfileModal({ groups, onClose, onSaved, editing }) {
  const [form, setForm] = useState({
    uid: editing?.uid || '',
    name: editing?.name || '',
    group_name: editing?.group_name || 'Default',
    password: editing?.password || '',
    two_fa: editing?.two_fa || '',
    cookies: editing?.cookies || '',
    proxy: editing?.proxy || '',
    start_url: editing?.start_url || '',
    notes: editing?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async (openNow) => {
    if (!form.uid.trim()) return alert('UID is required');
    setSaving(true);
    try {
      const res = await api.upsertProfile({ ...form, uid: form.uid.trim() });
      if (!res.success) { alert(res.error || 'Failed to save'); return; }
      onSaved({ uid: form.uid.trim(), openNow });
    } finally { setSaving(false); }
  };

  return (
    <Modal title={editing ? '✏️ Edit Profile' : '➕ Create Profile'} onClose={onClose} wide
      footer={<>
        <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn-primary" onClick={() => save(false)} disabled={saving}>💾 Save Only</button>
        <button className="btn-green" onClick={() => save(true)} disabled={saving}>💾 Save & Open Browser</button>
      </>}>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">UID (Facebook User ID) *</label>
          <input className="input" value={form.uid} onChange={e => upd('uid', e.target.value)} placeholder="100013793623381" disabled={!!editing} />
        </div>
        <div>
          <label className="label">Display Name</label>
          <input className="input" value={form.name} onChange={e => upd('name', e.target.value)} placeholder="Optional — defaults to Profile <UID>" />
        </div>
        <div>
          <label className="label">Group</label>
          <select className="input" value={form.group_name} onChange={e => upd('group_name', e.target.value)}>
            {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Password</label>
          <input className="input" value={form.password} onChange={e => upd('password', e.target.value)} placeholder="masum@03" />
        </div>
        <div>
          <label className="label">2FA Secret (optional)</label>
          <input className="input" value={form.two_fa} onChange={e => upd('two_fa', e.target.value)} placeholder="TOTP secret" />
        </div>
        <div>
          <label className="label">Proxy (optional)</label>
          <input className="input" value={form.proxy} onChange={e => upd('proxy', e.target.value)} placeholder="host:port:user:pass" />
        </div>
        <div className="col-span-2">
          <label className="label">Default Start URL (optional — when browser opens, it goes here)</label>
          <input className="input" value={form.start_url} onChange={e => upd('start_url', e.target.value)}
                 placeholder="Leave empty → uses Settings default (Facebook)" />
          <div className="text-[11px] text-muted mt-1">
            Example: <code>https://www.facebook.com/reels/</code> or <code>https://www.facebook.com/me</code> or any URL you want.
          </div>
        </div>
        <div className="col-span-2">
          <label className="label">Cookies (Facebook cookie string — from browser DevTools/extension)</label>
          <textarea className="input font-mono text-xs" rows="5" value={form.cookies} onChange={e => upd('cookies', e.target.value)}
                    placeholder="c_user=100013793623381; xs=abc%3A...; datr=...; sb=...; wd=884x505; ..." />
          <div className="text-[11px] text-muted mt-1">
            💡 Paste the full cookie string from Facebook (Chrome DevTools → Application → Cookies, or use a cookie-export extension). Auto-login will try cookies first, then password.
          </div>
        </div>
        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea className="input" rows="2" value={form.notes} onChange={e => upd('notes', e.target.value)} />
        </div>
      </div>
      <div className="mt-4 p-3 rounded-lg bg-cyanx/5 border border-cyanx/20 text-xs text-slate-300">
        <b className="text-cyanx">Tip:</b> "Save &amp; Open Browser" will launch a single dedicated Chromium window for this profile. If cookies are valid, it logs in automatically; otherwise it will try password login, and if both fail it opens the Facebook login page for you to log in manually (session will be remembered next time).
      </div>
    </Modal>
  );
}

function AddToGroupModal({ onClose, groups, onPick }) {
  const [newG, setNewG] = useState('');
  return (
    <Modal title="Move selected to group" onClose={onClose}
      footer={<button className="btn-ghost" onClick={onClose}>Cancel</button>}>
      <div className="space-y-2">
        {groups.map(g => (
          <button key={g.name} className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-white/5 flex justify-between"
                  onClick={() => onPick(g.name)}>
            <span className="text-white font-medium">{g.name}</span>
            <span className="chip">{g.count}</span>
          </button>
        ))}
        <div className="pt-3 border-t border-border">
          <label className="label">Or create new group</label>
          <div className="flex gap-2">
            <input className="input" value={newG} onChange={e => setNewG(e.target.value)} placeholder="e.g. News 3" />
            <button className="btn-primary" onClick={async () => {
              const n = newG.trim(); if (!n) return;
              await api.addGroup(n); onPick(n);
            }}>Create & Move</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
