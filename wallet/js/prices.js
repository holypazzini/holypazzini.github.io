import { getJson } from './http.js';

const UPBIT = 'https://api.upbit.com/v1/ticker?markets=KRW-BTC';
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=krw,usd';

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export async function fetchBtcPrices(fetchImpl = fetch) {
  let krw = null;
  let usd = null;
  let krwSource = null;
  let usdSource = null;

  try {
    const res = await getJson(UPBIT, { fetchImpl, timeoutMs: 12000 });
    const row = res.ok && Array.isArray(res.body) ? res.body[0] : null;
    if (row && positive(row.trade_price)) {
      krw = row.trade_price;
      krwSource = 'upbit';
    }
  } catch {
    /* CoinGecko below can still supply KRW. */
  }

  try {
    const res = await getJson(COINGECKO, { fetchImpl, timeoutMs: 12000 });
    const bitcoin = res.ok && res.body ? res.body.bitcoin : null;
    if (bitcoin && positive(bitcoin.usd)) {
      usd = bitcoin.usd;
      usdSource = 'coingecko';
    }
    if (krw == null && bitcoin && positive(bitcoin.krw)) {
      krw = bitcoin.krw;
      krwSource = 'coingecko';
    }
  } catch {
    /* Leave whatever Upbit already provided. */
  }

  return { krw, usd, krwSource, usdSource };
}
