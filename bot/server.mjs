import {createServer} from 'node:http';
import {existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULTS, COSTS, FREE_CREDITS, WINDOWS, shortWallet, traderName, mergeBoards, slimPosition, bookSummary, consensus, copyCheck, diffSnapshots, groupStats, refreshCost} from './engine.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const envFile = resolve(project, '.env');
const local = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const unset = value => !value || /your[_ ]key|paste|example/i.test(value);
const key = [process.env.PREDICTEFY_API_KEY, local.PREDICTEFY_API_KEY].find(value => !unset(value));
// Replay shows the saved snapshots without reading anything, so looking at them costs no credits.
const replay = process.env.TRACKER_REPLAY === '1';
const once = process.argv.includes('--once');
if (!key && !replay) {
  console.error('Set PREDICTEFY_API_KEY in .env before starting. Create a key at https://portal.predictefy.com/keys');
  process.exit(1);
}
const port = Number(process.env.TRACKER_PORT || local.TRACKER_PORT || 8818);
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('TRACKER_PORT must be a port between 1024 and 65535.'); process.exit(1); }
const UPGRADE_URL = 'https://predictefy.com/en/pricing?utm_source=youtube&utm_medium=video&utm_campaign=top-traders-tracker&utm_content=upgrade';

const dataDir = resolve(project, process.env.TRACKER_DATA || 'data');
const snapshotDir = resolve(dataDir, 'snapshots'); mkdirSync(snapshotDir, {recursive: true});
const stateFile = resolve(dataDir, 'tracker-state.json'), copyFile = resolve(dataDir, 'copy-checks.json');
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const saved = readJson(stateFile, {});
const copies = readJson(copyFile, {});
const state = {
  replay, startedAt: new Date().toISOString(), busy: false, progress: null, error: null, upgrade: null, logs: [],
  config: {...DEFAULTS, ...saved.config},
  counters: {refreshes: 0, requests: 0, credits: 0, copyChecks: 0, ...saved.counters},
};
const snapshotFiles = () => readdirSync(snapshotDir).filter(name => /^snapshot-.*\.json$/.test(name)).sort();
let latest = null, previous = null, view = null;
function loadSnapshots() {
  const files = snapshotFiles();
  // Names are worked out again on load, so a snapshot saved by an older version still shows shortened handles.
  const read = file => { const snapshot = readJson(resolve(snapshotDir, file), null); for (const t of snapshot?.traders || []) t.name = traderName(t.name, t.wallet); return snapshot; };
  latest = files.length ? read(files.at(-1)) : null;
  previous = files.length > 1 ? read(files.at(-2)) : null;
  view = latest ? buildView() : null;
}

const usd = value => `${value < 0 ? '-' : ''}$${Math.round(Math.abs(value)).toLocaleString('en-US')}`;
function log(text) { state.logs.unshift({at: new Date().toISOString(), text}); state.logs = state.logs.slice(0, 200); console.log(text); }
function save() { writeFileSync(stateFile, JSON.stringify({config: state.config, counters: state.counters}, null, 1)); }

// ---- Predictefy: every request is paced, counted and charged to the running total ----
let lastRequest = 0, usage = null, retryAfter = 0;
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function api(kind, path, params = {}) {
  const url = new URL(path, 'https://data.predictefy.com');
  for (const [name, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
  for (let attempt = 0; ; attempt++) {
    const gap = 60000 / state.config.requestsPerMinute - (Date.now() - lastRequest);
    if (gap > 0) await sleep(gap);
    lastRequest = Date.now();
    const response = await fetch(url, {headers: {authorization: `Bearer ${key}`, accept: 'application/json'}, signal: AbortSignal.timeout(45000), redirect: 'error'});
    const charged = Number(response.headers.get('x-credits-charged') || 0);
    state.counters.requests++; state.counters.credits += charged;
    if (usage && (kind === 'leaderboard' || kind === 'positions')) { const bucket = usage.byKind[kind] ||= {requests: 0, credits: 0}; bucket.requests++; bucket.credits += charged; usage.requests++; usage.credits += charged; }
    const body = await response.json().catch(() => ({}));
    if (response.status === 429 && attempt < 3) { await sleep((Number(response.headers.get('retry-after')) || 5) * 1000); continue; }
    if (response.ok && body.success !== false) return body;
    const code = body.error?.code || 'API_ERROR';
    // Out of credits, or a feature the plan does not include: say so once, with where to change it.
    if (response.status === 402 || (response.status === 403 && code === 'PLAN_REQUIRED')) {
      state.upgrade = {code, status: response.status, what: kind, message: response.status === 402 ? 'This key is out of credits for the month.' : 'This plan does not include that request.', url: UPGRADE_URL, at: new Date().toISOString()};
      log(`PLAN  | ${state.upgrade.message} Plans: ${UPGRADE_URL}`);
    }
    throw Object.assign(new Error(`${response.status} ${code}`), {status: response.status, code});
  }
}

// ---- one refresh: three leaderboards, then each wallet's open positions ----
async function readBook(trader) {
  const rows = []; let cursor, pages = 0;
  while (pages < state.config.maxPages) {
    const body = await api('positions', `/v1/accounts/polymarket/${trader.wallet}/positions`, {limit: 100, cursor});
    pages++;
    const page = body.data || []; rows.push(...page);
    cursor = body.nextCursor ?? body.page?.nextCursor ?? body.meta?.nextCursor;
    if (!cursor || !page.length) break;
  }
  trader.pages = pages; trader.rowCount = rows.length; trader.partial = Boolean(cursor);
  // Rows arrive largest share count first, so every unread row is no bigger than the last one read.
  trader.unreadMaxShares = trader.partial ? Number(rows.at(-1)?.size) || 0 : 0;
  trader.positions = rows.map(slimPosition).filter(p => p.value >= 1);
}

async function refresh() {
  if (state.busy || replay) return;
  state.busy = true; state.error = null; state.upgrade = null; retryAfter = 0;
  usage = {requests: 0, credits: 0, byKind: {}, startedAt: new Date().toISOString()};
  try {
    const boards = {};
    for (const [window, limit] of [['week', state.config.boardWeek], ['month', state.config.boardMonth], ['all', state.config.boardAll]]) {
      const body = await api('leaderboard', '/v1/traders/polymarket/leaderboard', {by: 'profit', window, limit});
      boards[window] = (body.data || []).map(r => ({rank: r.rank, wallet: r.wallet, displayName: r.displayName || '', profitUsd: r.profitUsd, volumeUsd: r.volumeUsd}));
      const top = boards[window][0];
      log(`BOARD | ${window.padEnd(5)} | ${boards[window].length} wallets | #1 ${mergeBoards({[window]: [top]})[0]?.name || '?'} +${usd(top?.profitUsd || 0)}`);
    }
    const traders = mergeBoards(boards);
    log(`BOOKS | ${traders.length} wallets to read, at most ${state.config.requestsPerMinute} requests a minute (* = partial read)`);
    let done = 0;
    for (const trader of traders) {
      state.progress = {done, total: traders.length, name: trader.name};
      try { await readBook(trader); }
      catch (error) { trader.error = error.code || error.message; trader.positions = []; trader.partial = false; if (error.status === 402 || error.status === 401) throw error; }
      done++;
      const book = bookSummary(trader.positions);
      // One line per wallet, kept under 100 characters so it never wraps in a terminal.
      const what = trader.error ? `not read (${trader.error})` : book.atRisk < 1 && book.locked < 1 ? 'nothing open' : `at risk ${usd(book.atRisk).padStart(10)}${book.locked >= 100 ? `   both sides ${usd(book.locked)}` : ''}`;
      log(`BOOK  ${String(done).padStart(2)}/${traders.length}  ${trader.name.slice(0, 22).padEnd(22)}  ${String(trader.rowCount ?? 0).padStart(3)} rows${trader.partial ? '*' : ' '}  ${what}`);
    }
    usage.finishedAt = new Date().toISOString(); usage.seconds = Math.round((Date.parse(usage.finishedAt) - Date.parse(usage.startedAt)) / 1000);
    const snapshot = {takenAt: usage.finishedAt, source: 'Predictefy: GET /v1/traders/polymarket/leaderboard and GET /v1/accounts/polymarket/{wallet}/positions',
      settings: {boardWeek: state.config.boardWeek, boardMonth: state.config.boardMonth, boardAll: state.config.boardAll, maxPages: state.config.maxPages}, boards, traders, usage};
    writeFileSync(resolve(snapshotDir, `snapshot-${snapshot.takenAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(snapshot, null, 1));
    state.counters.refreshes++; save(); loadSnapshots();
    const cost = refreshCost(usage, state.config.refreshHours);
    log(`DONE  | ${traders.length} wallets | ${usage.requests} requests | ${usage.credits} credits | ${view.totals.nothingOpen} with nothing open | ${view.totals.partial} partial`);
    log(`COST  | a refresh every ${state.config.refreshHours} hours is about ${cost.perMonth.toLocaleString('en-US')} credits a month. The free plan has ${FREE_CREDITS.toLocaleString('en-US')}.`);
  } catch (error) {
    // A failed refresh is not retried every minute: wait a quarter of an hour, and not at all once the plan has said no.
    state.error = error.message; retryAfter = Date.now() + 15 * 60e3;
    log(`ERROR | refresh stopped: ${error.message}`);
  }
  finally { state.busy = false; state.progress = null; usage = null; }
}

// ---- what the dashboard shows, worked out once per snapshot ----
function buildView() {
  const traders = latest.traders.map(t => {
    const book = bookSummary(t.positions || []);
    return {wallet: t.wallet, short: shortWallet(t.wallet), name: t.name, ranks: t.ranks, profit: t.profit, pages: t.pages, rowCount: t.rowCount, partial: Boolean(t.partial), unreadMaxShares: t.unreadMaxShares || 0, error: t.error || null,
      atRisk: book.atRisk, locked: book.locked, gross: book.gross, claimable: book.claimable, unrealized: book.unrealized, count: book.count, bothSidesCount: book.bothSidesCount,
      positions: book.net.filter(r => r.grossValue >= 1)};
  });
  const empty = t => t.atRisk < 1 && t.locked < 1;
  return {
    takenAt: latest.takenAt, settings: latest.settings, usage: latest.usage || null, traders,
    boards: Object.fromEntries(WINDOWS.map(w => [w, traders.filter(t => t.ranks[w]).sort((a, b) => a.ranks[w] - b.ranks[w]).map(t => t.wallet)])),
    stats: Object.fromEntries(WINDOWS.map(w => [w, groupStats(latest.traders, w, 10)])),
    totals: {wallets: traders.length, nothingOpen: traders.filter(empty).length, partial: traders.filter(t => t.partial).length, errors: traders.filter(t => t.error).length,
      atRisk: traders.reduce((sum, t) => sum + t.atRisk, 0), locked: traders.reduce((sum, t) => sum + t.locked, 0), bothSides: traders.filter(t => t.locked >= 100).length},
    consensus: consensus(latest.traders, state.config.minValue),
    changes: previous ? diffSnapshots(previous, latest, {minValue: state.config.minValue}) : null,
    cost: refreshCost(latest.usage, state.config.refreshHours),
  };
}

// The copy check reads the live order book and a week of hourly prices for one position: 10 credits.
async function runCopyCheck(wallet, marketId) {
  const trader = view?.traders.find(t => t.wallet === wallet), position = trader?.positions.find(p => p.marketId === marketId);
  if (!position) return {error: 'Position not found'};
  const id = `${wallet}:${marketId}`;
  if (replay && copies[id]) return {...copies[id], recorded: true};
  if (!key) return {error: 'No API key: replay can only show copy checks that were saved earlier'};
  const result = {wallet, marketId, outcomeId: position.outcomeId, capturedAt: new Date().toISOString(), copyUsd: state.config.copyUsd, historyDays: state.config.historyDays, credits: 0, errors: []};
  try {
    const book = (await api('orderBook', '/api/polymarket/fetchOrderBook', {outcomeId: position.outcomeId, limit: 50})).data;
    result.book = {asks: (book.asks || []).slice(0, 8), bids: (book.bids || []).slice(0, 8), asOf: book.asOf || book.datetime, levels: {asks: (book.asks || []).length, bids: (book.bids || []).length}};
    result.check = copyCheck(position, book, state.config.copyUsd);
    result.credits += COSTS.orderBook;
  } catch (error) { result.errors.push(`order book: ${error.message}`); }
  try {
    const candles = (await api('candles', '/api/polymarket/fetchOHLCV', {outcomeId: position.outcomeId, resolution: '1h', start: new Date(Date.now() - state.config.historyDays * 864e5 + 3600e3).toISOString(), end: new Date().toISOString(), limit: 1000})).data || [];
    result.series = candles.filter(c => Number.isFinite(c.close)).map(c => [c.timestamp, c.close]);
    result.seriesSource = candles[0] ? {source: candles[0].source, sourceType: candles[0].sourceType, isTrueCandle: candles[0].isTrueCandle} : null;
    result.credits += COSTS.candles;
  } catch (error) { result.errors.push(`price history: ${error.message}`); }
  if (state.upgrade) result.upgrade = state.upgrade;
  state.counters.copyChecks++; save();
  if (result.check || result.series) { copies[id] = result; writeFileSync(copyFile, JSON.stringify(copies, null, 1)); }
  log(`COPY  | ${trader.name} | ${(position.title || '').slice(0, 44)} — ${position.outcome} | entry ${(position.avg * 100).toFixed(1)}¢ | ${result.check?.quote ? `${usd(state.config.copyUsd)} now averages ${(result.check.quote.average * 100).toFixed(1)}¢` : 'no quote'}`);
  return result;
}

function json(res, body, status = 200) { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(body)); }
const sameOrigin = req => !req.headers.origin || req.headers.origin === `http://127.0.0.1:${port}`;
const LIMITS = [['boardWeek', 0, 100], ['boardMonth', 0, 100], ['boardAll', 0, 100], ['maxPages', 1, 20], ['refreshHours', 1, 720], ['requestsPerMinute', 10, 3000], ['minValue', 100, 10000000], ['copyUsd', 10, 1000000], ['historyDays', 1, 365]];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === '/api/state') return json(res, {...state, logs: state.logs.slice(0, 60), view, freeCredits: FREE_CREDITS, costs: COSTS, savedCopyChecks: Object.keys(copies), nextRefreshAt: view && !replay ? new Date(Date.parse(view.takenAt) + state.config.refreshHours * 3600e3).toISOString() : null});
    if (url.pathname === '/api/copy') return json(res, await runCopyCheck(url.searchParams.get('wallet'), url.searchParams.get('market')));
    if (url.pathname === '/api/config' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, {error: 'Local requests only'}, 403);
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 4096) return json(res, {error: 'Request too large'}, 413); }
      const incoming = JSON.parse(text);
      for (const [name, min, max] of LIMITS) {
        if (incoming[name] === undefined) continue;
        if (!Number.isFinite(incoming[name]) || incoming[name] < min || incoming[name] > max) return json(res, {error: `Invalid ${name}`}, 400);
        state.config[name] = incoming[name];
      }
      save(); if (latest) view = buildView();
      log(`CONFIG | refresh every ${state.config.refreshHours}h | boards ${state.config.boardWeek}/${state.config.boardMonth}/${state.config.boardAll} | up to ${state.config.maxPages} pages a wallet | positions from ${usd(state.config.minValue)}`);
      return json(res, {config: state.config});
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, {error: 'Local requests only'}, 403);
      if (replay) return json(res, {error: 'Replay mode does not read new data'}, 409);
      refresh(); return json(res, {started: true});
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const root = resolve(project, 'bot/public'), target = resolve(root, relative);
    if (target !== root && !target.startsWith(root + sep)) return json(res, {error: 'Not found'}, 404);
    if (!existsSync(target)) return json(res, {error: 'Not found'}, 404);
    const type = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png'}[extname(target)] || 'application/octet-stream';
    res.writeHead(200, {'content-type': `${type};charset=utf-8`}); res.end(readFileSync(target));
  } catch (error) { json(res, {error: error.message}, 500); }
});

loadSnapshots();
const due = () => !state.upgrade && Date.now() >= retryAfter && (!latest || Date.now() - Date.parse(latest.takenAt) >= state.config.refreshHours * 3600e3);
if (once) {
  log('Reading Polymarket\'s profit leaderboards through Predictefy. Read-only: no orders, no wallet keys.');
  await refresh();
  process.exit(state.error ? 1 : 0);
}
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set TRACKER_PORT to another local port.` : 'The local server could not start.'); process.exit(1); });
server.listen(port, '127.0.0.1', async () => {
  log(`Top Traders Tracker running at http://127.0.0.1:${port}`);
  if (replay) return log(`Replay mode: showing the snapshot of ${latest?.takenAt || '(none saved yet)'}. Nothing is being read.`);
  log('Reading Polymarket\'s profit leaderboards through Predictefy. Read-only: no orders, no wallet keys.');
  if (due()) await refresh();
  else log(`FRESH | the last snapshot is ${((Date.now() - Date.parse(latest.takenAt)) / 3600e3).toFixed(1)} hours old; the next refresh is due after ${state.config.refreshHours} hours`);
  setInterval(() => { if (due() && !state.busy) refresh(); }, 60000);
});
process.on('SIGINT', () => { save(); server.close(); process.exit(0); });
