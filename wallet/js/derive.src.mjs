/**
 * Watch-only Bitcoin address checks and xpub/ypub/zpub derivation.
 *
 * Shipped to the browser as derive.js (bundled, no build on GitHub Pages).
 * Rebuild, from a machine that has the packages installed:
 *   esbuild wallet/js/derive.src.mjs --bundle --format=esm --platform=browser --target=es2020 --outfile=wallet/js/derive.js
 * Packages (all MIT): @scure/bip32 2.4.0, @scure/base 2.4.0,
 * @noble/curves 2.4.0, @noble/hashes 2.4.0.
 *
 * This module never accepts a seed. Extended private keys and WIF are rejected.
 */
import { HDKey } from '@scure/bip32';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';

const base58check = createBase58check(sha256);

export const GAP_LIMIT = 20;
export const MAX_INDEX = 200;

const EXT = {
  0x0488b21e: { prefix: 'xpub', script: 'p2pkh', public: 0x0488b21e, private: 0x0488ade4 },
  0x049d7cb2: { prefix: 'ypub', script: 'p2sh-p2wpkh', public: 0x049d7cb2, private: 0x049d7878 },
  0x04b24746: { prefix: 'zpub', script: 'p2wpkh', public: 0x04b24746, private: 0x04b2430c },
  0x0488ade4: { prefix: 'xprv', priv: true },
  0x049d7878: { prefix: 'yprv', priv: true },
  0x04b2430c: { prefix: 'zprv', priv: true },
  0x043587cf: { prefix: 'tpub', testnet: true },
  0x044a5262: { prefix: 'upub', testnet: true },
  0x045f1cf6: { prefix: 'vpub', testnet: true },
  0x04358394: { prefix: 'tprv', priv: true },
  0x044a4e28: { prefix: 'uprv', priv: true },
  0x045f18bc: { prefix: 'vprv', priv: true },
  0x0295b43f: { prefix: 'Ypub', multisig: true },
  0x02aa7ed3: { prefix: 'Zpub', multisig: true },
  0x0295b005: { prefix: 'Yprv', priv: true },
  0x02aa7a99: { prefix: 'Zprv', priv: true },
};

function fail(code) {
  return { ok: false, code };
}

function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

function p2pkh(pubKeyHash) {
  const payload = new Uint8Array(21);
  payload[0] = 0x00;
  payload.set(pubKeyHash, 1);
  return base58check.encode(payload);
}

function p2wpkh(pubKeyHash) {
  return bech32.encode('bc', [0, ...bech32.toWords(pubKeyHash)]);
}

function p2shP2wpkh(pubKeyHash) {
  const redeem = new Uint8Array(22);
  redeem[0] = 0x00;
  redeem[1] = 0x14;
  redeem.set(pubKeyHash, 2);
  const scriptHash = hash160(redeem);
  const payload = new Uint8Array(21);
  payload[0] = 0x05;
  payload.set(scriptHash, 1);
  return base58check.encode(payload);
}

function addressFromHash(pubKeyHash, script) {
  if (!pubKeyHash || pubKeyHash.length !== 20) {
    throw new Error('Could not derive from extended public key');
  }
  if (script === 'p2pkh') return p2pkh(pubKeyHash);
  if (script === 'p2wpkh') return p2wpkh(pubKeyHash);
  if (script === 'p2sh-p2wpkh') return p2shP2wpkh(pubKeyHash);
  throw new Error('Could not derive from extended public key');
}

function looksLikeMnemonic(raw) {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 12 || parts.length > 24) return false;
  return parts.every((part) => /^[a-zA-Z]+$/.test(part) || /^[가-힣]+$/.test(part));
}

function stripToken(token) {
  let text = token.trim().replace(/^['"]+|['"]+$/g, '');
  if (/^bitcoin:/i.test(text)) {
    text = text.slice(text.indexOf(':') + 1);
    const query = text.indexOf('?');
    if (query >= 0) text = text.slice(0, query);
  }
  return text.trim();
}

function decodeSegwit(addr) {
  const lower = addr.toLowerCase();
  if (lower.startsWith('tb1') || lower.startsWith('bcrt1')) return fail('testnet');
  if (!lower.startsWith('bc1')) return null;
  const uniform = addr === addr.toLowerCase() || addr === addr.toUpperCase();
  if (!uniform) return fail('invalid');

  let decoded = bech32.decodeUnsafe(addr);
  let spec = decoded ? 'bech32' : null;
  if (!decoded) {
    decoded = bech32m.decodeUnsafe(addr);
    spec = decoded ? 'bech32m' : null;
  }
  if (!decoded || decoded.prefix.toLowerCase() !== 'bc' || !decoded.words.length) return fail('invalid');

  const version = decoded.words[0];
  const program = bech32.fromWordsUnsafe(decoded.words.slice(1));
  if (!program || version < 0 || version > 16) return fail('invalid');
  if (version === 0) {
    if (spec !== 'bech32' || (program.length !== 20 && program.length !== 32)) return fail('invalid');
  } else if (spec !== 'bech32m' || program.length < 2 || program.length > 40) {
    return fail('invalid');
  }

  const script = version === 0
    ? (program.length === 20 ? 'p2wpkh' : 'p2wsh')
    : (version === 1 && program.length === 32 ? 'p2tr' : 'witness');
  const words = [version, ...bech32.toWords(program)];
  const canonical = (version === 0 ? bech32 : bech32m).encode('bc', words);
  return { ok: true, kind: 'address', address: canonical, script };
}

function classifyExtended(raw, token) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = view.getUint32(0, false);
  const key = raw.subarray(45);
  if (key[0] === 0x00) return fail('secret');
  const meta = EXT[version];
  if (!meta) return fail('invalid');
  if (meta.priv) return fail('secret');
  if (meta.testnet) return fail('testnet');
  if (meta.multisig) return fail('multisig');

  const depth = raw[4];
  const index = view.getUint32(9, false);
  let mode = null;
  if (depth === 3) mode = 'account';
  else if (depth === 4 && index === 0) mode = 'receive';
  else if (depth === 4 && index === 1) mode = 'change';
  if (!mode) return fail('depth');

  try {
    const node = HDKey.fromExtendedKey(token, { public: meta.public, private: meta.private });
    if (node.privateKey) return fail('secret');
  } catch {
    return fail('invalid');
  }

  return {
    ok: true,
    kind: 'xpub',
    xpub: token,
    script: meta.script,
    prefix: meta.prefix,
    mode,
    depth,
    index,
    publicVersion: meta.public,
    privateVersion: meta.private,
  };
}

function classifyToken(token) {
  if (!token) return fail('empty');
  if (/^(x|y|z|t|u|v|Y|Z)prv/.test(token)) return fail('secret');
  if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(token)) return fail('secret');
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(token) || /^(0x)?[0-9a-fA-F]{128}$/.test(token)) return fail('secret');

  if (token.toLowerCase().startsWith('bc1') || token.toLowerCase().startsWith('tb1') || token.toLowerCase().startsWith('bcrt1')) {
    return decodeSegwit(token) || fail('invalid');
  }

  let raw;
  try {
    raw = Uint8Array.from(base58check.decode(token));
  } catch {
    return fail('invalid');
  }

  if (raw.length === 78) return classifyExtended(raw, token);
  if ((raw.length === 33 || raw.length === 34) && raw[0] === 0x80) return fail('secret');
  if (raw.length !== 21) return fail('invalid');

  const version = raw[0];
  if (version === 0x6f || version === 0xc4) return fail('testnet');
  if (version === 0x80) return fail('secret');
  if (version !== 0x00 && version !== 0x05) return fail('invalid');
  return {
    ok: true,
    kind: 'address',
    address: base58check.encode(raw),
    script: version === 0x00 ? 'p2pkh' : 'p2sh',
  };
}

export function classifyWatchInput(raw) {
  if (typeof raw !== 'string') return fail('invalid');
  const cleaned = raw.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
  if (!cleaned) return fail('empty');
  if (cleaned.length > 20000) return fail('too-long');
  if (looksLikeMnemonic(cleaned)) return fail('secret');

  let tokens = cleaned.split(/[\s,;]+/).filter(Boolean).map(stripToken).filter(Boolean);
  if (!tokens.length) return fail('empty');
  if (tokens.some((token) => /^(x|y|z|t|u|v|Y|Z)prv/.test(token)
    || /^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(token)
    || /^(0x)?[0-9a-fA-F]{64}$/.test(token)
    || /^(0x)?[0-9a-fA-F]{128}$/.test(token))) {
    return fail('secret');
  }

  const joined = tokens.join('');
  if (tokens.length > 1 && /^(x|y|z|t|u|v|Y|Z)(pub|prv)/.test(joined)) {
    return classifyToken(joined);
  }
  if (tokens.length === 1) return classifyToken(tokens[0]);

  const classified = tokens.map(classifyToken);
  if (classified.some((item) => !item.ok && item.code === 'secret')) return fail('secret');
  const bad = classified.filter((item) => !item.ok);
  if (bad.length) {
    const codes = new Set(bad.map((item) => item.code));
    return fail(codes.size === 1 ? [...codes][0] : 'invalid');
  }
  return { ok: true, kind: 'list', items: classified };
}

function deriveNode(node, mode, chain, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error('Could not derive from extended public key');
  }
  if (mode === 'account' && (chain === 0 || chain === 1)) return node.derive(`m/${chain}/${index}`);
  if (mode === 'receive' && chain === 0) return node.derive(`m/${index}`);
  if (mode === 'change' && chain === 1) return node.derive(`m/${index}`);
  throw new Error('Could not derive from extended public key');
}

export function deriveAddress(extendedPublicKey, chain, index) {
  const info = classifyToken(String(extendedPublicKey).trim());
  if (!info.ok || info.kind !== 'xpub') {
    const error = new Error('Could not derive from extended public key');
    error.code = info.ok ? 'invalid' : info.code;
    throw error;
  }
  const node = HDKey.fromExtendedKey(info.xpub, {
    public: info.publicVersion,
    private: info.privateVersion,
  });
  if (node.privateKey) {
    const error = new Error('Could not derive from extended public key');
    error.code = 'secret';
    throw error;
  }
  const child = deriveNode(node, info.mode, chain, index);
  return addressFromHash(child.pubKeyHash, info.script);
}
