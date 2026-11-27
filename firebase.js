// Branche le Carnet sur Firebase en imitant l'interface que claude.ai fournit à la page
// (claude.use("db" | "assets" | "sample" | "user" | "mcp")), pour que le même code tourne aux deux endroits.
//   db      -> Firestore, collection « recettes »
//   assets  -> photos compressées dans Firestore, collection « photos » (forfait gratuit : pas de Cloud Storage)
//   sample  -> Gemini via Firebase AI Logic (lecture d'une photo, d'un texte ou d'une adresse)
//   user    -> compte Google connecté ; seul le compte autorisé par les règles Firestore peut lire et écrire
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";
import { getAI, getGenerativeModel, GoogleAIBackend } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-ai.js";
import { firebaseConfig, MODELE_IA } from "./config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = "fr";
const fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

// ---------- Écran de connexion ----------
const POT = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 9c-1.4-1.3 1.4-2.7 0-4"/><path d="M16 8.5c-1.6-1.5 1.6-3 0-4.5"/><path d="M21 9c-1.4-1.3 1.4-2.7 0-4"/><path d="M14.5 12.3h3"/><path d="M6 15h20"/><path d="M7.5 15v8.5A3.5 3.5 0 0 0 11 27h10a3.5 3.5 0 0 0 3.5-3.5V15"/><path d="M7.5 18H4.5M24.5 18h3"/></svg>';
const gate = document.createElement("div");
gate.className = "fb-gate";
gate.hidden = true;
document.body.append(gate);
function showGate(kind, detail) {
  gate.hidden = false;
  gate.innerHTML = `<div class="fb-box"><span class="fb-logo">${POT}</span><h1>Carnet de cuisine</h1><p class="fb-msg"></p><div class="fb-acts"></div></div>`;
  const msg = gate.querySelector(".fb-msg"), acts = gate.querySelector(".fb-acts");
  const btn = (label, fn, cls = "") => { const b = document.createElement("button"); b.type = "button"; b.className = "btn " + cls; b.textContent = label; b.onclick = fn; acts.append(b); return b; };
  if (kind === "login") {
    msg.textContent = detail || "Connecte-toi avec ton compte Google pour ouvrir le carnet.";
    btn("Se connecter avec Google", async e => {
      e.currentTarget.disabled = true;
      try { await signInWithPopup(auth, new GoogleAuthProvider()); }
      catch (err) {
        if (err?.code === "auth/popup-blocked" || err?.code === "auth/operation-not-supported-in-this-environment") { await signInWithRedirect(auth, new GoogleAuthProvider()); return; }
        if (err?.code !== "auth/popup-closed-by-user" && err?.code !== "auth/cancelled-popup-request") showGate("login", "La connexion a échoué (" + (err?.code || "erreur") + "). Réessaie.");
        else e.currentTarget.disabled = false;
      }
    }, "primary");
  } else if (kind === "prive") {
    msg.textContent = `Ce carnet est privé. Le compte ${auth.currentUser?.email || ""} n'y a pas accès.`;
    btn("Changer de compte", async () => { await signOut(auth); location.reload(); }, "primary");
  }
}
function hideGate() { gate.hidden = true; gate.replaceChildren(); }

let resolveUser;
const userReady = new Promise(r => (resolveUser = r));
onAuthStateChanged(auth, u => {
  if (u) { hideGate(); resolveUser(u); }
  else showGate("login");
});

// ---------- db ----------
const snapOf = s => ({ metadata: { fromCache: s.metadata.fromCache }, docs: s.docs.map(d => ({ id: d.id, data: () => d.data() })) });
const dbApi = Object.freeze({
  collection: path => ({
    onSnapshot: (cb, onErr) => onSnapshot(collection(fs, path), s => cb(snapOf(s)), e => { if (e?.code === "permission-denied") showGate("prive"); onErr?.(e); }),
  }),
  doc: path => ({
    set: data => setDoc(doc(fs, path), data),
    update: data => updateDoc(doc(fs, path), data),
    delete: () => deleteDoc(doc(fs, path)),
    get: async () => { const d = await getDoc(doc(fs, path)); return d.exists() ? d.data() : null; },
  }),
});

// ---------- Photos (stockées dans Firestore, en JPEG compressé) ----------
const MAX_B64 = 850 * 1024;           // un document Firestore est limité à 1 Mio
const toB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
async function compress(blob) {
  let side = 1400, q = .82;
  for (let i = 0; i < 6; i++) {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise(r => c.toBlob(r, "image/jpeg", q));
    const b64 = await toB64(out);
    if (b64.length <= MAX_B64) return { b64, w: c.width, h: c.height };
    side = Math.round(side * .8); q = Math.max(.6, q - .06);
  }
  throw Object.assign(new Error("Photo trop lourde"), { code: "too_large" });
}
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
const urls = new Map();               // id -> Promise<URL blob:>
const ready = new Map();              // id -> URL blob: déjà chargée
function loadPhoto(id) {
  if (!urls.has(id)) urls.set(id, (async () => {
    await userReady;
    const d = await getDoc(doc(fs, "photos/" + id));
    if (!d.exists()) throw new Error("photo absente");
    const { b64, type } = d.data();
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const u = URL.createObjectURL(new Blob([bin], { type: type || "image/jpeg" }));
    ready.set(id, u);
    return u;
  })());
  return urls.get(id);
}
// Adresse provisoire (image vide) tant que la photo n'est pas chargée ; l'observateur la remplace ensuite.
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
window.photoUrl = id => ready.get(id) || (loadPhoto(id).catch(() => {}), BLANK + "#pid=" + id);
function hydrate(img) {
  const m = /#pid=([0-9a-f]+)$/.exec(img.getAttribute("src") || "");
  if (m) loadPhoto(m[1]).then(u => { if (img.getAttribute("src")?.endsWith("#pid=" + m[1])) img.src = u; }).catch(() => img.classList.remove("loading"));
}
new MutationObserver(list => {
  for (const r of list) {
    if (r.type === "attributes") { if (r.target.tagName === "IMG") hydrate(r.target); continue; }
    for (const n of r.addedNodes) if (n.nodeType === 1) { if (n.tagName === "IMG") hydrate(n); else n.querySelectorAll?.("img").forEach(hydrate); }
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
document.querySelectorAll("img").forEach(hydrate);

const assetsApi = Object.freeze({
  upload: async blob => {
    const { b64, w, h } = await compress(blob);
    const id = newId();
    await setDoc(doc(fs, "photos/" + id), { type: "image/jpeg", b64, w, h, le: new Date().toISOString() });
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const u = URL.createObjectURL(new Blob([bin], { type: "image/jpeg" }));
    ready.set(id, u); urls.set(id, Promise.resolve(u));
    return { id, url: u };
  },
});

// ---------- IA : Gemini via Firebase AI Logic ----------
const ai = getAI(app, { backend: new GoogleAIBackend() });
const modelJson = getGenerativeModel(ai, { model: MODELE_IA, generationConfig: { responseMimeType: "application/json", temperature: 0.2 } });
const modelWeb = getGenerativeModel(ai, { model: MODELE_IA, tools: [{ urlContext: {} }], generationConfig: { temperature: 0.2 } });
function parseJson(t) {
  t = String(t || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  throw Object.assign(new Error("JSON invalide"), { code: "invalid_json" });
}
function aiErr(e) {
  const s = String(e?.message || e);
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(s)) return { code: "rate_limited" };
  if (/too large|payload|size/i.test(s)) return { code: "prompt_too_large" };
  if (e?.code === "invalid_json") return e;
  console.error(e);
  return { code: "error", message: s };
}
const sampleFn = async (prompt, opts = {}) => (await sampleFn.json(prompt, opts));
sampleFn.json = async (prompt, opts = {}) => {
  const parts = [{ text: prompt }];
  for (const b of opts.images || []) parts.push({ inlineData: { mimeType: b.type || "image/jpeg", data: await toB64(b) } });
  try {
    const r = await (opts.url ? modelWeb : modelJson).generateContent(parts);
    return parseJson(r.response.text());
  } catch (e) { throw aiErr(e); }
};
sampleFn.limits = async () => ({ images: true });
sampleFn.lienDirect = true;

const userApi = Object.freeze({
  can: async () => true,
  canEdit: async () => true,
  isOwner: async () => true,
  id: async () => (await userReady).uid,
});

const caps = { db: dbApi, assets: assetsApi, sample: sampleFn, user: userApi, mcp: null };
window.__fbResolve({ use: async name => { await userReady; return caps[name] ?? null; }, auth, fs, signOut: () => signOut(auth) });

// ---------- Sauvegarde : #sauvegarde ouvre l'import d'un fichier .json { recettes: {id: {...}}, photos: {id: {type, b64}} } ----------
async function ecranSauvegarde() {
  await userReady;
  gate.hidden = false;
  gate.innerHTML = `<div class="fb-box"><span class="fb-logo">${POT}</span><h1>Importer une sauvegarde</h1>
    <p class="fb-msg">Choisis le fichier de sauvegarde du carnet (.json). Les recettes et photos qu'il contient sont ajoutées ou remplacées ; les autres ne sont pas touchées.</p>
    <input type="file" id="fb-file" accept="application/json,.json">
    <p class="fb-prog" aria-live="polite"></p>
    <div class="fb-acts"><button type="button" class="btn" id="fb-close">Fermer</button><button type="button" class="btn" id="fb-out">Se déconnecter</button></div></div>`;
  const prog = gate.querySelector(".fb-prog");
  gate.querySelector("#fb-close").onclick = () => { history.replaceState(null, "", location.pathname); hideGate(); };
  gate.querySelector("#fb-out").onclick = async () => { await signOut(auth); location.replace(location.pathname); };
  gate.querySelector("#fb-file").onchange = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    let data; try { data = JSON.parse(await f.text()); } catch { prog.textContent = "Ce fichier n'est pas une sauvegarde lisible."; return; }
    const photos = Object.entries(data.photos || {}), recs = Object.entries(data.recettes || {});
    let n = 0; const total = photos.length + recs.length;
    try {
      for (const [id, p] of photos) { await setDoc(doc(fs, "photos/" + id), p); prog.textContent = `${++n} / ${total}…`; }
      for (const [id, r] of recs) { await setDoc(doc(fs, "recettes/" + id), r); prog.textContent = `${++n} / ${total}…`; }
      prog.textContent = `Terminé : ${recs.length} recettes et ${photos.length} photos importées.`;
    } catch (err) { prog.textContent = `Arrêté à ${n} / ${total} : ${err?.code || err?.message}. Relance l'import : ce qui est déjà fait sera simplement réécrit.`; }
  };
}
if (location.hash === "#sauvegarde") ecranSauvegarde();
window.addEventListener("hashchange", () => { if (location.hash === "#sauvegarde") ecranSauvegarde(); });
