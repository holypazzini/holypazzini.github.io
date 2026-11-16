import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyWatchInput, deriveAddress, GAP_LIMIT, MAX_INDEX } from './derive.js';
import { createExplorer, normalizeFees } from './explorer.js';
import {
  balanceOf,
  confirmations,
  formatBtc,
  formatKrw,
  formatSats,
  formatUsd,
  formatWhen,
  isUsed,
  krwFromSats,
  sumBalances,
  txEffect,
  usdCentsFromSats,
} from './format.js';
import { fetchBtcPrices } from './prices.js';

const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const YPUB = 'ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP';
const XPUB = 'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';
const RECEIVE = 'zpub6u4KbU8TSgNuZSxzv7HaGq5Tk361gMHdZxnM4UYuwzg5CMLcNytzhobitV4Zq6vWtWHpG9QijsigkxAzXvQWyLRfLq1L7VxPP1tky1hPfD4';
const CHANGE = 'zpub6u4KbU8TSgNuco8HzL1LqM2ePjv8wrxUKENTtfambyxBbACZg5qvqqzAPwwAopTuxkrQzs661k5A6Q1P8b25a9DDJXYXDpN4KPwxygrx9Py';

assert.equal(GAP_LIMIT, 20);
assert.equal(MAX_INDEX, 200);
assert.equal(deriveAddress(ZPUB, 0, 0), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
assert.equal(deriveAddress(ZPUB, 0, 1), 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
assert.equal(deriveAddress(ZPUB, 1, 0), 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
assert.equal(deriveAddress(YPUB, 0, 0), '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');
assert.equal(deriveAddress(YPUB, 0, 1), '3LtMnn87fqUeHBUG414p9CWwnoV6E2pNKS');
assert.equal(deriveAddress(YPUB, 1, 0), '34K56kSjgUCUSD8GTtuF7c9Zzwokbs6uZ7');
assert.equal(deriveAddress(XPUB, 0, 0), '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
assert.equal(deriveAddress(XPUB, 0, 1), '1Ak8PffB2meyfYnbXZR9EGfLfFZVpzJvQP');
assert.equal(deriveAddress(XPUB, 1, 0), '1J3J6EvPrv8q6AC3VCjWV45Uf3nssNMRtH');
assert.equal(deriveAddress(RECEIVE, 0, 0), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
assert.equal(deriveAddress(CHANGE, 1, 0), 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');

const zpubInfo = classifyWatchInput(ZPUB);
assert.equal(zpubInfo.ok && zpubInfo.kind, 'xpub');
assert.equal(zpubInfo.prefix, 'zpub');
assert.equal(zpubInfo.mode, 'account');
assert.equal(zpubInfo.script, 'p2wpkh');
assert.equal(classifyWatchInput(RECEIVE).mode, 'receive');
assert.equal(classifyWatchInput(CHANGE).mode, 'change');

const wrapped = classifyWatchInput(`${ZPUB.slice(0, 40)}\n${ZPUB.slice(40)}`);
assert.equal(wrapped.ok && wrapped.xpub, ZPUB);

function rejectsSecret(value) {
  const result = classifyWatchInput(value);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'secret');
  assert.equal(JSON.stringify(result).includes(value), false);
  assert.throws(() => deriveAddress(value, 0, 0), (error) => !String(error.message).includes(value));
}

rejectsSecret(`L${'1'.repeat(51)}`);
rejectsSecret(`xprv${'1'.repeat(100)}`);
rejectsSecret('a'.repeat(64));
rejectsSecret('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima');
rejectsSecret('가게 가능 가로 가면 가시 가을 가족 가치 각각 간식 갈등 감동');
rejectsSecret(`${ZPUB} xprv${'1'.repeat(80)}`);

const genesis = classifyWatchInput('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
assert.equal(genesis.address, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
assert.equal(genesis.script, 'p2pkh');
assert.equal(classifyWatchInput('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb').code, 'invalid');
const upper = classifyWatchInput('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'.toUpperCase());
assert.equal(upper.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
const uri = classifyWatchInput('bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu?amount=0.01');
assert.equal(uri.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
const many = classifyWatchInput('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa\nbc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
assert.equal(many.kind, 'list');
assert.equal(many.items.length, 2);
assert.equal(classifyWatchInput('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx').code, 'testnet');
assert.equal(classifyWatchInput('').code, 'empty');

assert.equal(formatBtc(5771216367n), '57.71216367');
assert.equal(formatBtc(0n), '0.00');
assert.equal(formatBtc(-123456789n), '-1.23456789');
assert.equal(formatSats(5771216367n), '5,771,216,367 sats');
assert.equal(krwFromSats(100000000n, 89104000), 89104000n);
assert.equal(krwFromSats(5771216367n, 89104000), 5142384632n);
assert.equal(formatKrw(89104000n), '89,104,000원');
assert.equal(formatKrw(10n, true), '약 10원');
assert.equal(usdCentsFromSats(100000000n, 64799), 6479900n);
assert.equal(formatUsd(6479900n), '$64,799.00');
assert.ok(formatWhen(1577836800).includes('2020'));
assert.ok(formatWhen(1577836800).includes('09:00'));
assert.equal(confirmations(100, 110), 11);
assert.equal(confirmations(null, 110), 0);
assert.equal(confirmations(100, null), null);

const stats = {
  chain_stats: { funded_txo_sum: 5000, spent_txo_sum: 2000, tx_count: 2, funded_txo_count: 2 },
  mempool_stats: { funded_txo_sum: 100, spent_txo_sum: 0, tx_count: 1, funded_txo_count: 1 },
};
assert.deepEqual(balanceOf(stats), { confirmed: 3000n, pending: 100n, total: 3100n });
assert.equal(isUsed(stats), true);
assert.equal(isUsed({
  chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0, funded_txo_count: 0 },
  mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0, funded_txo_count: 0 },
}), false);

const ours = new Set(['bc1qours']);
const incoming = txEffect({
  txid: 'aa',
  vin: [{ prevout: { scriptpubkey_address: 'bc1qother', value: 5000 } }],
  vout: [{ scriptpubkey_address: 'bc1qours', value: 4900 }, { scriptpubkey_address: 'bc1qother', value: 50 }],
  status: { confirmed: true, block_height: 10, block_time: 1577836800 },
}, ours);
assert.equal(incoming.direction, 'in');
assert.equal(incoming.net, 4900n);
const internal = txEffect({
  txid: 'bb',
  vin: [{ prevout: { scriptpubkey_address: 'bc1qours', value: 5000 } }],
  vout: [{ scriptpubkey_address: 'bc1qours', value: 4800 }],
  status: { confirmed: false },
}, ours);
assert.equal(internal.direction, 'internal');
assert.equal(internal.net, -200n);
const overlap = sumBalances([
  { address: 'a', stats },
  { address: 'a', stats },
]);
assert.equal(overlap.total, 3100n);
assert.equal(overlap.overlap, true);

assert.deepEqual(normalizeFees('mempool.space', {
  fastestFee: 2, halfHourFee: 1, hourFee: 1, economyFee: 1,
}), { fastest: 2, halfHour: 1, hour: 1, economy: 1, source: 'mempool.space' });
assert.equal(normalizeFees('blockstream.info', { 1: 5, 3: 3, 6: 2, 24: 1 }).economy, 1);

const calls = [];
const explorer = createExplorer({
  gapMs: 0,
  sleepImpl: () => Promise.resolve(),
  fetchImpl: async (url) => {
    calls.push(url);
    if (url.includes('/v1/fees/recommended')) return new Response('no', { status: 500 });
    if (url.includes('/fee-estimates')) return new Response(JSON.stringify({ 1: 4, 3: 3, 6: 2, 24: 1 }), { status: 200 });
    if (url.includes('mempool.space')) return new Response('down', { status: 500 });
    return new Response(JSON.stringify({
      chain_stats: { funded_txo_sum: 10, spent_txo_sum: 4, tx_count: 1, funded_txo_count: 1 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0, funded_txo_count: 0 },
    }), { status: 200 });
  },
});
await assert.rejects(() => explorer.address('not an address'), (error) => error.code === 'bad-address');
assert.equal(calls.length, 0);
const watched = await explorer.address('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
assert.equal(balanceOf(watched).total, 6n);
assert.ok(calls.some((url) => url.startsWith('https://blockstream.info/api/address/')));
const fees = await explorer.fees();
assert.equal(fees.source, 'blockstream.info');
assert.equal(fees.fastest, 4);

let priceCalls = 0;
const prices = await fetchBtcPrices(async (url) => {
  priceCalls += 1;
  if (url.includes('upbit')) throw new Error('down');
  return new Response(JSON.stringify({ bitcoin: { krw: 1000, usd: 2 } }), { status: 200 });
});
assert.equal(prices.krw, 1000);
assert.equal(prices.krwSource, 'coingecko');
assert.equal(prices.usd, 2);
assert.ok(priceCalls >= 2);

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const derive = readFileSync(new URL('./derive.js', import.meta.url), 'utf8');
assert.equal(/<script[^>]+src="https?:/.test(html), false);
assert.equal(/type="password"/i.test(html), false);
assert.equal(html.includes('조회 전용'), true);
assert.equal(/fromMasterSeed|mnemonicToSeed|bip39/.test(app), false);
assert.equal(derive.includes('export{') || derive.includes('export {'), true);
assert.equal(derive.includes('mnemonicToSeed'), false);

const live = await fetch('https://mempool.space/api/address/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
assert.equal(live.ok, true);
const liveBody = await live.json();
const liveBalance = balanceOf(liveBody);
assert.equal(liveBalance.confirmed, BigInt(liveBody.chain_stats.funded_txo_sum) - BigInt(liveBody.chain_stats.spent_txo_sum));
assert.ok(liveBalance.total > 0n);
assert.equal(isUsed(liveBody), true);

console.log('selftest ok', formatBtc(liveBalance.total), 'BTC on genesis address');
