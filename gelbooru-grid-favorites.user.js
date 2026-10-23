// ==UserScript==
// @name         Gelbooru Grid Favorite Buttons
// @namespace    https://gelbooru.com/
// @version      1.0.0
// @description  Cache-first thumbnail hearts, confirmed favorite writes, full sync, import/export and optional API lookups.
// @author       jaratrozky
// @match        https://gelbooru.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_unregisterMenuCommand
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @connect      gelbooru.com
// ==/UserScript==

(function () {
  'use strict';

  // ╔════════════════════════ CONFIG ════════════════════════╗
  const ORIGIN = 'https://gelbooru.com';
  const REQUEST_TIMEOUT = 20000;
  const FAV_ENDPOINT   = '/public/addfav.php';                 // ?id=<id>
  const UNFAV_ENDPOINT = '/index.php?page=favorites&s=delete'; // &id=<id>
  const VOTE_ENDPOINT  = '/index.php?page=post&s=vote&type=up'; // &id=<id>
  // Native-style upvote pairing: no vote is sent until the favorite is confirmed.

  const FAVS_PER_PAGE   = 50;    // favorites view page size (fixed by site)
  const SCRAPE_WORKERS  = 5;     // parallel scrape workers; each awaits its response before pulling the next pid
  const RESOLVER_MAX    = 100;   // API max posts per response
  const CLUSTER_SPLIT_FACTOR = 8;
  const MAX_RECURSION   = 3;
  const PERPOST_CONCURRENCY = 4; // concurrency is separate from request pacing
  const DEBUG = false;

  // Storage keys
  const K_FAVS   = 'gfb2_favs';      // JSON array of favorited ids (numbers)
  const K_META   = 'gfb2_meta';      // { syncedAt, count }
  const K_CREDS  = 'gfb2_creds';     // legacy credentials, read once for migration
  const K_BACKUP = 'gfb2_favs_backup';
  const K_SET    = 'gfb2_settings';  // { apiFallback: bool }

  // ╔════════════════════════ STATE ════════════════════════╗
  let FAVS = null;          // Set<number> — the trusted collection (null until synced/imported)
  let META = null;          // { syncedAt, count } | null
  let CREDS = null;         // { apiKey, userId, rate } | null
  let SET = null;           // settings
  // Each confirmed post change has its own storage key. A full snapshot records
  // the revisions it replaces; changes made during a scrape remain overlaid.
  const K_SNAPSHOT = 'gfb3_snapshot:';
  const K_CHANGE = 'gfb3_change:';
  const K_EVENT = 'gfb3_event:';
  let changeRevisions = {};
  const busyPosts = new Set();
  const unknownPosts = new Set();
  const versions = new Map();
  let syncRunning = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => { if (DEBUG) console.log('[GFB]', ...a); };

  // ╔════════════════════════ SETTINGS ════════════════════════╗
  function settings() {
    if (SET) return SET;
    try { SET = JSON.parse(GM_getValue(K_SET, '{}')); } catch (e) { SET = {}; }
    if (!SET || typeof SET !== 'object' || Array.isArray(SET)) SET = {};
    SET = { apiFallback: SET.apiFallback === true };
    return SET;
  }
  function saveSettings() { GM_setValue(K_SET, JSON.stringify(settings())); }

  // Storage is account-scoped after credentials have been verified for this page.
  function accountKey(prefix) {
    if (!CREDS) throw new Error('account has not been verified');
    return prefix + CREDS.userId;
  }
  function validId(value) {
    if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value))) return false;
    return Number.isSafeInteger(Number(value));
  }
  function validateIds(value) {
    if (!Array.isArray(value) || value.some((id) => !validId(id))) throw new Error('expected an array of positive integer post IDs');
    return new Set(value.map(Number));
  }
  function readChanges() {
    const prefix = accountKey(K_CHANGE) + ':';
    const records = new Map();
    for (const key of GM_listValues()) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      const record = JSON.parse(GM_getValue(key, 'null'));
      if (!validId(id) || !record || typeof record.fav !== 'boolean' || typeof record.rev !== 'string') {
        throw new Error('invalid stored post change');
      }
      records.set(Number(id), record);
    }
    return records;
  }
  function loadFavs(force = false) {
    if (FAVS !== null && !force) return FAVS;
    FAVS = null; META = null; changeRevisions = {}; unknownPosts.clear();
    try {
      const raw = GM_getValue(accountKey(K_SNAPSHOT), '');
      let snapshot = null;
      if (raw) {
        snapshot = JSON.parse(raw);
        if (!snapshot || !snapshot.meta || String(snapshot.meta.userId) !== CREDS.userId) throw new Error('invalid cache owner');
        FAVS = validateIds(snapshot.ids);
        META = snapshot.meta;
        for (const id of validateIds(snapshot.unknownIds || [])) unknownPosts.add(String(id));
      } else {
        // Read the legacy blob only when its saved credentials identify this account.
        const legacy = JSON.parse(GM_getValue(K_CREDS, 'null'));
        const legacyOwner = GM_getValue('gfb3_legacy_owner', '') || (legacy && legacy.userId);
        if (String(legacyOwner) === CREDS.userId) {
          const old = GM_getValue(K_FAVS, '');
          if (old) {
            FAVS = validateIds(JSON.parse(old));
            META = { ...JSON.parse(GM_getValue(K_META, '{}')), userId: CREDS.userId };
          }
        }
      }
      for (const [id, record] of readChanges()) {
        changeRevisions[id] = record.rev;
        if (!snapshot || !snapshot.seen || snapshot.seen[id] !== record.rev) {
          if (record.known === false) { unknownPosts.add(String(id)); continue; }
          unknownPosts.delete(String(id));
          if (!FAVS) continue;
          if (record.fav) FAVS.add(id); else FAVS.delete(id);
        }
      }
      if (META && FAVS) META = { ...META, count: FAVS.size };
    } catch (e) {
      FAVS = null; META = null;
      console.error('[GFB] cache could not be read:', e.message);
      status('Cache could not be read. Export your backup before importing or syncing.', 'err');
    }
    return FAVS;
  }
  function cacheApply(changes) {
    let applied = 0;
    for (const [rawId, fav, known = true] of changes) {
      if (!validId(rawId) || typeof fav !== 'boolean') throw new Error('invalid favorite change');
      const id = Number(rawId);
      // Never rewrite another post's record, even when a tab has an old snapshot.
      const record = { fav, known, rev: crypto.randomUUID() };
      GM_setValue(accountKey(K_CHANGE) + ':' + id, JSON.stringify(record));
      changeRevisions[id] = record.rev;
      versions.set(String(id), (versions.get(String(id)) || 0) + 1);
      if (known) unknownPosts.delete(String(id)); else unknownPosts.add(String(id));
      if (FAVS && known) {
        if (FAVS.has(id) !== fav) applied++;
        if (fav) FAVS.add(id); else FAVS.delete(id);
      }
    }
    if (META && FAVS) META = { ...META, count: FAVS.size };
    GM_setValue(accountKey(K_EVENT), crypto.randomUUID());
    return applied;
  }
  function commitFull(newSet, syncedAt, seen, unknownIds = []) {
    const ids = [...validateIds([...newSet])];
    const unknown = [...validateIds([...unknownIds])];
    const key = accountKey(K_SNAPSHOT);
    loadFavs(true);
    if (FAVS) GM_setValue(accountKey(K_BACKUP + ':'), JSON.stringify({ ids: [...FAVS], unknownIds: [...unknownPosts], meta: META }));
    const snapshot = { ids, unknownIds: unknown, seen: seen || {}, meta: { userId: CREDS.userId, syncedAt, count: ids.length } };
    GM_setValue(key, JSON.stringify(snapshot));
    loadFavs(true); // overlays confirmed clicks made after the scrape/import began
    GM_setValue(accountKey(K_EVENT), crypto.randomUUID());
  }
  function haveTrustedCache() { return FAVS instanceof Set; }

  // Credentials live in the userscript sandbox for this page only. The account
  // options page is read once at startup and rechecked before a mutation/sync.
  let credsPending = null;
  async function ensureCreds(fresh = false) {
    if (CREDS && !fresh) return CREDS;
    if (credsPending) return credsPending;
    credsPending = (async () => {
      const r = await gmFetch(ORIGIN + '/index.php?page=account&s=options');
      checkHttp(r);
      const text = r.text.replace(/&amp;/g, '&');
      const pair = text.match(/api_key=([0-9a-f]{16,})&user_id=([1-9]\d*)/i);
      if (!pair || !validId(pair[2])) throw new Error('Could not verify account. Log in to Gelbooru first.');
      if (CREDS && CREDS.userId !== pair[2]) throw new Error('Account changed. Reload this page before continuing.');
      CREDS = { apiKey: pair[1], userId: pair[2] };
      let legacy = null;
      try { legacy = JSON.parse(GM_getValue(K_CREDS, 'null')); } catch (e) { log('Legacy credentials are unreadable; import or scrape to initialize this account.'); }
      if (legacy && legacy.userId && !GM_getValue('gfb3_legacy_owner', '')) GM_setValue('gfb3_legacy_owner', String(legacy.userId));
      // Remove the old persisted API key, preserving its owner for cache migration.
      if (legacy && legacy.apiKey) GM_deleteValue(K_CREDS);
      return CREDS;
    })();
    try { return await credsPending; } finally { credsPending = null; }
  }

  // Pace request starts, not just concurrency. This budget is per tab.
  let requestQueue = Promise.resolve();
  let nextRequestAt = 0;
  async function request(url, write = false) {
    const target = new URL(url, ORIGIN);
    if (target.origin !== ORIGIN) throw new Error('refusing a request outside Gelbooru HTTPS');
    const turn = requestQueue.then(async () => {
      await sleep(Math.max(0, nextRequestAt - Date.now()));
      nextRequestAt = Date.now() + 250;
    });
    requestQueue = turn.catch(() => {});
    await turn;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: target.href, timeout: REQUEST_TIMEOUT,
        headers: write ? { 'X-Requested-With': 'XMLHttpRequest' } : {},
        onload: (r) => resolve({ status: r.status, text: r.responseText || '', finalUrl: r.finalUrl }),
        onerror: () => reject(new Error('network error; server outcome unknown')),
        ontimeout: () => reject(new Error('request timed out; server outcome unknown')),
        onabort: () => reject(new Error('request aborted; server outcome unknown')),
      });
    });
  }
  function gmFetch(url) { return request(url); }
  function writeRequest(url) { return request(url, true); }
  function checkHttp(res) {
    if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status);
    if (res.finalUrl && new URL(res.finalUrl, ORIGIN).origin !== ORIGIN) throw new Error('unexpected redirect');
    if (res.finalUrl && new URL(res.finalUrl, ORIGIN).searchParams.get('s') === 'login') throw new Error('logged out');
    if (/<title>[^<]*\b(?:login|sign in)\b|<form[^>]*action=["'][^"']*s=login/i.test(res.text)) throw new Error('logged out');
    if (/<h[1-6][^>]*>\s*Login\s*<\//i.test(res.text) && /type=["']password["']/i.test(res.text)) throw new Error('logged out');
  }
  function checkFavResponse(res) {
    checkHttp(res);
    const body = res.text.trim();
    if (body === '2') throw new Error('logged out');
    if (body !== '1' && body !== '3') throw new Error('unrecognized favorite response; server outcome unknown');
  }
  async function voteUp(id) {
    try {
      const res = await writeRequest(VOTE_ENDPOINT + '&id=' + encodeURIComponent(id));
      checkHttp(res);
      if (!/^-?\d+$/.test(res.text.trim())) throw new Error('unexpected vote response');
    } catch (e) { status('Favorite saved, but the upvote was not confirmed.', 'warn'); }
  }
  async function apiQuery(tags, limit) {
    const c = await ensureCreds();
    const url = `${ORIGIN}/index.php?page=dapi&s=post&q=index&json=1`
      + `&limit=${limit}&tags=${encodeURIComponent(tags)}`
      + `&api_key=${encodeURIComponent(c.apiKey)}&user_id=${encodeURIComponent(c.userId)}`;
    const r = await gmFetch(url);
    checkHttp(r);
    const j = JSON.parse(r.text);
    const rawCount = j && j['@attributes'] && j['@attributes'].count;
    if (!['number', 'string'].includes(typeof rawCount) || !/^\d+$/.test(String(rawCount))) throw new Error('API response has no valid count');
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count)) throw new Error('API count is too large');
    const posts = j.post === undefined && (count === 0 || limit === 0) ? [] : j.post;
    if (!Array.isArray(posts) || posts.some((p) => !p || !validId(p.id))) throw new Error('invalid API post list');
    if (limit > 0 && posts.length !== Math.min(count, limit)) throw new Error('incomplete API result');
    return { count, ids: new Set(posts.map((p) => String(p.id))) };
  }

  // ╔════════════════════════ STATUS PILL ════════════════════════╗
  // Popup policy:
  //   popup  — scrape/sync progress (sticky while running), errors, important notices,
  //            user-invoked actions that need feedback (import/export/settings).
  //   console — routine "script working as it should" messages.
  // Non-sticky popups auto-hide; sticky ones stay until replaced by a non-sticky one.
  let pill = null, pillTimer = null, pillFadeTimer = null;
  function status(msg, tone, opts) {
    opts = opts || {};
    if (!pill) {
      pill = document.createElement('div');
      pill.style.cssText =
        'position:fixed;bottom:10px;right:10px;z-index:2147483647;' +
        'font:12px/1.4 sans-serif;padding:6px 10px;border-radius:6px;' +
        'background:rgba(0,0,0,.8);color:#fff;pointer-events:none;max-width:360px;white-space:pre-line;' +
        'transition:opacity .4s;';
      (document.body || document.documentElement).appendChild(pill);
    }
    clearTimeout(pillTimer); clearTimeout(pillFadeTimer);
    pill.style.background = tone === 'err' ? 'rgba(150,20,20,.92)'
      : tone === 'warn' ? 'rgba(150,110,20,.92)' : 'rgba(0,0,0,.8)';
    pill.textContent = '[Fav] ' + msg;
    pill.style.display = 'block';
    pill.style.opacity = '1';
    if (!opts.sticky) {
      const ms = tone === 'err' ? 12000 : tone === 'warn' ? 8000 : 5000;
      pillTimer = setTimeout(() => {
        pill.style.opacity = '0';
        pillFadeTimer = setTimeout(() => { pill.style.display = 'none'; }, 450);
      }, ms);
    }
  }

  // Full scrapes replace only a validated snapshot. Uncertain/aborted work never
  // commits. Offset pagination is not a server snapshot: reject detectable shifts.
  let syncAbort = false;
  function checkAbort() { if (syncAbort) throw new Error('aborted; cache not replaced'); }
  function parseHtml(html) {
    // Template contents stay inert: parsing a favorites page must not load its images.
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
  }
  function parseFavPage(html, userId) {
    const doc = parseHtml(html);
    const ids = [...new Set([...doc.querySelectorAll('a[id^="p"]')]
      .map((a) => /^p([1-9]\d*)$/.exec(a.id)).filter(Boolean).map((m) => Number(m[1])))];
    if (ids.some((id) => !validId(id))) throw new Error('invalid thumbnail ID');
    let maxPid = 0;
    for (const a of doc.querySelectorAll('a[href]')) {
      const url = new URL(a.getAttribute('href'), ORIGIN);
      const q = url.searchParams;
      if (url.origin !== ORIGIN || q.get('page') !== 'favorites' || q.get('s') !== 'view' || q.get('id') !== String(userId)) continue;
      const raw = q.get('pid');
      if (raw === null) continue;
      const pid = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(pid) || pid % FAVS_PER_PAGE !== 0 || pid > 5000000) throw new Error('unexpected favorites pagination');
      maxPid = Math.max(maxPid, pid);
    }
    const recognized = ids.length > 0 || (/favorites/i.test(doc.querySelector('title')?.textContent || '')
      && !!doc.querySelector('#paginator, #post-list, .thumbnail-container, .thumbnail-preview'));
    if (!recognized) throw new Error('unrecognized favorites page; cache not replaced');
    return { ids, maxPid };
  }
  async function fetchFavPage(pid, c) {
    checkAbort();
    const r = await gmFetch(`${ORIGIN}/index.php?page=favorites&s=view&id=${c.userId}&pid=${pid}`);
    checkAbort(); checkHttp(r);
    return parseFavPage(r.text, c.userId);
  }
  async function withLock(name, fn, ifAvailable = false) {
    if (!navigator.locks) throw new Error('Web Locks unavailable. Use an up-to-date Brave browser.');
    return navigator.locks.request('gfb:' + name, { ifAvailable }, async (lock) => {
      if (!lock) throw new Error('another tab is already syncing/importing this account');
      return fn();
    });
  }
  async function runSync(task) {
    if (syncRunning) { status('A sync/import is already running in this tab.', 'warn'); return; }
    syncRunning = true; syncAbort = false;
    try {
      const c = await ensureCreds(true);
      await withLock('sync:' + c.userId, async () => {
        checkAbort(); loadFavs(true);
        await task(c, { ...changeRevisions });
      }, true);
    } catch (e) { status('Sync/import stopped: ' + e.message, 'err'); }
    finally { syncRunning = false; registerMenu(); }
  }
  async function syncFavorites() {
    return runSync(async (c, seen) => {
      status('Scrape: reading page 1…', null, { sticky: true });
      const first = await fetchFavPage(0, c);
      if (!first.ids.length) {
        const { count } = await apiQuery('fav:' + c.userId, 0);
        checkAbort();
        if (count !== 0 || first.maxPid !== 0) throw new Error('empty page disagrees with API/pagination');
        if (FAVS && FAVS.size && !confirm('The site and API report zero favorites. Replace the local cache? A backup will be kept.')) return;
        checkAbort();
        commitFull(new Set(), Date.now(), seen);
        repaintAll(); status('Scrape complete: 0 favorites.'); return;
      }
      const collected = new Set(first.ids);
      const pids = [];
      for (let pid = FAVS_PER_PAGE; pid <= first.maxPid; pid += FAVS_PER_PAGE) pids.push(pid);
      let pages = 1;
      const collect = (page, pid, promised) => {
        if (promised && !page.ids.length) throw new Error('promised page is empty at offset ' + pid);
        for (const id of page.ids) {
          if (collected.has(id)) throw new Error('favorites shifted during scrape (duplicate post); retry when the list is stable');
          collected.add(id);
        }
        pages++;
        status('Scrape: ' + pages + ' pages · ' + collected.size + ' favorites', null, { sticky: true });
      };
      await pool(pids, async (pid) => collect(await fetchFavPage(pid, c), pid, true), SCRAPE_WORKERS);
      // Always check beyond the advertised last page; a missing/changed paginator
      // must not silently truncate the collection. A failed probe is a failed sync.
      let probePid = Math.max(first.maxPid, 0) + FAVS_PER_PAGE;
      while (true) {
        const page = await fetchFavPage(probePid, c);
        if (!page.ids.length) break;
        collect(page, probePid, false);
        if (page.ids.length < FAVS_PER_PAGE) break;
        probePid += FAVS_PER_PAGE;
        if (probePid > 5000000) throw new Error('pagination did not terminate');
      }
      checkAbort();
      if (first.maxPid && collected.size < first.maxPid) throw new Error('collected fewer favorites than pagination promised');
      const lastCheck = await fetchFavPage(0, c);
      if (JSON.stringify(lastCheck) !== JSON.stringify(first)) throw new Error('favorites changed during scrape; retry when the list is stable');
      checkAbort();
      commitFull(collected, Date.now(), seen);
      repaintAll(); status('Scrape complete: ' + FAVS.size + ' favorites cached.');
    });
  }
  // Additions only. Stopping at a known page is a heuristic, not a complete sync.
  async function quickRefresh() {
    return runSync(async (c, seen) => {
      if (!haveTrustedCache()) throw new Error('run a full scrape first');
      const found = new Set();
      let pages = 0, capped = true;
      for (let pid = 0; pages < 30; pid += FAVS_PER_PAGE) {
        status('Quick refresh: page ' + (pages + 1) + '…', null, { sticky: true });
        const { ids } = await fetchFavPage(pid, c); pages++;
        let added = 0;
        for (const id of ids) if (!FAVS.has(id) && !found.has(id)) { found.add(id); added++; }
        if (!added || ids.length < FAVS_PER_PAGE) { capped = false; break; }
      }
      checkAbort(); loadFavs(true);
      const changes = [...found].filter((id) => changeRevisions[id] === seen[id]).map((id) => [id, true]);
      if (changes.length) cacheApply(changes);
      repaintAll();
      status('Quick refresh: ' + changes.length + ' additions · ' + pages + ' pages.'
        + (capped ? ' Limit reached; use a full scrape for the rest.' : '') + ' Removals require a full scrape.');
    });
  }

  // ╔════════════════════════ IMPORT / EXPORT ════════════════════════╗
  function exportCache() {
    loadFavs(true);
    if (!FAVS) { status('nothing to export', 'warn'); return; }
    const blob = JSON.stringify({ meta: META, ids: [...FAVS], unknownIds: [...unknownPosts] });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
    a.download = 'gelbooru-favorites-cache.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    status('exported ' + FAVS.size + ' ids');
  }
  // NOTE: a detached input.click() needs transient user activation, which Tampermonkey
  // menu commands don't reliably carry into the page (MV3 dispatches them async) — the
  // picker silently never opens. So we show a real in-page panel instead; clicking the
  // input inside it is a genuine user gesture, which always works. Drag & drop too.
  function importCache() {
    if (document.getElementById('gfb-import-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'gfb-import-panel';
    panel.style.cssText =
      'position:fixed;bottom:50px;right:10px;z-index:2147483647;width:300px;box-sizing:border-box;' +
      'background:#1d1d1f;color:#fff;font:13px/1.5 sans-serif;padding:14px;border-radius:8px;' +
      'box-shadow:0 4px 24px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.15);';

    const title = document.createElement('div');
    title.textContent = 'Import favorites cache';
    title.style.cssText = 'font-weight:bold;margin-bottom:8px;';

    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.style.cssText = 'display:block;width:100%;margin:6px 0;color:#ddd;';

    const hint = document.createElement('div');
    hint.textContent = 'Pick the exported .json — or drop it anywhere on this panel.';
    hint.style.cssText = 'color:#aaa;font-size:12px;margin:6px 0 10px;';

    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:4px 12px;border:1px solid rgba(255,255,255,.3);border-radius:5px;' +
      'background:transparent;color:#fff;cursor:pointer;font:12px sans-serif;';
    cancel.addEventListener('click', () => panel.remove());

    const doImport = (f) => {
      if (!f) return;
      if (f.size > 10 * 1024 * 1024) { status('Import is limited to 10 MB.', 'err'); return; }
      const rd = new FileReader();
      rd.onload = async () => {
        try {
          const j = JSON.parse(rd.result);
          const arr = Array.isArray(j) ? j : j.ids;
          const ids = validateIds(arr);
          const unknown = validateIds(j.unknownIds || []);
          await runSync(async (c, seen) => {
            if (j.meta && j.meta.userId && String(j.meta.userId) !== c.userId) throw new Error('import belongs to another account');
            if (!confirm('Replace this account’s local cache with ' + ids.size + ' imported IDs? This does not change favorites on Gelbooru.')) return;
            checkAbort();
            const ts = j.meta && j.meta.syncedAt;
            commitFull(ids, Number.isFinite(ts) && ts >= 0 ? ts : Date.now(), seen, unknown);
            repaintAll(); status('Imported ' + FAVS.size + ' IDs.'); panel.remove();
          });
        } catch (e) { status('import failed: ' + e.message, 'err'); }
      };
      rd.onerror = () => status('import failed: could not read file', 'err');
      rd.readAsText(f);
    };

    inp.addEventListener('change', () => doImport(inp.files[0]));
    panel.addEventListener('dragover', (ev) => { ev.preventDefault(); panel.style.borderColor = '#e63b60'; });
    panel.addEventListener('dragleave', () => { panel.style.borderColor = 'rgba(255,255,255,.15)'; });
    panel.addEventListener('drop', (ev) => {
      ev.preventDefault();
      panel.style.borderColor = 'rgba(255,255,255,.15)';
      doImport(ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]);
    });

    panel.append(title, inp, hint, cancel);
    (document.body || document.documentElement).appendChild(panel);
  }

  // ╔════════════════════════ BUTTON STATE ════════════════════════╗
  const BTN_BASE =
    'position:absolute;top:4px;right:4px;z-index:99999;' +
    'width:28px;height:28px;padding:0;margin:0;box-sizing:border-box;' +
    'border:2px solid rgba(255,255,255,.9);border-radius:50%;' +
    'font:16px/24px sans-serif;text-align:center;cursor:pointer;' +
    'transition:transform .1s,background .15s;user-select:none;color:#fff;';

  function render(btn) {
    const fav = btn.dataset.fav === '1';
    const err = btn.dataset.err === '1';
    const unresolved = btn.dataset.unresolved === '1';
    btn.textContent = err ? '!' : unresolved ? '\u00b7' : (fav ? '\u2665' : '\u2661');
    let bg = fav ? '#e63b60' : 'rgba(0,0,0,.55)';
    if (unresolved) bg = 'rgba(90,90,90,.7)';
    if (err)        bg = '#b00020';
    btn.setAttribute('aria-pressed', unresolved || err ? 'mixed' : String(fav));
    btn.setAttribute('aria-label', (unresolved || err ? 'Check favorite state for post ' : fav ? 'Unfavorite post ' : 'Favorite post ') + btn.dataset.id);
    btn.disabled = busyPosts.has(btn.dataset.id);
    btn.style.background = bg;
    btn.style.opacity = fav ? '1' : '.85';
    btn.title = err ? 'Outcome unknown — click to check (id ' + btn.dataset.id + ')'
      : unresolved ? 'State unknown (id ' + btn.dataset.id + ') — click to check'
      : (fav ? 'Remove from favorites' : 'Add to favorites') + ' (id ' + btn.dataset.id + ')';
  }
  function applyFav(btn, fav) { btn.dataset.err = ''; btn.dataset.fav = fav ? '1' : ''; btn.dataset.resolved = '1'; btn.dataset.unresolved = ''; render(btn); }
  function paintPost(id, fav) {
    document.querySelectorAll('.gfb-btn').forEach((b) => { if (b.dataset.id === String(id)) applyFav(b, fav); });
    document.querySelectorAll('a[data-gfb-toggle]').forEach((a) => {
      if (a.dataset.gfbPostId === String(id)) morphPostLink(a, fav, id);
    });
  }
  function setFav(btn, fav) {
    if (unknownPosts.has(btn.dataset.id) || !FAVS || FAVS.has(Number(btn.dataset.id)) !== fav) cacheApply([[btn.dataset.id, fav]]);
    paintPost(btn.dataset.id, fav);
  }
  function setUnresolved(btn) { btn.dataset.unresolved = '1'; btn.dataset.resolved = ''; render(btn); }
  let resolutionEpoch = 0;
  function repaintAll() {
    resolutionEpoch++;
    document.querySelectorAll('.gfb-btn').forEach((b) => {
      if (busyPosts.has(b.dataset.id)) return;
      if (FAVS && !unknownPosts.has(b.dataset.id)) applyFav(b, FAVS.has(Number(b.dataset.id))); else setUnresolved(b);
    });
    if (FAVS) document.querySelectorAll('a[data-gfb-toggle]').forEach((a) => {
      if (busyPosts.has(a.dataset.gfbPostId)) return;
      if (a.dataset.cacheStamp === postCacheStamp(a.dataset.gfbPostId)) return;
      if (unknownPosts.has(a.dataset.gfbPostId)) { a.dataset.unknown = '1'; a.textContent = 'Check favorite state'; }
      else morphPostLink(a, FAVS.has(Number(a.dataset.gfbPostId)), a.dataset.gfbPostId);
    });
  }
  function resolutionStamp(btn) { return [resolutionEpoch, versions.get(btn.dataset.id) || 0, changeRevisions[btn.dataset.id]]; }
  function acceptResolution(btn, fav, stamp) {
    if (!btn.isConnected || busyPosts.has(btn.dataset.id) || JSON.stringify(stamp) !== JSON.stringify(resolutionStamp(btn))) return;
    setFav(btn, fav);
  }

  // ╔════════════════════════ TOGGLE (optimistic UI, confirmed storage) ════════════════════════╗
  function getCsrfToken() {
    const input = document.querySelector('input[name="csrf-token"]');
    if (input && input.value) return input.value;
    const link = document.querySelector('a[href*="csrf-token="]');
    return link ? new URL(link.href).searchParams.get('csrf-token') || '' : '';
  }

  function postState(doc, id) {
    const header = doc.querySelector('#scrollebox');
    if (!header) throw new Error('unrecognized post controls; server outcome unknown');
    for (const a of header.querySelectorAll('a[href]')) {
      const q = new URL(a.getAttribute('href'), ORIGIN).searchParams;
      if (q.get('page') === 'favorites' && q.get('s') === 'delete' && q.get('id') === String(id)) return true;
    }
    for (const a of header.querySelectorAll('[onclick]')) {
      const match = /addFav\(\s*['"]?(\d+)['"]?\s*\)/.exec(a.getAttribute('onclick') || '');
      if (match && match[1] === String(id)) return false;
    }
    throw new Error('favorite state could not be verified');
  }
  async function readPostState(id) {
    const r = await gmFetch(ORIGIN + '/index.php?page=post&s=view&id=' + encodeURIComponent(id));
    checkHttp(r);
    return postState(parseHtml(r.text), id);
  }
  async function changeFavorite(id, fav) {
    if (!validId(id) || typeof fav !== 'boolean') throw new Error('invalid favorite change');
    return withLock('post:' + CREDS.userId + ':' + id, async () => {
      // Account may have changed while this operation waited behind another tab.
      await ensureCreds(true);
      let url = fav ? FAV_ENDPOINT + '?id=' + id : UNFAV_ENDPOINT + '&id=' + id;
      const token = getCsrfToken();
      if (fav && token) url += '&csrf-token=' + encodeURIComponent(token);
      cacheApply([[id, !!(FAVS && FAVS.has(Number(id))), false]]);
      const r = await writeRequest(url);
      if (fav) checkFavResponse(r);
      else {
        checkHttp(r);
        if (await readPostState(id)) throw new Error('removal not confirmed by post page');
      }
      cacheApply([[id, fav]]);
      paintPost(id, fav);
      if (fav) void voteUp(id);
    });
  }
  async function toggle(btn) {
    const id = btn.dataset.id;
    if (busyPosts.has(id)) return;
    const unknown = btn.dataset.unresolved === '1' || btn.dataset.err === '1';
    const wasFav = btn.dataset.fav === '1';
    busyPosts.add(id);
    versions.set(id, (versions.get(id) || 0) + 1);
    try {
      if (unknown) {
        await withLock('post:' + CREDS.userId + ':' + id, async () => {
          await ensureCreds(true);
          const fav = await readPostState(id);
          cacheApply([[id, fav]]); paintPost(id, fav);
        });
        status('Favorite state checked. Click again to change it.');
      } else {
        paintPost(id, !wasFav); // optimistic UI only; no persistent write yet
        await changeFavorite(id, !wasFav);
      }
    } catch (e) {
      paintPost(id, wasFav);
      document.querySelectorAll('.gfb-btn').forEach((b) => {
        if (b.dataset.id === id) { b.dataset.err = '1'; setUnresolved(b); }
      });
      document.querySelectorAll('a[data-gfb-toggle]').forEach((a) => {
        if (a.dataset.gfbPostId === id) { a.dataset.unknown = '1'; a.textContent = 'Check favorite state'; }
      });
      status(e.message + ' — state not confirmed; click to check before retrying.', 'err');
    } finally {
      busyPosts.delete(id);
      document.querySelectorAll('.gfb-btn').forEach((b) => { if (b.dataset.id === id) render(b); });
    }
  }

  // ╔════════════════════ RESOLVER (cache is truth; API only if enabled) ════════════════════╗
  function median(nums) { if (!nums.length) return 0; const s = [...nums].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function clusterByGap(btns, factor) {
    const sorted = [...btns].sort((a, b) => Number(a.dataset.id) - Number(b.dataset.id));
    if (sorted.length <= 1) return [sorted];
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(Number(sorted[i].dataset.id) - Number(sorted[i - 1].dataset.id));
    const thr = Math.max(1, median(gaps) * factor);
    const out = []; let cur = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (Number(sorted[i].dataset.id) - Number(sorted[i - 1].dataset.id) > thr) { out.push(cur); cur = [sorted[i]]; }
      else cur.push(sorted[i]);
    }
    out.push(cur); return out;
  }
  function splitLargestGap(cl) {
    let bi = 1, bg = -1;
    for (let i = 1; i < cl.length; i++) { const g = Number(cl[i].dataset.id) - Number(cl[i - 1].dataset.id); if (g > bg) { bg = g; bi = i; } }
    return [cl.slice(0, bi), cl.slice(bi)];
  }
  async function resolveCluster(cl, depth, residue, stats) {
    if (!cl.length) return;
    const stamps = new Map(cl.map((b) => [b, resolutionStamp(b)]));
    const c = await ensureCreds();
    const ids = cl.map((b) => Number(b.dataset.id));
    const lo = Math.min(...ids), hi = Math.max(...ids);
    let count, favIds;
    try { ({ count, ids: favIds } = await apiQuery(`fav:${c.userId} id:>=${lo} id:<=${hi}`, RESOLVER_MAX)); stats.req++; }
    catch (e) { cl.forEach((b) => { if (!busyPosts.has(b.dataset.id) && JSON.stringify(stamps.get(b)) === JSON.stringify(resolutionStamp(b))) setUnresolved(b); }); stats.fail += cl.length; console.warn('[GFB] resolver window failed:', e.message); return; }
    if (count <= RESOLVER_MAX) { for (const b of cl) acceptResolution(b, favIds.has(b.dataset.id), stamps.get(b)); stats.windowed += cl.length; return; }
    if (depth >= MAX_RECURSION || cl.length <= 1) { residue.push(...cl); return; }
    const [l, r] = splitLargestGap(cl);
    await Promise.all([resolveCluster(l, depth + 1, residue, stats), resolveCluster(r, depth + 1, residue, stats)]);
  }

  let warnedNoCache = false;
  async function resolveBatch(buttons) {
    loadFavs();
    const targets = buttons.filter((b) => b.dataset.resolved !== '1' && b.isConnected);
    if (!targets.length) return;

    // Cached membership needs no per-thumbnail requests; incomplete writes stay unknown.
    if (haveTrustedCache() && !settings().apiFallback) {
      for (const b of targets) {
        if (unknownPosts.has(b.dataset.id)) setUnresolved(b); else applyFav(b, FAVS.has(Number(b.dataset.id)));
      }
      log('resolved', targets.length, 'from cache');
      return;
    }

    // ---- no cache, fallback disabled: mark unknown and tell the user once ----
    if (!haveTrustedCache() && !settings().apiFallback) {
      for (const b of targets) setUnresolved(b);
      if (!warnedNoCache) {
        warnedNoCache = true;
        status('no favorites cache — hearts marked unknown.\nRun "Scrape favorites" from the Tampermonkey menu (or enable API fallback).', 'warn');
      }
      return;
    }

    // ---- API fallback enabled: resolve against the server; results also update the cache ----
    const stats = { windowed: 0, req: 0, fail: 0 };
    const residue = [];
    for (const cl of clusterByGap(targets, CLUSTER_SPLIT_FACTOR)) await resolveCluster(cl, 0, residue, stats);
    let ppOk = 0, ppFail = 0;
    if (residue.length) {
      await pool(residue, async (b) => {
        const stamp = resolutionStamp(b);
        try { const r = await apiQuery(`fav:${(await ensureCreds()).userId} id:${b.dataset.id}`, 0); acceptResolution(b, r.count > 0, stamp); ppOk++; }
        catch (e) { ppFail++; if (!busyPosts.has(b.dataset.id) && JSON.stringify(stamp) === JSON.stringify(resolutionStamp(b))) setUnresolved(b); }
      }, PERPOST_CONCURRENCY);
    }
    const failed = stats.fail + ppFail;
    log('API resolve:', stats.windowed, 'windowed /', stats.req, 'req ·', ppOk, 'per-post ·', failed, 'failed');
    if (failed) status('API fallback: ' + failed + ' hearts unresolved (marked "·")', 'warn');
  }

  async function pool(items, worker, sizeFn) {
    const q = items.slice();
    const size = typeof sizeFn === 'function' ? sizeFn() : sizeFn;
    let failure = null;
    await Promise.all(Array.from({ length: Math.min(size, q.length) }, async () => {
      while (q.length && !failure) {
        try { await worker(q.shift()); } catch (e) { failure = e; }
      }
    }));
    if (failure) throw failure;
  }

  // Native controls use the same confirmed-write path as grid hearts. Merely
  // visiting a delete URL, or clicking a native control, is not proof of success.
  function postCacheStamp(id) { return JSON.stringify([META && META.syncedAt, changeRevisions[id]]); }
  function morphPostLink(a, fav, postId) {
    a.dataset.cacheStamp = postCacheStamp(postId);
    a.dataset.gfbToggle = '1'; a.dataset.gfbPostId = String(postId);
    a.dataset.fav = fav ? '1' : ''; a.dataset.unknown = '';
    a.textContent = fav ? 'Unfavorite' : 'Favorite';
    a.href = ORIGIN + '/index.php?page=post&s=view&id=' + postId;
    a.removeAttribute('onclick');
    a.title = fav ? 'Remove from favorites' : 'Add to favorites';
  }
  async function postPageToggle(a, postId) {
    if (busyPosts.has(String(postId))) return;
    const proxy = document.createElement('button');
    proxy.dataset.id = String(postId); proxy.dataset.fav = a.dataset.fav;
    proxy.dataset.unresolved = a.dataset.unknown || '';
    await toggle(proxy);
  }
  function hookPostPage() {
    const q = new URLSearchParams(location.search);
    const postId = q.get('id');
    if (q.get('page') !== 'post' || q.get('s') !== 'view' || !validId(postId)) return;
    const header = document.querySelector('#scrollebox');
    if (!header) return;
    try {
      const fav = postState(document, postId);
      for (const a of header.querySelectorAll('a')) {
        const match = /addFav\(\s*['"]?(\d+)['"]?\s*\)/.exec(a.getAttribute('onclick') || '');
        const link = new URL(a.getAttribute('href') || '', ORIGIN).searchParams;
        if ((match && match[1] === postId) || (link.get('page') === 'favorites' && link.get('s') === 'delete' && link.get('id') === postId)) morphPostLink(a, fav, postId);
      }
    } catch (e) { log('Native controls not recognized:', e.message); }
    document.addEventListener('click', (ev) => {
      const a = ev.target instanceof Element && ev.target.closest('a[data-gfb-toggle]');
      if (!a || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      void postPageToggle(a, a.dataset.gfbPostId);
    }, true);
  }

  // ╔════════════════════════ INJECTION ════════════════════════╗
  let pending = []; let pendingTimer = null;
  function scheduleResolve(btn) {
    // Default path resolves SYNCHRONOUSLY, in the same task that created the button:
    // the browser cannot paint mid-task, so red and empty hearts land on the very same
    // first paint — no grey-then-red flicker. The deferred batch below exists only for
    // the paths that genuinely need batching (API-fallback clustering, no-cache notice).
    loadFavs();
    if (haveTrustedCache() && !settings().apiFallback) {
      if (unknownPosts.has(btn.dataset.id)) setUnresolved(btn); else applyFav(btn, FAVS.has(Number(btn.dataset.id)));
      return;
    }
    pending.push(btn);
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { const b = pending; pending = []; resolveBatch(b).catch((e) => status('Resolution failed: ' + e.message, 'err')); }, 0);
  }
  function scheduleResolveAll() { document.querySelectorAll('.gfb-btn').forEach(scheduleResolve); }

  function idFromAnchor(a) {
    if (!a.querySelector('img')) return null;
    if (/^p[1-9]\d*$/.test(a.id) && validId(a.id.slice(1))) return a.id.slice(1);
    const url = new URL(a.getAttribute('href') || '', ORIGIN);
    const q = url.searchParams;
    return url.origin === ORIGIN && q.get('page') === 'post' && q.get('s') === 'view' && validId(q.get('id')) ? q.get('id') : null;
  }
  function processAnchor(a) {
    if (a.dataset.gfb) return;
    const id = idFromAnchor(a);
    if (!id) return;
    let host = a.closest('.thumbnail-preview, article, li, span, div');
    if (!host || [...host.querySelectorAll('a')].filter(idFromAnchor).length !== 1 || host.querySelector('.gfb-btn')) {
      host = document.createElement('span');
      host.style.cssText = 'display:inline-block;position:relative;';
      a.before(host); host.append(a);
    }
    if (getComputedStyle(host).position === 'static' || !getComputedStyle(host).position) host.style.position = 'relative';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'gfb-btn'; btn.style.cssText = BTN_BASE;
    btn.dataset.id = id; btn.dataset.fav = '';
    render(btn);
    btn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); void toggle(btn); });
    host.appendChild(btn); a.dataset.gfb = '1'; scheduleResolve(btn);
  }
  const ANCHOR_SELECTOR = 'a[id^="p"], a[href*="page=post"]';
  function scan(root) { (root || document).querySelectorAll(ANCHOR_SELECTOR).forEach(processAnchor); }

  // ╔════════════════════════ MENU ════════════════════════╗
  function fmtAge(ts) {
    if (!ts) return 'never';
    const d = Math.floor((Date.now() - ts) / 864e5);
    return d === 0 ? 'today' : d + 'd ago';
  }
  const menuIds = [];
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    menuIds.splice(0).forEach((id) => GM_unregisterMenuCommand(id));
    const menu = (label, fn) => menuIds.push(GM_registerMenuCommand(label, fn));
    loadFavs();
    menu('▶ Scrape favorites (full) · last: ' + fmtAge(META && META.syncedAt)
      + (FAVS ? ' · ' + FAVS.size + ' cached' : ''), () => syncFavorites());
    menu('⟳ Quick refresh (newest pages)', () => quickRefresh());
    menu('■ Abort scrape', () => { syncAbort = true; });
    menu('⚙ API fallback: ' + (settings().apiFallback ? 'ON' : 'OFF') + ' — toggle', () => {
      settings().apiFallback = !settings().apiFallback;
      saveSettings();
      status('API fallback ' + (SET.apiFallback ? 'ENABLED — hearts resolve via API queries' : 'DISABLED — cache is the sole source of truth'));
      document.querySelectorAll('.gfb-btn').forEach((b) => { b.dataset.resolved = ''; });
      resolutionEpoch++; scheduleResolveAll(); registerMenu();
    });
    menu('✂ Purge post id(s) from cache', () => {
      loadFavs();
      if (!FAVS) { status('no cache to purge from', 'warn'); return; }
      const inp = prompt('Post id(s) to remove from the cache (comma/space separated):', '');
      if (!inp) return;
      const ids = inp.split(/[\s,]+/).filter(validId).map(Number);
      if (!ids.length) { status('no valid ids entered', 'warn'); return; }
      const removed = cacheApply(ids.map((id) => [id, false])) || 0; // count of changes that actually landed
      status('purged ' + removed + ' id(s) from cache' + (removed < ids.length ? ' · ' + (ids.length - removed) + ' were not present' : ''));
      document.querySelectorAll('.gfb-btn').forEach((b) => { b.dataset.resolved = ''; });
      scheduleResolveAll();
    });
    menu('⤓ Export cache', () => exportCache());
    menu('⤒ Import cache', () => importCache());
    menu('↶ Restore previous cache', () => runSync(async (c, seen) => {
      const raw = GM_getValue(accountKey(K_BACKUP + ':'), '');
      if (!raw) throw new Error('no backup exists');
      const backup = JSON.parse(raw);
      if (!backup.meta || String(backup.meta.userId) !== c.userId) throw new Error('backup account mismatch');
      const ids = validateIds(backup.ids);
      if (!confirm('Restore the previous cache of ' + ids.size + ' IDs? Server favorites are unchanged.')) return;
      checkAbort(); commitFull(ids, backup.meta.syncedAt || Date.now(), seen, validateIds(backup.unknownIds || [])); repaintAll();
      status('Previous cache restored.');
    }));
    menu('↻ Recheck account / credentials', () => ensureCreds(true)
      .then(() => status('Account verified. API credentials are held only in this page’s memory.'))
      .catch((e) => status(e.message, 'err')));
  }

  // ╔════════════════════════ BOOT ════════════════════════╗
  async function boot() {
    await ensureCreds(true);
    loadFavs(); registerMenu(); hookPostPage(); scan();
    const refresh = () => { loadFavs(true); repaintAll(); };
    for (const key of [accountKey(K_SNAPSHOT), accountKey(K_EVENT)]) {
      GM_addValueChangeListener(key, (_key, _old, _next, remote) => { if (remote) refresh(); });
    }
    window.addEventListener('focus', refresh);
    const obs = new MutationObserver((muts) => {
      for (const m of muts) for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(ANCHOR_SELECTOR)) processAnchor(node);
        // Includes images inserted inside a nested span after the anchor exists.
        const parentAnchor = node.closest('a');
        if (parentAnchor) processAnchor(parentAnchor);
        scan(node);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  boot().catch((e) => status(e.message, 'err'));
})();
