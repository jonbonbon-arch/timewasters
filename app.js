import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, runTransaction, serverTimestamp,
  collection, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDhskeFqyWxMRZRxRG0tepngbZme2a095w",
  authDomain: "timewasters-26c3f.firebaseapp.com",
  projectId: "timewasters-26c3f",
  storageBucket: "timewasters-26c3f.firebasestorage.app",
  messagingSenderId: "732296370858",
  appId: "1:732296370858:web:6805f27f410f6f75884ed3",
};

// Who is allowed to see/change what lives in firestore.rules (in the Firebase
// console), not here, so no email addresses are shipped to the browser.
const KIDS = [
  { id: "ilay", name: "עילי", female: false },
  { id: "gali", name: "גלי", female: true },
];

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

const $ = (sel, root = document) => root.querySelector(sel);
const screens = ["loading", "signin", "denied", "main"];
function show(name) {
  for (const s of screens) $(`#screen-${s}`).hidden = s !== name;
  $("#signout").hidden = name === "signin" || name === "loading";
}

// Missing cat photo → hide the image instead of showing a broken icon.
document.addEventListener("error", (e) => {
  if (e.target.tagName === "IMG") e.target.classList.add("missing");
}, true);
// Images that already failed before this script ran.
for (const img of document.images) {
  if (img.complete && img.naturalWidth === 0) img.classList.add("missing");
}

// ---- server clock -------------------------------------------------------
// Every device computes the running time from the server's start timestamp,
// so we correct for the device's own clock being off.
let clockOffset = 0;
const now = () => Date.now() + clockOffset;

async function syncClock(uid) {
  try {
    const ref = doc(db, "clocks", uid);
    const t0 = Date.now();
    await setDoc(ref, { t: serverTimestamp() });
    const snap = await getDoc(ref);
    const t1 = Date.now();
    clockOffset = snap.data().t.toMillis() - (t0 + t1) / 2;
  } catch (err) {
    console.warn("clock sync failed", err);
  }
}

// ---- time math ----------------------------------------------------------
function currentMs(d) {
  if (!d) return 0;
  if (d.mode === "idle" || !d.startedAt) return d.bank;
  const elapsed = Math.max(0, now() - d.startedAt.toMillis());
  return d.mode === "up" ? d.bank + elapsed : Math.max(0, d.bank - elapsed);
}

function fmt(ms) {
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---- actions (admins only; rules enforce it) ----------------------------
let me = { name: "" };

function logEntry(tx, kidId, type, ms) {
  tx.set(doc(collection(db, "kids", kidId, "log")), {
    type, ms, by: me.name, at: serverTimestamp(),
  });
}

function act(kidId, fn) {
  return runTransaction(db, async (tx) => {
    const ref = doc(db, "kids", kidId);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    fn(tx, ref, snap.data());
  }).catch((err) => {
    console.error(err);
    alert("משהו השתבש, נסו שוב.");
  });
}

const actions = {
  up: (kidId) => act(kidId, (tx, ref, d) => {
    if (d.mode !== "idle") return;
    tx.update(ref, { mode: "up", startedAt: serverTimestamp() });
  }),
  down: (kidId) => act(kidId, (tx, ref, d) => {
    if (d.mode !== "idle" || d.bank <= 0) return;
    tx.update(ref, { mode: "down", startedAt: serverTimestamp() });
  }),
  stop: (kidId) => act(kidId, (tx, ref, d) => {
    if (d.mode === "idle") return;
    const bank = Math.round(currentMs(d));
    const delta = Math.abs(bank - d.bank);
    tx.update(ref, { bank, mode: "idle", startedAt: null });
    if (delta >= 1000) logEntry(tx, kidId, d.mode === "up" ? "wasted" : "paid", delta);
  }),
  add: (kidId, minutes) => act(kidId, (tx, ref, d) => {
    const bank = Math.max(0, d.bank + minutes * 60000);
    tx.update(ref, { bank });
    logEntry(tx, kidId, minutes > 0 ? "add" : "remove", Math.abs(bank - d.bank));
  }),
  reset: (kidId) => {
    const kid = KIDS.find((k) => k.id === kidId);
    if (!confirm(`לאפס את הבנק של ${kid.name}?`)) return;
    return act(kidId, (tx, ref) => {
      tx.update(ref, { bank: 0, mode: "idle", startedAt: null });
      logEntry(tx, kidId, "reset", 0);
    });
  },
};

// ---- rendering ----------------------------------------------------------
const cards = new Map(); // kidId -> { el, data, stopping }
let unsubs = [];

function statusText(kid, d) {
  if (!d) return "עוד לא הוגדר";
  if (d.mode === "up") return kid.female ? `${kid.name} מבזבזת זמן…` : `${kid.name} מבזבז זמן…`;
  if (d.mode === "down") return "מחזירים את הזמן…";
  return "";
}

function logText(kid, e) {
  switch (e.type) {
    case "wasted": return `${kid.female ? "בזבזה" : "בזבז"} ${fmt(e.ms)}`;
    case "paid": return `הוחזרו ${fmt(e.ms)}`;
    case "add": return `‎+${fmt(e.ms)} ידני`;
    case "remove": return `‎−${fmt(e.ms)} ידני`;
    case "reset": return "איפוס";
    default: return e.type;
  }
}

function whenText(ts) {
  if (!ts) return "";
  const d = ts.toDate();
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString("he-IL", today
    ? { hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

function buildCard(kid, isAdmin) {
  const el = $("#tpl-card").content.firstElementChild.cloneNode(true);
  $(".kid-name", el).textContent = kid.name;
  const img = $(".cat-kid", el);
  img.src = `img/cat-${kid.id}.jpg`;
  $(".controls", el).hidden = !isAdmin;
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    actions[btn.dataset.act](kid.id, Number(btn.dataset.min));
  });
  $("#cards").append(el);

  const card = { el, kid, data: null, stopping: false };
  cards.set(kid.id, card);

  unsubs.push(onSnapshot(doc(db, "kids", kid.id), (snap) => {
    card.data = snap.exists() ? snap.data({ serverTimestamps: "estimate" }) : null;
    card.stopping = false;
    paintControls(card);
  }));

  const logQ = query(collection(db, "kids", kid.id, "log"), orderBy("at", "desc"), limit(20));
  unsubs.push(onSnapshot(logQ, (snap) => {
    const ul = $(".log", el);
    ul.replaceChildren();
    if (snap.empty) {
      const li = document.createElement("li");
      li.className = "empty-log";
      li.textContent = "עוד אין כלום";
      ul.append(li);
    }
    snap.forEach((s) => {
      const e = s.data({ serverTimestamps: "estimate" });
      const li = document.createElement("li");
      const what = document.createElement("span");
      what.textContent = logText(kid, e);
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = [e.by, whenText(e.at)].filter(Boolean).join(" · ");
      li.append(what, meta);
      ul.append(li);
    });
  }));
}

function paintControls(card) {
  const d = card.data;
  const mode = d ? d.mode : "idle";
  card.el.dataset.mode = mode;
  $(".status", card.el).textContent = statusText(card.kid, d);
  const running = mode !== "idle";
  $('[data-act="up"]', card.el).hidden = running;
  $('[data-act="down"]', card.el).hidden = running;
  $('[data-act="down"]', card.el).disabled = !d || d.bank <= 0;
  $('[data-act="stop"]', card.el).hidden = !running;
}

function tick() {
  for (const card of cards.values()) {
    const ms = currentMs(card.data);
    $(".clock", card.el).textContent = fmt(ms);
    const d = card.data;
    // Payback ran out: show the sad cat until time is added again.
    if (d && d.mode === "down" && ms <= 0) card.justEmptied = true;
    if (d && d.mode !== "down" && d.bank > 0) card.justEmptied = false;
    $(".empty", card.el).hidden = !card.justEmptied;
    // An admin's screen closes out a payback that reached zero.
    if (card.isAdmin && d && d.mode === "down" && ms <= 0 && !card.stopping) {
      card.stopping = true;
      actions.stop(card.kid.id);
    }
  }
}
setInterval(tick, 250);

// ---- startup ------------------------------------------------------------
async function canRead(path) {
  try {
    const snap = await getDoc(doc(db, ...path));
    return { ok: true, snap };
  } catch {
    return { ok: false };
  }
}

async function start(user) {
  me.name = (user.displayName || user.email).split(" ")[0];
  await syncClock(user.uid);

  const isAdmin = (await canRead(["meta", "admin"])).ok;
  let visible = [];
  if (isAdmin) {
    visible = KIDS;
    for (const kid of KIDS) {
      const { snap } = await canRead(["kids", kid.id]);
      if (snap && !snap.exists()) {
        await setDoc(doc(db, "kids", kid.id), { name: kid.name, bank: 0, mode: "idle", startedAt: null });
      }
    }
  } else {
    for (const kid of KIDS) {
      if ((await canRead(["kids", kid.id])).ok) visible.push(kid);
    }
  }

  if (!visible.length) {
    $("#denied-email").textContent = user.email;
    show("denied");
    return;
  }
  for (const kid of visible) buildCard(kid, isAdmin);
  for (const card of cards.values()) card.isAdmin = isAdmin;
  show("main");
}

function teardown() {
  unsubs.forEach((u) => u());
  unsubs = [];
  cards.clear();
  $("#cards").replaceChildren();
}

$("#signin").addEventListener("click", () => {
  signInWithPopup(auth, new GoogleAuthProvider()).catch((err) => {
    if (err.code !== "auth/popup-closed-by-user") alert("ההתחברות נכשלה: " + err.code);
  });
});
$("#signout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  teardown();
  if (!user) return show("signin");
  show("loading");
  start(user).catch((err) => {
    console.error(err);
    alert("שגיאה בטעינה: " + err.message);
  });
});
