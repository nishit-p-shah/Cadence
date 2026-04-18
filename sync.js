/* ==========================================================
   Cadence · Firebase sync (auth + Firestore)
   ========================================================== */

const cfg = window.FIREBASE_CONFIG || {};
const configured = !!(cfg.apiKey && cfg.projectId && cfg.authDomain);

let app = null, auth = null, db = null;
let currentUser = null;
let authSubscribers = [];
let unsubscribeSnapshot = null;
let pushTimer = null;

async function init() {
  if (!configured) return;
  try {
    const [{ initializeApp }, fbAuth, fbStore] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js'),
    ]);
    app = initializeApp(cfg);
    auth = fbAuth.getAuth(app);
    db = fbStore.getFirestore(app);
    window.__fb = { fbAuth, fbStore };

    fbAuth.onAuthStateChanged(auth, (user) => {
      currentUser = user || null;
      authSubscribers.forEach(fn => { try { fn(currentUser); } catch (e) {} });
    });
  } catch (e) {
    console.warn('[cadence-sync] init failed', e);
  }
}

async function signIn() {
  if (!auth) return null;
  const { GoogleAuthProvider, signInWithPopup } = window.__fb.fbAuth;
  const provider = new GoogleAuthProvider();
  try {
    const res = await signInWithPopup(auth, provider);
    return res.user;
  } catch (e) {
    console.warn('[cadence-sync] sign-in failed', e);
    alert('Sign-in failed: ' + (e.message || e.code || e));
    return null;
  }
}

async function signOutUser() {
  if (!auth) return;
  const { signOut } = window.__fb.fbAuth;
  try { await signOut(auth); } catch (e) {}
  if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
}

function userDocRef() {
  if (!db || !currentUser) return null;
  const { doc } = window.__fb.fbStore;
  return doc(db, 'users', currentUser.uid, 'state', 'main');
}

async function pullRemote() {
  const ref = userDocRef();
  if (!ref) return null;
  const { getDoc } = window.__fb.fbStore;
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data();
      return data && data.payload ? JSON.parse(data.payload) : null;
    }
  } catch (e) {
    console.warn('[cadence-sync] pull failed', e);
  }
  return null;
}

function pushRemote(state) {
  const ref = userDocRef();
  if (!ref) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const { setDoc, serverTimestamp } = window.__fb.fbStore;
    try {
      await setDoc(ref, {
        payload: JSON.stringify(state),
        updatedAt: serverTimestamp(),
        client: navigator.userAgent.slice(0, 120),
      });
      window.dispatchEvent(new CustomEvent('cadence-sync-saved'));
    } catch (e) {
      console.warn('[cadence-sync] push failed', e);
      window.dispatchEvent(new CustomEvent('cadence-sync-error', { detail: e }));
    }
  }, 600);
}

function subscribeRemote(onChange) {
  const ref = userDocRef();
  if (!ref) return () => {};
  const { onSnapshot } = window.__fb.fbStore;
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  unsubscribeSnapshot = onSnapshot(ref, (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();
    if (!data || !data.payload) return;
    try { onChange(JSON.parse(data.payload), data); } catch (e) {}
  }, (err) => console.warn('[cadence-sync] snapshot error', err));
  return unsubscribeSnapshot;
}

function onAuthChange(fn) {
  authSubscribers.push(fn);
  try { fn(currentUser); } catch (e) {}
  return () => { authSubscribers = authSubscribers.filter(f => f !== fn); };
}

window.cadenceSync = {
  available: configured,
  get user() { return currentUser; },
  onAuthChange,
  signIn,
  signOut: signOutUser,
  pullRemote,
  pushRemote,
  subscribeRemote,
  init,
};

init();
