// Pure functions: no network, no files. Everything the tracker concludes from the data is decided here.

export const DEFAULTS = {
  boardWeek: 15, boardMonth: 25, boardAll: 25, // wallets taken from each profit leaderboard
  maxPages: 4,          // pages of 100 positions read per wallet before the book is labelled partial
  refreshHours: 24,     // one refresh a day lasts all month on the free plan
  requestsPerMinute: 50, // the free plan allows 60
  minValue: 5000,       // a position counts for agree, disagree and changes from this many dollars
  copyUsd: 1000,        // the copy check prices a buy of this size
  historyDays: 7,       // the free plan reads 7 days of price history
};
export const FREE_CREDITS = 25000;
export const COSTS = {leaderboard: 1, positions: 3, orderBook: 5, candles: 5};
export const WINDOWS = ['week', 'month', 'all'];

export const shortWallet = wallet => wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : '';
// Polymarket gives accounts without a chosen name a handle made from an address. Show those shortened.
export const traderName = (displayName, wallet) => !displayName || /^0x[a-f0-9]{16,}/i.test(displayName) ? shortWallet(wallet) : displayName;
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;

// One trader list from the three boards: a wallet on several boards appears once, with each rank.
export function mergeBoards(boards) {
  const traders = new Map();
  for (const window of WINDOWS) for (const row of boards[window] || []) {
    if (!/^0x[a-f0-9]{40}$/i.test(row?.wallet || '')) continue; // only a real address is ever put into a request path
    const wallet = row.wallet.toLowerCase();
    const t = traders.get(wallet) || {wallet, name: traderName(row.displayName, wallet), ranks: {}, profit: {}, volume: {}};
    t.ranks[window] = row.rank; t.profit[window] = row.profitUsd ?? null; t.volume[window] = row.volumeUsd ?? null;
    traders.set(wallet, t);
  }
  return [...traders.values()];
}

// The fields the tracker keeps from one row of GET /v1/accounts/polymarket/{wallet}/positions.
export function slimPosition(row) {
  const raw = row.raw || {}, size = num(row.size), mark = num(row.markPrice);
  return {
    marketId: row.marketId, outcomeId: row.outcomeId, title: raw.title || null, outcome: raw.outcome || row.side || null,
    slug: raw.slug || null, eventSlug: raw.eventSlug || null, size, avg: num(row.avgEntryPrice), mark, value: size * mark,
    unrealized: num(row.unrealizedPnl), realized: num(row.realizedPnl), endDate: raw.endDate || null,
    redeemable: Boolean(raw.redeemable), negRisk: Boolean(raw.negativeRisk), asOf: row.asOf || null,
  };
}

// A wallet holding both outcomes of one market is not betting on it: one share of each pays $1 whatever happens.
// Net those pairs out and keep what is left on the larger side.
export function netBook(positions) {
  const byMarket = new Map();
  for (const p of positions) { const list = byMarket.get(p.marketId) || []; list.push(p); byMarket.set(p.marketId, list); }
  const rows = [];
  for (const sides of byMarket.values()) {
    const sorted = [...sides].sort((a, b) => b.size - a.size), main = sorted[0], other = sorted[1];
    // Only a two-outcome market can be netted this way. Three or more rows in one market is left as it is.
    const paired = sorted.length === 2 && other.outcomeId !== main.outcomeId && other.size > 0;
    const lockedShares = paired ? other.size : 0, netSize = main.size - lockedShares;
    rows.push({
      marketId: main.marketId, outcomeId: main.outcomeId, title: main.title, outcome: main.outcome, slug: main.slug, eventSlug: main.eventSlug,
      size: main.size, netSize, avg: main.avg, mark: main.mark, netValue: netSize * main.mark,
      grossValue: sorted.reduce((sum, p) => sum + p.value, 0),
      lockedShares, lockedValue: paired ? lockedShares * (main.mark + other.mark) : 0,
      bothSides: paired, otherOutcome: paired ? other.outcome : null, otherSize: paired ? other.size : 0,
      // Polymarket reports profit per side; for a pair the honest figure is the two together.
      unrealized: sorted.reduce((sum, p) => sum + p.unrealized, 0),
      endDate: main.endDate, redeemable: sorted.every(p => p.redeemable), negRisk: sorted.some(p => p.negRisk),
      extraRows: sorted.length > 2 ? sorted.length : 0,
    });
  }
  return rows.sort((a, b) => b.grossValue - a.grossValue);
}

// What a trader has on the table right now.
export function bookSummary(positions) {
  const net = netBook(positions);
  const live = net.filter(r => !r.redeemable), settled = net.filter(r => r.redeemable);
  const sum = (rows, field) => rows.reduce((total, r) => total + r[field], 0);
  return {
    net,
    gross: sum(live, 'grossValue'),       // everything in unsettled markets, counting both sides
    atRisk: sum(live, 'netValue'),        // what is actually riding on an outcome
    locked: sum(live, 'lockedValue'),     // both-sides pairs: pays the same whatever happens
    claimable: sum(settled, 'grossValue'), // settled markets not yet cashed in
    unrealized: sum(live, 'unrealized'),
    count: live.filter(r => r.netValue >= 100).length,
    bothSidesCount: live.filter(r => r.bothSides && r.lockedValue >= 100).length,
  };
}

// Outcomes several tracked wallets hold after netting, and markets where they sit on opposite sides.
export function consensus(traders, minValue = DEFAULTS.minValue) {
  const byOutcome = new Map(), byMarket = new Map();
  for (const t of traders) for (const r of netBook(t.positions || [])) {
    if (r.redeemable || r.netValue < minValue) continue;
    const e = byOutcome.get(r.outcomeId) || {marketId: r.marketId, outcomeId: r.outcomeId, title: r.title, outcome: r.outcome, slug: r.slug, mark: r.mark, endDate: r.endDate, negRisk: r.negRisk, holders: []};
    e.holders.push({wallet: t.wallet, name: t.name, ranks: t.ranks, value: r.netValue, size: r.netSize, avg: r.avg, unrealized: r.unrealized, bothSides: r.bothSides});
    byOutcome.set(r.outcomeId, e);
  }
  const total = e => e.holders.reduce((sum, h) => sum + h.value, 0);
  const all = [...byOutcome.values()].map(e => ({...e, total: total(e), holders: e.holders.sort((a, b) => b.value - a.value)}));
  for (const e of all) { const list = byMarket.get(e.marketId) || []; list.push(e); byMarket.set(e.marketId, list); }
  const agree = all.filter(e => e.holders.length > 1).sort((a, b) => b.total - a.total || b.holders.length - a.holders.length); // most dollars first
  const disagree = [...byMarket.values()].filter(sides => sides.length > 1 && new Set(sides.flatMap(e => e.holders.map(h => h.wallet))).size > 1)
    .map(sides => ({marketId: sides[0].marketId, title: sides[0].title, slug: sides[0].slug, endDate: sides[0].endDate, negRisk: sides.some(s => s.negRisk), total: sides.reduce((sum, s) => sum + s.total, 0), sides: sides.sort((a, b) => b.total - a.total)}))
    .sort((a, b) => b.total - a.total);
  return {agree, disagree, held: all.length};
}

// Walk the asks to see what a buy of `usd` dollars would really cost. Never reports a full quote the book cannot fill.
export function walkAsks(book, usd) {
  const asks = (book?.asks || []).filter(l => l.price > 0 && l.size > 0).sort((a, b) => a.price - b.price);
  if (!asks.length || !(usd > 0)) return null;
  let left = usd, shares = 0, spent = 0, worst = asks[0].price;
  for (const level of asks) {
    const take = Math.min(left, level.price * level.size);
    shares += take / level.price; spent += take; left -= take; worst = level.price;
    if (left <= 1e-9) break;
  }
  return {bestAsk: asks[0].price, shares, spent, average: spent / shares, worst, complete: left <= 1e-9, wanted: usd};
}

// Their price against yours. Every share pays $1 if the outcome happens, so what is left to win is 1 minus the price.
export function copyCheck(position, book, usd = DEFAULTS.copyUsd) {
  const quote = walkAsks(book, usd);
  if (!quote) return {entry: position.avg, quote: null, reason: 'No asks on the book right now'};
  const theirUpside = 1 - position.avg, yourUpside = 1 - quote.average;
  return {
    entry: position.avg, mark: position.mark, quote,
    premium: quote.average - position.avg,            // what you pay per share on top of what they paid
    theirUpside, yourUpside,                           // dollars left to win per share
    theirReturn: position.avg > 0 ? theirUpside / position.avg : null, // profit per dollar staked if it pays out
    yourReturn: yourUpside / quote.average,
    slippage: quote.average - quote.bestAsk,
  };
}

// What moved between two snapshots. A partial read can hide a small position, so a change that depends on one is marked unsure.
export function diffSnapshots(previous, current, {minValue = DEFAULTS.minValue} = {}) {
  const before = new Map(previous.traders.map(t => [t.wallet.toLowerCase(), t]));
  const changes = [], board = {joined: [], left: []};
  const names = new Set(current.traders.map(t => t.wallet.toLowerCase()));
  for (const t of previous.traders) if (!names.has(t.wallet.toLowerCase())) board.left.push({wallet: t.wallet, name: t.name, ranks: t.ranks});
  for (const t of current.traders) {
    const old = before.get(t.wallet.toLowerCase());
    if (!old) { board.joined.push({wallet: t.wallet, name: t.name, ranks: t.ranks}); continue; }
    const was = new Map(netBook(old.positions || []).map(r => [r.marketId, r])), now = new Map(netBook(t.positions || []).map(r => [r.marketId, r]));
    const add = (kind, r, extra = {}) => changes.push({kind, wallet: t.wallet, name: t.name, ranks: t.ranks, marketId: r.marketId, outcomeId: r.outcomeId, title: r.title, outcome: r.outcome, slug: r.slug, mark: r.mark, avg: r.avg, bothSides: r.bothSides, negRisk: r.negRisk, ...extra});
    for (const [marketId, r] of now) {
      const o = was.get(marketId);
      if (!o) {
        if (r.redeemable || r.netValue < minValue) continue;
        // If the earlier read stopped early, this position may simply not have been read then.
        add('opened', r, {usd: r.netValue, shares: r.netSize, unsure: Boolean(old.partial)});
      } else if (r.redeemable && !o.redeemable) {
        if (Math.max(o.netValue, r.grossValue) >= minValue) add('settled', r, {usd: r.grossValue, shares: r.size, won: r.mark >= 0.5, before: o.netValue});
      } else if (!r.redeemable) {
        if (o.outcomeId !== r.outcomeId && Math.max(o.netValue, r.netValue) >= minValue) { add('flipped', r, {usd: r.netValue, shares: r.netSize, from: o.outcome}); continue; }
        const delta = r.netSize - o.netSize, usd = delta * r.mark;
        if (Math.abs(usd) >= minValue && Math.abs(delta) >= 0.05 * Math.max(o.netSize, 1)) add(delta > 0 ? 'added' : 'reduced', r, {usd, shares: delta, sharesBefore: o.netSize, sharesNow: r.netSize});
        // A both-sides pile can shrink or grow while the net bet stays at nothing. Each pair is worth $1, so pairs are dollars.
        const pairs = r.lockedShares - o.lockedShares;
        if (Math.abs(pairs) >= minValue) add(pairs > 0 ? 'paired' : 'unpaired', r, {usd: pairs, shares: pairs, pairsBefore: o.lockedShares, pairsNow: r.lockedShares});
      }
    }
    for (const [marketId, o] of was) {
      if (now.has(marketId) || o.redeemable || o.netValue < minValue) continue;
      // Rows come largest first, so a partial read still proves a position is gone when it was bigger than the last row read.
      const unsure = Boolean(t.partial) && !(t.unreadMaxShares > 0 && o.size > t.unreadMaxShares);
      add('closed', o, {usd: -o.netValue, shares: -o.netSize, unsure});
    }
  }
  changes.sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));
  const count = kind => changes.filter(c => c.kind === kind && !c.unsure).length;
  return {from: previous.takenAt, to: current.takenAt, hours: (Date.parse(current.takenAt) - Date.parse(previous.takenAt)) / 3600e3, changes, board,
    counts: {opened: count('opened'), closed: count('closed'), added: count('added'), reduced: count('reduced'), settled: count('settled'), flipped: count('flipped'), unpaired: count('unpaired'), paired: count('paired'), unsure: changes.filter(c => c.unsure).length}};
}

// The numbers the board leads with: what a group of leaders made, against what they have open now.
export function groupStats(traders, window, top = 10) {
  const group = traders.filter(t => t.ranks[window] && t.ranks[window] <= top).sort((a, b) => a.ranks[window] - b.ranks[window]);
  const books = group.map(t => ({t, book: bookSummary(t.positions || [])}));
  return {
    window, top, wallets: group.length,
    profit: group.reduce((sum, t) => sum + num(t.profit[window]), 0),
    atRisk: books.reduce((sum, b) => sum + b.book.atRisk, 0),
    locked: books.reduce((sum, b) => sum + b.book.locked, 0),
    nothingOpen: books.filter(b => b.book.atRisk < 1 && b.book.locked < 1).length,
    partial: group.filter(t => t.partial).length, unread: group.filter(t => t.error).length,
  };
}

// Credits for one refresh, and what a month of refreshes at this interval adds up to.
export function refreshCost(usage, refreshHours = DEFAULTS.refreshHours) {
  const perRefresh = usage?.credits ?? 0, perMonth = perRefresh * (30 * 24 / refreshHours);
  return {perRefresh, refreshHours, perMonth: Math.round(perMonth), freeCredits: FREE_CREDITS, shareOfFree: perMonth / FREE_CREDITS, fitsFree: perMonth <= FREE_CREDITS,
    copyChecksLeft: Math.max(0, Math.floor((FREE_CREDITS - perMonth) / (COSTS.orderBook + COSTS.candles)))};
}
