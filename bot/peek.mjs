// Print the raw rows the tracker reads, so you can see what Predictefy returns.
//   node bot/peek.mjs board [week|month|all]     one row of Polymarket's profit leaderboard (1 credit)
//   node bot/peek.mjs book <handle or wallet>    one row of that wallet's open positions (3 credits, plus 3 to find a handle)
import {existsSync, readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {shortWallet} from './engine.mjs';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
const local = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const unset = value => !value || /your[_ ]key|paste|example/i.test(value);
const key = [process.env.PREDICTEFY_API_KEY, local.PREDICTEFY_API_KEY].find(value => !unset(value));
if (!key) { console.error('Set PREDICTEFY_API_KEY in .env first.'); process.exit(1); }

const base = 'https://data.predictefy.com';
async function get(path) {
  const response = await fetch(base + path, {headers: {authorization: `Bearer ${key}`}});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { console.error(`${response.status} ${body.error?.code || ''}`); process.exit(1); }
  return {body, credits: response.headers.get('x-credits-charged')};
}
const clip = id => typeof id === 'string' && id.length > 24 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
const [mode = 'board', arg] = process.argv.slice(2);

if (mode === 'board') {
  const window = ['week', 'month', 'all'].includes(arg) ? arg : 'all';
  const path = `/v1/traders/polymarket/leaderboard?by=profit&window=${window}&limit=25`;
  const {body, credits} = await get(path);
  console.log(`GET ${base}${path}\n`);
  console.log(JSON.stringify({...body.data[0], wallet: shortWallet(body.data[0].wallet)}, null, 2));
  console.log(`\n${body.data.length} rows, ${credits} credit. Showing rank 1. Wallet shortened for display.`);
} else if (mode === 'book') {
  if (!arg) { console.error('Give a leaderboard handle or a wallet address: node bot/peek.mjs book <handle>'); process.exit(1); }
  let wallet = /^0x[a-f0-9]{40}$/i.test(arg) ? arg.toLowerCase() : null;
  for (const window of ['week', 'month', 'all']) {
    if (wallet) break;
    const {body} = await get(`/v1/traders/polymarket/leaderboard?by=profit&window=${window}&limit=100`);
    wallet = body.data.find(row => row.displayName?.toLowerCase() === arg.toLowerCase())?.wallet || null;
  }
  if (!wallet) { console.error(`No wallet named ${arg} in the top 100 of the week, month or all-time boards.`); process.exit(1); }
  const {body, credits} = await get(`/v1/accounts/polymarket/${wallet}/positions?limit=100`);
  console.log(`GET ${base}/v1/accounts/polymarket/${shortWallet(wallet)}/positions?limit=100\n`);
  const row = [...body.data].sort((a, b) => b.size * b.markPrice - a.size * a.markPrice)[0];
  if (!row) console.log('[]   (this wallet has no position rows)');
  else {
    const raw = row.raw || {};
    const shown = {marketId: clip(row.marketId), outcomeId: clip(row.outcomeId), side: row.side, size: row.size, avgEntryPrice: row.avgEntryPrice, markPrice: row.markPrice, unrealizedPnl: row.unrealizedPnl, status: row.status, asOf: row.asOf};
    console.log(JSON.stringify(shown, null, 2).replace(/\n}$/, `,\n  "raw": ${JSON.stringify({title: raw.title, outcome: raw.outcome, oppositeOutcome: raw.oppositeOutcome, endDate: raw.endDate, redeemable: raw.redeemable, negativeRisk: raw.negativeRisk})}\n}`));
  }
  console.log(`\n${body.data.length} rows on this page, largest share count first, ${credits} credits. Showing the one worth the most. Long ids shortened.`);
} else { console.error('Use: node bot/peek.mjs board [week|month|all]   or   node bot/peek.mjs book <handle>'); process.exit(1); }
