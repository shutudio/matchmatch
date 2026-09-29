// 데이터 계층. 실제 Firebase(Firestore + 익명 로그인)와 테스트용 가짜 서버(?mock=1)를 같은 API로 감싼다.
// 앱 코드는 이 파일의 함수만 사용한다.

export const SERVER_TS = { __serverTs: true };
const MOCK = new URLSearchParams(location.search).has('mock');

let impl = null;
let clockOffset = 0; // serverNow = Date.now() + clockOffset

export const isMock = MOCK;
export const serverNow = () => Date.now() + clockOffset;
export const uid = () => impl.uid;

export async function init() {
  impl = MOCK ? await mockImpl() : await firebaseImpl();
  return impl.uid;
}

export const onDoc = (path, cb, onErr) => impl.onDoc(path, cb, onErr);
export const onCol = (path, cb, onErr) => impl.onCol(path, cb, onErr);
export const getDoc = (path) => impl.getDoc(path);
export const setDoc = (path, data, merge = false) => impl.setDoc(path, data, merge);
export const updateDoc = (path, data) => impl.updateDoc(path, data);
export const deleteDoc = (path) => impl.deleteDoc(path);
export const batch = (ops) => impl.batch(ops);
export const transaction = (fn) => impl.transaction(fn);

// 서버 시각 보정: 내 전용 문서에 서버 시각을 기록하고 되읽어 차이를 잰다.
export async function syncClock(roomId) {
  try {
    const path = `rooms/${roomId}/clocks/${impl.uid}`;
    const t0 = Date.now();
    await setDoc(path, { t: SERVER_TS });
    const d = await getDoc(path);
    const t1 = Date.now();
    if (d && typeof d.t === 'number') clockOffset = d.t - (t0 + t1) / 2;
  } catch (e) { console.warn('clock sync failed', e); }
}

/* ---------------- 실제 Firebase ---------------- */
async function firebaseImpl() {
  const V = '10.12.2';
  const [{ initializeApp }, A, F, { firebaseConfig }] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
    import('./firebase-config.js'),
  ]);
  if (String(firebaseConfig.apiKey).startsWith('여기에')) {
    throw new Error('js/firebase-config.js에 Firebase 설정값을 먼저 넣어 주세요.');
  }
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  await A.setPersistence(auth, A.browserLocalPersistence);
  const user = await new Promise((res, rej) => {
    const off = A.onAuthStateChanged(auth, (u) => {
      if (u) { off(); res(u); }
      else A.signInAnonymously(auth).catch(rej);
    });
  });

  const conv = (v) => {
    if (v && typeof v.toMillis === 'function') return v.toMillis();
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === 'object' && v.constructor === Object) {
      const o = {}; for (const k in v) o[k] = conv(v[k]); return o;
    }
    return v;
  };
  const enc = (v) => {
    if (v === SERVER_TS) return F.serverTimestamp();
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object' && v.constructor === Object) {
      const o = {}; for (const k in v) o[k] = enc(v[k]); return o;
    }
    return v;
  };
  const ref = (p) => F.doc(db, p);
  const meta = (snap) => ({ pending: snap.metadata.hasPendingWrites, fromCache: snap.metadata.fromCache });

  return {
    uid: user.uid,
    onDoc(path, cb, onErr) {
      return F.onSnapshot(ref(path), { includeMetadataChanges: true },
        (s) => cb(s.exists() ? conv(s.data({ serverTimestamps: 'estimate' })) : null, meta(s)),
        (e) => { console.warn('onDoc', path, e); onErr && onErr(e); });
    },
    onCol(path, cb, onErr) {
      return F.onSnapshot(F.collection(db, path),
        (s) => cb(s.docs.map((d) => ({ id: d.id, data: conv(d.data({ serverTimestamps: 'estimate' })) }))),
        (e) => { console.warn('onCol', path, e); onErr && onErr(e); });
    },
    async getDoc(path) {
      const s = await F.getDoc(ref(path));
      return s.exists() ? conv(s.data()) : null;
    },
    setDoc: (path, data, merge) => F.setDoc(ref(path), enc(data), { merge }),
    updateDoc: (path, data) => F.updateDoc(ref(path), enc(data)),
    deleteDoc: (path) => F.deleteDoc(ref(path)),
    batch(ops) {
      const b = F.writeBatch(db);
      for (const o of ops) {
        if (o.type === 'set') b.set(ref(o.path), enc(o.data), { merge: !!o.merge });
        else if (o.type === 'update') b.update(ref(o.path), enc(o.data));
        else if (o.type === 'delete') b.delete(ref(o.path));
      }
      return b.commit();
    },
    transaction(fn) {
      return F.runTransaction(db, async (t) => fn({
        get: async (p) => { const s = await t.get(ref(p)); return s.exists() ? conv(s.data()) : null; },
        set: (p, d, merge = false) => t.set(ref(p), enc(d), { merge }),
        update: (p, d) => t.update(ref(p), enc(d)),
        delete: (p) => t.delete(ref(p)),
      }));
    },
  };
}

/* ---------------- 가짜 서버 (같은 브라우저 안에서만 동작, 테스트·리허설용) ---------------- */
async function mockImpl() {
  const qs = new URLSearchParams(location.search);
  let id = qs.get('mockuid') || localStorage.getItem('mock:uid');
  if (!id) { id = 'u' + Math.random().toString(36).slice(2, 8); localStorage.setItem('mock:uid', id); }
  const KEY = 'mock:db:';
  const ch = new BroadcastChannel('mockdb');
  const docL = new Map(); // path -> Set(cb)
  const colL = new Map();
  const failNext = () => localStorage.getItem('mock:offline:' + id) === '1';

  const read = (p) => { const v = localStorage.getItem(KEY + p); return v ? JSON.parse(v) : null; };
  const parent = (p) => p.split('/').slice(0, -1).join('/');
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const res = (v) => {
    if (v === SERVER_TS || (v && v.__serverTs)) return Date.now();
    if (Array.isArray(v)) return v.map(res);
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = res(v[k]); return o; }
    return v;
  };
  const listCol = (c) => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith(KEY)) continue;
      const p = k.slice(KEY.length);
      if (parent(p) === c) out.push({ id: p.split('/').pop(), data: JSON.parse(localStorage.getItem(k)) });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  };
  const notify = (p) => {
    (docL.get(p) || []).forEach((cb) => cb(clone(read(p)), { pending: false }));
    (colL.get(parent(p)) || []).forEach((cb) => cb(listCol(parent(p))));
  };
  ch.onmessage = (e) => notify(e.data);
  const write = (p, v) => {
    if (v == null) localStorage.removeItem(KEY + p); else localStorage.setItem(KEY + p, JSON.stringify(v));
  };
  const applyOp = (o) => {
    const cur = read(o.path);
    if (o.type === 'delete') write(o.path, null);
    else if (o.type === 'set') write(o.path, o.merge && cur ? { ...cur, ...res(o.data) } : res(o.data));
    else if (o.type === 'update') {
      if (!cur) throw new Error('not-found ' + o.path);
      const next = { ...cur };
      for (const [k, v] of Object.entries(res(o.data))) {
        if (k.includes('.')) { const [a, b] = k.split('.'); next[a] = { ...(next[a] || {}), [b]: v }; }
        else next[k] = v;
      }
      write(o.path, next);
    }
  };
  const commit = async (ops) => {
    await new Promise((r) => setTimeout(r, 30));
    if (failNext()) throw new Error('offline (mock)');
    ops.forEach(applyOp);
    ops.forEach((o) => { notify(o.path); ch.postMessage(o.path); });
  };
  const sub = (m, p, cb) => { if (!m.has(p)) m.set(p, new Set()); m.get(p).add(cb); return () => m.get(p).delete(cb); };

  return {
    uid: id,
    onDoc(p, cb) { setTimeout(() => cb(clone(read(p)), { pending: false }), 0); return sub(docL, p, cb); },
    onCol(p, cb) { setTimeout(() => cb(listCol(p)), 0); return sub(colL, p, cb); },
    async getDoc(p) { return clone(read(p)); },
    setDoc: (p, d, merge) => commit([{ type: 'set', path: p, data: d, merge }]),
    updateDoc: (p, d) => commit([{ type: 'update', path: p, data: d }]),
    deleteDoc: (p) => commit([{ type: 'delete', path: p }]),
    batch: (ops) => commit(ops),
    async transaction(fn) {
      if (failNext()) { await new Promise((r) => setTimeout(r, 30)); throw new Error('offline (mock)'); }
      const ops = [];
      const out = await fn({
        get: async (p) => clone(read(p)),
        set: (p, d, merge = false) => ops.push({ type: 'set', path: p, data: d, merge }),
        update: (p, d) => ops.push({ type: 'update', path: p, data: d }),
        delete: (p) => ops.push({ type: 'delete', path: p }),
      });
      await commit(ops);
      return out;
    },
  };
}
