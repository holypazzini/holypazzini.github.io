const KEY = 'btc-watchonly.v1';

function emptyState() {
  return { version: 1, showUsd: false, items: [] };
}

export function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type !== 'address' && item.type !== 'xpub') return null;
  if (typeof item.value !== 'string') return null;
  const value = item.value.trim();
  if (!value || value.length > 200) return null;
  const label = typeof item.label === 'string' ? item.label.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  const id = typeof item.id === 'string' && item.id.length > 0 && item.id.length < 80 ? item.id : newId();
  const addedAt = typeof item.addedAt === 'string' ? item.addedAt : new Date().toISOString();
  return { id, type: item.type, value, label, addedAt };
}

export function loadState() {
  const empty = emptyState();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { state: empty, corrupt: false, raw: null, blocked: false };
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
      return { state: empty, corrupt: true, raw, blocked: false };
    }
    return {
      state: {
        version: 1,
        showUsd: Boolean(data.showUsd),
        items: data.items.map(cleanItem).filter(Boolean),
      },
      corrupt: false,
      raw: null,
      blocked: false,
    };
  } catch {
    let raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      return { state: empty, corrupt: false, raw: null, blocked: true };
    }
    return { state: empty, corrupt: Boolean(raw), raw, blocked: false };
  }
}

export function saveState(state) {
  const payload = {
    version: 1,
    showUsd: Boolean(state.showUsd),
    items: state.items.map((item) => ({
      id: item.id,
      type: item.type,
      value: item.value,
      label: item.label || '',
      addedAt: item.addedAt,
    })),
  };
  localStorage.setItem(KEY, JSON.stringify(payload));
}

export function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
