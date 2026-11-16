import { getJson } from './http.js';

const HOSTS = [
  { id: 'mempool.space', origin: 'https://mempool.space/api' },
  { id: 'blockstream.info', origin: 'https://blockstream.info/api' },
];

const ADDRESS_RE = /^(?:[13][1-9A-HJ-NP-Za-km-z]{25,62}|bc1[ac-hj-np-z02-9]{11,87})$/;

export class ExplorerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLimiter(max, gapMs, sleepImpl) {
  let active = 0;
  let last = 0;
  const queue = [];

  function pump() {
    while (active < max && queue.length) {
      const job = queue.shift();
      active += 1;
      const now = Date.now();
      const wait = Math.max(0, last + gapMs - now);
      last = now + wait;
      sleepImpl(wait)
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  };
}

function isAddressStats(body) {
  return Boolean(
    body
    && body.chain_stats
    && body.mempool_stats
    && typeof body.chain_stats.funded_txo_sum === 'number'
    && typeof body.chain_stats.spent_txo_sum === 'number'
    && typeof body.mempool_stats.funded_txo_sum === 'number'
    && typeof body.mempool_stats.spent_txo_sum === 'number',
  );
}

function feeFromMap(data, target) {
  const keys = Object.keys(data).map(Number).filter((key) => Number.isFinite(key) && typeof data[String(key)] === 'number');
  if (!keys.length) return null;
  keys.sort((a, b) => a - b);
  let chosen = keys[0];
  let best = Infinity;
  for (const key of keys) {
    const distance = Math.abs(key - target);
    if (distance < best) {
      best = distance;
      chosen = key;
    }
  }
  return data[String(chosen)];
}

export function normalizeFees(source, data) {
  if (!data || typeof data !== 'object') return null;
  if (source === 'mempool.space') {
    const fastest = data.fastestFee;
    const halfHour = data.halfHourFee;
    const hour = data.hourFee;
    const economy = data.economyFee;
    if ([fastest, halfHour, hour, economy].some((value) => typeof value !== 'number')) return null;
    return { fastest, halfHour, hour, economy, source };
  }
  const fastest = feeFromMap(data, 1);
  const halfHour = feeFromMap(data, 3);
  const hour = feeFromMap(data, 6);
  const economy = feeFromMap(data, 24);
  if ([fastest, halfHour, hour, economy].some((value) => typeof value !== 'number')) return null;
  return { fastest, halfHour, hour, economy, source };
}

export function createExplorer(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleepImpl || sleep;
  const gapMs = options.gapMs == null ? 160 : options.gapMs;
  const limit = createLimiter(options.concurrency || 3, gapMs, sleepImpl);
  const cache = new Map();
  let preferred = 0;
  let avoidMempoolUntil = 0;
  const usedHosts = new Set();

  async function requestPath(path, { force = false, ttl = 20000, expect } = {}) {
    if (!force && cache.has(path)) {
      const hit = cache.get(path);
      if (Date.now() - hit.at < ttl) return hit.value;
    }

    const order = preferred === 0 && Date.now() < avoidMempoolUntil ? [1, 0] : [preferred, preferred === 0 ? 1 : 0];
    let lastCode = 'unavailable';

    for (const hostIndex of order) {
      const host = HOSTS[hostIndex];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let res;
        try {
          res = await limit(() => getJson(`${host.origin}${path}`, { fetchImpl, timeoutMs: 20000 }));
        } catch {
          lastCode = 'unavailable';
          if (hostIndex === 0) avoidMempoolUntil = Date.now() + 60000;
          break;
        }
        if (res.status === 429) {
          lastCode = 'rate-limit';
          const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1200 * (2 ** attempt);
          await sleepImpl(Math.min(backoff, 8000));
          continue;
        }
        if (!res.ok) {
          lastCode = res.status >= 500 ? 'unavailable' : 'bad-response';
          if (hostIndex === 0 && res.status >= 500) avoidMempoolUntil = Date.now() + 60000;
          break;
        }
        if (expect && !expect(res.body)) {
          lastCode = 'bad-response';
          break;
        }
        preferred = hostIndex;
        usedHosts.add(host.id);
        const value = { body: res.body, source: host.id };
        cache.set(path, { at: Date.now(), value });
        return value;
      }
    }
    throw new ExplorerError(lastCode);
  }

  return {
    usedSources() {
      return [...usedHosts];
    },
    clearCache() {
      cache.clear();
    },
    async address(address, opts = {}) {
      if (!ADDRESS_RE.test(address)) throw new ExplorerError('bad-address');
      const result = await requestPath(`/address/${encodeURIComponent(address)}`, { ...opts, expect: isAddressStats });
      return result.body;
    },
    async txs(address, opts = {}) {
      if (!ADDRESS_RE.test(address)) throw new ExplorerError('bad-address');
      const result = await requestPath(`/address/${encodeURIComponent(address)}/txs`, {
        ...opts,
        expect: (body) => Array.isArray(body),
      });
      return result.body;
    },
    async tip(opts = {}) {
      const result = await requestPath('/blocks/tip/height', {
        ...opts,
        ttl: 15000,
        expect: (body) => typeof body === 'number' && body > 0,
      });
      return result.body;
    },
    async fees(opts = {}) {
      const attempts = [
        { host: 0, path: '/v1/fees/recommended', kind: 'mempool.space' },
        { host: 1, path: '/fee-estimates', kind: 'blockstream.info' },
      ];
      let last = new ExplorerError('unavailable');
      for (const attempt of attempts) {
        try {
          const host = HOSTS[attempt.host];
          const res = await limit(() => getJson(`${host.origin}${attempt.path}`, { fetchImpl, timeoutMs: 20000 }));
          if (res.status === 429) {
            last = new ExplorerError('rate-limit');
            continue;
          }
          if (!res.ok) {
            last = new ExplorerError(res.status >= 500 ? 'unavailable' : 'bad-response');
            continue;
          }
          const fees = normalizeFees(attempt.kind, res.body);
          if (!fees) {
            last = new ExplorerError('bad-response');
            continue;
          }
          usedHosts.add(host.id);
          return fees;
        } catch {
          last = new ExplorerError('unavailable');
        }
      }
      throw last;
    },
    resetSources() {
      usedHosts.clear();
    },
  };
}
