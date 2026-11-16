import { GAP_LIMIT, MAX_INDEX, classifyWatchInput, deriveAddress } from './derive.js';
import { createExplorer } from './explorer.js';
import {
  confirmations,
  formatBtc,
  formatFee,
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
import { download, loadState, newId, saveState } from './store.js';

const MAX_ITEMS = 30;
const TX_LIMIT = 40;
const SCRIPT_NAME = {
  p2pkh: '레거시 · 1',
  p2sh: '3으로 시작',
  'p2sh-p2wpkh': '중첩 세그윗 · 3',
  p2wpkh: '세그윗 · bc1q',
  p2wsh: '세그윗 스크립트 · bc1q',
  p2tr: '탭루트 · bc1p',
  witness: '세그윗',
};
const XPUB_NAME = {
  p2pkh: '레거시 xpub · 1 주소',
  'p2sh-p2wpkh': '중첩 세그윗 ypub · 3 주소',
  p2wpkh: '세그윗 zpub · bc1q 주소',
};
const DIRECTION = { in: '입금', out: '출금', internal: '내부 이동' };
const INPUT_ERROR = {
  secret: '개인키, 복구 문구(시드), WIF로 보입니다. 저장하지 않고 입력칸을 비웠습니다. 받는 주소 또는 xpub/ypub/zpub만 넣을 수 있습니다.',
  empty: '주소 또는 확장 공개키를 입력해 주세요.',
  invalid: '비트코인 주소(bc1, 3, 1) 또는 xpub/ypub/zpub이 아닙니다. 한 줄에 하나씩 넣어 주세요.',
  testnet: '테스트넷 주소는 지원하지 않습니다. 메인넷 주소 또는 xpub/ypub/zpub을 넣어 주세요.',
  multisig: '멀티시그용 Ypub/Zpub은 지원하지 않습니다. 일반 zpub, ypub, xpub 또는 주소를 넣어 주세요.',
  depth: '이 키는 계정 확장 공개키가 아닙니다. 지갑에서 계정 xpub/ypub/zpub을 복사해 주세요. bc1 지갑은 zpub입니다.',
  'too-long': '내용이 너무 깁니다.',
};

const explorer = createExplorer();
const memoryStats = new Map();
const nodes = {
  alert: document.getElementById('alert'),
  warnings: document.getElementById('warnings'),
  status: document.getElementById('status'),
  summary: document.getElementById('summary'),
  fees: document.getElementById('fees'),
  list: document.getElementById('list'),
  txs: document.getElementById('txs'),
  input: document.getElementById('watch-input'),
  label: document.getElementById('label-input'),
  add: document.getElementById('add-btn'),
  refresh: null,
  usd: document.getElementById('show-usd'),
  exportBtn: document.getElementById('export-btn'),
  importBtn: document.getElementById('import-btn'),
  importFile: document.getElementById('import-file'),
  importReplace: document.getElementById('import-replace'),
  clearBtn: document.getElementById('clear-btn'),
  clearBox: document.getElementById('clear-confirm'),
  clearYes: document.getElementById('clear-yes'),
  clearNo: document.getElementById('clear-no'),
  corrupt: document.getElementById('corrupt-box'),
  exportRaw: document.getElementById('export-raw'),
  resetCorrupt: document.getElementById('reset-corrupt'),
};

let state = { version: 1, showUsd: false, items: [] };
let allowSave = true;
let corruptRaw = null;
let ui = { cards: [], flat: [], txs: [], prices: null, fees: null, tip: null, total: null, sources: [], loading: false };
let pendingDelete = null;
let refreshing = false;
let refreshAgain = false;
let refreshForce = false;
let currentGen = 0;
let flash = '';

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'hidden' || key === 'disabled' || key === 'checked') node[key] = Boolean(value);
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function mount(node, ...children) {
  node.textContent = '';
  const list = children.flat().filter((child) => child != null && child !== false);
  if (list.length) node.append(...list);
}

function shorten(value, left = 10, right = 8) {
  if (!value || value.length <= left + right + 1) return value || '';
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function setStatus(text) {
  nodes.status.textContent = text || '';
}

function showAlert(text) {
  nodes.alert.hidden = !text;
  nodes.alert.textContent = text || '';
  if (text && typeof nodes.alert.scrollIntoView === 'function') {
    nodes.alert.scrollIntoView({ block: 'nearest' });
  }
}

function titleOf(item) {
  if (item.label) return item.label;
  return item.type === 'xpub' ? '확장 공개키' : '주소';
}

function priceName(source) {
  if (source === 'upbit') return '업비트';
  if (source === 'coingecko') return 'CoinGecko';
  return '';
}

function persist() {
  if (!allowSave) return;
  try {
    saveState(state);
  } catch {
    showAlert('이 브라우저는 저장을 막아, 새로고침하면 목록이 사라질 수 있습니다.');
  }
}

function sanitize(current) {
  const items = [];
  let removedSecret = false;
  let changed = false;
  for (const item of current.items) {
    const info = classifyWatchInput(item.value);
    if (!info.ok && info.code === 'secret') {
      removedSecret = true;
      changed = true;
      continue;
    }
    if (!info.ok || info.kind === 'list') {
      changed = true;
      continue;
    }
    const type = info.kind === 'address' ? 'address' : 'xpub';
    const value = info.kind === 'address' ? info.address : info.xpub;
    if (type !== item.type || value !== item.value) changed = true;
    items.push({ ...item, type, value });
  }
  return { state: { ...current, items }, removedSecret, changed };
}

function moneyBlock(balance, compact) {
  if (!balance) return el('p', { class: 'muted', text: '잔액 확인 중…' });
  const lines = [
    el('p', { class: compact ? 'item-btc num' : 'balance num', text: `${formatBtc(balance.total)} BTC` }),
    el('p', { class: 'unit num', text: formatSats(balance.total) }),
  ];
  if (ui.prices && ui.prices.krw != null) {
    lines.push(el('p', { class: 'unit num', text: formatKrw(krwFromSats(balance.total, ui.prices.krw), true) }));
  }
  if (state.showUsd && ui.prices && ui.prices.usd != null) {
    lines.push(el('p', { class: 'muted num', text: formatUsd(usdCentsFromSats(balance.total, ui.prices.usd)) }));
  }
  if (balance.pending !== 0n) {
    const sign = balance.pending > 0n ? '+' : '';
    lines.push(el('p', { class: 'muted num', text: `미확정 ${sign}${formatBtc(balance.pending)} BTC` }));
  }
  return el('div', null, lines);
}

function renderWarnings(warnings) {
  mount(nodes.warnings, warnings.length
    ? el('div', { class: 'alert' }, ...warnings.map((text) => el('p', { text })))
    : null);
}

function renderFees() {
  if (!ui.fees) {
    mount(nodes.fees, ui.loading ? el('p', { class: 'muted', text: '추천 수수료를 불러오는 중…' }) : null);
    return;
  }
  const rows = [
    ['최우선', ui.fees.fastest],
    ['약 30분', ui.fees.halfHour],
    ['약 1시간', ui.fees.hour],
    ['절약', ui.fees.economy],
  ];
  const tip = ui.tip ? ` · 블록 ${Number(ui.tip).toLocaleString('ko-KR')}` : '';
  mount(
    nodes.fees,
    el('section', { class: 'panel' },
      el('h2', { text: '추천 수수료' }),
      el('p', { class: 'muted', text: `${ui.fees.source} · sat/vB${tip}. 보내는 기능은 없습니다.` }),
      el('div', { class: 'fee-grid' }, ...rows.map(([name, value]) => el('div', { class: 'fee' },
        el('span', { text: name }),
        el('b', { class: 'num', text: formatFee(value) }),
        el('span', { text: 'sat/vB' }))))),
  );
}

function sourceParts() {
  const parts = [];
  if (ui.sources && ui.sources.length) parts.push(`잔액·거래: ${ui.sources.join(' · ')}`);
  if (ui.prices && ui.prices.krwSource) parts.push(`원 시세: ${priceName(ui.prices.krwSource)}`);
  if (state.showUsd && ui.prices && ui.prices.usdSource) parts.push(`달러: ${priceName(ui.prices.usdSource)}`);
  return parts;
}

function renderSummary() {
  const hasItems = state.items.length > 0;
  const anyStats = (ui.flat || []).some((entry) => entry.stats);
  const children = [el('h2', { text: hasItems ? '총잔액' : '비트코인 시세' })];
  if (hasItems && anyStats && ui.total) {
    children.push(moneyBlock(ui.total, false));
    if (ui.total.confirmed !== ui.total.total) {
      children.push(el('p', { class: 'muted num', text: `확정 ${formatBtc(ui.total.confirmed)} BTC` }));
    }
  } else if (hasItems) {
    children.push(el('p', { class: 'balance', text: ui.loading ? '불러오는 중…' : '확인하지 못했습니다' }));
  }
  if (ui.prices && ui.prices.krw != null) {
    const usd = state.showUsd && ui.prices.usd != null ? ` · ${formatUsd(BigInt(Math.round(ui.prices.usd * 100)))}` : '';
    children.push(el('p', { class: 'unit num', text: `1 BTC = ${formatKrw(BigInt(Math.round(ui.prices.krw)))}${usd}` }));
  } else if (!ui.loading) {
    children.push(el('p', { class: 'muted', text: '시세를 가져오지 못했습니다.' }));
  }
  const meta = [...sourceParts(), ui.loading ? '갱신 중' : ''].filter(Boolean);
  if (meta.length) {
    children.push(el('p', { class: 'muted sources' }, ...meta.map((part) => el('span', { text: part }))));
  }
  children.push(el('div', { class: 'actions' }, el('button', {
    type: 'button',
    id: 'refresh-btn',
    text: ui.loading ? '불러오는 중…' : '다시 불러오기',
    disabled: ui.loading,
  })));
  mount(nodes.summary, el('div', null, children));
  nodes.refresh = document.getElementById('refresh-btn');
  nodes.refresh.addEventListener('click', () => refresh({ force: true }));
}

function addressLink(address) {
  return el('a', {
    href: `https://mempool.space/address/${address}`,
    target: '_blank',
    rel: 'noopener noreferrer',
    text: 'mempool에서 보기',
  });
}

function copyButton(value, label = '복사') {
  return el('button', { type: 'button', 'data-action': 'copy', 'data-copy': value, text: label });
}

function usedList(entries, chainName) {
  if (!entries.length) return null;
  return el('details', null,
    el('summary', { text: `${chainName} ${entries.length}개` }),
    ...entries.map((entry) => el('div', { class: 'tx' },
      el('div', null,
        el('div', { class: 'muted', text: `${chainName} #${entry.index}` }),
        el('div', { class: 'mono', text: entry.address })),
      el('div', { class: 'amt num' }, formatBtc(sumBalances([entry]).total) + ' BTC'))));
}

function renderCard(card) {
  const item = card.item;
  const info = card.info || classifyWatchInput(item.value);
  const known = info && info.ok && info.kind !== 'list';
  const balance = card.entries && card.entries.length ? sumBalances(card.entries) : null;
  const body = [
    el('h3', { text: titleOf(item) }),
  ];
  if (known && info.kind === 'address') {
    body.push(el('p', { class: 'badge', text: SCRIPT_NAME[info.script] || '주소' }));
    body.push(el('p', { class: 'mono', text: info.address }));
  } else if (known && info.kind === 'xpub') {
    body.push(el('p', { class: 'badge', text: XPUB_NAME[info.script] || info.prefix }));
    body.push(el('p', { class: 'mono', text: info.xpub }));
    if (info.mode === 'receive') body.push(el('p', { class: 'muted', text: '이 키는 수신 주소만 계산합니다. 거스름 주소는 포함되지 않습니다.' }));
    if (info.mode === 'change') body.push(el('p', { class: 'muted', text: '이 키는 거스름 주소만 계산합니다.' }));
  } else {
    body.push(el('p', { class: 'muted', text: '이 항목은 주소로 읽지 못했습니다. 지운 뒤 다시 넣어 주세요.' }));
  }

  if (card.loading && !balance) body.push(el('p', { class: 'muted', text: '잔액 확인 중…' }));
  else if (balance) body.push(moneyBlock(balance, true));
  else if (card.error) body.push(el('p', { class: 'muted', text: '잔액을 가져오지 못했습니다.' }));

  if (known && info.kind === 'xpub' && card.entries) {
    const receiveUsed = card.entries.filter((entry) => entry.chain === 0 && entry.used);
    const changeUsed = card.entries.filter((entry) => entry.chain === 1 && entry.used);
    if (info.mode === 'account') {
      body.push(el('p', { class: 'muted', text: `사용한 주소 · 수신 ${receiveUsed.length}개, 거스름 ${changeUsed.length}개. 빈 주소 ${GAP_LIMIT}개가 연속되면 멈춥니다.` }));
    }
    const next = info.mode === 'change' ? null : card.entries.find((entry) => entry.chain === 0 && !entry.used);
    if (next) {
      body.push(el('div', { class: 'next' },
        el('p', { class: 'muted', text: '다음 수신 주소' }),
        el('p', { class: 'mono', text: next.address }),
        el('p', { class: 'muted', text: '지갑 앱의 다음 받는 주소와 같은지 확인해 주세요. 다르면 zpub, ypub, xpub 종류가 맞지 않는 것입니다.' }),
        el('div', { class: 'row' }, copyButton(next.address), addressLink(next.address))));
    }
    const lists = [usedList(receiveUsed, '수신'), usedList(changeUsed, '거스름')].filter(Boolean);
    if (lists.length) body.push(...lists);
    else if (!card.loading) body.push(el('p', { class: 'muted', text: '체인에 아직 사용된 주소가 없습니다.' }));
    if (card.truncated) body.push(el('p', { class: 'muted', text: `주소 ${MAX_INDEX}개에서 멈췄습니다. 뒤의 잔액은 빠질 수 있습니다.` }));
    if (card.incomplete) body.push(el('p', { class: 'muted', text: '일부 주소를 확인하지 못했습니다.' }));
    if (card.stale) body.push(el('p', { class: 'muted', text: '이전에 불러온 잔액입니다.' }));
  }

  if (pendingDelete === item.id) {
    body.push(el('div', { class: 'confirm' },
      el('p', { text: '목록에서 지울까요? 코인은 지갑에 그대로 있습니다.' }),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'danger', 'data-action': 'delete-yes', text: '지우기' }),
        el('button', { type: 'button', 'data-action': 'delete-no', text: '취소' }))));
  } else {
    const buttons = [el('button', { type: 'button', class: 'danger', 'data-action': 'delete', text: '삭제' })];
    if (known && info.kind === 'address') buttons.unshift(copyButton(info.address), addressLink(info.address));
    if (known && info.kind === 'xpub') buttons.unshift(copyButton(info.xpub, '키 복사'));
    body.push(el('div', { class: 'row' }, buttons));
  }
  return el('article', { class: 'card', 'data-id': item.id }, body);
}

function renderList() {
  const cards = ui.cards && ui.cards.length
    ? ui.cards
    : state.items.map((item) => ({ item, entries: [], loading: ui.loading }));
  if (!state.items.length) {
    mount(nodes.list, el('p', { class: 'muted', text: '아직 감시 중인 주소가 없습니다.' }));
    return;
  }
  mount(nodes.list, ...cards.map(renderCard));
}

function renderTxs() {
  if (ui.loading && !(ui.txs || []).length) {
    mount(nodes.txs, el('p', { class: 'muted', text: state.items.length ? '거래를 불러오는 중…' : '주소를 추가하면 최근 거래가 여기에 표시됩니다.' }));
    return;
  }
  if (!(ui.txs || []).length) {
    mount(nodes.txs, el('p', { class: 'muted', text: state.items.length ? '아직 거래가 없습니다.' : '주소를 추가하면 최근 거래가 여기에 표시됩니다.' }));
    return;
  }
  const rows = ui.txs.map(({ tx, effect }) => {
    const sign = effect.net > 0n ? '+' : '';
    const when = effect.confirmed && effect.time ? formatWhen(effect.time) : '아직 블록에 없습니다';
    const conf = effect.confirmed
      ? (confirmations(effect.height, ui.tip) == null ? '확정' : `확인 ${confirmations(effect.height, ui.tip).toLocaleString('ko-KR')}회`)
      : '미확정';
    const names = namesForTx(tx);
    return el('article', { class: 'tx' },
      el('div', null,
        el('div', { class: `dir-${effect.direction}`, text: DIRECTION[effect.direction] || '거래' }),
        el('div', { class: 'muted', text: when }),
        el('div', { class: 'muted', text: [conf, names].filter(Boolean).join(' · ') }),
        el('a', {
          href: `https://mempool.space/tx/${effect.txid}`,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: shorten(effect.txid, 8, 6),
        })),
      el('div', { class: `amt num dir-${effect.direction}` },
        el('div', { text: `${sign}${formatBtc(effect.net)} BTC` }),
        el('div', { class: 'muted', text: formatSats(effect.net) })));
  });
  const note = el('p', { class: 'muted', text: ui.txTruncated ? `최근 ${TX_LIMIT}건만 표시합니다. 각 주소의 최근 거래입니다.` : '각 주소의 최근 거래입니다.' });
  mount(nodes.txs, note, ...rows);
}

function namesForTx(tx) {
  if (state.items.length < 2) return '';
  const seen = new Set();
  for (const input of tx.vin || []) {
    if (input.prevout && input.prevout.scriptpubkey_address) seen.add(input.prevout.scriptpubkey_address);
  }
  for (const output of tx.vout || []) {
    if (output.scriptpubkey_address) seen.add(output.scriptpubkey_address);
  }
  const names = [];
  for (const card of ui.cards || []) {
    if ((card.entries || []).some((entry) => seen.has(entry.address))) names.push(titleOf(card.item));
  }
  return names.join(', ');
}

function renderAll(warnings) {
  renderWarnings(warnings || []);
  renderFees();
  renderSummary();
  renderList();
  renderTxs();
}

function collectWarnings() {
  const warnings = [];
  const codes = (ui.cards || []).map((card) => card.error).filter(Boolean);
  if (!ui.prices || ui.prices.krw == null) warnings.push('원화 시세를 가져오지 못했습니다. 비트코인 수량은 그대로 표시합니다.');
  if (!ui.fees) warnings.push('추천 수수료를 가져오지 못했습니다.');
  if ((ui.cards || []).some((card) => card.stale)) warnings.push('일부 잔액은 방금 갱신하지 못해 이전에 불러온 값입니다.');
  if (codes.includes('rate-limit')) warnings.push('조회가 많아 잠시 막혔습니다. 조금 뒤에 다시 불러오기를 눌러 주세요.');
  else if ((ui.cards || []).some((card) => card.incomplete || (card.error && !(card.entries || []).length))) {
    warnings.push('일부 주소를 확인하지 못했습니다. 잠시 후 다시 불러와 주세요.');
  }
  if ((ui.cards || []).some((card) => card.truncated)) warnings.push('주소가 많아 각 체인 200개에서 멈췄습니다. 그 뒤의 잔액은 빠질 수 있습니다.');
  if (ui.txFailed) warnings.push('최근 거래 일부를 가져오지 못했습니다.');
  if (ui.total && ui.total.overlap) warnings.push('같은 주소가 겹쳐 총액에는 한 번만 더했습니다.');
  return [...new Set(warnings)];
}

async function scanXpub(info, { force, isStale, onProgress }) {
  const chains = info.mode === 'account' ? [0, 1] : info.mode === 'receive' ? [0] : [1];
  const found = [];
  let truncated = false;
  let incomplete = false;
  let errorCode = null;
  for (const chain of chains) {
    let gap = 0;
    let index = 0;
    const chainName = chain === 0 ? '수신' : '거스름';
    let stop = false;
    while (gap < GAP_LIMIT && index < MAX_INDEX && !stop) {
      if (isStale()) return { stale: true, found, truncated, incomplete, errorCode };
      const count = Math.min(5, MAX_INDEX - index);
      const batch = [];
      for (let step = 0; step < count; step += 1) {
        const at = index + step;
        try {
          batch.push({ chain, index: at, address: deriveAddress(info.xpub, chain, at) });
        } catch {
          incomplete = true;
          errorCode = 'unavailable';
          stop = true;
          break;
        }
      }
      if (!batch.length) break;
      onProgress(`${chainName} 주소 확인 중… ${index + batch.length}번째, 빈 주소 ${gap}/${GAP_LIMIT}`);
      const settled = await Promise.allSettled(batch.map((row) => explorer.address(row.address, { force })));
      for (let step = 0; step < batch.length; step += 1) {
        const result = settled[step];
        if (result.status !== 'fulfilled') {
          incomplete = true;
          errorCode = result.reason && result.reason.code ? result.reason.code : 'unavailable';
          stop = true;
          break;
        }
        const stats = result.value;
        memoryStats.set(batch[step].address, { stats, at: Date.now() });
        const used = isUsed(stats);
        found.push({ ...batch[step], stats, used });
        gap = used ? 0 : gap + 1;
        index += 1;
        if (gap >= GAP_LIMIT) {
          stop = true;
          break;
        }
      }
    }
    if (incomplete) break;
    if (gap < GAP_LIMIT) truncated = true;
  }
  return { found, truncated, incomplete, errorCode };
}

async function refreshOnce(force) {
  const generation = ++currentGen;
  const stale = () => generation !== currentGen;
  ui.loading = true;
  ui.cards = state.items.map((item) => {
    const previous = (ui.cards || []).find((card) => card.item.id === item.id);
    return previous ? { ...previous, item, loading: true } : { item, entries: [], loading: true };
  });
  renderAll([]);
  setStatus(state.items.some((item) => item.type === 'xpub')
    ? '확장 공개키에서 주소를 찾는 중… 주소가 많으면 조금 걸립니다.'
    : '불러오는 중…');
  explorer.resetSources();

  const pricePromise = fetchBtcPrices();
  const feePromise = explorer.fees().catch(() => null);
  const tipPromise = explorer.tip({ force }).catch(() => null);
  const cards = [];
  const flat = [];

  for (const item of state.items) {
    if (stale()) return;
    const info = classifyWatchInput(item.value);
    if (!info.ok || info.kind === 'list') {
      cards.push({ item, info: null, entries: [], error: 'invalid' });
      continue;
    }
    if (info.kind === 'address') {
      setStatus(`${titleOf(item)} 잔액 확인 중…`);
      try {
        const stats = await explorer.address(info.address, { force });
        if (stale()) return;
        memoryStats.set(info.address, { stats, at: Date.now() });
        const entries = [{ address: info.address, stats, used: isUsed(stats) }];
        cards.push({ item, info, entries });
        flat.push(...entries);
      } catch (error) {
        const cached = memoryStats.get(info.address);
        if (cached) {
          const entries = [{ address: info.address, stats: cached.stats, used: isUsed(cached.stats) }];
          cards.push({ item, info, entries, stale: true, error: error.code || 'unavailable' });
          flat.push(...entries);
        } else {
          cards.push({ item, info, entries: [], error: error.code || 'unavailable' });
        }
      }
    } else {
      const scan = await scanXpub(info, {
        force,
        isStale: stale,
        onProgress: (text) => { if (!stale()) setStatus(`${titleOf(item)} · ${text}`); },
      });
      if (scan.stale || stale()) return;
      cards.push({
        item,
        info,
        entries: scan.found,
        truncated: scan.truncated,
        incomplete: scan.incomplete,
        error: scan.incomplete ? scan.errorCode : null,
      });
      flat.push(...scan.found);
    }
  }

  if (stale()) return;
  const usedAddresses = [];
  const seen = new Set();
  for (const entry of flat) {
    if (!entry.used || seen.has(entry.address)) continue;
    seen.add(entry.address);
    usedAddresses.push(entry.address);
  }
  const txById = new Map();
  let txFailed = false;
  if (usedAddresses.length) {
    setStatus('최근 거래를 불러오는 중…');
    const settled = await Promise.allSettled(usedAddresses.map((address) => explorer.txs(address, { force })));
    if (stale()) return;
    settled.forEach((result) => {
      if (result.status !== 'fulfilled') {
        txFailed = true;
        return;
      }
      for (const tx of result.value) {
        if (tx && tx.txid && !txById.has(tx.txid)) txById.set(tx.txid, tx);
      }
    });
  }

  const [prices, fees, tip] = await Promise.all([pricePromise, feePromise, tipPromise]);
  if (stale()) return;
  const ourSet = new Set(flat.map((entry) => entry.address));
  const txs = [...txById.values()].map((tx) => ({ tx, effect: txEffect(tx, ourSet) }));
  txs.sort((a, b) => {
    if (a.effect.confirmed !== b.effect.confirmed) return a.effect.confirmed ? 1 : -1;
    return (b.effect.time || 0) - (a.effect.time || 0);
  });
  ui = {
    cards,
    flat,
    prices,
    fees,
    tip,
    txs: txs.slice(0, TX_LIMIT),
    txTruncated: txs.length > TX_LIMIT,
    txFailed,
    total: sumBalances(flat),
    sources: explorer.usedSources(),
    loading: false,
  };
  renderAll(collectWarnings());
  const time = formatWhen(Date.now() / 1000);
  setStatus(flash ? `${flash} ${time}` : time);
  flash = '';
}

async function refresh(options = {}) {
  const force = Boolean(options.force);
  if (refreshing) {
    refreshAgain = true;
    refreshForce = refreshForce || force;
    return;
  }
  refreshing = true;
  try {
    let useForce = force;
    do {
      refreshAgain = false;
      const passForce = useForce || refreshForce;
      refreshForce = false;
      try {
        await refreshOnce(passForce);
      } catch {
        ui.loading = false;
        showAlert('잔액을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
        renderAll(collectWarnings());
      }
      useForce = true;
    } while (refreshAgain);
  } finally {
    refreshing = false;
    ui.loading = false;
    if (nodes.refresh) nodes.refresh.disabled = false;
  }
}

function onAdd() {
  const result = classifyWatchInput(nodes.input.value);
  if (!result.ok) {
    if (result.code === 'secret') nodes.input.value = '';
    showAlert(INPUT_ERROR[result.code] || INPUT_ERROR.invalid);
    return;
  }
  const incoming = result.kind === 'list' ? result.items : [result];
  if (state.items.length + incoming.length > MAX_ITEMS) {
    showAlert(`감시 목록은 ${MAX_ITEMS}개까지 넣을 수 있습니다.`);
    return;
  }
  let added = 0;
  let duplicates = 0;
  const label = incoming.length === 1 ? nodes.label.value.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  for (const info of incoming) {
    const type = info.kind === 'address' ? 'address' : 'xpub';
    const value = info.kind === 'address' ? info.address : info.xpub;
    if (state.items.some((item) => item.value === value)) {
      duplicates += 1;
      continue;
    }
    state.items.push({
      id: newId(),
      type,
      value,
      label,
      addedAt: new Date().toISOString(),
    });
    added += 1;
  }
  if (!added) {
    showAlert(duplicates ? '이미 감시 목록에 있습니다.' : INPUT_ERROR.invalid);
    return;
  }
  nodes.input.value = '';
  nodes.label.value = '';
  showAlert('');
  persist();
  flash = duplicates ? `${added}개를 추가했습니다. ${duplicates}개는 이미 있었습니다.` : `${added}개를 추가했습니다.`;
  refresh({ force: true });
}

async function copyText(value, button) {
  const previous = button.textContent;
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
  }
  button.textContent = ok ? '복사함' : '복사 실패';
  if (!ok) showAlert('복사하지 못했습니다. 주소를 길게 눌러 선택해 주세요.');
  setTimeout(() => { button.textContent = previous; }, 1600);
}

function exportList() {
  if (!state.items.length) {
    showAlert('저장할 목록이 없습니다.');
    return;
  }
  const body = {
    app: 'btc-watchonly',
    version: 1,
    exportedAt: new Date().toISOString(),
    items: state.items.map(({ type, value, label }) => ({ type, value, label: label || '' })),
  };
  download('bitcoin-watchlist.json', `${JSON.stringify(body, null, 2)}\n`);
}

async function onImport(file) {
  let text = '';
  try {
    text = await file.text();
  } catch {
    showAlert('파일을 읽지 못했습니다. 이 페이지에서 저장한 JSON인지 확인해 주세요.');
    return;
  }
  if (text.length > 1000000) {
    showAlert('파일이 너무 큽니다.');
    return;
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    showAlert('파일을 읽지 못했습니다. 이 페이지에서 저장한 JSON인지 확인해 주세요.');
    return;
  }
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
  if (!list) {
    showAlert('파일을 읽지 못했습니다. 이 페이지에서 저장한 JSON인지 확인해 주세요.');
    return;
  }
  const parsed = [];
  for (const row of list) {
    const value = row && typeof row.value === 'string' ? row.value : (typeof row === 'string' ? row : '');
    if (!value) continue;
    const info = classifyWatchInput(value);
    if (!info.ok && info.code === 'secret') {
      showAlert('파일에 개인키나 복구 문구가 들어 있습니다. 가져오지 않았습니다.');
      return;
    }
    if (!info.ok || info.kind === 'list') continue;
    const label = row && typeof row.label === 'string' ? row.label.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    parsed.push({
      type: info.kind === 'address' ? 'address' : 'xpub',
      value: info.kind === 'address' ? info.address : info.xpub,
      label,
    });
  }
  if (!parsed.length) {
    showAlert('가져올 주소가 없습니다.');
    return;
  }
  const base = nodes.importReplace.checked ? [] : state.items.slice();
  let added = 0;
  let duplicates = 0;
  for (const row of parsed) {
    if (base.some((item) => item.value === row.value)) {
      duplicates += 1;
      continue;
    }
    if (base.length >= MAX_ITEMS) break;
    base.push({
      id: newId(),
      type: row.type,
      value: row.value,
      label: row.label,
      addedAt: new Date().toISOString(),
    });
    added += 1;
  }
  state.items = base;
  allowSave = true;
  nodes.corrupt.hidden = true;
  persist();
  showAlert('');
  flash = duplicates ? `${added}개를 가져왔습니다. ${duplicates}개는 이미 있었습니다.` : `${added}개를 가져왔습니다.`;
  refresh({ force: true });
}

function bind() {
  nodes.add.addEventListener('click', onAdd);
  nodes.list.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || !nodes.list.contains(button)) return;
    const card = button.closest('[data-id]');
    const id = card ? card.dataset.id : '';
    const action = button.dataset.action;
    if (action === 'copy') {
      copyText(button.dataset.copy || '', button);
      return;
    }
    if (action === 'delete') {
      pendingDelete = id;
      renderList();
      return;
    }
    if (action === 'delete-no') {
      pendingDelete = null;
      renderList();
      return;
    }
    if (action === 'delete-yes') {
      state.items = state.items.filter((item) => item.id !== id);
      pendingDelete = null;
      persist();
      flash = '목록에서 지웠습니다. 코인은 지갑에 그대로 있습니다.';
      refresh({ force: true });
    }
  });
  nodes.usd.addEventListener('change', () => {
    state.showUsd = nodes.usd.checked;
    persist();
    renderSummary();
  });
  nodes.exportBtn.addEventListener('click', exportList);
  nodes.importBtn.addEventListener('click', () => nodes.importFile.click());
  nodes.importFile.addEventListener('change', () => {
    const file = nodes.importFile.files && nodes.importFile.files[0];
    if (file) onImport(file).finally(() => { nodes.importFile.value = ''; });
  });
  nodes.clearBtn.addEventListener('click', () => { nodes.clearBox.hidden = false; });
  nodes.clearNo.addEventListener('click', () => { nodes.clearBox.hidden = true; });
  nodes.clearYes.addEventListener('click', () => {
    state.items = [];
    pendingDelete = null;
    nodes.clearBox.hidden = true;
    persist();
    flash = '목록을 지웠습니다. 코인은 지갑에 그대로 있습니다.';
    refresh({ force: true });
  });
  nodes.exportRaw.addEventListener('click', () => {
    if (corruptRaw) download('bitcoin-watchlist-raw.json', corruptRaw);
  });
  nodes.resetCorrupt.addEventListener('click', () => {
    state = { version: 1, showUsd: false, items: [] };
    allowSave = true;
    corruptRaw = null;
    nodes.corrupt.hidden = true;
    nodes.usd.checked = false;
    persist();
    showAlert('');
    refresh({ force: true });
  });
}

function boot() {
  const loaded = loadState();
  corruptRaw = loaded.corrupt ? loaded.raw : null;
  allowSave = !loaded.corrupt;
  state = loaded.state;
  if (loaded.blocked) showAlert('이 브라우저는 저장을 막아, 새로고침하면 목록이 사라질 수 있습니다.');
  if (loaded.corrupt) {
    showAlert('저장된 목록이 손상됐습니다. 아래 원본을 받은 뒤 새로 시작할 수 있습니다. 코인과는 무관합니다.');
    nodes.corrupt.hidden = false;
  } else {
    const cleaned = sanitize(state);
    state = cleaned.state;
    if (cleaned.removedSecret) {
      showAlert('저장된 항목 중 개인키로 보이는 것이 있어 삭제했습니다. 바깥으로는 보내지 않았습니다.');
    }
    if (cleaned.changed) persist();
  }
  nodes.usd.checked = Boolean(state.showUsd);
  bind();
  refresh({ force: true });
}

boot();
