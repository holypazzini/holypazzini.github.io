function toBig(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  throw new Error('amount');
}

export function balanceOf(stats) {
  const chain = stats.chain_stats;
  const mempool = stats.mempool_stats;
  const confirmed = BigInt(chain.funded_txo_sum) - BigInt(chain.spent_txo_sum);
  const pending = BigInt(mempool.funded_txo_sum) - BigInt(mempool.spent_txo_sum);
  return { confirmed, pending, total: confirmed + pending };
}

export function isUsed(stats) {
  const chain = stats.chain_stats;
  const mempool = stats.mempool_stats;
  return chain.tx_count > 0 || mempool.tx_count > 0 || chain.funded_txo_count > 0 || mempool.funded_txo_count > 0;
}

export function formatBtc(sats) {
  const value = toBig(sats);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100000000n;
  const fracRaw = (abs % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  const frac = fracRaw.length === 0 ? '00' : fracRaw.length === 1 ? `${fracRaw}0` : fracRaw;
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

export function formatSats(sats) {
  return `${toBig(sats).toLocaleString('ko-KR')} sats`;
}

export function krwFromSats(sats, krwPerBtc) {
  const price = BigInt(Math.round(krwPerBtc));
  const value = toBig(sats);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const won = (abs * price + 50000000n) / 100000000n;
  return negative ? -won : won;
}

export function formatKrw(won, approx = false) {
  const value = toBig(won);
  const body = `${value.toLocaleString('ko-KR')}원`;
  if (approx && value > 0n) return `약 ${body}`;
  return body;
}

export function usdCentsFromSats(sats, usdPerBtc) {
  const cents = BigInt(Math.round(usdPerBtc * 100));
  const value = toBig(sats);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const out = (abs * cents + 50000000n) / 100000000n;
  return negative ? -out : out;
}

export function formatUsd(cents) {
  const value = toBig(cents);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toLocaleString('ko-KR');
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${whole}.${frac}`;
}

export function formatFee(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '-';
  if (number >= 10) return String(Math.round(number));
  const rounded = Math.round(number * 100) / 100;
  return String(rounded);
}

const WHEN = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatWhen(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '';
  return WHEN.format(new Date(unixSeconds * 1000));
}

export function confirmations(height, tip) {
  if (height == null) return 0;
  if (tip == null) return null;
  const count = Number(tip) - Number(height) + 1;
  if (!Number.isFinite(count)) return null;
  return count > 0 ? count : 0;
}

export function txEffect(tx, ourAddresses) {
  const ours = ourAddresses instanceof Set ? ourAddresses : new Set(ourAddresses);
  let spent = 0n;
  let received = 0n;
  let externalOut = false;
  for (const input of tx.vin || []) {
    const prev = input && input.prevout;
    if (!prev) continue;
    if (prev.scriptpubkey_address && ours.has(prev.scriptpubkey_address)) {
      spent += BigInt(prev.value);
    }
  }
  for (const output of tx.vout || []) {
    const value = BigInt(output.value || 0);
    if (output.scriptpubkey_address && ours.has(output.scriptpubkey_address)) received += value;
    else if (value > 0n) externalOut = true;
  }
  const net = received - spent;
  let direction = 'internal';
  if (!(spent > 0n && !externalOut)) {
    if (net > 0n) direction = 'in';
    else if (net < 0n) direction = 'out';
  }
  const status = tx.status || {};
  return {
    txid: tx.txid,
    net,
    direction,
    confirmed: Boolean(status.confirmed),
    height: status.confirmed ? status.block_height : null,
    time: status.confirmed ? status.block_time : null,
  };
}

export function sumBalances(entries) {
  const seen = new Set();
  let confirmed = 0n;
  let pending = 0n;
  let overlap = false;
  for (const entry of entries) {
    if (!entry || !entry.stats) continue;
    if (seen.has(entry.address)) {
      overlap = true;
      continue;
    }
    seen.add(entry.address);
    const balance = balanceOf(entry.stats);
    confirmed += balance.confirmed;
    pending += balance.pending;
  }
  return { confirmed, pending, total: confirmed + pending, overlap };
}
