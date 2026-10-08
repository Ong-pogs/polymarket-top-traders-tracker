import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeBoards, traderName, shortWallet, slimPosition, netBook, bookSummary, consensus, walkAsks, copyCheck, diffSnapshots, groupStats, refreshCost, FREE_CREDITS} from './engine.mjs';

const W1 = '0x' + '1'.repeat(40), W2 = '0x' + '2'.repeat(40), W3 = '0x' + '3'.repeat(40);
const pos = (extra = {}) => ({marketId: 'm1', outcomeId: 'yes1', title: 'Will it rain?', outcome: 'Yes', size: 1000, avg: 0.4, mark: 0.5, value: 500, unrealized: 100, realized: 0, redeemable: false, negRisk: false, ...extra});
const trader = (wallet, name, positions, extra = {}) => ({wallet, name, ranks: {week: 1}, profit: {week: 1000}, positions, ...extra});

test('a wallet on several boards becomes one trader with each rank, and default handles are shortened', () => {
  const traders = mergeBoards({
    week: [{wallet: W1.toUpperCase().replace('0X', '0x'), displayName: 'alice', rank: 2, profitUsd: 10}],
    month: [{wallet: W1, displayName: 'alice', rank: 5, profitUsd: 40}, {wallet: W2, displayName: `${W2}-1759935795465`, rank: 1, profitUsd: 90}],
    all: [],
  });
  assert.equal(traders.length, 2);
  assert.deepEqual(traders[0].ranks, {week: 2, month: 5});
  assert.equal(traders[1].name, shortWallet(W2));
  assert.equal(traderName('', W3), shortWallet(W3));
  assert.equal(mergeBoards({week: [{wallet: '../../v1/usage', rank: 1}, {wallet: null, rank: 2}], month: [], all: []}).length, 0);
  assert.equal(shortWallet(W3).length, 11);
});

test('a position row keeps the normalized fields and the title from raw', () => {
  const p = slimPosition({marketId: 'm', outcomeId: 'o', side: 'yes', size: 200, avgEntryPrice: 0.25, markPrice: 0.5, unrealizedPnl: 50, realizedPnl: 0, raw: {title: 'T', outcome: 'Yes', redeemable: false, negativeRisk: true}});
  assert.equal(p.value, 100);
  assert.equal(p.title, 'T');
  assert.equal(p.negRisk, true);
});

test('holding both sides of one market nets to nothing at risk', () => {
  const book = bookSummary([
    pos({size: 1619534, mark: 0.55, value: 890743.7, unrealized: 10}),
    pos({outcomeId: 'no1', outcome: 'No', size: 1619534, mark: 0.45, value: 728790.3, unrealized: -10}),
  ]);
  assert.equal(book.net.length, 1);
  assert.equal(book.net[0].bothSides, true);
  assert.equal(book.net[0].netSize, 0);
  assert.equal(book.atRisk, 0);
  assert.ok(Math.abs(book.locked - 1619534) < 1e-6);
  assert.ok(Math.abs(book.gross - 1619534) < 1e-6);
  assert.equal(book.unrealized, 0);
  assert.equal(book.count, 0);
});

test('an uneven pair leaves the difference on the larger side', () => {
  const [row] = netBook([pos({size: 300, outcomeId: 'no1', outcome: 'No', mark: 0.5, value: 150}), pos({size: 1000})]);
  assert.equal(row.outcome, 'Yes');
  assert.equal(row.netSize, 700);
  assert.equal(row.netValue, 350);
  assert.equal(row.lockedShares, 300);
  assert.equal(row.otherOutcome, 'No');
});

test('settled positions waiting to be claimed are not counted as open bets', () => {
  const book = bookSummary([pos({redeemable: true, mark: 1, value: 1000}), pos({marketId: 'm2', outcomeId: 'yes2'})]);
  assert.equal(book.claimable, 1000);
  assert.equal(book.atRisk, 500);
  assert.equal(book.count, 1);
});

test('agreement needs two wallets on the same outcome after netting; opposite sides are a disagreement', () => {
  const big = extra => pos({size: 20000, value: 10000, ...extra});
  const result = consensus([
    trader(W1, 'alice', [big()]),
    trader(W2, 'bob', [big({size: 30000, value: 15000})]),
    trader(W3, 'carol', [big({outcomeId: 'no1', outcome: 'No'})]),
    // Both sides: holds the outcome on paper, bets on nothing, so it must not count as a holder.
    trader('0x' + '4'.repeat(40), 'dave', [big(), big({outcomeId: 'no1', outcome: 'No'})]),
  ], 5000);
  assert.equal(result.agree.length, 1);
  assert.deepEqual(result.agree[0].holders.map(h => h.name), ['bob', 'alice']);
  assert.equal(result.disagree.length, 1);
  assert.deepEqual(result.disagree[0].sides.map(s => s.outcome), ['Yes', 'No']);
});

test('small positions do not count as agreement', () => {
  assert.equal(consensus([trader(W1, 'a', [pos()]), trader(W2, 'b', [pos()])], 5000).agree.length, 0);
});

test('the cost of copying comes from the asks, and a thin book is never reported as a full quote', () => {
  const book = {asks: [{price: 0.5, size: 1000}, {price: 0.6, size: 1000}]};
  const quote = walkAsks(book, 800);
  assert.equal(quote.complete, true);
  assert.ok(Math.abs(quote.shares - (1000 + 300 / 0.6)) < 1e-9);
  assert.ok(quote.average > 0.5 && quote.average < 0.6);
  const thin = walkAsks({asks: [{price: 0.5, size: 100}]}, 1000);
  assert.equal(thin.complete, false);
  assert.equal(thin.spent, 50);
  assert.equal(walkAsks({asks: []}, 100), null);
});

test('their price against yours: what is left to win is one dollar minus the price', () => {
  const check = copyCheck(pos({avg: 0.2, mark: 0.9}), {asks: [{price: 0.9, size: 100000}]}, 1000);
  assert.ok(Math.abs(check.premium - 0.7) < 1e-9);
  assert.ok(Math.abs(check.theirUpside - 0.8) < 1e-9);
  assert.ok(Math.abs(check.yourUpside - 0.1) < 1e-9);
  assert.ok(Math.abs(check.theirReturn - 4) < 1e-9);
  assert.ok(Math.abs(check.yourReturn - 0.1 / 0.9) < 1e-9);
  assert.equal(copyCheck(pos(), {asks: []}).quote, null);
});

test('changes between snapshots: opened, added, reduced, closed and settled', () => {
  const big = extra => pos({size: 20000, value: 10000, ...extra});
  const previous = {takenAt: '2026-10-07T22:00:00.000Z', traders: [trader(W1, 'alice', [big(), big({marketId: 'm2', outcomeId: 'yes2'}), big({marketId: 'm3', outcomeId: 'yes3'}), big({marketId: 'm5', outcomeId: 'yes5'})]), trader(W3, 'gone', [])]};
  const current = {takenAt: '2026-10-08T08:00:00.000Z', traders: [
    trader(W1, 'alice', [big({size: 50000, value: 25000}), big({marketId: 'm3', outcomeId: 'yes3', size: 5000, value: 2500}), big({marketId: 'm4', outcomeId: 'yes4'}), big({marketId: 'm5', outcomeId: 'yes5', redeemable: true, mark: 1, value: 20000})]),
    trader(W2, 'new', [big()]),
  ]};
  const diff = diffSnapshots(previous, current, {minValue: 5000});
  const kinds = Object.fromEntries(diff.changes.map(c => [c.marketId, c.kind]));
  assert.deepEqual(kinds, {m1: 'added', m2: 'closed', m3: 'reduced', m4: 'opened', m5: 'settled'});
  assert.equal(diff.changes.find(c => c.marketId === 'm5').won, true);
  assert.equal(diff.hours, 10);
  assert.deepEqual(diff.board.joined.map(t => t.name), ['new']);
  assert.deepEqual(diff.board.left.map(t => t.name), ['gone']);
  assert.equal(diff.counts.opened, 1);
});

test('a partial read cannot prove a small position is gone, but can for one larger than the last row read', () => {
  const big = extra => pos({size: 20000, value: 10000, ...extra});
  const previous = {takenAt: '2026-10-07T22:00:00.000Z', traders: [trader(W1, 'alice', [big(), big({marketId: 'm2', outcomeId: 'yes2', size: 900000, value: 450000})], {partial: true})]};
  const current = {takenAt: '2026-10-08T08:00:00.000Z', traders: [trader(W1, 'alice', [big({marketId: 'm9', outcomeId: 'yes9'})], {partial: true, unreadMaxShares: 50000})]};
  const diff = diffSnapshots(previous, current, {minValue: 5000});
  assert.equal(diff.changes.find(c => c.marketId === 'm1').unsure, true);
  assert.equal(diff.changes.find(c => c.marketId === 'm2').unsure, false);
  assert.equal(diff.changes.find(c => c.marketId === 'm9').unsure, true); // the earlier read was partial
  assert.equal(diff.counts.unsure, 2);
});

test('a both-sides pile that shrinks is reported even though the net bet is still nothing', () => {
  const pair = size => [pos({size, mark: 0.6, value: size * 0.6}), pos({outcomeId: 'no1', outcome: 'No', size, mark: 0.4, value: size * 0.4})];
  const diff = diffSnapshots({takenAt: '2026-10-07T22:00:00.000Z', traders: [trader(W1, 'alice', pair(1619534))]}, {takenAt: '2026-10-08T08:00:00.000Z', traders: [trader(W1, 'alice', pair(1219534))]});
  assert.equal(diff.changes.length, 1);
  assert.equal(diff.changes[0].kind, 'unpaired');
  assert.equal(diff.changes[0].usd, -400000);
  assert.equal(diff.counts.unpaired, 1);
});

test('the headline compares what a group made with what it has at risk now', () => {
  const stats = groupStats([
    {...trader(W1, 'a', []), ranks: {all: 1}, profit: {all: 22000000}},
    {...trader(W2, 'b', [pos({size: 20000, value: 10000})]), ranks: {all: 2}, profit: {all: 8000000}},
    {...trader(W3, 'c', [pos()]), ranks: {all: 11}, profit: {all: 5}},
  ], 'all', 10);
  assert.equal(stats.wallets, 2);
  assert.equal(stats.profit, 30000000);
  assert.equal(stats.atRisk, 10000);
  assert.equal(stats.nothingOpen, 1);
});

test('one refresh a day at about 280 credits fits the free plan', () => {
  const cost = refreshCost({credits: 280}, 24);
  assert.equal(cost.perMonth, 8400);
  assert.equal(cost.fitsFree, true);
  assert.equal(cost.freeCredits, FREE_CREDITS);
  assert.equal(refreshCost({credits: 280}, 1).fitsFree, false);
});
