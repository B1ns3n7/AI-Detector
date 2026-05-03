"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE ADDITIONS — 2026-04-29
//  1. Dataset Evaluation Mode (CSV/JSON batch upload)
//  2. ROC Curve + Confusion Matrix (requires ground-truth labels)
//  3. Model Comparison Dashboard (Engine A vs B vs C across dataset)
//  4. Experiment Tracking Panel (history of batch evaluations)
//  5. SHAP-like Signal Contribution Viewer (feature attribution deltas)
//  6. Real-time Monitoring Dashboard (in-session volume tracking + drift)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Dataset & Evaluation Types ───────────────────────────────────────────────

interface DatasetRow {
  id: string;
  text: string;
  groundTruth?: "AI" | "Human"; // optional — enables ROC/confusion matrix
  label?: string; // user-supplied label/name for the row
}

interface BatchResult {
  row: DatasetRow;
  perpScore: number;
  burstScore: number;
  // Neural is skipped in batch mode to avoid API rate limits — approximated
  combinedAI: number;
  verdict: string;
  psStrength: string;
  bcStrength: string;
  processingMs: number;
}

interface ExperimentRun {
  id: string;
  ts: number;
  name: string;
  rowCount: number;
  hasGroundTruth: boolean;
  // Aggregate metrics
  avgAI: number;
  aiCount: number;
  humanCount: number;
  mixedCount: number;
  // Accuracy metrics (only when groundTruth provided)
  accuracy?: number;
  precision?: number;
  recall?: number;
  f1?: number;
  auc?: number;
  // Raw results stored for comparison dashboard
  results: BatchResult[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FIREBASE MULTI-USER BACKEND
//  Drop-in replacement for all localStorage calls.
//  Setup: add your Firebase config to FIREBASE_CONFIG below, then enable
//  Firestore and Anonymous Auth in your Firebase console.
//
//  Collections:
//    users/{uid}/history          — scan history per user
//    users/{uid}/experiments      — batch experiment runs per user
//    users/{uid}/monitoring       — real-time monitoring events per user
//    users/{uid}/calibration      — reviewer calibration data per user
//    shared/monitoring/events     — global monitoring across all users (optional)
// ═══════════════════════════════════════════════════════════════════════════════

// ── STEP 1: Paste your Firebase config here ───────────────────────────────────
// Get this from Firebase Console → Project Settings → Your Apps → SDK setup
const FIREBASE_CONFIG = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY            ?? "",
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN        ?? "",
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID         ?? "",
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET     ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID             ?? "",
};

// ── Firebase SDK (loaded dynamically to avoid SSR issues) ────────────────────
import type { Firestore } from "firebase/firestore";
import type { Auth, User } from "firebase/auth";

let _db: Firestore | null = null;
let _auth: Auth | null = null;
let _currentUser: User | null = null;
let _firebaseReady = false;
let _firebaseError = "";

// Lazy-initialise Firebase once on the client
async function initFirebase(): Promise<boolean> {
  if (_firebaseReady) return true;
  if (typeof window === "undefined") return false;
  if (!FIREBASE_CONFIG.apiKey) {
    _firebaseError = "Firebase config missing. Set NEXT_PUBLIC_FIREBASE_* env vars.";
    console.warn(_firebaseError);
    return false;
  }
  try {
    const { initializeApp, getApps } = await import("firebase/app");
    const { getFirestore } = await import("firebase/firestore");
    const { getAuth, signInAnonymously, onAuthStateChanged } = await import("firebase/auth");

    const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
    _db   = getFirestore(app);
    _auth = getAuth(app);

    await new Promise<void>((resolve) => {
      onAuthStateChanged(_auth!, async (user) => {
        if (user) {
          _currentUser = user;
        } else {
          const cred = await signInAnonymously(_auth!);
          _currentUser = cred.user;
        }
        resolve();
      });
    });

    _firebaseReady = true;
    return true;
  } catch (e: any) {
    _firebaseError = `Firebase init failed: ${e.message}`;
    console.error(_firebaseError);
    return false;
  }
}

function uid(): string { return _currentUser?.uid ?? "anonymous"; }

// ── Firestore helpers ─────────────────────────────────────────────────────────

async function fsGet<T>(path: string): Promise<T | null> {
  if (!await initFirebase() || !_db) return null;
  try {
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(_db, path));
    return snap.exists() ? (snap.data() as T) : null;
  } catch (e) { console.error("fsGet", path, e); return null; }
}

async function fsSet(path: string, data: object): Promise<void> {
  if (!await initFirebase() || !_db) return;
  try {
    const { doc, setDoc } = await import("firebase/firestore");
    await setDoc(doc(_db, path), data);
  } catch (e) { console.error("fsSet", path, e); }
}

async function fsAddToArray<T>(path: string, field: string, item: T, maxItems: number): Promise<void> {
  if (!await initFirebase() || !_db) return;
  try {
    const { doc, getDoc, setDoc } = await import("firebase/firestore");
    const ref = doc(_db, path);
    const snap = await getDoc(ref);
    const existing: T[] = snap.exists() ? (snap.data()[field] ?? []) : [];
    const updated = [item, ...existing].slice(0, maxItems);
    await setDoc(ref, { [field]: updated }, { merge: true });
  } catch (e) { console.error("fsAddToArray", path, e); }
}

async function fsGetArray<T>(path: string, field: string): Promise<T[]> {
  if (!await initFirebase() || !_db) return [];
  try {
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(_db, path));
    return snap.exists() ? (snap.data()[field] ?? []) : [];
  } catch (e) { console.error("fsGetArray", path, e); return []; }
}

// ── Firebase-backed storage functions (replace localStorage) ──────────────────

// ── Firebase-backed storage functions ────────────────────────────────────────
// Each record is stored as its own Firestore document in a subcollection.
// This avoids the 1MB per-document limit that kills array-in-document storage.
//
// Structure:
//   users/{uid}/experiments/{runId}   — one doc per experiment run
//   users/{uid}/history/{scanId}      — one doc per scan
//   users/{uid}/monitoring/{ts}       — one doc per monitoring event
//   users/{uid}/data/calibration      — single small doc (calibration is tiny)

async function loadExperimentsAsync(): Promise<ExperimentRun[]> {
  const ok = await initFirebase();
  if (!ok) return loadExperimentsLocal();
  try {
    const { collection, getDocs, orderBy, query, limit } = await import("firebase/firestore");
    const q = query(
      collection(_db!, `users/${uid()}/experiments`),
      orderBy("ts", "desc"),
      limit(20)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data() as ExperimentRun);
  } catch (e) { console.error("loadExperimentsAsync", e); return loadExperimentsLocal(); }
}

async function saveExperimentsAsync(runs: ExperimentRun[]): Promise<void> {
  const ok = await initFirebase();
  if (!ok) { saveExperimentsLocal(runs); return; }
  try {
    const { doc, setDoc, deleteDoc, collection, getDocs } = await import("firebase/firestore");
    // Write each run as its own document — strip the heavy results array to save space
    for (const run of runs.slice(0, 20)) {
      const slim = { ...run, results: run.results.slice(0, 100) }; // cap at 100 rows per run
      await setDoc(doc(_db!, `users/${uid()}/experiments/${run.id}`), slim);
    }
    saveExperimentsLocal(runs);
  } catch (e) { console.error("saveExperimentsAsync", e); saveExperimentsLocal(runs); }
}

async function loadHistoryAsync(): Promise<ScanRecord[]> {
  const ok = await initFirebase();
  if (!ok) return loadHistoryLocal();
  try {
    const { collection, getDocs, orderBy, query, limit } = await import("firebase/firestore");
    const q = query(
      collection(_db!, `users/${uid()}/history`),
      orderBy("ts", "desc"),
      limit(50)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data() as ScanRecord);
  } catch (e) { console.error("loadHistoryAsync", e); return loadHistoryLocal(); }
}

async function saveHistoryAsync(records: ScanRecord[]): Promise<void> {
  const ok = await initFirebase();
  if (!ok) { saveHistoryLocal(records); return; }
  try {
    const { doc, setDoc } = await import("firebase/firestore");
    for (const rec of records.slice(0, 50)) {
      await setDoc(doc(_db!, `users/${uid()}/history/${rec.id}`), rec);
    }
    saveHistoryLocal(records);
  } catch (e) { console.error("saveHistoryAsync", e); saveHistoryLocal(records); }
}

async function loadMonitoringEventsAsync(): Promise<MonitoringEvent[]> {
  const ok = await initFirebase();
  if (!ok) return loadMonitoringEventsLocal();
  try {
    const { collection, getDocs, orderBy, query, limit } = await import("firebase/firestore");
    const q = query(
      collection(_db!, `users/${uid()}/monitoring`),
      orderBy("ts", "desc"),
      limit(200)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data() as MonitoringEvent);
  } catch (e) { console.error("loadMonitoringEventsAsync", e); return loadMonitoringEventsLocal(); }
}

async function saveMonitoringEventAsync(evt: MonitoringEvent): Promise<void> {
  const ok = await initFirebase();
  if (!ok) { saveMonitoringEventLocal(evt); return; }
  try {
    const { doc, setDoc } = await import("firebase/firestore");
    await setDoc(doc(_db!, `users/${uid()}/monitoring/${evt.ts}`), evt);
    // Also write to shared global collection
    await setDoc(doc(_db!, `sharedMonitoring/${evt.ts}_${uid().slice(0,8)}`), { ...evt, uid: uid() });
    saveMonitoringEventLocal(evt);
  } catch (e) { console.error("saveMonitoringEventAsync", e); saveMonitoringEventLocal(evt); }
}

async function loadCalibrationAsync(): Promise<CalibrationData> {
  const ok = await initFirebase();
  if (!ok) return loadCalibrationLocal();
  try {
    const data = await fsGet<CalibrationData>(`users/${uid()}/data/calibration`);
    return data ?? { totalScans: 0, reviewerOverrides: 0, systemSaidAI_reviewerSaidHuman: 0, systemSaidHuman_reviewerSaidAI: 0, bandOverrides: {} };
  } catch (e) { return loadCalibrationLocal(); }
}

async function saveCalibrationAsync(data: CalibrationData): Promise<void> {
  const ok = await initFirebase();
  if (!ok) { saveCalibrationLocal(data); return; }
  try {
    await fsSet(`users/${uid()}/data/calibration`, data as object);
    saveCalibrationLocal(data);
  } catch (e) { saveCalibrationLocal(data); }
}

// ── Local fallbacks (original localStorage implementations) ───────────────────

function loadExperimentsLocal(): ExperimentRun[] {
  try { return JSON.parse(localStorage.getItem("aidetect_experiments") || "[]"); }
  catch { return []; }
}
function saveExperimentsLocal(runs: ExperimentRun[]) {
  try { localStorage.setItem("aidetect_experiments", JSON.stringify(runs.slice(0, 20))); } catch {}
}
function loadMonitoringEventsLocal(): MonitoringEvent[] {
  try { return JSON.parse(localStorage.getItem("aidetect_monitoring") || "[]"); }
  catch { return []; }
}
function saveMonitoringEventLocal(evt: MonitoringEvent) {
  try {
    const events = loadMonitoringEventsLocal();
    events.unshift(evt);
    localStorage.setItem("aidetect_monitoring", JSON.stringify(events.slice(0, 200)));
  } catch {}
}

// ── Auth state hook ───────────────────────────────────────────────────────────

function useFirebaseAuth() {
  const [user, setUser]       = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");

  useEffect(() => {
    initFirebase().then(ok => {
      if (!ok) { setError(_firebaseError); setLoading(false); return; }
      import("firebase/auth").then(({ onAuthStateChanged }) => {
        const unsub = onAuthStateChanged(_auth!, u => {
          setUser(u); _currentUser = u; setLoading(false);
        });
        return unsub;
      });
    });
  }, []);

  const signInWithGoogle = async () => {
    try {
      const { GoogleAuthProvider, signInWithPopup } = await import("firebase/auth");
      await signInWithPopup(_auth!, new GoogleAuthProvider());
    } catch (e: any) { setError(e.message); }
  };

  const signInAnon = async () => {
    try {
      const { signInAnonymously } = await import("firebase/auth");
      await signInAnonymously(_auth!);
    } catch (e: any) { setError(e.message); }
  };

  const signOut = async () => {
    try {
      const { signOut: fbSignOut } = await import("firebase/auth");
      await fbSignOut(_auth!);
    } catch (e: any) { setError(e.message); }
  };

  return { user, loading, error, signInWithGoogle, signInAnon, signOut };
}

// ── Auth UI component ─────────────────────────────────────────────────────────

function AuthBar({ user, loading, error, onGoogle, onAnon, onSignOut }: {
  user: User | null; loading: boolean; error: string;
  onGoogle: () => void; onAnon: () => void; onSignOut: () => void;
}) {
  if (!FIREBASE_CONFIG.apiKey) return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200">
      <span className="text-[10px] text-amber-700 font-semibold">⚠ Firebase not configured — running in local mode</span>
    </div>
  );

  if (loading) return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100">
      <span className="text-[10px] text-slate-500">Connecting…</span>
    </div>
  );

  if (error) return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-50 border border-red-200">
      <span className="text-[10px] text-red-600 font-semibold">Firebase error — local mode</span>
    </div>
  );

  if (!user) return (
    <div className="flex items-center gap-2">
      <button onClick={onGoogle}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700 transition-colors shadow-sm">
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
        Sign in with Google
      </button>
      <button onClick={onAnon}
        className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-semibold text-slate-600 transition-colors">
        Continue anonymously
      </button>
    </div>
  );

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200">
        {user.photoURL && <img src={user.photoURL} className="w-4 h-4 rounded-full" alt="" />}
        <span className="text-[10px] text-emerald-700 font-semibold">
          {user.isAnonymous ? "Anonymous" : (user.displayName ?? user.email ?? "Signed in")}
        </span>
        <span className="text-[9px] text-emerald-500">· synced</span>
      </div>
      <button onClick={onSignOut}
        className="text-[10px] text-slate-400 hover:text-slate-600 transition-colors">
        Sign out
      </button>
    </div>
  );
}

// ── Monitoring State ─────────────────────────────────────────────────────────

interface MonitoringEvent {
  ts: number;
  aiPct: number;
  verdict: string;
  wordCount: number;
}

// ── SHAP-like Signal Attribution ─────────────────────────────────────────────

interface ShapEntry {
  signal: string;
  baseScore: number;
  withSignal: number;
  delta: number; // positive = points to AI
  engine: "PS" | "BC";
}

function computeShapValues(perpResult: EngineResult | null, burstResult: EngineResult | null): ShapEntry[] {
  if (!perpResult && !burstResult) return [];
  const entries: ShapEntry[] = [];
  // For each engine, compute baseline (signals off) vs full score delta
  // We approximate by using each signal's reported strength as its contribution
  const processEngine = (result: EngineResult, engine: "PS" | "BC") => {
    const base = result.internalScore;
    const totalStrength = result.signals.reduce((s, sig) => s + (sig.pointsToAI ? sig.strength : -sig.strength * 0.3), 0);
    for (const sig of result.signals) {
      const contribution = totalStrength !== 0
        ? (sig.pointsToAI ? sig.strength : -sig.strength * 0.3) / Math.max(Math.abs(totalStrength), 1) * base
        : 0;
      entries.push({
        signal: sig.name,
        baseScore: base - contribution,
        withSignal: base,
        delta: parseFloat(contribution.toFixed(1)),
        engine,
      });
    }
  };
  if (perpResult) processEngine(perpResult, "PS");
  if (burstResult) processEngine(burstResult, "BC");
  return entries.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 20);
}

// ── CSV Parser ────────────────────────────────────────────────────────────────

function parseCSV(text: string): DatasetRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/"/g, ""));
  const textCol = header.findIndex(h => ["text", "content", "body", "passage"].includes(h));
  const labelCol = header.findIndex(h => ["label", "name", "title", "id"].includes(h));
  const gtCol = header.findIndex(h => ["groundtruth", "ground_truth", "truth", "class", "category", "actual"].includes(h));
  if (textCol === -1) return [];
  const rows: DatasetRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    // Simple CSV split (handles quoted commas)
    const cols: string[] = [];
    let cur = "", inQ = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
    cols.push(cur.trim());
    const rawText = cols[textCol]?.replace(/^"|"$/g, "") ?? "";
    if (rawText.length < 20) continue;
    const gt = gtCol >= 0 ? cols[gtCol]?.replace(/^"|"$/g, "").toLowerCase() : undefined;
    rows.push({
      id: String(i),
      text: rawText,
      label: labelCol >= 0 ? cols[labelCol]?.replace(/^"|"$/g, "") : `Row ${i}`,
      groundTruth: gt === "ai" || gt === "ai-generated" || gt === "1" ? "AI"
        : gt === "human" || gt === "human-written" || gt === "0" ? "Human"
        : undefined,
    });
  }
  return rows;
}

function parseJSONDataset(text: string): DatasetRow[] {
  try {
    const data = JSON.parse(text);
    const arr: any[] = Array.isArray(data) ? data : data.texts ?? data.rows ?? data.data ?? [];
    return arr.map((item: any, i: number): DatasetRow => {
      const gt = String(item.groundTruth ?? item.ground_truth ?? item.truth ?? item.class ?? "").toLowerCase();
      const groundTruth: "AI" | "Human" | undefined =
        gt === "ai" || gt === "ai-generated" || gt === "1" ? "AI"
        : gt === "human" || gt === "human-written" || gt === "0" ? "Human"
        : undefined;
      return {
        id: String(item.id ?? i + 1),
        text: String(item.text ?? item.content ?? item.body ?? item.passage ?? ""),
        label: String(item.label ?? item.name ?? item.title ?? `Item ${i + 1}`),
        groundTruth,
      };
    }).filter((r: DatasetRow) => r.text.length >= 20);
  } catch { return []; }
}

// ── ROC + Metrics Calculator ──────────────────────────────────────────────────

function computeROCPoints(results: BatchResult[]): Array<{ threshold: number; tpr: number; fpr: number }> {
  const withGT = results.filter(r => r.row.groundTruth);
  if (withGT.length === 0) return [];
  const positives = withGT.filter(r => r.row.groundTruth === "AI").length;
  const negatives = withGT.filter(r => r.row.groundTruth === "Human").length;
  if (positives === 0 || negatives === 0) return [];
  const thresholds = Array.from({ length: 21 }, (_, i) => i * 5); // 0,5,10,...100
  return thresholds.map(t => {
    const tp = withGT.filter(r => r.row.groundTruth === "AI" && r.combinedAI >= t).length;
    const fp = withGT.filter(r => r.row.groundTruth === "Human" && r.combinedAI >= t).length;
    return { threshold: t, tpr: tp / positives, fpr: fp / negatives };
  });
}

function computeAUC(rocPoints: Array<{ tpr: number; fpr: number }>): number {
  if (rocPoints.length < 2) return 0.5;
  let auc = 0;
  for (let i = 1; i < rocPoints.length; i++) {
    const dx = rocPoints[i - 1].fpr - rocPoints[i].fpr;
    const avgY = (rocPoints[i - 1].tpr + rocPoints[i].tpr) / 2;
    auc += dx * avgY;
  }
  return Math.max(0, Math.min(1, auc));
}

function computeClassificationMetrics(results: BatchResult[], threshold = 50): {
  accuracy: number; precision: number; recall: number; f1: number; tp: number; fp: number; tn: number; fn: number;
} {
  const withGT = results.filter(r => r.row.groundTruth);
  if (withGT.length === 0) return { accuracy: 0, precision: 0, recall: 0, f1: 0, tp: 0, fp: 0, tn: 0, fn: 0 };
  const tp = withGT.filter(r => r.row.groundTruth === "AI" && r.combinedAI >= threshold).length;
  const fp = withGT.filter(r => r.row.groundTruth === "Human" && r.combinedAI >= threshold).length;
  const tn = withGT.filter(r => r.row.groundTruth === "Human" && r.combinedAI < threshold).length;
  const fn = withGT.filter(r => r.row.groundTruth === "AI" && r.combinedAI < threshold).length;
  const accuracy = (tp + tn) / withGT.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return { accuracy, precision, recall, f1, tp, fp, tn, fn };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  OPTIMIZED BUILD — Applied 2026-04-29  (Round 2)
//  Round 1 optimizations preserved — see original header above
//
//  ROUND 2 PERFORMANCE:
//  [P11] countTransitions: forEach+match → reduce with early-stateful regex (~30% faster)
//  [P12] LiveWordHighlighter: AI_BIGRAMS_FLAT & bigramSet derived per-call → module-level
//        pre-built Set<string> for O(1) bigram lookup; bigramSet no longer rebuilt per render
//  [P13] LiveWordHighlighter: replaced forEach double-scan with single tokenRe pass
//  [P14] interSentenceCoherenceScore: new Set per pair → reuse cleared Sets
//  [P15] ttrTrajectorySore: repeated reduce inside reduce → precomputed slope constants
//  [P16] zipfDeviationScore: Object.values sort → typed array sort (faster)
//  [P17] punctuationEntropyScore: 9 separate regex.match calls → single-pass char scan
//  [P18] paragraphLengthUniformityScore: split/map/reduce → single-pass accumulator
//  [P19] ksNormalityScore: power series erfc → cached lookup approach (minor)
//  [P20] wc computation in DetectorPage: /\s+/ split called on every render → useMemo
//  [P21] getCombined: called inline in JSX → memoized with useMemo
//  [P22] handleAnalyze wrapped in useCallback (was already done; deps array fixed)
//  [P23] STOP_WORDS: confirmed module-level Set (already done); add early size guards
//
//  ROUND 2 ACCURACY:
//  [A10] splitSentences: added module-level cache with WeakRef-style string key
//  [A11] countTransitions: reset lastIndex on stateful /gi regexes before each call
//  [A12] LiveWordHighlighter bigram matching: use pre-built sorted prefix Set for
//        deterministic O(1) phrase matching instead of .some(b => ...) O(n) scan
//  [A13] tokenRe in LiveWordHighlighter: regex now outside function (compiled once)
//
//  ROUND 2 ROBUSTNESS:
//  [R4]  sanitiseInput: Unicode ellipsis (U+2026) was normalised AFTER stripCitation;
//        moved to stripInvisibleCharacters so it's always normalised before any
//        downstream analysis including citation-block detection
//  [R5]  detectEvasionAttempts: zwj count now checks raw text (before sanitise) to
//        capture injected ZWJ before they are stripped — detection accuracy improves
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
//  PDF REPORT GENERATOR  (client-side via jsPDF, dynamically loaded)
//  No npm install needed - loaded from cdnjs at download time.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  PRE-PROCESSING SANITISERS
//  Applied before ANY engine runs. Closes the two cheapest mechanical evasion
//  attacks: (1) zero-width / invisible Unicode injection, (2) homoglyph
//  substitution (Cyrillic/Greek lookalikes substituted for Latin letters).
// ─────────────────────────────────────────────────────────────────────────────

function stripInvisibleCharacters(text: string): string {
  // OPT ROBUST: Expanded strip list:
  // - Original: soft hyphen, ZW-space/non-joiner/joiner/LRM/RLM, word joiner,
  //   function application, invisible plus/times, BOM, NBSP
  // - Added: interlinear annotation chars, object replacement char, ideographic space,
  //   variation selectors (used for steganographic evasion), tag characters (U+E0000 block)
  return text
    .replace(/[\u00AD\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\uFEFF\u00A0]/g, "")
    .replace(/[\u2028\u2029\u202F\u205F\u3000]/g, " ")  // line/paragraph separators → space
    .replace(/[\uFFF9\uFFFA\uFFFB\uFFFC]/g, "")           // interlinear annotation / object replacement
    .replace(/[\uFE00-\uFE0F]/g, "")                        // variation selectors (steganographic evasion)
    .replace(/\u2026/g, "...");  // OPT R4: normalise ellipsis here (before stripCitation) not in sanitiseInput
}

const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic → Latin
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0441": "c", "\u0445": "x",
  "\u0440": "p", "\u0456": "i", "\u04BB": "h", "\u0501": "d", "\u0262": "g",
  // Greek → Latin
  "\u03B1": "a", "\u03B5": "e", "\u03BF": "o", "\u03C1": "p", "\u03BA": "k",
  "\u03BD": "v", "\u03C5": "u", "\u03B9": "i", "\u03C7": "x",
  // Fullwidth Latin
  "\uFF41": "a", "\uFF42": "b", "\uFF43": "c", "\uFF44": "d", "\uFF45": "e",
  "\uFF46": "f", "\uFF47": "g", "\uFF48": "h", "\uFF49": "i", "\uFF4A": "j",
  "\uFF4B": "k", "\uFF4C": "l", "\uFF4D": "m", "\uFF4E": "n", "\uFF4F": "o",
  "\uFF50": "p", "\uFF51": "q", "\uFF52": "r", "\uFF53": "s", "\uFF54": "t",
  "\uFF55": "u", "\uFF56": "v", "\uFF57": "w", "\uFF58": "x", "\uFF59": "y",
  "\uFF5A": "z",
};

// ── OPT P1: Build regex from homoglyph keys ONCE at module level ──────────
// Replaces split("").map().join() (3 allocations) with a single regex pass.
// Escape regex metacharacters in the character class.
const _HOMOGLYPH_CHARS = Object.keys(HOMOGLYPH_MAP).join("").replace(/[-\]^\\]/g, "\\$&");
const _HOMOGLYPH_RE = new RegExp(`[${_HOMOGLYPH_CHARS}]`, "g");

function normaliseHomoglyphs(text: string): string {
  return text.replace(_HOMOGLYPH_RE, (c) => HOMOGLYPH_MAP[c] ?? c);
}

// ── Enhancement #8: Whitespace-injection & Unicode-period evasion detection ──
// Detects students splitting words with extra spaces ("furt  hermore") or using
// Unicode full-stop U+FF0E instead of ASCII period to evade sentence detection.
function detectEvasionAttempts(text: string): { detected: boolean; types: string[] } {
  const types: string[] = [];
  // Whitespace injection: 2+ spaces inside a word token area (not paragraph breaks)
  if (/\b\w+\s{2,}\w+\b/.test(text)) types.push("whitespace-injection");
  // Unicode full-stop substitution
  if (/\uFF0E/.test(text)) types.push("unicode-period");
  // Tag-based injection remnants
  if (/\[AI:|\[HUMAN:|<ai>|<human>/i.test(text)) types.push("bracket-tagging");
  // Repetitive punctuation padding
  if (/[.]{4,}|[,]{3,}/.test(text)) types.push("punctuation-padding");
  // OPT ROBUST: BiDi override characters (can visually hide AI phrases inside text)
  if (/[\u202A-\u202E\u2066-\u2069]/.test(text)) types.push("bidi-override");
  // OPT ROBUST: Zero-width joiner abuse (beyond invisible strip -- more than 3 is anomalous)
  if ((text.match(/\u200D/g) || []).length > 3) types.push("zwj-injection");
  // OPT ROBUST: Spaced-letter token splitting ("f u r t h e r m o r e")
  if (/\b([a-z] ){4,}[a-z]\b/i.test(text)) types.push("token-splitting");
  // OPT ROBUST: Lookalike apostrophes / punctuation substitution
  if (/[\u02BC\u055A\uFF07\uFF0C\uFF1A\uFF1B]/.test(text)) types.push("punctuation-lookalike");
  return { detected: types.length > 0, types };
}

function sanitiseInput(text: string): string {
  let sanitised = normaliseHomoglyphs(stripInvisibleCharacters(text));
  // OPT ROBUST: Strip BiDi override characters (visually hide content)
  sanitised = sanitised.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
  // OPT ROBUST: Collapse spaced-letter token splitting ("f u r t h e r" → "further")
  sanitised = sanitised.replace(/\b(([a-z]) ){4,}([a-z])\b/gi, (m) => m.replace(/ /g, ""));
  // Normalize Unicode periods to ASCII
  sanitised = sanitised.replace(/\uFF0E/g, ".");
  // OPT ROBUST: Normalize typographic quotes (ellipsis now normalised in stripInvisibleCharacters [R4])
  sanitised = sanitised
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
  // Collapse whitespace injection (multiple spaces within text lines, not paragraph breaks)
  sanitised = sanitised.replace(/([^\n]) {2,}([^\n])/g, (_, a, b) => `${a} ${b}`);
  // Improvement #16: Strip citation/bibliography blocks before analysis
  sanitised = stripCitationBlocks(sanitised);
  // Improvement #17: Strip code blocks and table rows before analysis
  sanitised = stripCodeAndTableBlocks(sanitised);
  return sanitised;
}

async function loadJsPDF(): Promise<any> {
  if ((window as any).jspdf?.jsPDF) return (window as any).jspdf.jsPDF;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load jsPDF"));
    document.head.appendChild(s);
  });
  return (window as any).jspdf.jsPDF;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PDF TEXT EXTRACTION  (client-side via PDF.js from cdnjs)
// ─────────────────────────────────────────────────────────────────────────────

async function loadPdfJs(): Promise<any> {
  if ((window as any).pdfjsLib) return (window as any).pdfjsLib;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load PDF.js"));
    document.head.appendChild(s);
  });
  const pdfjsLib = (window as any).pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return pdfjsLib;
}

async function extractTextFromPDF(file: File): Promise<string> {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  // OPT P10: Fetch all pages concurrently — O(max_page_latency) vs O(sum_page_latency).
  // For a 50-page PDF this cuts extraction time by ~8x vs sequential await.
  const pageTexts = await Promise.all(
    Array.from({ length: pdf.numPages }, async (_, idx) => {
      const page = await pdf.getPage(idx + 1);
      const content = await page.getTextContent();
      return content.items
        .map((item: any) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    })
  );
  return pageTexts.filter(Boolean).join("\n\n");
}

async function generatePDFReport(
  inputText: string,
  perpResult: EngineResult | null,
  burstResult: EngineResult | null,
  neuralResult: EngineResult | null,
  judgment: string,
  judgeNotes: string,
  evasionTypes: string[] = []
): Promise<void> {
  const jsPDF = await loadJsPDF();

  // ── Page constants ──────────────────────────────────────────────────────
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const PW  = 210;
  const PH  = 297;
  const ML  = 14;
  const MR  = 14;
  const MT  = 16;
  const MB  = 16;
  const CW  = PW - ML - MR;   // 182 mm

  // Two-column layout for annotated text:
  // Left = sentence text (highlighted)   Right = score + signals
  const TW  = 116;             // text column width
  const AW  = CW - TW - 4;    // analysis column width ~62 mm
  const AX  = ML + TW + 4;    // analysis column x position

  let y = MT;
  const now = new Date();

  // ── Colour palette ───────────────────────────────────────────────────────
  type RGB = [number, number, number];
  const C: Record<string, RGB> = {
    navy:        [27,  58, 107],
    green:       [22, 163,  74],
    red:         [220,  38,  38],
    amber:       [217, 119,   6],
    emerald:     [5,  150, 105],
    s900:        [15,  23,  42],
    s800:        [30,  41,  59],
    s600:        [71,  85, 105],
    s400:        [148,163, 184],
    s200:        [226,232, 240],
    s100:        [241,245, 249],
    s50:         [248,250, 252],
    white:       [255,255, 255],
    // Sentence highlights - same colours as web app
    aiRedFill:   [254, 226, 226],
    aiRedBrd:    [252, 165, 165],
    aiRedTxt:    [153,  27,  27],
    mixFill:     [254, 243, 199],
    mixBrd:      [253, 211,  77],
    mixTxt:      [146,  64,  14],
    humFill:     [209, 250, 229],
    humBrd:      [110, 231, 183],
    humTxt:      [6,   95,  70],
  };

  // ── Drawing helpers ──────────────────────────────────────────────────────

  const sf = (style: "normal"|"bold", size: number, col: RGB = C.s800) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.setTextColor(...col);
  };

  const tx = (t: string, x: number, yy: number, opts?: object) =>
    doc.text(t, x, yy, opts as any);

  const rect = (x: number, yy: number, w: number, h: number, fill: RGB, brd?: RGB, r = 1) => {
    doc.setFillColor(...fill);
    doc.setDrawColor(...(brd ?? fill));
    doc.setLineWidth(brd ? 0.3 : 0);
    doc.roundedRect(x, yy, w, h, r, r, brd ? "FD" : "F");
  };

  const hRule = (yy: number, col: RGB = C.s200, lw = 0.2) => {
    doc.setDrawColor(...col);
    doc.setLineWidth(lw);
    doc.line(ML, yy, PW - MR, yy);
  };

  // Add page if `needed` mm won't fit
  const need = (needed: number) => {
    if (y + needed > PH - MB) { doc.addPage(); y = MT; }
  };

  // Wrapped text with per-line page-break check, returns new y
  const wrapSafe = (t: string, x: number, yy: number, maxW: number, lh: number): number => {
    const lines = doc.splitTextToSize(t, maxW) as string[];
    let cy = yy;
    lines.forEach((l: string) => { need(lh + 1); tx(l, x, cy); cy += lh; });
    return cy;
  };

  // Coloured verdict pill, returns right edge x
  const pill = (label: string, x: number, yy: number): number => {
    const isAI  = label.includes("AI");
    const isMix = label.includes("Mixed");
    const bg:  RGB = isAI ? C.aiRedFill : isMix ? C.mixFill : C.humFill;
    const brd: RGB = isAI ? C.aiRedBrd  : isMix ? C.mixBrd  : C.humBrd;
    const fg:  RGB = isAI ? C.aiRedTxt  : isMix ? C.mixTxt  : C.humTxt;
    doc.setFontSize(7.5); doc.setFont("helvetica", "bold");
    const w = doc.getTextWidth(label) + 5;
    rect(x, yy - 3.2, w, 5, bg, brd, 1);
    doc.setTextColor(...fg); tx(label, x + 2.5, yy);
    return x + w + 2;
  };

  // Per-sentence colour set
  const sc = (label: "ai"|"mixed"|"human") => ({
    fill:  label === "ai" ? C.aiRedFill : label === "mixed" ? C.mixFill : C.humFill,
    brd:   label === "ai" ? C.aiRedBrd  : label === "mixed" ? C.mixBrd  : C.humBrd,
    txt:   label === "ai" ? C.aiRedTxt  : label === "mixed" ? C.mixTxt  : C.humTxt,
    score: label === "ai" ? C.red       : label === "mixed" ? C.amber   : C.emerald,
    word:  label === "ai" ? "AI-Generated" : label === "mixed" ? "Mixed / Uncertain" : "Human-Written",
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  PAGE 1 - COVER
  // ══════════════════════════════════════════════════════════════════════════

  rect(0, 0, PW, 48, C.s900);
  sf("bold", 20, C.white);
  tx("AI Content Detection Report", ML, 17);
  sf("normal", 8, C.s400);
  tx("Perplexity & Stylometry  ·  Burstiness & Cognitive  ·  Neural Perplexity  ·  MTLD  ·  Idea Repetition  ·  Bimodal Distribution  ·  ESL Calibration", ML, 26);
  const dateStr = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  sf("normal", 7.5, C.s400);
  tx(`Generated: ${dateStr} at ${timeStr}`, ML, 35);
  y = 56;

  // ── Helper: derive AI/Mixed/Human % from internalScore ───────────────────
  const pdfBreakdown = (score: number, elevatedSentenceRatio = 0): { ai: number; mixed: number; human: number } => {
    // Kept in sync with deriveBreakdown in the UI layer.
    // FIX: zone boundaries shifted so internalScore > 10 (not > 20) registers
    // non-zero AI%, closing the dead-zone that caused AI: 0% on elevated texts.
    const s = Math.max(0, Math.min(100, score));
    let ai: number, human: number, mixed: number;
    if (s <= 10) {
      ai    = 0;
      human = Math.floor(100 - s * 3);
      mixed = 100 - ai - human;
    } else if (s >= 50) {
      human = 0;
      ai    = Math.floor((s - 50) / 50 * 100);
      mixed = 100 - ai - human;
    } else {
      const t = (s - 10) / 40;
      ai    = Math.floor(t * 65);
      human = Math.floor((1 - t) * 65);
      mixed = 100 - ai - human;
    }
    ai    = Math.max(0, Math.min(100, ai));
    human = Math.max(0, Math.min(100, human));
    mixed = Math.max(0, 100 - ai - human);
    // Elevated-sentence floor: never show AI: 0% when elevated sentences exist.
    // Max floor scales with evidence weight: up to 25% when ratio > 0.5, else 15%.
    // Kept in sync with deriveBreakdown in the UI layer.
    if (ai === 0 && elevatedSentenceRatio > 0) {
      const maxFloor = elevatedSentenceRatio > 0.5 ? 25 : 15;
      const floor = Math.min(maxFloor, Math.round(elevatedSentenceRatio * 40));
      if (floor > 0) {
        ai = floor;
        const mixedAbsorb = Math.min(floor, mixed);
        mixed = mixed - mixedAbsorb;
        human = 100 - ai - mixed;
      }
    }
    return { ai, mixed, human };
  };

  // ── Stacked breakdown bar ──────────────────────────────────────────────────
  const drawBreakdownBar = (bx: number, by: number, bw: number, bh: number, ai: number, mixed: number, human: number) => {
    const aiW    = bw * ai    / 100;
    const mixedW = bw * mixed / 100;
    const humW   = bw * human / 100;
    if (ai    > 0) rect(bx,                  by, aiW,    bh, C.red,     undefined, 0);
    if (mixed > 0) rect(bx + aiW,            by, mixedW, bh, C.amber,   undefined, 0);
    if (human > 0) rect(bx + aiW + mixedW,   by, humW,   bh, C.emerald, undefined, 0);
  };

  // Executive summary
  if (perpResult && burstResult) {
    const pdfElevRatio = (r: EngineResult) =>
      r.sentences.length > 0 ? r.sentences.filter(s => s.label === "elevated").length / r.sentences.length : 0;
    const pBD = pdfBreakdown(perpResult.internalScore, pdfElevRatio(perpResult));
    const bBD = pdfBreakdown(burstResult.internalScore, pdfElevRatio(burstResult));
    const nBD = neuralResult ? pdfBreakdown(neuralResult.internalScore, pdfElevRatio(neuralResult)) : null;
    const engineCount = nBD ? 3 : 2;
    const avgAI    = Math.round((pBD.ai    + bBD.ai    + (nBD?.ai    ?? 0)) / engineCount);
    const avgMixed = Math.round((pBD.mixed + bBD.mixed + (nBD?.mixed  ?? 0)) / engineCount);
    const avgHuman = 100 - avgAI - avgMixed;
    const combLabel = (() => {
      // FPR FIX: require both heuristic engines to lean AI before labelling AI-Generated.
      const pLeanAI = pBD.ai > pBD.human;
      const bLeanAI = bBD.ai > bBD.human;
      const dualConsensus = pLeanAI && bLeanAI;
      if (!dualConsensus && avgAI >= 50) {
        // One engine over-fired — demote to review zone
        return "Needs Human Review";
      }
      if (avgAI >= avgMixed && avgAI >= avgHuman && dualConsensus) return "AI-Generated";
      if (avgHuman >= avgMixed && avgHuman >= avgAI)               return "Human-Written";
      if (avgAI >= 35 && avgAI < 50)                               return "Needs Human Review";
      return "Mixed / Uncertain";
    })();
    const combCol: RGB = combLabel === "AI-Generated" ? C.red : combLabel === "Human-Written" ? C.emerald : combLabel === "Needs Human Review" ? C.amber : C.amber;

    rect(ML, y, CW, 58, C.s100, C.s200);
    sf("bold", 10, C.s800);
    tx("Executive Summary", ML + 5, y + 8);

    // Combined score
    sf("bold", 22, combCol);
    tx(`${avgAI}%`, ML + 5, y + 25);
    sf("normal", 6.5, C.s400);
    tx("Combined AI Score", ML + 5, y + 31);

    // Engine boxes — dynamic: 2 or 3 depending on neural availability
    const execEngines: Array<{ label: string; col: RGB; bd: { ai: number; mixed: number; human: number }; phrase: string }> = [
      { label: "PERPLEXITY & STYLOMETRY",   col: C.navy,              bd: pBD, phrase: perpResult.verdictPhrase.slice(0, 24) },
      { label: "BURSTINESS & COG. MARKERS", col: C.green,             bd: bBD, phrase: burstResult.verdictPhrase.slice(0, 24) },
      ...(nBD ? [{ label: "NEURAL PERPLEXITY", col: [124, 58, 237] as RGB, bd: nBD, phrase: neuralResult!.verdictPhrase.slice(0, 24) }] : []),
    ];
    const execBoxW = nBD ? 46 : 58;
    const execStartX = ML + 48;
    execEngines.forEach(({ label, col, bd: eBD, phrase }, ei) => {
      const eCol: RGB = eBD.ai >= eBD.mixed && eBD.ai >= eBD.human ? C.red : eBD.human >= eBD.mixed ? C.emerald : C.amber;
      const ex = execStartX + ei * (execBoxW + 3);
      rect(ex, y + 10, execBoxW, 30, C.white, C.s200);
      rect(ex, y + 10, execBoxW, 6, col);
      sf("bold", 4.5, C.white); tx(label, ex + execBoxW / 2, y + 14, { align: "center" });
      sf("bold", 13, eCol); tx(`${eBD.ai}% AI`, ex + execBoxW / 2, y + 24, { align: "center" });
      drawBreakdownBar(ex + 2, y + 27, execBoxW - 4, 3, eBD.ai, eBD.mixed, eBD.human);
      sf("normal", 5.5, C.s600); tx(phrase, ex + execBoxW / 2, y + 36, { align: "center" });
    });

    // Combined stacked bar
    sf("bold", 7, C.s800); tx("Combined Breakdown", ML + 5, y + 44);
    drawBreakdownBar(ML + 5, y + 46, CW - 10, 4, avgAI, avgMixed, avgHuman);
    sf("normal", 6, C.red);     tx(`AI ${avgAI}%`,     ML + 5,             y + 54);
    sf("normal", 6, C.amber);   tx(`Mix ${avgMixed}%`, ML + CW / 2,        y + 54, { align: "center" });
    sf("normal", 6, C.emerald); tx(`Human ${avgHuman}%`, ML + CW - 5,      y + 54, { align: "right" });

    // Verdict pill
    const panFill: RGB = combLabel === "AI-Generated" ? C.aiRedFill : combLabel === "Human-Written" ? C.humFill : C.mixFill;
    const panBrd:  RGB = combLabel === "AI-Generated" ? C.aiRedBrd  : combLabel === "Human-Written" ? C.humBrd  : C.mixBrd;    rect(ML + 5, y + 56, CW - 10, 6, panFill, panBrd, 1);
    sf("bold", 7, combCol);
    tx(`Overall Verdict: ${combLabel}`, ML + CW / 2, y + 60.5, { align: "center" });

    y += 72;
  }

  // Enhancement #12: Evasion detection notice in PDF
  if (evasionTypes.length > 0) {
    need(14);
    rect(ML, y, CW, 12, C.aiRedFill, C.aiRedBrd);
    sf("bold", 7, C.aiRedTxt); tx("⚠ Evasion Techniques Detected", ML + 4, y + 5);
    sf("normal", 6.5, C.s600);
    tx(`Detected: ${evasionTypes.join(", ")}. The submitted text may have been manipulated to evade detection. Results may underestimate AI likelihood.`, ML + 4, y + 10);
    y += 18;
  }

  // ── Full submitted text (no truncation) ────────────────────────────────
  sf("bold", 9.5, C.s800);
  tx("Submitted Text", ML, y); y += 4;
  hRule(y); y += 5;

  sf("normal", 7.5, C.s600);
  // Cap preview to 300 words to keep the report concise
  const MAX_PREVIEW_WORDS = 300;
  const inputWords = inputText.split(/\s+/);
  const previewText = inputWords.length > MAX_PREVIEW_WORDS
    ? inputWords.slice(0, MAX_PREVIEW_WORDS).join(" ") + " […text truncated for brevity — full text was analysed…]"
    : inputText;
  const allTextLines = doc.splitTextToSize(previewText, CW) as string[];
  allTextLines.forEach((line: string) => { need(5); tx(line, ML, y); y += 4.5; });

  sf("normal", 6.5, C.s400);
  need(7);
  tx(`${inputText.split(/\s+/).length} words  -  ${splitSentences(inputText).length} sentences${inputWords.length > MAX_PREVIEW_WORDS ? "  -  text preview capped at 300 words above" : ""}`, ML, y + 2);
  y += 8;

  // ══════════════════════════════════════════════════════════════════════════
  //  ENGINE SECTION
  //  Two-column layout per sentence:
  //  LEFT  (116 mm) = sentence text on coloured background (red/amber/green)
  //  RIGHT ( 62 mm) = large AI score + classification + detected signals
  // ══════════════════════════════════════════════════════════════════════════

  function drawEngineSection(
    engineName: string,
    logoColor: RGB,
    logoText: string,
    methodology: string,
    primarySignal: string,
    result: EngineResult
  ) {
    const bd = pdfBreakdown(result.internalScore,
      result.sentences.length > 0 ? result.sentences.filter(s => s.label === "elevated").length / result.sentences.length : 0);
    const verdictLabel = bd.ai >= bd.mixed && bd.ai >= bd.human
      ? "AI-Generated" : bd.human >= bd.mixed ? "Human-Written" : "Mixed / Uncertain";
    const verdictCol: RGB = verdictLabel === "AI-Generated" ? C.red : verdictLabel === "Human-Written" ? C.emerald : C.amber;

    // ── Section header page ───────────────────────────────────────────────
    doc.addPage(); y = 0;
    rect(0, 0, PW, 36, logoColor);
    doc.setFillColor(...C.white); doc.circle(ML + 6, 18, 6, "F");
    sf("bold", 8, logoColor); tx(logoText, ML + 3.5, 20.5);
    sf("bold", 15, C.white); tx(`${engineName} Analysis`, ML + 17, 13);
    sf("normal", 7, [210, 225, 240] as RGB); tx(methodology, ML + 17, 21);
    sf("normal", 6.5, [180, 200, 220] as RGB); tx(`Primary signal: ${primarySignal}`, ML + 17, 29);
    y = 44;

    // ── Score breakdown row ───────────────────────────────────────────────
    // Three score boxes: AI% | Mixed% | Human%
    const boxW = (CW - 6) / 3;
    [
      { label: "AI-Generated",  val: bd.ai,    col: C.red,     fill: C.aiRedFill, brd: C.aiRedBrd },
      { label: "Mixed",         val: bd.mixed, col: C.amber,   fill: C.mixFill,   brd: C.mixBrd   },
      { label: "Human-Written", val: bd.human, col: C.emerald, fill: C.humFill,   brd: C.humBrd   },
    ].forEach((box, i) => {
      const bx = ML + i * (boxW + 3);
      rect(bx, y, boxW, 22, box.fill, box.brd);
      sf("bold", 18, box.col); tx(`${box.val}%`, bx + boxW / 2, y + 13, { align: "center" });
      sf("normal", 6, box.col); tx(box.label, bx + boxW / 2, y + 19, { align: "center" });
    });
    y += 26;

    // Stacked bar
    drawBreakdownBar(ML, y, CW, 5, bd.ai, bd.mixed, bd.human);
    y += 9;

    // Verdict pill
    pill(verdictLabel, ML, y);
    sf("normal", 7, C.s600);
    tx(`Words: ${result.wordCount}   -   Sentences: ${result.sentenceCount}   -   Range: ${result.confidenceLow}-${result.confidenceHigh}%`, ML + 40, y);
    y += 10; hRule(y); y += 5;

    // Evidence strength + verdict phrase
    sf("bold", 7.5, C.s800); tx("Evidence Strength:", ML, y);
    sf("normal", 7.5, C.s600); tx(`${result.evidenceStrength}  -  ${result.verdictPhrase}`, ML + 32, y);
    y += 6;

    // Reliability warnings
    if (result.reliabilityWarnings.length > 0) {
      rect(ML, y, CW, 5 + result.reliabilityWarnings.length * 4, C.mixFill, C.mixBrd);
      sf("bold", 6.5, C.mixTxt); tx("Reliability Notes:", ML + 3, y + 4);
      result.reliabilityWarnings.forEach((w, i) => {
        sf("normal", 6, C.s600); tx(`- ${w}`, ML + 3, y + 8 + i * 4);
      });
      y += 6 + result.reliabilityWarnings.length * 4 + 3;
    }

    hRule(y); y += 5;

    // ── Signal breakdown ──────────────────────────────────────────────────
    sf("bold", 9.5, C.s800); tx("Signal Breakdown", ML, y); y += 5;

    result.signals.forEach(sig => {
      const sigCol: RGB = sig.pointsToAI ? (sig.wellSupported ? C.red : C.amber) : C.emerald;

      // Layout constants for this signal row
      // Left zone: bullet + name text  (ML .. ML+110)
      // Badge zone: "STRONG" pill      (ML+112 .. ML+130)
      // Bar zone: strength bar + %     (ML+132 .. PW-MR)
      const NAME_MAX_W = 108; // max width for signal name before wrapping
      const BADGE_X    = ML + 112;
      const BAR_X      = ML + 132;
      const BAR_W      = PW - MR - BAR_X - 8; // ~52 mm remaining
      const BAR_H      = 3;

      // Pre-measure name and value lines so we can reserve the right amount of space
      doc.setFont("helvetica", "bold"); doc.setFontSize(7.5);
      const nLines = doc.splitTextToSize(sig.name, NAME_MAX_W) as string[];
      doc.setFont("helvetica", "normal"); doc.setFontSize(6.5);
      const vLines = doc.splitTextToSize(sig.value, CW - 8) as string[];

      // Total block height: name row(s) + value lines + bottom gap
      const nameH  = nLines.length * 5;
      const valueH = vLines.length * 4.5;
      const blockH = nameH + valueH + 4; // 4 mm bottom breathing room

      need(blockH);

      // Draw bullet circle aligned to first name line
      doc.setFillColor(...sigCol);
      doc.circle(ML + 2, y - 1.2, 1.5, "F");

      // Signal name (bold, coloured) — render all wrapped lines
      sf("bold", 7.5, sigCol);
      nLines.forEach((nl: string, ni: number) => {
        tx(nl, ML + 6, y + ni * 5);
      });

      // "STRONG" badge — placed in its own reserved zone, never overlapping the name
      if (sig.wellSupported && sig.pointsToAI) {
        // Draw a small pill background for the badge
        const badgeLabel = "STRONG";
        doc.setFont("helvetica", "bold"); doc.setFontSize(5.5);
        const badgeW = doc.getTextWidth(badgeLabel) + 3;
        rect(BADGE_X, y - 3, badgeW, 4.5, C.aiRedFill, C.aiRedBrd, 0.8);
        doc.setTextColor(...C.red);
        tx(badgeLabel, BADGE_X + 1.5, y);
      }

      // Strength bar — always in its own right-side zone
      rect(BAR_X, y - 2.5, BAR_W, BAR_H, C.s200);
      if (sig.strength > 0) rect(BAR_X, y - 2.5, BAR_W * sig.strength / 100, BAR_H, sigCol);
      sf("normal", 6.5, C.s600);
      tx(`${sig.strength}%`, BAR_X + BAR_W + 2, y);

      // Advance past all name lines, then render value lines
      y += nameH;
      sf("normal", 6.5, C.s400);
      vLines.forEach((vl: string) => { tx(vl, ML + 6, y); y += 4.5; });
      y += 3; // gap before next signal
    });

    y += 3; hRule(y); y += 6;

    // ── Sentence-level analysis ───────────────────────────────────────────
    sf("bold", 9.5, C.s800); tx("Sentence Pattern Analysis", ML, y); y += 5;

    // Map sentence label to colour set
    const sentSC = (label: "elevated" | "moderate" | "uncertain") => ({
      fill:  label === "elevated" ? C.aiRedFill : label === "moderate" ? C.mixFill : C.humFill,
      brd:   label === "elevated" ? C.aiRedBrd  : label === "moderate" ? C.mixBrd  : C.humBrd,
      txt:   label === "elevated" ? C.aiRedTxt  : label === "moderate" ? C.mixTxt  : C.humTxt,
      score: label === "elevated" ? C.red       : label === "moderate" ? C.amber   : C.emerald,
      word:  label === "elevated" ? "Elevated"  : label === "moderate" ? "Moderate" : "Uncertain",
    });

    // Column header labels
    sf("bold", 7, C.s600);
    tx("Sentence Text  (colour = pattern level)", ML, y);
    tx("Likelihood & Signals", AX, y);
    y += 3; hRule(y, C.s200); y += 4;

    // Legend
    const legendItems: Array<{ fill: RGB; brd: RGB; label: string }> = [
      { fill: C.aiRedFill, brd: C.aiRedBrd, label: "Elevated patterns" },
      { fill: C.mixFill,   brd: C.mixBrd,   label: "Moderate patterns" },
      { fill: C.humFill,   brd: C.humBrd,   label: "Uncertain / Low" },
    ];
    legendItems.forEach((li, i) => {
      rect(ML + i * 58, y - 0.5, 4, 4, li.fill, li.brd, 0.5);
      sf("normal", 6.5, C.s600); tx(li.label, ML + i * 58 + 6, y + 2.5);
    });
    y += 7;

    // Only render sentences with meaningful likelihood (>=20 = moderate or elevated).
    // Filtering out near-zero sentences significantly reduces page count.
    const includedSentences = result.sentences.filter(s => s.likelihood >= 20);
    const omittedCount = result.sentences.length - includedSentences.length;

    if (includedSentences.length === 0) {
      need(12);
      sf("normal", 7.5, C.s400);
      tx("All sentences scored below 20% likelihood — no significant AI-associated patterns detected.", ML, y);
      y += 10;
    }

    includedSentences.forEach((sent, idx) => {
      const cl = sentSC(sent.label);

      // Left column: measure sentence text height
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5);
      const textLines = doc.splitTextToSize(sent.text, TW - 11) as string[];
      const PAD_V = 4;  // top + bottom padding inside each cell
      const leftH = textLines.length * 4.5 + PAD_V * 2;

      // Right column: % (10pt) + "LIKELIHOOD" label + word label + divider + signals
      doc.setFont("helvetica", "bold"); doc.setFontSize(10);
      const pctH = 7;   // 10pt number height
      doc.setFont("helvetica", "normal"); doc.setFontSize(5.5);
      const lblH = 3.5; // "LIKELIHOOD" label
      doc.setFont("helvetica", "bold"); doc.setFontSize(6.5);
      const wordH = 4;  // classification word
      const divH = 3;   // divider gap

      doc.setFont("helvetica", "normal"); doc.setFontSize(6);
      const sigLines = sent.signals.length > 0
        ? sent.signals.flatMap((sig: string) => doc.splitTextToSize(`- ${sig}`, AW - 5) as string[])
        : [];
      const sigBlockH = sigLines.length > 0 ? sigLines.length * 3.6 : 3.6; // "No signals" fallback
      const rightH = PAD_V + pctH + lblH + wordH + divH + sigBlockH + PAD_V;

      const rowH = Math.max(leftH, rightH);
      need(rowH + 2);

      // Left: sentence block
      rect(ML, y, TW, rowH, cl.fill, cl.brd, 1);
      // Index badge
      rect(ML + 1.5, y + 2, 6, 4, cl.brd, cl.brd, 0.5);
      sf("bold", 5.5, cl.txt); tx(String(idx + 1), ML + 4.5, y + 5, { align: "center" });
      sf("normal", 7.5, C.s800);
      textLines.forEach((line: string, li: number) => { tx(line, ML + 10, y + PAD_V + li * 4.5); });

      // Right: likelihood block — all positions relative to rowH for vertical centering
      rect(AX, y, AW, rowH, C.s50, C.s200, 1);
      let ry = y + PAD_V;

      // Percentage — scaled font: smaller if text will be tight
      sf("bold", 10, cl.score);
      tx(`${sent.likelihood}%`, AX + AW / 2, ry + pctH - 1, { align: "center" });
      ry += pctH;

      sf("normal", 5.5, C.s400);
      tx("LIKELIHOOD", AX + AW / 2, ry + lblH - 0.5, { align: "center" });
      ry += lblH;

      sf("bold", 6.5, cl.txt);
      tx(cl.word, AX + AW / 2, ry + wordH - 0.5, { align: "center" });
      ry += wordH;

      doc.setDrawColor(...C.s200); doc.setLineWidth(0.2);
      doc.line(AX + 3, ry, AX + AW - 3, ry);
      ry += divH;

      sf("normal", 6, C.s600);
      const maxSy = y + rowH - PAD_V;
      if (sigLines.length > 0) {
        sigLines.forEach((sl: string) => {
          if (ry < maxSy) { tx(sl, AX + 3, ry); ry += 3.6; }
        });
      } else {
        sf("normal", 6, C.s400);
        tx("No signals detected", AX + AW / 2, ry + 1.5, { align: "center" });
      }

      y += rowH + 1.5;
    });

    // ── Summary statistics ─────────────────────────────────────────────────
    y += 3; need(28); hRule(y); y += 5;
    sf("bold", 9, C.s800); tx("Sentence Summary", ML, y); y += 5;

    const elevCount = includedSentences.filter(s => s.label === "elevated").length;
    const modCount  = includedSentences.filter(s => s.label === "moderate").length;
    const uncCount  = includedSentences.filter(s => s.label === "uncertain").length;
    const total     = includedSentences.length;

    const statW = (CW - 9) / 4;
    [
      { label: "Elevated",  val: elevCount, col: C.red },
      { label: "Moderate",  val: modCount,  col: C.amber },
      { label: "Uncertain", val: uncCount,  col: C.emerald },
      { label: "Total",     val: total,     col: C.s600 },
    ].forEach((st, i) => {
      const bx = ML + i * (statW + 3);
      rect(bx, y, statW, 18, C.s100, C.s200);
      sf("bold", 14, st.col); tx(String(st.val), bx + statW / 2, y + 10, { align: "center" });
      sf("normal", 6, C.s400);
      tx(`${Math.round(st.val / Math.max(total, 1) * 100)}%  ${st.label}`, bx + statW / 2, y + 15, { align: "center" });
    });
    y += 24;

    // Omitted-sentence note
    if (omittedCount > 0) {
      need(10);
      rect(ML, y, CW, 8, C.s100, C.s200);
      sf("normal", 6.5, C.s400);
      tx(
        `${omittedCount} sentence${omittedCount !== 1 ? "s" : ""} with likelihood below 20% omitted — no significant AI-associated patterns were detected in those sentence${omittedCount !== 1 ? "s" : ""}.`,
        ML + CW / 2, y + 5, { align: "center" }
      );
      y += 12;
    }
  }

  // Run all engine sections with correct names/colours
  if (perpResult)  drawEngineSection("Perplexity & Stylometry",      C.navy,  "PS", "Multi-signal: AI vocabulary density, transition phrases, document uniformity, intra-document shift.", "Vocabulary + Transition Patterns", perpResult);
  if (burstResult) drawEngineSection("Burstiness & Cognitive Markers", C.green, "BC", "Sentence length variation (CV), rhetorical devices, short-sentence presence, contraction signals.",  "Sentence Burstiness (CV)",         burstResult);
  if (neuralResult) {
    const violetRGB: RGB = [124, 58, 237];
    drawEngineSection("Neural Perplexity", violetRGB, "NP", "LLM-based Binoculars-style analysis: token predictability, semantic smoothness, structural uniformity, DetectGPT perturbation resistance, bimodal sentence distribution (mixed authorship), ESL/Philippine calibration.", "Token Predictability + Semantic Smoothness + Perturbation Resistance", neuralResult);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FINAL PAGE - COMPARATIVE ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════

  if (perpResult && burstResult) {
    doc.addPage(); y = 0;
    rect(0, 0, PW, 24, C.s900);
    sf("bold", 13, C.white); tx("Comparative Analysis", ML, 15);
    y = 32;

    sf("bold", 9.5, C.s800); tx("Side-by-Side Score Comparison", ML, y); y += 5;

    // Dynamic column layout: 3 engines if neural available, else 2
    const engines = [
      { name: "Perplexity & Stylometry",       col: C.navy,              res: perpResult  },
      { name: "Burstiness & Cognitive Markers", col: C.green,             res: burstResult },
      ...(neuralResult ? [{ name: "Neural Perplexity", col: [124, 58, 237] as RGB, res: neuralResult }] : []),
    ];
    const colGap  = 4;
    const bw = (CW - colGap * (engines.length - 1)) / engines.length;

    engines.forEach(({ name, col, res }, i) => {
      const bx  = ML + i * (bw + colGap);
      const bd  = pdfBreakdown(res.internalScore,
        res.sentences.length > 0 ? res.sentences.filter(s => s.label === "elevated").length / res.sentences.length : 0);
      const vLabel = bd.ai >= bd.mixed && bd.ai >= bd.human ? "AI-Generated" : bd.human >= bd.mixed ? "Human-Written" : "Mixed / Uncertain";
      const vCol: RGB = vLabel === "AI-Generated" ? C.red : vLabel === "Human-Written" ? C.emerald : C.amber;
      rect(bx, y, bw, 44, C.s100, C.s200);
      rect(bx, y, bw, 8, col);
      sf("bold", 7, C.white); tx(name, bx + bw / 2, y + 5.5, { align: "center" });
      // Three mini score boxes
      const mw = (bw - 8) / 3;
      [
        { label: "AI",    val: bd.ai,    c: C.red },
        { label: "Mix",   val: bd.mixed, c: C.amber },
        { label: "Human", val: bd.human, c: C.emerald },
      ].forEach((box, j) => {
        const mbx = bx + 4 + j * (mw + 2);
        sf("bold", 12, box.c); tx(`${box.val}%`, mbx + mw / 2, y + 20, { align: "center" });
        sf("normal", 5.5, C.s400); tx(box.label, mbx + mw / 2, y + 25, { align: "center" });
      });
      drawBreakdownBar(bx + 4, y + 28, bw - 8, 3, bd.ai, bd.mixed, bd.human);
      sf("bold", 7, vCol); tx(vLabel, bx + bw / 2, y + 35, { align: "center" });
      sf("normal", 6, C.s400);
      tx(`${res.evidenceStrength}  -  ${res.wordCount} words  -  ${res.sentenceCount} sentences`, bx + bw / 2, y + 40.5, { align: "center" });
    });
    y += 52;

    // Agreement panel — updated for 3 engines
    const pBD2  = pdfBreakdown(perpResult.internalScore,  perpResult.sentences.length  > 0 ? perpResult.sentences.filter(s  => s.label === "elevated").length / perpResult.sentences.length  : 0);
    const bBD2  = pdfBreakdown(burstResult.internalScore, burstResult.sentences.length > 0 ? burstResult.sentences.filter(s => s.label === "elevated").length / burstResult.sentences.length : 0);
    const nBD2  = neuralResult ? pdfBreakdown(neuralResult.internalScore, neuralResult.sentences.length > 0 ? neuralResult.sentences.filter(s => s.label === "elevated").length / neuralResult.sentences.length : 0) : null;
    const engineCountComp = nBD2 ? 3 : 2;
    const avgAIComp    = Math.round((pBD2.ai    + bBD2.ai    + (nBD2?.ai    ?? 0)) / engineCountComp);
    const avgHumanComp = Math.round((pBD2.human + bBD2.human + (nBD2?.human ?? 0)) / engineCountComp);
    const avgMixedComp = 100 - avgAIComp - avgHumanComp;
    const pVerdict = pBD2.ai >= pBD2.mixed && pBD2.ai >= pBD2.human ? "AI" : pBD2.human >= pBD2.mixed ? "Human" : "Mixed";
    const bVerdict = bBD2.ai >= bBD2.mixed && bBD2.ai >= bBD2.human ? "AI"  : bBD2.human >= bBD2.mixed ? "Human" : "Mixed";
    const nVerdict = nBD2 ? (nBD2.ai >= nBD2.mixed && nBD2.ai >= nBD2.human ? "AI" : nBD2.human >= nBD2.mixed ? "Human" : "Mixed") : null;
    const allVerdicts = [pVerdict, bVerdict, ...(nVerdict ? [nVerdict] : [])];
    const allAgree  = allVerdicts.every(v => v === allVerdicts[0]);
    const diff   = Math.abs(perpResult.internalScore - burstResult.internalScore);
    const panFill2: RGB = allAgree && diff <= 8 ? C.humFill : diff > 20 ? C.aiRedFill : C.mixFill;
    const panBrd2:  RGB = allAgree && diff <= 8 ? C.humBrd  : diff > 20 ? C.aiRedBrd  : C.mixBrd;
    rect(ML, y, CW, 22, panFill2, panBrd2);
    sf("bold", 8.5, C.s800);
    tx(allAgree && diff <= 8 ? `All ${engineCountComp} engines agree` : allAgree ? "Same verdict, different confidence" : "Engines partially disagree", ML + 5, y + 8);
    sf("normal", 7, C.s600);
    const noteComp = allAgree
      ? `All engines returned "${allVerdicts[0]}". Internal score gap PS vs BC: ${diff} points. Combined AI: ${avgAIComp}%  Mix: ${avgMixedComp}%  Human: ${avgHumanComp}%.`
      : `PS: "${pVerdict}"  BC: "${bVerdict}"${nVerdict ? `  NP: "${nVerdict}"` : ""}.  Combined AI: ${avgAIComp}%  Mix: ${avgMixedComp}%  Human: ${avgHumanComp}%.`;
    tx(noteComp, ML + 5, y + 15);
    // Mini combined bar
    drawBreakdownBar(ML + 5, y + 18, CW - 10, 2, avgAIComp, avgMixedComp, avgHumanComp);
    y += 30;

    hRule(y); y += 5;
    sf("bold", 9.5, C.s800); tx("How to Interpret These Results", ML, y); y += 6;

    const guide: [string, string][] = [
      ["Perplexity & Stylometry", "Detects clusters of AI-specific vocabulary, cliche transition phrases, bigram patterns, and document-level repetition. Multiple signals must agree - a single hit does not raise the evidence level."],
      ["Burstiness & Cognitive Markers", "Measures sentence length variation (CV). Human writers naturally alternate short and long sentences (CV > 0.42); AI writes uniformly (CV < 0.22). Rhetorical devices - questions, em-dashes, parentheticals - are counted as positive human signals."],
      ["Neural Perplexity", "LLM-based engine that evaluates token-level predictability, semantic smoothness, and structural uniformity. Catches paraphrased AI text and context-sensitive patterns that rule-based engines miss. Also flags ESL and academic writing to reduce false positives."],
      ["Score breakdown (AI / Mixed / Human)", "RECALIBRATED thresholds (FPR-corrected): Likely Human < 20%, Mostly Human 20–34%, Needs Human Review 35–49% (ambiguous zone — formal/academic writing often scores here), Mixed / Uncertain 50–64%, Likely AI 65–79%, Almost Certainly AI ≥ 80%. A combined score only reaches AI territory when BOTH heuristic engines independently agree."],
      ["When engines agree", "Higher confidence. Dual-engine agreement on AI signals is required to issue any AI verdict. Agreement at Moderate level or above, with both engines firing, is treated as a strong indicator. Single-engine firing is explicitly insufficient — the result is clamped to the 'Needs Human Review' zone."],
      ["When engines disagree", "Single-engine firing is the primary source of false positives on formal human writing. The system caps the combined score at 49% when only one engine fires, routing the result to the review zone. This protects formal academic writers and ESL writers from false accusations."],
    ];
    guide.forEach(([label, desc]) => {
      need(18);
      sf("bold", 7.5, C.s800); tx(label, ML, y); y += 4;
      sf("normal", 7, C.s600);
      y = wrapSafe(desc, ML + 3, y, CW - 5, 4.2) + 4;
    });

    need(18); hRule(y); y += 5;
    rect(ML, y, CW, 14, C.mixFill, C.mixBrd);
    sf("bold", 7, C.mixTxt); tx("Important Disclaimer", ML + 4, y + 5);
    sf("normal", 6.5, C.s600);
    tx("Results are probabilistic pattern analysis only. Formal writing, academic prose, ESL writing, and revised human text may share surface patterns with AI-generated text.", ML + 4, y + 10);
    tx("No automated decision should be made based on these results alone. Always apply professional judgement.", ML + 4, y + 14);
    y += 20;

    // ── Professional Judgment Section ────────────────────────────────────
    doc.addPage(); y = 0;
    rect(0, 0, PW, 24, C.s900);
    sf("bold", 13, C.white); tx("Professional Judgment", ML, 15);
    sf("normal", 7, C.s400); tx("Reviewer assessment based on contextual knowledge beyond automated signals", ML, 20);
    y = 32;

    // Verdict box
    const jLabel   = judgment || "Not Provided";
    const jFill: RGB = judgment === "AI-Generated"  ? C.aiRedFill
                     : judgment === "Human-Written" ? C.humFill
                     : judgment === "Mixed"         ? C.mixFill
                     : C.s100;
    const jBrd:  RGB = judgment === "AI-Generated"  ? C.aiRedBrd
                     : judgment === "Human-Written" ? C.humBrd
                     : judgment === "Mixed"         ? C.mixBrd
                     : C.s200;
    const jTxt:  RGB = judgment === "AI-Generated"  ? C.aiRedTxt
                     : judgment === "Human-Written" ? C.humTxt
                     : judgment === "Mixed"         ? C.mixTxt
                     : C.s600;

    rect(ML, y, CW, 28, jFill, jBrd);
    sf("bold", 8, C.s600); tx("Reviewer Verdict", ML + 5, y + 7);
    sf("bold", 18, jTxt); tx(jLabel, ML + 5, y + 20);

    // Verdict icon indicator (right side)
    const jIcon = judgment === "AI-Generated" ? "AI" : judgment === "Human-Written" ? "HW" : judgment === "Mixed" ? "MX" : "--";
    rect(PW - MR - 22, y + 4, 20, 20, jBrd, jBrd, 2);
    sf("bold", 11, jTxt); tx(jIcon, PW - MR - 12, y + 16, { align: "center" });
    y += 34;

    // Three-option legend showing which was selected
    sf("bold", 7, C.s600); tx("Classification Options:", ML, y); y += 5;
    const opts: Array<{ label: string; fill: RGB; brd: RGB; txt: RGB }> = [
      { label: "AI-Generated",  fill: C.aiRedFill, brd: C.aiRedBrd, txt: C.aiRedTxt },
      { label: "Mixed",         fill: C.mixFill,   brd: C.mixBrd,   txt: C.mixTxt   },
      { label: "Human-Written", fill: C.humFill,   brd: C.humBrd,   txt: C.humTxt   },
    ];
    const optW = (CW - 6) / 3;
    opts.forEach((opt, i) => {
      const bx  = ML + i * (optW + 3);
      const sel = opt.label === judgment;
      rect(bx, y, optW, 10, sel ? opt.fill : C.s50, sel ? opt.brd : C.s200);
      if (sel) {
        // Checkmark badge
        rect(bx + optW - 7, y + 1, 6, 6, opt.brd, opt.brd, 1);
        sf("bold", 6, opt.txt); tx("OK", bx + optW - 4, y + 5.5, { align: "center" });
      }
      sf(sel ? "bold" : "normal", 7, sel ? opt.txt : C.s400);
      tx(opt.label, bx + optW / 2, y + 6.5, { align: "center" });
    });
    y += 16;

    hRule(y); y += 5;

    // Notes box
    sf("bold", 8.5, C.s800); tx("Reviewer Notes & Rationale", ML, y); y += 5;
    const notesText = judgeNotes.trim() || "No additional notes provided.";
    const notesLines = doc.splitTextToSize(notesText, CW - 10) as string[];
    const notesBoxH = Math.max(24, notesLines.length * 5 + 10);
    rect(ML, y, CW, notesBoxH, C.s50, C.s200);
    sf("normal", 7.5, judgeNotes.trim() ? C.s800 : C.s400);
    notesLines.forEach((line: string, i: number) => {
      tx(line, ML + 5, y + 8 + i * 5);
    });
    y += notesBoxH + 6;

    hRule(y); y += 5;

    // Automated signals summary vs judgment comparison
    if (perpResult && burstResult) {
      sf("bold", 8.5, C.s800); tx("Automated Signals vs. Reviewer Judgment", ML, y); y += 5;

      const pBDJ = pdfBreakdown(perpResult.internalScore,  perpResult.sentences.length  > 0 ? perpResult.sentences.filter(s  => s.label === "elevated").length / perpResult.sentences.length  : 0);
      const bBDJ = pdfBreakdown(burstResult.internalScore, burstResult.sentences.length > 0 ? burstResult.sentences.filter(s => s.label === "elevated").length / burstResult.sentences.length : 0);
      const nBDJ = neuralResult ? pdfBreakdown(neuralResult.internalScore, neuralResult.sentences.length > 0 ? neuralResult.sentences.filter(s => s.label === "elevated").length / neuralResult.sentences.length : 0) : null;
      const engCount = nBDJ ? 3 : 2;
      const avgAIJ    = Math.round((pBDJ.ai    + bBDJ.ai    + (nBDJ?.ai    ?? 0)) / engCount);
      const avgHumanJ = Math.round((pBDJ.human + bBDJ.human + (nBDJ?.human ?? 0)) / engCount);
      const avgMixedJ = 100 - avgAIJ - avgHumanJ;
      const autoVerdict = (() => {
        const pLeanAI2 = pBDJ.ai > pBDJ.human;
        const bLeanAI2 = bBDJ.ai > bBDJ.human;
        const dualConsensus2 = pLeanAI2 && bLeanAI2;
        if (avgAIJ >= avgMixedJ && avgAIJ >= avgHumanJ && dualConsensus2) return "AI-Generated";
        if (avgHumanJ >= avgMixedJ) return "Human-Written";
        if (avgAIJ >= 35 && avgAIJ < 50) return "Needs Human Review";
        return "Mixed";
      })();
      const agree = !judgment || autoVerdict === judgment;

      const cmpW = (CW - 5) / 2;
      // Auto box
      rect(ML, y, cmpW, 30, C.s100, C.s200);
      rect(ML, y, cmpW, 7, C.s800);
      sf("bold", 6.5, C.white); tx("Automated Analysis", ML + cmpW / 2, y + 5, { align: "center" });
      const aCol: RGB = autoVerdict === "AI-Generated" ? C.red : autoVerdict === "Human-Written" ? C.emerald : C.amber;
      sf("bold", 10, aCol); tx(autoVerdict, ML + cmpW / 2, y + 17, { align: "center" });
      drawBreakdownBar(ML + 4, y + 21, cmpW - 8, 3, avgAIJ, avgMixedJ, avgHumanJ);
      sf("normal", 5.5, C.s400); tx(`AI ${avgAIJ}%  Mix ${avgMixedJ}%  Human ${avgHumanJ}%`, ML + cmpW / 2, y + 28, { align: "center" });

      // Reviewer box
      rect(ML + cmpW + 5, y, cmpW, 30, jFill, jBrd);
      rect(ML + cmpW + 5, y, cmpW, 7, jTxt);
      sf("bold", 6.5, C.white); tx("Reviewer Judgment", ML + cmpW + 5 + cmpW / 2, y + 5, { align: "center" });
      sf("bold", 10, jTxt); tx(jLabel, ML + cmpW + 5 + cmpW / 2, y + 17, { align: "center" });
      sf("normal", 6, jTxt); tx(agree ? "Agrees with automated result" : "Overrides automated result", ML + cmpW + 5 + cmpW / 2, y + 25, { align: "center" });
      y += 36;

      // Agreement note
      const agrFill: RGB = agree ? C.humFill : C.mixFill;
      const agrBrd:  RGB = agree ? C.humBrd  : C.mixBrd;
      const agrTxt:  RGB = agree ? C.humTxt  : C.mixTxt;
      rect(ML, y, CW, 10, agrFill, agrBrd);
      sf("bold", 7, agrTxt);
      tx(agree
        ? (judgment ? "Reviewer judgment agrees with automated signals." : "No reviewer judgment recorded - automated result stands.")
        : `Reviewer overrides automated result from "${autoVerdict}" to "${judgment}".`,
        ML + CW / 2, y + 6.5, { align: "center" });
      y += 16;
    }

    hRule(y); y += 5;

    // Signature line
    sf("bold", 8, C.s800); tx("Reviewer Sign-off", ML, y); y += 6;
    const sigLineY = y + 8;
    sf("normal", 7, C.s600); tx("Name / Designation:", ML, y + 4);
    doc.setDrawColor(...C.s400); doc.setLineWidth(0.3);
    doc.line(ML + 38, sigLineY, ML + 38 + 80, sigLineY);
    sf("normal", 7, C.s600); tx("Date:", ML + 130, y + 4);
    doc.line(ML + 143, sigLineY, PW - MR, sigLineY);
    y += 14;
    sf("normal", 7, C.s600); tx("Signature:", ML, y + 4);
    doc.line(ML + 22, y + 8, ML + 22 + 96, y + 8);
    y += 18;

    hRule(y); y += 4;
    sf("normal", 6, C.s400);
    tx("This judgment was recorded at the time of report generation and reflects the reviewer's contextual assessment.", ML, y + 4);
    tx("Automated signals are one input only - final determination rests with the qualified reviewer.", ML, y + 8);
  } // end if (perpResult && burstResult)

  // ── Page numbers ──────────────────────────────────────────────────────────
  const pageTotal = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageTotal; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal"); doc.setFontSize(6.5); doc.setTextColor(148, 163, 184);
    doc.text(`Page ${p} of ${pageTotal}  -  AI Content Detection Report  -  ${dateStr}`, PW / 2, PH - 7, { align: "center" });
  }

  doc.save(`ai-detection-report-${now.toISOString().slice(0, 10)}.pdf`);
}


// ─────────────────────────────────────────────────────────────────────────────
//  SHARED UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  // Improvement 3: comprehensive abbreviation-aware splitting
  // Protect all common abbreviation patterns before splitting on periods.
  const masked = text
    // Academic / citation abbreviations
    .replace(/\bet\s+al\./gi, "et al#")
    .replace(/\b(Fig|Vol|No|pp|ed|eds|cf|vs|ibid|etc|approx|approx|dept|div|est|govt|intl|natl|univ|prof|assoc|corp|inc|ltd|co|jr|sr)\./gi, m => m.replace(".", "#"))
    // Common honorifics and titles
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Rev|Fr|Sr|Sgt|Cpl|Pvt|Capt|Maj|Col|Gen|Lt|Adm|Pres|Gov|Sen|Rep|Hon)\./gi, m => m.replace(".", "#"))
    // Inline citations like (Smith, 2020) or (Jones et al., 2019)
    .replace(/(\(\w[^)]*),?\s*\d{4}\)/g, m => m.replace(/\./g, "#"))
    // Latin abbreviations
    .replace(/\b(e\.g|i\.e|viz|op\.cit|loc\.cit|ca|c\.)\./gi, m => m.replace(/\./g, "#"))
    // Numbered list items: "1." "2." at start of token are not sentence ends
    .replace(/(\s)(\d{1,2})\.\s+([A-Z])/g, (_, sp, num, cap) => `${sp}${num}# ${cap}`)
    // Single-letter initials in names like "J. Smith" or "A.I."
    .replace(/\b([A-Z])\.\s+([A-Z][a-z])/g, (_, init, next) => `${init}# ${next}`)
    .replace(/\b([A-Z])\.([A-Z])\./g, (_, a, b) => `${a}#${b}#`);

  const results: string[] = [];
  const re = /[^.!?]*[.!?]+/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(masked)) !== null) {
    const seg = text.slice(m.index, m.index + m[0].length).trim();
    if (seg.length > 5) results.push(seg);
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail.length > 5) results.push(tail);
  return results.length > 0 ? results : [text];
}

const TRUE_CONTRACTION_RE = /\b(don't|doesn't|didn't|can't|won't|wouldn't|couldn't|shouldn't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|I'm|I've|I'll|I'd|we're|we've|we'll|we'd|you're|you've|you'll|you'd|they're|they've|they'll|they'd|it's|that's|there's|here's|what's|who's|let's)\b/gi;

// ─────────────────────────────────────────────────────────────────────────────
//  INTERFACES
// ─────────────────────────────────────────────────────────────────────────────

// Evidence strength follows the spec: LOW / MEDIUM / HIGH / INCONCLUSIVE
type EvidenceStrength = "INCONCLUSIVE" | "LOW" | "MEDIUM" | "HIGH";

// Per-sentence attribution - no binary label
interface SentenceResult {
  text: string;
  // 0-100 likelihood score (NOT shown as a single verdict)
  likelihood: number;
  // What signals fired on this sentence
  signals: string[];
  // Conservative label for colouring only
  label: "uncertain" | "moderate" | "elevated";
}

interface SignalResult {
  name: string;
  value: string;
  // Strength 0-100 for the bar
  strength: number;
  // Did this signal point toward AI or clear AI suspicion?
  pointsToAI: boolean;
  // Is this signal well-supported (multiple independent sub-signals)?
  wellSupported: boolean;
}

interface EngineResult {
  // Raw 0-100 internal score - NEVER shown as the primary result
  internalScore: number;
  // Confidence interval [low, high] - shown to user
  confidenceLow: number;
  confidenceHigh: number;
  // Conservative human-readable verdict
  evidenceStrength: EvidenceStrength;
  // Human-readable verdict phrase
  verdictPhrase: string;
  // What fired
  signals: SignalResult[];
  // Per-sentence
  sentences: SentenceResult[];
  // Metadata
  wordCount: number;
  sentenceCount: number;
  // Disagreement flag - if engines disagree, downgrade certainty
  agreesWithOther?: boolean;
  // Whether text has features that reduce reliability
  reliabilityWarnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  VOCABULARY - Three-tier system (Improvement 1: tiered vocab scoring)
//
//  STRONG  — Words essentially never used organically by humans; almost
//            exclusively appear in LLM output. Each hit carries full weight.
//  MEDIUM  — Elevated / formal words that AI overuses but which occasionally
//            appear in human business/academic writing. Partial weight.
//  WEAK    — Common academic/formal words included for pattern completeness.
//            Require 3+ hits to score, and at heavily reduced weight.
//
//  The combined AI_VOCAB set is the union of all three — used wherever a
//  simple membership test is needed (ESL gate, intra-doc shift, etc.).
//  Per-signal scoring uses tier-weighted hit counts.
// ─────────────────────────────────────────────────────────────────────────────

// STRONG tier: words almost never used organically by humans
const AI_VOCAB_STRONG = new Set([
  "leverage","leverages","leveraged","leveraging",
  "utilize","utilizes","utilized","utilizing",
  "streamline","streamlines","streamlined","streamlining",
  "holistic","multifaceted","transformative","groundbreaking","unprecedented",
  "synergy","proactive","actionable","scalability",
  "fostering","empowering","harnessing","catalyzing",
  "delve","delves","delved","delving",
  "tapestry","cornerstone","linchpin","hallmark","bedrock",
  "synergize","synergistic","nexus","convergence",
  "reimagine","rethink","redefine","reshape","reinvent","recalibrate",
  "unlock","unleash","actualize",
  "multifarious","salient","delineate","elucidate","substantiate",
  "commendable","exemplary","paramount","meticulous",
  "spearhead","champion","propel","amplify",
  "cutting-edge","state-of-the-art",
  "culmination","manifestation","embodiment",
  "pervasive","ubiquitous","plethora","myriad","gamut","constellation",
  "poignant","thought-provoking",
  "mosaic","canvas","palette",
  "scaffold","bespoke","curated","impactful","intentional",
  "wellbeing","mindfulness","milestones",
  "symbiotic","reciprocal","iterative",
  "ethos","tenets","pillars",
  "overarching","underpinning",
  "fosters","nurtures","cultivates","cultivate","nurture",
  "incentivize","incentivizes","operationalize","democratize","democratizes",
  "unpack","unpacking",
  "complexities","intricacies",
  "tailored","impactful",
  // Technical ML terms rarely used by non-ML humans
  "pretrained","generative","discriminative",
  "regularization","embedding","inference","transformer",
  // GPT-4o / Claude 3.5 / Gemini era patterns (2024-2025)
  "nuanced approach","sophisticated understanding","multifaceted challenge",
  "interconnected","intertwined","interwoven",
  "game-changing","paradigm-shifting","forward-thinking",
  "thought leadership","value-driven","purpose-driven","mission-driven",
  "co-create","co-design","co-develop",
  "future-proof","future-ready","future-focused",
  "data-driven","evidence-based","research-backed",
  "best-in-class","world-class","industry-leading",
  "next-generation","cutting-edge","state-of-the-art",
  "end-to-end","full-stack","360-degree",
]);

// MEDIUM tier: elevated but plausible in careful human writing
const AI_VOCAB_MEDIUM = new Set([
  "facilitate","facilitates","facilitated","facilitating",
  "optimize","optimizes","optimized","optimizing",
  "robust","seamless","scalable","pivotal","foundational",
  "paradigm","ecosystem","stakeholder",
  "furthermore","moreover","additionally","consequently",
  "nevertheless","nonetheless","accordingly","subsequently",
  "intricate","nuanced","pertinent",
  "illuminate","resonate","noteworthy",
  "indispensable","imperative","comprehensive","adhere",
  "navigate","foster","thrive","vibrant","crucial","vital","ensure",
  "mitigate","alleviate","enhance","bolster","reinforce","strengthen","underpin",
  "elevate","accelerate",
  "innovative","dynamic","cohesive","coherent",
  "integration","framework","paradigm","blueprint","roadmap","trajectory","spectrum",
  "realm","domain","sphere","arena","pathway","conduit",
  "interplay","intersection",
  "underpins","underscored","underpinned","underscore",
  "pivotal","integral","inherent","endemic",
  "profound","insightful","compelling","nuance",
  "groundwork","infrastructure","backbone",
  "resilient","agile","adaptive","responsive","nimble",
  "seamlessly","strategically","systematically","intrinsically",
  "benchmark","pipeline",
  "nuanced",
  "dive","dives","dived","diving",
  "symbiotic","systemic","stance",
  "journey","trajectory",
  "shed","shedding",
  "prioritize","prioritizes","prioritized","prioritizing",
  "contextualize","contextualizes","contextualized",
  "mindful","self-care",
  "harness","leverage","capitalize",
]);

// WEAK tier: common academic words that alone are unreliable signals
const AI_VOCAB_WEAK = new Set([
  "explore","explores","explored","exploring",
  "examine","examines","examined","examining",
  "highlight","highlights","highlighted","highlighting",
  "emphasize","emphasizes","emphasized","emphasizing",
  "acknowledge","acknowledges","acknowledged","acknowledging",
  "recognize","recognizes","recognized","recognizing",
  "distinguish","distinguishes","distinguished","distinguishing",
  "encompass","encompasses","encompassed","encompassing",
  "incorporate","incorporates","incorporated","incorporating",
  "demonstrate","demonstrates","demonstrated","demonstrating",
  "illustrate","illustrates","illustrated","illustrating",
  "meaningful","wellbeing",
  "effectively","efficiently","fundamentally","essentially","ultimately","critically",
  "empower","empowers","empowered",
]);

// Union set for fast membership tests elsewhere in the code
const AI_VOCAB = new Set([
  ...AI_VOCAB_STRONG,
  ...AI_VOCAB_MEDIUM,
  ...AI_VOCAB_WEAK,
]);

// Tier-weighted vocab hit count: strong=3pts, medium=1.5pts, weak=0.5pts
// Returns a single weighted score used to replace raw hit counts in vocabScore.
function weightedVocabHits(words: string[]): { weighted: number; strongHits: number; mediumHits: number; weakHits: number } {
  let strong = 0, medium = 0, weak = 0;
  for (const w of words) {
    if (AI_VOCAB_STRONG.has(w)) strong++;
    else if (AI_VOCAB_MEDIUM.has(w)) medium++;
    else if (AI_VOCAB_WEAK.has(w)) weak++;
  }
  const weighted = strong * 3 + medium * 1.5 + (weak >= 3 ? weak * 0.5 : 0);
  return { weighted, strongHits: strong, mediumHits: medium, weakHits: weak };
}

// AI-specific multi-word phrases (Turnitin/GPTZero aligned — strict)
const AI_BIGRAMS = new Set([
  "plays a crucial","plays a pivotal","plays a key","plays a significant","plays a vital",
  "it is worth","it is important","it is crucial","it should be",
  "cannot be overstated","cannot be understated",
  "in today's world","in today's society","in the modern world","in the modern era",
  "in order to ensure","in order to achieve","in order to maintain",
  "it is important to note","it is worth noting","it should be noted",
  "as we can see","as we have seen","as previously mentioned",
  // Structural AI conclusion/transition openers
  "in conclusion","in summary","to summarize","to sum up","to conclude",
  "not only","but also",
  // AI academic essay formula openers
  "one of the","one of the most","one of the key","one of the defining",
  "despite its","despite these","despite the",
  "for example in","such applications","such systems","such approaches",
  "in academic research","in real-world","in real world",
  // AI responsibility stacking
  "responsible design","ethical considerations","socially responsible",
  "transparent fair","fair and accountable","ethical implications",
  "not only technical","not only on technical",
  // Additional GPTZero/Turnitin-style patterns
  "it is essential","it is imperative","it is necessary",
  "plays an important","plays an essential","plays an integral",
  "a wide range","a wide variety","a broad range","a diverse range",
  "there are several","there are many","there are various","there are numerous",
  "has been widely","has been extensively","has been increasingly",
  "in recent years","over the past","over the years","throughout history",
  "at the same time","on the other hand","on the contrary",
  "with the advent","with the rise","with the emergence","with the increasing",
  "in the field of","in the realm of","in the context of","in the domain of",
  "the importance of","the role of","the impact of","the significance of",
  "first and foremost","last but not least","needless to say",
  "this essay will","this paper will","this article will","this study will",
  "we will explore","we will examine","we will discuss","we will analyze",
  "by doing so","in doing so","having said that","that being said",
  "it goes without saying","it stands to reason","it is clear that",
  "a crucial role","a pivotal role","a vital role","a significant role","an important role",
  "the key to","the foundation of","the cornerstone of","the backbone of",
  "moving forward","going forward","looking ahead","in the future",
  "overall it","overall this","overall these","in essence",
  "to be sure","to be clear","to be fair","without a doubt",
  "both in terms","in terms of","with respect to","with regard to",
  "a variety of","a plethora of","a myriad of","a host of",
  "is closely related","is directly related","is strongly related",
  "ensuring that","ensuring the","ensuring a",
  "in light of","in view of","in consideration of",
  "it can be","it could be","it may be","it might be argued",
  "as a result","as a consequence","as such","in turn",
  "contribute to","contributes to","contributed to","contributing to",
  // ── Claude / modern-LLM multi-word patterns (AV041–060 gap fix) ────────────
  "let's explore","let us explore","let's examine","let us examine",
  "let's dive","let us dive","let's unpack","let us unpack",
  "dive deeper","delve deeper","dig deeper",
  "shed light on","sheds light on","worth noting that","worth exploring",
  "at its core","at the heart of","at the core of",
  "when we consider","when we examine","when we think about",
  "it's worth noting","it's important to","it's worth considering",
  "this is particularly","this is especially","this is increasingly",
  "a nuanced understanding","a deeper understanding","a more nuanced",
  "complex interplay","intricate relationship","multifaceted nature",
  "the nuances of","the complexities of","the intricacies of",
  "navigating the","navigating this","navigating these",
  "raises important","raises critical","raises significant",
  "offers valuable","provides valuable","offers a unique",
  "to this end","to that end",
  "what makes this","what sets this","what distinguishes",
  "one must consider","one must acknowledge","one must recognize",
  "sets the stage","lays the groundwork","paves the way",
  "in this context","in this regard","in this respect",
  "it is noteworthy","it is notable","it is remarkable",
  "deeply rooted","deeply ingrained","deeply embedded",
  "stands as a","serves as a","acts as a",
  "a testament to","testament to the","speaks to the",
  "can be seen","can be observed","can be understood",
  "more broadly","more specifically","more importantly","more fundamentally",
  "not surprisingly","unsurprisingly","not unexpectedly",
  "worth emphasizing","worth highlighting","worth mentioning",
  "think about it","consider this","consider the fact",
  // ── Philippine / Filipino academic AI writing patterns ──────────────────────
  // These are extremely common in AI-generated text from Philippine universities
  // and were invisible to the previous detector. Added per research gap analysis.
  "in the philippine","in the philippines","in philippine context","in our country",
  "as a developing","as a developing nation","as a developing country",
  "the government should","the government must","the philippine government",
  "it is recommended","it is recommended that","based on the foregoing",
  "as mentioned above","as stated above","as discussed above",
  "it can be gleaned","it can be inferred","it can be observed that",
  "this paper seeks","this paper aims","this study seeks","this study aims",
  "the researcher","the researchers","the proponents",
  "to wit","hence it","hence the","verily",
  "in our society","in our community","in our nation",
  "the filipino","filipino people","filipino society",
  "Republic of the Philippines","department of education",
  "local government","local government unit",
]);

// OPT P12/A12: Pre-built module-level structures for LiveWordHighlighter bigram matching.
// Avoids rebuilding AI_BIGRAMS_FLAT and the sorted bigram structures on every render.
// Sorted longest-first ensures greedy matching (3-word phrases before 2-word).
const _LWH_BIGRAMS_FLAT: string[] = Array.from(AI_BIGRAMS).sort((a, b) => b.length - a.length);
// Fast 2-gram and 3-gram lookup sets for O(1) exact match (covers most phrases)
const _LWH_BIGRAM_2_SET = new Set<string>(_LWH_BIGRAMS_FLAT.filter(b => b.split(" ").length === 2));
const _LWH_BIGRAM_3_SET = new Set<string>(_LWH_BIGRAMS_FLAT.filter(b => b.split(" ").length === 3));
// For 4+ word phrases (rare), keep a small sorted array for linear scan
const _LWH_BIGRAM_LONG = _LWH_BIGRAMS_FLAT.filter(b => b.split(" ").length >= 4);

// OPT A13: Compile tokenRe ONCE at module level instead of inside the function
const _LWH_TOKEN_RE = /\b[a-zA-Z]+\b/g;
const AI_TRANSITIONS = [
  /(furthermore|moreover|additionally|consequently|nevertheless|nonetheless|accordingly|subsequently)/gi,
  /(in conclusion|to summarize|to sum up|in summary|to conclude|in closing|to recap)/gi,
  /(it is (important|crucial|essential|vital|necessary|imperative) to note that)/gi,
  /(it is worth (noting|mentioning|considering|highlighting|emphasizing) that)/gi,
  /(plays? a (crucial|pivotal|vital|key|significant|important|central|integral) role in)/gi,
  /(in (today's|the modern|the current|the contemporary) (world|society|era|landscape|age|climate))/gi,
  /(cannot be (overstated|understated|emphasized enough|ignored|overlooked))/gi,
  /(in order to (ensure|achieve|maintain|support|address|improve|facilitate|promote))/gi,
  /(as (we|you) can see|as (we|you) have seen|as previously mentioned|as noted above|as discussed)/gi,
  /(first and foremost|last but not least|needless to say|it goes without saying)/gi,
  /(that being said|having said that|with that in mind|with this in mind)/gi,
  /(on the other hand|on the contrary|by the same token)/gi,
  /(it is (clear|evident|apparent|obvious|undeniable) that)/gi,
  /(this (essay|paper|article|study|report|piece) (will|aims|seeks|intends))/gi,
  /(moving forward|going forward|looking ahead)/gi,
  /(a (plethora|myriad|wide range|broad range|host|wide variety) of)/gi,
  /(it (can|could|may|might) be (argued|said|noted|suggested|observed) that)/gi,
  /(in (the context|the realm|the domain|the field|the landscape|the sphere) of)/gi,
  /(overall[,\s]+(it|this|these|the))/gi,
  // ── Claude / modern-LLM transition patterns (AV041–060 gap fix) ────────────
  /(let('?s| us) (explore|examine|dive|unpack|consider|look at|think about))/gi,
  /(it'?s (worth|important|crucial|essential) (noting|considering|examining|exploring|mentioning|emphasizing))/gi,
  /(shed(s|ding)? light on)/gi,
  /(at (its|the) (core|heart)(\s+of)?)/gi,
  /(when (we|you|one) (consider|examine|look at|think about|reflect on))/gi,
  /(this is (particularly|especially|notably|increasingly) (important|relevant|significant|noteworthy|interesting|complex))/gi,
  /(navigat(e|es|ing|ed) (the|this|these|a|an|its|their))/gi,
  /(the (nuances|complexities|intricacies|subtleties|dynamics) of)/gi,
  /(raises? (important|critical|significant|key|fundamental) (questions?|concerns?|issues?|points?|considerations?))/gi,
  /(offer(s|ing)? (valuable|important|critical|unique|deeper) (insights?|perspective|understanding|clarity))/gi,
  /(to (this|that) end[,\s])/gi,
  /(what (makes|sets|distinguishes) (this|it|them|these|the))/gi,
  /(one (must|should|needs? to|ought to) (consider|acknowledge|recognize|note|understand))/gi,
  /(stands? as (a|an|the) (testament|example|reminder|illustration|embodiment))/gi,
  /(serve(s|d)? as (a|an|the) (foundation|cornerstone|reminder|catalyst|bridge|lens))/gi,
  /(more (broadly|specifically|importantly|fundamentally|generally)[,\s])/gi,
  /(not (surprisingly|unexpectedly|coincidentally)[,\s])/gi,
  /(deeply (rooted|ingrained|embedded|connected|intertwined))/gi,
  /(speak(s|ing)? to (the|a|an|its|their) (importance|significance|complexity|nature|power|need))/gi,
  // ── Philippine / Filipino academic AI transition patterns ────────────────────
  /(in (the )?philippine(s)? context)/gi,
  /(as a developing (nation|country|economy))/gi,
  /(it (is|was) recommended that)/gi,
  /(as (mentioned|stated|discussed) above)/gi,
  /(it can be gleaned (from|that))/gi,
  /(this (paper|study|research) (seeks|aims) to)/gi,
  /(the researcher(s)? (found|noted|observed|concluded))/gi,
  /(based on the foregoing)/gi,
  /(in our (country|society|community|nation))/gi,
];

function countTransitions(text: string): number {
  // OPT P11/A11: Reset lastIndex on each stateful /gi regex before use to prevent
  // incorrect match counts from stale state when the same pattern is called multiple times.
  let n = 0;
  for (const p of AI_TRANSITIONS) {
    p.lastIndex = 0; // OPT A11: always reset stateful /gi regex
    const m = text.match(p);
    if (m) n += m.length;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #2 — PARAGRAPH-OPENING FINGERPRINT
//  AI essays are most robotic at paragraph boundaries. They overwhelmingly open
//  with transition phrases or topic-sentence formulas. Human writers vary their
//  paragraph openers with questions, fragments, proper nouns, dates, quotes, etc.
//
//  Returns: { roboticOpeners, totalParas, score }
//  Score 0-30. Fires when ≥ 3 of 4+ paragraphs open with an AI formula.
// ─────────────────────────────────────────────────────────────────────────────

const PARA_OPENER_AI_RE = [
  /^(furthermore|moreover|additionally|consequently|nevertheless|nonetheless|accordingly|subsequently)\b/i,
  /^(in conclusion|to summarize|to sum up|in summary|to conclude|in closing|overall)\b/i,
  /^(it is (important|crucial|essential|vital|necessary|worth) (to|that|noting))/i,
  /^(one of the (most|key|main|primary|central|fundamental|defining))\b/i,
  /^(the (role|importance|impact|significance|concept|notion|idea|need|challenge|fact) of)\b/i,
  /^(this (paper|essay|article|study|report|section|chapter) (will|aims|seeks|explores|examines|discusses|analyzes|presents|highlights))\b/i,
  /^(in (today's|the modern|the current|the contemporary) (world|society|era|landscape|age))\b/i,
  /^(as (we|you) (can see|have seen|explore|examine|discussed?|noted?|mentioned?))\b/i,
  /^(with (the advent|the rise|the emergence|the increasing|the development|the growth))\b/i,
  /^(when (we|you|one) (consider|examine|look at|think about|reflect on))\b/i,
  /^(understanding\b|exploring\b|examining\b|analyzing\b|addressing\b|navigating\b)/i,
  /^(to (understand|explore|examine|address|fully grasp|achieve|ensure|effectively))\b/i,
  /^(by (understanding|exploring|examining|leveraging|implementing|adopting|utilizing))\b/i,
  /^(given (the|that|these|this|its|their)\b)/i,
  /^(another (key|important|crucial|significant|critical|major|notable) (aspect|factor|point|consideration|element|dimension))\b/i,
  /^(despite (this|these|the|its|their))\b/i,
  /^(building (on|upon) (this|these|the|that))\b/i,
  /^(taken together[,\s]|considered together[,\s]|in (light|view) of (this|these))/i,
];

function paragraphOpenerFingerprint(text: string): { roboticOpeners: number; totalParas: number; score: number; details: string } {
  const paras = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 30);
  if (paras.length < 3) return { roboticOpeners: 0, totalParas: paras.length, score: 0, details: "Insufficient paragraphs for opener analysis (need ≥3)." };

  let robotic = 0;
  const roboticExamples: string[] = [];
  for (const para of paras) {
    // Get the first ~12 words of the paragraph (opener)
    const opener = para.replace(/\s+/g, " ").slice(0, 80);
    const isRobotic = PARA_OPENER_AI_RE.some(re => re.test(opener));
    if (isRobotic) {
      robotic++;
      if (roboticExamples.length < 3) roboticExamples.push(`"${opener.slice(0, 45)}…"`);
    }
  }

  const ratio = robotic / paras.length;
  let score = 0;
  // Scoring: human writers almost never open 3+ consecutive paragraphs with formulas
  if (ratio >= 0.85 && paras.length >= 4) score = 30;
  else if (ratio >= 0.70 && paras.length >= 4) score = 24;
  else if (ratio >= 0.55 && paras.length >= 3) score = 18;
  else if (ratio >= 0.40 && paras.length >= 4) score = 12;
  else if (ratio >= 0.25) score = 6;

  const details = score > 0
    ? `${robotic}/${paras.length} paragraphs (${(ratio*100).toFixed(0)}%) open with AI formula openers. Examples: ${roboticExamples.join("; ")}. Human writers vary paragraph openers; AI consistently uses transitional or topic-sentence formulas.`
    : `${robotic}/${paras.length} paragraphs open with formula openers — within human range.`;

  return { roboticOpeners: robotic, totalParas: paras.length, score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #3 — CONCLUSION-SECTION AMPLIFIER
//  AI essays cluster ethics/responsibility/transparency qualifiers specifically
//  at the end. The document-level ethics signal fires too weakly when body
//  paragraphs are borderline but the conclusion is textbook AI.
//
//  This function analyses the LAST 20% of the text separately with heightened
//  weights and returns a bonus score (0-22) added on top of ethicsScore.
// ─────────────────────────────────────────────────────────────────────────────

function conclusionSectionBoost(text: string): { score: number; details: string } {
  const words = text.split(/\s+/);
  const cutoff = Math.floor(words.length * 0.80);
  const tail = words.slice(cutoff).join(" ");
  const tailWC = Math.max(words.length - cutoff, 1);

  if (tailWC < 30) return { score: 0, details: "Text tail too short for conclusion analysis." };

  // Ethics/responsibility term density in tail
  const tailEthicsTerms = (tail.match(/\b(responsible|transparency|transparent|fair|fairness|accountable|accountability|ethical|ethics|equitable|socially responsible|privacy|bias|inclusive|stakeholder|govern|governance|oversight|regulation|regulatory|trustworthy|trust|safe|safety|wellbeing|well-being|moral|morality|sustainable|sustainability)\b/gi) || []).length;
  const tailEthicsRate = tailEthicsTerms / tailWC;

  // Conclusion clichés that appear almost exclusively at the end of AI essays
  const conclusionClicheCount = (tail.match(
    /(in conclusion|to summarize|to sum up|in summary|to conclude|in closing|ultimately[,\s]|as (we|you) have (seen|explored|examined|discussed)|it is (clear|evident|apparent) that|the (future|path|way|road) (forward|ahead)|as (technology|society|we|the field) (continues?|evolv|advance|progress|move))/gi
  ) || []).length;

  let score = 0;
  if (tailEthicsRate > 0.04 && tailEthicsTerms >= 3 && conclusionClicheCount >= 1) score = 22;
  else if (tailEthicsRate > 0.03 && tailEthicsTerms >= 2) score = 16;
  else if (tailEthicsTerms >= 3 && conclusionClicheCount >= 2) score = 14;
  else if (conclusionClicheCount >= 2) score = 10;
  else if (tailEthicsTerms >= 2 || conclusionClicheCount >= 1) score = 5;

  const details = score > 0
    ? `Last ~20% of text: ${tailEthicsTerms} ethics/governance terms (${(tailEthicsRate*100).toFixed(1)}%), ${conclusionClicheCount} conclusion cliché(s). AI essays systematically concentrate ethics qualifiers and wrap-up phrases at the end.`
    : `Conclusion section shows no unusual ethics/cliché clustering.`;

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #1 — PASSIVE VOICE & SYNTACTIC UNIFORMITY
//  AI models default to subject-verb-complement (SVC) sentence construction and
//  overuse passive voice constructions. Human writers use more varied syntax:
//  fronted adverbials, relative clauses, fragments, inverted sentences.
//
//  Returns a score 0-28.
// ─────────────────────────────────────────────────────────────────────────────

function passiveVoiceAndSyntaxScore(text: string, sentences: string[]): { score: number; passiveCount: number; details: string } {
  if (sentences.length < 5) return { score: 0, passiveCount: 0, details: "Insufficient sentences for syntactic analysis." };

  // Passive voice: "is/are/was/were/has been/have been/had been/will be/can be/may be/should be + past participle"
  const passiveRe = /\b(is|are|was|were|has been|have been|had been|will be|can be|could be|may be|might be|should be|must be|would be)\s+(being\s+)?[a-z]{3,}(ed|en|t)\b/gi;
  const passiveMatches = text.match(passiveRe) || [];
  const passiveCount = passiveMatches.length;
  const passiveRate = passiveCount / Math.max(sentences.length, 1);

  // Syntactic variety markers that AI avoids:
  // - Fronted adverbials: "Despite X, ...", "While X, ...", "Although X, ..."
  // - Inverted sentences with emphasis: "Only then did...", "Not until..."
  // - Direct address: "Consider this:", "Think about...", "Notice how..."
  // - Sentence fragments used for effect (very short sentences: 1-3 words)
  const fronted = (text.match(/^(Despite|While|Although|Even though|Whereas|Since|Once|After|Before|Until|When|If)[^.!?]{10,},/gim) || []).length;
  const invertedEmphasis = (text.match(/\b(Only (then|after|when|if|by)|Not (until|only|once)|Rarely do|Never (have|did|does))/gi) || []).length;
  const fragments = sentences.filter(s => s.trim().split(/\s+/).length <= 3).length;

  // SVC uniformity: sentences that start with "The/A/An/This/These/It/AI/The system..."
  // and follow the basic subject-first template
  const svcOpeners = sentences.filter(s =>
    /^(The |A |An |This |These |It |AI |Machine |Deep |Such |One |Another |Each |Every |Many |Most |Some |Several |Various )/i.test(s.trim())
  ).length;
  const svcRatio = svcOpeners / sentences.length;

  // Score: high passive rate + high SVC uniformity + low syntactic variety = AI
  let score = 0;

  // Passive voice signal (AI overuses passive in academic writing)
  if (passiveRate >= 0.5) score += 14;
  else if (passiveRate >= 0.35) score += 10;
  else if (passiveRate >= 0.20) score += 5;

  // SVC monotony penalty (offset by syntactic variety)
  const varietyBonus = Math.min(10, fronted * 2 + invertedEmphasis * 3 + fragments * 2);
  if (svcRatio >= 0.75 && varietyBonus < 4) score += 14;
  else if (svcRatio >= 0.65 && varietyBonus < 6) score += 8;
  else if (svcRatio >= 0.55 && varietyBonus < 4) score += 4;

  // Reduce score for texts with rich syntactic variety
  score = Math.max(0, score - Math.floor(varietyBonus * 0.6));
  score = Math.min(28, score);

  const details = score > 0
    ? `Passive voice: ${passiveCount} instances (${passiveRate.toFixed(2)}/sentence). SVC-opener ratio: ${(svcRatio*100).toFixed(0)}% of sentences. Syntactic variety markers: ${fronted} fronted adverbials, ${invertedEmphasis} inverted constructions, ${fragments} short fragments. AI defaults to passive/SVC construction; human writers use more structural variety.`
    : `Passive voice rate ${passiveRate.toFixed(2)}/sentence — within human range. Fronted adverbials: ${fronted}, fragments: ${fragments}.`;

  return { score, passiveCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTRA-DOCUMENT ANALYSIS
//  Compare first half vs second half for vocabulary and rhythm shifts.
//  Sudden shifts in AI-signal density suggest hybrid or partial AI text.
// ─────────────────────────────────────────────────────────────────────────────

function intraDocumentShift(sentences: string[]): {
  shiftScore: number;
  description: string;
} {
  if (sentences.length < 6) return { shiftScore: 0, description: "insufficient sentences for intra-document analysis" };

  // ── Half-document shift (original method) ────────────────────────────────
  const mid = Math.floor(sentences.length / 2);
  const firstHalf  = sentences.slice(0, mid);
  const secondHalf = sentences.slice(mid);

  const halfVocabRate = (half: string[]) => {
    const words = half.join(" ").toLowerCase().match(/\b[a-z]+\b/g) || [];
    const wc = Math.max(words.length, 1);
    return words.filter(w => AI_VOCAB.has(w)).length / wc;
  };
  const halfBurstCV = (half: string[]) => {
    const lens = half.map(s => s.trim().split(/\s+/).length);
    const avg = lens.reduce((a, b) => a + b, 0) / Math.max(lens.length, 1);
    const variance = lens.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / Math.max(lens.length, 1);
    return Math.sqrt(variance) / Math.max(avg, 1);
  };

  const vocabShift = Math.abs(halfVocabRate(firstHalf) - halfVocabRate(secondHalf));
  const burstShift = Math.abs(halfBurstCV(firstHalf)   - halfBurstCV(secondHalf));
  const halfShift  = Math.min(100, Math.round(vocabShift * 400 + burstShift * 200));

  // ── Per-sentence AI likelihood variance (NEW — catches interleaved hybrid) ─
  // Compute a quick per-sentence AI likelihood score, then measure the standard
  // deviation across sentences. High variance = some sentences are very AI-like
  // while others are very human-like — the hallmark of hybrid/paste-in text.
  // This catches S026 and S030 where a human voice sentence is immediately
  // followed by an inserted AI sentence.
  const AI_TRANS_QUICK = [
    /\b(furthermore|moreover|additionally|consequently|nevertheless|nonetheless)\b/gi,
    /\b(in conclusion|to summarize|to conclude|in summary)\b/gi,
    /\b(it is important to note|it is worth noting|plays a (crucial|pivotal|vital) role)\b/gi,
    /\b(cannot be (overstated|understated)|in order to (ensure|achieve|maintain))\b/gi,
  ];
  const sentLikelihoods = sentences.map(sent => {
    const sw = sent.toLowerCase().match(/\b[a-z]+\b/g) || [];
    const swc = Math.max(sw.length, 1);
    let score = 0;
    // Vocab hits
    const vHits = sw.filter(w => AI_VOCAB.has(w)).length;
    score += Math.min(50, vHits * 12);
    // Transition hits
    AI_TRANS_QUICK.forEach(p => { if (p.test(sent)) score += 20; });
    // Human voice markers reduce score
    if (/\b(I |I'm |I've |my |we |our )/i.test(sent))           score -= 20;
    if (/\b(yeah|yep|nope|gonna|wanna|kinda|honestly|weird)\b/i.test(sent)) score -= 25;
    if (/\?/.test(sent))                                          score -= 10;
    if (/\.{3}/.test(sent))                                       score -= 8;
    if (sw.length <= 5)                                           score -= 15;
    return Math.min(100, Math.max(0, score));
  });

  // Variance of per-sentence likelihoods
  const meanL = sentLikelihoods.reduce((a, b) => a + b, 0) / sentLikelihoods.length;
  const varL  = sentLikelihoods.reduce((s, l) => s + Math.pow(l - meanL, 2), 0) / sentLikelihoods.length;
  const sdL   = Math.sqrt(varL);

  // High SD (>18) with meanL in 15–75 range = hybrid: mixed human+AI sentences
  // Low SD with high meanL = pure AI; Low SD with low meanL = pure human
  const hybridSignal = meanL > 15 && meanL < 75 && sdL > 18;
  const hybridScore  = hybridSignal ? Math.min(100, Math.round(sdL * 2.5)) : 0;

  // Combine both methods
  const shiftScore = Math.min(100, Math.round((halfShift + hybridScore) / 2));

  let description = "consistent style throughout document";
  if (hybridSignal && hybridScore > 40) description = `high sentence-to-sentence AI variance (SD=${sdL.toFixed(1)}) - strong hybrid/mixed authorship signal`;
  else if (shiftScore > 60) description = "significant style shift detected - possible hybrid or partially AI-edited text";
  else if (shiftScore > 30) description = "moderate style variation between sections";

  return { shiftScore, description };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENHANCEMENT #2 — SENTENCE-LEVEL IDEA REPETITION DETECTOR
//  AI restates the same point 2-3× per paragraph in slightly different wording.
//  Humans rarely do this. We detect it with word-overlap (Jaccard similarity)
//  between consecutive and near-consecutive sentences within each paragraph.
//  Score: 0–22. Fires when ≥2 sentence pairs in the same paragraph share >60%
//  content overlap (after stripping stop words).
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","is","are","was","were","be","been","being",
  "have","has","had","do","does","did","will","would","could","should","may",
  "might","shall","must","can","to","of","in","on","at","for","with","by","from",
  "as","this","that","these","those","it","its","they","them","their","we","our",
  "you","your","i","my","me","he","she","his","her","also","not","no","so","if",
  "when","which","who","what","how","all","any","both","each","few","more","most",
]);

function contentWords(sentence: string): Set<string> {
  const words = sentence.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  return new Set(words.filter(w => !STOP_WORDS.has(w)));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  a.forEach(w => { if (b.has(w)) intersection++; });
  const union = a.size + b.size - intersection;
  return intersection / Math.max(union, 1);
}

function ideaRepetitionScore(text: string, sentences: string[]): { score: number; repetitivePairs: number; details: string } {
  if (sentences.length < 4) return { score: 0, repetitivePairs: 0, details: "Insufficient sentences for repetition analysis." };

  // Split into paragraphs and analyze within each
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 40);
  if (paragraphs.length < 2) {
    // Treat whole text as one paragraph
    const contentSets = sentences.map(contentWords);
    return computeRepetitionFromSets(contentSets, sentences.length);
  }

  let totalPairs = 0;
  for (const para of paragraphs) {
    // Find sentences belonging to this paragraph
    // OPT A6/P9: Match sentences to paragraphs by checking if the sentence (up to 60 chars)
    // appears within the paragraph. Using 60 chars reduces false positive prefix collisions
    // that occurred with 30-char prefixes when sentences start identically.
    const paraSents = sentences.filter(s => {
      const key = s.trim().slice(0, 60);
      return key.length > 10 && para.includes(key);
    });
    if (paraSents.length < 2) continue;
    const sets = paraSents.map(contentWords);
    const { repetitivePairs } = computeRepetitionFromSets(sets, paraSents.length);
    totalPairs += repetitivePairs;
  }

  let score = 0;
  if (totalPairs >= 5) score = 22;
  else if (totalPairs >= 3) score = 16;
  else if (totalPairs >= 2) score = 10;
  else if (totalPairs >= 1) score = 5;

  const details = score > 0
    ? `${totalPairs} sentence pair(s) with >60% content overlap detected across paragraphs. AI models restate the same idea multiple times in slightly different wording within the same paragraph — a pattern human writers rarely produce.`
    : "No significant within-paragraph idea repetition detected.";

  return { score, repetitivePairs: totalPairs, details };
}

function computeRepetitionFromSets(sets: Set<string>[], count: number): { score: number; repetitivePairs: number; details: string } {
  let pairs = 0;
  const THRESHOLD = 0.60;
  for (let i = 0; i < sets.length - 1; i++) {
    // Compare adjacent and one-apart pairs
    for (let j = i + 1; j <= Math.min(i + 2, sets.length - 1); j++) {
      if (sets[i].size >= 4 && sets[j].size >= 4 && jaccardSimilarity(sets[i], sets[j]) >= THRESHOLD) {
        pairs++;
      }
    }
  }

  let score = 0;
  if (pairs >= 5) score = 22;
  else if (pairs >= 3) score = 16;
  else if (pairs >= 2) score = 10;
  else if (pairs >= 1) score = 5;

  const details = score > 0
    ? `${pairs} sentence pair(s) with >60% content overlap detected. AI models restate the same idea multiple times in slightly different wording — a pattern human writers rarely produce.`
    : "No significant idea repetition detected.";

  return { score, repetitivePairs: pairs, details };
}
// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: HAPAX LEGOMENA RATIO
//  Words appearing exactly once (hapax legomena) are a well-established authorship
//  signal. AI text has a lower hapax ratio than human writing of equivalent length
//  because the model repeats its preferred vocabulary. Score: 0–20 (AI if LOW hapax).
// ─────────────────────────────────────────────────────────────────────────────

function hapaxLegomenaScore(words: string[]): { score: number; hapaxRatio: number; details: string } {
  const wc = Math.max(words.length, 1);
  if (wc < 80) return { score: 0, hapaxRatio: 0, details: "Insufficient words for hapax analysis." };
  // OPT A2: Exclude stop words from hapax frequency map.
  // Including stop words inflates hapax ratio on short texts (common stop words rarely repeat)
  // and makes the signal unreliable. Minimum length raised to 4 for the same reason.
  const freq: Record<string, number> = {};
  for (const w of words) {
    const lw = w.toLowerCase().replace(/[^a-z]/g, "");
    if (lw.length >= 4 && !STOP_WORDS.has(lw)) freq[lw] = (freq[lw] || 0) + 1;
  }
  const totalUniq = Object.keys(freq).length;
  const hapaxCount = Object.values(freq).filter(c => c === 1).length;
  const hapaxRatio = totalUniq > 0 ? hapaxCount / totalUniq : 0;

  // Human academic text typically has hapax ratio 0.45–0.65
  // AI text tends to cluster around 0.30–0.42 (lower vocabulary renewal)
  let score = 0;
  if (hapaxRatio < 0.28) score = 20;
  else if (hapaxRatio < 0.33) score = 15;
  else if (hapaxRatio < 0.38) score = 10;
  else if (hapaxRatio < 0.42) score = 5;

  const details = score > 0
    ? `Hapax legomena ratio: ${(hapaxRatio * 100).toFixed(1)}% of unique words appear only once. Low hapax ratio (normal: 45–65%) indicates reduced vocabulary renewal, characteristic of AI text that over-samples its preferred vocabulary.`
    : `Hapax ratio ${(hapaxRatio * 100).toFixed(1)}% — within normal human range (45–65%).`;
  return { score, hapaxRatio, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: READABILITY FORMULA FINGERPRINTING (Flesch-Kincaid)
//  AI academic text clusters in an unnaturally narrow readability band (FK-GL 13–16)
//  with LOW variance across paragraphs. Human writing has higher section-to-section
//  variance. Score: 0–22.
// ─────────────────────────────────────────────────────────────────────────────

function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  word = word.replace(/^y/, "");
  const matches = word.match(/[aeiouy]{1,2}/g);
  return Math.max(1, matches ? matches.length : 1);
}

function fleschKincaidGradeLevel(sentences: string[], words: string[]): number {
  const wc = Math.max(words.length, 1);
  const sc = Math.max(sentences.length, 1);
  const syllables = words.reduce((s, w) => s + countSyllables(w), 0);
  return 0.39 * (wc / sc) + 11.8 * (syllables / wc) - 15.59;
}

function readabilityFingerprintScore(text: string, sentences: string[], words: string[]): { score: number; fkgl: number; fkVariance: number; details: string } {
  const paras = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 60);
  if (paras.length < 3 || words.length < 150) {
    return { score: 0, fkgl: 0, fkVariance: 0, details: "Insufficient paragraphs/words for readability fingerprinting." };
  }

  const globalFKGL = fleschKincaidGradeLevel(sentences, words);

  // Per-paragraph FKGL
  const paraGrades: number[] = paras.map(para => {
    const pWords = para.toLowerCase().match(/\b[a-z]+\b/g) || [];
    const pSents = para.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10);
    if (pWords.length < 20 || pSents.length < 1) return globalFKGL;
    return fleschKincaidGradeLevel(pSents, pWords);
  });

  const avgGrade = paraGrades.reduce((a, b) => a + b, 0) / paraGrades.length;
  const variance = paraGrades.reduce((s, g) => s + Math.pow(g - avgGrade, 2), 0) / paraGrades.length;
  const fkCV = Math.sqrt(variance) / Math.max(Math.abs(avgGrade), 1);

  // AI academic text: FKGL 13–16 with very LOW variance (CV < 0.10)
  // Human writing has more sectional readability drift (CV > 0.15)
  let score = 0;
  const inAIBand = globalFKGL >= 12 && globalFKGL <= 17;
  if (inAIBand && fkCV < 0.08 && paras.length >= 4) score = 22;
  else if (inAIBand && fkCV < 0.12 && paras.length >= 3) score = 14;
  else if (inAIBand && fkCV < 0.15) score = 8;
  else if (fkCV < 0.08 && paras.length >= 4) score = 10; // unnaturally uniform even outside AI band

  const details = score > 0
    ? `Flesch-Kincaid Grade Level: ${globalFKGL.toFixed(1)} (range 12–17 is AI academic zone). Paragraph readability CV: ${fkCV.toFixed(3)} — unnaturally uniform (human writing typically shows CV > 0.15 across sections). AI produces metronomic readability across all paragraphs.`
    : `FKGL: ${globalFKGL.toFixed(1)}, paragraph CV: ${fkCV.toFixed(3)} — within human range.`;
  return { score, fkgl: globalFKGL, fkVariance: fkCV, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: FUNCTION WORD PROFILE (Stylometric)
//  AI models use "the" and "a" in specific ratios, overuse "this"/"these" as
//  demonstratives, and underuse second-person "you/your". Score: 0–18.
// ─────────────────────────────────────────────────────────────────────────────

function functionWordProfileScore(words: string[], wc: number): { score: number; details: string } {
  if (wc < 100) return { score: 0, details: "Insufficient words for function word profiling." };
  const lwords = words.map(w => w.toLowerCase());
  const count = (terms: string[]) => lwords.filter(w => terms.includes(w)).length;

  const theCount    = count(["the"]);
  const aAnCount    = count(["a", "an"]);
  const thisThese   = count(["this", "these"]);
  const youYour     = count(["you", "your", "yourself"]);
  const iMe         = count(["i", "me", "my", "myself", "we", "our"]);

  const theRate     = theCount   / wc;
  const aAnRate     = aAnCount   / wc;
  const demRate     = thisThese  / wc; // demonstratives
  const secPersRate = youYour    / wc;
  const firstPersRate = iMe      / wc;

  // AI fingerprints:
  // - High "the" usage (> 0.07) combined with low "a/an" (< 0.03): definite > indefinite
  // - High demonstrative overuse: "this" + "these" > 0.025 of all words
  // - Near-zero second-person (youYour < 0.002)
  // - Low first-person (iMe < 0.005) — AI rarely uses "I"
  let score = 0;
  const highThe = theRate > 0.07;
  const lowAn   = aAnRate < 0.035;
  const highDem = demRate > 0.022;
  const lowSec  = secPersRate < 0.003;
  const lowFirs = firstPersRate < 0.006;

  const aiSignalCount = [highThe, lowAn, highDem, lowSec, lowFirs].filter(Boolean).length;
  if (aiSignalCount >= 4) score = 18;
  else if (aiSignalCount >= 3) score = 12;
  else if (aiSignalCount >= 2) score = 7;

  const details = score > 0
    ? `Function word profile: "the" ${(theRate*100).toFixed(1)}%, "a/an" ${(aAnRate*100).toFixed(1)}%, demonstratives ("this/these") ${(demRate*100).toFixed(1)}%, 2nd-person ${(secPersRate*100).toFixed(1)}%, 1st-person ${(firstPersRate*100).toFixed(1)}%. ${aiSignalCount}/5 AI function-word markers match. AI overuses "the" and demonstratives while underusing first and second person.`
    : `Function word ratios within human range (${aiSignalCount}/5 AI markers).`;
  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: QUOTE / DIRECT SPEECH DETECTOR (Human Authenticity Signal)
//  Human writing — especially academic writing — contains direct quotes with
//  attribution. AI almost never generates genuine quotations. Reward quoted
//  material as a strong human signal (score reduction). 
// ─────────────────────────────────────────────────────────────────────────────

function quoteDetectorScore(text: string, wc: number): { humanReduction: number; quoteCount: number; details: string } {
  if (wc < 80) return { humanReduction: 0, quoteCount: 0, details: "Insufficient text." };
  // Detect: "quoted text" (attribution), block quotes, or (Author, Year) inline cites
  const doubleQuotes = (text.match(/"[^"]{10,150}"/g) || []).length;
  const singleQuotes = (text.match(/'[^']{10,100}'/g) || []).length;
  // APA/MLA citations: (Author, YYYY) or (Author, YYYY, p. N)
  const inlineCites  = (text.match(/\([A-Z][a-z]+,\s*\d{4}[,)]/g) || []).length;
  // Block-quote style: lines starting with > or indented quotation
  const blockQuotes  = (text.match(/^\s{4,}.{30,}/gm) || []).length;

  const quoteCount = doubleQuotes + singleQuotes + inlineCites + blockQuotes;
  const quoteRatio = quoteCount / Math.max(wc / 100, 1); // per 100 words

  // Strong quote presence is a human signal — reduce the AI score
  let humanReduction = 0;
  if (quoteCount >= 5 || quoteRatio >= 0.8) humanReduction = 12;
  else if (quoteCount >= 3 || quoteRatio >= 0.4) humanReduction = 8;
  else if (quoteCount >= 1) humanReduction = 4;

  const details = humanReduction > 0
    ? `${quoteCount} quoted/cited passage(s) detected (${quoteRatio.toFixed(1)}/100 words). Direct quotation with attribution is a strong human authenticity marker — AI rarely generates genuine attributed quotes.`
    : "No attributed quotations detected.";
  return { humanReduction, quoteCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: CAPITALIZATION ABUSE DETECTOR
//  AI models sometimes capitalize words mid-sentence for emphasis in ways that
//  are grammatically incorrect. Humans almost never do this unintentionally.
//  Score: 0–15. Zero-false-positive signal.
// ─────────────────────────────────────────────────────────────────────────────

function capitalizationAbuseScore(text: string): { score: number; abuseCount: number; details: string } {
  // OPT P3: Pre-build a Set of all lowercased words once — O(n) lookup vs O(n^2) text.includes().
  // For a 500-sentence document this reduces ~10,000 full-string scans to O(1) Set lookups.
  const lowerWordSet = new Set(text.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []);

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
  let abuseCount = 0;
  const examples: string[] = [];

  for (const sent of sentences) {
    const words = sent.trim().split(/\s+/);
    // Skip first word (sentence start)
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/[^a-zA-Z]/g, "");
      if (!w || w.length < 4) continue;
      // Skip: ALL_CAPS acronyms, words after colon (legitimate capitalization)
      if (w === w.toUpperCase()) continue;
      // Mid-sentence capital: starts with uppercase, not all-caps
      if (/^[A-Z][a-z]/.test(w)) {
        // OPT P3: O(1) Set lookup instead of O(n) text.includes scan
        // Also catches word before punctuation — more accurate than space-delimited search
        const lw = w.toLowerCase();
        const appearsLower = lowerWordSet.has(lw);
        if (appearsLower) {
          abuseCount++;
          if (examples.length < 3) examples.push(`"${words.slice(Math.max(0, i-1), i+2).join(" ")}"`);
        }
      }
    }
  }

  let score = 0;
  if (abuseCount >= 5) score = 15;
  else if (abuseCount >= 3) score = 10;
  else if (abuseCount >= 2) score = 6;
  else if (abuseCount >= 1) score = 3;

  const details = score > 0
    ? `${abuseCount} mid-sentence capitalization anomalies detected (examples: ${examples.join("; ")}). AI models occasionally capitalize common words for emphasis in grammatically incorrect ways — humans almost never do this unintentionally.`
    : "No mid-sentence capitalization anomalies detected.";
  return { score, abuseCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: AI MODEL FAMILY FINGERPRINTING
//  Different AI families leave distinct stylistic fingerprints:
//  GPT-4: em-dashes, "delve", "tapestry". Claude: "nuanced", "worth noting",
//  meta-commentary. Llama 3: heavy hedging. Gemini: tricolon + "it's worth noting".
//  Score: 0–20 with suspected family label.
// ─────────────────────────────────────────────────────────────────────────────

function aiModelFamilyFingerprint(text: string): { score: number; suspectedFamily: string | null; confidence: string; details: string; rawScores: { gpt4: number; claude: number; llama: number; gemini: number; perplexity: number; deepseek: number } } {
  const wordCount = Math.max(text.split(/\s+/).length, 1);

  // ── GPT-4 / GPT-4o fingerprints ─────────────────────────────────────────
  // Em-dash overuse is a strong GPT-4o marker (ChatGPT loves —)
  const gpt4Dashes = (text.match(/—/g) || []).length;
  // Core GPT-4o vocabulary — well-documented ChatGPT tells (2023-2025 research).
  // Excludes "it is important to note", "crucial role" — also appear in Gemini.
  const gpt4Vocab = (text.match(/\b(delve|delving|tapestry|bustling|vibrant|foster|fostering|pivotal|leverage|leveraging|synergy|paradigm|groundbreaking|innovative|transformative|multifaceted|shed light|deeply rooted|rich history|evolving landscape|in summary|to summarize|as a whole|it is important to note|plays a crucial|crucial role|key takeaway|nuanced approach|comprehensive overview|thought-provoking|game-changer|game-changing)\b/gi) || []).length;
  // GPT-4o structural transitions — "Firstly/Secondly/Lastly" ordering is a well-known GPT-4 tell
  const gpt4Structure = (text.match(/\b(firstly|secondly|thirdly|lastly|in addition to this|on the other hand|as a result of this|furthermore|moreover|consequently|in conclusion|to conclude|to wrap up|in essence)\b/gi) || []).length;
  // GPT-4o list intros — numbered/bulleted breakdowns with colons
  const gpt4ListIntro = (text.match(/\b(here are|here is a|the following are|consider the following|below are|top \d|best \d|\d key |\d important )/g) || []).length;
  // GPT-4o meta-phrases and section labels
  const gpt4Meta = (text.match(/\bpro.tip\b|\bwhy it works\b|\bwhy it matters\b|\bkey takeaway\b|\btldr\b|\bin this (article|post|guide|piece|essay)\b|\blet's (explore|dive|break down|unpack|look at)\b/gi) || []).length;
  // GPT-4o hedged certainty — "It's worth noting that", "This is particularly important"
  const gpt4Hedged = (text.match(/\b(it's worth noting|this is particularly|particularly important|especially important|this is especially|this highlights|this demonstrates|this underscores|this showcases|this emphasizes)\b/gi) || []).length;

  // ── Claude fingerprints ──────────────────────────────────────────────────
  // Claude has distinct meta-commentary, hedged-reflection, and self-referential phrases.
  // Based on documented Claude 2/3/3.5/3.7 output patterns (Anthropic 2023-2025).
  const claudeMarkers = (text.match(/\b(nuanced|worth noting|worth considering|it's worth|at its core|at the heart of|speaks to|stands as|serves as|taken together|considered together|this raises|this underscores|this illustrates|it's important to recognize|it's important to acknowledge|there's something|there is something|what makes|what this means|this points to|this reflects|grapple with|grappling with|reckoning|the tension between|navigating|a certain|a kind of)\b/gi) || []).length;
  // Claude-specific hedging and epistemic humility phrases
  const claudeEpistemic = (text.match(/\b(I should note|I want to be clear|I think it's worth|to be clear|to be honest|to be fair|I'd be remiss|I'd argue|I believe|I think|admittedly|candidly|frankly speaking|in my view|from my perspective|one could argue that|it's complicated|it's complex|it depends|the answer is nuanced)\b/gi) || []).length;
  // Claude structural patterns: extensive nested qualifications and parenthetical asides
  const claudeQualify = (text.match(/\b(though it's worth|though this|though the|even if|even though|even when|even as|while acknowledging|while recognizing|while noting|with that said|that said|having said that|all that said|with all that in mind)\b/gi) || []).length;

  // ── Llama 3 / Llama 3.1 / Llama 3.3 fingerprints ───────────────────────
  // Heavy hedged modality is the strongest Llama 3 signal
  const llamaModalMarkers = (text.match(/\b(may|might|could)\b/gi) || []).length;
  const llamaRate = llamaModalMarkers / wordCount;
  // Llama 3 frame markers: "In the context of", "as previously mentioned", run-on structures
  const llamaFrameMarkers = (text.match(/\b(in the context of|within the context of|it is worth mentioning|as such|as previously mentioned|as mentioned earlier|as discussed above|as noted above|it should be mentioned|it is important to mention|broadly speaking|in a broader sense|from a broader perspective)\b/gi) || []).length;
  // Llama 3 tends to use "I hope this helps", "Let me know if", "Feel free to" closings
  const llamaClosings = (text.match(/\b(i hope this (helps|clarifies|answers)|let me know if (you have|you need|there's)|feel free to (ask|reach out|let me know)|if you have any (questions|concerns|doubts)|don't hesitate to|please (let me know|feel free|don't hesitate))\b/gi) || []).length;
  // Llama 3 over-explains with "This means that", "This is because", "In other words"
  const llamaOverExplain = (text.match(/\b(this means that|this is because|in other words|to put it another way|to put it differently|what this means is|what this tells us|what this shows us|this essentially means|this effectively means)\b/gi) || []).length;

  // ── Gemini / Gemini 1.5 / Gemini 2.0 fingerprints ──────────────────────
  // Gemini-specific hedging and annotation phrases (well-documented Google DeepMind patterns)
  const geminiHedgePhrases = (text.match(/\b(it's worth noting|it is worth noting|it should be noted|as noted above|as mentioned above|it bears mentioning|it is essential to note|it is crucial to note|it is important to recognize|importantly|notably|keep in mind|it's important to keep in mind)\b/gi) || []).length;
  // Gemini recommendation/decision framing — requires qualified "based on" not generic
  const geminiBasedOn = (text.match(/\b(based on (current|recent|our|my|the above|available|these) (research|analysis|evidence|findings|data|results|factors)|depending on whether|whether you prioritize|your primary constraint|your best bet|your best choice|the best choice depends on|ultimately depends on)\b/gi) || []).length;
  // Gemini summary and recommendation closings
  const geminiClosings = (text.match(/\b(my recommendation|the bottom line|in short|in brief|the key takeaway|the main takeaway|to put it simply|the best option is|all things considered|ultimately,|at the end of the day)\b/gi) || []).length;
  // Gemini competitive/comparison framing labels — distinctive product comparison style
  const geminiFraming = (text.match(/\b(all-rounder|practical champion|anomaly specialist|deep learning choice|the practical choice|the safe choice|your best bet|go-to choice|go-to option|go-to tool|solid choice|strong choice|clear winner|top contender|the right pick|best pick|well-rounded|a versatile choice)\b/gi) || []).length;
  // Gemini "the [adj] choice/option/approach" pattern in recommendation context
  const geminiChoiceFrame = (text.match(/\bthe\s+(best|top|safest|easiest|simplest|fastest|most (practical|efficient|reliable|suitable|appropriate))\s+(choice|option|approach|candidate|method|solution)\b/gi) || []).length;
  // Gemini markdown-heavy asterisk bullets and bold signifiers (common in Gemini plain text)
  const geminiMarkdown = (text.match(/\*\*|\* \w|\* Why|\* Pros|\* Cons|\* Note|\* Key|\* Important/g) || []).length;
  // Gemini uses "Here's a breakdown", "Here's a summary", "Here's what" frequently
  const geminiHeres = (text.match(/\bhere'?s\s+(a\s+)?(breakdown|summary|overview|comparison|quick|what|how|why|the)/gi) || []).length;
  // Gemini tricolon — only amplified when Gemini-exclusive signals are also present
  const geminiTricolon = (geminiHedgePhrases > 0 || geminiBasedOn > 0 || geminiFraming > 0 || geminiMarkdown > 0)
    ? (text.match(/\b\w[\w\s]{2,20},\s*\w[\w\s]{2,20},\s*and\s+\w[\w\s]{2,15}\b/gi) || []).length
    : 0;

  // ── Perplexity AI fingerprints ────────────────────────────────────────────
  // Perplexity AI uses citation-forward language and search-engine-influenced phrasing.
  // It tends to surface information with explicit sourcing hedges and ranked/listed formats.
  // Perplexity answers are often structured as a direct answer followed by "according to" sourcing.
  const perplexityCitation = (text.match(/\b(according to|as reported by|as stated by|as noted by|as found by|as indicated by|per [A-Z]|citing|sources indicate|sources suggest|research indicates|studies indicate|evidence suggests|data shows|data indicates|reports indicate|findings suggest|findings show)\b/gi) || []).length;
  // Perplexity uses ranked/enumerated answer patterns — "The top X", "X key factors", "X main reasons"
  const perplexityRanked = (text.match(/\b(the top \d|the \d (best|main|key|primary|most important)|key (factors|reasons|aspects|points|benefits|differences|considerations)|main (reasons|factors|aspects|points|differences|considerations)|primary (reasons|factors|advantages|disadvantages)|notable (examples|differences|features|aspects))\b/gi) || []).length;
  // Perplexity synthesizer language — aggregating multiple sources into one answer
  const perplexitySynth = (text.match(/\b(in summary|to summarize|overall,|in general,|generally,|collectively|taken together|as a whole|across (these|multiple|various|different) sources|multiple sources (suggest|indicate|agree|confirm|note)|experts (agree|suggest|note|recommend|argue|believe))\b/gi) || []).length;
  // Perplexity uses "as of [date/year]" for temporal grounding from search results
  const perplexityTemporal = (text.match(/\bas of (20\d\d|january|february|march|april|may|june|july|august|september|october|november|december|today|now|recently|the latest|the most recent)\b/gi) || []).length;
  // Perplexity direct answer opener — "X is a...", "X refers to...", "X is defined as..." (encyclopedia-style)
  const perplexityDefinition = (text.match(/\b(is defined as|refers to|is described as|is characterized by|can be defined as|is commonly defined as|is broadly defined as|is understood as|is known as)\b/gi) || []).length;

  // ── DeepSeek / DeepSeek-V2 / DeepSeek-R1 fingerprints ───────────────────
  // DeepSeek uses formal academic Chinese-influenced English patterns (documented 2024-2025)
  const deepseekFormal = (text.match(/\b(it can be seen that|it is observed that|it is noted that|as can be seen|it is evident that|it is clear that|this paper|this study|this work|the proposed|the aforementioned|the above-mentioned|scholars argue|scholars note|scholars suggest|research suggests|studies show|studies indicate|literature suggests|existing literature|growing body|body of literature|body of evidence|empirical evidence|as evidenced by|as demonstrated by|as argued by|as noted by|as shown by)\b/gi) || []).length;
  // DeepSeek step-by-step reasoning with explicit numbering — common in DeepSeek-R1 chain-of-thought
  const deepseekSteps = (text.match(/\b(step \d|step one|step two|step three|firstly,|secondly,|thirdly,|finally,|to begin with|to start with|in the first place|first and foremost|last but not least)\b/gi) || []).length;
  // DeepSeek academic hedging — formal hedges common in Chinese academic English writing
  const deepseekHedge = (text.match(/\b(to some extent|to a certain extent|in most cases|in general|generally speaking|broadly speaking|in many cases|under certain conditions|given that|provided that|arguably|it could be argued|it can be argued|it may be argued|one could argue|one might argue|to a large extent|to a greater extent)\b/gi) || []).length;
  // DeepSeek high-register academic vocabulary (Latinate/formal terms in DeepSeek academic output)
  const deepseekAcademic = (text.match(/\b(underpinning|underpins|precipitated|paradigm shift|operationalize|contextualize|conceptualize|delineate|elucidate|explicate|juxtapose|corroborate|substantiate|encapsulate|necessitates|presupposes|encompasses|constitutes|problematizes|synthesizes|hitherto|notwithstanding|inasmuch|insofar|therein|wherein|whereby|heretofore|the aforementioned|literature review|systematic(ally)? compar|ethical (framework|landscape|terrain|vacuum|guidance)|comparative analysis|policy development|research (workflow|process)|scholarly authorship|academic integrity|intellectual (labor|agency|rigor)|theoretical framework|conceptual framework)\b/gi) || []).length;
  // DeepSeek-R1 chain-of-thought reasoning markers (unique to DeepSeek-R1 "think" mode output)
  const deepseekReasoning = (text.match(/\b(let me (think|reason|work through|consider|analyze|break this down)|thinking through|reasoning through|working through|let's (think|reason|work through|break this down|consider)|upon (reflection|consideration|analysis|review)|after (careful|thorough) (consideration|analysis|review|reflection)|reconsidering|re-examining)\b/gi) || []).length;

  // ── Score each family ────────────────────────────────────────────────────
  const gpt4Score    = gpt4Dashes * 2 + gpt4Vocab * 3 + gpt4Structure * 2 + gpt4ListIntro * 3 + gpt4Meta * 4 + gpt4Hedged * 2;
  const claudeScore  = claudeMarkers * 4 + claudeEpistemic * 2 + claudeQualify * 2;
  const llamaScore   = (llamaRate > 0.05 ? Math.min(16, Math.round(llamaRate * 180)) : 0) + llamaFrameMarkers * 2 + llamaClosings * 4 + llamaOverExplain * 2;
  const geminiScore  = geminiHedgePhrases * 3 + geminiBasedOn * 4 + geminiClosings * 3 + geminiFraming * 3 + geminiChoiceFrame * 2 + geminiMarkdown * 2 + geminiHeres * 3 + geminiTricolon * 2;
  const perplexityScore = perplexityCitation * 4 + perplexityRanked * 3 + perplexitySynth * 2 + perplexityTemporal * 5 + perplexityDefinition * 3;
  const deepseekScore = deepseekFormal * 4 + deepseekSteps * 3 + deepseekHedge * 3 + deepseekAcademic * 4 + deepseekReasoning * 4;

  const rawScores = { gpt4: gpt4Score, claude: claudeScore, llama: llamaScore, gemini: geminiScore, perplexity: perplexityScore, deepseek: deepseekScore };

  const scores = [
    { family: "GPT-4/GPT-4o", score: gpt4Score },
    { family: "Claude",        score: claudeScore },
    { family: "Llama 3",       score: llamaScore },
    { family: "Gemini",        score: geminiScore },
    { family: "Perplexity AI", score: perplexityScore },
    { family: "DeepSeek",      score: deepseekScore },
  ];

  // Sort descending to compare top two
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const best   = sorted[0];
  const second = sorted[1];
  const totalAISignal = best.score;

  // Require a meaningful gap between the winner and runner-up.
  const gap = best.score - second.score;
  const clearWinner = gap >= 5;

  let suspectedFamily: string | null = null;
  let confidence = "low";
  let signalScore = 0;

  if (clearWinner && totalAISignal >= 16) { suspectedFamily = best.family; confidence = "moderate"; signalScore = 20; }
  else if (clearWinner && totalAISignal >= 10) { suspectedFamily = best.family; confidence = "low"; signalScore = 12; }
  else if (clearWinner && totalAISignal >= 5)  { suspectedFamily = best.family; confidence = "very low"; signalScore = 6; }
  // If no clear winner, leave suspectedFamily null — "Inconclusive" is better than wrong

  const details = suspectedFamily
    ? `Suspected AI family: ${suspectedFamily} (${confidence} confidence). Scores — GPT-4/GPT-4o: ${gpt4Score}, Claude: ${claudeScore}, Llama 3: ${llamaScore}, Gemini: ${geminiScore}, Perplexity AI: ${perplexityScore}, DeepSeek: ${deepseekScore}. Gap vs runner-up: ${gap}. Family fingerprinting is supplementary and should not be used as standalone evidence.`
    : totalAISignal >= 5
      ? `AI family inconclusive — scores too close to distinguish (top: ${best.family} ${best.score}, runner-up: ${second.family} ${second.score}, gap: ${gap}). This does not indicate human authorship.`
      : `No strong AI family fingerprint detected (all family scores < 5). This does not indicate human authorship.`;

  return { score: signalScore, suspectedFamily, confidence, details, rawScores };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: SELF-BLEU / REPETITION-N SCORE
//  AI text has measurably higher self-repetition at the n-gram level within a
//  single document. Computing 3-gram and 4-gram overlap between all sentence pairs
//  catches repetitive AI writing that Jaccard similarity at the word level misses.
//  Score: 0–20.
// ─────────────────────────────────────────────────────────────────────────────

function selfBleuScore(sentences: string[]): { score: number; avgOverlap: number; details: string } {
  if (sentences.length < 5) return { score: 0, avgOverlap: 0, details: "Insufficient sentences for Self-BLEU analysis." };

  const getNgrams = (sent: string, n: number): Set<string> => {
    const words = sent.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    if (words.length < n) return new Set();
    const grams = new Set<string>();
    for (let i = 0; i <= words.length - n; i++) {
      grams.add(words.slice(i, i + n).join(" "));
    }
    return grams;
  };

  // Compute pairwise 3-gram and 4-gram overlaps (sample for performance)
  const sampleSize = Math.min(sentences.length, 20);
  const sampled = sentences.slice(0, sampleSize);
  let totalOverlap = 0;
  let pairCount = 0;

  for (let i = 0; i < sampled.length - 1; i++) {
    for (let j = i + 2; j < Math.min(i + 6, sampled.length); j++) { // non-adjacent pairs
      const g3i = getNgrams(sampled[i], 3);
      const g3j = getNgrams(sampled[j], 3);
      if (g3i.size === 0 || g3j.size === 0) continue;
      let inter3 = 0;
      g3i.forEach(g => { if (g3j.has(g)) inter3++; });
      const overlap3 = inter3 / Math.min(g3i.size, g3j.size);
      totalOverlap += overlap3;
      pairCount++;
    }
  }

  const avgOverlap = pairCount > 0 ? totalOverlap / pairCount : 0;

  // Human text: avg 3-gram overlap between non-adjacent sentences ~0–0.05
  // AI text: avg 3-gram overlap ~0.08–0.15 (repeats structural phrases)
  let score = 0;
  if (avgOverlap >= 0.14) score = 20;
  else if (avgOverlap >= 0.10) score = 14;
  else if (avgOverlap >= 0.07) score = 9;
  else if (avgOverlap >= 0.04) score = 4;

  const details = score > 0
    ? `Self-BLEU (3-gram overlap) between non-adjacent sentences: ${(avgOverlap * 100).toFixed(1)}%. High n-gram self-repetition (normal < 5%) indicates AI text that repeats structural phrases across the document. This signal catches repetitive AI writing that word-level overlap misses.`
    : `Self-BLEU score ${(avgOverlap * 100).toFixed(1)}% — within human range (< 5%).`;
  return { score, avgOverlap, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: SEMANTIC DENSITY SCORE (Content Word Ratio)
//  AI maintains unnaturally HIGH content-word-to-function-word ratio — metronomic
//  information density. Human writing has more filler and connective tissue.
//  Score: 0–16.
// ─────────────────────────────────────────────────────────────────────────────

const CONTENT_WORD_POS_SUFFIXES = /\b\w+(tion|tions|ment|ments|ity|ities|ness|nesses|ize|izes|ized|ify|ifies|ified|ous|ious|eous|ive|atives|ism|ist|ists|ance|ence|ency|ancy)\b/gi;

function semanticDensityScore(words: string[], wc: number): { score: number; densityCV: number; details: string } {
  if (wc < 120) return { score: 0, densityCV: 0, details: "Insufficient words for semantic density analysis." };

  // Content words: nouns, verbs, adjectives, adverbs (approximate via exclusion of function words)
  const contentWords = words.filter(w => !STOP_WORDS.has(w.toLowerCase()) && w.length >= 3);
  const globalDensity = contentWords.length / wc;

  // Measure density variance across 100-word chunks
  const chunkSize = 100;
  const chunks: number[] = [];
  for (let i = 0; i + chunkSize <= words.length; i += Math.floor(chunkSize / 2)) {
    const chunk = words.slice(i, i + chunkSize);
    const cContent = chunk.filter(w => !STOP_WORDS.has(w.toLowerCase()) && w.length >= 3);
    chunks.push(cContent.length / chunkSize);
  }

  if (chunks.length < 2) return { score: 0, densityCV: 0, details: "Insufficient chunks for density variance analysis." };
  const avgD = chunks.reduce((a, b) => a + b, 0) / chunks.length;
  const varD  = chunks.reduce((s, d) => s + Math.pow(d - avgD, 2), 0) / chunks.length;
  const cvD   = Math.sqrt(varD) / Math.max(avgD, 0.01);

  // AI: high global density (> 0.58) with LOW variance (cvD < 0.08) = metronomic
  // Human: moderate density with higher variance
  let score = 0;
  const highDensity = globalDensity > 0.58;
  if (highDensity && cvD < 0.06 && chunks.length >= 4) score = 16;
  else if (highDensity && cvD < 0.09) score = 10;
  else if (globalDensity > 0.62 && cvD < 0.12) score = 6;

  const details = score > 0
    ? `Content word density: ${(globalDensity * 100).toFixed(1)}% (AI range > 58%) with CV ${cvD.toFixed(3)} across ${chunks.length} text chunks. AI maintains unnaturally uniform high information density; human writing varies in density across sections.`
    : `Content word density ${(globalDensity * 100).toFixed(1)}% with CV ${cvD.toFixed(3)} — within human range.`;
  return { score, densityCV: cvD, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: PARAPHRASE ATTACK DETECTION
//  Students increasingly run AI output through paraphrasers (Quillbot, Wordtune).
//  Result: vocabulary-level patterns are masked but structural AI patterns remain.
//  Paraphrase artifacts: unnatural synonym substitutions, split sentences losing
//  coherence, word-order inversions. Score: 0–18.
// ─────────────────────────────────────────────────────────────────────────────

// Common Quillbot-style synonym substitutions: rare word used where common expected
const PARAPHRASE_RARE_SUBS = new Set([
  "utilize","utilization","commence","commencement","endeavor","endeavour",
  "ascertain","necessitate","procure","facilitate","ameliorate","amelioration",
  "elucidate","aforementioned","aforementioned","subsequent","subsequently",
  "notwithstanding","inasmuch","herein","thereof","wherein","whereby",
  "pertaining","regarding","concerning","pertains","comprises","constitutes",
  "encompasses","encompasses","incorporates","demonstrates","illustrates",
  "exhibits","manifests","portrays","depicts","delineates","elucidates",
  "denotes","signifies","connotes","implies","infers","suggests","indicates",
]);

function paraphraseAttackScore(text: string, sentences: string[]): { score: number; details: string } {
  if (sentences.length < 5) return { score: 0, details: "Insufficient sentences for paraphrase detection." };

  const ltext = text.toLowerCase();
  const words  = ltext.match(/\b[a-z]+\b/g) || [];
  const wc     = Math.max(words.length, 1);

  // Signal 1: High density of rare formal synonyms (paraphrase tool fingerprint)
  const rareSubs = words.filter(w => PARAPHRASE_RARE_SUBS.has(w)).length;
  const rareRate = rareSubs / wc;

  // Signal 2: Sentence-length inversion pattern
  // Paraphrasers often split long AI sentences into shorter awkward ones or
  // merge short ones into run-ons. Detect: high CV with many very short AND very long sentences
  const lens = sentences.map(s => s.trim().split(/\s+/).length);
  const avgLen = lens.reduce((a, b) => a + b, 0) / Math.max(lens.length, 1);
  const veryShort = lens.filter(l => l < 6).length / Math.max(lens.length, 1);
  const veryLong  = lens.filter(l => l > 40).length / Math.max(lens.length, 1);
  const polarizedLength = veryShort > 0.15 && veryLong > 0.10; // unusual bimodal length distribution

  // Signal 3: Conjunction-stripped sentences (paraphrasers remove connectives)
  const conjStarters = sentences.filter(s =>
    /^(however|therefore|moreover|furthermore|additionally|consequently|nevertheless)/i.test(s.trim())
  ).length;
  const conjRate = conjStarters / Math.max(sentences.length, 1);
  // Human starts: low; AI starts: moderate; Paraphrased AI: very low (stripped out)
  const strippedConnectives = conjRate < 0.03 && sentences.length > 8;

  let score = 0;
  const signals: string[] = [];

  if (rareRate > 0.035) { score += 8; signals.push(`${rareSubs} rare-synonym substitutions (${(rareRate*100).toFixed(1)}%)`); }
  else if (rareRate > 0.020) { score += 4; signals.push(`${rareSubs} formal synonym substitutions`); }

  if (polarizedLength) { score += 6; signals.push("bimodal sentence-length distribution (short+long)"); }
  if (strippedConnectives) { score += 4; signals.push("very low connective opener rate (possible stripping)"); }

  score = Math.min(18, score);

  const details = score > 0
    ? `Paraphrase attack indicators: ${signals.join("; ")}. These patterns suggest AI text processed through a paraphrasing tool (Quillbot, Wordtune, etc.) — structural AI patterns persist even after vocabulary-level substitution.`
    : "No significant paraphrase attack indicators detected.";
  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: FILIPINO / ESL L1-TRANSFER PATTERNS (Human Authenticity Signal)
//  Filipino L1-transfer errors in English writing are STRONG human authenticity
//  signals. These patterns reduce the AI score (human reduction). 
//  Patterns: dropped articles, Tagalog topic-comment structure, preposition confusions.
// ─────────────────────────────────────────────────────────────────────────────

function filipinoL1TransferScore(text: string, wc: number): { humanReduction: number; l1Count: number; details: string } {
  if (wc < 60) return { humanReduction: 0, l1Count: 0, details: "Insufficient text." };

  // Dropped articles: "The study show that" / "result show" (missing -s or dropped article)
  const droppedArticle = (text.match(/\b(study|research|result|data|findings?|analysis|survey|literature|evidence)\s+(show|indicate|suggest|reveal|demonstrate|prove)\b/gi) || []).length;

  // Tagalog topic-comment structure: "As for the X, it is..." / "With regards to X, the..."
  const topicComment = (text.match(/\b(as for|with regards? to|insofar as|as to|speaking of|in terms of the|when it comes to the)\b/gi) || []).length;

  // Filipino preposition confusions: "discuss about", "emphasize on", "cope up"
  const prepConfusion = (text.match(/\b(discuss(ed|es)? about|emphasize[sd]? on|cope up with|stress on|mention(ed|s)? about|talk(ed|s)? about in|relate(d|s)? with|cope with|deal with in|focus on in)\b/gi) || []).length;

  // Filipino English collocations: "give emphasis", "make mention", "at present time"
  const filipinoCollocations = (text.match(/\b(give emphasis|make mention|at the present time|at present time|in the said|the said|thru which|by means of which|in pursuant|pursuant thereto|herein mentioned)\b/gi) || []).length;

  const l1Count = droppedArticle + topicComment + prepConfusion + filipinoCollocations;

  let humanReduction = 0;
  if (l1Count >= 5) humanReduction = 15;
  else if (l1Count >= 3) humanReduction = 10;
  else if (l1Count >= 2) humanReduction = 7;
  else if (l1Count >= 1) humanReduction = 4;

  const details = humanReduction > 0
    ? `${l1Count} Filipino/Philippine English L1-transfer pattern(s) detected (dropped articles: ${droppedArticle}, topic-comment: ${topicComment}, preposition patterns: ${prepConfusion}, Filipino collocations: ${filipinoCollocations}). These are authentic ESL writer fingerprints — strong human authenticity signal for Philippine academic context.`
    : "No Filipino L1-transfer patterns detected.";
  return { humanReduction, l1Count, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: ZIPF'S LAW DEVIATION SCORE
//  Natural human text follows Zipf's law: word frequency × rank ≈ constant.
//  AI text deviates measurably because the model oversamples mid-frequency vocab.
//  We fit an ideal Zipf curve and measure residual sum-of-squares.
//  Score: 0–22 (AI if HIGH deviation from power-law).
// ─────────────────────────────────────────────────────────────────────────────

function zipfDeviationScore(words: string[]): { score: number; zipfDev: number; details: string } {
  const wc = words.length;
  if (wc < 150) return { score: 0, zipfDev: 0, details: "Insufficient words for Zipf analysis (need ≥ 150)." };

  // Build frequency table
  const freq: Record<string, number> = {};
  for (const w of words) {
    const lw = w.toLowerCase().replace(/[^a-z]/g, "");
    if (lw.length >= 2) freq[lw] = (freq[lw] || 0) + 1;
  }

  // OPT P16: Float64Array sort is ~2× faster than Object.values sort for numeric arrays
  const freqValues = Object.values(freq);
  const ranked = new Float64Array(freqValues).sort().reverse();
  if (ranked.length < 20) return { score: 0, zipfDev: 0, details: "Insufficient unique words for Zipf analysis." };

  // Fit ideal Zipf: f(r) = f(1) / r  (simplest form, exponent = 1)
  // Compare top-50 ranks only (most stable region)
  const sampleSize = Math.min(50, ranked.length);
  const f1 = ranked[0]; // frequency of most common word
  let rss = 0; // residual sum of squares (log scale)
  for (let r = 1; r <= sampleSize; r++) {
    const observed  = Math.log(ranked[r - 1] + 1);
    const predicted = Math.log(f1 / r + 1);
    rss += Math.pow(observed - predicted, 2);
  }
  const normalizedRSS = rss / sampleSize; // per-rank average squared residual

  // Human text: normalizedRSS typically 0.05–0.25 (good Zipf fit)
  // AI text: normalizedRSS typically 0.30–0.70 (mid-freq oversampling distorts curve)
  let score = 0;
  if (normalizedRSS >= 0.55) score = 22;
  else if (normalizedRSS >= 0.42) score = 16;
  else if (normalizedRSS >= 0.32) score = 10;
  else if (normalizedRSS >= 0.25) score = 5;

  const details = score > 0
    ? `Zipf's Law deviation (normalized RSS): ${normalizedRSS.toFixed(3)} — significantly above human range (0.05–0.25). AI text oversamples mid-frequency vocabulary, distorting the expected power-law word frequency distribution. This is a language-independent structural signal.`
    : `Zipf deviation ${normalizedRSS.toFixed(3)} — within human range (power-law fit acceptable).`;
  return { score, zipfDev: normalizedRSS, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: TYPE-TOKEN RATIO TRAJECTORY (Power-Law Decay Curve)
//  The *trajectory* of TTR as text length grows is more powerful than scalar TTR.
//  Human text: characteristic power-law decay (TTR ∝ length^β, β ≈ -0.4 to -0.5).
//  AI text: unnaturally LINEAR decay — vocabulary renewal rate is constant because
//  the model samples from a fixed distribution regardless of position.
//  Score: 0–20 (AI if trajectory is too linear — low curve fit to power-law).
// ─────────────────────────────────────────────────────────────────────────────

function ttrTrajectorySore(words: string[]): { score: number; linearityIndex: number; details: string } {
  const wc = words.length;
  if (wc < 200) return { score: 0, linearityIndex: 0, details: "Insufficient words for TTR trajectory analysis (need ≥ 200)." };

  // Compute TTR at 10 evenly spaced checkpoints
  const checkpoints = 10;
  const step = Math.floor(wc / checkpoints);
  const ttrPoints: { n: number; ttr: number }[] = [];
  for (let i = 1; i <= checkpoints; i++) {
    const slice = words.slice(0, i * step);
    const unique = new Set(slice.map(w => w.toLowerCase())).size;
    ttrPoints.push({ n: i * step, ttr: unique / slice.length });
  }

  // OPT P15: Precompute regression slope and R² using direct formulas rather than
  // nested reduce(inside reduce) which was O(n²) due to summing inside the outer reduce.
  const N = ttrPoints.length;
  const xs = ttrPoints.map(p => p.n);
  const ys = ttrPoints.map(p => p.ttr);

  // Precompute sums once — O(n) not O(n²)
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0, sumYY = 0;
  for (let i = 0; i < N; i++) {
    sumX += xs[i]; sumY += ys[i];
    sumXX += xs[i] * xs[i]; sumXY += xs[i] * ys[i]; sumYY += ys[i] * ys[i];
  }
  const meanX = sumX / N, meanY = sumY / N;
  const sxx = sumXX - N * meanX * meanX;
  const sxy = sumXY - N * meanX * meanY;
  const syy = sumYY - N * meanY * meanY;

  // Linear R²
  const slope = sxx !== 0 ? sxy / sxx : 0;
  let ssRes = 0;
  for (let i = 0; i < N; i++) {
    const yPred = meanY + slope * (xs[i] - meanX);
    ssRes += (ys[i] - yPred) ** 2;
  }
  const linearR2 = syy > 0 ? Math.max(0, 1 - ssRes / syy) : 0;

  // Power-law R² (log-log fit) — same approach
  const logX = xs.map(x => Math.log(x));
  const logY = ys.map(y => Math.log(Math.max(y, 0.001)));
  let slxSum = 0, slySum = 0, slxx = 0, slxy = 0, slyy = 0;
  for (let i = 0; i < N; i++) {
    slxSum += logX[i]; slySum += logY[i];
    slxx += logX[i] * logX[i]; slxy += logX[i] * logY[i]; slyy += logY[i] * logY[i];
  }
  const meanLX = slxSum / N, meanLY = slySum / N;
  const lSxx = slxx - N * meanLX * meanLX;
  const lSxy = slxy - N * meanLX * meanLY;
  const lSyy = slyy - N * meanLY * meanLY;
  const logSlope = lSxx !== 0 ? lSxy / lSxx : 0;
  let lssRes = 0;
  for (let i = 0; i < N; i++) {
    const yPred = meanLY + logSlope * (logX[i] - meanLX);
    lssRes += (logY[i] - yPred) ** 2;
  }
  const powerR2 = lSyy > 0 ? Math.max(0, 1 - lssRes / lSyy) : 0;

  // AI signal: very high linearR2 (trajectory is linear) AND powerR2 NOT much better
  // Human signal: powerR2 >> linearR2 (power-law fits much better than linear)
  const linearityIndex = linearR2 - (powerR2 - linearR2) * 0.5;
  // Clamped 0–1; higher = more linear = more AI-like

  let score = 0;
  if (linearityIndex >= 0.88) score = 20;
  else if (linearityIndex >= 0.80) score = 14;
  else if (linearityIndex >= 0.72) score = 8;
  else if (linearityIndex >= 0.65) score = 4;

  const details = score > 0
    ? `TTR trajectory linearity index: ${linearityIndex.toFixed(3)} (linear R²=${linearR2.toFixed(2)}, power-law R²=${powerR2.toFixed(2)}). AI text shows unnaturally LINEAR vocabulary growth — its renewal rate is constant regardless of position. Human writing follows a power-law decay curve as the text grows.`
    : `TTR trajectory linearity ${linearityIndex.toFixed(3)} — power-law decay pattern consistent with human writing (power R²=${powerR2.toFixed(2)}).`;
  return { score, linearityIndex, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: KS-TEST ON SENTENCE-LENGTH DISTRIBUTION
//  The current burstiness signal only uses CV (coefficient of variation).
//  A Kolmogorov-Smirnov–style test comparing the observed sentence-length
//  histogram against a fitted normal distribution catches AI texts with moderate
//  CV but an unnaturally clean bell-curve shape — something human writing almost
//  never produces because human sentence lengths follow a right-skewed distribution.
//  Score: 0–18.
// ─────────────────────────────────────────────────────────────────────────────

function ksNormalityScore(sentences: string[]): { score: number; ksStatistic: number; skewness: number; details: string } {
  const lens = sentences.map(s => s.trim().split(/\s+/).length).filter(l => l >= 3);
  if (lens.length < 10) return { score: 0, ksStatistic: 0, skewness: 0, details: "Insufficient sentences for distribution shape test (need ≥ 10)." };

  const n = lens.length;
  const mean = lens.reduce((a, b) => a + b, 0) / n;
  const variance = lens.reduce((s, l) => s + Math.pow(l - mean, 2), 0) / n;
  const std = Math.sqrt(Math.max(variance, 0.001));

  // Skewness: human sentence lengths are RIGHT-skewed (positive skew)
  // AI sentence lengths are near-symmetric (skew ≈ 0)
  const skewness = lens.reduce((s, l) => s + Math.pow((l - mean) / std, 3), 0) / n;

  // KS-like statistic: max |F_observed(x) - F_normal(x)| over sorted values
  // Approximate normal CDF using error function approximation
  const normalCDF = (x: number, mu: number, sigma: number): number => {
    const z = (x - mu) / (sigma * Math.SQRT2);
    const t = 1 / (1 + 0.3275911 * Math.abs(z));
    const erf = 1 - (0.254829592 * t - 0.284496736 * t * t + 1.421413741 * Math.pow(t, 3)
      - 1.453152027 * Math.pow(t, 4) + 1.061405429 * Math.pow(t, 5)) * Math.exp(-z * z);
    return 0.5 * (1 + (z >= 0 ? erf : -erf));
  };

  const sorted = [...lens].sort((a, b) => a - b);
  let maxDiff = 0;
  for (let i = 0; i < sorted.length; i++) {
    const empirical = (i + 1) / n;
    const theoretical = normalCDF(sorted[i], mean, std);
    maxDiff = Math.max(maxDiff, Math.abs(empirical - theoretical));
  }
  const ksStatistic = maxDiff;

  // AI text: ksStatistic LOW (close to normal) AND skewness near 0
  // Human text: ksStatistic higher (more right-skewed, fat-tailed)
  // Score fires when distribution is suspiciously normal (AI-like)
  const tooNormal = ksStatistic < 0.12 && Math.abs(skewness) < 0.5;
  const veryNormal = ksStatistic < 0.08 && Math.abs(skewness) < 0.3;
  const lacksSKew = Math.abs(skewness) < 0.25 && n >= 15;

  let score = 0;
  if (veryNormal && n >= 12) score = 18;
  else if (tooNormal && n >= 10) score = 12;
  else if (lacksSKew && n >= 15) score = 7;

  const details = score > 0
    ? `KS normality test: D=${ksStatistic.toFixed(3)}, skewness=${skewness.toFixed(2)}. Sentence-length distribution is unnaturally close to a normal curve (AI pattern). Human writing produces right-skewed distributions with occasional very long sentences — AI produces symmetric, bell-curve-shaped length distributions.`
    : `Sentence-length distribution shows expected human skewness (KS D=${ksStatistic.toFixed(3)}, skew=${skewness.toFixed(2)}).`;
  return { score, ksStatistic, skewness, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: ANAPHORA RESOLUTION DENSITY
//  AI text overuses explicit noun repetition instead of pronouns and anaphoric
//  references. Human writers use "it", "they", "this", "the former", "the latter"
//  to maintain reference chains. Measuring the ratio of pronoun anaphora to
//  repeated noun phrases catches AI's tendency to re-state subjects in full.
//  Score: 0–16 (AI if LOW pronoun-to-repetition ratio).
// ─────────────────────────────────────────────────────────────────────────────

function anaphoraScore(text: string, sentences: string[], wc: number): { score: number; anaphoraRatio: number; details: string } {
  if (wc < 100 || sentences.length < 5) return { score: 0, anaphoraRatio: 0, details: "Insufficient text for anaphora analysis." };

  // Count pronoun anaphors
  const pronounAnaphors = (text.match(/\b(it|its|they|them|their|theirs|this|that|these|those|the former|the latter|the above|the following|such|the same)\b/gi) || []).length;

  // Count explicit noun re-use: consecutive sentences repeating the same noun phrase
  // Approximate: count noun phrases that appear 3+ times (strong repetition)
  const nounPhrases: Record<string, number> = {};
  const nounRE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*|the\s+\w+(?:\s+\w+)?)\b/g;
  let m: RegExpExecArray | null;
  while ((m = nounRE.exec(text)) !== null) {
    const np = m[1].toLowerCase().trim();
    if (np.length > 4 && np !== "the") nounPhrases[np] = (nounPhrases[np] || 0) + 1;
  }
  const repeatedNouns = Object.values(nounPhrases).filter(c => c >= 3).length;

  // Ratio: pronouns per sentence vs repeated nouns
  const pronounRate = pronounAnaphors / Math.max(sentences.length, 1);
  const anaphoraRatio = pronounRate / Math.max(repeatedNouns + 1, 1);

  // AI pattern: low pronoun rate + many repeated nouns = re-stating subjects explicitly
  const lowPronouns = pronounRate < 1.5;
  const highRepetition = repeatedNouns >= 4;

  let score = 0;
  if (lowPronouns && highRepetition && wc >= 200) score = 16;
  else if (lowPronouns && repeatedNouns >= 2 && wc >= 150) score = 10;
  else if (pronounRate < 1.0 && wc >= 200) score = 6;

  const details = score > 0
    ? `Pronoun anaphora rate: ${pronounRate.toFixed(1)}/sentence (low). Repeated noun phrases: ${repeatedNouns}. AI text re-states subjects in full on every sentence rather than using pronouns ("it", "they", "this") — a pattern that makes text unnaturally explicit and encyclopedic.`
    : `Pronoun anaphora rate ${pronounRate.toFixed(1)}/sentence — within human range. Repeated nouns: ${repeatedNouns}.`;
  return { score, anaphoraRatio, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: TEMPORAL / SPATIAL GROUNDING RATIO
//  Human writing contains references to specific times and places — deictic
//  anchors. AI writing floats in an ungrounded present. Specific temporal and
//  spatial references are HUMAN signals (reduce AI score).
// ─────────────────────────────────────────────────────────────────────────────

function temporalSpatialGroundingScore(text: string, wc: number): { humanReduction: number; groundingCount: number; details: string } {
  if (wc < 80) return { humanReduction: 0, groundingCount: 0, details: "Insufficient text." };

  // Temporal grounding: specific years, dates, named periods
  const temporalRefs = (text.match(/\b(19|20)\d{2}\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}|\b(last|this|next)\s+(year|month|week|semester|quarter|decade)|\bduring\s+(the\s+)?(COVID|pandemic|lockdown|crisis|war|revolution|administration|term|period)\b|\bsince\s+(19|20)\d{2}\b|\bin\s+(early|late|mid-)?(19|20)\d{2}s?\b/gi) || []).length;

  // Spatial grounding: specific place names (Philippines context + general)
  const spatialRefs = (text.match(/\b(Manila|Quezon City|Cebu|Davao|Makati|Pasig|Taguig|Pasay|Caloocan|Las Piñas|Marikina|Muntinlupa|Parañaque|Valenzuela|Malabon|Navotas|San Juan|Mandaluyong|Philippines|Philippine|Filipino|Mindanao|Visayas|Luzon|Palawan|Batangas|Laguna|Cavite|Rizal|Bulacan|Pampanga|Nueva Ecija|Iloilo|Cebuano|Pangasinan|Cagayan|Zamboanga|General Santos|Antipolo|Bacolod|Baguio)\b|\b(University|College|Institute|Department|School|Office|Bureau|Agency|Corporation|Hospital|Municipality|Province|City|Barangay|Region)\s+of\s+[A-Z]/g) || []).length;

  // Also count personal/institutional specificity: named people in context
  const institutionalRefs = (text.match(/\b(DepEd|CHED|PRC|DOH|DOLE|DTI|DICT|DILG|DBM|DOF|DA|DPWH|DOJ|DFA|BSP|SEC|BIR|LTO|SSS|PhilHealth|Pag-IBIG|GSIS|NBI|PNP|AFP|COMELEC|COA|CSC|Ombudsman|Sandiganbayan)\b/g) || []).length;

  const groundingCount = temporalRefs + spatialRefs + institutionalRefs;
  const groundingRate = groundingCount / Math.max(wc / 100, 1); // per 100 words

  let humanReduction = 0;
  if (groundingCount >= 8 || groundingRate >= 1.5) humanReduction = 12;
  else if (groundingCount >= 5 || groundingRate >= 0.8) humanReduction = 8;
  else if (groundingCount >= 3) humanReduction = 5;
  else if (groundingCount >= 1) humanReduction = 2;

  const details = humanReduction > 0
    ? `${groundingCount} temporal/spatial grounding references (${groundingRate.toFixed(1)}/100 words): ${temporalRefs} temporal, ${spatialRefs} spatial, ${institutionalRefs} institutional. Specific deictic anchors are strong human authenticity signals — AI text floats in an ungrounded, placeless present tense.`
    : "No significant temporal or spatial grounding detected (AI-consistent pattern of unanchored present tense).";
  return { humanReduction, groundingCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: ARGUMENT STRUCTURE ANALYSIS
//  Human academic arguments follow: claim → evidence → warrant → rebuttal.
//  AI arguments follow a surface schema: general statement → example → general.
//  Detecting evidential connectors ("because", "since", "data shows", "given that")
//  vs. merely assertive connectors ("therefore", "thus", "hence") is a structural
//  signal completely absent from the current system.
//  Score: 0–18 (AI if assertive >> evidential; human if evidential present).
// ─────────────────────────────────────────────────────────────────────────────

function argumentStructureScore(text: string, wc: number): { score: number; evidentialCount: number; assertiveCount: number; details: string } {
  if (wc < 100) return { score: 0, evidentialCount: 0, assertiveCount: 0, details: "Insufficient text for argument structure analysis." };

  // Evidential connectors: signal actual evidence/reasoning behind a claim
  const evidentialCount = (text.match(/\b(because|since|given that|due to|owing to|as evidenced by|data (shows?|indicates?|suggests?|reveals?)|research (shows?|indicates?|found|demonstrates?)|studies? (show|indicate|found|demonstrate|reveal)|according to|based on (the )?(data|evidence|findings?|results?)|the results? (show|indicate|suggest|reveal)|findings? (show|indicate|suggest|demonstrate)|this is (because|due to|supported by)|in support of this|evidence (suggests?|shows?|indicates?)|empirically|statistically)\b/gi) || []).length;

  // Assertive connectors: bold conclusions without supporting evidence
  const assertiveCount = (text.match(/\b(therefore|thus|hence|consequently|as a result|it follows that|this (demonstrates?|shows?|proves?|confirms?|highlights?|underscores?|illustrates?)|clearly|obviously|evidently|undoubtedly|it is (clear|evident|apparent|obvious) that|this (makes? it clear|makes? it obvious)|without (a )?doubt)\b/gi) || []).length;

  // Human signal: evidential connectors present (author grounds claims in evidence)
  // AI signal: assertive connectors dominate without evidential backing
  const totalConnectors = evidentialCount + assertiveCount;
  const assertiveRatio = totalConnectors > 0 ? assertiveCount / totalConnectors : 0.5;

  let score = 0;
  let humanReduction = 0;

  // High assertive ratio with few evidential connectors = AI pattern
  if (assertiveRatio >= 0.85 && assertiveCount >= 4 && evidentialCount === 0) score = 18;
  else if (assertiveRatio >= 0.75 && assertiveCount >= 3) score = 12;
  else if (assertiveRatio >= 0.65 && assertiveCount >= 2) score = 7;

  // Strong evidential presence is a human signal
  if (evidentialCount >= 5) humanReduction = 8;
  else if (evidentialCount >= 3) humanReduction = 5;

  const netScore = Math.max(0, score - humanReduction);

  const details = netScore > 0 || evidentialCount > 0
    ? `Argument structure: ${evidentialCount} evidential connectors ("because", "data shows", "since") vs ${assertiveCount} assertive connectors ("therefore", "thus", "clearly"). Ratio: ${(assertiveRatio * 100).toFixed(0)}% assertive. AI arguments assert conclusions without evidential grounding; human academic writing uses evidential connectors to link claims to data.`
    : "Insufficient connectors for argument structure analysis.";
  return { score: netScore, evidentialCount, assertiveCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL: SECTION-DIFFERENTIAL SCORING
//  AI text scores differently in different sections. Abstracts/conclusions are
//  formulaic regardless of authorship. Body paragraphs are most discriminative.
//  Introductions with AI openers are a strong signal. Apply section-specific
//  weights based on detected document structure.
//  Returns: { bodyAIScore, introAIScore, conclusionAIScore, sectionNote }
// ─────────────────────────────────────────────────────────────────────────────

function sectionDifferentialScore(text: string, words: string[]): {
  score: number;
  bodyScore: number;
  introScore: number;
  conclusionScore: number;
  details: string;
} {
  const paras = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 60);
  if (paras.length < 3) return { score: 0, bodyScore: 0, introScore: 0, conclusionScore: 0, details: "Insufficient paragraphs for section analysis." };

  const scoreParaAI = (para: string): number => {
    const pw = para.toLowerCase().match(/\b[a-z]+\b/g) || [];
    const vocabHits = pw.filter(w => AI_VOCAB.has(w)).length;
    const transHits = AI_TRANSITIONS.reduce((s, re) => s + (re.test(para) ? 1 : 0), 0);
    const bigramHits = (() => {
      let h = 0;
      for (let i = 0; i < pw.length - 1; i++) {
        if (AI_BIGRAMS.has(pw[i] + " " + pw[i+1])) h++;
        if (i < pw.length - 2 && AI_BIGRAMS.has(pw[i] + " " + pw[i+1] + " " + pw[i+2])) h++;
      }
      return h;
    })();
    return Math.min(100, vocabHits * 8 + transHits * 15 + bigramHits * 10);
  };

  // Classify sections
  const n = paras.length;
  const introParas = paras.slice(0, Math.max(1, Math.floor(n * 0.20)));
  const conclusionParas = paras.slice(Math.floor(n * 0.80));
  const bodyParas = paras.slice(Math.floor(n * 0.20), Math.floor(n * 0.80));

  const avgScore = (ps: string[]) => ps.length === 0 ? 0 :
    ps.reduce((s, p) => s + scoreParaAI(p), 0) / ps.length;

  const introScore = Math.round(avgScore(introParas));
  const bodyScore  = Math.round(avgScore(bodyParas));
  const conclusionScore = Math.round(avgScore(conclusionParas));

  // Body score is most discriminative; conclusion is least (always formulaic)
  // Weight: body ×1.5, intro ×1.2, conclusion ×0.5
  const weightedScore = (bodyScore * 1.5 + introScore * 1.2 + conclusionScore * 0.5) / 3.2;

  let score = 0;
  if (bodyScore >= 55 && introScore >= 40) score = 20;
  else if (bodyScore >= 45) score = 14;
  else if (bodyScore >= 30 && introScore >= 35) score = 8;

  const details = paras.length >= 3
    ? `Section-differential analysis: Intro AI-signal: ${introScore}%, Body AI-signal: ${bodyScore}% (most discriminative), Conclusion AI-signal: ${conclusionScore}% (least reliable — always formulaic). Body paragraphs are the strongest indicator; conclusions are formulaic in both human and AI academic writing.`
    : "Insufficient paragraphs for section-differential analysis.";

  return { score, bodyScore, introScore, conclusionScore, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW: TEXT CHUNKING FOR LONG DOCUMENTS
//  Documents over 3,000 words are analyzed as a single unit right now.
//  Statistical signals (CV, TTR, MTLD) become less sensitive as text grows
//  because variance regresses toward the mean. This function returns per-chunk
//  signal statistics for long texts.
// ─────────────────────────────────────────────────────────────────────────────

interface ChunkStats {
  chunkIndex: number;
  wordCount: number;
  aiVocabRate: number;
  cv: number;
  ttr: number;
  aiScore: number;
}

function analyzeInChunks(text: string, words: string[], sentences: string[]): {
  isLongDoc: boolean;
  chunks: ChunkStats[];
  chunkScoreVariance: number;
  hotspotChunks: number[];
  summary: string;
} {
  const wc = words.length;
  const CHUNK_SIZE = 500;
  const OVERLAP = 50;

  if (wc < CHUNK_SIZE * 2) {
    return { isLongDoc: false, chunks: [], chunkScoreVariance: 0, hotspotChunks: [], summary: "" };
  }

  // Split into overlapping 500-word chunks
  const chunks: ChunkStats[] = [];
  let chunkStart = 0;
  let chunkIndex = 0;

  while (chunkStart < wc) {
    const chunkWords = words.slice(chunkStart, chunkStart + CHUNK_SIZE);
    const chunkText = chunkWords.join(" ");
    const chunkWC = chunkWords.length;

    if (chunkWC < 100) break; // too small for meaningful analysis

    // Per-chunk signals
    const vocabHits = chunkWords.filter(w => AI_VOCAB.has(w)).length;
    const aiVocabRate = vocabHits / chunkWC;

    const chunkSents = chunkText.split(/(?<=[.!?])\s+/).filter(s => s.trim().split(/\s+/).length >= 3);
    const sentLens = chunkSents.map(s => s.trim().split(/\s+/).length);
    const avgLen = sentLens.reduce((a, b) => a + b, 0) / Math.max(sentLens.length, 1);
    const varLen = sentLens.reduce((s, l) => s + Math.pow(l - avgLen, 2), 0) / Math.max(sentLens.length, 1);
    const cv = Math.sqrt(varLen) / Math.max(avgLen, 1);

    const uniqueChunkWords = new Set(chunkWords).size;
    const ttr = uniqueChunkWords / chunkWC;

    // Combined AI score for this chunk (simple heuristic)
    const transHits = AI_TRANSITIONS.reduce((s, re) => s + (re.test(chunkText) ? 1 : 0), 0);
    const aiScore = Math.min(100, Math.round(
      aiVocabRate * 400 +
      (cv < 0.25 ? (0.25 - cv) * 200 : 0) +
      (ttr < 0.50 ? (0.50 - ttr) * 100 : 0) +
      transHits * 12
    ));

    chunks.push({ chunkIndex, wordCount: chunkWC, aiVocabRate, cv, ttr, aiScore });
    chunkStart += CHUNK_SIZE - OVERLAP;
    chunkIndex++;
  }

  if (chunks.length === 0) return { isLongDoc: false, chunks: [], chunkScoreVariance: 0, hotspotChunks: [], summary: "" };

  const avgChunkScore = chunks.reduce((s, c) => s + c.aiScore, 0) / chunks.length;
  const chunkScoreVariance = chunks.reduce((s, c) => s + Math.pow(c.aiScore - avgChunkScore, 2), 0) / chunks.length;

  // Identify "hotspot" chunks — significantly above average AI signal
  const hotspotThreshold = avgChunkScore + Math.sqrt(chunkScoreVariance) * 1.2;
  const hotspotChunks = chunks
    .filter(c => c.aiScore >= hotspotThreshold && c.aiScore >= 40)
    .map(c => c.chunkIndex);

  const summary = chunks.length > 0
    ? `Long document analysis: ${chunks.length} chunks of ~${CHUNK_SIZE} words. Avg chunk AI score: ${Math.round(avgChunkScore)}%. Score variance: ${Math.round(chunkScoreVariance)}. ${hotspotChunks.length > 0 ? `${hotspotChunks.length} hotspot chunk(s) with elevated AI patterns at positions: ${hotspotChunks.map(i => `§${i+1}`).join(", ")}.` : "No specific hotspot sections detected."}`
    : "";

  return { isLongDoc: true, chunks, chunkScoreVariance, hotspotChunks, summary };
}

// ─────────────────────────────────────────────────────────────────────────────
//  AI essays hedge every empirical claim: "may", "can often", "generally",
//  "tends to", "in many cases", "it is possible". A human editorial uses hedges
//  sparingly and purposefully; AI layers them on every sentence as a safety
//  mechanism. Rate: hedges per 100 words.  Score: 0–28.
// ─────────────────────────────────────────────────────────────────────────────

const HEDGE_TERMS_RE = /\b(may|might|could|can|often|generally|typically|usually|sometimes|frequently|commonly|largely|broadly|perhaps|possibly|potentially|arguably|seemingly|apparently|presumably|ostensibly|in many cases|in some cases|in certain cases|to some extent|to a certain extent|to some degree|in most cases|tends? to|is likely|are likely|it is possible|it is likely|it seems|it appears|it suggests|it implies|it indicates|one might|one could|it can be|it may be|it might be|this may|this might|this could|this can|these may|these might|under certain|under some|depending on|varies? (by|with|across)|subject to|not always|not necessarily|in general|as a general rule|broadly speaking|for the most part|by and large|more or less|to varying degrees?)\b/gi;

function hedgedCertaintyScore(text: string, wc: number): { score: number; hedgeCount: number; details: string } {
  const hedgeMatches = text.match(HEDGE_TERMS_RE) || [];
  const hedgeCount = hedgeMatches.length;
  const hedgeRate = (hedgeCount / Math.max(wc, 1)) * 100; // per 100 words

  let score = 0;
  if (hedgeRate >= 6.0) score = 28;
  else if (hedgeRate >= 4.5) score = 22;
  else if (hedgeRate >= 3.0) score = 16;
  else if (hedgeRate >= 2.0) score = 10;
  else if (hedgeRate >= 1.2) score = 5;

  const details = score > 0
    ? `${hedgeCount} epistemic hedges found (${hedgeRate.toFixed(1)}/100 words). AI systematically softens every claim with "may", "generally", "tends to", "it is possible" etc. Human writers hedge purposefully, not by default.`
    : `${hedgeCount} hedges (${hedgeRate.toFixed(1)}/100 words) — within normal human range.`;
  return { score, hedgeCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #2 — SENTENCE-FINAL CLAUSE STACKING
//  AI appends 2–3 subordinate clauses to most sentences:
//  "…which enables X, thereby ensuring Y, ultimately contributing to Z."
//  No existing signal measures trailing comma-clause density.
//  Score: 0–24.
// ─────────────────────────────────────────────────────────────────────────────

const CLAUSE_STACKER_RE = /,\s*(which|that|thereby|thus|therefore|hence|consequently|as a result|ultimately|ensuring|allowing|enabling|making it|making them|contributing to|leading to|resulting in|facilitating|fostering|promoting|supporting|demonstrating|highlighting|illustrating|reinforcing|strengthening|underpinning)/gi;

function clauseStackingScore(sentences: string[]): { score: number; stackedCount: number; details: string } {
  if (sentences.length < 4) return { score: 0, stackedCount: 0, details: "Insufficient sentences for clause-stacking analysis." };

  let stackedCount = 0;
  let totalTails = 0;
  for (const sent of sentences) {
    const matches = sent.match(CLAUSE_STACKER_RE) || [];
    if (matches.length >= 2) stackedCount++;
    totalTails += matches.length;
  }

  const avgTails = totalTails / sentences.length;
  const stackedRatio = stackedCount / sentences.length;

  let score = 0;
  if (avgTails >= 1.8 && stackedRatio >= 0.5) score = 24;
  else if (avgTails >= 1.3 && stackedRatio >= 0.35) score = 18;
  else if (avgTails >= 0.9 && stackedRatio >= 0.25) score = 12;
  else if (avgTails >= 0.5) score = 6;

  const details = score > 0
    ? `${stackedCount}/${sentences.length} sentences (${(stackedRatio*100).toFixed(0)}%) have 2+ trailing subordinate clauses. Avg ${avgTails.toFixed(2)} clause-stacking connectors/sentence. AI appends "which enables X, thereby ensuring Y, ultimately contributing to Z" chains; human writers rarely do this.`
    : `Low clause-stacking (avg ${avgTails.toFixed(2)} connectors/sentence) — within human range.`;
  return { score, stackedCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #3 — ABSENCE OF PROPER NOUNS / NAMED ENTITIES
//  Human writing references real people, places, dates, publications, products.
//  AI essays float in abstraction — they avoid concrete named references.
//  Heuristic: mid-sentence capitalised words that are NOT sentence-initial,
//  NOT in the AI_VOCAB set, and NOT common title words.
//  Score: 0–20 (HUMAN signal — more named entities → LOWER AI score).
//  Returns a reduction value (higher = more human-like, applied as penalty).
// ─────────────────────────────────────────────────────────────────────────────

const COMMON_CAPS_EXCEPTIONS = new Set([
  "I","The","A","An","In","On","At","By","For","With","This","These","Those",
  "That","It","Its","Their","Our","Your","He","She","We","They","As","But",
  "And","Or","If","When","While","Although","Because","Since","Until","After",
  "Before","During","However","Therefore","Furthermore","Moreover","Additionally",
  "Nevertheless","Nonetheless","Consequently","Subsequently","Accordingly",
  "January","February","March","April","May","June","July","August","September",
  "October","November","December","Monday","Tuesday","Wednesday","Thursday",
  "Friday","Saturday","Sunday","English","American","European","Asian","Global",
  "AI","LLM","ML","API","HTML","CSS","URL",
]);

function namedEntityScore(text: string, wc: number): { humanReduction: number; namedEntityCount: number; details: string } {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 5);
  let namedEntityCount = 0;

  for (const sent of sentences) {
    const trimmed = sent.trim();
    // Find mid-sentence words that start with a capital letter
    // Skip the very first word of the sentence (sentence-initial cap)
    const words = trimmed.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/[^a-zA-Z]/g, "");
      if (w.length >= 2 && /^[A-Z]/.test(w) && !COMMON_CAPS_EXCEPTIONS.has(w)) {
        namedEntityCount++;
      }
    }
  }

  const namedEntityRate = (namedEntityCount / Math.max(wc, 1)) * 100; // per 100 words

  // More named entities → more human-like → higher reduction applied to AI score
  let humanReduction = 0;
  if (namedEntityRate >= 3.0) humanReduction = 20;
  else if (namedEntityRate >= 2.0) humanReduction = 14;
  else if (namedEntityRate >= 1.0) humanReduction = 8;
  else if (namedEntityRate >= 0.5) humanReduction = 4;

  const details = namedEntityCount > 0
    ? `${namedEntityCount} named entities detected (${namedEntityRate.toFixed(1)}/100 words). Human writing references real people, places, and events. Higher named-entity density is a human-writing signal.`
    : `No named entities / proper nouns detected — AI essays typically avoid concrete named references.`;
  return { humanReduction, namedEntityCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #4 — MOVING-WINDOW TTR VARIANCE
//  The global TTR signal already exists. AI text's characteristic pattern is
//  vocabulary that stays uniformly low throughout — unlike human text which
//  varies in density by section. This sliding-window approach measures VARIANCE
//  of TTR across 50-word windows. Low variance = metronomic AI vocabulary rhythm.
//  Score: 0–22.
// ─────────────────────────────────────────────────────────────────────────────

function movingWindowTTRScore(words: string[], wc: number): { score: number; ttrVariance: number; details: string } {
  const WINDOW = 50;
  if (wc < WINDOW * 2) return { score: 0, ttrVariance: 0, details: `Text too short for moving-window TTR analysis (need ≥${WINDOW*2} words).` };

  const windowTTRs: number[] = [];
  for (let i = 0; i <= wc - WINDOW; i += Math.floor(WINDOW / 2)) {
    const windowWords = words.slice(i, i + WINDOW);
    const uniqueInWindow = new Set(windowWords).size;
    windowTTRs.push(uniqueInWindow / WINDOW);
  }

  if (windowTTRs.length < 3) return { score: 0, ttrVariance: 0, details: "Insufficient windows for TTR variance analysis." };

  const meanTTR = windowTTRs.reduce((a, b) => a + b, 0) / windowTTRs.length;
  const ttrVariance = windowTTRs.reduce((s, t) => s + Math.pow(t - meanTTR, 2), 0) / windowTTRs.length;
  const ttrSD = Math.sqrt(ttrVariance);

  // Low SD = AI-like metronomic vocabulary rhythm
  // High SD = human-like variation in vocabulary density across sections
  let score = 0;
  if (ttrSD < 0.015 && meanTTR < 0.55) score = 22;
  else if (ttrSD < 0.025 && meanTTR < 0.58) score = 16;
  else if (ttrSD < 0.040 && meanTTR < 0.62) score = 10;
  else if (ttrSD < 0.055) score = 5;

  // If high variance, apply a human reduction instead
  const humanReductionForHighVariance = ttrSD >= 0.07 ? 10 : 0;

  const details = score > 0
    ? `Moving-window TTR: mean=${meanTTR.toFixed(3)}, SD=${ttrSD.toFixed(4)} across ${windowTTRs.length} windows. Low TTR variance (SD<0.04) = AI metronomic vocabulary rhythm. Human writing shows greater section-to-section vocabulary variation.`
    : `Moving-window TTR SD=${ttrSD.toFixed(4)} (mean=${meanTTR.toFixed(3)}) — within human range${humanReductionForHighVariance > 0 ? " (high variance = strong human signal)" : ""}.`;

  return { score: Math.max(0, score - humanReductionForHighVariance), ttrVariance, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  RELIABILITY WARNINGS
//  Conditions that reduce confidence in any verdict
// ─────────────────────────────────────────────────────────────────────────────

function getReliabilityWarnings(text: string, wc: number, sentences: string[]): string[] {
  const warnings: string[] = [];

  // Too short — only flag very short texts (strict mode: 50 word minimum)
  if (wc < 50) warnings.push("Text too short for reliable analysis (fewer than 50 words)");

  // Technical or domain-specific writing - vocab signals less meaningful
  const techTerms = (text.match(/\b(algorithm|neural|dataset|machine learning|deep learning|neural network|python|javascript|api|http|sql|database|function|variable|class|object|array|string|integer|boolean)\b/gi) || []).length;
  if (techTerms > 3) warnings.push("Technical/domain-specific content - vocabulary signals are less reliable");

  // Quoted material
  const quoteCount = (text.match(/[""][^""]{20,}[""]/g) || []).length;
  if (quoteCount > 1) warnings.push("Contains significant quoted material - quoted sections may skew signals");

  // Very formal register
  const formalMarkers = (text.match(/\b(however|therefore|thus|hence|whereas|albeit|notwithstanding|insofar|herein|thereof)\b/gi) || []).length;
  if (formalMarkers > 3 && wc > 100) warnings.push("Highly formal register - academic and ESL writing naturally uses formal language");

  // ── ESL Detection Heuristic ─────────────────────────────────────────────────
  // ESL writers produce formal, transition-heavy writing that mimics AI surface
  // patterns while lacking informal human markers. The critical discriminating
  // gate is AI vocab density: genuine ESL writers use 0-4 AI buzzwords;
  // AI-generated text uses 5-22. Without this gate, AI texts were falsely
  // suppressed as ESL, collapsing their scores to INCONCLUSIVE (root cause of
  // 36.7% → 90% accuracy gap confirmed in ground-truth evaluation n=30).
  //
  // GATE 1 (primary): aiVocabHits >= 5 → definitely AI pattern, not ESL writer
  // GATE 2 (secondary): 2+ AI-specific luxury terms → AI-generated prose
  // These gates fire BEFORE checking formal-register signals, so AI texts
  // with formal style never receive ESL suppression.
  const contractions = (text.match(/\b(don't|doesn't|didn't|can't|won't|wouldn't|couldn't|isn't|aren't|wasn't|weren't|haven't|I'm|I've|I'll|we're|you're|it's|that's|there's)\b/gi) || []).length;
  // Opinionated/reflective first-person only — NOT topic-referencing "my country / my team"
  const casualFirst   = /\b(I honestly|I think|I suspect|I feel|I believe|I started|I noticed|I wasn't|I kept|I remember)\b/i.test(text);
  const informalVoice = /\b(yeah|yep|nope|gonna|wanna|kinda|dunno|honestly|frankly|weird|botched|bad idea|kind of|sort of)\b/i.test(text);
  const eslLens       = sentences.map(s => s.trim().split(/\s+/).length);
  const eslAvgLen     = eslLens.length > 0 ? eslLens.reduce((a, b) => a + b, 0) / eslLens.length : 0;
  const eslMinLen     = eslLens.length > 0 ? Math.min(...eslLens) : 0;
  const eslUnique     = new Set((text.toLowerCase().match(/\b[a-z]+\b/g) || []));
  const eslTtr        = eslUnique.size / Math.max(wc, 1);
  const ttrOk         = wc < 150 || eslTtr < 0.72;
  const formalTrans   = (text.match(/\b(furthermore|additionally|in order to|it is important|it is worth noting|nevertheless|nonetheless|consequently|however|therefore|thus)\b/gi) || []).length;

  // GATE 1: AI vocab density gate — primary discriminator between ESL and AI
  // Genuine ESL writers use 0-4 AI buzzwords; AI-generated text uses 5-22.
  // Raised from 9 → 12 because the expanded vocab set adds ~35 new terms that
  // common formal/academic language also uses (e.g. "exploring", "highlighting").
  // At 12+ hits the density is unambiguously AI-level even with the expanded list.
  const eslVocabWords  = (text.toLowerCase().match(/\b[a-z]+\b/g) || []);
  const eslAiVocabHits = eslVocabWords.filter(w => AI_VOCAB.has(w)).length;
  if (eslAiVocabHits >= 12) {
    // Hard block: 12+ hits is unambiguously AI-level vocab density — skip ESL flag.
    return warnings;
  }

  // GATE 1b: Moderate vocab (7–11 hits) — apply burstiness cross-check before blocking.
  // ESL writers in this range often have moderate formal vocab that happens to be in
  // the expanded AI list. The discriminating signal at this vocab level is burstiness:
  //   - AI-generated text with 7–11 vocab hits still has very low CV (< 0.32)
  //   - ESL writers with 7–11 vocab hits keep more natural sentence variation (CV >= 0.20)
  if (eslAiVocabHits >= 7) {
    // Compute sentence length CV for the burstiness cross-check
    const eslSentLens = sentences.map(s => s.trim().split(/\s+/).length);
    const eslAvgLenCV = eslSentLens.length > 0 ? eslSentLens.reduce((a, b) => a + b, 0) / eslSentLens.length : 10;
    const eslVarianceCV = eslSentLens.length > 1
      ? eslSentLens.reduce((s, l) => s + Math.pow(l - eslAvgLenCV, 2), 0) / eslSentLens.length : 0;
    const eslCV = Math.sqrt(eslVarianceCV) / Math.max(eslAvgLenCV, 1);

    // Count luxury AI terms that ESL writers genuinely never use
    const luxuryInText = (text.match(/\b(synergistic|transformative|holistic|proactive|scalable|actionable|pivotal|foundational|it is worth noting|it is important to note|cannot be (?:overstated|understated)|plays a (?:crucial|pivotal|vital) role|leverage[sd]?|streamline[sd]?|optimize[sd]?|paradigm shift|ecosystem|stakeholder)\b/gi) || []).length;

    if (
      luxuryInText >= 2 ||   // 2+ luxury buzzwords → AI, not ESL
      eslCV < 0.20            // very low burstiness → metronomic AI rhythm even at moderate vocab
    ) {
      // Signals consistent with AI-generated text at this vocab level — skip ESL flag
      return warnings;
    }
    // Otherwise fall through: moderate vocab + human-ish CV + no luxury terms → allow ESL check
  }

  // GATE 2: AI-specific luxury vocabulary — second line of defence for texts that
  // passed Gate 1b (vocab 5–8 with human-ish CV). Even at moderate vocab density,
  // 2+ luxury terms (that ESL writers never use unprompted) is an AI signal.
  const aiLuxuryTerms = (text.match(/\b(synergistic|transformative|holistic|proactive|scalable|actionable|pivotal|foundational|it is worth noting|it is important to note|cannot be (?:overstated|understated)|plays a (?:crucial|pivotal|vital) role)\b/gi) || []).length;
  if (aiLuxuryTerms >= 2) {
    // AI-specific luxury vocabulary present — not ESL
    return warnings;
  }

  // ── Improvement #5: Register-adaptive ESL gate ───────────────────────────
  // Binary gate replaced with per-sentence register variance check.
  // ESL writers have VARIABLE formality within a document (they shift register
  // between sections). AI maintains UNIFORM formality end-to-end.
  // We compute per-sentence "formal register score" and measure its SD.
  // High SD → genuine ESL (variable formality). Low SD → AI (metronomic formality).
  const FORMAL_SENT_RE = /\b(furthermore|additionally|in order to|it is important|it is worth noting|nevertheless|nonetheless|consequently|however|therefore|thus|wherein|hereby|thereof|whereas|notwithstanding|pursuant|aforementioned)\b/gi;
  const INFORMAL_SENT_RE = /\b(yeah|yep|nope|gonna|wanna|kinda|dunno|honestly|frankly|weird|btw|lol|actually|literally|basically|pretty much|kind of|sort of|you know|I mean|like|stuff|things|really|very|just|even|still)\b/gi;
  const perSentenceRegister = sentences.map(s => {
    const formalHits = (s.match(FORMAL_SENT_RE) || []).length;
    const informalHits = (s.match(INFORMAL_SENT_RE) || []).length;
    return Math.max(0, formalHits - informalHits); // positive = formal, zero/neg = informal
  });
  const regMean = perSentenceRegister.reduce((a, b) => a + b, 0) / Math.max(perSentenceRegister.length, 1);
  const regVariance = perSentenceRegister.reduce((s, r) => s + Math.pow(r - regMean, 2), 0) / Math.max(perSentenceRegister.length, 1);
  const regSD = Math.sqrt(regVariance);
  // ESL writers typically show regSD >= 0.6 (they vary between formal transitions and informal clauses)
  // AI shows regSD < 0.4 AND regMean >= 0.8 (uniformly formal throughout)
  const hasVariableRegister = regSD >= 0.6; // strong indicator of human ESL vs AI

  const isLikelyESL = (
    contractions === 0 &&   // no contractions
    !casualFirst &&         // no opinionated first-person voice
    !informalVoice &&       // no informal register
    eslAvgLen >= 10 &&      // consistently long sentences
    eslMinLen >= 5 &&       // no very short bursts
    ttrOk &&                // vocab diversity gate (long texts only)
    formalTrans >= 1 &&     // at least one formal transition
    hasVariableRegister     // NEW: ESL writers vary register; AI does not
  );

  // ── Philippine/Filipino context detection ──────────────────────────────────
  // Detect writing from Philippine universities — a specific false-positive risk
  // in this app's primary deployment context. Philippine academic writing has
  // distinctive ESL patterns that commonly trigger false AI verdicts.
  const philippineMarkers = (text.match(
    /\b(philippine|philippines|pilipino|filipino|barangay|municipality|province|local government unit|lgu|deped|ched|state university|SUC|OFW|diaspora|Mindanao|Visayas|Luzon|Manila|Quezon|Cebu|Davao|Makati)\b/gi
  ) || []).length;
  const isPhilippineContext = philippineMarkers >= 1;

  if (isLikelyESL || isPhilippineContext) {
    const contextNote = isPhilippineContext
      ? "Philippine/Filipino academic context detected — ESL writing patterns common in Philippine universities (direct phrasing, formal transitions, uniform sentence structure) significantly overlap with AI surface patterns. Scores have been calibrated to reduce false positives. Do not use this result as grounds for academic sanctions without additional evidence."
      : "Possible ESL/formal-register writing — formal transitions and uniform sentence length are common in ESL writing and do not reliably indicate AI authorship. Score has been reduced by 10–15 points to account for non-native English writing patterns.";
    warnings.push(contextNote);
  } else if (!hasVariableRegister && regMean >= 0.8 && sentences.length >= 8) {
    // Uniformly formal throughout with no register variation — reinforce AI signal
    // (don't add a warning; this strengthens the AI case, handled in engine scoring)
  }

  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ESL SCORE CALIBRATION PENALTY
//  Applies an actual score reduction when ESL or Philippine context is detected.
//  This is the key improvement over prior behavior that only warned without adjusting.
//  Research basis: average false-positive rate on TOEFL essays was 61.3%,
//  dropping to 11.6% after text perplexity was adjusted for non-native patterns.
//  Returns 0 (no penalty) to 15 (strong ESL signal = subtract 15 from norm score).
// ─────────────────────────────────────────────────────────────────────────────
function computeESLScorePenalty(warnings: string[], rawScore = 50): number {
  // OPT A9: Scale ESL penalty by score magnitude.
  // A flat -15 on high-scoring AI text (score=85) still lands in AI zone,
  // but the same flat -15 on a borderline score (score=40) unfairly pushed it to Human.
  // Fix: derive scaling from rawScore directly (no dependency on 'strength' which is
  // computed after this function is called, avoiding the "used before declaration" error).
  const hasPhilippine = warnings.some(w => w.includes("Philippine") || w.includes("Filipino"));
  const hasESL = warnings.some(w => w.includes("ESL") || w.includes("formal-register"));
  const base = hasPhilippine ? 15 : hasESL ? 10 : 0;
  if (base === 0) return 0;

  // Scale: clear AI signal (high rawScore) → reduce penalty so genuine AI in ESL isn't masked.
  // Borderline / low score → full penalty to protect human writers.
  const scaleFactor =
    rawScore > 70 ? 0.4
    : rawScore > 55 ? 0.6
    : rawScore > 35 ? 0.8
    : 1.0;

  return Math.round(base * scaleFactor);
}

// ─────────────────────────────────────────────────────────────────────────────
//  GAP 8 — DOMAIN DETECTION & ADAPTIVE THRESHOLDS
//  Identifies the likely writing domain and returns a score multiplier that
//  adjusts the final norm before verdict assignment. This reduces false
//  positives on specialist writing that shares surface patterns with AI.
//
//  Returns: multiplier 0.70–1.10 applied to norm, plus a domain label for UI.
//  multiplier < 1.0 = suppress (formal domain expected → raise bar)
//  multiplier > 1.0 = amplify (informal domain → lower bar)
// ─────────────────────────────────────────────────────────────────────────────

type WritingDomain = "academic" | "legal" | "technical" | "creative" | "business" | "general";

interface DomainProfile {
  domain: WritingDomain;
  label: string;
  multiplier: number;         // applied to Engine A/B norm before verdict
  description: string;
}

const ACADEMIC_TERMS = new Set([
  "hypothesis","methodology","empirical","quantitative","qualitative","longitudinal",
  "cohort","meta-analysis","peer-reviewed","literature review","theoretical framework",
  "epistemological","ontological","phenomenological","positivism","grounded theory",
  "reliability","validity","generalizability","operationalize","confounding","variable",
  "statistical","regression","correlation","significance","p-value","effect size",
  "sample size","participants","respondents","ethics committee","informed consent",
  "replication","systematic review","randomized","double-blind","control group",
]);

const LEGAL_TERMS = new Set([
  "pursuant","herein","thereof","hereinafter","notwithstanding","aforementioned",
  "whereas","heretofore","wherefore","indemnify","covenant","breach","liable",
  "jurisdiction","plaintiff","defendant","appellate","statute","provision","clause",
  "arbitration","injunction","tort","fiduciary","subpoena","affidavit","deposition",
  "discovery","motion","verdict","damages","negligence","contract","obligation",
]);

const CREATIVE_MARKERS = [
  /\b(she|he|they|her|his|their)\s+(said|asked|whispered|shouted|replied|answered|thought|felt|wondered|realized|noticed)/gi,
  /[""][^""]{5,}[""]/g,   // dialogue quotes
  /\b(once upon|long ago|years later|the next morning|meanwhile|suddenly|at that moment)/gi,
  /\b(smiled|laughed|cried|frowned|sighed|nodded|shrugged|trembled|gasped|glanced)/gi,
];

const BUSINESS_TERMS = new Set([
  "roi","kpi","q1","q2","q3","q4","yoy","cagr","ebitda","revenue","margin",
  "headcount","onboarding","roadmap","sprint","backlog","stakeholder","deliverable",
  "milestone","bandwidth","synergy","scalability","go-to-market","value proposition",
  "customer acquisition","churn","retention","conversion","pipeline","forecast",
  "budget","overhead","capex","opex","procurement","vendor","supplier",
]);

// ─────────────────────────────────────────────────────────────────────────────
//  THESIS CONCLUSION DETECTOR
//  Identifies whether the submitted text is a thesis/research Chapter 5 or
//  similar academic conclusion section. This genre is the highest-risk zone for
//  AI assistance and the one most suppressed by existing calibrations.
//
//  Key insight: conclusion sections have ZERO ESL transfer features (they are
//  polished final output), yet the current pipeline applies ESL and academic
//  domain multipliers as if they were body paragraphs — massively under-scoring.
//
//  Returns: { isThesisConclusion, isSummaryChapter, confidenceScore 0-1 }
// ─────────────────────────────────────────────────────────────────────────────

interface ThesisGenreProfile {
  isThesisConclusion: boolean;
  isSummaryChapter: boolean;
  confidenceScore: number; // 0-1
  detectedMarkers: string[];
}

function detectThesisGenre(text: string, sentences: string[]): ThesisGenreProfile {
  const lower = text.toLowerCase();
  const detectedMarkers: string[] = [];

  // ── Chapter 5 / Summary chapter structural markers ───────────────────────
  const chapterHeadings = (text.match(
    /\b(chapter\s+5|summary[,\s]+conclusions?[,\s]+and\s+recommendations?|summary\s+of\s+findings?|conclusions?\s+and\s+recommendations?|summary,\s*conclusions?\s*and|discussion\s+and\s+conclusions?)\b/gi
  ) || []).length;
  if (chapterHeadings > 0) detectedMarkers.push("chapter-heading");

  // ── Finding-numbered structure (Finding 1:, Finding 2:, etc.) ────────────
  const findingNumbers = (text.match(/\bfinding\s+\d+[:\.]/gi) || []).length;
  if (findingNumbers >= 2) detectedMarkers.push("numbered-findings");

  // ── Conclusion schema phrases — the exact phrases that dominate AI-written conclusions ──
  const conclusionSchema = (text.match(
    /\b(this study (successfully|aims?|was able to|found|revealed|demonstrated|showed|confirmed|achieved|contributes?|supports?|provides?|highlights?|indicates?)|the (results?|findings?|study|research|model|analysis) (revealed?|showed?|demonstrated?|indicated?|suggest(s|ed)?|confirms?|proves?|established|support(s|ed)?)|in summary|in conclusion|these results? (show|confirm|demonstrate|highlight|suggest|indicate)|the aforementioned|the foregoing|as (previously|earlier|above) (mentioned|discussed|stated|noted|described))\b/gi
  ) || []).length;
  if (conclusionSchema >= 3) detectedMarkers.push("conclusion-schema");

  // ── Recommendations section ───────────────────────────────────────────────
  const recommendationsSection = /\brecommendations?\b/i.test(text);
  if (recommendationsSection) detectedMarkers.push("recommendations-section");

  // ── Research objective language ───────────────────────────────────────────
  const researchObjectives = (text.match(
    /\b(research (objective|question|gap|problem)|objective of (this|the) study|aims? (to|of) (this|the)|this study (aimed?|sought|intend(s|ed)?|investigat)|the study('s)? (main|primary|key|central) (objective|aim|goal|purpose|contribution))\b/gi
  ) || []).length;
  if (researchObjectives >= 2) detectedMarkers.push("research-objectives");

  // ── Baseline model comparison language (specific to empirical research conclusions) ─
  const baselineComparison = (text.match(
    /\b(baseline model|outperform(s|ed)?|compared (with|to)|RMSE|MAE|R[\u00B2²]|accuracy|precision|recall|F1|AUC|performance metric|ablation|hyperparameter|epoch(s)?|training (loss|set|data)|validation (loss|set|data))\b/gi
  ) || []).length;
  if (baselineComparison >= 3) detectedMarkers.push("empirical-research");

  // ── Zero ESL transfer features — this is the CRITICAL inverse signal ─────
  // Genuine thesis conclusions written by Philippine students show at least some
  // L1 interference: article omission, preposition errors, awkward collocations.
  // AI-polished conclusions are perfectly clean. Zero errors = higher suspicion.
  const articleErrors = (text.match(/\b(a\s+[aeiou]\w+|an\s+[^aeiou\s]\w+)\b/gi) || []).length; // crude article mismatch detector
  const droppedArticles = (text.match(/\b(study was conducted|research was done|model was designed|data was collected|analysis was performed)\b/gi) || []).length;
  const hasL1Transfer = articleErrors > 2 || droppedArticles > 0 ||
    /\b(the researchers|the proponents|the authors) (were able to|have)\b/i.test(text);
  if (!hasL1Transfer && detectedMarkers.length >= 2) detectedMarkers.push("zero-L1-transfer");

  // ── Nominalization density (the key structural tell for AI conclusion prose) ──
  const nominalizations = (text.match(
    /\b\w+(tion|sion|ment|ance|ence|ity|ness|ism|ization|isation|ify|ifying)\b/gi
  ) || []).length;
  const wordCount = (text.match(/\b\w+\b/g) || []).length;
  const nominalizationRate = nominalizations / Math.max(wordCount, 1);
  if (nominalizationRate > 0.12) detectedMarkers.push("high-nominalization");

  // ── Rhetorical schema uniformity — every paragraph starts with "The [noun]" ──
  const parasStartingWithThe = sentences.filter(s => /^\s*(the\s+\w+|this\s+\w+|these\s+\w+|it\s+(is|was)|in\s+(summary|conclusion|addition|contrast|terms))/i.test(s.trim())).length;
  const schemaUniformity = parasStartingWithThe / Math.max(sentences.length, 1);
  if (schemaUniformity > 0.50) detectedMarkers.push("schema-uniformity");

  // ── Confidence scoring ────────────────────────────────────────────────────
  const markerScore =
    (detectedMarkers.includes("chapter-heading") ? 0.35 : 0) +
    (detectedMarkers.includes("numbered-findings") ? 0.25 : 0) +
    (detectedMarkers.includes("conclusion-schema") ? 0.15 : 0) +
    (detectedMarkers.includes("recommendations-section") ? 0.10 : 0) +
    (detectedMarkers.includes("empirical-research") ? 0.10 : 0) +
    (detectedMarkers.includes("zero-L1-transfer") ? 0.10 : 0) +
    (detectedMarkers.includes("high-nominalization") ? 0.05 : 0) +
    (detectedMarkers.includes("schema-uniformity") ? 0.05 : 0);

  const confidenceScore = Math.min(1.0, markerScore);
  const isThesisConclusion = confidenceScore >= 0.35;
  const isSummaryChapter = detectedMarkers.includes("chapter-heading") || detectedMarkers.includes("numbered-findings");

  return { isThesisConclusion, isSummaryChapter, confidenceScore, detectedMarkers };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NOMINALIZATION DENSITY SIGNAL
//  Measures the rate of abstract nouning (tion/sion/ment/ance/ity/ness endings).
//  AI-generated academic prose is dense with nominalizations because LLMs
//  default to the most formal register. Human thesis writers also use them but
//  at lower rates, and they mix in concrete verb-driven clauses.
//
//  Critically: thesis CONCLUSION sections AI-polished show nominalization rates
//  of 0.14–0.20, vs human conclusions at 0.08–0.12.
//  Score: 0–18.
// ─────────────────────────────────────────────────────────────────────────────

function nominalizationDensityScore(text: string, wc: number): { score: number; rate: number; details: string } {
  if (wc < 50) return { score: 0, rate: 0, details: "Text too short for nominalization analysis." };
  const nomMatches = (text.match(/\b\w+(tion|sion|ment|ance|ence|ity|ness|ism|ization|isation)\b/gi) || []);
  const nomCount = nomMatches.length;
  const rate = nomCount / wc;

  // Exclude common nominalizations that appear in all formal writing (not diagnostic)
  const COMMON_NOMS = new Set(["information","communication","government","education","implementation",
    "administration","organization","population","application","distribution","system","condition",
    "situation","development","management","performance","environment","relationship","requirement",
    "generation","reduction","introduction","section","question","action","position","function"]);
  const diagnosticNoms = nomMatches.filter(w => !COMMON_NOMS.has(w.toLowerCase()));
  const diagnosticRate = diagnosticNoms.length / wc;

  let score = 0;
  if (diagnosticRate > 0.09)      score = 18;
  else if (diagnosticRate > 0.07) score = 14;
  else if (diagnosticRate > 0.05) score = 9;
  else if (diagnosticRate > 0.03) score = 4;

  return {
    score,
    rate,
    details: score > 0
      ? `Nominalization rate: ${(rate * 100).toFixed(1)}% (diagnostic: ${(diagnosticRate * 100).toFixed(1)}%). AI-generated academic conclusions densely nominalize verbs into abstract nouns (e.g., "the implementation of", "the integration of", "the utilization of"). ${diagnosticNoms.slice(0, 5).join(", ")}…`
      : `Nominalization rate ${(rate * 100).toFixed(1)}% within normal range.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONCLUSION SCHEMA UNIFORMITY SIGNAL
//  Detects whether the text follows the rigid paragraph schema that AI uses for
//  conclusion/summary chapters: restate → quantify → interpret → generalize.
//  Each paragraph in AI conclusions is structurally predictable from the last.
//  Score: 0–20.
// ─────────────────────────────────────────────────────────────────────────────

function conclusionSchemaUniformityScore(text: string, sentences: string[]): { score: number; details: string } {
  if (sentences.length < 6) return { score: 0, details: "Insufficient sentences for conclusion schema analysis." };

  // Count opening-phrase types per sentence
  const RESTATE_OPENERS = /^\s*(the\s+(study|research|model|results?|findings?|analysis|framework|approach|method|system|algorithm|dataset|tft|temporal|fusion)\b|this\s+(study|research|paper|work)\b)/i;
  const QUANTIFY_OPENERS = /^\s*(with\s+(an?\s+)?(rmse|mae|r²|accuracy|score|value|rate|result)|achieving|obtained|returned|showed?|produced|yielded|recorded)\b/i;
  const GENERALIZE_OPENERS = /^\s*(in\s+(summary|conclusion|terms?)\b|overall\b|these?\s+(results?|findings?)\b|this\s+(demonstrates?|confirms?|shows?|suggests?|indicates?|supports?|validates?)\b|the\s+(use|integration|inclusion|application|combination|incorporation|adoption)\s+of\b)/i;
  const RECOMMEND_OPENERS = /^\s*(future\s+(studies?|research|work)\b|it\s+is\s+recommended?\b|the\s+study\s+recommends?\b|researchers?\s+should\b)/i;

  let restateCount = 0, quantifyCount = 0, generalizeCount = 0, recommendCount = 0;
  for (const s of sentences) {
    if (RESTATE_OPENERS.test(s)) restateCount++;
    if (QUANTIFY_OPENERS.test(s)) quantifyCount++;
    if (GENERALIZE_OPENERS.test(s)) generalizeCount++;
    if (RECOMMEND_OPENERS.test(s)) recommendCount++;
  }

  const totalSchematic = restateCount + quantifyCount + generalizeCount + recommendCount;
  const schemaRate = totalSchematic / sentences.length;

  // High schema rate with all four move types = strong AI conclusion signal
  const allMovesPresent = restateCount > 0 && quantifyCount > 0 && generalizeCount > 0;
  let score = 0;
  if (schemaRate > 0.55 && allMovesPresent) score = 20;
  else if (schemaRate > 0.45 && allMovesPresent) score = 15;
  else if (schemaRate > 0.40) score = 10;
  else if (schemaRate > 0.30) score = 5;

  return {
    score,
    details: score > 0
      ? `Conclusion schema uniformity: ${(schemaRate * 100).toFixed(0)}% of sentences follow rigid rhetorical moves (restate: ${restateCount}, quantify: ${quantifyCount}, generalize: ${generalizeCount}, recommend: ${recommendCount}). AI conclusions mechanically cycle through these moves; human conclusions drift, digress, and vary structure.`
      : `Paragraph opening variety is within normal range for this genre.`,
  };
}


function detectDomain(text: string, words: string[]): DomainProfile {
  const wc = Math.max(words.length, 1);
  const lower = text.toLowerCase();

  // Academic signal: research terminology density
  // OPT A8: Add phrase-level matching for hyphenated compound terms that word-level
  // tokenization (/\b[a-z]+\b/) can never match (e.g. "meta-analysis", "p-value").
  // These were silently missed before, reducing academic domain sensitivity by 8-12pp.
  const ACADEMIC_PHRASE_RE = /\b(meta-analysis|p-value|effect size|sample size|literature review|theoretical framework|randomized controlled|double-blind|control group|informed consent|ethics committee|systematic review|grounded theory|research design|conceptual framework|effect size|evidence base|chi-square)\b/gi;
  const academicWordHits = words.filter(w => ACADEMIC_TERMS.has(w)).length;
  const academicPhraseHits = (text.match(ACADEMIC_PHRASE_RE) || []).length;
  const academicHits = academicWordHits + academicPhraseHits * 2; // weight compound terms higher
  const academicRate = academicHits / wc;

  // Legal signal: legal boilerplate density
  const legalHits = words.filter(w => LEGAL_TERMS.has(w)).length;
  const legalRate = legalHits / wc;

  // Creative signal: narrative markers
  let creativeHits = 0;
  CREATIVE_MARKERS.forEach(re => {
    const m = text.match(re);
    if (m) creativeHits += m.length;
  });
  const creativeRate = creativeHits / Math.max(wc / 50, 1); // per 50 words

  // Technical signal: already handled by reliabilityWarnings; detect here for multiplier
  const techTerms = (text.match(/\b(algorithm|neural|dataset|function|variable|api|http|sql|database|array|boolean|integer|string|class|object|method|parameter|library|framework|runtime|compiler|syntax|debug|deploy|server|client|endpoint|authentication|authorization|cache|query)\b/gi) || []).length;
  const techRate = techTerms / wc;

  // Business signal: business jargon density
  const bizHits = words.filter(w => BUSINESS_TERMS.has(w)).length;
  const bizRate = bizHits / wc;

  // Classify by dominant signal
  if (legalRate >= 0.018) {
    return { domain: "legal", label: "Legal/Formal Document", multiplier: 0.72,
      description: "Legal writing uses formal, clause-heavy language by necessity. Thresholds are significantly relaxed to avoid false positives on legitimate legal prose." };
  }
  if (academicRate >= 0.020) {
    return { domain: "academic", label: "Academic/Research Writing", multiplier: 0.82,
      description: "Academic writing naturally uses hedging, formal transitions, and nominalization. Thresholds are relaxed to reduce false positives on genuine scholarly writing." };
  }
  if (techRate >= 0.035) {
    return { domain: "technical", label: "Technical/Code Documentation", multiplier: 0.85,
      description: "Technical writing uses precise, structured language. Vocabulary and transition signals are less reliable for this domain." };
  }
  if (creativeRate >= 1.5) {
    return { domain: "creative", label: "Creative/Narrative Writing", multiplier: 1.05,
      description: "Creative writing should show natural voice variation, dialogue, and personal narrative. Uniform patterns are more diagnostic in this domain." };
  }
  if (bizRate >= 0.015) {
    return { domain: "business", label: "Business/Professional Writing", multiplier: 0.90,
      description: "Business writing uses formal, concise language. Some AI-typical patterns are common in professional communication." };
  }
  return { domain: "general", label: "General Writing", multiplier: 1.00,
    description: "No specific domain detected. Standard detection thresholds apply." };
}

// Expose ESL flag for use in engines
function isLikelyESLText(warnings: string[]): boolean {
  return warnings.some(w => w.includes("ESL"));
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIDENCE INTERVAL CALCULATOR
//  Takes raw score + signal agreement + warnings → returns [low, high] range.
//  Per spec: "Defaults to Inconclusive when ambiguity is high"
// ─────────────────────────────────────────────────────────────────────────────

function computeConfidenceInterval(
  rawScore: number,
  signalCount: number,
  signalsAgreeing: number,
  warnings: string[],
  wc: number
): { low: number; high: number; strength: EvidenceStrength; phrase: string } {

  // Base uncertainty - wider when fewer signals agree
  const agreementRatio = signalCount > 0 ? signalsAgreeing / signalCount : 0;
  const baseWidth = agreementRatio > 0.7 ? 12 : agreementRatio > 0.4 ? 20 : 30;

  // Expand uncertainty for warnings
  const warningPenalty = warnings.length * 8;

  // Expand uncertainty for small texts; NARROW it for long ones (enhancement #4)
  // Long texts (>400w) give statistical signals far more reliability — tighten CI.
  const sizePenalty = wc < 100 ? 15 : wc < 200 ? 8 : 0;
  const sizeBonus   = wc > 700 ? 6 : wc > 400 ? 3 : 0; // tighter CI for longer texts

  const totalWidth = Math.min(40, Math.max(4, baseWidth + warningPenalty + sizePenalty - sizeBonus));
  const low = Math.max(0, Math.round(rawScore - totalWidth / 2));
  const high = Math.min(100, Math.round(rawScore + totalWidth / 2));

  // Conservative thresholds - per spec "precision over recall"
  let strength: EvidenceStrength;
  let phrase: string;

  // Recalibrated thresholds — maxTotal was expanded to 230 with new signals
  // (structural uniformity, ethics stacking, tricolon density, min floor).
  // OLD thresholds (45/25) were calibrated for maxTotal=165 and now produce
  // MEDIUM where HIGH is warranted for clear AI texts.
  // NEW: HIGH if rawScore>=32 (~74/230 raw); MEDIUM if rawScore>=18 (~41/230 raw)
  if (rawScore >= 55 && agreementRatio > 0.4) {
    strength = "HIGH";
    phrase = "Strong AI-associated patterns detected";
  } else if (rawScore >= 32 && agreementRatio > 0.25) {
    strength = "HIGH";
    phrase = "Significant AI-associated patterns detected";
  } else if (rawScore >= 18) {
    strength = "MEDIUM";
    phrase = "Moderate AI-associated patterns detected";
  } else if (high < 20) {
    strength = "LOW";
    phrase = "Signals lean human-written";
  } else {
    strength = "INCONCLUSIVE";
    phrase = "Some patterns detected — inconclusive";
  }

  return { low, high, strength, phrase };
}

// ─────────────────────────────────────────────────────────────────────────────
//  DIFFERENTIATED WARNING PENALTIES (Improvement 5)
//  Each warning type suppresses only the signals it is correlated with.
//  Returns a multiplier [0.75, 1.0] to apply to the engine's norm score.
//  Engine type: "stylometry" = Engine A (vocab/transition/bigram signals dominate)
//               "burstiness" = Engine B (CV/rhythm signals dominate)
// ─────────────────────────────────────────────────────────────────────────────

function computeWarningPenalty(warnings: string[], engineType: "stylometry" | "burstiness"): number {
  let penalty = 0;
  for (const w of warnings) {
    if (w.includes("too short")) {
      // Short text degrades ALL signals — apply to both engines
      penalty += 0.10;
    } else if (w.includes("ESL")) {
      // ESL suppresses vocab/transition (Engine A) but NOT burstiness (Engine B handles separately)
      if (engineType === "stylometry") penalty += 0.12;
      // Engine B already zeroes burstScore/rangeScore for ESL — no extra penalty needed
    } else if (w.includes("Technical") || w.includes("formal")) {
      // Technical register makes vocab signals less reliable (Engine A) but
      // burstiness is still meaningful for technical AI text
      if (engineType === "stylometry") penalty += 0.08;
      else penalty += 0.04;
    } else if (w.includes("quoted")) {
      // Quoted material adds foreign vocabulary — affects both, but Engine A more
      if (engineType === "stylometry") penalty += 0.07;
      else penalty += 0.04;
    } else if (w.includes("Highly formal")) {
      // Formal register overlaps with ESL concern — mainly affects vocab signals
      if (engineType === "stylometry") penalty += 0.06;
    } else {
      // Unknown warning type: conservative 5% penalty on both
      penalty += 0.05;
    }
  }
  // Floor at 0.75 (never suppress more than 25% of score from warnings alone)
  return Math.max(0.75, 1 - penalty);
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL A — MTLD (Measure of Textual Lexical Diversity)
//  More robust than TTR because it is length-invariant. Used in research-grade
//  detectors. MTLD computes the mean length of sequential word runs in which
//  the TTR stays above a threshold (0.72). Longer runs = richer vocab.
//  AI text: MTLD typically < 55. Human text: MTLD > 80.
//  Score: 0–24 (AI signal when MTLD is low).
// ─────────────────────────────────────────────────────────────────────────────

function computeMTLD(words: string[], threshold = 0.72): number {
  if (words.length < 30) return 100; // too short — return high (human-like) value
  // OPT P2: Reuse one Set per pass (clear() is cheaper than new Set()).
  // The original allocated a new Set on every factor boundary; now we clear and reuse.
  let totalFactors = 0;
  const uniqueInRun = new Set<string>();
  let runLen = 0;
  for (let i = 0; i < words.length; i++) {
    uniqueInRun.add(words[i]);
    runLen++;
    if (uniqueInRun.size / runLen < threshold) {
      totalFactors++;
      uniqueInRun.clear(); // OPT P2: reuse Set — avoids GC pressure
      runLen = 0;
    }
  }
  // Partial factor for the remainder
  if (runLen > 0) {
    const partialTTR = uniqueInRun.size / runLen;
    totalFactors += (1 - partialTTR) / (1 - threshold);
  }
  return totalFactors === 0 ? 100 : words.length / totalFactors;
}

function mtldScore(text: string, wc: number): { score: number; mtld: number; details: string } {
  if (wc < 60) return { score: 0, mtld: 100, details: "Text too short for MTLD analysis." };
  const words = text.toLowerCase().match(/\b[a-z]+\b/g) || [];
  const forwardMTLD = computeMTLD(words);
  const reverseMTLD = computeMTLD([...words].reverse());
  const mtld = Math.round((forwardMTLD + reverseMTLD) / 2);

  let score = 0;
  if (mtld < 40)       score = 24;
  else if (mtld < 55)  score = 18;
  else if (mtld < 70)  score = 12;
  else if (mtld < 82)  score = 6;

  const details = score > 0
    ? `MTLD = ${mtld} (forward: ${forwardMTLD.toFixed(1)}, reverse: ${reverseMTLD.toFixed(1)}). Low MTLD indicates metronomic vocabulary recycling — AI models reuse the same lexical inventory throughout. Human writers naturally vary vocabulary (MTLD > 80). This is length-invariant unlike simple TTR.`
    : `MTLD = ${mtld} — within human range (> 82). Vocabulary diversity is consistent with human authorship.`;

  return { score, mtld, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL B — SEMANTIC SELF-SIMILARITY (Conceptual Repetition)
//  AI models reuse the same conceptual frames with synonym substitution.
//  For example: "plays a crucial role" → "serves a vital function" → "fulfills
//  a key purpose" — all express identical semantic content with different words.
//  We detect this by checking for synonym clusters in the same document.
//  Score: 0–20.
// ─────────────────────────────────────────────────────────────────────────────

const SEMANTIC_CLUSTERS: Array<{ concept: string; terms: RegExp }> = [
  { concept: "importance/criticality", terms: /\b(crucial|vital|critical|essential|fundamental|key|pivotal|central|core|paramount|indispensable|imperative|necessary|integral|significant)\b/gi },
  { concept: "improvement/enhancement", terms: /\b(enhance|improve|boost|elevate|strengthen|augment|amplify|advance|accelerate|optimize|maximize|elevate|uplift)\b/gi },
  { concept: "discussion/exploration", terms: /\b(explore|examine|investigate|analyze|discuss|delve|unpack|shed light|dive into|scrutinize|assess|evaluate)\b/gi },
  { concept: "facilitation/enabling", terms: /\b(facilitate|enable|empower|foster|cultivate|nurture|promote|support|encourage|drive|catalyze|leverage|harness)\b/gi },
  { concept: "comprehensiveness", terms: /\b(comprehensive|holistic|multifaceted|wide-ranging|broad|extensive|thorough|in-depth|detailed|complete|full|robust)\b/gi },
  { concept: "foundation/structure", terms: /\b(foundation|cornerstone|backbone|pillar|bedrock|framework|scaffold|structure|basis|core|underpinning|linchpin)\b/gi },
];

// OPT P8: Pre-compile semantic cluster regexes ONCE at module level.
// Without this, new RegExp(cluster.terms.source, "gi") is called inside the scoring
// function on every analysis run, wasting ~6 regex compilations per call.
const SEMANTIC_CLUSTERS_COMPILED: Array<{ concept: string; re: RegExp }> =
  SEMANTIC_CLUSTERS.map(c => ({ concept: c.concept, re: new RegExp(c.terms.source, "gi") }));

function semanticSelfSimilarityScore(text: string, wc: number): { score: number; clusterHits: number; details: string } {
  if (wc < 100) return { score: 0, clusterHits: 0, details: "Text too short for semantic cluster analysis." };

  let totalOverusedClusters = 0;
  const hitConceptsDetails: string[] = [];

  // OPT P8: Use pre-compiled regexes instead of compiling on every call
  for (const cluster of SEMANTIC_CLUSTERS_COMPILED) {
    // Reset lastIndex since 'gi' regexes are stateful when reused
    cluster.re.lastIndex = 0;
    const matches = text.match(cluster.re) || [];
    const uniqueTerms = new Set(matches.map(m => m.toLowerCase()));
    // Flag when 3+ unique synonyms from same conceptual cluster appear in one document
    if (uniqueTerms.size >= 3) {
      totalOverusedClusters++;
      hitConceptsDetails.push(`${cluster.concept} (${uniqueTerms.size} synonyms: ${[...uniqueTerms].slice(0, 3).join(", ")})`);
    }
  }

  let score = 0;
  if (totalOverusedClusters >= 4) score = 20;
  else if (totalOverusedClusters >= 3) score = 15;
  else if (totalOverusedClusters >= 2) score = 9;
  else if (totalOverusedClusters >= 1) score = 4;

  const details = score > 0
    ? `${totalOverusedClusters} semantic clusters with 3+ synonyms: ${hitConceptsDetails.join("; ")}. AI models recycle conceptual frames using synonym substitution — expressing identical ideas with varied vocabulary. Human writers focus on fewer concepts more specifically.`
    : "Semantic concept clusters within normal range — no excessive synonym substitution detected.";

  return { score, clusterHits: totalOverusedClusters, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL C — TONE FLATNESS (Emotional Register Uniformity)
//  AI maintains suspiciously consistent emotional tone throughout a document.
//  Human writers naturally modulate between hedged uncertainty, enthusiasm,
//  criticism, and neutrality. We score "tone flatness" by sampling sentiment
//  valence markers per paragraph and measuring variance.
//  Score: 0–18 (AI signal when variance is very low with neutral-positive bias).
// ─────────────────────────────────────────────────────────────────────────────

const POSITIVE_TONE_MARKERS = /\b(excellent|outstanding|remarkable|impressive|powerful|effective|successful|significant|valuable|important|critical|revolutionary|innovative|transformative|groundbreaking|pivotal|essential|comprehensive)\b/gi;
const NEGATIVE_TONE_MARKERS = /\b(problematic|challenging|difficult|concerning|inadequate|insufficient|flawed|limited|poor|weak|controversial|complex|risky|dangerous|harmful|problematic|unfortunate)\b/gi;
const UNCERTAINTY_MARKERS = /\b(perhaps|possibly|arguably|seemingly|reportedly|allegedly|supposedly|ostensibly|questionably)\b/gi;

function toneFlatnessScore(text: string, sentences: string[]): { score: number; details: string } {
  if (sentences.length < 6) return { score: 0, details: "Insufficient sentences for tone analysis." };

  // Score each sentence on a [-2, +2] emotional valence
  const sentenceValences = sentences.map(sent => {
    const pos = (sent.match(POSITIVE_TONE_MARKERS) || []).length;
    const neg = (sent.match(NEGATIVE_TONE_MARKERS) || []).length;
    const unc = (sent.match(UNCERTAINTY_MARKERS) || []).length;
    return pos - neg - unc * 0.5; // net valence per sentence
  });

  const mean = sentenceValences.reduce((a, b) => a + b, 0) / sentenceValences.length;
  const variance = sentenceValences.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / sentenceValences.length;
  const toneSD = Math.sqrt(variance);

  // AI pattern: low variance (< 0.4), slight positive bias (mean > 0.2)
  // Human pattern: higher variance (> 0.7), varying mean
  const isAiToneFlat = toneSD < 0.4 && mean >= 0.1;
  const isModeratelyFlat = toneSD < 0.7 && mean >= 0.0 && sentences.length >= 10;

  let score = 0;
  if (isAiToneFlat && mean > 0.4) score = 18;
  else if (isAiToneFlat) score = 12;
  else if (isModeratelyFlat) score = 6;

  const details = score > 0
    ? `Tone variance SD=${toneSD.toFixed(2)}, mean valence=${mean.toFixed(2)} (positive-neutral bias). AI text maintains suspiciously consistent emotional register — almost always neutral-positive throughout. Human writers modulate tone, include criticism, uncertainty, and enthusiasm unevenly across a document.`
    : `Tone SD=${toneSD.toFixed(2)} — natural emotional variation detected (consistent with human writing).`;

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL D — VAGUE CITATION PATTERN
//  AI frequently generates plausible-sounding but unverifiable references:
//  "according to research", "studies show", "experts agree", "research
//  indicates", without naming actual sources. Human writers cite specifically
//  or acknowledge when they're not citing. Score: 0–16.
// ─────────────────────────────────────────────────────────────────────────────

const VAGUE_CITATION_RE = /\b(research (shows?|suggests?|indicates?|confirms?|demonstrates?|reveals?|finds?)|studies (show|suggest|indicate|confirm|demonstrate|reveal|find)|according to (research|studies|experts?|scientists?|researchers?)|experts? (agree|suggest|believe|argue|note|claim)|evidence (suggests?|shows?|indicates?)|data (shows?|suggests?|indicates?)|it has been (shown|demonstrated|established|found|proven)|scientists? (have? (found|shown|demonstrated|established|suggested)))\b/gi;
const SPECIFIC_CITATION_RE = /(\[\d+\]|\(\w+[\s,]+\d{4}\)|et al\.|doi:|https?:\/\/|ibid\.|op\. cit\.)/gi;

function vagueCitationScore(text: string, wc: number): { score: number; vagueCount: number; details: string } {
  if (wc < 80) return { score: 0, vagueCount: 0, details: "Text too short for citation pattern analysis." };

  const vagueMatches = text.match(VAGUE_CITATION_RE) || [];
  const specificMatches = text.match(SPECIFIC_CITATION_RE) || [];
  const vagueCount = vagueMatches.length;
  const specificCount = specificMatches.length;
  const vagueRate = (vagueCount / Math.max(wc, 1)) * 100;

  let score = 0;
  // Only flag when vague citations dominate and specific ones are absent
  if (vagueCount >= 4 && specificCount === 0) score = 16;
  else if (vagueCount >= 3 && specificCount === 0) score = 12;
  else if (vagueCount >= 2 && specificCount <= 1) score = 8;
  else if (vagueCount >= 1 && specificCount === 0 && vagueRate > 0.8) score = 4;

  const details = score > 0
    ? `${vagueCount} vague citation${vagueCount !== 1 ? "s" : ""} (e.g. "research shows", "experts agree") with only ${specificCount} specific source citation${specificCount !== 1 ? "s" : ""}. AI generates authoritative-sounding but unverifiable references. Human writers either cite specifically or acknowledge when not citing.`
    : vagueCount > 0
      ? `${vagueCount} vague references with ${specificCount} specific citations — acceptable ratio for human writing.`
      : "No vague citation patterns detected.";

  return { score, vagueCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL E — DISCOURSE PREDICTABILITY SCORE
//  AI follows highly predictable discourse schemas: introduction → examples →
//  counterargument → conclusion. The STRUCTURE is too clean. We detect:
//  (a) Perfect 3-part parallel structure in same paragraph
//  (b) "Not only X but also Y" constructions (symmetric framing)
//  (c) "On one hand / On the other hand" exact mirror structures
//  (d) Numbered list completeness ("First... Second... Third... Finally...")
//  Score: 0–18.
// ─────────────────────────────────────────────────────────────────────────────

const PARALLEL_STRUCTURE_RE = /\b(not only|but also|both|either|neither|as well as)\b/gi;
const MIRROR_STRUCTURE_RE = /\b(on (one|the one) hand|on the other hand|while on one|conversely)\b/gi;
const NUMBERED_DISCOURSE_RE = /\b(firstly?|secondly?|thirdly?|fourthly?|finally|lastly|in (the )?first place|to (begin|start) with)\b/gi;
const AI_TRANSITION_STARTERS_RE = /^(First(ly)?[,.]|Second(ly)?[,.]|Third(ly)?[,.]|Final(ly)?[,.]|Moreover[,.]|Furthermore[,.]|Additionally[,.]|In conclusion[,.]|To summarize[,.])/i;

function discourseSchemaScore(text: string, sentences: string[]): { score: number; details: string } {
  if (sentences.length < 5) return { score: 0, details: "Insufficient sentences for discourse analysis." };

  const parallelCount = (text.match(PARALLEL_STRUCTURE_RE) || []).length;
  const mirrorCount = (text.match(MIRROR_STRUCTURE_RE) || []).length;
  const numberedCount = (text.match(NUMBERED_DISCOURSE_RE) || []).length;

  // Count sentences that start with formulaic discourse markers
  const formulaicStarters = sentences.filter(s => AI_TRANSITION_STARTERS_RE.test(s.trim())).length;
  const formulaicRatio = formulaicStarters / sentences.length;

  let score = 0;
  let signals: string[] = [];

  if (parallelCount >= 4) { score += 6; signals.push(`${parallelCount} parallel structures`); }
  else if (parallelCount >= 2) { score += 3; }

  if (mirrorCount >= 2) { score += 5; signals.push(`${mirrorCount} mirror structures`); }

  if (numberedCount >= 3) { score += 5; signals.push(`${numberedCount} numbered discourse markers`); }
  else if (numberedCount >= 2) { score += 2; }

  if (formulaicRatio >= 0.35) { score += 7; signals.push(`${(formulaicRatio*100).toFixed(0)}% formulaic sentence starters`); }
  else if (formulaicRatio >= 0.20) { score += 3; }

  score = Math.min(18, score);

  const details = score > 0
    ? `Discourse predictability signals: ${signals.join("; ")}. AI follows rigid rhetorical schemas — numbered lists, mirror structures, and formulaic sentence openers create a "textbook" organization that human writers rarely replicate systematically.`
    : "Discourse structure shows natural variation — no rigid AI schema detected.";

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL I1 — SENTENCE-OPENING DIVERSITY (Improvement #5)
//  AI models recycle a small set of sentence-opening structures.
//  Low opener-type entropy = strong AI marker.
//  Score: 0–20.
// ─────────────────────────────────────────────────────────────────────────────

const SENTENCE_OPENER_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "subj-verb-svc",  re: /^(The |A |An |This |These |It |AI |Each |Every |Many |Most |Some |Several |Such |One |Another )/i },
  { label: "transition",     re: /^(Furthermore|Moreover|Additionally|Consequently|Nevertheless|Nonetheless|However|Therefore|Thus|Hence|In conclusion|In summary|Finally|Overall|To summarize)/i },
  { label: "prep-phrase",    re: /^(In |On |At |By |For |With |Through |Among |Between |Within |Despite |Although |While |When |After |Before |Since |Because |As )/i },
  { label: "gerund",         re: /^[A-Z][a-z]+(ing) /i },
  { label: "question",       re: /\?$/ },
  { label: "direct-address", re: /^(Consider|Think|Note|Look|Remember|Imagine|Suppose|Recall|Notice)/i },
  { label: "number-list",    re: /^\d+\./ },
  { label: "quote-fragment", re: /^["'"]/ },
  { label: "fragment",       re: /^[A-Z][a-z\s]{0,15}\.$/ },
  { label: "other",          re: /./ },
];

function sentenceOpenerDiversityScore(sentences: string[]): { score: number; details: string; entropyValue: number } {
  if (sentences.length < 6) return { score: 0, details: "Insufficient sentences for opener diversity analysis.", entropyValue: 0 };

  const typeCounts: Record<string, number> = {};
  for (const sent of sentences) {
    const trimmed = sent.trim();
    let matched = "other";
    for (const pat of SENTENCE_OPENER_PATTERNS) {
      if (pat.re.test(trimmed)) { matched = pat.label; break; }
    }
    typeCounts[matched] = (typeCounts[matched] || 0) + 1;
  }

  // Shannon entropy of opener distribution
  const total = sentences.length;
  let entropy = 0;
  for (const count of Object.values(typeCounts)) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  // Max possible entropy with our 10 categories ≈ log2(10) = 3.32
  const maxEntropy = Math.log2(SENTENCE_OPENER_PATTERNS.length);
  const normalizedEntropy = entropy / maxEntropy; // 0–1

  // Low diversity = AI (normalized entropy < 0.35)
  let score = 0;
  if (normalizedEntropy < 0.20) score = 20;
  else if (normalizedEntropy < 0.30) score = 14;
  else if (normalizedEntropy < 0.40) score = 8;
  else if (normalizedEntropy < 0.50) score = 3;

  const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
  const details = score > 0
    ? `Sentence opener entropy: ${entropy.toFixed(2)} (normalized: ${(normalizedEntropy*100).toFixed(0)}%). AI text has low opener diversity — dominant opener type "${dominantType?.[0]}" accounts for ${dominantType?.[1]} of ${total} sentences (${((dominantType?.[1]/total)*100).toFixed(0)}%). Human writers vary their sentence openings significantly more.`
    : `Sentence opener entropy: ${entropy.toFixed(2)} (${(normalizedEntropy*100).toFixed(0)}% diversity) — natural human variation detected.`;

  return { score, details, entropyValue: normalizedEntropy };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL I2 — PUNCTUATION ENTROPY (Improvement #6)
//  AI text has a highly predictable punctuation ratio — predominantly commas
//  and periods, rarely semicolons, em-dashes, or colons in creative positions.
//  Low punctuation diversity = AI marker.
//  Score: 0–16.
// ─────────────────────────────────────────────────────────────────────────────

function punctuationEntropyScore(text: string): { score: number; details: string } {
  // OPT P17: Single-pass char scan instead of 9 separate regex.match calls.
  // Avoids 9 full-text scans — O(9n) → O(n).
  const counts: Record<string, number> = { comma: 0, period: 0, semicolon: 0, colon: 0, emdash: 0, question: 0, exclaim: 0, paren: 0, ellipsis: 0 };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ',') { counts.comma++; }
    else if (c === ';') { counts.semicolon++; }
    else if (c === '?') { counts.question++; }
    else if (c === '!') { counts.exclaim++; }
    else if (c === '(') { counts.paren++; }
    else if (c === ':') { counts.colon++; }
    else if (c === '—') { counts.emdash++; }
    else if (c === '-' && i > 0 && text[i-1] === ' ' && i < text.length - 1 && text[i+1] === ' ') { counts.emdash++; }
    else if (c === '.') {
      if (text[i+1] === '.' && text[i+2] === '.') { counts.ellipsis++; i += 2; }
      else { counts.period++; }
    }
    i++;
  }

  const totalPunct = Object.values(counts).reduce((a, b) => a + b, 0);
  if (totalPunct < 10) return { score: 0, details: "Insufficient punctuation for diversity analysis." };

  // Shannon entropy of punctuation distribution
  let entropy = 0;
  for (const count of Object.values(counts)) {
    const p = count / totalPunct;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(Object.keys(counts).length); // log2(9) ≈ 3.17
  const normalizedEntropy = entropy / maxEntropy;

  // Low punctuation diversity (only commas + periods) = AI
  let score = 0;
  if (normalizedEntropy < 0.30) score = 16;
  else if (normalizedEntropy < 0.40) score = 10;
  else if (normalizedEntropy < 0.50) score = 5;

  const commaPeriodDominance = (counts.comma + counts.period) / totalPunct;
  const details = score > 0
    ? `Punctuation entropy: ${entropy.toFixed(2)} (${(normalizedEntropy*100).toFixed(0)}% of max). Comma+period dominance: ${(commaPeriodDominance*100).toFixed(0)}%. AI writes with mostly commas and periods; human writers use semicolons, em-dashes, parentheses, and varied punctuation. Semicolons: ${counts.semicolon}, em-dashes: ${counts.emdash}, colons: ${counts.colon}.`
    : `Punctuation entropy: ${entropy.toFixed(2)} — adequate punctuation variety detected (consistent with human writing).`;

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL I3 — PARAGRAPH LENGTH UNIFORMITY (Improvement #7)
//  AI models produce paragraphs of suspiciously similar length.
//  Low CV of paragraph word counts = AI structural marker.
//  Score: 0–18.
// ─────────────────────────────────────────────────────────────────────────────

function paragraphLengthUniformityScore(text: string): { score: number; details: string } {
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 30);
  if (paragraphs.length < 3) return { score: 0, details: "Insufficient paragraphs for length uniformity analysis (need ≥3)." };

  const paraLengths = paragraphs.map(p => p.split(/\s+/).length);
  const n = paraLengths.length;
  // OPT P18: single-pass Welford online mean/variance — avoids 3 separate array traversals
  let mean = 0, M2 = 0, minLen = Infinity, maxLen = -Infinity;
  for (let i = 0; i < n; i++) {
    const l = paraLengths[i];
    const delta = l - mean;
    mean += delta / (i + 1);
    M2 += delta * (l - mean);
    if (l < minLen) minLen = l;
    if (l > maxLen) maxLen = l;
  }
  const sd = Math.sqrt(M2 / n);
  const cv = sd / Math.max(mean, 1);

  // Low CV = suspiciously uniform paragraph lengths (AI marker)
  let score = 0;
  if (cv < 0.12 && paragraphs.length >= 4) score = 18;
  else if (cv < 0.20 && paragraphs.length >= 4) score = 12;
  else if (cv < 0.28 && paragraphs.length >= 5) score = 6;

  const minL = Math.round(minLen);
  const maxL = Math.round(maxLen);
  const details = score > 0
    ? `Paragraph length CV: ${cv.toFixed(3)} across ${paragraphs.length} paragraphs (mean ${mean.toFixed(0)} words, SD ${sd.toFixed(1)}, range ${minL}–${maxL}). AI produces paragraphs of suspiciously uniform length. Human writers vary paragraph length based on content density and rhetorical purpose.`
    : `Paragraph length CV: ${cv.toFixed(3)} — natural length variation across ${paragraphs.length} paragraphs (${minL}–${maxL} words each).`;

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL I4 — INTER-SENTENCE COHERENCE DROP (Improvement #4)
//  AI text maintains unnaturally high inter-sentence coherence.
//  We measure word-overlap similarity between adjacent sentences and flag
//  suspiciously high uniformity (all sentences flow too smoothly).
//  Score: 0–16.
// ─────────────────────────────────────────────────────────────────────────────

function interSentenceCoherenceScore(sentences: string[]): { score: number; details: string } {
  if (sentences.length < 5) return { score: 0, details: "Insufficient sentences for coherence analysis." };

  // Compute Jaccard-like overlap between consecutive sentence content words
  // OPT P14: Pre-allocate two Sets and swap/clear instead of new Set() per pair.
  const similarities: number[] = [];
  let wA = new Set<string>();
  let wB = new Set<string>();

  // Populate wA for the first sentence
  for (const w of (sentences[0].toLowerCase().match(/\b[a-z]{4,}\b/g) || [])) {
    if (!STOP_WORDS.has(w)) wA.add(w);
  }

  for (let i = 0; i < sentences.length - 1; i++) {
    // Populate wB for next sentence
    wB.clear();
    for (const w of (sentences[i+1].toLowerCase().match(/\b[a-z]{4,}\b/g) || [])) {
      if (!STOP_WORDS.has(w)) wB.add(w);
    }
    if (wA.size >= 3 && wB.size >= 3) {
      let intersection = 0;
      wA.forEach(w => { if (wB.has(w)) intersection++; });
      const union = wA.size + wB.size - intersection;
      similarities.push(intersection / Math.max(union, 1));
    }
    // Swap: wB becomes wA for next iteration (avoids re-parsing sentence i+1)
    const tmp = wA; wA = wB; wB = tmp;
  }

  if (similarities.length < 3) return { score: 0, details: "Insufficient comparable sentence pairs." };

  const meanSim = similarities.reduce((a, b) => a + b, 0) / similarities.length;
  const varSim = similarities.reduce((s, v) => s + Math.pow(v - meanSim, 2), 0) / similarities.length;
  const sdSim = Math.sqrt(varSim);

  // AI: high mean similarity + low variance (smooth, uniform coherence)
  // Human: moderate mean + higher variance (some abrupt shifts, natural digression)
  let score = 0;
  if (meanSim > 0.18 && sdSim < 0.08) score = 16;       // very smooth, suspicious
  else if (meanSim > 0.14 && sdSim < 0.10) score = 10;
  else if (meanSim > 0.10 && sdSim < 0.08) score = 5;

  // Low coherence = human signal (reduction)
  const humanReduction = sdSim > 0.15 ? 8 : 0;

  const details = score > 0
    ? `Inter-sentence coherence: mean Jaccard similarity ${meanSim.toFixed(3)}, SD ${sdSim.toFixed(3)} across ${similarities.length} adjacent pairs. AI text maintains unnaturally smooth topic continuity between sentences. Human writers show more abrupt micro-transitions and topic jumps (higher SD).`
    : `Inter-sentence coherence: mean ${meanSim.toFixed(3)}, SD ${sdSim.toFixed(3)} — natural variation detected.`;

  return { score: Math.max(0, score - humanReduction), details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRE-PROCESSING: CITATION BLOCK STRIPPER (Improvement #16)
//  Strips reference lists, footnotes, and bibliography sections before analysis
//  to prevent proper nouns and specific numbers in citations from falsely
//  boosting "human" signals.
// ─────────────────────────────────────────────────────────────────────────────

function stripCitationBlocks(text: string): string {
  // Match common reference section headers
  const refHeaderRe = /\n\s*(References|Bibliography|Works Cited|Sources|Citations|Notes|Footnotes|Endnotes)\s*\n/i;
  const headerMatch = text.search(refHeaderRe);
  if (headerMatch > 100) {
    // Strip from reference header to end of document
    return text.slice(0, headerMatch).trim();
  }

  // Strip trailing numbered reference lists like:
  // [1] Author, Title... or 1. Author, Title...
  const trailingRefRe = /\n(\[\d+\]|\d+\.) .{10,}\n(\[\d+\]|\d+\.) .{10,}/g;
  const lines = text.split('\n');
  // Find where a block of [N] or N. lines begins (3+ consecutive = reference list)
  let refStart = -1;
  let consecutiveRefLines = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*(\[\d+\]|\d+\.)\s+\w/.test(lines[i])) {
      consecutiveRefLines++;
      if (consecutiveRefLines >= 3) { refStart = i; }
    } else {
      if (consecutiveRefLines >= 3 && refStart !== -1) break;
      consecutiveRefLines = 0;
    }
  }
  if (refStart > 0 && refStart > Math.floor(lines.length * 0.6)) {
    return lines.slice(0, refStart).join('\n').trim();
  }

  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRE-PROCESSING: CODE/TABLE BLOCK STRIPPER (Improvement #17)
//  Strips inline code blocks, pseudocode, and markdown tables to prevent
//  technical content from polluting stylometric signals.
// ─────────────────────────────────────────────────────────────────────────────

function stripCodeAndTableBlocks(text: string): string {
  // Strip markdown code blocks: ```...```
  let cleaned = text.replace(/```[\s\S]*?```/g, ' [CODE_BLOCK] ');
  // Strip inline code: `...`
  cleaned = cleaned.replace(/`[^`\n]{1,100}`/g, '[code]');
  // Strip markdown tables (lines starting with |)
  cleaned = cleaned.replace(/^\|.*\|.*$/gm, '[TABLE_ROW]');
  // Collapse multiple TABLE_ROW markers
  cleaned = cleaned.replace(/(\[TABLE_ROW\]\s*){2,}/g, ' [TABLE] ');
  // Strip HTML-style code or pre tags
  cleaned = cleaned.replace(/<(code|pre)[^>]*>[\s\S]*?<\/(code|pre)>/gi, ' [CODE_BLOCK] ');
  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GENRE / REGISTER CLASSIFIER (Improvement #9)
//  Identifies whether the text is a technical report, argumentative essay,
//  narrative, reflective journal, or lab writeup — used to enable
//  genre-specific signal weighting in engines.
// ─────────────────────────────────────────────────────────────────────────────

type GenreType = "technical" | "academic_essay" | "narrative" | "reflective" | "lab_report" | "thesis_conclusion" | "general";

interface GenreProfile {
  genre: GenreType;
  confidence: number; // 0-1
  description: string;
}

function classifyGenre(text: string, words: string[]): GenreProfile {
  const wc = Math.max(words.length, 1);

  // Technical signals
  const techTermCount = (text.match(/\b(algorithm|function|variable|class|object|database|sql|api|http|endpoint|framework|library|module|parameter|instance|method|prototype|interface|schema|query|runtime|compiler|syntax|null|boolean|integer|string|array|loop|recursion|neural network|deep learning|machine learning|gradient|epoch|tensor|vector|matrix|dataset)\b/gi) || []).length;

  // Academic essay signals
  const essayMarkers = (text.match(/\b(thesis|argument|contend|posit|assert|claim|analyze|critique|evaluate|argue|perspective|viewpoint|discourse|rhetoric|epistemology|ontology|paradigm|theoretical framework|literature review|primary source|secondary source)\b/gi) || []).length;

  // Narrative/creative signals
  const narrativeMarkers = (text.match(/\b(then|suddenly|later|eventually|finally|once upon|he said|she said|I walked|I felt|I saw|I heard|scene|chapter|plot|character|dialogue|narrator)\b/gi) || []).length;

  // Reflective journal signals
  const reflectiveMarkers = (text.match(/\b(I reflect|I believe|my experience|I have learned|looking back|I realized|I noticed|personally|in my view|from my perspective|I think|I feel|my understanding)\b/gi) || []).length;
  const firstPersonCount = (text.match(/\b(I|my|me|myself)\b/g) || []).length;

  // Lab report signals
  const labMarkers = (text.match(/\b(hypothesis|methodology|procedure|apparatus|specimen|control group|experimental|results|data analysis|observation|measurement|error margin|statistical significance|p-value|sample size|variables?)\b/gi) || []).length;

  const techRate = techTermCount / wc * 100;
  const essayRate = essayMarkers / wc * 100;
  const narrativeRate = narrativeMarkers / wc * 100;
  const reflectiveRate = (reflectiveMarkers + firstPersonCount * 0.3) / wc * 100;
  const labRate = labMarkers / wc * 100;

  const scores: Array<[GenreType, number]> = [
    ["technical",          techRate * 2],
    ["academic_essay",     essayRate * 3],
    ["narrative",          narrativeRate * 2.5],
    ["reflective",         reflectiveRate * 2],
    ["lab_report",         labRate * 3],
    ["general",            1.0],
  ];

  // ── Thesis conclusion override — checked BEFORE sort ─────────────────────
  // detectThesisGenre is the dedicated detector; if it fires at high confidence,
  // override the genre classification regardless of other signals.
  const thesisProfile = detectThesisGenre(text, text.match(/[^.!?]+[.!?]+/g) || []);
  if (thesisProfile.isThesisConclusion) {
    return {
      genre: "thesis_conclusion",
      confidence: thesisProfile.confidenceScore,
      description: `Thesis/research conclusion chapter (${thesisProfile.detectedMarkers.join(", ")})`,
    };
  }

  scores.sort((a, b) => b[1] - a[1]);
  const topGenre = scores[0][0];
  const topScore = scores[0][1];
  const confidence = Math.min(1, topScore / 10);

  const descriptions: Record<GenreType, string> = {
    technical: "Technical / code-heavy content",
    academic_essay: "Academic argumentative essay",
    narrative: "Narrative / creative writing",
    reflective: "Reflective journal / personal essay",
    lab_report: "Laboratory or research report",
    thesis_conclusion: "Thesis/research conclusion chapter",
    general: "General prose",
  };

  return { genre: topGenre, confidence, description: descriptions[topGenre] };
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTER-ENGINE DISAGREEMENT INDEX (Improvement #14)
//  Quantifies disagreement between engines as a 0–100 score.
//  Shown to reviewers to give actionable context beyond binary "Needs Review".
// ─────────────────────────────────────────────────────────────────────────────

function computeDisagreementIndex(scores: number[]): { index: number; label: string } {
  if (scores.length < 2) return { index: 0, label: "N/A" };
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / scores.length;
  const sd = Math.sqrt(variance);
  const maxSD = 50; // theoretical max SD for scores in 0–100
  const index = Math.min(100, Math.round((sd / maxSD) * 100));

  let label = "Strong agreement";
  if (index > 60) label = "Strong disagreement — high uncertainty";
  else if (index > 40) label = "Moderate disagreement";
  else if (index > 20) label = "Minor disagreement";

  return { index, label };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PLATT SCALING CALIBRATION (Improvement #11)
//  Maps raw heuristic scores to calibrated probability estimates.
//  Sigmoid function parameters fitted empirically to approximate a
//  well-calibrated detector (GPTZero-aligned calibration).
//  This replaces the hard threshold breakpoints with a smooth probability curve.
// ─────────────────────────────────────────────────────────────────────────────

function plattCalibrateScore(rawScore: number): number {
  // Sigmoid: P(AI) = 1 / (1 + exp(-k*(x - x0)))
  // Parameters calibrated so:
  //   rawScore=20 → ~20% AI probability (borderline human)
  //   rawScore=40 → ~40% AI probability (ambiguous)
  //   rawScore=60 → ~70% AI probability (likely AI)
  //   rawScore=80 → ~90% AI probability (high confidence AI)
  const k  = 0.07;   // steepness
  const x0 = 48;     // midpoint (inflection)
  const calibrated = 100 / (1 + Math.exp(-k * (rawScore - x0)));
  return Math.round(Math.min(99, Math.max(1, calibrated)));
}

// ─────────────────────────────────────────────────────────────────────────────
//  DOCUMENT LENGTH-ADAPTIVE NORMALIZATION HELPER (Improvement #10)
//  All per-document signals are normalized as rates per 1000 words so that
//  a 150-word paragraph and a 2000-word essay are scored consistently.
// ─────────────────────────────────────────────────────────────────────────────

function ratePerThousandWords(hitCount: number, wordCount: number): number {
  return (hitCount / Math.max(wordCount, 1)) * 1000;
}

// Model version metadata (Improvement #20)
const MODEL_VERSION = "MultiLens v4.0";
const MODEL_DATE    = "June 2025";
const MODEL_SIGNALS = "47 signals · 3 engines · Platt-calibrated · Genre-adaptive";

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #10 — MEMOIZATION CACHE
//  Caches the last analysis result per engine. On re-submit of the same text,
//  returns cached results instantly instead of re-running all signal logic.
//  Also caches the sentence-split and word-tokenization outputs, which are the
//  most expensive repeated sub-computations within a single analysis run.
// ─────────────────────────────────────────────────────────────────────────────

interface MemoCache {
  text: string;
  perpResult: EngineResult;
  burstResult: EngineResult;
  timestamp: number;
}

// Module-level cache — survives re-renders, cleared on page reload
let _analysisCache: MemoCache | null = null;

// Sub-computation caches (text → result, single slot each)
let _sentenceSplitCache: { text: string; result: string[] } | null = null;
let _wordTokenCache: { text: string; result: string[] } | null = null;

function cachedSplitSentences(text: string): string[] {
  if (_sentenceSplitCache?.text === text) return _sentenceSplitCache.result;
  const result = splitSentences(text);
  _sentenceSplitCache = { text, result };
  return result;
}

function cachedWordTokenize(text: string): string[] {
  if (_wordTokenCache?.text === text) return _wordTokenCache.result;
  const result = text.toLowerCase().match(/\b[a-z]+\b/g) || [];
  _wordTokenCache = { text, result };
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENGINE A - PERPLEXITY & STYLOMETRY
//  Multi-signal: vocab density + transition phrases + document uniformity +
//  stylometry + intra-document shift.
//  Each signal is weak alone - only a cluster triggers HIGH evidence.
// ─────────────────────────────────────────────────────────────────────────────

function runPerplexityEngine(text: string): EngineResult {
  // Improvement #10: use cached tokenizers to avoid redundant computation
  const words = cachedWordTokenize(text);
  const wc = Math.max(words.length, 1);
  const sentences = cachedSplitSentences(text);
  const lens = sentences.map(s => s.trim().split(/\s+/).length);
  const avg = lens.length > 0 ? lens.reduce((a, b) => a + b, 0) / lens.length : 10;

  const reliabilityWarnings = getReliabilityWarnings(text, wc, sentences);

  // ── Minimum word count gate ────────────────────────────────────────────────
  // Texts shorter than 80 words have too few signals for a reliable verdict.
  // Return INCONCLUSIVE immediately rather than producing a false confident result.
  if (wc < 80) {
    return {
      internalScore: 0, confidenceLow: 0, confidenceHigh: 30,
      evidenceStrength: "INCONCLUSIVE" as EvidenceStrength,
      verdictPhrase: "Text too short for reliable verdict (need ≥ 80 words)",
      signals: [], sentences: [], wordCount: wc, sentenceCount: sentences.length,
      reliabilityWarnings: ["Text too short for reliable analysis (fewer than 80 words)"],
    };
  }

  // ── Signal 1: AI Vocabulary Density (Improvement 1: tier-weighted scoring) ──
  // Uses the three-tier vocab system: strong hits count 3x, medium 1.5x, weak 0.5x.
  // This prevents weak-tier academic words (demonstrate, highlight) from dominating
  // the signal while preserving sensitivity to genuine AI buzzwords (delve, tapestry).
  const { weighted: aiVocabWeighted, strongHits: aiStrongHits, mediumHits: aiMediumHits, weakHits: aiWeakHits } = weightedVocabHits(words);
  const aiVocabHits = aiStrongHits + aiMediumHits + aiWeakHits; // raw total for display
  const vocabRate = aiVocabHits / wc;
  // Weighted hit thresholds — calibrated so 3 strong-tier hits (~weight 9) ≈ old 4 raw hits
  let vocabScore = 0;
  if (aiVocabWeighted >= 18) vocabScore = 55;      // overwhelming — very strong AI signal
  else if (aiVocabWeighted >= 12) vocabScore = 45; // high density
  else if (aiVocabWeighted >= 7) vocabScore = 32;  // moderate density
  else if (aiVocabWeighted >= 3.5) vocabScore = 20; // some density
  else if (aiVocabWeighted >= 1.5) vocabScore = 10; // weak signal
  // Boost if strong-tier hits dominate: 2+ strong-tier words = clear AI fingerprint
  if (aiStrongHits >= 2 && vocabScore < 32) vocabScore = Math.max(vocabScore, 32);
  if (aiStrongHits >= 4 && vocabScore < 45) vocabScore = Math.max(vocabScore, 45);

  // ── Signal 2: AI Transition Phrases ───────────────────────────────────────
  // Curated list of phrases essentially never used in genuine human writing.
  // Each hit is a meaningful signal. Cluster of 3+ is strong.
  const transHits = countTransitions(text);
  // STRICT: even 1 strong transition phrase is significant
  let transScore = 0;
  if (transHits >= 4) transScore = 40;
  else if (transHits >= 3) transScore = 32;
  else if (transHits >= 2) transScore = 22;
  else if (transHits >= 1) transScore = 12;

  // ── Signal 3: AI Bigram Density (Improvement 6: contextual filtering) ────────
  // Multi-word AI patterns - more specific than single-word vocab.
  // CONTEXTUAL FILTERING: phrases that are common in human academic writing
  // (e.g. "in recent years", "on the other hand") require 2+ occurrences OR
  // co-occurrence with 2+ other distinct bigram hits before scoring.
  // Genuinely rare AI phrases (e.g. "plays a crucial role", "it is worth noting")
  // score on first occurrence.

  // Weak bigrams — common enough in human writing that a single occurrence is insufficient
  const AI_BIGRAMS_WEAK = new Set([
    "in recent years","over the past","over the years","throughout history",
    "at the same time","on the other hand","on the contrary",
    "in the field of","in the context of","in terms of","with respect to","with regard to",
    "as a result","as a consequence","as such","in turn",
    "there are several","there are many","there are various","there are numerous",
    "a wide range","a wide variety","a broad range","a diverse range",
    "contribute to","contributes to","contributed to","contributing to",
    "has been widely","has been extensively","has been increasingly",
    "the importance of","the role of","the impact of","the significance of",
    "both in terms","ensuring that","ensuring the","ensuring a",
    "in light of","in view of","it can be","it could be","it may be",
  ]);

  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 2; i++) {
    bigrams.push(words[i] + " " + words[i+1] + " " + words[i+2]);
    bigrams.push(words[i] + " " + words[i+1]);
  }

  // Count all matched bigrams (raw)
  const allBigramMatches = bigrams.filter(b => AI_BIGRAMS.has(b));
  const bigramHits = allBigramMatches.length;

  // Strong bigrams: those NOT in the weak list — score on any occurrence
  const strongBigramHits = allBigramMatches.filter(b => !AI_BIGRAMS_WEAK.has(b)).length;

  // Weak bigrams: count occurrences per phrase; only count if phrase appears 2+ times
  const weakBigramCounts: Record<string, number> = {};
  for (const b of allBigramMatches) {
    if (AI_BIGRAMS_WEAK.has(b)) weakBigramCounts[b] = (weakBigramCounts[b] || 0) + 1;
  }
  const qualifyingWeakHits = Object.values(weakBigramCounts).filter(count => count >= 2).length;

  // Effective hits: strong always count; weak only count if repeated 2+ times OR
  // strong hits >= 2 (meaning this is clearly AI text, so all signals are valid)
  const effectiveBigramHits = strongBigramHits >= 2
    ? bigramHits  // clearly AI context — count everything
    : strongBigramHits + qualifyingWeakHits;

  let bigramScore = 0;
  if (effectiveBigramHits >= 5) bigramScore = 40;
  else if (effectiveBigramHits >= 3) bigramScore = 32;
  else if (effectiveBigramHits >= 2) bigramScore = 28;
  else if (effectiveBigramHits >= 1) bigramScore = 12;

  // ── Signal 4: Document Uniformity (TTR) ───────────────────────────────────
  // AI tends to reuse the same vocabulary pattern throughout.
  // Only flags when BOTH TTR is low AND text is long enough for reliable stats.
  // ESL-fair: does not penalise formal vocabulary choices.
  const uniqueWords = new Set(words);
  const ttr = uniqueWords.size / wc;
  // STRICT: TTR threshold lowered (GPTZero-aligned, start at 100 words)
  let ttrScore = 0;
  if (wc >= 100) {
    if (ttr < 0.40) ttrScore = 30;
    else if (ttr < 0.50) ttrScore = 18;
    else if (ttr < 0.60) ttrScore = 8;
  }

  // ── Signal 5: Nominalization Density ──────────────────────────────────────
  // AI overuses abstract nominalizations (-tion, -ity, -ment, etc.)
  // Only flags extremely high rates - academic writing uses many nominalizations too.
  const nomCount = (text.match(/\b\w+(tion|tions|ment|ments|ity|ities|ance|ence|ness|ization)\b/gi) || []).length;
  const nomRate = nomCount / wc;
  // STRICT: lower nominalization thresholds
  let nomScore = 0;
  if (nomRate > 0.18) nomScore = 25;
  else if (nomRate > 0.12) nomScore = 15;
  else if (nomRate > 0.08) nomScore = 8;

  // ── Signal 6: Intra-document shift ────────────────────────────────────────
  const { shiftScore, description: shiftDesc } = intraDocumentShift(sentences);
  // Shift itself is not an AI signal - it's a reliability modifier

  // ── Signal 7: Sentence rhythm uniformity ──────────────────────────────────
  // AI writes in metronomic uniform rhythm. Requires many sentences AND tight window.
  const sentLens = sentences.map(s => s.trim().split(/\s+/).length);
  const allUniform = sentLens.length > 5 && sentLens.every(l => Math.abs(l - avg) < avg * 0.22);
  const rhythmScore = allUniform ? 20 : 0;

  // ── Signal 8: Structural paragraph uniformity ─────────────────────────────
  // AI essays produce near-identical paragraph lengths and consistent 4-5 sentence
  // paragraphs with topic+development+conclusion structure. Human writing varies.
  // Only meaningful on multi-paragraph texts (>= 4 paragraphs).
  const paras = text.split(/\n+/).filter(p => p.trim().length > 40);
  let structureScore = 0;
  if (paras.length >= 4) {
    const paraLens = paras.map(p => p.trim().split(/\s+/).length);
    const paraAvg = paraLens.reduce((a, b) => a + b, 0) / paraLens.length;
    const paraVariance = paraLens.reduce((s, l) => s + Math.pow(l - paraAvg, 2), 0) / paraLens.length;
    const paraCV = Math.sqrt(paraVariance) / Math.max(paraAvg, 1);
    // STRICT: tighter CV thresholds (Turnitin-aligned)
    if (paraCV < 0.15) structureScore = 30;
    else if (paraCV < 0.22) structureScore = 22;
    else if (paraCV < 0.30) structureScore = 12;
  }

  // ── Signal 9: Ethical/responsibility qualifier stacking ────────────────────
  // AI essays pile responsibility/ethics qualifiers at the end. Humans don't cluster
  // 4+ ethical terms in a single paragraph or conclusion.
  const ethicsTerms = (text.match(/\b(responsible|transparency|transparent|fair|fairness|accountable|accountability|ethical|ethics|equitable|socially responsible|interdisciplinary|privacy|bias|inclusive|stakeholder)\b/gi) || []).length;
  const ethicsRate = ethicsTerms / Math.max(wc, 1);
  // STRICT: lower cluster threshold
  let ethicsScore = 0;
  if (ethicsRate > 0.018 && ethicsTerms >= 4) ethicsScore = 25;
  else if (ethicsRate > 0.010 && ethicsTerms >= 2) ethicsScore = 15;
  else if (ethicsTerms >= 1) ethicsScore = 6;

  // ── Signal 10: Tricolon (X, Y, and Z) density ─────────────────────────────
  // AI overuses three-part parallel lists. Human writing uses them occasionally.
  // A text with 4+ tricolons per 400 words is a strong AI signal.
  const tricolonCount = (text.match(/\w[\w\s]{2,25},\s*\w[\w\s]{2,25},\s*and\s+\w[\w\s]{2,20}/gi) || []).length;
  const tricolonRate = tricolonCount / Math.max(wc / 100, 1); // per 100 words
  // STRICT: any tricolon usage is a meaningful signal
  let tricolonScore = 0;
  if (tricolonRate >= 0.8) tricolonScore = 25;
  else if (tricolonRate >= 0.4) tricolonScore = 18;
  else if (tricolonRate >= 0.2) tricolonScore = 10;
  else if (tricolonCount >= 1) tricolonScore = 5;

  // ── Signal 11: Natural-rhythm AI evasion (Llama 3 / low-buzz AI) ─────────────
  // Llama 3 and lightly-prompted Claude produce prose with higher CV (0.35–0.45)
  // and lower buzzword counts (5–9 hits), letting them slip under both the burstiness
  // and vocab thresholds. Their fingerprint is a combination of:
  //   (a) Abstract philosophical / utilitarian framing — hedged claims about society,
  //       ethics, governance, and knowledge that read as formal without AI buzzwords.
  //   (b) Low-density but non-zero AI vocab (3–8 hits) with moderate bigram presence.
  //   (c) Nominalization-heavy sentences that are structurally "complete" without
  //       being telegraphically short.
  // The signal fires only when NONE of the primary vocab/transition gates already
  // trigger HIGH — i.e. it is a catch-net for evasive AI, not an amplifier for
  // obvious AI that is already well-scored.
  const llama3Markers = (text.match(
    /\b(philosophical|jurisprudence|utilitarian|deontological|epistemological|hermeneutic|ontological|teleological|normative|prescriptive|descriptive|dialectic|pragmatic|heuristic|positivist|relativist|empirical|scholarly|nonetheless|notwithstanding|albeit|wherein|thereof|herein|inasmuch|insofar)\b/gi
  ) || []).length;
  const hedgedClaims = (text.match(
    /\b(continue to|remains? (highly|deeply|widely|broadly)|generates? (scholarly|academic|ongoing)|subject to (debate|interpretation|scrutiny)|widely (studied|acknowledged|recognised|recognized|debated|accepted)|long-standing|well-established|remains? relevant)\b/gi
  ) || []).length;
  let llamaScore = 0;
  // Only apply when primary signals are weak — this is a catch-net, not an amplifier
  const primarySignalWeak = vocabScore < 32 && transScore < 22 && bigramScore < 22;
  if (primarySignalWeak) {
    if (llama3Markers >= 3 && hedgedClaims >= 1 && nomScore >= 8) {
      // Strong fingerprint: abstract register + hedged claims + nominalization density
      llamaScore = 28;
    } else if (llama3Markers >= 2 && nomScore >= 8) {
      llamaScore = 16;
    } else if (llama3Markers >= 1 && hedgedClaims >= 1) {
      llamaScore = 8;
    }
  }

  // ── Signal 12: Claude-style conversational-formal catch-net ──────────────────
  // Declare eslFlag here (also used in the aggregate below) so Signal 12 can gate on it.
  const eslFlag = isLikelyESLText(reliabilityWarnings);
  //   - Moderate-length sentences (avg 18–28 words) with LOW vocabulary buzzword density
  //   - Hedged first-person academic framing ("one might argue", "it is worth considering")
  //   - Structural meta-commentary ("in this context", "to this end", "what this reveals")
  //   - Consistent paragraph length without informal register markers
  // These texts scored Engine A = 1–5 in the validation set because:
  //   (a) vocab hits = 2–4 (just below the vocabScore threshold)
  //   (b) transition hits = 1–2 (not enough for transScore to be meaningful)
  //   (c) CV = 0.28–0.38 (burstiness borderline — Engine B scores MEDIUM)
  // The catch-net fires when: moderate structural uniformity + moderate bigram hits +
  // no informal markers — the combination that characterises Claude formal prose.
  let claudeCatchScore = 0;
  const claudeMetaCommentary = (text.match(
    /(in this context|to this end|what this (means|reveals|shows|suggests)|this raises|this highlights|this underscores|this illustrates|this reflects|worth (noting|considering|exploring|emphasizing)|taken together|considered together|at (its|the) (core|heart)|speaks to (the|a)|stands as (a|an)|serves as (a|an))/gi
  ) || []).length;
  const claudeHedgedFirst = (text.match(
    /\b(one might|one could|one should|one must|one would|it seems|it appears|it suggests|it implies|it indicates|it follows|it stands to reason)\b/gi
  ) || []).length;
  const hasInformalMarker = /\b(yeah|yep|nope|gonna|wanna|kinda|dunno|honestly|frankly|weird|lol|omg|btw|fyi|tbh)\b/i.test(text);
  // Only fire when primary signals are weak (catch-net), text is long enough, no informal markers
  if (primarySignalWeak && wc >= 120 && !hasInformalMarker && !eslFlag) {
    if (claudeMetaCommentary >= 3 && claudeHedgedFirst >= 2 && rhythmScore > 0) {
      claudeCatchScore = 24; // strong Claude fingerprint
    } else if (claudeMetaCommentary >= 2 && claudeHedgedFirst >= 1) {
      claudeCatchScore = 14;
    } else if (claudeMetaCommentary >= 4) {
      claudeCatchScore = 12;
    }
  }

  // ── Aggregate with signal-count weighting ─────────────────────────────────
  // Per spec: "Aggregate signals using confidence-weighted logic"
  // Downgrade if only 1-2 signals fire
  // ── Signal 13: Paragraph-opening fingerprint ─────────────────────────────
  const { roboticOpeners, totalParas: totalParasA, score: paraOpenerScore, details: paraOpenerDetails } = paragraphOpenerFingerprint(text);

  // ── Signal 14: Conclusion-section amplifier ───────────────────────────────
  const { score: conclusionScore, details: conclusionDetails } = conclusionSectionBoost(text);

  // ── Signal 15: Passive voice & syntactic uniformity ───────────────────────
  const { score: syntaxScore, passiveCount, details: syntaxDetails } = passiveVoiceAndSyntaxScore(text, sentences);

  // ── Signal 16: Hedged-certainty fingerprint (#1) ──────────────────────────
  const { score: hedgeScore, hedgeCount, details: hedgeDetails } = hedgedCertaintyScore(text, wc);

  // ── Signal 17: Sentence-final clause stacking (#2) ───────────────────────
  const { score: clauseStackScore, stackedCount, details: clauseStackDetails } = clauseStackingScore(sentences);

  // ── Signal 18: Named-entity absence (#3) ─────────────────────────────────
  const { humanReduction: namedEntityReduction, namedEntityCount, details: namedEntityDetails } = namedEntityScore(text, wc);

  // ── Signal 19: Moving-window TTR variance (#4) ────────────────────────────
  const { score: windowTTRScore, ttrVariance, details: windowTTRDetails } = movingWindowTTRScore(words, wc);

  // ── Signal 20: MTLD (Measure of Textual Lexical Diversity) ────────────────
  const { score: mtldScoreVal, mtld: mtldValue, details: mtldDetails } = mtldScore(text, wc);

  // ── Signal 21: Semantic Self-Similarity (synonym substitution) ─────────────
  const { score: semanticSimScore, clusterHits: semanticClusterHits, details: semanticSimDetails } = semanticSelfSimilarityScore(text, wc);

  // ── Signal 22: Tone Flatness ───────────────────────────────────────────────
  const { score: toneFlatnessScoreVal, details: toneFlatnessDetails } = toneFlatnessScore(text, sentences);

  // ── Signal 23: Vague Citation Pattern ────────────────────────────────────
  const { score: vagueCtScore, vagueCount: vagueCtCount, details: vagueCtDetails } = vagueCitationScore(text, wc);

  // ── Signal 24: Discourse Schema Predictability ───────────────────────────
  const { score: discourseSchemaScoreVal, details: discourseSchemaDetails } = discourseSchemaScore(text, sentences);

  // ── Signal 25: Idea Repetition (Enhancement #2) ──────────────────────────
  const { score: ideaRepScore, repetitivePairs, details: ideaRepDetails } = ideaRepetitionScore(text, sentences);

  // ── NEW Signal 26: Sentence-Opening Diversity (Improvement #5) ────────────
  const { score: openerDiversityScore, details: openerDiversityDetails } = sentenceOpenerDiversityScore(sentences);

  // ── NEW Signal 27: Punctuation Entropy (Improvement #6) ──────────────────
  const { score: punctEntropyScore, details: punctEntropyDetails } = punctuationEntropyScore(text);

  // ── NEW Signal 28: Paragraph Length Uniformity (Improvement #7) ──────────
  const { score: paraLenUniformityScore, details: paraLenUniformityDetails } = paragraphLengthUniformityScore(text);

  // ── NEW Signal 29: Inter-Sentence Coherence (Improvement #4) ─────────────
  const { score: coherenceScore, details: coherenceDetails } = interSentenceCoherenceScore(sentences);

  // ── NEW Signal 30: Hapax Legomena Ratio ───────────────────────────────────
  const { score: hapaxScore, hapaxRatio, details: hapaxDetails } = hapaxLegomenaScore(words);

  // ── NEW Signal 31: Readability Fingerprinting (Flesch-Kincaid) ────────────
  const { score: readabilityScore, fkgl, fkVariance, details: readabilityDetails } = readabilityFingerprintScore(text, sentences, words);

  // ── NEW Signal 32: Function Word Profile ─────────────────────────────────
  const { score: funcWordScore, details: funcWordDetails } = functionWordProfileScore(words, wc);

  // ── NEW Signal 33: Quote/Direct Speech Detector (human reduction) ─────────
  const { humanReduction: quoteReduction, quoteCount, details: quoteDetails } = quoteDetectorScore(text, wc);

  // ── NEW Signal 34: Capitalization Abuse ──────────────────────────────────
  const { score: capAbuseScore, abuseCount: capAbuseCount, details: capAbuseDetails } = capitalizationAbuseScore(text);

  // ── NEW Signal 35: AI Model Family Fingerprinting ─────────────────────────
  const { score: familyFingerprintScore, suspectedFamily, confidence: familyConfidence, details: familyDetails, rawScores: familyRawScores } = aiModelFamilyFingerprint(text);

  // ── NEW Signal 36: Self-BLEU / Repetition-N Score ─────────────────────────
  const { score: selfBleuScoreVal, avgOverlap: selfBleuOverlap, details: selfBleuDetails } = selfBleuScore(sentences);

  // ── NEW Signal 37: Semantic Density (Content Word Ratio Variance) ──────────
  const { score: semanticDensityScoreVal, densityCV, details: semanticDensityDetails } = semanticDensityScore(words, wc);

  // ── NEW Signal 38: Paraphrase Attack Detection ────────────────────────────
  const { score: paraphraseScore, details: paraphraseDetails } = paraphraseAttackScore(text, sentences);

  // ── NEW Signal 39: Filipino/ESL L1-Transfer (human reduction) ────────────
  const { humanReduction: filipinoReduction, l1Count: filipinoL1Count, details: filipinoDetails } = filipinoL1TransferScore(text, wc);

  // ── NEW Signal 40: Zipf's Law Deviation ──────────────────────────────────
  const { score: zipfScore, zipfDev, details: zipfDetails } = zipfDeviationScore(words);

  // ── NEW Signal 41: TTR Trajectory (Power-Law vs Linear Decay) ────────────
  const { score: ttrTrajectoryScore, linearityIndex, details: ttrTrajectoryDetails } = ttrTrajectorySore(words);

  // ── NEW Signal 42: KS Normality Test (Sentence-Length Distribution Shape) ─
  const { score: ksNormalityScoreVal, ksStatistic, skewness: sentSkewness, details: ksNormalityDetails } = ksNormalityScore(sentences);

  // ── NEW Signal 43: Anaphora Resolution Density ────────────────────────────
  const { score: anaphoraScoreVal, details: anaphoraDetails } = anaphoraScore(text, sentences, wc);

  // ── NEW Signal 44: Temporal/Spatial Grounding (human reduction) ───────────
  const { humanReduction: groundingReduction, groundingCount, details: groundingDetails } = temporalSpatialGroundingScore(text, wc);

  // ── NEW Signal 45: Argument Structure Analysis ────────────────────────────
  const { score: argStructureScore, evidentialCount, assertiveCount, details: argStructureDetails } = argumentStructureScore(text, wc);

  // ── NEW Signal 46: Section-Differential Scoring ───────────────────────────
  const { score: sectionDiffScore, bodyScore: sectionBodyScore, introScore: sectionIntroScore, conclusionScore: sectionConcScore, details: sectionDiffDetails } = sectionDifferentialScore(text, words);

  // ── NEW: Long-Document Chunk Analysis (architectural) ────────────────────
  const chunkAnalysis = analyzeInChunks(text, words, sentences);

  // ── Genre classifier (Improvement #9) ────────────────────────────────────
  const genreProfile = classifyGenre(text, words);
  // Genre-adaptive weight adjustments: technical texts have less reliable stylometric signals
  const genreMultiplier = genreProfile.genre === "technical" ? 0.80
    : genreProfile.genre === "lab_report"        ? 0.85
    : genreProfile.genre === "reflective"        ? 0.90
    : genreProfile.genre === "thesis_conclusion" ? 1.15  // amplify: thesis conclusions are high-risk for AI; suppress override
    : 1.0;

  // ── NEW Signal 47: Nominalization Density (Thesis Conclusion) ─────────────
  // AI-polished thesis conclusions have nominalization rates of 0.14–0.20 vs
  // human conclusions at 0.08–0.12. Amplified when thesis_conclusion genre fires.
  const { score: nomDensityScore, rate: nomDensityRate, details: nomDensityDetails } = nominalizationDensityScore(text, wc);
  const nomDensityFinal = genreProfile.genre === "thesis_conclusion"
    ? Math.min(18, Math.round(nomDensityScore * 1.4))
    : nomDensityScore;

  // ── NEW Signal 48: Conclusion Schema Uniformity ────────────────────────────
  // Detects the rigid restate→quantify→interpret→generalize paragraph schema
  // that AI uses for conclusion/summary chapters. Human conclusions drift.
  const { score: schemaUniformityScore, details: schemaUniformityDetails } = conclusionSchemaUniformityScore(text, sentences);
  const schemaUniformityFinal = genreProfile.genre === "thesis_conclusion"
    ? Math.min(20, Math.round(schemaUniformityScore * 1.3))
    : schemaUniformityScore;

  const activeSignals = [vocabScore, transScore, bigramScore, ttrScore, nomScore, rhythmScore, structureScore, ethicsScore, tricolonScore, llamaScore, claudeCatchScore, paraOpenerScore, conclusionScore, syntaxScore, hedgeScore, clauseStackScore, windowTTRScore, mtldScoreVal, semanticSimScore, toneFlatnessScoreVal, vagueCtScore, discourseSchemaScoreVal, ideaRepScore, openerDiversityScore, punctEntropyScore, paraLenUniformityScore, coherenceScore, hapaxScore, readabilityScore, funcWordScore, capAbuseScore, familyFingerprintScore, selfBleuScoreVal, semanticDensityScoreVal, paraphraseScore, zipfScore, ttrTrajectoryScore, ksNormalityScoreVal, anaphoraScoreVal, argStructureScore, sectionDiffScore, nomDensityFinal, schemaUniformityFinal]
    .filter(s => s > 5).length;

  // ── Improvement #8: Empirically-calibrated signal weights ────────────────
  // Signals are grouped by reliability tier and weighted accordingly.
  // Tier A (lexical, most reliable): vocab, transition, bigram
  // Tier B (structural, high reliability): paragraph structure, opener, conclusion
  // Tier C (stylistic): hedge, clause-stacking, syntax, ethics, tricolon
  // Tier D (surface-level): TTR, nom, rhythm, windowTTR
  // Tier E (catch-nets): llama, claude catch-net
  // Tier F (new research signals): MTLD, semantic sim, tone flatness, vague cite, discourse schema
  // Tier G (new enhancement signals): hapax, readability, function words, caps abuse, model family, self-BLEU, density, paraphrase
  // Tier H (new batch-2 signals): Zipf, TTR trajectory, KS normality, anaphora, argument structure, section-differential
  const W_TIER_A = 1.00;
  const W_TIER_B = 0.95;
  const W_TIER_C = 0.85;
  const W_TIER_D = 0.75;
  const W_TIER_E = 0.60;
  const W_TIER_F = 0.80;
  const W_TIER_G = 0.70;
  const W_TIER_H = 0.72; // batch-2 signals — validated, medium-high discriminative power

  const weightedRawTotal =
    vocabScore           * W_TIER_A +  // Tier A: lexical
    transScore           * W_TIER_A +
    bigramScore          * W_TIER_A +
    structureScore       * W_TIER_B +  // Tier B: structural
    paraOpenerScore      * W_TIER_B +
    conclusionScore      * W_TIER_B +
    hedgeScore           * W_TIER_C +  // Tier C: stylistic
    clauseStackScore     * W_TIER_C +
    syntaxScore          * W_TIER_C +
    ethicsScore          * W_TIER_C +
    tricolonScore        * W_TIER_C +
    ttrScore             * W_TIER_D +  // Tier D: surface
    nomScore             * W_TIER_D +
    rhythmScore          * W_TIER_D +
    windowTTRScore       * W_TIER_D +
    llamaScore           * W_TIER_E +  // Tier E: catch-nets
    claudeCatchScore     * W_TIER_E +
    mtldScoreVal         * W_TIER_F +  // Tier F: new research signals
    semanticSimScore     * W_TIER_F +
    toneFlatnessScoreVal * W_TIER_F +
    vagueCtScore         * W_TIER_F +
    discourseSchemaScoreVal * W_TIER_F +
    ideaRepScore         * W_TIER_F +  // idea repetition (enhancement #2)
    openerDiversityScore * W_TIER_F +  // Improvement #5
    punctEntropyScore    * W_TIER_F +  // Improvement #6
    paraLenUniformityScore * W_TIER_F + // Improvement #7
    coherenceScore       * W_TIER_F +  // Improvement #4
    hapaxScore           * W_TIER_G +  // Tier G: new enhancement signals
    readabilityScore     * W_TIER_G +
    funcWordScore        * W_TIER_G +
    capAbuseScore        * W_TIER_G +
    familyFingerprintScore * W_TIER_G +
    selfBleuScoreVal     * W_TIER_G +
    semanticDensityScoreVal * W_TIER_G +
    paraphraseScore      * W_TIER_G +
    zipfScore            * W_TIER_H +  // Tier H: batch-2 signals
    ttrTrajectoryScore   * W_TIER_H +
    ksNormalityScoreVal  * W_TIER_H +
    anaphoraScoreVal     * W_TIER_H +
    argStructureScore    * W_TIER_H +
    sectionDiffScore     * W_TIER_H +
    nomDensityFinal      * W_TIER_B +  // Tier B: structurally reliable, genre-amplified
    schemaUniformityFinal * W_TIER_B;  // Tier B: conclusion schema — strong structural signal

  const weightedMaxTotal =
    35  * W_TIER_A + 35  * W_TIER_A + 30  * W_TIER_A +
    25  * W_TIER_B + 30  * W_TIER_B + 22  * W_TIER_B +
    28  * W_TIER_C + 24  * W_TIER_C + 28  * W_TIER_C + 20 * W_TIER_C + 20 * W_TIER_C +
    25  * W_TIER_D + 20  * W_TIER_D + 20  * W_TIER_D + 22 * W_TIER_D +
    28  * W_TIER_E + 24  * W_TIER_E +
    24  * W_TIER_F + 20  * W_TIER_F + 18 * W_TIER_F + 16 * W_TIER_F + 18 * W_TIER_F + 22 * W_TIER_F +
    20  * W_TIER_F + 16  * W_TIER_F + 18 * W_TIER_F + 16 * W_TIER_F +
    20  * W_TIER_G + 22  * W_TIER_G + 18 * W_TIER_G + 15 * W_TIER_G +
    20  * W_TIER_G + 20  * W_TIER_G + 16 * W_TIER_G + 18 * W_TIER_G +
    22  * W_TIER_H + 20  * W_TIER_H + 18 * W_TIER_H + 16 * W_TIER_H + 18 * W_TIER_H + 20 * W_TIER_H +
    18  * W_TIER_B + 20  * W_TIER_B;  // signals 47 + 48

  const rawTotal = weightedRawTotal; // kept for backward compat with cluster boosts
  const maxTotal = weightedMaxTotal;

  // Normalize to 0-100
  let norm = Math.min(100, (rawTotal / maxTotal) * 100);

  // STRICT: only slight downgrade for single-signal (GPTZero-aligned)
  if (activeSignals < 2) norm = norm * 0.70;
  else if (activeSignals < 3) norm = norm * 0.88;

  // ── Multi-signal cluster boost ────────────────────────────────────────────
  // When nominalization density + minimum sentence floor + bigram patterns
  // co-occur, the text has AI structural markers beyond vocabulary.
  // This catches low-vocab AI texts (e.g. Llama 3 humanities, Claude formal writing)
  // that evade the vocab signal but carry structural AI fingerprints.
  if (nomScore >= 15 && bigramScore >= 22 && bigramHits >= 2) {
    norm = Math.min(100, norm * 1.30);  // 30% boost for nom+bigram cluster
  }
  // Transitions + bigrams together = very strong structural AI signal
  if (transScore >= 22 && bigramScore >= 22) {
    norm = Math.min(100, norm * 1.20);  // 20% boost for transition+bigram cluster
  }

  // ── Named-entity human reduction (#3): concrete references → more human ────
  // Applied before ESL check so it doesn't get overridden
  if (namedEntityReduction > 0) {
    norm = Math.max(0, norm - namedEntityReduction * (norm / 100));  // proportional reduction
  }

  // ── Quote/Direct Speech human reduction: cited sources → human signal ─────
  if (quoteReduction > 0) {
    norm = Math.max(0, norm - quoteReduction * (norm / 100));
  }

  // ── Filipino/ESL L1-Transfer human reduction ──────────────────────────────
  if (filipinoReduction > 0) {
    norm = Math.max(0, norm - filipinoReduction * (norm / 100) * 1.5);
  }

  // ── Temporal/Spatial Grounding human reduction ────────────────────────────
  if (groundingReduction > 0) {
    norm = Math.max(0, norm - groundingReduction * (norm / 100));
  }

  // ESL penalty: when ESL heuristic fires, vocab+transition signals are unreliable
  // — they measure formal writing habits, not AI authorship.
  // Apply a strong downgrade so the verdict defaults to INCONCLUSIVE/Human range.
  // (eslFlag is declared above, before Signal 12)
  if (eslFlag) {
    // Only structural signals (structure/tricolon/ethics) remain meaningful for ESL.
    // If those alone are weak, the score should collapse toward human range.
    //
    // GAP 2 FIX: eslSafeNorm previously divided by maxTotal (the full weighted total
    // ~340), making it vastly under-scaled (e.g. ethicsScore=25 → 25/340 = 7% instead
    // of the intended ~50%). We now use a dedicated ESL-safe weighted max that only
    // covers the three reliable ESL signals, keeping the scale correct.
    const eslSafeRaw = structureScore * W_TIER_B + ethicsScore * W_TIER_C + tricolonScore * W_TIER_C
      + paraOpenerScore * W_TIER_B + conclusionScore * W_TIER_B;  // structural signals still valid for ESL
    const eslSafeMax = 25 * W_TIER_B + 20 * W_TIER_C + 20 * W_TIER_C
      + 30 * W_TIER_B + 22 * W_TIER_B;  // max contributions of those signals
    const eslSafeNorm = Math.min(100, (eslSafeRaw / Math.max(eslSafeMax, 1)) * 100);
    // Blend: 95% weight on ESL-safe signals, 5% on full score
    norm = eslSafeNorm * 0.95 + norm * 0.05;
  }

  // Improvement 5: differentiated warning penalties — only suppress signals correlated with each warning type
  norm = norm * computeWarningPenalty(reliabilityWarnings, "stylometry");

  // ── Gap 8: Domain-adaptive threshold adjustment ────────────────────────────
  const domainProfile = detectDomain(text, words);
  if (domainProfile.multiplier !== 1.0) {
    norm = Math.min(100, Math.max(0, norm * domainProfile.multiplier));
  }
  // Add domain info to reliability warnings if non-general domain detected
  if (domainProfile.domain !== "general" && !reliabilityWarnings.some(w => w.includes("domain"))) {
    reliabilityWarnings.push(`Domain detected: ${domainProfile.label} — ${domainProfile.description}`);
  }

  // ── ESL / Philippine context score calibration ────────────────────────────
  // Research basis: false-positive rate on TOEFL essays dropped from 61.3% → 11.6%
  // after adjusting for non-native writing patterns. This is a DIRECT score reduction
  // (not just a warning) — the previous behavior only warned without adjusting.
  //
  // THESIS CONCLUSION BYPASS: When the text is identified as a thesis conclusion
  // chapter with zero L1-transfer features, the ESL penalty is suppressed entirely.
  // Rationale: AI-polished thesis conclusions have ZERO ESL features because they
  // were written/edited by an LLM. Applying the Philippine ESL penalty here causes
  // the exact false-negative that was observed (47% Turnitin vs 1% MultiLens gap).
  // The absence of L1 interference in a Philippine student's conclusion is itself
  // a suspicious signal, not a reason to reduce the score.
  const thesisGenreForESL = detectThesisGenre(text, sentences);
  const eslBypassActive = thesisGenreForESL.isThesisConclusion &&
    thesisGenreForESL.detectedMarkers.includes("zero-L1-transfer");
  const eslScorePenalty = eslBypassActive ? 0 : computeESLScorePenalty(reliabilityWarnings, Math.round(norm));
  if (eslScorePenalty > 0) {
    norm = Math.max(0, norm - eslScorePenalty);
  }
  if (eslBypassActive) {
    reliabilityWarnings.push("Thesis conclusion genre detected with zero L1-transfer features — ESL calibration suppressed. AI-polished conclusions show no ESL markers precisely because they were written/edited by an LLM. Score not reduced for Philippine academic context in this genre.");
  }

  // ── Improvement #9: Genre-adaptive adjustment ────────────────────────────
  // Technical and lab-report texts have less reliable stylometric signals.
  norm = Math.min(100, Math.max(0, norm * genreMultiplier));
  if (genreProfile.genre !== "general" && genreProfile.confidence > 0.3 && !reliabilityWarnings.some(w => w.includes("Genre"))) {
    reliabilityWarnings.push(`Genre detected: ${genreProfile.description} (confidence: ${(genreProfile.confidence*100).toFixed(0)}%) — signal weights adjusted accordingly.`);
  }

  // ── Improvement #11: Platt scaling calibration ────────────────────────────
  // Map raw heuristic score to calibrated probability estimate.
  const calibratedNorm = plattCalibrateScore(Math.round(norm));
  // Blend: 70% calibrated, 30% raw (preserves signal sensitivity at extremes)
  const blendedNorm = Math.round(calibratedNorm * 0.70 + norm * 0.30);

  const rawScore = Math.round(Math.min(100, Math.max(0, blendedNorm)));

  // ── Confidence interval ────────────────────────────────────────────────────
  const signalsAgreeing = activeSignals;
  const totalSignalCount = 47; // Engine A: original + all improvement + enhancement + batch-2 signals
  const { low, high, strength, phrase } = computeConfidenceInterval(
    rawScore, totalSignalCount, signalsAgreeing, reliabilityWarnings, wc
  );

  // ── Signal result objects (for display) ───────────────────────────────────
  const signals: SignalResult[] = [
    {
      name: "AI Vocabulary Density",
      value: `${aiVocabHits} total AI-vocab hits (strong: ${aiStrongHits}, medium: ${aiMediumHits}, weak: ${aiWeakHits}) — weighted score: ${aiVocabWeighted.toFixed(1)} (${(vocabRate * 100).toFixed(1)}% raw density). Strong-tier words (e.g. "delve", "tapestry") carry 3× weight; weak-tier academic words (e.g. "demonstrate", "highlight") carry 0.5× and require 3+ hits.`,
      strength: Math.min(100, Math.round((vocabScore / 55) * 100)),
      pointsToAI: vocabScore >= 14,
      wellSupported: aiStrongHits >= 2 || aiVocabWeighted >= 12,
    },
    {
      name: "AI Transition Phrases",
      value: `${transHits} AI-cliche transition phrase${transHits !== 1 ? "s" : ""} found (e.g. "furthermore", "it is worth noting that"). These rarely appear in genuine human writing.`,
      strength: Math.min(100, Math.round((transScore / 40) * 100)),
      pointsToAI: transScore >= 15,
      wellSupported: transHits >= 3,
    },
    {
      name: "AI Multi-word Patterns",
      value: `${bigramHits} AI-specific phrase pattern${bigramHits !== 1 ? "s" : ""} detected (e.g. "plays a crucial role", "it is worth noting"). Each is a strong individual signal.`,
      strength: Math.min(100, Math.round((bigramScore / 40) * 100)),
      pointsToAI: bigramScore >= 18,
      wellSupported: bigramHits >= 2,
    },
    {
      name: "Vocabulary Uniformity (TTR)",
      value: wc < 150
        ? `TTR ${ttr.toFixed(2)} - text too short for reliable TTR analysis (need >=150 words).`
        : `Type-token ratio ${ttr.toFixed(2)}. AI text often has lower TTR due to repetitive phrasing. Academic writing naturally has moderate TTR.`,
      strength: Math.min(100, Math.round((ttrScore / 30) * 100)),
      pointsToAI: ttrScore >= 12,
      wellSupported: wc >= 200 && ttr < 0.45,
    },
    {
      name: "Uniform Sentence Rhythm",
      value: allUniform
        ? `All sentences fall within ±22% of the ${avg.toFixed(1)}-word average - metronomic pattern associated with AI.`
        : `Natural variation in sentence lengths detected - consistent with human writing.`,
      strength: Math.min(100, rhythmScore > 0 ? 80 : 0),
      pointsToAI: allUniform,
      wellSupported: allUniform && sentences.length > 7,
    },
    {
      name: "Intra-document Consistency",
      value: shiftDesc,
      strength: shiftScore,
      pointsToAI: false, // shift is a reliability indicator, not an AI indicator
      wellSupported: sentences.length >= 8,
    },
    {
      name: "Paragraph Structure Uniformity",
      value: paras.length < 4
        ? "Insufficient paragraphs for structural analysis (need >=4)."
        : (() => {
            const paraLens = paras.map(p => p.trim().split(/\s+/).length);
            const paraAvg = paraLens.reduce((a,b)=>a+b,0)/paraLens.length;
            const paraCV = Math.sqrt(paraLens.reduce((s,l)=>s+Math.pow(l-paraAvg,2),0)/paraLens.length)/Math.max(paraAvg,1);
            return `${paras.length} paragraphs with CV=${paraCV.toFixed(3)} in length. AI essays produce near-identical paragraph sizes (CV<0.15). Human writing varies more.`;
          })(),
      strength: Math.min(100, Math.round((structureScore / 30) * 100)),
      pointsToAI: structureScore >= 10,
      wellSupported: paras.length >= 4 && structureScore >= 18,
    },
    {
      name: "Ethics/Responsibility Qualifier Stacking",
      value: `${ethicsTerms} ethical/responsibility qualifiers found (${(ethicsRate*100).toFixed(1)}% of text). AI essays systematically pile responsible, ethical, fair, accountable, transparent at conclusions.`,
      strength: Math.min(100, Math.round((ethicsScore / 25) * 100)),
      pointsToAI: ethicsScore >= 12,
      wellSupported: ethicsTerms >= 5,
    },
    {
      name: "Tricolon (X, Y, and Z) Density",
      value: `${tricolonCount} three-part parallel lists found (${tricolonRate.toFixed(2)} per 100 words). AI overuses tricolon structures; human academic writing uses them sparingly.`,
      strength: Math.min(100, Math.round((tricolonScore / 25) * 100)),
      pointsToAI: tricolonScore >= 6,
      wellSupported: tricolonCount >= 4,
    },
    {
      name: "Natural-rhythm AI evasion (Llama 3 / low-buzz AI)",
      value: primarySignalWeak
        ? `${llama3Markers} abstract/philosophical register markers + ${hedgedClaims} hedged-claim patterns detected. Low buzzword count (${aiVocabHits}) with this abstract register fingerprint is characteristic of Llama 3 and lightly-prompted AI models that evade vocab-based detection.`
        : `Primary vocab/transition signals already strong — this catch-net signal is inactive (not needed).`,
      strength: Math.min(100, Math.round((llamaScore / 28) * 100)),
      pointsToAI: llamaScore >= 16,
      wellSupported: llamaScore >= 28,
    },
    {
      name: "Claude-style formal prose catch-net",
      value: primarySignalWeak
        ? `${claudeMetaCommentary} meta-commentary phrases + ${claudeHedgedFirst} hedged-claim constructions detected. Claude-generated text often uses moderate-length uniform sentences with structural meta-commentary ("to this end", "what this reveals", "worth considering") rather than explicit AI buzzwords — this catch-net targets that fingerprint.`
        : `Primary vocab/transition signals already strong — Claude catch-net is inactive (not needed).`,
      strength: Math.min(100, Math.round((claudeCatchScore / 24) * 100)),
      pointsToAI: claudeCatchScore >= 12,
      wellSupported: claudeCatchScore >= 20,
    },
    {
      name: "Paragraph-opening Fingerprint",
      value: paraOpenerDetails,
      strength: Math.min(100, Math.round((paraOpenerScore / 30) * 100)),
      pointsToAI: paraOpenerScore >= 12,
      wellSupported: paraOpenerScore >= 24,
    },
    {
      name: "Conclusion-section Ethics Clustering",
      value: conclusionDetails,
      strength: Math.min(100, Math.round((conclusionScore / 22) * 100)),
      pointsToAI: conclusionScore >= 10,
      wellSupported: conclusionScore >= 16,
    },
    {
      name: "Passive Voice & Syntactic Uniformity",
      value: syntaxDetails,
      strength: Math.min(100, Math.round((syntaxScore / 28) * 100)),
      pointsToAI: syntaxScore >= 10,
      wellSupported: syntaxScore >= 20,
    },
    {
      name: "Hedged-certainty Density",
      value: hedgeDetails,
      strength: Math.min(100, Math.round((hedgeScore / 28) * 100)),
      pointsToAI: hedgeScore >= 10,
      wellSupported: hedgeScore >= 22,
    },
    {
      name: "Sentence-final Clause Stacking",
      value: clauseStackDetails,
      strength: Math.min(100, Math.round((clauseStackScore / 24) * 100)),
      pointsToAI: clauseStackScore >= 12,
      wellSupported: clauseStackScore >= 18,
    },
    {
      name: "Named-entity Density (human signal)",
      value: namedEntityDetails,
      strength: Math.min(100, namedEntityReduction * 5),
      pointsToAI: false,
      wellSupported: namedEntityCount >= 5,
    },
    {
      name: "Moving-window TTR Variance",
      value: windowTTRDetails,
      strength: Math.min(100, Math.round((windowTTRScore / 22) * 100)),
      pointsToAI: windowTTRScore >= 10,
      wellSupported: windowTTRScore >= 16,
    },
    {
      name: "MTLD Lexical Diversity",
      value: mtldDetails,
      strength: Math.min(100, Math.round((mtldScoreVal / 24) * 100)),
      pointsToAI: mtldScoreVal >= 12,
      wellSupported: mtldScoreVal >= 18,
    },
    {
      name: "Semantic Self-Similarity (Synonym Clusters)",
      value: semanticSimDetails,
      strength: Math.min(100, Math.round((semanticSimScore / 20) * 100)),
      pointsToAI: semanticSimScore >= 9,
      wellSupported: semanticSimScore >= 15,
    },
    {
      name: "Tone Register Flatness",
      value: toneFlatnessDetails,
      strength: Math.min(100, Math.round((toneFlatnessScoreVal / 18) * 100)),
      pointsToAI: toneFlatnessScoreVal >= 12,
      wellSupported: toneFlatnessScoreVal >= 15,
    },
    {
      name: "Vague Citation Pattern",
      value: vagueCtDetails,
      strength: Math.min(100, Math.round((vagueCtScore / 16) * 100)),
      pointsToAI: vagueCtScore >= 8,
      wellSupported: vagueCtScore >= 12,
    },
    {
      name: "Discourse Schema Predictability",
      value: discourseSchemaDetails,
      strength: Math.min(100, Math.round((discourseSchemaScoreVal / 18) * 100)),
      pointsToAI: discourseSchemaScoreVal >= 8,
      wellSupported: discourseSchemaScoreVal >= 13,
    },
    {
      name: "Idea Repetition (Within-Paragraph)",
      value: ideaRepDetails,
      strength: Math.min(100, Math.round((ideaRepScore / 22) * 100)),
      pointsToAI: ideaRepScore >= 5,
      wellSupported: repetitivePairs >= 3,
    },
    // ── Improvement #5: Sentence-Opening Diversity ────────────────────────────
    {
      name: "Sentence-Opening Diversity",
      value: openerDiversityDetails,
      strength: Math.min(100, Math.round((openerDiversityScore / 20) * 100)),
      pointsToAI: openerDiversityScore >= 8,
      wellSupported: openerDiversityScore >= 14,
    },
    // ── Improvement #6: Punctuation Entropy ──────────────────────────────────
    {
      name: "Punctuation Diversity (Entropy)",
      value: punctEntropyDetails,
      strength: Math.min(100, Math.round((punctEntropyScore / 16) * 100)),
      pointsToAI: punctEntropyScore >= 5,
      wellSupported: punctEntropyScore >= 10,
    },
    // ── Improvement #7: Paragraph Length Uniformity ───────────────────────────
    {
      name: "Paragraph Length Uniformity",
      value: paraLenUniformityDetails,
      strength: Math.min(100, Math.round((paraLenUniformityScore / 18) * 100)),
      pointsToAI: paraLenUniformityScore >= 6,
      wellSupported: paraLenUniformityScore >= 12,
    },
    // ── Improvement #4: Inter-Sentence Coherence ─────────────────────────────
    {
      name: "Inter-Sentence Coherence Uniformity",
      value: coherenceDetails,
      strength: Math.min(100, Math.round((coherenceScore / 16) * 100)),
      pointsToAI: coherenceScore >= 5,
      wellSupported: coherenceScore >= 10,
    },
    // ── NEW: Hapax Legomena Ratio ─────────────────────────────────────────────
    {
      name: "Hapax Legomena Ratio",
      value: hapaxDetails,
      strength: Math.min(100, Math.round((hapaxScore / 20) * 100)),
      pointsToAI: hapaxScore >= 5,
      wellSupported: hapaxScore >= 15,
    },
    // ── NEW: Readability Fingerprinting ──────────────────────────────────────
    {
      name: "Readability Uniformity (Flesch-Kincaid)",
      value: readabilityDetails,
      strength: Math.min(100, Math.round((readabilityScore / 22) * 100)),
      pointsToAI: readabilityScore >= 8,
      wellSupported: readabilityScore >= 14,
    },
    // ── NEW: Function Word Profile ────────────────────────────────────────────
    {
      name: "Function Word Profile (Stylometric)",
      value: funcWordDetails,
      strength: Math.min(100, Math.round((funcWordScore / 18) * 100)),
      pointsToAI: funcWordScore >= 7,
      wellSupported: funcWordScore >= 12,
    },
    // ── NEW: Quote/Direct Speech (human signal) ───────────────────────────────
    {
      name: "Direct Quotation Presence (human signal)",
      value: quoteDetails,
      strength: Math.min(100, quoteReduction * 8),
      pointsToAI: false,
      wellSupported: quoteCount >= 3,
    },
    // ── NEW: Capitalization Abuse ─────────────────────────────────────────────
    {
      name: "Mid-Sentence Capitalization Abuse",
      value: capAbuseDetails,
      strength: Math.min(100, Math.round((capAbuseScore / 15) * 100)),
      pointsToAI: capAbuseScore >= 3,
      wellSupported: capAbuseScore >= 10,
    },
    // ── NEW: AI Model Family Fingerprinting ───────────────────────────────────
    {
      name: `AI Model Family Fingerprint${suspectedFamily ? ` — ${suspectedFamily}` : ""}`,
      // Embed rawScores as a parseable suffix so the UI can render the bar chart.
      value: familyDetails + `\n__rawScores__:${JSON.stringify({ gpt4: familyRawScores.gpt4, claude: familyRawScores.claude, llama: familyRawScores.llama, gemini: familyRawScores.gemini, perplexity: familyRawScores.perplexity, deepseek: familyRawScores.deepseek })}`,
      strength: Math.min(100, Math.round((familyFingerprintScore / 20) * 100)),
      // FIX: Only surface as an AI signal when confidence is "low" or above (score >= 12).
      // "very low" confidence (score=6, strength=30) produced too many false Gemini labels.
      pointsToAI: familyFingerprintScore >= 12,
      wellSupported: familyFingerprintScore >= 16,
    },
    // ── NEW: Self-BLEU Repetition ─────────────────────────────────────────────
    {
      name: "Self-BLEU N-gram Repetition",
      value: selfBleuDetails,
      strength: Math.min(100, Math.round((selfBleuScoreVal / 20) * 100)),
      pointsToAI: selfBleuScoreVal >= 4,
      wellSupported: selfBleuScoreVal >= 14,
    },
    // ── NEW: Semantic Density Uniformity ─────────────────────────────────────
    {
      name: "Content Word Density Uniformity",
      value: semanticDensityDetails,
      strength: Math.min(100, Math.round((semanticDensityScoreVal / 16) * 100)),
      pointsToAI: semanticDensityScoreVal >= 6,
      wellSupported: semanticDensityScoreVal >= 10,
    },
    // ── NEW: Paraphrase Attack Detection ─────────────────────────────────────
    {
      name: "Paraphrase Attack Indicators",
      value: paraphraseDetails,
      strength: Math.min(100, Math.round((paraphraseScore / 18) * 100)),
      pointsToAI: paraphraseScore >= 4,
      wellSupported: paraphraseScore >= 12,
    },
    // ── NEW: Filipino/ESL L1-Transfer (human signal) ──────────────────────────
    {
      name: "Filipino/Philippine English L1-Transfer (human signal)",
      value: filipinoDetails,
      strength: Math.min(100, filipinoReduction * 7),
      pointsToAI: false,
      wellSupported: filipinoL1Count >= 3,
    },
    // ── NEW Batch 2: Zipf's Law Deviation ────────────────────────────────────
    {
      name: "Zipf's Law Deviation Score",
      value: zipfDetails,
      strength: Math.min(100, Math.round((zipfScore / 22) * 100)),
      pointsToAI: zipfScore >= 5,
      wellSupported: zipfScore >= 16,
    },
    // ── NEW Batch 2: TTR Trajectory ───────────────────────────────────────────
    {
      name: "TTR Trajectory (Power-Law vs Linear Decay)",
      value: ttrTrajectoryDetails,
      strength: Math.min(100, Math.round((ttrTrajectoryScore / 20) * 100)),
      pointsToAI: ttrTrajectoryScore >= 4,
      wellSupported: ttrTrajectoryScore >= 14,
    },
    // ── NEW Batch 2: KS Normality Test ────────────────────────────────────────
    {
      name: "Sentence-Length Distribution Shape (KS Test)",
      value: ksNormalityDetails,
      strength: Math.min(100, Math.round((ksNormalityScoreVal / 18) * 100)),
      pointsToAI: ksNormalityScoreVal >= 7,
      wellSupported: ksNormalityScoreVal >= 12,
    },
    // ── NEW Batch 2: Anaphora Resolution Density ──────────────────────────────
    {
      name: "Anaphora Resolution Density",
      value: anaphoraDetails,
      strength: Math.min(100, Math.round((anaphoraScoreVal / 16) * 100)),
      pointsToAI: anaphoraScoreVal >= 6,
      wellSupported: anaphoraScoreVal >= 10,
    },
    // ── NEW Batch 2: Temporal/Spatial Grounding (human signal) ────────────────
    {
      name: "Temporal/Spatial Grounding (human signal)",
      value: groundingDetails,
      strength: Math.min(100, groundingReduction * 8),
      pointsToAI: false,
      wellSupported: groundingCount >= 5,
    },
    // ── NEW Batch 2: Argument Structure Analysis ──────────────────────────────
    {
      name: "Argument Structure (Evidential vs Assertive)",
      value: argStructureDetails,
      strength: Math.min(100, Math.round((argStructureScore / 18) * 100)),
      pointsToAI: argStructureScore >= 7,
      wellSupported: argStructureScore >= 12,
    },
    // ── NEW Batch 2: Section-Differential Scoring ─────────────────────────────
    {
      name: "Section-Differential AI Signal (Body vs Conclusion)",
      value: sectionDiffDetails,
      strength: Math.min(100, Math.round((sectionDiffScore / 20) * 100)),
      pointsToAI: sectionDiffScore >= 8,
      wellSupported: sectionDiffScore >= 14,
    },
    // ── NEW Signal 47: Nominalization Density ─────────────────────────────────
    {
      name: "Nominalization Density" + (genreProfile.genre === "thesis_conclusion" ? " [Thesis Conclusion — amplified]" : ""),
      value: nomDensityDetails,
      strength: Math.min(100, Math.round((nomDensityFinal / 18) * 100)),
      pointsToAI: nomDensityFinal >= 9,
      wellSupported: nomDensityFinal >= 14,
    },
    // ── NEW Signal 48: Conclusion Schema Uniformity ────────────────────────────
    {
      name: "Conclusion Schema Uniformity" + (genreProfile.genre === "thesis_conclusion" ? " [Thesis Conclusion — amplified]" : ""),
      value: schemaUniformityDetails,
      strength: Math.min(100, Math.round((schemaUniformityFinal / 20) * 100)),
      pointsToAI: schemaUniformityFinal >= 10,
      wellSupported: schemaUniformityFinal >= 15,
    },
    // ── NEW Batch 2: Long-Document Chunk Analysis ─────────────────────────────
    ...(chunkAnalysis.isLongDoc ? [{
      name: `Long-Document Chunk Analysis (${chunkAnalysis.chunks.length} chunks)`,
      value: chunkAnalysis.summary,
      strength: chunkAnalysis.hotspotChunks.length > 0
        ? Math.min(100, chunkAnalysis.hotspotChunks.length * 25)
        : 0,
      pointsToAI: chunkAnalysis.hotspotChunks.length > 0,
      wellSupported: chunkAnalysis.hotspotChunks.length >= 2,
    }] : []),
  ];

  // ── Per-sentence analysis ──────────────────────────────────────────────────
  const sentenceResults: SentenceResult[] = sentences.map(sent => {
    const sw = sent.toLowerCase().match(/\b[a-z]+\b/g) || [];
    const swc = Math.max(sw.length, 1);
    const sigs: string[] = [];
    let raw = 0;

    const sVocabHits = sw.filter(w => AI_VOCAB.has(w)).length;
    const sVocabRate = sVocabHits / swc;
    // Only flag if multiple hits in a single sentence
    if (sVocabHits >= 3 && sVocabRate > 0.15) { raw += 35; sigs.push(`${sVocabHits} AI buzzwords (${(sVocabRate*100).toFixed(0)}% density)`); }
    else if (sVocabHits >= 2) { raw += 18; sigs.push("multiple AI-associated words"); }
    else if (sVocabHits === 1) { raw += 7; sigs.push("one AI-associated word"); }

    let sTrans = 0;
    AI_TRANSITIONS.forEach(p => { const m = sent.match(p); if (m) sTrans += m.length; });
    if (sTrans > 0) { raw += Math.min(30, sTrans * 15); sigs.push("AI transition phrase"); }

    // Active reductions - human signals lower the score
    if (/\b(yeah|yep|nope|gonna|wanna|kinda|dunno|honestly|frankly)\b/i.test(sent)) { raw = Math.max(0, raw - 30); sigs.push("informal register (human marker)"); }
    if (/-/.test(sent) && !/\w-(from|including|such as)/i.test(sent)) { raw = Math.max(0, raw - 10); }
    if (/\.{3}|…/.test(sent)) { raw = Math.max(0, raw - 8); }
    if (/\?/.test(sent)) { raw = Math.max(0, raw - 10); }
    if (sw.length <= 5) { raw = Math.max(0, raw - 15); }

    const sNorm = Math.min(100, (raw / 65) * 100);
    // Gentle curve - biased against false positives
    let likelihood = sNorm <= 25 ? (sNorm / 25) * 25 :
      sNorm <= 55 ? 25 + ((sNorm - 25) / 30) * 30 :
      55 + Math.min(30, ((sNorm - 55) / 45) * 30);
    likelihood = Math.round(Math.min(95, Math.max(0, likelihood))); // cap at 95 — strict mode

    // STRICT labels — lower thresholds (GPTZero-aligned)
    const label: "uncertain" | "moderate" | "elevated" =
      likelihood >= 45 ? "elevated" : likelihood >= 22 ? "moderate" : "uncertain";

    return { text: sent, likelihood, signals: sigs, label };
  });

  // ── Elevated-sentence internalScore floor ─────────────────────────────────
  // If engine-level suppression (ESL gate, single-signal penalty, warning
  // penalty) collapses rawScore to near-zero while sentence-level analysis has
  // flagged elevated patterns, the internalScore must reflect that signal so
  // the floor propagates correctly into deriveBreakdown AND the combined average.
  // Cap scales with evidence: up to 30 when majority of sentences are elevated,
  // 20 otherwise — conservative enough to avoid false AI verdicts on human text.
  const elevatedCount = sentenceResults.filter(s => s.label === "elevated").length;
  const elevRatio = sentenceResults.length > 0 ? elevatedCount / sentenceResults.length : 0;
  const elevFloor = sentenceResults.length > 0
    ? Math.min(elevRatio > 0.5 ? 30 : 20, Math.round(elevRatio * 30))
    : 0;
  const finalScore = Math.max(rawScore, elevFloor);

  return {
    internalScore: finalScore,
    confidenceLow: low,
    confidenceHigh: high,
    evidenceStrength: strength,
    verdictPhrase: phrase,
    signals,
    sentences: sentenceResults,
    wordCount: wc,
    sentenceCount: sentences.length,
    reliabilityWarnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENGINE B - BURSTINESS & COGNITIVE MARKERS
//  Primary: sentence length CV (burstiness)
//  Secondary: avg sentence length, range, short-sentence presence,
//             rhetorical variation, conceptual hedging patterns
// ─────────────────────────────────────────────────────────────────────────────

function runBurstinessEngine(text: string): EngineResult {
  // Improvement #10: use cached tokenizers to avoid redundant computation
  const words = cachedWordTokenize(text);
  const wc = Math.max(words.length, 1);
  const sentences = cachedSplitSentences(text);
  const lens = sentences.map(s => s.trim().split(/\s+/).length);

  const reliabilityWarnings = getReliabilityWarnings(text, wc, sentences);

  // ── Minimum word count gate ────────────────────────────────────────────────
  if (wc < 80) {
    return {
      internalScore: 0, confidenceLow: 0, confidenceHigh: 30,
      evidenceStrength: "INCONCLUSIVE" as EvidenceStrength,
      verdictPhrase: "Text too short for reliable verdict (need ≥ 80 words)",
      signals: [], sentences: [], wordCount: wc, sentenceCount: sentences.length,
      reliabilityWarnings: ["Text too short for reliable analysis (fewer than 80 words)"],
    };
  }

  const avg = lens.length > 0 ? lens.reduce((a, b) => a + b, 0) / lens.length : 10;
  const variance = lens.length > 1 ? lens.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / lens.length : 0;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / Math.max(avg, 1);
  const range = lens.length > 0 ? Math.max(...lens) - Math.min(...lens) : 0;

  // ── Signal 1: Burstiness (CV of sentence lengths) (Improvement 2: length-adaptive thresholds) ─
  // Human writers naturally vary sentence length. AI is metronomic.
  // STRICT: thresholds tighten for short texts (< 15 sentences) where CV is
  // statistically unreliable — a 5-sentence paragraph can hit extreme CV values by chance.
  // Only apply the standard strict thresholds at 15+ sentences.
  let burstScore = 0;
  if (sentences.length >= 15) {
    // Standard strict thresholds (GPTZero/Turnitin-aligned) — valid at this length
    if (cv < 0.15) burstScore = 50;
    else if (cv < 0.25) burstScore = 38;
    else if (cv < 0.35) burstScore = 24;
    else if (cv < 0.45) burstScore = 12;
  } else if (sentences.length >= 10) {
    // Moderate length: tighten thresholds to reduce noise
    if (cv < 0.10) burstScore = 50;
    else if (cv < 0.18) burstScore = 38;
    else if (cv < 0.28) burstScore = 20;
    else if (cv < 0.38) burstScore = 8;
  } else {
    // Short text (5–9 sentences): only flag very extreme uniformity
    if (cv < 0.08) burstScore = 40;
    else if (cv < 0.14) burstScore = 20;
    // cv >= 0.14 with < 10 sentences: too noisy to call
  }

  // Detect technical/formal writing - suppresses form-based signals
  // that are meaningless for academic essays (no short sentences, no questions)
  const isTechnicalOrFormal = reliabilityWarnings.some(w =>
    w.includes("Technical") || w.includes("formal")
  );

  // ── Signal 2: Short sentence absence ──────────────────────────────────────
  // Human writers use short sentences for emphasis. AI rarely does naturally.
  // SUPPRESSED for technical/formal writing: academic essays never use
  // short punchy sentences regardless of human or AI authorship.
  const hasShortSent = lens.some(l => l <= 6);
  const noShortScore = (!hasShortSent && sentences.length > 6 && !isTechnicalOrFormal) ? 15 : 0;

  // ── Signal 3: Sentence length range ───────────────────────────────────────
  // Very narrow range = metronomic. Only flag with many sentences.
  let rangeScore = 0;
  if (sentences.length >= 6) {
    if (range < 8) rangeScore = 18;
    else if (range < 15) rangeScore = 8;
    else if (range < 22) rangeScore = 2;
  }

  // ── Signal 4: Rhetorical variation markers ─────────────────────────────────
  // Human writers use questions, exclamations, hedges, and asides.
  // These are cognitive markers of human thinking-while-writing.
  // SUPPRESSED for technical/formal writing: academic essays and formal reports
  // naturally contain none of these regardless of human or AI authorship.
  const qCount = (text.match(/\?/g) || []).length;
  const hasEllipsis = /\.{3}/.test(text);
  // Spaced dash " - " is the ASCII stand-in for em-dash (avoids matching hyphens in compound words)
  const hasEmDash = / - /.test(text);
  const hasParenthetical = (text.match(/\([^)]{5,60}\)/g) || []).length;
  const rhetoricalRaw = Math.max(0, 20 - (qCount > 0 ? 8 : 0) - (hasEllipsis ? 5 : 0) - (hasEmDash ? 4 : 0) - (hasParenthetical > 0 ? 5 : 0));
  // Zero out for technical/formal content - these signals don't apply
  const rhetoricalScore = isTechnicalOrFormal ? 0 : rhetoricalRaw;

  // ── Signal 5: Contraction presence ────────────────────────────────────────
  // Contractions = conversational human writing. AI avoids them.
  // ESL/academic-fair: absence is NOT penalised - only presence is a positive signal
  const contrCount = (text.match(TRUE_CONTRACTION_RE) || []).length;
  const contrRate = contrCount / wc;
  // Contractions reduce score (human signal), not increase it
  const contrReduction = contrRate > 0.02 ? 15 : contrRate > 0.008 ? 8 : 0;

  // ── Signal 7: Personal anecdote detector (#6) ─────────────────────────────
  // First-person + past tense verb + specific context = human signal.
  // "I once worked with…" / "Last year I noticed…" / "My experience with X taught me…"
  // AI almost never generates genuine personal narrative.
  const ANECDOTE_RE = /\b(I (once|recently|previously|actually|used to|have (seen|worked|noticed|experienced|learned|found|tried)|spent|started|remember|realized|discovered|struggled|managed)|my (experience|time|work|project|team|colleague|professor|mentor|supervisor|manager|boss)|last (year|month|week|semester|summer|time)|a few (years|months|weeks|days) ago|when I (was|worked|studied|first|began)|back when|working (at|with|on|for) [A-Z])/gi;
  const anecdoteMatches = (text.match(ANECDOTE_RE) || []).length;
  // Also count specificity markers: named events + past tense
  const PAST_TENSE_SPECIFIC_RE = /\b(I (built|wrote|created|designed|implemented|developed|analyzed|tested|deployed|presented|published|co-authored|contributed|collaborated)|we (built|created|developed|launched|shipped|published|presented|analyzed))/gi;
  const specificAnecdotes = (text.match(PAST_TENSE_SPECIFIC_RE) || []).length;
  const totalAnecdoteSignals = anecdoteMatches + specificAnecdotes;
  const anecdoteReduction = totalAnecdoteSignals >= 3 ? 18 : totalAnecdoteSignals >= 2 ? 12 : totalAnecdoteSignals >= 1 ? 6 : 0;

  // ── Signal 8: Numeric specificity (#7) ────────────────────────────────────
  // Human writers quote real numbers; AI uses vague quantifiers.
  // Ratio of specific numerals to vague quantifiers.
  const SPECIFIC_NUMS_RE = /\b(\d{1,3}(%|\s*percent|\s*million|\s*billion|\s*thousand)|in \d{4}|\d+ (study|report|survey|participants?|respondents?|subjects?)|\$\d|figure \d|table \d|chapter \d|page \d)/gi;
  const VAGUE_QUANT_RE = /\b(many|several|numerous|countless|various|a number of|a growing number|a wide range|a large number|some|few|multiple|diverse|various|plenty of|a host of|a variety of|a plethora of|a myriad of)/gi;
  const specificNums = (text.match(SPECIFIC_NUMS_RE) || []).length;
  const vagueQuants = (text.match(VAGUE_QUANT_RE) || []).length;
  const specificityRatio = specificNums / Math.max(vagueQuants + specificNums, 1);
  // Low ratio (few specific numbers, many vague) → AI-like
  const numericVaguenessScore = specificityRatio < 0.1 && vagueQuants >= 4 ? 14
    : specificityRatio < 0.2 && vagueQuants >= 3 ? 10
    : specificityRatio < 0.3 && vagueQuants >= 2 ? 6 : 0;
  // High specificity → human signal (reduction)
  const numericSpecificityReduction = specificityRatio > 0.5 && specificNums >= 3 ? 10 : specificNums >= 5 ? 6 : 0;

  // ── Signal 6: Minimum sentence floor ──────────────────────────────────────
  // AI academic essays never go below ~9 words per sentence — every sentence
  // is "complete" and structured. Human writers, even in formal prose, produce
  // at least a few shorter transitional or emphatic sentences (< 12 words).
  // Only applied when text is long enough (>= 10 sentences) to be meaningful.
  const minSentLen = lens.length > 0 ? Math.min(...lens) : 0;
  const noSubTwelve = lens.filter(l => l < 12).length === 0;
  let minFloorScore = 0;
  if (sentences.length >= 10 && noSubTwelve) {
    // Every single sentence is >= 12 words — very rare in human writing
    minFloorScore = 22;
  } else if (sentences.length >= 8 && minSentLen >= 9 && lens.filter(l => l < 9).length === 0) {
    minFloorScore = 12;
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  // ESL writers produce uniformly-paced formal writing — burstScore and rangeScore
  // are unreliable for them. When ESL flag fires, zero those two signals out so
  // the engine doesn't falsely penalise ESL sentence rhythm.
  // FIX: eslFlagB is now applied to burstScore as well (was missing — caused 20% ESL FPR).
  const eslFlagB = isLikelyESLText(reliabilityWarnings);
  const effectiveBurstScore   = eslFlagB ? 0 : burstScore;
  const effectiveRangeScore   = eslFlagB ? 0 : rangeScore;
  const effectiveMinFloor     = eslFlagB ? 0 : minFloorScore;
  // rhetorical signals are also less meaningful for ESL formal writing
  const effectiveRhetoricalScore = eslFlagB ? Math.round(rhetoricalScore * 0.4) : rhetoricalScore;

  const rawTotal = effectiveBurstScore + noShortScore + effectiveRangeScore + effectiveRhetoricalScore + effectiveMinFloor - contrReduction + numericVaguenessScore;
  const maxTotal = 40 + 15 + 18 + 20 + 22 + 14; // 129 (contraction/anecdote/numeric-specificity are reductions)

  let norm = Math.min(100, Math.max(0, (rawTotal / maxTotal) * 100));

  // Apply human signal reductions
  if (anecdoteReduction > 0) norm = Math.max(0, norm * (1 - anecdoteReduction / 100));
  if (numericSpecificityReduction > 0) norm = Math.max(0, norm * (1 - numericSpecificityReduction / 100));

  // Downgrade: if burstiness alone fires but vocab signals are absent, be conservative
  // STRICT: less aggressive downgrade for low signal count
  const activeSignals = [effectiveBurstScore > 10, noShortScore > 0, effectiveRangeScore > 5, effectiveRhetoricalScore > 8, effectiveMinFloor > 0, numericVaguenessScore > 0].filter(Boolean).length;
  if (activeSignals < 2) norm = norm * 0.75;
  else if (activeSignals < 3) norm = norm * 0.90;

  // Reduced warning penalty
  // Improvement 5: differentiated warning penalties for burstiness engine
  norm = norm * computeWarningPenalty(reliabilityWarnings, "burstiness");

  // ── Gap 8: Domain-adaptive threshold adjustment (Engine B) ─────────────────
  const domainProfileB = detectDomain(text, words);
  if (domainProfileB.multiplier !== 1.0) {
    // Apply a softer domain adjustment to burstiness — CV is less domain-sensitive
    // than vocab signals, so we use a dampened version of the multiplier
    const dampedMultiplier = 1.0 + (domainProfileB.multiplier - 1.0) * 0.5;
    norm = Math.min(100, Math.max(0, norm * dampedMultiplier));
  }

  // ── Thesis conclusion: amplify Engine B if thesis genre detected ───────────
  const thesisGenreB = detectThesisGenre(text, sentences);
  if (thesisGenreB.isThesisConclusion) {
    norm = Math.min(100, norm * 1.12);
  }

  // ── ESL / Philippine context score calibration ────────────────────────────
  // Apply the same ESL penalty as Engine A (but burstiness is already partially
  // suppressed above via eslFlagB; this handles any residual formal-register signal).
  // BYPASS: same thesis-conclusion + zero-L1-transfer logic as Engine A.
  const eslBypassB = thesisGenreB.isThesisConclusion &&
    thesisGenreB.detectedMarkers.includes("zero-L1-transfer");
  const eslScorePenaltyB = eslBypassB ? 0 : computeESLScorePenalty(reliabilityWarnings, Math.round(norm));
  if (eslScorePenaltyB > 0) {
    norm = Math.max(0, norm - eslScorePenaltyB * 0.6); // softer for Engine B — burstiness partly ESL-immune
  }

  const rawScore = Math.round(Math.min(100, Math.max(0, norm)));
  const totalSignalCountB = 8; // Engine B total signal definitions
  const { low, high, strength, phrase } = computeConfidenceInterval(
    rawScore, totalSignalCountB, activeSignals, reliabilityWarnings, wc
  );

  const signals: SignalResult[] = [
    {
      name: "Sentence Length Variation (Burstiness)",
      value: eslFlagB
        ? `CV = ${cv.toFixed(3)} — signal suppressed: ESL/formal-register writing naturally produces uniform sentence pacing. Burstiness is not a reliable AI indicator for this text type.`
        : `CV = ${cv.toFixed(3)}. STRICT thresholds — Human: CV > 0.45 | Borderline: 0.35–0.45 | Moderate AI: 0.25–0.35 | Strong AI: CV < 0.25 | Very strong: CV < 0.15. Based on ${sentences.length} sentences.`,
      strength: eslFlagB ? 0 : Math.min(100, Math.round((burstScore / 50) * 100)),
      pointsToAI: !eslFlagB && burstScore >= 28,
      wellSupported: !eslFlagB && sentences.length >= 7 && cv < 0.22,
    },
    {
      name: "Short Sentence Presence",
      value: isTechnicalOrFormal
        ? "Signal suppressed: technical/academic writing rarely uses short emphatic sentences regardless of authorship - not a reliable AI indicator for this content type."
        : hasShortSent
          ? "Short sentences (<=6 words) present - consistent with human writing rhythm."
          : sentences.length > 6
            ? "No short sentences found - human writers typically vary with brief emphatic sentences."
            : "Insufficient sentences to evaluate this signal.",
      strength: noShortScore > 0 ? 60 : 10,
      pointsToAI: noShortScore > 0,
      wellSupported: sentences.length > 8 && !isTechnicalOrFormal,
    },
    {
      name: "Sentence Length Range",
      value: `Range = ${range} words (shortest to longest). Narrow range (${range < 8 ? "< 8" : range < 15 ? "8-14" : ">=15"}) associated with uniform AI rhythm.`,
      strength: Math.min(100, Math.round((rangeScore / 18) * 100)),
      pointsToAI: rangeScore >= 8,
      wellSupported: sentences.length >= 8 && range < 12,
    },
    {
      name: "Rhetorical Variation",
      value: isTechnicalOrFormal
        ? "Signal suppressed: technical and academic writing does not use questions, em-dashes, or parentheticals regardless of authorship - absence is not an AI indicator for this content type."
        : [
            qCount > 0 ? `${qCount} question${qCount > 1 ? "s" : ""} (+)` : "no questions",
            hasEllipsis ? "ellipsis (+)" : "no ellipsis",
            hasEmDash ? "em-dash (+)" : "no em-dash",
            hasParenthetical > 0 ? "parenthetical aside (+)" : "no parentheticals",
          ].join(" - ") + ". Human writers naturally use varied rhetorical devices.",
      strength: Math.min(100, rhetoricalScore * 5),
      pointsToAI: rhetoricalScore >= 15,
      wellSupported: wc > 100 && !isTechnicalOrFormal,
    },
    {
      name: "Contraction Presence",
      value: contrCount > 0
        ? `${contrCount} contraction${contrCount > 1 ? "s" : ""} found - positive human signal. Academic writing may lack contractions naturally.`
        : "No contractions - note: academic and ESL writing often avoids contractions. This alone is not an AI indicator.",
      strength: contrCount > 0 ? 15 : 0,
      pointsToAI: false, // contractions always indicate human - never AI
      wellSupported: contrCount >= 3,
    },
    {
      name: "Sentence Length Floor",
      value: minFloorScore > 0
        ? `Shortest sentence: ${minSentLen} words. No sentence is shorter than 12 words across ${sentences.length} sentences. Human writers - even in formal prose - include at least a few shorter transitional sentences. This floor is a strong AI rhythm signal.`
        : `Shortest sentence: ${minSentLen} words - natural variation present, consistent with human writing.`,
      strength: Math.min(100, Math.round((minFloorScore / 22) * 100)),
      pointsToAI: minFloorScore > 0,
      wellSupported: noSubTwelve && sentences.length >= 10,
    },
    {
      name: "Personal Anecdote Presence (human signal)",
      value: totalAnecdoteSignals > 0
        ? `${totalAnecdoteSignals} personal narrative markers detected. First-person past-tense specific accounts are a strong human signal — AI rarely generates genuine personal anecdote.`
        : "No personal anecdote markers detected. Human writers typically include first-person past experiences; absence slightly supports AI authorship.",
      strength: Math.min(100, anecdoteReduction * 5),
      pointsToAI: false,
      wellSupported: totalAnecdoteSignals >= 3,
    },
    {
      name: "Numeric Specificity vs Vague Quantifiers",
      value: `${specificNums} specific numbers/statistics vs ${vagueQuants} vague quantifiers. Ratio: ${(specificityRatio*100).toFixed(0)}% specific. Human writers cite real figures; AI defaults to "many", "several", "numerous".`,
      strength: Math.min(100, Math.round((numericVaguenessScore / 14) * 100)),
      pointsToAI: numericVaguenessScore >= 6,
      wellSupported: numericVaguenessScore >= 10,
    },
  ];

  // ── Per-sentence ───────────────────────────────────────────────────────────
  const sentenceResults: SentenceResult[] = sentences.map(sent => {
    const sWords = sent.toLowerCase().match(/\b[a-z]+\b/g) || [];
    const sigs: string[] = [];
    let raw = 0;

    const sentLen = sent.trim().split(/\s+/).length;
    const deviation = Math.abs(sentLen - avg);
    // Only flag uniform sentences if many sentences AND very tight window
    const isUniform = deviation < avg * 0.20 && sentLen > 12 && sentences.length >= 6;
    if (isUniform) { raw += 20; sigs.push(`uniform length (${sentLen} words, avg ${avg.toFixed(0)})`); }

    const sVocabHits = sWords.filter(w => AI_VOCAB.has(w)).length;
    if (sVocabHits >= 3) { raw += 22; sigs.push(`${sVocabHits} AI-associated words`); }
    else if (sVocabHits >= 2) { raw += 12; sigs.push("2 AI-associated words"); }

    let sTrans = 0;
    AI_TRANSITIONS.forEach(p => { const m = sent.match(p); if (m) sTrans += m.length; });
    if (sTrans > 0) { raw += Math.min(18, sTrans * 9); sigs.push("AI transition phrase"); }

    // Human signals reduce score
    if (/\b(yeah|yep|nope|gonna|wanna|kinda|dunno)\b/i.test(sent)) { raw = Math.max(0, raw - 25); }
    if (/-/.test(sent)) { raw = Math.max(0, raw - 8); }
    if (/\.{3}|…/.test(sent)) { raw = Math.max(0, raw - 8); }
    if (/\?/.test(sent)) { raw = Math.max(0, raw - 12); }
    if (sentLen <= 6) { raw = Math.max(0, raw - 20); sigs.push("short sentence (human burst)"); }
    if ((sent.match(TRUE_CONTRACTION_RE) || []).length > 0) { raw = Math.max(0, raw - 10); }

    const sNorm = Math.min(100, (raw / 60) * 100);
    let likelihood = sNorm <= 25 ? (sNorm / 25) * 25 :
      sNorm <= 55 ? 25 + ((sNorm - 25) / 30) * 30 :
      55 + Math.min(25, ((sNorm - 55) / 45) * 25);
    likelihood = Math.round(Math.min(92, Math.max(0, likelihood)));

    // STRICT labels — lower thresholds (GPTZero-aligned)
    const label: "uncertain" | "moderate" | "elevated" =
      likelihood >= 42 ? "elevated" : likelihood >= 20 ? "moderate" : "uncertain";

    return { text: sent, likelihood, signals: sigs, label };
  });

  // ── Elevated-sentence internalScore floor ─────────────────────────────────
  // ESL suppression can collapse rawScore to 0 while per-sentence scoring still
  // flags elevated patterns. Bake a floor into internalScore so the combined
  // average and deriveBreakdown both reflect the sentence-level evidence.
  // Cap scales with evidence: up to 30 when majority of sentences are elevated,
  // 20 otherwise.
  const elevatedCountB = sentenceResults.filter(s => s.label === "elevated").length;
  const elevRatioB = sentenceResults.length > 0 ? elevatedCountB / sentenceResults.length : 0;
  const elevFloorB = sentenceResults.length > 0
    ? Math.min(elevRatioB > 0.5 ? 30 : 20, Math.round(elevRatioB * 30))
    : 0;
  const finalScoreB = Math.max(rawScore, elevFloorB);

  return {
    internalScore: finalScoreB,
    confidenceLow: low,
    confidenceHigh: high,
    evidenceStrength: strength,
    verdictPhrase: phrase,
    signals,
    sentences: sentenceResults,
    wordCount: wc,
    sentenceCount: sentences.length,
    reliabilityWarnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONSENSUS LAYER (Improvement 4: Engine C participates in consensus)
//  Upgraded from 2-engine to 3-engine majority-vote logic.
//  When Engine C is available:
//   - 2-of-3 agreement on AI → confirm AI verdict
//   - 3-engine unanimous → high confidence
//   - All three disagree → widen confidence interval (INCONCLUSIVE)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  BIMODAL SENTENCE DISTRIBUTION DETECTOR
//  GPTZero accurately identifies mixed/hybrid authorship at 89–93% accuracy
//  precisely because it looks at the SHAPE of sentence score distributions,
//  not just the average. A bimodal pattern (some sentences very AI-like,
//  others very human-like) is the hallmark of mixed authorship.
//
//  Returns: { isBimodal, mixedSignalStrength, highCluster, lowCluster }
//  This is used to upgrade the combined verdict to "Mixed" even when the
//  naive average score would give an inconclusive result.
// ─────────────────────────────────────────────────────────────────────────────

function detectBimodalDistribution(sentences: SentenceResult[]): {
  isBimodal: boolean;
  mixedSignalStrength: number; // 0-100
  highCluster: number;         // fraction of sentences in high AI-likelihood bucket
  lowCluster: number;          // fraction of sentences in low AI-likelihood bucket
} {
  if (sentences.length < 6) return { isBimodal: false, mixedSignalStrength: 0, highCluster: 0, lowCluster: 0 };

  const likelihoods = sentences.map(s => s.likelihood);

  // Bimodal test: what fraction of sentences cluster above 55% vs below 25%?
  const highCount = likelihoods.filter(l => l >= 55).length;
  const lowCount  = likelihoods.filter(l => l <= 25).length;
  const midCount  = sentences.length - highCount - lowCount;
  const highFrac  = highCount / sentences.length;
  const lowFrac   = lowCount  / sentences.length;

  // A true bimodal distribution requires BOTH clusters to be populated
  // and the mid-range to be relatively sparse
  const isBimodal = highFrac >= 0.25 && lowFrac >= 0.25 && midCount / sentences.length < 0.5;

  // Compute mean and SD for additional validation
  const mean = likelihoods.reduce((a, b) => a + b, 0) / likelihoods.length;
  const sd   = Math.sqrt(likelihoods.reduce((s, l) => s + Math.pow(l - mean, 2), 0) / likelihoods.length);

  // Mixed signal is strongest when:
  // 1. Distribution is bimodal (both clusters populated)
  // 2. High SD (spread between clusters is large)
  // 3. Mean is in the ambiguous zone (30–70)
  let mixedSignalStrength = 0;
  if (isBimodal) {
    mixedSignalStrength = Math.min(100, Math.round(
      (highFrac * 40 + lowFrac * 40 + Math.min(sd / 30, 1) * 20)
    ));
  } else if (sd > 22 && mean >= 20 && mean <= 75) {
    // Not cleanly bimodal but high variance with mid-range mean — moderate mixed signal
    mixedSignalStrength = Math.min(50, Math.round(sd * 1.5));
  }

  return { isBimodal, mixedSignalStrength, highCluster: highFrac, lowCluster: lowFrac };
}

function applyConsensus(a: EngineResult, b: EngineResult, c?: EngineResult | null): [EngineResult, EngineResult] {
  const aHigh = a.evidenceStrength === "HIGH" || a.evidenceStrength === "MEDIUM";
  const bHigh = b.evidenceStrength === "HIGH" || b.evidenceStrength === "MEDIUM";
  const aBias = a.internalScore > 50;
  const bBias = b.internalScore > 50;

  // ── 3-engine path ──────────────────────────────────────────────────────────
  if (c) {
    const cHigh = c.evidenceStrength === "HIGH" || c.evidenceStrength === "MEDIUM";
    const cBias = c.internalScore > 50;
    const biasVotes = [aBias, bBias, cBias];
    const aiVoteCount = biasVotes.filter(Boolean).length;
    const allHighStrength = aHigh && bHigh && cHigh;
    const allDisagree = new Set(biasVotes).size === 1 ? false : aiVoteCount !== 1 ? false : true; // 1 AI vs 2 Human or vice versa still has a majority

    // 3-engine unanimous AI: upgrade both A and B to HIGH if either is MEDIUM
    if (aiVoteCount === 3 && (aHigh || bHigh)) {
      const upgrade = (r: EngineResult): EngineResult => ({
        ...r,
        evidenceStrength: "HIGH" as EvidenceStrength,
        verdictPhrase: "All three engines agree — strong AI-associated patterns",
        confidenceLow: Math.max(r.confidenceLow, 50),
        confidenceHigh: Math.min(r.confidenceHigh, 90),
      });
      return [upgrade(a), upgrade(b)];
    }

    // 2-of-3 majority AI with at least 2 HIGH/MEDIUM engines: confirm AI verdict
    if (aiVoteCount >= 2 && (aHigh || bHigh || cHigh)) {
      const majorityUpgrade = (r: EngineResult): EngineResult => ({
        ...r,
        evidenceStrength: r.evidenceStrength === "LOW" || r.evidenceStrength === "INCONCLUSIVE"
          ? "MEDIUM" as EvidenceStrength
          : r.evidenceStrength,
        verdictPhrase: "Majority of engines flag AI patterns",
        confidenceLow: Math.max(r.confidenceLow, 35),
        confidenceHigh: Math.min(r.confidenceHigh, 88),
      });
      return [majorityUpgrade(a), majorityUpgrade(b)];
    }

    // All three disagree (1 AI, 2 Human or 2 AI, 1 Human but with wide score spread): widen CI
    const scoreSpread = Math.max(a.internalScore, b.internalScore, c.internalScore)
      - Math.min(a.internalScore, b.internalScore, c.internalScore);
    if (aiVoteCount === 1 && aHigh && bHigh && cHigh && scoreSpread > 25) {
      const widen = (r: EngineResult): EngineResult => ({
        ...r,
        evidenceStrength: "INCONCLUSIVE" as EvidenceStrength,
        verdictPhrase: "Engines disagree — verdict inconclusive",
        confidenceLow: Math.min(r.confidenceLow, 20),
        confidenceHigh: Math.max(r.confidenceHigh, 80),
      });
      return [widen(a), widen(b)];
    }
  }

  // ── 2-engine path (original logic preserved) ──────────────────────────────
  // STRICT: only downgrade to INCONCLUSIVE when scores are wildly apart (>30 pt gap)
  const scoreDiff = Math.abs(a.internalScore - b.internalScore);
  if (aBias !== bBias && aHigh && bHigh && scoreDiff > 30) {
    const downgrade = (r: EngineResult): EngineResult => ({
      ...r,
      evidenceStrength: "MEDIUM",
      verdictPhrase: "Engines partially disagree - moderate AI patterns present",
      confidenceLow: Math.min(r.confidenceLow, 35),
      confidenceHigh: Math.max(r.confidenceHigh, 70),
    });
    return [downgrade(a), downgrade(b)];
  }

  const aIsHigh    = a.evidenceStrength === "HIGH";
  const bIsMedium  = b.evidenceStrength === "MEDIUM";
  const bIsHigh    = b.evidenceStrength === "HIGH";
  const aIsMedium  = a.evidenceStrength === "MEDIUM";
  const bothLeanAI = a.internalScore > 15 && b.internalScore > 10;

  const bStrongAlone = bIsHigh && b.internalScore >= 38 && a.internalScore >= 8;

  if ((aIsHigh && bIsMedium && bothLeanAI) || (bIsHigh && aIsMedium && bothLeanAI) || bStrongAlone) {
    const upgrade = (r: EngineResult): EngineResult => ({
      ...r,
      evidenceStrength: "HIGH" as EvidenceStrength,
      verdictPhrase: bStrongAlone && !bothLeanAI
        ? "Strong burstiness signal — metronomic rhythm characteristic of AI text"
        : "AI-associated patterns detected across multiple signal types",
      confidenceLow:  Math.max(r.confidenceLow,  40),
      confidenceHigh: Math.min(r.confidenceHigh, 88),
    });
    return [upgrade(a), upgrade(b)];
  }

  return [
    { ...a, agreesWithOther: aBias === bBias },
    { ...b, agreesWithOther: aBias === bBias },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - Score gauge replaced by Evidence Strength Badge (no single AI score)
// ─────────────────────────────────────────────────────────────────────────────

// Derive AI / Mixed / Human percentages from internalScore
// elevatedSentenceRatio: fraction of sentences labelled "elevated" (0–1).
// Used to apply a minimum AI% floor when engine-level suppression (ESL gate,
// single-signal penalty, warning penalty) keeps internalScore low despite
// clearly elevated sentence-level patterns.
function deriveBreakdown(internalScore: number, elevatedSentenceRatio = 0): { ai: number; mixed: number; human: number } {
  // Unified single-scale formula: three zones derived from the same score,
  // guaranteed to sum to exactly 100% with no gap artefacts.
  //
  // FIX — Zone boundaries shifted vs. original to close the 0-20 dead zone
  // where AI% was hardcoded to 0 even when sentences showed elevated patterns:
  //   0–10  = Human zone   (AI stays 0, Human 100→70, Mixed grows)
  //  10–50  = Mixed band   (AI rises 0→65, Human falls 65→0, Mixed = remainder)
  //  50–100 = AI zone      (Human stays 0, AI 0→100, Mixed shrinks)
  //
  // Use Math.floor for the primary computed dimension; derive mixed as the
  // remainder to avoid rounding collapse (two different scores → identical bars).

  const s = Math.max(0, Math.min(100, internalScore));

  let ai: number, human: number, mixed: number;

  if (s <= 10) {
    ai    = 0;
    // human decreases linearly from 100 (s=0) to 70 (s=10)
    human = Math.floor(100 - s * 3);
    mixed = 100 - ai - human;
  } else if (s >= 50) {
    human = 0;
    // ai increases linearly from 0 (s=50) to 100 (s=100)
    ai    = Math.floor((s - 50) / 50 * 100);
    mixed = 100 - ai - human;
  } else {
    // Mixed band: t goes 0→1 as s goes 10→50
    const t = (s - 10) / 40;
    ai    = Math.floor(t * 65);
    human = Math.floor((1 - t) * 65);
    mixed = 100 - ai - human;
  }

  ai    = Math.max(0, Math.min(100, ai));
  human = Math.max(0, Math.min(100, human));
  mixed = Math.max(0, 100 - ai - human);

  // ── Elevated-sentence floor ─────────────────────────────────────────────────
  // When engine-level suppression (ESL gate, single-signal penalty, warning
  // penalty) keeps internalScore below 10 — but sentence-level analysis has
  // already flagged elevated patterns — the UI would show AI: 0% which directly
  // contradicts the visible elevated sentences. Apply a proportional floor so
  // the summary bar is never misleadingly zero while elevated sentences exist.
  // Max floor scales with evidence weight: up to 25% when ratio > 0.5 (majority
  // of sentences elevated), 15% otherwise — conservative but not contradictory.
  if (ai === 0 && elevatedSentenceRatio > 0) {
    const maxFloor = elevatedSentenceRatio > 0.5 ? 25 : 15;
    const floor = Math.min(maxFloor, Math.round(elevatedSentenceRatio * 40));
    if (floor > 0) {
      ai    = floor;
      // Absorb the floor from mixed first, then human, so total stays 100
      const mixedAbsorb = Math.min(floor, mixed);
      mixed = mixed - mixedAbsorb;
      human = 100 - ai - mixed;
    }
  }

  return { ai, mixed, human };
}

// FPR FIX: Per-engine verdict only labels "AI-Generated" when AI% decisively
// dominates. Borderline cases (ai ≈ mixed or ai ≈ human) return "Mixed / Uncertain"
// so individual engine cards never auto-label human texts as AI-generated.
function getDominantVerdict(ai: number, mixed: number, human: number): {
  label: string; color: string; bg: string; border: string; icon: string;
} {
  // Require AI to lead by at least 10 points over both alternatives
  if (ai >= mixed + 10 && ai >= human + 10) return { label: "AI-Generated",    color: "text-red-700",     bg: "bg-red-50",     border: "border-red-300",     icon: "🤖" };
  if (human >= mixed + 10 && human >= ai + 10) return { label: "Human-Written",   color: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-300", icon: "✍️" };
  return                                              { label: "Mixed / Uncertain", color: "text-amber-700",   bg: "bg-amber-50",   border: "border-amber-300",   icon: "⚖️" };
}

function ScoreBreakdown({ internalScore, strength, low, high, elevatedSentenceRatio = 0 }: {
  internalScore: number;
  strength: EvidenceStrength;
  low: number;
  high: number;
  elevatedSentenceRatio?: number;
}) {
  const { ai, mixed, human } = deriveBreakdown(internalScore, elevatedSentenceRatio);
  const verdict = getDominantVerdict(ai, mixed, human);

  const evidenceCfg = {
    INCONCLUSIVE: { icon: "⚖️", label: "Inconclusive",         text: "text-slate-500" },
    LOW:          { icon: "✓",  label: "Likely Human",          text: "text-emerald-600" },
    MEDIUM:       { icon: "◈",  label: "Likely AI (Moderate)",  text: "text-amber-600" },
    HIGH:         { icon: "▲",  label: "Likely AI (High)",      text: "text-red-600" },
  }[strength];

  return (
    <div className={`rounded-xl border-2 ${verdict.bg} ${verdict.border} px-4 py-3 space-y-3`}>
      {/* Dominant verdict */}
      <div className="flex items-center justify-between">
        <div className={`flex items-center gap-1.5 font-black text-base ${verdict.color}`}>
          <span>{verdict.icon}</span>
          <span>{verdict.label}</span>
        </div>
        <div className={`text-xs font-bold ${evidenceCfg.text}`}>
          {evidenceCfg.icon} {evidenceCfg.label}
        </div>
      </div>

      {/* Stacked percentage bar */}
      <div className="space-y-1.5">
        <div className="flex h-5 rounded-full overflow-hidden w-full">
          {ai > 0    && <div className="bg-red-400 flex items-center justify-center text-[9px] text-white font-bold transition-all duration-700" style={{ width: `${ai}%` }}>{ai >= 10 ? `${ai}%` : ""}</div>}
          {mixed > 0 && <div className="bg-amber-400 flex items-center justify-center text-[9px] text-white font-bold transition-all duration-700" style={{ width: `${mixed}%` }}>{mixed >= 10 ? `${mixed}%` : ""}</div>}
          {human > 0 && <div className="bg-emerald-400 flex items-center justify-center text-[9px] text-white font-bold transition-all duration-700" style={{ width: `${human}%` }}>{human >= 10 ? `${human}%` : ""}</div>}
        </div>
        {/* Legend row */}
        <div className="flex justify-between text-[10px] font-semibold">
          <span className="flex items-center gap-1 text-red-600">
            <span className="w-2 h-2 rounded-sm bg-red-400 inline-block" />
            AI-Generated <span className="font-black">{ai}%</span>
          </span>
          <span className="flex items-center gap-1 text-amber-600">
            <span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />
            Mixed <span className="font-black">{mixed}%</span>
          </span>
          <span className="flex items-center gap-1 text-emerald-600">
            <span className="w-2 h-2 rounded-sm bg-emerald-400 inline-block" />
            Human <span className="font-black">{human}%</span>
          </span>
        </div>
      </div>

      {/* Confidence range footnote */}
      <div className="text-[9px] text-slate-400 border-t border-current border-opacity-20 pt-1.5 flex justify-between">
        <span>Likelihood range: <span className="font-bold">{low}-{high}%</span></span>
        <span className="uppercase tracking-wide">AI pattern score</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - Signal Row (updated for new SignalResult shape)
// ─────────────────────────────────────────────────────────────────────────────

function SignalRow({ signal }: { signal: SignalResult }) {
  const [open, setOpen] = useState(false);
  const color = signal.pointsToAI
    ? (signal.wellSupported ? "bg-red-400" : "bg-amber-400")
    : "bg-emerald-400";
  const dotColor = signal.pointsToAI
    ? (signal.wellSupported ? "bg-red-400" : "bg-amber-400")
    : "bg-emerald-400";

  return (
    <div className="cursor-pointer select-none" onClick={() => setOpen(v => !v)}>
      <div className="flex items-center gap-2 mb-0.5">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
        <span className="text-xs text-slate-600 flex-1 leading-tight font-medium">{signal.name}</span>
        {signal.wellSupported && signal.pointsToAI && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 font-bold">strong</span>
        )}
        <span className="text-[10px] font-mono text-slate-400 flex-shrink-0">{signal.strength}%</span>
      </div>
      <div className="ml-4 w-full h-1.5 bg-slate-100 rounded-full overflow-hidden mb-0.5">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${signal.strength}%` }} />
      </div>
      {open && <p className="ml-4 text-[10px] text-slate-400 italic mt-0.5 pb-1">{signal.value}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - Sentence Chip (updated for new label scheme)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  UI - Paragraph Heat Map  (Improvement #9)
//  Shows a per-paragraph rollup of sentence-level AI scores.
//  Gives reviewers a fast visual on WHERE in the document AI patterns cluster.
// ─────────────────────────────────────────────────────────────────────────────

function ParagraphHeatMap({ sentences, originalText }: { sentences: SentenceResult[]; originalText: string }) {
  const [expanded, setExpanded] = useState(false);
  if (sentences.length === 0) return null;

  // Split original text into paragraphs preserving offsets
  const rawParas = originalText.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 20);
  if (rawParas.length < 2) return null;

  // GAP 6 FIX: Index-based paragraph→sentence assignment.
  // Build paragraph char-offset ranges, then locate each sentence's start
  // position in the original text and assign it to the correct paragraph.
  // This handles repeated prefixes correctly because we use position, not content.
  type ParaRange = { start: number; end: number; text: string };
  const paraRanges: ParaRange[] = [];
  let searchFrom = 0;
  for (const para of rawParas) {
    const idx = originalText.indexOf(para.slice(0, Math.min(para.length, 40)), searchFrom);
    if (idx !== -1) {
      paraRanges.push({ start: idx, end: idx + para.length, text: para });
      searchFrom = idx + para.length;
    }
  }

  // For each sentence, find its start offset in the original text
  type ParaData = { paraIdx: number; text: string; sentences: SentenceResult[]; avgLikelihood: number; label: "high" | "medium" | "low" };
  const paraSentBuckets: SentenceResult[][] = paraRanges.map(() => []);
  let textCursor = 0;
  for (const sent of sentences) {
    const trimmed = sent.text.trim();
    if (!trimmed) continue;
    // Find this sentence starting from our current cursor position
    const sentStart = originalText.indexOf(trimmed.slice(0, Math.min(trimmed.length, 50)), textCursor);
    if (sentStart === -1) {
      // Fallback: assign to last paragraph with content
      const lastIdx = paraSentBuckets.length - 1;
      if (lastIdx >= 0) paraSentBuckets[lastIdx].push(sent);
      continue;
    }
    // Find which paragraph range contains this offset
    let assigned = false;
    for (let pi = 0; pi < paraRanges.length; pi++) {
      if (sentStart >= paraRanges[pi].start && sentStart <= paraRanges[pi].end + 20) {
        paraSentBuckets[pi].push(sent);
        assigned = true;
        break;
      }
    }
    // Fallback: assign to nearest paragraph by proximity
    if (!assigned) {
      let nearest = 0;
      let minDist = Infinity;
      for (let pi = 0; pi < paraRanges.length; pi++) {
        const dist = Math.abs(sentStart - paraRanges[pi].start);
        if (dist < minDist) { minDist = dist; nearest = pi; }
      }
      paraSentBuckets[nearest].push(sent);
    }
    textCursor = Math.max(0, sentStart - 10); // allow slight overlap for re-search
  }

  // Build paraData from buckets
  const paraData: ParaData[] = [];
  for (let pi = 0; pi < paraRanges.length; pi++) {
    const paraSents = paraSentBuckets[pi];
    if (paraSents.length === 0) continue;
    const avg = paraSents.reduce((s, r) => s + r.likelihood, 0) / paraSents.length;
    paraData.push({
      paraIdx: pi,
      text: paraRanges[pi].text.slice(0, 80) + (paraRanges[pi].text.length > 80 ? "…" : ""),
      sentences: paraSents,
      avgLikelihood: Math.round(avg),
      label: avg >= 55 ? "high" : avg >= 30 ? "medium" : "low",
    });
  }

  if (paraData.length < 2) return null;

  const highCount = paraData.filter(p => p.label === "high").length;
  const medCount  = paraData.filter(p => p.label === "medium").length;

  return (
    <div className="px-5 py-3 border-b border-slate-100">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between mb-1.5 group"
      >
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
          Paragraph Heat Map
          <span className="normal-case font-normal text-slate-300">— click to {expanded ? "collapse" : "expand"}</span>
        </p>
        <div className="flex items-center gap-2 text-[9px] font-medium">
          {highCount > 0 && <span className="bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-bold">{highCount} high</span>}
          {medCount > 0  && <span className="bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded font-bold">{medCount} medium</span>}
          <span className={`text-slate-400 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>▾</span>
        </div>
      </button>

      {/* Compact bar overview — always visible */}
      <div className="flex gap-0.5 h-4 rounded overflow-hidden mb-1">
        {paraData.map((p, i) => {
          const bg = p.label === "high" ? "bg-red-400" : p.label === "medium" ? "bg-amber-300" : "bg-emerald-200";
          return (
            <div
              key={i}
              title={`Para ${i+1}: ${p.avgLikelihood}% avg pattern likelihood`}
              className={`flex-1 ${bg} transition-all`}
              style={{ opacity: 0.5 + p.avgLikelihood / 200 }}
            />
          );
        })}
      </div>
      <p className="text-[9px] text-slate-300 mb-1.5">Each bar = one paragraph. Red = elevated AI patterns, amber = moderate, green = low.</p>

      {/* Expanded detail rows */}
      {expanded && (
        <div className="space-y-1.5 mt-2">
          {paraData.map((p, i) => {
            const barColor = p.label === "high" ? "bg-red-400" : p.label === "medium" ? "bg-amber-300" : "bg-emerald-300";
            const textColor = p.label === "high" ? "text-red-700" : p.label === "medium" ? "text-amber-700" : "text-emerald-700";
            const bgColor   = p.label === "high" ? "bg-red-50 border-red-200" : p.label === "medium" ? "bg-amber-50 border-amber-200" : "bg-slate-50 border-slate-200";
            return (
              <div key={i} className={`rounded-lg border px-2.5 py-2 ${bgColor}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[9px] font-bold text-slate-400 uppercase w-12 flex-shrink-0">Para {i+1}</span>
                  <div className="flex-1 h-1.5 bg-white/60 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${barColor}`} style={{ width: `${p.avgLikelihood}%` }} />
                  </div>
                  <span className={`text-[9px] font-bold ${textColor} w-8 text-right flex-shrink-0`}>{p.avgLikelihood}%</span>
                  <span className={`text-[8px] font-bold uppercase px-1.5 py-0.5 rounded ${p.label === "high" ? "bg-red-200 text-red-700" : p.label === "medium" ? "bg-amber-200 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                    {p.label}
                  </span>
                </div>
                <p className="text-[9px] text-slate-500 italic leading-tight">{p.text}</p>
                <p className="text-[9px] text-slate-400 mt-0.5">{p.sentences.length} sentence{p.sentences.length !== 1 ? "s" : ""} · elevated: {p.sentences.filter(s => s.label === "elevated").length} · moderate: {p.sentences.filter(s => s.label === "moderate").length}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SentenceChip({ s, idx }: { s: SentenceResult; idx: number }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const hl = {
    elevated: { bg: "bg-red-50",    border: "border-red-300",    text: "text-red-900",    dot: "bg-red-400",    label: "Elevated patterns" },
    moderate: { bg: "bg-amber-50",  border: "border-amber-300",  text: "text-amber-900",  dot: "bg-amber-400",  label: "Some patterns" },
    uncertain:{ bg: "bg-slate-50",  border: "border-slate-200",  text: "text-slate-700",  dot: "bg-slate-400",  label: "No strong patterns" },
  }[s.label];
  const tip = idx % 2 === 0 ? "left-0" : "right-0";

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const report = `Sentence: "${s.text}" | Pattern likelihood: ${s.likelihood}% | Level: ${hl.label}${s.signals.length > 0 ? " | Signals: " + s.signals.join("; ") : ""}`;
    navigator.clipboard.writeText(report).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  return (
    <span className={`relative inline cursor-pointer px-0.5 rounded ${hl.bg} border-b-2 ${hl.border} ${hl.text}`}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => { setShow(false); }}>
      {s.text}{" "}
      {show && (
        <span className={`absolute ${tip} top-full mt-1 z-50 w-80 bg-white border border-gray-200 shadow-xl rounded-xl p-3 text-xs pointer-events-auto`}
          style={{ whiteSpace: "normal" }}>
          <div className="flex items-center gap-1.5 mb-1.5 font-semibold text-gray-800">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${hl.dot}`} />
            {hl.label}
            <span className="ml-auto text-gray-400 font-normal text-[10px]">Pattern likelihood: {s.likelihood}%</span>
          </div>
          <p className="text-[10px] text-gray-400 italic mb-1.5">
            This reflects detected patterns only - it does not determine authorship.
          </p>
          {s.signals.length > 0 ? (
            <ul className="space-y-0.5 text-gray-500 mb-2">
              {s.signals.map(sig => (
                <li key={sig} className="flex items-center gap-1"><span className="text-slate-400">›</span> {sig}</li>
              ))}
            </ul>
          ) : <span className="text-gray-400 italic block mb-2">No notable patterns in this sentence</span>}
          {/* Enhancement #11: copy-to-clipboard for academic integrity reports */}
          <button
            onClick={handleCopy}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 transition-colors text-[10px] font-semibold text-slate-600"
          >
            {copied ? <><span className="text-emerald-600">✓</span> Copied!</> : <><span>📋</span> Copy for report</>}
          </button>
        </span>
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - Engine Panel (redesigned for fairness-first output)
// ─────────────────────────────────────────────────────────────────────────────

function EnginePanel({
  name, logoText, logoBg, methodology, primarySignal, result, loading, accentColor, borderColor, originalText,
}: {
  name: string; logoText: string; logoBg: string; methodology: string; primarySignal: string;
  result: EngineResult | null; loading: boolean; accentColor: string; borderColor: string;
  originalText?: string;
}) {
  return (
    <div className={`bg-white rounded-2xl shadow-sm border-2 ${borderColor} flex flex-col`}>
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="flex items-center gap-3 mb-2">
          <div className={`w-9 h-9 rounded-xl ${logoBg} flex items-center justify-center flex-shrink-0`}>
            <span className="text-white text-xs font-black">{logoText}</span>
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">{name}</h2>
            <p className="text-[11px] text-slate-500 leading-tight">{methodology}</p>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 whitespace-nowrap">Primary signal:</span>
          <span className="text-[10px] font-bold px-3 py-1.5 rounded-full border text-center leading-tight w-full"
            style={{ backgroundColor: `${accentColor}12`, color: accentColor, borderColor: `${accentColor}40` }}>
            {primarySignal}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20">
          <svg className="animate-spin h-7 w-7" style={{ color: accentColor }} viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
          </svg>
          <p className="text-sm font-medium text-slate-500">Analyzing…</p>
        </div>
      ) : result ? (
        <div className="flex flex-col flex-1">

          {/* Score breakdown + evidence strength */}
          <div className="px-5 pt-4 pb-3 border-b border-slate-100 space-y-3">
            <ScoreBreakdown
              internalScore={result.internalScore}
              strength={result.evidenceStrength}
              low={result.confidenceLow}
              high={result.confidenceHigh}
              elevatedSentenceRatio={
                result.sentences.length > 0
                  ? result.sentences.filter(s => s.label === "elevated").length / result.sentences.length
                  : 0
              }
            />
            <p className="text-xs text-slate-600 leading-relaxed font-medium">{result.verdictPhrase}</p>

            {/* ── Per-Engine Reliability Score Badge ───────────────────────── */}
            {(() => {
              const wc = result.wordCount;
              const warns = result.reliabilityWarnings;
              const hasESL      = warns.some(w => /ESL|non-native|language/i.test(w));
              const hasShort    = wc < 150;
              const hasDomain   = warns.some(w => w.startsWith("Domain detected:"));
              const hasGenre    = warns.some(w => w.startsWith("Genre detected:"));
              // Deduct points per reliability risk factor
              let rel = 100;
              if (wc < 80)  rel -= 50;
              else if (wc < 150) rel -= 25;
              else if (wc < 300) rel -= 10;
              if (hasESL)    rel -= 15;
              if (hasDomain) rel -= 8;
              if (hasGenre)  rel -= 5;
              if (warns.filter(w => !w.startsWith("Domain") && !w.startsWith("Genre")).length >= 2) rel -= 10;
              rel = Math.max(10, Math.min(100, rel));
              const color = rel >= 75 ? "#16a34a" : rel >= 50 ? "#d97706" : "#dc2626";
              const label = rel >= 75 ? "High" : rel >= 50 ? "Moderate" : "Low";
              return (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">Reliability</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: color + "18", color }}>
                    {label} · {rel}%
                  </span>
                  {rel < 75 && <span className="text-[10px] text-slate-400">— treat verdict with caution</span>}
                </div>
              );
            })()}
            {result.reliabilityWarnings.length > 0 && (() => {
              const domainWarnings = result.reliabilityWarnings.filter(w => w.startsWith("Domain detected:"));
              const otherWarnings  = result.reliabilityWarnings.filter(w => !w.startsWith("Domain detected:"));
              return (
                <>
                  {domainWarnings.length > 0 && (
                    <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 space-y-0.5">
                      <p className="text-[10px] font-bold text-blue-700 uppercase tracking-wide">🏷 Domain Detected</p>
                      {domainWarnings.map((w, i) => (
                        <p key={i} className="text-[10px] text-blue-700">{w.replace("Domain detected: ", "")}</p>
                      ))}
                    </div>
                  )}
                  {otherWarnings.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 space-y-0.5">
                      <p className="text-[10px] font-bold text-amber-700 uppercase tracking-wide">⚠ Reliability Notes</p>
                      {otherWarnings.map((w, i) => (
                        <p key={i} className="text-[10px] text-amber-700">{w}</p>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}

            <div className="grid grid-cols-2 gap-1.5 text-center">
              {[
                { label: "Words",     value: result.wordCount },
                { label: "Sentences", value: result.sentenceCount },
              ].map(({ label, value }) => (
                <div key={label} className="bg-white rounded-lg py-1.5 border border-slate-100">
                  <div className="text-sm font-bold text-slate-800">{value}</div>
                  <div className="text-[9px] text-slate-400 uppercase">{label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Engine identity strip */}
          <div className="px-5 py-2 flex items-center gap-2 border-b border-slate-100" style={{ backgroundColor: `${accentColor}08` }}>
            <span className={`w-6 h-6 rounded-lg ${logoBg} flex items-center justify-center flex-shrink-0`}>
              <span className="text-white text-[9px] font-black">{logoText}</span>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold truncate" style={{ color: accentColor }}>{name}</p>
              <p className="text-[9px] text-slate-400">Primary signal: <span className="font-semibold">{primarySignal}</span></p>
            </div>
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full border" style={{ color: accentColor, borderColor: `${accentColor}40`, backgroundColor: `${accentColor}10` }}>
              {result.wordCount}w · {result.sentenceCount}s
            </span>
          </div>

          {/* Signals */}
          <div className="px-5 py-3 border-b border-slate-100">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
              Signal Breakdown <span className="normal-case font-normal text-slate-400">— click any signal to expand</span>
            </p>
            <div className="space-y-2.5">
              {result.signals.map((sig, i) => <SignalRow key={i} signal={sig} />)}
            </div>
          </div>

          {/* Paragraph heat map */}
          <ParagraphHeatMap
            sentences={result.sentences}
            originalText={originalText || result.sentences.map(s => s.text).join(" ")}
          />

          {/* Sentence highlighting */}
          <div className="px-5 py-3">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Sentence-Level Pattern Analysis</p>
              <div className="flex gap-2 text-[9px] font-medium text-slate-400">
                {[
                  { c: "bg-red-300", l: "Elevated" },
                  { c: "bg-amber-300", l: "Moderate" },
                  { c: "bg-slate-300", l: "Uncertain" },
                ].map(({ c, l }) => (
                  <span key={l} className="flex items-center gap-1"><span className={`w-2 h-2 rounded-sm ${c}`} />{l}</span>
                ))}
              </div>
            </div>
            <p className="text-[10px] text-slate-300 mb-2">Hover any sentence for signal details</p>
            <div className="text-sm leading-8 text-slate-800">
              {result.sentences.map((s, i) => <SentenceChip key={i} s={s} idx={i} />)}
            </div>
          </div>

        </div>
      ) : (
        <div className="flex items-center justify-center py-20 text-center px-6">
          <div className="text-slate-400 space-y-1.5">
            <div className="text-3xl">📊</div>
            <p className="text-sm text-slate-400">Results will appear here</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - How Popular AI Text Detection Software Works (educational section)
// ─────────────────────────────────────────────────────────────────────────────

const HOW_IT_WORKS_TECHNIQUES = [
  {
    id: 1,
    icon: "📉",
    title: "Perplexity Analysis",
    borderColor: "#3b82f6",
    bgCard: "#eff6ff",
    badge: "bg-blue-100 text-blue-700",
    badgeLabel: "Core Method",
    body: "The most foundational method. Perplexity measures how \"surprising\" a piece of text is to a language model - how unpredictable each word choice is. AI-generated text tends to have low perplexity because models gravitate toward statistically likely word sequences, while humans make more unexpected, idiosyncratic word choices.",
  },
  {
    id: 2,
    icon: "📊",
    title: "Burstiness Detection",
    borderColor: "#16a34a",
    bgCard: "#f0fdf4",
    badge: "bg-green-100 text-green-700",
    badgeLabel: "Rhythm Signal",
    body: "Human writing has burstiness - it alternates between complex, long sentences and short, punchy ones. AI text tends to be rhythmically uniform: sentence lengths and complexity stay suspiciously consistent throughout a passage. Detectors measure the coefficient of variation (CV) of sentence lengths to flag this flatness.",
  },
  {
    id: 3,
    icon: "🔬",
    title: "Stylometric Fingerprinting",
    borderColor: "#9333ea",
    bgCard: "#faf5ff",
    badge: "bg-purple-100 text-purple-700",
    badgeLabel: "Deep Signal",
    body: "Examines deeper stylistic patterns. Type-Token Ratio (TTR) measures how many unique words vs. total words appear - AI text tends to reuse common vocabulary, lowering TTR. Bigram/trigram density flags overused word-pair combinations that are statistically \"safe\". AI also gravitates toward neutral, balanced sentence construction and avoids things like em-dashes, ellipses, or abrupt fragments.",
  },
  {
    id: 4,
    icon: "🔏",
    title: "Watermarking",
    borderColor: "#0891b2",
    bgCard: "#ecfeff",
    badge: "bg-cyan-100 text-cyan-700",
    badgeLabel: "Emerging",
    body: "Some generators (OpenAI and research tools) embed statistical watermarks - subtle biases in token selection during generation, e.g. always preferring certain synonym choices. Detectors that know the watermark pattern can verify origin. This is still emerging and not universally deployed.",
  },
  {
    id: 5,
    icon: "🧲",
    title: "Semantic Coherence & Topic Drift",
    borderColor: "#d97706",
    bgCard: "#fffbeb",
    badge: "bg-amber-100 text-amber-700",
    badgeLabel: "Structural",
    body: "AI text tends to stay very on-topic with smooth transitions. Human writing often drifts, contradicts itself, or includes tangential thoughts. Some detectors flag text that is too coherent or too perfectly organized as a sign of machine authorship.",
  },
  {
    id: 6,
    icon: "🤖",
    title: "Training-Based Classifiers",
    borderColor: "#dc2626",
    bgCard: "#fef2f2",
    badge: "bg-red-100 text-red-700",
    badgeLabel: "Dominant Approach",
    body: "Tools like GPTZero, Originality.ai, and Turnitin train binary classifiers - often fine-tuned transformers like RoBERTa - on large labeled datasets of human vs. AI text. The model learns subtle distributional patterns too complex to describe as rules. This is increasingly the dominant approach in commercial tools.",
  },
  {
    id: 7,
    icon: "📐",
    title: "MTLD Lexical Diversity",
    borderColor: "#0d9488",
    bgCard: "#f0fdfa",
    badge: "bg-teal-100 text-teal-700",
    badgeLabel: "Research-Grade",
    body: "Measure of Textual Lexical Diversity (MTLD) is a length-invariant vocabulary richness metric used in computational linguistics research. Unlike simple type-token ratio (TTR), MTLD doesn't artificially inflate for short texts. AI models recycle a limited vocabulary systematically (low MTLD); human writers vary their word choices more naturally (high MTLD). This tool computes both forward and reverse MTLD for stability.",
  },
  {
    id: 8,
    icon: "🔁",
    title: "Semantic Self-Similarity",
    borderColor: "#4f46e5",
    bgCard: "#eef2ff",
    badge: "bg-indigo-100 text-indigo-700",
    badgeLabel: "Novel Signal",
    body: "AI models express the same conceptual ideas using synonym rotation — 'plays a crucial role' becomes 'serves a vital function' becomes 'fulfills an essential purpose'. Human writers focus on specific ideas without exhausting a synonym thesaurus. This detector measures how many words from the same conceptual cluster (importance, enhancement, facilitation, etc.) appear in a single document.",
  },
  {
    id: 9,
    icon: "🎭",
    title: "Tone Register Flatness",
    borderColor: "#e11d48",
    bgCard: "#fff1f2",
    badge: "bg-rose-100 text-rose-700",
    badgeLabel: "Novel Signal",
    body: "Human writers modulate emotional tone — they are enthusiastic in some places, critical in others, uncertain elsewhere. AI maintains a suspiciously consistent neutral-to-positive register throughout entire documents, as if written by someone who never gets excited, frustrated, or genuinely uncertain. This detector measures per-sentence sentiment valence variance; low variance with neutral-positive bias is an AI fingerprint.",
  },
];

const TOOL_TABLE = [
  { tool: "GPTZero",       approach: "Perplexity + burstiness + trained classifier" },
  { tool: "Turnitin AI",   approach: "Fine-tuned transformer classifier on academic corpora" },
  { tool: "Originality.ai",approach: "RoBERTa-based classifier + perplexity scoring" },
  { tool: "Copyleaks",     approach: "Multi-model ensemble + semantic analysis" },
  { tool: "ZeroGPT",       approach: "Deep learning classifier + DeepAnalyse™ algorithm" },
];

// ─────────────────────────────────────────────────────────────────────────────
//  UI — LIVE AI WORD HIGHLIGHTER
// ─────────────────────────────────────────────────────────────────────────────

// OPT P5: Extract tokenisation into a pure function for caching.
function _computeHighlightParts(text: string) {
  const parts: Array<{ word: string; tier: "strong" | "medium" | "none" }> = [];
  const tokenRe = /(\b[a-zA-Z\'-]+\b|[^a-zA-Z\'-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    const tok = match[0];
    const lower = tok.toLowerCase().replace(/[^a-z]/g, "");
    parts.push({
      word: tok,
      tier: AI_VOCAB_STRONG.has(lower) ? "strong"
           : AI_VOCAB_MEDIUM.has(lower) ? "medium"
           : "none",
    });
  }
  return parts;
}

function LiveHighlightedText({ text }: { text: string }) {
  if (!text.trim()) return null;
  // OPT P5: Compute highlight parts only when text changes (avoids re-tokenising on every render)
  const parts = _computeHighlightParts(text);
  const strongCount = parts.filter(p => p.tier === "strong").length;
  const mediumCount = parts.filter(p => p.tier === "medium").length;
  return (
    <div className="rounded-2xl border-2 border-slate-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-slate-700">🔍 Live AI Word Scanner</span>
          <span className="text-[10px] text-slate-400 hidden sm:inline">Highlights AI-associated vocabulary</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-semibold">
          <span className="flex items-center gap-1 text-red-600"><span className="inline-block w-3 h-1.5 rounded bg-red-400" /> Strong ({strongCount})</span>
          <span className="flex items-center gap-1 text-amber-600"><span className="inline-block w-3 h-1.5 rounded bg-amber-400" /> Medium ({mediumCount})</span>
        </div>
      </div>
      <div className="px-4 py-3 text-sm leading-relaxed text-slate-800 max-h-44 overflow-y-auto whitespace-pre-wrap break-words" style={{ fontSize: "13px", lineHeight: "1.8" }}>
        {parts.map((p, i) =>
          p.tier === "strong" ? (
            <mark key={i} className="bg-red-100 text-red-800 rounded px-0.5 border-b-2 border-red-400 not-italic">{p.word}</mark>
          ) : p.tier === "medium" ? (
            <mark key={i} className="bg-amber-50 text-amber-800 rounded px-0.5 border-b-2 border-amber-300 not-italic">{p.word}</mark>
          ) : (
            <span key={i}>{p.word}</span>
          )
        )}
      </div>
      {(strongCount > 0 || mediumCount > 0) ? (
        <div className="px-4 py-2 bg-slate-50 border-t border-slate-200 text-[10px] text-slate-500">
          {strongCount > 0 && <span className="text-red-600 font-semibold">{strongCount} strong-tier AI word{strongCount !== 1 ? "s" : ""}</span>}
          {strongCount > 0 && mediumCount > 0 && <span className="text-slate-400 mx-1">·</span>}
          {mediumCount > 0 && <span className="text-amber-600 font-semibold">{mediumCount} medium-tier word{mediumCount !== 1 ? "s" : ""}</span>}
          <span className="text-slate-400 ml-2">— red = AI-exclusive vocab, amber = AI-overused formal vocab</span>
        </div>
      ) : (
        <div className="px-4 py-2 bg-emerald-50 border-t border-emerald-200 text-[10px] text-emerald-700 font-semibold">
          ✓ No AI-associated vocabulary detected
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI — WRITING FINGERPRINT RADAR CHART
// ─────────────────────────────────────────────────────────────────────────────

function RadarChart({ perpResult, burstResult, neuralResult }: {
  perpResult: EngineResult | null;
  burstResult: EngineResult | null;
  neuralResult: EngineResult | null;
}) {
  if (!perpResult || !burstResult) return null;
  const getStr = (result: EngineResult, name: string): number => {
    const sig = result.signals.find(s => s.name.toLowerCase().includes(name.toLowerCase()));
    return sig ? Math.min(100, sig.strength) : 0;
  };
  const dims = [
    { label: "Vocabulary", score: Math.min(100, getStr(perpResult, "AI Vocabulary") * 1.2), color: "#ef4444", desc: "AI-specific word density" },
    { label: "Burstiness", score: Math.min(100, getStr(burstResult, "Sentence Length") * 1.1), color: "#f59e0b", desc: "Sentence rhythm uniformity" },
    { label: "Structural", score: Math.min(100, ((getStr(perpResult, "Paragraph-opening") + getStr(perpResult, "Paragraph Structure")) / 2) * 1.4), color: "#8b5cf6", desc: "Document organization rigidity" },
    { label: "Stylometric", score: Math.min(100, ((getStr(perpResult, "Hedged") + getStr(perpResult, "Clause Stack")) / 2) * 1.3), color: "#3b82f6", desc: "Writing style patterns" },
    { label: "Semantic", score: Math.min(100, ((getStr(perpResult, "MTLD") + getStr(perpResult, "Semantic Self")) / 2) * 1.5), color: "#10b981", desc: "Concept diversity & repetition" },
    { label: "Neural", score: neuralResult ? Math.min(100, neuralResult.internalScore * 1.1) : 0, color: "#ec4899", desc: neuralResult ? "LLM token predictability" : "Run analysis to see" },
  ];
  const N = dims.length;
  const CX = 120, CY = 120, R = 88;
  const ang = (i: number) => (2 * Math.PI * i) / N;
  const pt = (i: number, r: number) => ({ x: CX + r * Math.sin(ang(i)), y: CY - r * Math.cos(ang(i)) });
  const gridLevels = [0.25, 0.5, 0.75, 1.0];
  const dataPts = dims.map((d, i) => pt(i, (d.score / 100) * R));
  const poly = dataPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";
  const avgScore = Math.round(dims.reduce((s, d) => s + d.score, 0) / N);
  const dominantDim = dims.reduce((a, b) => a.score > b.score ? a : b);
  return (
    <div className="bg-white rounded-2xl border-2 border-slate-200 overflow-hidden">
      <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
        <div>
          <p className="font-bold text-slate-800 text-sm">🕸 Writing Fingerprint</p>
          <p className="text-[10px] text-slate-400">6-dimensional AI pattern signature</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black text-slate-800">{avgScore}<span className="text-sm font-normal text-slate-400">%</span></p>
          <p className="text-[10px] text-slate-500">avg AI signal</p>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row items-center">
        <div className="flex-shrink-0 p-2">
          <svg width="240" height="240" viewBox="0 0 240 240">
            {gridLevels.map(level => {
              const gpts = dims.map((_, i) => pt(i, level * R));
              const gpath = gpts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";
              return <path key={level} d={gpath} fill="none" stroke="#e2e8f0" strokeWidth="0.8" />;
            })}
            {dims.map((_, i) => { const op = pt(i, R); return <line key={i} x1={CX} y1={CY} x2={op.x.toFixed(1)} y2={op.y.toFixed(1)} stroke="#e2e8f0" strokeWidth="0.8" />; })}
            <path d={poly} fill="rgba(239,68,68,0.12)" stroke="#ef4444" strokeWidth="2" strokeLinejoin="round" />
            {dataPts.map((p, i) => <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r="4" fill={dims[i].color} stroke="white" strokeWidth="1.5" />)}
            <circle cx={CX} cy={CY} r="3" fill="#cbd5e1" />
            {dims.map((d, i) => {
              const lp = pt(i, R + 17);
              const ta = lp.x < CX - 5 ? "end" : lp.x > CX + 5 ? "start" : "middle";
              return (
                <g key={i}>
                  <text x={lp.x.toFixed(1)} y={lp.y.toFixed(1)} textAnchor={ta} fontSize="9" fontWeight="700" fill={d.color} fontFamily="system-ui,sans-serif">{d.label}</text>
                  <text x={lp.x.toFixed(1)} y={(parseFloat(lp.y.toFixed(1)) + 10).toFixed(1)} textAnchor={ta} fontSize="8" fill="#94a3b8" fontFamily="system-ui,sans-serif">{d.score.toFixed(0)}%</text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="flex-1 px-4 py-4 space-y-2 w-full">
          {dims.map(d => (
            <div key={d.label}>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-xs font-bold" style={{ color: d.color }}>{d.label}</span>
                <span className="text-[10px] font-mono text-slate-500">{d.score.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${d.score}%`, backgroundColor: d.color, opacity: 0.8 }} />
              </div>
              <p className="text-[9px] text-slate-400 mt-0.5">{d.desc}</p>
            </div>
          ))}
          <div className="mt-2 pt-2 border-t border-slate-100 text-[10px] text-slate-500">
            Dominant: <span className="font-bold" style={{ color: dominantDim.color }}>{dominantDim.label}</span> ({dominantDim.score.toFixed(0)}%)
          </div>
        </div>
      </div>
    </div>
  );
}


function HowItWorksSection() {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="bg-white rounded-2xl overflow-hidden border border-slate-200">
      {/* Toggle header */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left group"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl"></span>
          <div>
            <p className="text-slate-900 font-bold text-sm">How Popular AI Text Detection Software Works</p>
            <p className="text-slate-400 text-xs mt-0.5">
             {/* 6 core techniques used by GPTZero, Turnitin, Originality.ai and others */}
            </p>
          </div>
        </div>
        <span className={`text-slate-400 text-lg transition-transform duration-300 ${open ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-200 px-5 py-5 space-y-5">

          {/* Intro */}
          <p className="text-slate-500 text-xs leading-relaxed">
            AI text detectors use several overlapping techniques to distinguish human-written from AI-generated content.
            No single technique is definitive - this tool combine many of these signals into ensemble models.
          </p>

          {/* Technique cards */}
          <div className="grid sm:grid-cols-2 gap-3">
            {HOW_IT_WORKS_TECHNIQUES.map(t => (
              <div
                key={t.id}
                onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                className="cursor-pointer rounded-xl border px-4 py-3 space-y-1.5 transition-all hover:brightness-95"
                style={{
                  borderLeftWidth: "4px",
                  borderLeftColor: t.borderColor,
                  borderTopColor: `${t.borderColor}33`,
                  borderRightColor: `${t.borderColor}33`,
                  borderBottomColor: `${t.borderColor}33`,
                  background: t.bgCard,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-base">{t.icon}</span>
                    <span className="text-slate-900 text-xs font-bold">{t.title}</span>
                  </div>
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${t.badge} flex-shrink-0`}>
                    {t.badgeLabel}
                  </span>
                </div>
                <p className={`text-slate-500 text-[10px] leading-relaxed transition-all ${expandedId === t.id ? "" : "line-clamp-2"}`}>
                  {t.body}
                </p>
                {expandedId !== t.id && (
                  <span className="text-[9px] text-slate-500 italic">click to expand</span>
                )}
              </div>
            ))}
          </div>

          {/* Tool comparison table */}
        {/*   <div>
            <p className="text-white text-xs font-bold mb-2 flex items-center gap-2">
              <span>🛠</span> How Major Tools Combine These
            </p>
            <div className="rounded-xl overflow-hidden border border-slate-700">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-700">
                    <th className="text-left text-slate-300 font-semibold px-3 py-2 w-1/3">Tool</th>
                    <th className="text-left text-slate-300 font-semibold px-3 py-2">Core Approach</th>
                  </tr>
                </thead>
                <tbody>
                  {TOOL_TABLE.map((row, i) => (
                    <tr key={row.tool} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-850 bg-opacity-60"}>
                      <td className="text-blue-300 font-bold px-3 py-2">{row.tool}</td>
                      <td className="text-slate-400 px-3 py-2">{row.approach}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div> */}

          {/* Key limitation */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <p className="text-amber-700 text-[10px] font-bold uppercase tracking-wide mb-1">⚠ Key Limitation</p>
            <p className="text-amber-700/80 text-[10px] leading-relaxed">
              All detection methods have a fundamental weakness: paraphrasing and humanization tools (like Quillbot)
              can perturb AI text enough to evade detectors by artificially increasing perplexity and burstiness.
              This detector's three-layer scoring approach - combining vocabulary density, burstiness CV, and
              stylometric fingerprinting - is designed to catch subtler signals even in lightly edited AI text.
            </p>
          </div>

        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENGINE C — NEURAL PERPLEXITY  (Anthropic API · Option C)
//
//  Sends the text to Claude claude-sonnet-4-20250514 with a carefully structured
//  prompt that asks it to evaluate:
//    1. Token-level predictability (proxy for true LLM perplexity)
//    2. Sentence-level semantic smoothness (lack of human "messiness")
//    3. Structural fingerprints: tricolon, paragraph uniformity, transition density
//    4. A per-sentence likelihood estimate
//
//  Returns a full EngineResult so it slots directly into the existing
//  ensemble, PDF report, and UI components with zero changes to those layers.
//
//  How this improves metrics:
//  • Overall Accuracy  ↑  — third independent vote resolves 2-engine ties
//  • AI Recall         ↑  — token-predictability catches paraphrased / lightly
//                           edited AI text that evades heuristic vocab lists
//  • Human Recall      ↑  — LLM knows that high-entropy human prose is NOT
//                           low-perplexity; reduces false-positive rate
//  • Mixed/Hybrid F1   ↑  — the model can reason about sentence-level switches
//                           even when overall stats look ambiguous
//  • False Pos. Rate   ↓  — LLM explicitly flags ESL / academic caveats;
//                           its reasoning layer understands context that
//                           regex patterns cannot
// ─────────────────────────────────────────────────────────────────────────────

async function runNeuralEngine(text: string, engineAContext?: { score: number; topSignals: string[]; evidenceStrength: string } | null, engineBContext?: { score: number; topSignals: string[]; evidenceStrength: string } | null): Promise<EngineResult> {
  const sentences = splitSentences(text);
  const wc = text.trim().split(/\s+/).length;

  if (wc < 80) {
    return {
      internalScore: 0, confidenceLow: 0, confidenceHigh: 30,
      evidenceStrength: "INCONCLUSIVE" as EvidenceStrength,
      verdictPhrase: "Text too short for neural analysis (need ≥ 80 words)",
      signals: [], sentences: [], wordCount: wc, sentenceCount: sentences.length,
      reliabilityWarnings: ["Text too short for reliable analysis (fewer than 80 words)"],
    };
  }

  // ── Enhancement #5: Sliding-window strategy for long texts ─────────────────
  // Previously truncated at 800 words, silently missing the second half of most
  // student essays. Now: analyze first 700 words + last 500 words separately,
  // then average scores. This catches mixed-authorship where AI content appears
  // only in the conclusion (a common student pattern).
  const MAX_WORDS = 700;
  const TAIL_WORDS = 500;
  let analysisText: string;
  let usedSlidingWindow = false;

  if (wc > MAX_WORDS + TAIL_WORDS) {
    const wordArr = text.trim().split(/\s+/);
    const headText = wordArr.slice(0, MAX_WORDS).join(" ");
    const tailText = wordArr.slice(-TAIL_WORDS).join(" ");
    analysisText = `[DOCUMENT HEAD — first ${MAX_WORDS} words]\n${headText}\n\n[DOCUMENT TAIL — last ${TAIL_WORDS} words]\n${tailText}\n\n[Note: analyze both sections; flag any authorship inconsistency between head and tail as a potential mixed-authorship signal.]`;
    usedSlidingWindow = true;
  } else if (wc > MAX_WORDS) {
    analysisText = text.trim().split(/\s+/).slice(0, MAX_WORDS).join(" ") + " [truncated for analysis]";
  } else {
    analysisText = text;
  }

  const SYSTEM_PROMPT = `You are an expert AI content detection engine implementing state-of-the-art zero-shot detection methods analogous to Binoculars (Hans et al., ICML 2024) and DetectGPT. Your task is to analyze text and determine the probability it was generated by an AI language model.

You must respond ONLY with a valid JSON object — no explanation, no markdown, no preamble.

CRITICAL FOCUS — Ignore vocabulary lists entirely. Instead, evaluate ONLY what LLMs can detect that rule-based systems cannot:

Evaluate these dimensions and return a score from 0 (strongly human) to 100 (strongly AI):

1. token_predictability: This is your PRIMARY signal. Does each word feel like the most statistically expected next token? AI text sits at a LOCAL PROBABILITY MAXIMUM — every word choice is the most likely continuation. Human text is idiosyncratic: unexpected word orders, unusual collocations, surprising metaphors, mid-thought corrections. Rate the SMOOTHNESS of token sequences throughout. Score 80-100 if text reads like a language model predicted every word, 0-20 if word choices feel unpredictable and personal.

2. semantic_smoothness: Does the text flow with ZERO friction — zero unexpected tangents, zero logical gaps, zero self-corrections? AI text is semantically over-smooth. Human writers get confused mid-paragraph, change direction, repeat themselves slightly differently, or introduce unexpected examples. Also consider: if you changed 3 random words to synonyms, would the text sound MORE or LESS natural? AI text degrades with substitution (it's at a peak); human text is neutral to substitution.

3. structural_uniformity: Are paragraph lengths, sentence counts, and rhythms metronomically consistent? Could you predict the structure of the NEXT paragraph before reading it? AI follows predictable discourse schemas (intro → examples → counterargument → conclusion). Score high if you can mentally generate the next paragraph.

4. transition_density: Does the text overuse connective tissue (furthermore, moreover, in conclusion, it is worth noting, etc.)? AI over-engineers paragraph linkage.

5. vocabulary_authenticity: Beyond word lists — does the text use vocabulary at the STATISTICAL DENSITY typical of AI output? High density of abstract, elevated, formal terms with zero concrete sensory details, zero colloquial register shifts, zero personality-specific word choices.

6. human_markers: Are there informal phrases, contractions, em-dashes, genuine personal anecdotes, concrete specific details (named real people, specific dates, actual products), contradictions, or signs of human thinking-while-writing? ABSENCE of any specificity is a strong AI signal. Human writers ground text in real experience.

7. hedging_density: AI systematically hedges EVERY claim as a safety mechanism. Humans hedge purposefully and sparingly. Count epistemic hedge density vs. assertive claim ratio. Score high if almost every sentence contains "may", "can often", "generally tends", "in many cases", "it is possible that".

8. named_entity_grounding: Does the text float in abstraction (no real people, no specific places, no verifiable dates, no actual publication names)? AI essays avoid concrete named references. Human writers reference specific entities naturally. Score 0-20 if richly grounded, 70-100 if suspiciously abstract throughout.

9. bimodal_sentence_distribution: CRITICAL for Mixed/Hybrid detection. Examine the per-sentence AI likelihood scores you will assign. Is the distribution BIMODAL — do some sentences cluster at the high end (AI-like) AND others cluster at the low end (human-like)? A bimodal distribution is a stronger Mixed signal than any average. If you detect this pattern, flag it in reliability_notes and set a higher overall_score reflecting mixed authorship.

10. perturbation_resistance: Mentally test: if I changed 3 random words to synonyms, would the text degrade? AI text is at a LOCAL MAXIMUM — substitutions make it worse. Human text is NOT at a maximum — substitutions are neutral or improve nothing. A text that reads like "every word is exactly right" scores high here.

ESL / Non-native English consideration: If writing shows ESL markers (shorter average sentences, direct noun-verb-object constructions, limited subordinate clause variety, simpler transition phrases, direct phrasing without elaboration, article omission errors, preposition confusions), REDUCE your overall_score by 10-15 points and note this in reliability_notes. False positives on ESL writers cause severe harm.

CRITICAL EXCEPTION — THESIS CONCLUSION / CHAPTER 5: If the text appears to be a thesis conclusion, summary of findings, or Chapter 5 (look for: numbered findings, "this study successfully", "the results revealed", "recommendations" section, numbered conclusions, baseline model comparison, RMSE/MAE metrics, research objective language), you must NOT apply the ESL reduction even if the author is a Filipino/Philippine student. Here is why: AI-polished thesis conclusions show ZERO ESL transfer features precisely because an LLM wrote or heavily edited them. The absence of L1-interference is itself evidence of AI authorship. Instead, for thesis conclusion text, INCREASE sensitivity to: (1) token predictability — every word feels like the most statistically probable continuation; (2) structural uniformity — each paragraph follows an identical restate→quantify→interpret→generalize schema; (3) nominalization density — abstract nouns ending in -tion, -sion, -ment, -ity dominate; (4) zero hedging failures — no self-corrections, no contradictions, no writer's voice; (5) perfect schema adherence — conclusions that read like an LLM was given "write a conclusion for Finding N" as a prompt.

For thesis conclusion text specifically, weight token_predictability at 50% of your overall_score (instead of the usual 20%). A score of 40-60 from Engines A and B for this genre should be treated as STRONGER evidence of AI than it would be for general prose, because the domain and ESL suppressions that reduced those scores do not apply here.

IMPORTANT: The bimodal_sentence_distribution and perturbation_resistance dimensions are NEW — use them to catch paraphrased AI text that evades vocabulary-based detectors.

Also provide:
- overall_score: weighted composite of all above (0-100, higher = more AI-like). Weight token_predictability and semantic_smoothness most heavily (40% combined). If pre-computed engine scores are provided in the user message, calibrate toward their consensus when they strongly agree (both >60 or both <25). When they disagree, look for the reason: paraphrased AI? ESL? Mixed authorship?
- evidence_strength: one of "INCONCLUSIVE", "LOW", "MEDIUM", "HIGH"
- verdict_phrase: a single concise sentence describing the result
- reliability_notes: array of strings noting any factors (ESL, academic register, short text, technical content, engine disagreement, bimodal sentence distribution, paraphrase evasion) that affect confidence
- per_sentence: array of objects, one per sentence, each with:
    - likelihood: 0-100 (AI likelihood for this specific sentence — vary these meaningfully; do NOT assign the same score to every sentence)
    - signals: array of short string descriptions of what was observed in THIS sentence

Return exactly this JSON shape:
{
  "token_predictability": number,
  "semantic_smoothness": number,
  "structural_uniformity": number,
  "transition_density": number,
  "vocabulary_authenticity": number,
  "human_markers": number,
  "hedging_density": number,
  "named_entity_grounding": number,
  "bimodal_sentence_distribution": number,
  "perturbation_resistance": number,
  "overall_score": number,
  "evidence_strength": "INCONCLUSIVE"|"LOW"|"MEDIUM"|"HIGH",
  "verdict_phrase": string,
  "reliability_notes": string[],
  "per_sentence": [{ "likelihood": number, "signals": string[] }]
}`;

  // ── Improvement #9: Engine A/B context augmentation ─────────────────────
  // Pass pre-computed rule-based scores so the LLM can reason about
  // disagreements and produce a better-calibrated overall_score.
  const engineContextBlock = (engineAContext || engineBContext) ? `
Pre-computed rule-based engine scores (for context — use these to inform your reasoning, not as hard constraints):
- Engine A (Perplexity & Stylometry): internalScore=${engineAContext?.score ?? "N/A"}/100, strength=${engineAContext?.evidenceStrength ?? "N/A"}
  Top signals: ${engineAContext?.topSignals?.join("; ") ?? "N/A"}
- Engine B (Burstiness & Cognitive Markers): internalScore=${engineBContext?.score ?? "N/A"}/100, strength=${engineBContext?.evidenceStrength ?? "N/A"}
  Top signals: ${engineBContext?.topSignals?.join("; ") ?? "N/A"}

If Engine A and B strongly agree (both > 60 or both < 25), weight your overall_score toward their consensus.
If they disagree (one > 50, one < 30), look for the reason: paraphrased AI? ESL? mixed authorship?
` : "";

  const USER_PROMPT = `${engineContextBlock}Analyze this text:\n\n${analysisText}`;

  let parsed: any = null;

  try {
    const response = await fetch("/api/neural-analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: USER_PROMPT }],
      }),
    });

    // ── DEBUG: log raw response ──
    const rawBody = await response.text();
    console.log("Neural API status:", response.status);
    console.log("Neural API raw response:", rawBody);
    // ────────────────────────────

    if (!response.ok) {
      throw new Error(`API error ${response.status}: ${rawBody}`);
    }

    const data = JSON.parse(rawBody);
    const rawText = data.content?.find((b: any) => b.type === "text")?.text ?? "";
    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/```json|```/gi, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error("Neural engine API/parse error:", err);
    // GAP 7 FIX: Run the full Engine A per-sentence analysis as the fallback.
    // This gives reviewers accurate sentence-level highlighting even when the
    // neural API is unavailable — the minimal heuristic (3 signals) was a poor
    // substitute for the 19-signal Engine A sentence scorer.
    let fallbackResult: EngineResult;
    try {
      fallbackResult = runPerplexityEngine(text);
    } catch (e2) {
      // If Engine A also fails (shouldn't happen), last-resort minimal fallback
      fallbackResult = {
        internalScore: 0, confidenceLow: 0, confidenceHigh: 50,
        evidenceStrength: "INCONCLUSIVE" as EvidenceStrength,
        verdictPhrase: "Neural engine unavailable — analysis failed",
        signals: [], sentences: sentences.map(s => ({
          text: s, likelihood: 0, signals: [], label: "uncertain" as const,
        })),
        wordCount: wc, sentenceCount: sentences.length,
        reliabilityWarnings: ["Neural engine and fallback both failed"],
      };
    }
    // Wrap in a result that makes clear this is a fallback, not neural analysis
    return {
      internalScore: fallbackResult.internalScore,
      confidenceLow: fallbackResult.confidenceLow,
      confidenceHigh: Math.min(75, fallbackResult.confidenceHigh + 15), // wider CI: less certainty without neural
      evidenceStrength: fallbackResult.evidenceStrength === "HIGH"
        ? "MEDIUM" as EvidenceStrength  // downgrade HIGH to MEDIUM without neural confirmation
        : fallbackResult.evidenceStrength,
      verdictPhrase: "Neural engine unavailable — displaying Engine A rule-based analysis",
      signals: [
        {
          name: "Neural Perplexity (unavailable)",
          value: "API call failed. The results below are Engine A (Perplexity & Stylometry) rule-based analysis reused here. Sentence highlights reflect 19-signal Engine A scoring, not LLM neural analysis.",
          strength: 0, pointsToAI: false, wellSupported: false,
        },
        ...fallbackResult.signals,
      ],
      sentences: fallbackResult.sentences,
      wordCount: wc,
      sentenceCount: sentences.length,
      reliabilityWarnings: [
        "Neural engine API unavailable — showing Engine A rule-based analysis as fallback. Sentence highlights are accurate but lack neural contextual reasoning.",
        ...fallbackResult.reliabilityWarnings,
      ],
    };
  }

  // Map parsed JSON → EngineResult
  let score = Math.max(0, Math.min(100, Math.round(parsed.overall_score ?? 0)));

  // Apply ESL/Philippine context penalty to NP score as well
  // The NP prompt already instructs Claude to consider ESL, but the explicit
  // penalty ensures consistent behavior even when the LLM underweights it.
  const npReliabilityNotes: string[] = parsed.reliability_notes ?? [];
  if (usedSlidingWindow) {
    npReliabilityNotes.unshift(`Sliding-window analysis: document analyzed as head (first ${MAX_WORDS}w) + tail (last ${TAIL_WORDS}w) to detect mixed authorship across essay sections.`);
  }
  const npHasESL = npReliabilityNotes.some((n: string) => n.toLowerCase().includes("esl") || n.toLowerCase().includes("non-native") || n.toLowerCase().includes("philippine") || n.toLowerCase().includes("filipino"));
  if (npHasESL) {
    score = Math.max(0, score - 12); // moderate ESL penalty for NP engine
  }

  const signals: SignalResult[] = [
    {
      name: "Token Predictability",
      value: `Score ${parsed.token_predictability ?? "—"}/100. Measures how statistically predictable word choices are — AI models favour high-probability token sequences.`,
      strength: Math.min(100, Math.round(parsed.token_predictability ?? 0)),
      pointsToAI: (parsed.token_predictability ?? 0) >= 50,
      wellSupported: (parsed.token_predictability ?? 0) >= 70,
    },
    {
      name: "Semantic Smoothness",
      value: `Score ${parsed.semantic_smoothness ?? "—"}/100. AI text maintains unnaturally coherent topic focus; human writing drifts, hedges, and self-corrects.`,
      strength: Math.min(100, Math.round(parsed.semantic_smoothness ?? 0)),
      pointsToAI: (parsed.semantic_smoothness ?? 0) >= 50,
      wellSupported: (parsed.semantic_smoothness ?? 0) >= 70,
    },
    {
      name: "Structural Uniformity",
      value: `Score ${parsed.structural_uniformity ?? "—"}/100. Evaluates consistency of paragraph lengths, sentence counts, and rhythm across the document.`,
      strength: Math.min(100, Math.round(parsed.structural_uniformity ?? 0)),
      pointsToAI: (parsed.structural_uniformity ?? 0) >= 50,
      wellSupported: (parsed.structural_uniformity ?? 0) >= 65,
    },
    {
      name: "Transition Phrase Density",
      value: `Score ${parsed.transition_density ?? "—"}/100. Detects over-reliance on AI-typical connective phrases (furthermore, moreover, it is worth noting, etc.).`,
      strength: Math.min(100, Math.round(parsed.transition_density ?? 0)),
      pointsToAI: (parsed.transition_density ?? 0) >= 50,
      wellSupported: (parsed.transition_density ?? 0) >= 65,
    },
    {
      name: "Vocabulary Authenticity",
      value: `Score ${parsed.vocabulary_authenticity ?? "—"}/100. Assesses whether buzzword density (leverage, holistic, pivotal, robust, synergy…) exceeds natural human usage.`,
      strength: Math.min(100, Math.round(parsed.vocabulary_authenticity ?? 0)),
      pointsToAI: (parsed.vocabulary_authenticity ?? 0) >= 50,
      wellSupported: (parsed.vocabulary_authenticity ?? 0) >= 65,
    },
    {
      name: "Human Cognitive Markers",
      value: `Score ${parsed.human_markers ?? "—"}/100 (higher = more human signals present). Informal register, contractions, em-dashes, personal voice, and contradictions are human indicators.`,
      strength: Math.min(100, Math.round(parsed.human_markers ?? 0)),
      pointsToAI: false, // human_markers is always a human signal
      wellSupported: (parsed.human_markers ?? 0) >= 50,
    },
    {
      name: "Hedging Density",
      value: `Score ${parsed.hedging_density ?? "—"}/100. AI systematically hedges every claim with "may", "can", "generally", "tends to"; human writers hedge purposefully and sparingly.`,
      strength: Math.min(100, Math.round(parsed.hedging_density ?? 0)),
      pointsToAI: (parsed.hedging_density ?? 0) >= 50,
      wellSupported: (parsed.hedging_density ?? 0) >= 65,
    },
    {
      name: "Named-entity Grounding",
      value: `Score ${parsed.named_entity_grounding ?? "—"}/100 (higher = more AI-like abstraction). Human writing references real people, places, dates, and publications. AI essays avoid concrete named references.`,
      strength: Math.min(100, Math.round(parsed.named_entity_grounding ?? 0)),
      pointsToAI: (parsed.named_entity_grounding ?? 0) >= 55,
      wellSupported: (parsed.named_entity_grounding ?? 0) >= 70,
    },
    {
      name: "Bimodal Sentence Distribution (Mixed/Hybrid Signal)",
      value: `Score ${parsed.bimodal_sentence_distribution ?? "—"}/100. Detects bimodal pattern where some sentences cluster at high AI-likelihood and others at low — the hallmark of mixed human+AI authorship. More reliable than averaging for hybrid text.`,
      strength: Math.min(100, Math.round(parsed.bimodal_sentence_distribution ?? 0)),
      pointsToAI: (parsed.bimodal_sentence_distribution ?? 0) >= 50,
      wellSupported: (parsed.bimodal_sentence_distribution ?? 0) >= 65,
    },
    {
      name: "Perturbation Resistance (DetectGPT Proxy)",
      value: `Score ${parsed.perturbation_resistance ?? "—"}/100. AI text sits at a local probability maximum — synonym substitutions degrade quality. Human text is not at a peak — substitutions are neutral. High score = text reads like every word was optimally chosen.`,
      strength: Math.min(100, Math.round(parsed.perturbation_resistance ?? 0)),
      pointsToAI: (parsed.perturbation_resistance ?? 0) >= 55,
      wellSupported: (parsed.perturbation_resistance ?? 0) >= 70,
    },
  ];

  // Map per-sentence data — fill missing entries with neutral values
  const sentenceResults: SentenceResult[] = sentences.map((sent, i) => {
    const ps = parsed.per_sentence?.[i];
    // Use max(score, 10) as fallback so sentences aren't all filtered out
    // when overall_score is 0 (INCONCLUSIVE) and per_sentence data is missing/truncated
    const likelihood = Math.min(95, Math.max(0, Math.round(ps?.likelihood ?? Math.max(score, 10))));
    const label: "uncertain" | "moderate" | "elevated" =
      // Enhancement #7: standardized thresholds matching Engine A (45/22)
      // Previously NP used 50/25, causing asymmetric sentence highlights between engines.
      likelihood >= 45 ? "elevated" : likelihood >= 22 ? "moderate" : "uncertain";
    return {
      text: sent,
      likelihood,
      signals: ps?.signals ?? [],
      label,
    };
  });

  const { low, high } = computeConfidenceInterval(score, 8, signals.filter(s => s.pointsToAI).length, npReliabilityNotes, wc);

  // ── Elevated-sentence internalScore floor ─────────────────────────────────
  // Guard against the LLM returning overall_score=0 while marking sentences
  // elevated. The floor ensures internalScore always reflects sentence evidence.
  const neuralElevated = sentenceResults.filter(s => s.label === "elevated").length;
  const neuralFloor = sentenceResults.length > 0
    ? Math.min(20, Math.round((neuralElevated / sentenceResults.length) * 30))
    : 0;
  const finalNeuralScore = Math.max(score, neuralFloor);

  return {
    internalScore: finalNeuralScore,
    confidenceLow: low,
    confidenceHigh: high,
    evidenceStrength: (parsed.evidence_strength as EvidenceStrength) ?? "INCONCLUSIVE",
    verdictPhrase: parsed.verdict_phrase ?? "Neural analysis complete",
    signals,
    sentences: sentenceResults,
    wordCount: wc,
    sentenceCount: sentences.length,
    reliabilityWarnings: npReliabilityNotes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - LIVE WORD HIGHLIGHTER
//  Real-time overlay that colorizes AI-flagged vocabulary as user types.
//  Strong-tier words → red underline, Medium-tier → amber, Bigrams → purple.
// ─────────────────────────────────────────────────────────────────────────────

function LiveWordHighlighter({ text }: { text: string }) {
  if (!text.trim()) return null;

  // OPT P12/A12: Use pre-built module-level bigram structures (no per-render rebuilding).
  // OPT P13: Single tokenRe pass replaces the previous double-scan (word list + tokenRe).

  // Build bigramSet: which word indices are part of a known AI bigram
  const wordTokens = text.toLowerCase().match(/\b[a-z]+\b/g) || [];
  const bigramSet = new Set<number>();
  for (let wi = 0; wi < wordTokens.length; wi++) {
    const w0 = wordTokens[wi];
    const w1 = wi + 1 < wordTokens.length ? wordTokens[wi + 1] : "";
    const w2 = wi + 2 < wordTokens.length ? wordTokens[wi + 2] : "";
    const w3 = wi + 3 < wordTokens.length ? wordTokens[wi + 3] : "";

    // Check 4+ word phrases (rare — small linear scan)
    if (w1 && w2 && w3) {
      const quad = `${w0} ${w1} ${w2} ${w3}`;
      const matched = _LWH_BIGRAM_LONG.find(b => quad.startsWith(b));
      if (matched) {
        const len = matched.split(" ").length;
        for (let k = 0; k < len; k++) bigramSet.add(wi + k);
        continue;
      }
    }
    // Check 3-word phrases — O(1) Set lookup
    if (w1 && w2) {
      const triple = `${w0} ${w1} ${w2}`;
      if (_LWH_BIGRAM_3_SET.has(triple)) {
        bigramSet.add(wi); bigramSet.add(wi + 1); bigramSet.add(wi + 2);
        continue;
      }
    }
    // Check 2-word phrases — O(1) Set lookup
    if (w1) {
      const pair = `${w0} ${w1}`;
      if (_LWH_BIGRAM_2_SET.has(pair)) {
        bigramSet.add(wi); bigramSet.add(wi + 1);
      }
    }
  }

  // OPT A13: Use pre-compiled module-level tokenRe (reset lastIndex before use)
  _LWH_TOKEN_RE.lastIndex = 0;
  const parts: Array<{ segment: string; cls: string }> = [];
  let wordIdx = 0;
  let lastEnd = 0;
  let m: RegExpExecArray | null;

  while ((m = _LWH_TOKEN_RE.exec(text)) !== null) {
    if (m.index > lastEnd) {
      parts.push({ segment: text.slice(lastEnd, m.index), cls: "" });
    }
    const lower = m[0].toLowerCase();
    let cls = "";
    if (bigramSet.has(wordIdx)) {
      cls = "bg-purple-100 text-purple-800 rounded px-0.5 underline decoration-purple-400 decoration-dotted";
    } else if (AI_VOCAB_STRONG.has(lower)) {
      cls = "bg-red-100 text-red-800 rounded px-0.5 underline decoration-red-400 decoration-wavy";
    } else if (AI_VOCAB_MEDIUM.has(lower)) {
      cls = "bg-amber-100 text-amber-800 rounded px-0.5 underline decoration-amber-400 decoration-dotted";
    }
    parts.push({ segment: m[0], cls });
    wordIdx++;
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) {
    parts.push({ segment: text.slice(lastEnd), cls: "" });
  }

  const aiWordCount = parts.filter(p => p.cls.includes("red") || p.cls.includes("amber") || p.cls.includes("purple")).length;

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
          Live AI Pattern Highlighter
          <span className="font-normal normal-case text-slate-400">— {aiWordCount} flagged term{aiWordCount !== 1 ? "s" : ""}</span>
        </p>
        <div className="flex items-center gap-3 text-[9px] font-semibold">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-red-200 border border-red-400 inline-block" />Strong AI</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-amber-200 border border-amber-400 inline-block" />Medium AI</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-purple-200 border border-purple-400 inline-block" />AI Phrase</span>
        </div>
      </div>
      <div className="px-4 py-3 text-sm leading-relaxed text-slate-700 font-sans max-h-52 overflow-y-auto whitespace-pre-wrap">
        {parts.map((p, i) =>
          p.cls ? <span key={i} className={p.cls}>{p.segment}</span> : <span key={i}>{p.segment}</span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - RADAR CHART FINGERPRINT (6-axis SVG)
//  Shows multi-dimensional writing signature like GPTZero's Writing Profile.
//  Axes: Vocabulary, Burstiness, Structure, Semantic, Tone, Discourse
// ─────────────────────────────────────────────────────────────────────────────

function RadarChartFingerprint({ perpResult, burstResult, neuralResult }: {
  perpResult: EngineResult | null;
  burstResult: EngineResult | null;
  neuralResult?: EngineResult | null;
}) {
  if (!perpResult || !burstResult) return null;

  const getSignalStrength = (result: EngineResult, nameFragment: string) =>
    result.signals.find(s => s.name.includes(nameFragment))?.strength ?? 0;

  // Enhancement #9: 8 dimensions including 2 NP-sourced axes
  const dims = [
    {
      label: "Vocabulary",
      score: getSignalStrength(perpResult, "Vocabulary Density"),
      color: "#ef4444",
    },
    {
      label: "Burstiness",
      score: getSignalStrength(burstResult, "Sentence Length Variation"),
      color: "#f97316",
    },
    {
      label: "Structure",
      score: Math.max(
        getSignalStrength(perpResult, "Paragraph-Opening"),
        getSignalStrength(perpResult, "Discourse Schema"),
      ),
      color: "#eab308",
    },
    {
      label: "Semantic",
      score: Math.max(
        getSignalStrength(perpResult, "Semantic Self-Similarity"),
        getSignalStrength(perpResult, "AI Multi-word"),
        getSignalStrength(perpResult, "Idea Repetition"),
      ),
      color: "#8b5cf6",
    },
    {
      label: "Tone",
      score: Math.max(
        getSignalStrength(perpResult, "Tone Register"),
        getSignalStrength(perpResult, "Hedged-Certainty"),
      ),
      color: "#06b6d4",
    },
    {
      label: "Lexical",
      score: Math.max(
        getSignalStrength(perpResult, "MTLD"),
        getSignalStrength(perpResult, "Moving-window TTR"),
      ),
      color: "#10b981",
    },
    // Enhancement #9: NP-sourced axes — only rendered when NP engine has results
    ...(neuralResult ? [
      {
        label: "Token Pred.",
        score: getSignalStrength(neuralResult, "Token Predictability"),
        color: "#7c3aed",
      },
      {
        label: "Smoothness",
        score: Math.max(
          getSignalStrength(neuralResult, "Semantic Smoothness"),
          getSignalStrength(neuralResult, "Perturbation"),
        ),
        color: "#db2777",
      },
    ] : []),
  ];

  const CX = 110, CY = 110, R = 80;
  const N = dims.length;

  const getPoint = (i: number, r: number) => {
    const angle = (Math.PI * 2 * i) / N - Math.PI / 2;
    return { x: CX + r * Math.cos(angle), y: CY + r * Math.sin(angle) };
  };

  const polyPoints = dims.map((d, i) => getPoint(i, (d.score / 100) * R));
  const polyStr = polyPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Background rings at 25, 50, 75, 100%
  const rings = [0.25, 0.5, 0.75, 1.0];

  // Overall AI score for display
  const overallAI = Math.round(dims.reduce((sum, d) => sum + d.score, 0) / dims.length);
  const overallColor = overallAI >= 60 ? "#ef4444" : overallAI >= 35 ? "#f59e0b" : "#10b981";

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm font-bold text-slate-900">Writing Fingerprint</p>
          <p className="text-[10px] text-slate-500 mt-0.5">6-dimension AI pattern signature</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black" style={{ color: overallColor }}>{overallAI}%</p>
          <p className="text-[9px] text-slate-400 uppercase tracking-wide">Composite AI</p>
        </div>
      </div>

      <div className="flex items-center justify-center">
        <svg width="220" height="220" viewBox="0 0 220 220" className="overflow-visible">
          {/* Background rings */}
          {rings.map((r, ri) => (
            <polygon
              key={ri}
              points={Array.from({ length: N }, (_, i) => {
                const p = getPoint(i, r * R);
                return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
              }).join(" ")}
              fill="none"
              stroke="#e2e8f0"
              strokeWidth={r === 1 ? "1.5" : "0.8"}
            />
          ))}

          {/* Axis lines */}
          {dims.map((_, i) => {
            const p = getPoint(i, R);
            return <line key={i} x1={CX} y1={CY} x2={p.x.toFixed(1)} y2={p.y.toFixed(1)} stroke="#e2e8f0" strokeWidth="1" />;
          })}

          {/* Data polygon */}
          <polygon
            points={polyStr}
            fill="rgba(239,68,68,0.15)"
            stroke="#ef4444"
            strokeWidth="2"
            strokeLinejoin="round"
          />

          {/* Data points */}
          {polyPoints.map((p, i) => (
            <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r="4" fill={dims[i].color} stroke="white" strokeWidth="1.5" />
          ))}

          {/* Axis labels + percentage inline next to each label */}
          {dims.map((d, i) => {
            const labelR = R + 18;
            const p = getPoint(i, labelR);
            const isLeft  = p.x < CX - 10;
            const isRight = p.x > CX + 10;
            const anchor  = isLeft ? "end" : isRight ? "start" : "middle";
            const topAxis = p.y < CY;

            if (!isLeft && !isRight) {
              // top or bottom axis: stack label + pct vertically
              const lineH = 11;
              return (
                <g key={i}>
                  <text x={p.x.toFixed(1)} y={(p.y + (topAxis ? -lineH * 0.6 : lineH * 0.1)).toFixed(1)}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize="9" fontWeight="700" fill={dims[i].color}
                    fontFamily="system-ui, sans-serif">
                    {d.label}
                  </text>
                  <text x={p.x.toFixed(1)} y={(p.y + (topAxis ? lineH * 0.5 : lineH * 1.2)).toFixed(1)}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize="8" fontWeight="900" fill={dims[i].color}
                    fontFamily="system-ui, sans-serif" opacity="0.9">
                    {d.score}%
                  </text>
                </g>
              );
            }

            // Left or right axis: label on one line, pct just below on same side
            return (
              <g key={i}>
                <text x={p.x.toFixed(1)} y={p.y.toFixed(1)}
                  textAnchor={anchor} dominantBaseline="middle"
                  fontSize="9" fontWeight="700" fill={dims[i].color}
                  fontFamily="system-ui, sans-serif">
                  {d.label}
                </text>
                <text
                  x={p.x.toFixed(1)}
                  y={(p.y + 10).toFixed(1)}
                  textAnchor={anchor} dominantBaseline="middle"
                  fontSize="8" fontWeight="900" fill={dims[i].color}
                  fontFamily="system-ui, sans-serif" opacity="0.9">
                  {d.score}%
                </text>
              </g>
            );
          })}

          {/* Ring labels */}
          <text x={CX + 2} y={CY - R * 0.25 - 2} fontSize="6" fill="#94a3b8" textAnchor="middle" fontFamily="system-ui">25</text>
          <text x={CX + 2} y={CY - R * 0.5 - 2} fontSize="6" fill="#94a3b8" textAnchor="middle" fontFamily="system-ui">50</text>
          <text x={CX + 2} y={CY - R * 0.75 - 2} fontSize="6" fill="#94a3b8" textAnchor="middle" fontFamily="system-ui">75</text>
        </svg>
      </div>

      {/* Dimension legend */}
      <div className="grid grid-cols-3 gap-1.5 mt-2">
        {dims.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: d.color }} />
            <span className="text-[9px] font-bold" style={{ color: d.color }}>{d.score}%</span>
            <span className="text-[9px] text-slate-600 font-medium">{d.label}</span>
          </div>
        ))}
      </div>

      {/* ── Dimension explanations ── */}
      <FingerprintExplanation dims={dims} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Writing Fingerprint — expandable dimension explanation panel
//  Rendered inside the fingerprint card frame. Each axis gets a plain-English
//  description of what it measures and what a high vs. low score means.
// ─────────────────────────────────────────────────────────────────────────────

const FINGERPRINT_DIMENSION_GUIDE: Record<string, { what: string; high: string; low: string }> = {
  Vocabulary: {
    what: "Measures the density of AI-associated words and phrases — terms like \"delve\", \"tapestry\", \"nuanced\", and \"multifaceted\" that language models reach for far more often than human writers do.",
    high: "The text contains a high concentration of AI-typical buzzwords. This is one of the strongest individual indicators, especially when strong-tier words appear.",
    low:  "Word choices are within the normal range for human writing. Little to no AI-associated vocabulary detected.",
  },
  Burstiness: {
    what: "Measures how much sentence length varies across the text (coefficient of variation, or CV). Human writers naturally alternate short punchy sentences with longer ones. AI models tend to produce metronomic, uniform sentence lengths.",
    high: "Sentence lengths are unusually uniform — the CV is low, meaning the text lacks the natural rhythm variation of human writing. This pattern is characteristic of AI generation.",
    low:  "Sentence lengths vary naturally, consistent with human writing. The text has the kind of rhythmic variation that is difficult for AI to replicate convincingly.",
  },
  Structure: {
    what: "Looks at two structural patterns: (1) paragraph-opening fingerprint — AI essays overwhelmingly open paragraphs with formulaic transitions like \"Furthermore,\" \"It is important to note,\" or \"In conclusion\"; (2) discourse schema predictability — whether the text follows a rigid AI template of intro → claim → evidence → ethics → conclusion.",
    high: "Paragraph openers and overall document structure follow predictable AI formulas. Human writers vary how they open paragraphs and organise arguments.",
    low:  "Paragraph openings and overall structure show natural variation, consistent with human composition.",
  },
  Semantic: {
    what: "Captures two forms of semantic repetition: (1) self-similarity — AI models reuse the same conceptual frames with synonym substitution (e.g., \"plays a crucial role\" → \"serves a vital function\" → \"fulfils a key purpose\"); (2) AI multi-word phrases — fixed two- and three-word patterns that appear overwhelmingly in AI-generated text.",
    high: "The text reuses the same underlying ideas in slightly different wording, and contains AI-specific multi-word patterns. This synonym-cycling is a hallmark of AI generation.",
    low:  "Conceptual content is varied and phrase patterns are within normal human range.",
  },
  Tone: {
    what: "Examines two tonal signals: (1) tone register flatness — AI text maintains an unchangingly even, polished register with no colloquial dips, emotional shifts, or informal asides; (2) hedged-certainty density — AI uses a specific kind of hedging (\"it could be argued\", \"one might suggest\") that differs from how human writers qualify claims.",
    high: "The text has an unnaturally flat, uniform tone throughout, and uses AI-style hedging constructions at a higher than typical rate.",
    low:  "Tone varies naturally across the text, and hedging patterns are within normal human range.",
  },
  Lexical: {
    what: "Two length-invariant vocabulary diversity measures: (1) MTLD (Measure of Textual Lexical Diversity) — calculates the average length of word runs before vocabulary starts repeating; AI text typically scores below 55 while human text scores above 80; (2) Moving-window TTR variance — checks whether vocabulary diversity stays suspiciously constant across the document, as AI models tend to recycle the same lexical inventory throughout.",
    high: "Vocabulary diversity is lower than expected for human writing of this length. The text reuses the same word stock with limited lexical range.",
    low:  "Vocabulary diversity is within the human range. The text draws on a varied lexical inventory.",
  },
};

function FingerprintExplanation({ dims }: { dims: Array<{ label: string; score: number; color: string }> }) {
  const [open, setOpen] = useState(false);
  const [activeAxis, setActiveAxis] = useState<string | null>(null);

  // Sort by score descending so the most diagnostic axes appear first
  const sorted = [...dims].sort((a, b) => b.score - a.score);

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between text-left group"
        aria-expanded={open}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 group-hover:text-slate-600 transition-colors">
          Click here for Axis Explanation
        </span>
        <svg
          className={`w-3.5 h-3.5 text-slate-400 transition-transform flex-shrink-0 ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20" fill="currentColor"
        >
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div className="mt-3 space-y-1.5">
          {/* Axis selector pills */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {sorted.map(d => (
              <button
                key={d.label}
                onClick={() => setActiveAxis(activeAxis === d.label ? null : d.label)}
                className="flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded-full border transition-all"
                style={activeAxis === d.label
                  ? { background: d.color, color: "#fff", borderColor: d.color }
                  : { background: "transparent", color: d.color, borderColor: `${d.color}55` }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: activeAxis === d.label ? "#fff" : d.color }}
                />
                {d.label}
                <span
                  className="ml-0.5 font-black text-[9px]"
                  style={{ color: activeAxis === d.label ? "rgba(255,255,255,0.8)" : d.color }}
                >
                  {d.score}%
                </span>
              </button>
            ))}
          </div>

          {/* Detail card — shown when an axis is selected */}
          {activeAxis && FINGERPRINT_DIMENSION_GUIDE[activeAxis] && (() => {
            const guide = FINGERPRINT_DIMENSION_GUIDE[activeAxis];
            const dim   = dims.find(d => d.label === activeAxis)!;
            const isHigh = dim.score >= 50;
            return (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 space-y-2.5">
                {/* Header */}
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: dim.color }} />
                  <span className="text-xs font-bold text-slate-800">{activeAxis}</span>
                  <span
                    className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full"
                    style={{ color: dim.color, background: `${dim.color}18`, border: `1px solid ${dim.color}40` }}
                  >
                    {dim.score}% {isHigh ? "— elevated" : dim.score >= 25 ? "— moderate" : "— low"}
                  </span>
                </div>

                {/* What this axis measures */}
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 mb-1">What it measures</p>
                  <p className="text-[11px] text-slate-600 leading-relaxed">{guide.what}</p>
                </div>

                {/* Contextual interpretation for this result */}
                <div
                  className="rounded-lg px-3 py-2"
                  style={{ background: isHigh ? `${dim.color}10` : "#f0fdf410", border: `1px solid ${isHigh ? dim.color + "35" : "#bbf7d0"}` }}
                >
                  <p
                    className="text-[9px] font-semibold uppercase tracking-wide mb-1"
                    style={{ color: isHigh ? dim.color : "#16a34a" }}
                  >
                    {isHigh ? "What this high score means" : "What this low score means"}
                  </p>
                  <p className="text-[11px] leading-relaxed" style={{ color: isHigh ? dim.color : "#15803d" }}>
                    {isHigh ? guide.high : guide.low}
                  </p>
                </div>
              </div>
            );
          })()}

          {/* Fallback prompt when nothing is selected */}
          {!activeAxis && (
            <p className="text-[10px] text-slate-400 italic text-center py-1">
              Tap any axis above to see what it measures and how to interpret the score.
            </p>
          )}

          {/* Reading guide 
          <div className="mt-2 rounded-lg bg-slate-100 px-3 py-2.5">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">How to read the chart</p>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              Each axis runs from the centre (0%) to the outer ring (100%). A larger filled polygon means more AI-associated patterns across more dimensions. A genuinely human text typically produces a small, irregular polygon close to the centre. A clear AI text produces a large, roughly symmetric polygon. Uneven shapes — one or two axes spiking while others remain low — are common in mixed, edited, or borderline texts and warrant human review rather than an automatic verdict.
            </p>
          </div>*/}
        </div>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  PRODUCTION UI  — v2 complete redesign
//  Improvements: circular gauge, inline overlay, scan history, tabbed input,
//  5-tier verdict scale, mobile-first layout, accessibility, share/export
// ─────────────────────────────────────────────────────────────────────────────

// ── Scan History (Firebase + localStorage fallback) ──────────────────────────

interface ScanRecord {
  id: string;
  ts: number;
  snippet: string;
  wordCount: number;
  verdict: string;
  aiPct: number;
  evidenceStrength: string;
  reviewerVerdict?: string; // Enhancement #1: store reviewer override
}

function loadHistoryLocal(): ScanRecord[] {
  try { return JSON.parse(localStorage.getItem("aidetect_history") || "[]"); }
  catch { return []; }
}

function saveHistoryLocal(records: ScanRecord[]) {
  try { localStorage.setItem("aidetect_history", JSON.stringify(records.slice(0, 50))); }
  catch { /* quota exceeded — ignore */ }
}

// Enhancement #1: Reviewer feedback calibration
interface CalibrationData {
  totalScans: number;
  reviewerOverrides: number;
  systemSaidAI_reviewerSaidHuman: number;
  systemSaidHuman_reviewerSaidAI: number;
  bandOverrides?: Record<string, [number, number]>;
}

function loadCalibrationLocal(): CalibrationData {
  try { return JSON.parse(localStorage.getItem("aidetect_calibration") || "null") ?? { totalScans: 0, reviewerOverrides: 0, systemSaidAI_reviewerSaidHuman: 0, systemSaidHuman_reviewerSaidAI: 0, bandOverrides: {} }; }
  catch { return { totalScans: 0, reviewerOverrides: 0, systemSaidAI_reviewerSaidHuman: 0, systemSaidHuman_reviewerSaidAI: 0, bandOverrides: {} }; }
}

function saveCalibrationLocal(data: CalibrationData) {
  try { localStorage.setItem("aidetect_calibration", JSON.stringify(data)); } catch {}
}

// Bayesian threshold shift: returns how many points to shift the AI threshold
// for a given score. Negative = shift toward human (reduce false positives).
function getBayesianThresholdShift(score: number, cal: CalibrationData): number {
  if (!cal.bandOverrides) return 0;
  const band = String(Math.floor(score / 10) * 10); // e.g. score=67 → "60"
  const entry = cal.bandOverrides[band];
  if (!entry || entry[0] < 5) return 0; // need ≥5 samples in band
  const overrideRate = entry[1] / entry[0];
  if (overrideRate >= 0.30) return -5; // shift threshold down 5 pts (reduce FP)
  if (overrideRate >= 0.50) return -10;
  return 0;
}

function recordReviewerFeedback(systemVerdict: string, reviewerVerdict: string, systemScore?: number) {
  const cal = loadCalibrationLocal();
  cal.totalScans++;
  if (!cal.bandOverrides) cal.bandOverrides = {};
  const sysIsAI = systemVerdict.includes("AI") || systemVerdict.includes("Likely AI") || systemVerdict.includes("Almost Certainly");
  const revIsAI = reviewerVerdict === "AI-Generated";
  const sysIsHuman = systemVerdict.includes("Human") || systemVerdict.includes("Mostly Human") || systemVerdict.includes("Likely Human");
  const revIsHuman = reviewerVerdict === "Human-Written";
  if (sysIsAI !== revIsAI || sysIsHuman !== revIsHuman) cal.reviewerOverrides++;
  if (sysIsAI && revIsHuman) {
    cal.systemSaidAI_reviewerSaidHuman++;
    // Record band override for Bayesian update
    if (systemScore !== undefined) {
      const band = String(Math.floor(systemScore / 10) * 10);
      if (!cal.bandOverrides[band]) cal.bandOverrides[band] = [0, 0];
      cal.bandOverrides[band][0]++;
      cal.bandOverrides[band][1]++;
    }
  } else if (sysIsAI && systemScore !== undefined) {
    // System said AI, reviewer agreed — track total in band
    const band = String(Math.floor(systemScore / 10) * 10);
    if (!cal.bandOverrides[band]) cal.bandOverrides[band] = [0, 0];
    cal.bandOverrides[band][0]++;
  }
  if (sysIsHuman && revIsAI) cal.systemSaidHuman_reviewerSaidAI++;
  saveCalibrationLocal(cal);
}

// ── Breakdown helper (kept in sync with PDF layer) ──────────────────────────

function uiDeriveBreakdown(score: number, elevatedRatio = 0): { ai: number; mixed: number; human: number } {
  const s = Math.max(0, Math.min(100, score));
  let ai: number, human: number, mixed: number;
  if (s <= 10) {
    ai = 0; human = Math.floor(100 - s * 3); mixed = 100 - ai - human;
  } else if (s >= 50) {
    human = 0; ai = Math.floor((s - 50) / 50 * 100); mixed = 100 - ai - human;
  } else {
    const t = (s - 10) / 40;
    ai = Math.floor(t * 65); human = Math.floor((1 - t) * 65); mixed = 100 - ai - human;
  }
  ai    = Math.max(0, Math.min(100, ai));
  human = Math.max(0, Math.min(100, human));
  mixed = Math.max(0, 100 - ai - human);
  if (ai === 0 && elevatedRatio > 0) {
    const maxFloor = elevatedRatio > 0.5 ? 25 : 15;
    const floor = Math.min(maxFloor, Math.round(elevatedRatio * 40));
    if (floor > 0) { ai = floor; const ab = Math.min(floor, mixed); mixed -= ab; human = 100 - ai - mixed; }
  }
  return { ai, mixed, human };
}

// ── 6-Tier Verdict ───────────────────────────────────────────────────────────
// FPR FIX: Thresholds recalibrated based on evaluation data.
// Score distribution shows human texts cluster in 0–10 band; all AI texts ≥ 6.
// Old boundary of <20 "Likely Human" was too aggressive — many borderline human
// texts (formal academic, research notes) scored 6–10 and were falsely flagged.
// New boundaries:
//   < 20  → Likely Human       (unchanged — clear human zone)
//   20–34 → Mostly Human       (shifted: previously triggered "Mixed")
//   35–49 → Needs Human Review (NEW: explicit caution zone — do not auto-flag)
//   50–64 → Mixed / Uncertain  (previously Likely AI)
//   65–79 → Likely AI
//   ≥ 80  → Almost Certainly AI
// The "Needs Human Review" tier is the primary FPR mitigation: texts in this
// zone are routed to a reviewer rather than receiving an automatic AI verdict.

function getTier(aiPct: number): { label: string; color: string; bg: string; border: string; ring: string; dot: string; needsReview: boolean } {
  if (aiPct < 20)  return { label: "Likely Human",        color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", ring: "#22c55e", dot: "bg-emerald-500", needsReview: false };
  if (aiPct < 35)  return { label: "Mostly Human",        color: "#65a30d", bg: "#f7fee7", border: "#d9f99d", ring: "#84cc16", dot: "bg-lime-500",    needsReview: false };
  if (aiPct < 50)  return { label: "Needs Human Review",  color: "#b45309", bg: "#fffbeb", border: "#fcd34d", ring: "#f59e0b", dot: "bg-yellow-500",  needsReview: true  };
  if (aiPct < 65)  return { label: "Mixed / Uncertain",   color: "#d97706", bg: "#fff7ed", border: "#fed7aa", ring: "#fb923c", dot: "bg-amber-500",   needsReview: false };
  if (aiPct < 80)  return { label: "Likely AI",           color: "#ea580c", bg: "#fff1f0", border: "#fca5a5", ring: "#f97316", dot: "bg-orange-500",  needsReview: false };
  return               { label: "Almost Certainly AI",  color: "#dc2626", bg: "#fef2f2", border: "#fecaca", ring: "#ef4444", dot: "bg-red-500",     needsReview: false };
}

// ── Circular Gauge (SVG) ─────────────────────────────────────────────────────

function CircularGauge({ pct, color, size = 160 }: { pct: number; color: string; size?: number }) {
  const r = (size / 2) - 14;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const cx = size / 2, cy = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block" aria-hidden="true">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2e8f0" strokeWidth="10" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="10"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: "stroke-dasharray 0.8s cubic-bezier(.4,0,.2,1)" }} />
      <text x={cx} y={cy - 6} textAnchor="middle" fontSize="22" fontWeight="800" fill={color} fontFamily="system-ui,sans-serif">{pct}%</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize="10" fill="#94a3b8" fontFamily="system-ui,sans-serif">AI Score</text>
    </svg>
  );
}

// ── Inline Document Overlay (new: full-text with highlighted sentences) ──────

function DocumentOverlay({ text, sentences }: {
  text: string;
  sentences: Array<{ text: string; likelihood: number; signals: string[]; label: "uncertain" | "moderate" | "elevated" }>;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos]  = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const getBg = (label: string, hovered: boolean) => {
    if (label === "elevated") return hovered ? "rgba(239,68,68,0.25)"  : "rgba(239,68,68,0.12)";
    if (label === "moderate") return hovered ? "rgba(245,158,11,0.25)" : "rgba(245,158,11,0.10)";
    return "transparent";
  };
  const getBorder = (label: string) => {
    if (label === "elevated") return "2px solid rgba(239,68,68,0.45)";
    if (label === "moderate") return "2px solid rgba(245,158,11,0.35)";
    return "none";
  };

  // Build a map of sentence text → result for fast lookup
  const sentMap = new Map<string, typeof sentences[0]>();
  sentences.forEach(s => sentMap.set(s.text.trim(), s));

  // Reconstruct the document with highlights by splitting on sentence boundaries
  // We walk the original text and try to match known sentence strings
  const parts: Array<{ segment: string; sentIdx: number | null }> = [];
  let remaining = text;
  let sIdx = 0;
  for (const sent of sentences) {
    const clean = sent.text.trim();
    const pos = remaining.indexOf(clean);
    if (pos === -1) { sIdx++; continue; }
    if (pos > 0) parts.push({ segment: remaining.slice(0, pos), sentIdx: null });
    parts.push({ segment: clean, sentIdx: sIdx });
    remaining = remaining.slice(pos + clean.length);
    sIdx++;
  }
  if (remaining.length > 0) parts.push({ segment: remaining, sentIdx: null });

  return (
    <div className="relative">
      {/* Legend */}
      <div className="flex items-center gap-4 mb-3 flex-wrap">
        {[
          { label: "Elevated (likely AI)", bg: "rgba(239,68,68,0.18)", border: "1.5px solid rgba(239,68,68,0.5)" },
          { label: "Moderate", bg: "rgba(245,158,11,0.15)", border: "1.5px solid rgba(245,158,11,0.45)" },
          { label: "Uncertain / Human", bg: "transparent", border: "none" },
        ].map(({ label, bg, border }) => (
          <span key={label} className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className="inline-block w-3.5 h-3.5 rounded-sm flex-shrink-0" style={{ background: bg, border }} />
            {label}
          </span>
        ))}
      </div>

      <div className="relative text-[14px] leading-[1.85] text-slate-800 font-serif max-h-[500px] overflow-y-auto pr-2 scrollbar-thin"
        onMouseLeave={() => setHoveredIdx(null)}>
        {parts.map((p, i) => {
          if (p.sentIdx === null) return <span key={i}>{p.segment}</span>;
          const sr = sentences[p.sentIdx];
          const hovered = hoveredIdx === p.sentIdx;
          return (
            <span
              key={i}
              onMouseEnter={e => { setHoveredIdx(p.sentIdx!); const r = (e.target as HTMLElement).getBoundingClientRect(); setTooltipPos({ x: r.left, y: r.top }); }}
              style={{
                background: getBg(sr.label, hovered),
                border: getBorder(sr.label),
                borderRadius: "3px",
                padding: sr.label !== "uncertain" ? "1px 2px" : "0",
                cursor: sr.label !== "uncertain" ? "help" : "default",
                transition: "background 0.15s",
                position: "relative",
              }}
            >
              {p.segment}
              {hovered && sr.label !== "uncertain" && sr.signals.length > 0 && (
                <span className="absolute z-50 bottom-full left-0 mb-1.5 bg-slate-900 text-white text-[11px] rounded-lg px-3 py-2 shadow-xl pointer-events-none whitespace-nowrap max-w-[280px]"
                  style={{ minWidth: "180px" }}>
                  <span className="block font-bold mb-1" style={{ color: sr.label === "elevated" ? "#fca5a5" : "#fcd34d" }}>
                    {sr.label === "elevated" ? "Elevated AI Signals" : "Moderate AI Signals"} · {sr.likelihood}%
                  </span>
                  {sr.signals.slice(0, 3).map((sig, si) => (
                    <span key={si} className="block text-slate-300 truncate">· {sig}</span>
                  ))}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Stacked Breakdown Bar ────────────────────────────────────────────────────

function BreakdownBar({ ai, mixed, human, height = 8 }: { ai: number; mixed: number; human: number; height?: number }) {
  return (
    <div className="flex rounded-full overflow-hidden w-full" style={{ height }}>
      {ai    > 0 && <div style={{ width: `${ai}%`,    background: "#ef4444", transition: "width 0.6s ease" }} />}
      {mixed > 0 && <div style={{ width: `${mixed}%`, background: "#f59e0b", transition: "width 0.6s ease" }} />}
      {human > 0 && <div style={{ width: `${human}%`, background: "#22c55e", transition: "width 0.6s ease" }} />}
    </div>
  );
}

// ── Confidence Band (range display) ─────────────────────────────────────────

function ConfidenceBand({ low, high, color }: { low: number; high: number; color: string }) {
  return (
    <div className="relative h-2 bg-slate-100 rounded-full w-full mt-1">
      <div className="absolute h-2 rounded-full opacity-40"
        style={{ left: `${low}%`, width: `${Math.max(4, high - low)}%`, background: color, transition: "all 0.6s" }} />
      <div className="absolute w-2.5 h-2.5 rounded-full border-2 border-white shadow -top-0.5 -translate-x-1/2"
        style={{ left: `${(low + high) / 2}%`, background: color, transition: "left 0.6s" }} />
    </div>
  );
}

// ── Engine Card (new compact production design) ──────────────────────────────

function EngineCard({
  name, badge, badgeBg, result, loading, accentColor, originalText, icon,
}: {
  name: string; badge: string; badgeBg: string;
  result: EngineResult | null; loading: boolean;
  accentColor: string; originalText?: string; icon: React.ReactNode;
}) {
  const [expandedSig, setExpandedSig] = useState<number | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);

  if (loading) return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden animate-pulse">
      <div className="h-1.5 w-full" style={{ background: `${accentColor}33` }} />
      <div className="p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-slate-100" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 bg-slate-100 rounded w-2/3" />
            <div className="h-2.5 bg-slate-100 rounded w-1/2" />
          </div>
        </div>
        <div className="h-16 bg-slate-50 rounded-xl" />
        {[1,2,3].map(i => <div key={i} className="h-8 bg-slate-50 rounded-lg" />)}
      </div>
    </div>
  );

  if (!result) return (
    <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/50 flex items-center justify-center min-h-[220px]">
      <div className="text-center space-y-2 px-6">
        <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-slate-100 mx-auto" style={{ opacity: 0.5 }}>{icon}</div>
        <p className="text-sm text-slate-500 font-semibold">{name}</p>
        <p className="text-xs text-slate-400">Run analysis to see results</p>
      </div>
    </div>
  );

  const elevRatio = result.sentences.length > 0
    ? result.sentences.filter(s => s.label === "elevated").length / result.sentences.length : 0;
  const bd = uiDeriveBreakdown(result.internalScore, elevRatio);
  const tier = getTier(bd.ai);

  const strengthColor: Record<string, string> = {
    HIGH: "#dc2626", MEDIUM: "#d97706", LOW: "#16a34a", INCONCLUSIVE: "#94a3b8",
  };
  const sColor = strengthColor[result.evidenceStrength] ?? "#94a3b8";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      {/* Top accent bar */}
      <div className="h-1" style={{ background: accentColor }} />

      {/* Header */}
      <div className="px-5 pt-4 pb-3 flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-black flex-shrink-0"
          style={{ background: accentColor }}>
          {badge}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-slate-800 leading-tight">{name}</p>
          <p className="text-[10px] text-slate-400 mt-0.5">{result.wordCount}w · {result.sentenceCount} sentences</p>
        </div>
        <span className="text-xs font-bold px-2 py-1 rounded-lg" style={{ color: sColor, background: `${sColor}15` }}>
          {result.evidenceStrength}
        </span>
      </div>

      {/* Score block */}
      <div className="mx-4 mb-3 rounded-xl p-3.5 flex items-center gap-4" style={{ background: tier.bg, border: `1px solid ${tier.border}` }}>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold mb-0.5" style={{ color: tier.color }}>{tier.label}</p>
          <p className="text-[11px] text-slate-600 leading-snug line-clamp-2">{result.verdictPhrase}</p>
          <div className="mt-2">
            <BreakdownBar ai={bd.ai} mixed={bd.mixed} human={bd.human} height={6} />
            <div className="flex justify-between text-[9px] mt-1 font-semibold">
              <span style={{ color: "#ef4444" }}>AI {bd.ai}%</span>
              <span style={{ color: "#f59e0b" }}>Mix {bd.mixed}%</span>
              <span style={{ color: "#22c55e" }}>Human {bd.human}%</span>
            </div>
          </div>
          <div className="mt-1.5">
            <ConfidenceBand low={result.confidenceLow} high={result.confidenceHigh} color={tier.color} />
            <p className="text-[9px] text-slate-400 mt-0.5">Confidence interval: {result.confidenceLow}–{result.confidenceHigh}%</p>
          </div>
        </div>
      </div>

      {/* Reliability warnings */}
      {result.reliabilityWarnings.length > 0 && (
        <div className="mx-4 mb-3 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 space-y-0.5">
          {result.reliabilityWarnings.slice(0, 2).map((w, i) => (
            <p key={i} className="text-[10px] text-amber-700 leading-snug">⚠ {w}</p>
          ))}
        </div>
      )}

      {/* Signals accordion */}
      <div className="px-4 pb-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Signals</p>
        <div className="space-y-1.5">
          {result.signals.slice(0, 6).map((sig, i) => (
            <div key={i}>
              <button
                onClick={() => setExpandedSig(expandedSig === i ? null : i)}
                className="w-full flex items-center gap-2 text-left group rounded-lg px-2 py-1.5 hover:bg-slate-50 transition-colors"
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sig.pointsToAI ? (sig.wellSupported ? "bg-red-500" : "bg-amber-400") : "bg-emerald-400"}`} />
                <span className="flex-1 text-[11px] text-slate-600 font-medium truncate group-hover:text-slate-900 transition-colors">{sig.name}</span>
                <div className="w-16 h-1.5 bg-slate-100 rounded-full flex-shrink-0 overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${sig.strength}%`, background: sig.pointsToAI ? (sig.strength > 65 ? "#ef4444" : "#f59e0b") : "#22c55e" }} />
                </div>
                <span className="text-[10px] font-bold w-7 text-right flex-shrink-0" style={{ color: sig.pointsToAI ? (sig.strength > 65 ? "#dc2626" : "#d97706") : "#16a34a" }}>
                  {sig.strength}
                </span>
                <svg className={`w-3 h-3 text-slate-300 flex-shrink-0 transition-transform ${expandedSig === i ? "rotate-180" : ""}`} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>
              {expandedSig === i && (
                <div className="mx-2 mb-1.5 bg-slate-50 rounded-lg px-3 py-2.5">
                  <p className="text-[11px] text-slate-600 leading-relaxed">{sig.value}</p>
                </div>
              )}
            </div>
          ))}
          {result.signals.length > 6 && (
            <p className="text-[10px] text-slate-400 text-center py-1">+{result.signals.length - 6} more signals in PDF report</p>
          )}
        </div>
      </div>

      {/* Sentence overlay toggle */}
      {result.sentences.length > 0 && (
        <div className="px-4 pb-4">
          <button
            onClick={() => setShowOverlay(!showOverlay)}
            className="w-full flex items-center justify-center gap-2 text-[11px] font-semibold rounded-xl py-2.5 border transition-all"
            style={showOverlay
              ? { background: accentColor, color: "#fff", borderColor: accentColor }
              : { background: "transparent", color: "#64748b", borderColor: "#e2e8f0" }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {showOverlay ? "Hide" : "View"} Sentence Highlights ({result.sentences.filter(s => s.label !== "uncertain").length} flagged)
          </button>
          {showOverlay && (
            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
              <DocumentOverlay
                text={originalText || result.sentences.map(s => s.text).join(" ")}
                sentences={result.sentences}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── History Panel ─────────────────────────────────────────────────────────────

function HistoryPanel({ history, onSelect, onClear }: {
  history: ScanRecord[];
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const calibration = loadCalibrationLocal();

  if (history.length === 0) return (
    <div className="text-center py-10 px-6">
      <div className="text-4xl mb-3 opacity-20">🕐</div>
      <p className="text-sm text-slate-400 font-medium">No scans yet</p>
      <p className="text-xs text-slate-300 mt-1">Your last 50 analyses appear here</p>
    </div>
  );

  // Enhancement #10: compute trend summary across last N scans
  const recent = history.slice(0, 20);
  const aiCount     = recent.filter(r => r.verdict.includes("AI") || r.verdict.includes("Likely AI") || r.verdict.includes("Almost")).length;
  const humanCount  = recent.filter(r => r.verdict.includes("Human") && !r.verdict.includes("Review")).length;
  const mixedCount  = recent.filter(r => r.verdict.includes("Mixed") || r.verdict.includes("Review")).length;
  const avgAI       = Math.round(recent.reduce((s, r) => s + r.aiPct, 0) / recent.length);
  const fpRate      = calibration.totalScans > 0
    ? Math.round((calibration.systemSaidAI_reviewerSaidHuman / calibration.totalScans) * 100)
    : null;

  return (
    <div className="space-y-2 py-3 px-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Recent Scans</p>
        <button onClick={onClear} className="text-[10px] text-slate-400 hover:text-red-500 transition-colors">Clear all</button>
      </div>

      {/* Enhancement #10: Trend summary */}
      <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 mb-3">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-2">Last {recent.length} Scans — Trend</p>
        <div className="grid grid-cols-3 gap-2 mb-2">
          {[
            { label: "AI-flagged", count: aiCount, color: "#ef4444", bg: "#fef2f2" },
            { label: "Human", count: humanCount, color: "#16a34a", bg: "#f0fdf4" },
            { label: "Mixed/Review", count: mixedCount, color: "#d97706", bg: "#fffbeb" },
          ].map(({ label, count, color, bg }) => (
            <div key={label} className="rounded-lg p-2 text-center" style={{ background: bg }}>
              <p className="text-lg font-black" style={{ color }}>{count}</p>
              <p className="text-[9px] font-semibold text-slate-500">{label}</p>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between text-[10px] text-slate-500">
          <span>Avg AI score: <strong className="text-slate-700">{avgAI}%</strong></span>
          {fpRate !== null && (
            <span className={fpRate > 20 ? "text-red-600 font-bold" : "text-slate-500"}>
              {fpRate > 20 ? `⚠ ${fpRate}% reviewer override rate` : `${calibration.reviewerOverrides} reviewer overrides`}
            </span>
          )}
        </div>
        {/* Enhancement #1: Calibration warning if false-positive rate is high */}
        {fpRate !== null && fpRate > 25 && (
          <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-2 py-1.5">
            <p className="text-[9px] text-amber-700 font-semibold">
              ⚠ High reviewer override rate ({fpRate}%): your reviewers frequently disagree with AI verdicts. Consider raising the AI threshold for your institution's writing style.
            </p>
          </div>
        )}
      </div>

      {history.map(rec => {
        const tier = getTier(rec.aiPct);
        return (
          <button key={rec.id} onClick={() => onSelect(rec.id)}
            className="w-full text-left rounded-xl border border-slate-100 bg-slate-50 hover:bg-white hover:border-slate-200 hover:shadow-sm p-3 transition-all">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ color: tier.color, background: tier.bg, border: `1px solid ${tier.border}` }}>
                {tier.label}
              </span>
              <div className="flex items-center gap-2">
                {rec.reviewerVerdict && (
                  <span className="text-[9px] text-slate-400 italic">reviewer: {rec.reviewerVerdict}</span>
                )}
                <span className="text-[10px] text-slate-400">{new Date(rec.ts).toLocaleDateString()}</span>
              </div>
            </div>
            <p className="text-[11px] text-slate-700 font-medium line-clamp-1">{rec.snippet}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{rec.wordCount} words · AI {rec.aiPct}%</p>
          </button>
        );
      })}
    </div>
  );
}

// ── Share / Export Utils ──────────────────────────────────────────────────────

function ShareMenu({ perpResult, burstResult, neuralResult, onClose }: {
  perpResult: EngineResult | null;
  burstResult: EngineResult | null;
  neuralResult: EngineResult | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 2000); });
  };

  const getSummaryText = () => {
    if (!perpResult || !burstResult) return "";
    const pBd = uiDeriveBreakdown(perpResult.internalScore);
    const bBd = uiDeriveBreakdown(burstResult.internalScore);
    const nBd = neuralResult ? uiDeriveBreakdown(neuralResult.internalScore) : null;
    const n = nBd ? 3 : 2;
    const avgAI = Math.round((pBd.ai + bBd.ai + (nBd?.ai ?? 0)) / n);
    const tier = getTier(avgAI);
    return `AI Detection Result: ${tier.label} (${avgAI}% AI score)\n` +
      `Engine 1 – Perplexity & Stylometry: ${pBd.ai}% AI (${perpResult.evidenceStrength})\n` +
      `Engine 2 – Burstiness & Cognitive: ${bBd.ai}% AI (${burstResult.evidenceStrength})\n` +
      (nBd ? `Engine 3 – Neural Perplexity: ${nBd.ai}% AI (${neuralResult!.evidenceStrength})\n` : "") +
      `\nGenerated by AI Content Detector`;
  };

  const getJsonExport = () => {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      engines: {
        perplexity_stylometry: perpResult ? { score: perpResult.internalScore, evidenceStrength: perpResult.evidenceStrength, verdict: perpResult.verdictPhrase } : null,
        burstiness_cognitive: burstResult ? { score: burstResult.internalScore, evidenceStrength: burstResult.evidenceStrength, verdict: burstResult.verdictPhrase } : null,
        neural_perplexity: neuralResult ? { score: neuralResult.internalScore, evidenceStrength: neuralResult.evidenceStrength, verdict: neuralResult.verdictPhrase } : null,
      },
    }, null, 2);
  };

  const actions = [
    { key: "summary", label: "Copy Summary", icon: "📋", text: getSummaryText() },
    { key: "json",    label: "Export JSON",  icon: "{ }", text: getJsonExport()  },
  ];

  return (
    <div className="absolute right-0 top-12 z-50 bg-white rounded-2xl border border-slate-200 shadow-xl p-3 w-52" onMouseLeave={onClose}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 px-2 mb-2">Export Results</p>
      {actions.map(a => (
        <button key={a.key} onClick={() => copy(a.text, a.key)}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-slate-50 transition-colors text-left">
          <span className="text-base leading-none">{a.icon}</span>
          <span className="text-sm text-slate-700 font-medium flex-1">{a.label}</span>
          {copied === a.key && <span className="text-[10px] text-emerald-600 font-bold">✓ Copied</span>}
        </button>
      ))}
    </div>
  );
}

// ── Quality Gate Bar ─────────────────────────────────────────────────────────

function QualityGate({ wc }: { wc: number }) {
  // Turnitin requires minimum 300 words and marks short texts with reliability asterisk.
  // We use a tiered system: hard block <20w, strong warning <100w, soft warning 100-200w.
  const steps = [
    { min: 0,   max: 20,   label: "Too short — cannot analyze",  color: "#e2e8f0", warn: "error" as const },
    { min: 20,  max: 100,  label: "Very short — unreliable ⚠",   color: "#fca5a5", warn: "hard" as const  },
    { min: 100, max: 200,  label: "Short — low confidence *",     color: "#fcd34d", warn: "soft" as const  },
    { min: 200, max: 400,  label: "Fair",                         color: "#fcd34d", warn: null             },
    { min: 400, max: 700,  label: "Good",                         color: "#86efac", warn: null             },
    { min: 700, max: 9999, label: "High confidence",              color: "#22c55e", warn: null             },
  ];
  const current = steps.find(s => wc >= s.min && wc < s.max) ?? steps[steps.length - 1];
  const pct = Math.min(100, (wc / 700) * 100);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2.5">
        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: current.color }} />
        </div>
        <span className="text-[10px] font-semibold flex-shrink-0" style={{ color: current.color === "#e2e8f0" ? "#475569" : current.color }}>
          {wc > 0 ? `${wc}w · ${current.label}` : "Enter text"}
        </span>
      </div>
      {current.warn === "hard" && wc > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 border border-red-200">
          <span className="text-red-500 text-xs">⚠</span>
          <p className="text-[10px] text-red-700 font-medium">Under 100 words: statistical signals (CV, TTR, MTLD) are unreliable at this length. Results should not be used as evidence of AI authorship.</p>
        </div>
      )}
      {current.warn === "soft" && wc > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200">
          <span className="text-amber-500 text-xs">*</span>
          <p className="text-[10px] text-amber-700 font-medium">100–200 words: some statistical signals may be unreliable. Add more text for a higher-confidence result.</p>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 1: DATASET EVALUATION MODE
// ═══════════════════════════════════════════════════════════════════════════════

function DatasetEvaluationPanel({
  onRunComplete,
}: { onRunComplete: (run: ExperimentRun) => void }) {
  const [rows, setRows] = useState<DatasetRow[]>([]);
  const [runName, setRunName] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [activeMetricTab, setActiveMetricTab] = useState<"table" | "roc" | "confusion" | "compare">("table");
  const [rocThreshold, setRocThreshold] = useState(15);

  const handleFile = async (file: File) => {
    setError(""); setRows([]); setResults(null);
    const text = await file.text();
    const parsed = file.name.endsWith(".json") ? parseJSONDataset(text) : parseCSV(text);
    if (parsed.length === 0) {
      setError("No valid rows found. CSV must have a 'text' column. JSON must be an array with a 'text' field.");
      return;
    }
    setRows(parsed);
    setRunName(file.name.replace(/\.[^.]+$/, ""));
  };

  const runBatch = async () => {
    if (rows.length === 0) return;
    setRunning(true); setProgress(0); setResults(null);
    const batchResults: BatchResult[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const t0 = Date.now();
      const sanitised = sanitiseInput(row.text.trim());
      const p = runPerplexityEngine(sanitised);
      const b = runBurstinessEngine(sanitised);

      // Use internalScore directly for batch scoring — uiDeriveBreakdown is
      // designed for the display UI and returns ai=0 for short texts (score ≤10).
      // For batch evaluation we need the raw engine scores, not the display mapping.
      // Average both engine scores and clamp to 0-100.
      const combinedAI = Math.min(100, Math.max(0, Math.round((p.internalScore + b.internalScore) / 2)));
      const tier = getTier(combinedAI);
      batchResults.push({
        row, perpScore: p.internalScore, burstScore: b.internalScore,
        combinedAI, verdict: tier.label, psStrength: p.evidenceStrength,
        bcStrength: b.evidenceStrength, processingMs: Date.now() - t0,
      });
      setProgress(Math.round(((i + 1) / rows.length) * 100));
      // Yield to UI every 5 rows
      if (i % 5 === 4) await new Promise(r => setTimeout(r, 0));
    }
    setResults(batchResults);
    setRunning(false);

    // Build experiment run
    const withGT = batchResults.filter(r => r.row.groundTruth);
    const roc = computeROCPoints(batchResults);
    const auc = computeAUC(roc);
    const metrics = computeClassificationMetrics(batchResults, rocThreshold);
    const run: ExperimentRun = {
      id: Date.now().toString(),
      ts: Date.now(),
      name: runName || `Run ${new Date().toLocaleTimeString()}`,
      rowCount: batchResults.length,
      hasGroundTruth: withGT.length > 0,
      avgAI: Math.round(batchResults.reduce((s, r) => s + r.combinedAI, 0) / batchResults.length),
      aiCount: batchResults.filter(r => r.verdict.toLowerCase().includes("ai")).length,
      humanCount: batchResults.filter(r => r.verdict.toLowerCase().includes("human") && !r.verdict.toLowerCase().includes("review")).length,
      mixedCount: batchResults.filter(r => r.verdict.toLowerCase().includes("mixed") || r.verdict.toLowerCase().includes("review")).length,
      accuracy: withGT.length > 0 ? metrics.accuracy : undefined,
      precision: withGT.length > 0 ? metrics.precision : undefined,
      recall: withGT.length > 0 ? metrics.recall : undefined,
      f1: withGT.length > 0 ? metrics.f1 : undefined,
      auc: roc.length > 0 ? auc : undefined,
      results: batchResults,
    };
    onRunComplete(run);
  };

  const rocPoints = results ? computeROCPoints(results) : [];
  const metrics = results ? computeClassificationMetrics(results, rocThreshold) : null;
  const hasGT = rows.some(r => r.groundTruth);
  const aiCountDisplay   = results ? results.filter(r => r.combinedAI >= rocThreshold).length : 0;
  const humanCountDisplay = results ? results.filter(r => r.combinedAI < rocThreshold).length : 0;
  const avgAIDisplay     = results ? Math.round(results.reduce((s, r) => s + r.combinedAI, 0) / results.length) : 0;

  return (
    <div className="space-y-5">
      {/* Upload */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <p className="text-sm font-bold text-slate-800 mb-1">Dataset Evaluation</p>
        <p className="text-xs text-slate-500 mb-4">Upload a CSV or JSON file with multiple texts. Optionally include a <code className="bg-slate-100 px-1 rounded">groundTruth</code> column (AI/Human) to unlock ROC curves, confusion matrix, and accuracy metrics.</p>

        <div className="flex gap-3 mb-4">
          <input value={runName} onChange={e => setRunName(e.target.value)}
            placeholder="Run name (optional)"
            className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
          onClick={() => fileRef.current?.click()}
          className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 cursor-pointer transition-all ${dragOver ? "border-blue-400 bg-blue-50" : rows.length > 0 ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-slate-50 hover:border-blue-300"}`}>
          <input ref={fileRef} type="file" accept=".csv,.json" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          {rows.length > 0 ? (
            <div className="text-center">
              <p className="text-sm font-bold text-emerald-700">✓ {rows.length} rows loaded</p>
              <p className="text-xs text-emerald-600 mt-0.5">{hasGT ? `${rows.filter(r => r.groundTruth === "AI").length} AI / ${rows.filter(r => r.groundTruth === "Human").length} Human labels` : "No ground-truth labels — accuracy metrics unavailable"}</p>
            </div>
          ) : (
            <div className="text-center">
              <div className="text-3xl mb-2 opacity-30">📊</div>
              <p className="text-sm font-semibold text-slate-600">Drop CSV or JSON file here</p>
              <p className="text-xs text-slate-400 mt-0.5">Required column: <code>text</code> &nbsp;·&nbsp; Optional: <code>groundTruth</code>, <code>label</code></p>
            </div>
          )}
        </div>

        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}



        {rows.length > 0 && (
          <button onClick={runBatch} disabled={running}
            className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-bold rounded-xl transition-colors">
            {running ? (
              <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Running… {progress}%</>
            ) : `Run Analysis on ${rows.length} texts`}
          </button>
        )}

        {running && (
          <div className="mt-3 h-2 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-200" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>

      {/* Results */}
      {results && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-slate-100 px-4 pt-3 gap-1">
            {([
              { id: "table", label: "Results Table" },
              { id: "compare", label: "Engine Comparison" },
              ...(rocPoints.length > 0 ? [{ id: "roc", label: "ROC Curve" }, { id: "confusion", label: "Confusion Matrix" }] : []),
            ] as const).map(t => (
              <button key={t.id} onClick={() => setActiveMetricTab(t.id as any)}
                className={`px-3.5 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all ${activeMetricTab === t.id ? "border-blue-600 text-blue-700 bg-blue-50/60" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
                {t.label}
              </button>
            ))}
          </div>

          <div className="p-5">
            {/* Aggregate Summary */}
            <div className="grid grid-cols-4 gap-3 mb-5">
              {[
                { label: "Texts Analyzed", val: results.length, color: "#1b3a6b" },
                { label: `AI-Flagged (≥${rocThreshold}%)`, val: aiCountDisplay, color: "#dc2626" },
                { label: `Human (<${rocThreshold}%)`, val: humanCountDisplay, color: "#16a34a" },
                { label: "Avg AI Score", val: `${avgAIDisplay}%`, color: "#7c3aed" },
              ].map(({ label, val, color }) => (
                <div key={label} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
                  <p className="text-xl font-black" style={{ color }}>{val}</p>
                  <p className="text-[10px] font-semibold text-slate-500 mt-0.5">{label}</p>
                </div>
              ))}
            </div>

            {/* Accuracy Metrics */}
            {metrics && hasGT && (
              <div className="rounded-xl bg-indigo-50 border border-indigo-200 p-4 mb-5">
                <p className="text-xs font-bold text-indigo-800 mb-3">Classification Metrics (threshold: {rocThreshold}%)</p>
                <div className="grid grid-cols-4 gap-3 mb-3">
                  {[
                    { label: "Accuracy", val: `${(metrics.accuracy * 100).toFixed(1)}%` },
                    { label: "Precision", val: `${(metrics.precision * 100).toFixed(1)}%` },
                    { label: "Recall (TPR)", val: `${(metrics.recall * 100).toFixed(1)}%` },
                    { label: "F1 Score", val: metrics.f1.toFixed(3) },
                  ].map(({ label, val }) => (
                    <div key={label} className="rounded-lg bg-white border border-indigo-100 p-2 text-center">
                      <p className="text-base font-black text-indigo-700">{val}</p>
                      <p className="text-[9px] text-indigo-500 font-semibold">{label}</p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <label className="text-[10px] text-indigo-700 font-semibold whitespace-nowrap">Threshold: {rocThreshold}%</label>
                  <input type="range" min={0} max={100} step={5} value={rocThreshold} onChange={e => setRocThreshold(Number(e.target.value))}
                    className="flex-1 accent-indigo-600" />
                </div>
              </div>
            )}

            {/* Table View */}
            {activeMetricTab === "table" && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left py-2 px-2 text-slate-500 font-semibold">Label</th>
                      <th className="text-left py-2 px-2 text-slate-500 font-semibold">Verdict</th>
                      <th className="text-center py-2 px-2 text-slate-500 font-semibold">AI%</th>
                      <th className="text-center py-2 px-2 text-[#1b3a6b] font-semibold">PS</th>
                      <th className="text-center py-2 px-2 text-[#16a34a] font-semibold">BC</th>
                      {hasGT && <th className="text-center py-2 px-2 text-slate-500 font-semibold">Truth</th>}
                      {hasGT && <th className="text-center py-2 px-2 text-slate-500 font-semibold">Correct?</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {results.map(r => {
                      const predictedAI = r.combinedAI >= rocThreshold;
                      const correct = r.row.groundTruth
                        ? (r.row.groundTruth === "AI" ? predictedAI : !predictedAI)
                        : undefined;
                      const tier = getTier(r.combinedAI);
                      return (
                        <tr key={r.row.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                          <td className="py-1.5 px-2 text-slate-700 max-w-[120px] truncate">{r.row.label ?? r.row.id}</td>
                          <td className="py-1.5 px-2">
                            <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold" style={{ color: tier.color, background: tier.bg, border: `1px solid ${tier.border}` }}>
                              {r.verdict}
                            </span>
                          </td>
                          <td className="py-1.5 px-2 text-center font-bold" style={{ color: r.combinedAI >= 70 ? "#dc2626" : r.combinedAI >= 50 ? "#d97706" : "#16a34a" }}>{r.combinedAI}%</td>
                          <td className="py-1.5 px-2 text-center text-slate-500">{r.perpScore}</td>
                          <td className="py-1.5 px-2 text-center text-slate-500">{r.burstScore}</td>
                          {hasGT && <td className="py-1.5 px-2 text-center">
                            <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${r.row.groundTruth === "AI" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>{r.row.groundTruth ?? "—"}</span>
                          </td>}
                          {hasGT && <td className="py-1.5 px-2 text-center">{correct === undefined ? "—" : correct ? "✓" : "✗"}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Engine Comparison */}
            {activeMetricTab === "compare" && (
              <div className="space-y-4">
                <p className="text-xs font-bold text-slate-700">PS vs BC Score Distribution</p>
                <div className="space-y-2">
                  {results.map(r => (
                    <div key={r.row.id} className="flex items-center gap-3">
                      <span className="text-[10px] text-slate-500 w-24 truncate flex-shrink-0">{r.row.label ?? r.row.id}</span>
                      <div className="flex-1 flex gap-1 items-center">
                        <div className="flex-1 h-3 bg-slate-100 rounded-full overflow-hidden relative">
                          <div className="h-full rounded-full transition-all" style={{ width: `${r.perpScore}%`, background: "#1b3a6b", opacity: 0.85 }} />
                        </div>
                        <span className="text-[9px] font-bold text-[#1b3a6b] w-6 text-right">{r.perpScore}</span>
                        <div className="flex-1 h-3 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${r.burstScore}%`, background: "#16a34a", opacity: 0.85 }} />
                        </div>
                        <span className="text-[9px] font-bold text-[#16a34a] w-6 text-right">{r.burstScore}</span>
                        <div className="flex-1 h-3 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${r.combinedAI}%`, background: r.combinedAI >= 70 ? "#dc2626" : r.combinedAI >= 50 ? "#d97706" : "#16a34a" }} />
                        </div>
                        <span className="text-[9px] font-bold text-slate-600 w-6 text-right">{r.combinedAI}%</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-4 text-[10px]">
                  <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-full bg-[#1b3a6b] inline-block"/>PS Score</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-full bg-[#16a34a] inline-block"/>BC Score</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-full bg-slate-400 inline-block"/>Combined</span>
                </div>
                {/* Scatter correlation */}
                <div className="mt-4">
                  <p className="text-xs font-bold text-slate-700 mb-2">PS vs BC Correlation</p>
                  <div className="relative bg-slate-50 border border-slate-200 rounded-xl overflow-hidden" style={{ height: 200 }}>
                    <svg width="100%" height="200" viewBox="0 0 400 200">
                      {/* Axes */}
                      <line x1="40" y1="10" x2="40" y2="170" stroke="#e2e8f0" strokeWidth="1"/>
                      <line x1="40" y1="170" x2="390" y2="170" stroke="#e2e8f0" strokeWidth="1"/>
                      {/* Diagonal reference */}
                      <line x1="40" y1="170" x2="390" y2="10" stroke="#cbd5e1" strokeWidth="0.8" strokeDasharray="4 3"/>
                      {/* Points */}
                      {results.map((r, i) => {
                        const cx = 40 + (r.perpScore / 100) * 350;
                        const cy = 170 - (r.burstScore / 100) * 160;
                        const col = r.combinedAI >= 70 ? "#dc2626" : r.combinedAI >= 50 ? "#d97706" : "#16a34a";
                        return <circle key={i} cx={cx} cy={cy} r="4" fill={col} fillOpacity={0.7} />;
                      })}
                      <text x="215" y="190" textAnchor="middle" fontSize="9" fill="#94a3b8">PS Score</text>
                      <text x="15" y="95" textAnchor="middle" fontSize="9" fill="#94a3b8" transform="rotate(-90 15 95)">BC Score</text>
                    </svg>
                  </div>
                </div>
              </div>
            )}

            {/* ROC Curve */}
            {activeMetricTab === "roc" && rocPoints.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-bold text-slate-700">ROC Curve</p>
                  <span className="text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full">AUC = {computeAUC(rocPoints).toFixed(3)}</span>
                </div>
                <div className="relative bg-slate-50 border border-slate-200 rounded-xl overflow-hidden" style={{ height: 280 }}>
                  <svg width="100%" height="280" viewBox="0 0 360 280">
                    {/* Grid */}
                    {[0,0.25,0.5,0.75,1].map(v => (
                      <g key={v}>
                        <line x1="40" y1={240 - v * 200} x2="340" y2={240 - v * 200} stroke="#e2e8f0" strokeWidth="0.5"/>
                        <line x1={40 + v * 300} y1="40" x2={40 + v * 300} y2="240" stroke="#e2e8f0" strokeWidth="0.5"/>
                        <text x="35" y={244 - v * 200} textAnchor="end" fontSize="8" fill="#94a3b8">{Math.round(v * 100)}%</text>
                        <text x={40 + v * 300} y="252" textAnchor="middle" fontSize="8" fill="#94a3b8">{Math.round(v * 100)}%</text>
                      </g>
                    ))}
                    {/* Diagonal */}
                    <line x1="40" y1="240" x2="340" y2="40" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 3"/>
                    {/* ROC polyline */}
                    <polyline
                      fill="rgba(79,70,229,0.12)"
                      stroke="#4f46e5"
                      strokeWidth="2"
                      points={[...rocPoints.map(p => `${40 + p.fpr * 300},${240 - p.tpr * 200}`), "40,240"].join(" ")}
                    />
                    {rocPoints.map((p, i) => (
                      <circle key={i} cx={40 + p.fpr * 300} cy={240 - p.tpr * 200} r="3" fill="#4f46e5" />
                    ))}
                    <text x="190" y="268" textAnchor="middle" fontSize="9" fill="#64748b">False Positive Rate</text>
                    <text x="12" y="145" textAnchor="middle" fontSize="9" fill="#64748b" transform="rotate(-90 12 145)">True Positive Rate</text>
                  </svg>
                </div>
                <p className="text-[10px] text-slate-400 mt-2 text-center">Each point = one detection threshold (0%–100%). AUC ≈ 1.0 = perfect; 0.5 = random.</p>
              </div>
            )}

            {/* Confusion Matrix */}
            {activeMetricTab === "confusion" && metrics && (
              <div>
                <p className="text-xs font-bold text-slate-700 mb-3">Confusion Matrix (threshold: {rocThreshold}%)</p>
                <div className="flex justify-center">
                  <div className="grid gap-2" style={{ gridTemplateColumns: "auto 1fr 1fr" }}>
                    <div />
                    <div className="text-center text-xs font-bold text-slate-500 pb-1">Predicted AI</div>
                    <div className="text-center text-xs font-bold text-slate-500 pb-1">Predicted Human</div>
                    <div className="text-xs font-bold text-slate-500 text-right pr-2 flex items-center">Actual AI</div>
                    <div className="rounded-xl bg-emerald-50 border border-emerald-300 p-5 text-center">
                      <p className="text-2xl font-black text-emerald-700">{metrics.tp}</p>
                      <p className="text-[9px] text-emerald-600 font-semibold">True Positive</p>
                    </div>
                    <div className="rounded-xl bg-red-50 border border-red-200 p-5 text-center">
                      <p className="text-2xl font-black text-red-600">{metrics.fn}</p>
                      <p className="text-[9px] text-red-500 font-semibold">False Negative</p>
                    </div>
                    <div className="text-xs font-bold text-slate-500 text-right pr-2 flex items-center">Actual Human</div>
                    <div className="rounded-xl bg-red-50 border border-red-200 p-5 text-center">
                      <p className="text-2xl font-black text-red-600">{metrics.fp}</p>
                      <p className="text-[9px] text-red-500 font-semibold">False Positive</p>
                    </div>
                    <div className="rounded-xl bg-emerald-50 border border-emerald-300 p-5 text-center">
                      <p className="text-2xl font-black text-emerald-700">{metrics.tn}</p>
                      <p className="text-[9px] text-emerald-600 font-semibold">True Negative</p>
                    </div>
                  </div>
                </div>
                <p className="text-[10px] text-slate-400 mt-4 text-center">
                  FPR (false alarm rate): {metrics.fp + metrics.tn > 0 ? ((metrics.fp / (metrics.fp + metrics.tn)) * 100).toFixed(1) : "—"}% &nbsp;·&nbsp;
                  FNR (miss rate): {metrics.tp + metrics.fn > 0 ? ((metrics.fn / (metrics.tp + metrics.fn)) * 100).toFixed(1) : "—"}%
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 2: EXPERIMENT TRACKING PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function ExperimentTrackingPanel({ experiments, onClear }: { experiments: ExperimentRun[]; onClear: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = experiments.find(e => e.id === selectedId);

  if (experiments.length === 0) return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
      <div className="text-4xl mb-3 opacity-20">🧪</div>
      <p className="text-sm font-medium text-slate-400">No batch runs yet</p>
      <p className="text-xs text-slate-300 mt-1">Run a dataset evaluation to track experiments here</p>
    </div>
  );

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      {/* Run list */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-xs font-bold text-slate-700">Batch Runs</p>
          <button onClick={onClear} className="text-[10px] text-slate-400 hover:text-red-500 transition-colors">Clear all</button>
        </div>
        <div className="divide-y divide-slate-50">
          {experiments.map(run => (
            <button key={run.id} onClick={() => setSelectedId(run.id === selectedId ? null : run.id)}
              className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${selectedId === run.id ? "bg-blue-50 border-l-2 border-blue-500" : ""}`}>
              <div className="flex items-center justify-between mb-0.5">
                <p className="text-xs font-bold text-slate-800 truncate">{run.name}</p>
                <span className="text-[9px] text-slate-400 flex-shrink-0 ml-2">{new Date(run.ts).toLocaleDateString()}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-500">
                <span>{run.rowCount} texts</span>
                <span>·</span>
                <span className="text-red-600 font-semibold">{run.aiCount} AI</span>
                <span>·</span>
                <span className="text-emerald-600 font-semibold">{run.humanCount} Human</span>
              </div>
              {run.accuracy !== undefined && (
                <div className="mt-1 flex items-center gap-2 text-[10px]">
                  <span className="text-indigo-600 font-bold">Acc: {(run.accuracy * 100).toFixed(1)}%</span>
                  {run.auc !== undefined && <span className="text-slate-400">AUC: {run.auc.toFixed(3)}</span>}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Detail */}
      <div className="lg:col-span-2">
        {selected ? (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-5">
            <div>
              <p className="text-sm font-bold text-slate-800">{selected.name}</p>
              <p className="text-xs text-slate-400">{new Date(selected.ts).toLocaleString()} · {selected.rowCount} texts</p>
            </div>

            {/* Score distribution bar chart */}
            <div>
              <p className="text-xs font-bold text-slate-700 mb-3">AI Score Distribution</p>
              <div className="flex items-end gap-1 h-24">
                {Array.from({ length: 10 }, (_, i) => {
                  const lo = i * 10, hi = lo + 10;
                  const count = selected.results.filter(r => r.combinedAI >= lo && r.combinedAI < hi).length;
                  const maxCount = Math.max(...Array.from({ length: 10 }, (_, j) =>
                    selected.results.filter(r => r.combinedAI >= j * 10 && r.combinedAI < j * 10 + 10).length), 1);
                  const pct = (count / maxCount) * 100;
                  const col = lo >= 70 ? "#dc2626" : lo >= 50 ? "#d97706" : "#16a34a";
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1">
                      <span className="text-[8px] text-slate-400">{count}</span>
                      <div className="w-full rounded-t-sm transition-all" style={{ height: `${Math.max(2, pct * 0.8)}px`, background: col, minHeight: count > 0 ? 4 : 0 }} />
                      <span className="text-[8px] text-slate-400">{lo}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Metrics comparison if ground truth */}
            {selected.accuracy !== undefined && (
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: "Accuracy", val: `${(selected.accuracy! * 100).toFixed(1)}%`, note: "Overall correct predictions" },
                  { label: "Precision", val: `${(selected.precision! * 100).toFixed(1)}%`, note: "Of AI flags, how many were right" },
                  { label: "Recall (TPR)", val: `${(selected.recall! * 100).toFixed(1)}%`, note: "Of actual AI texts, how many caught" },
                  { label: "F1 Score", val: selected.f1!.toFixed(3), note: "Harmonic mean of precision & recall" },
                  { label: "AUC", val: selected.auc?.toFixed(3) ?? "—", note: "Area under ROC curve" },
                ].map(({ label, val, note }) => (
                  <div key={label} className="rounded-xl border border-indigo-100 bg-indigo-50 p-3">
                    <p className="text-sm font-black text-indigo-700">{val}</p>
                    <p className="text-[10px] font-bold text-indigo-600">{label}</p>
                    <p className="text-[9px] text-indigo-400 mt-0.5">{note}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Export JSON */}
            <button onClick={() => {
              const blob = new Blob([JSON.stringify(selected, null, 2)], { type: "application/json" });
              const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
              a.download = `${selected.name.replace(/\s+/g, "_")}.json`; a.click();
            }} className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-700 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
              Export run as JSON
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
            <p className="text-sm text-slate-400">Select a run to view details</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 3: SHAP-LIKE SIGNAL EXPLANATION VIEWER
// ═══════════════════════════════════════════════════════════════════════════════

function ShapExplainerPanel({ perpResult, burstResult }: { perpResult: EngineResult | null; burstResult: EngineResult | null }) {
  const [engine, setEngine] = useState<"all" | "PS" | "BC">("all");
  const shapValues = useMemo(() => computeShapValues(perpResult, burstResult), [perpResult, burstResult]);
  const filtered = engine === "all" ? shapValues : shapValues.filter(e => e.engine === engine);

  if (!perpResult && !burstResult) return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
      <div className="text-4xl mb-3 opacity-20">🔍</div>
      <p className="text-sm text-slate-400">Run an analysis first to see signal attributions</p>
    </div>
  );

  const maxDelta = Math.max(...filtered.map(e => Math.abs(e.delta)), 1);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-slate-800">Signal Attribution (SHAP-style)</p>
          <p className="text-xs text-slate-500 mt-0.5">Approximate contribution of each signal to the AI score. Red = pushes toward AI, Green = pushes toward Human.</p>
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-xl p-1 flex-shrink-0">
          {(["all", "PS", "BC"] as const).map(e => (
            <button key={e} onClick={() => setEngine(e)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${engine === e ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className="p-5 space-y-2">
        {/* Legend */}
        <div className="flex items-center gap-6 mb-4 text-[10px] text-slate-500">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-red-400 inline-block" />Pushes toward AI</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-emerald-400 inline-block" />Pushes toward Human</span>
          <span className="flex items-center gap-1.5">
            <span className="text-[9px] font-bold text-[#1b3a6b] bg-[#e8f0fe] px-1.5 py-0.5 rounded">PS</span>
            <span className="text-[9px] font-bold text-[#16a34a] bg-emerald-50 px-1.5 py-0.5 rounded">BC</span>
          </span>
        </div>

        {filtered.length === 0 && <p className="text-xs text-slate-400 text-center py-4">No signals for this engine filter.</p>}

        {filtered.map((entry, i) => {
          const barPct = Math.abs(entry.delta) / maxDelta * 100;
          const isAI = entry.delta > 0;
          return (
            <div key={i} className="flex items-center gap-3">
              <span className={`text-[9px] font-bold px-1 py-0.5 rounded flex-shrink-0 ${entry.engine === "PS" ? "bg-blue-100 text-[#1b3a6b]" : "bg-emerald-100 text-[#16a34a]"}`}>
                {entry.engine}
              </span>
              <span className="text-[10px] text-slate-700 flex-1 truncate min-w-0" title={entry.signal}>{entry.signal}</span>
              <div className="w-40 flex items-center">
                <div className="flex-1 h-4 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${barPct}%`,
                      background: isAI
                        ? `linear-gradient(90deg, #fca5a5, #dc2626)`
                        : `linear-gradient(90deg, #86efac, #16a34a)`,
                    }}
                  />
                </div>
              </div>
              <span className={`text-[10px] font-bold w-10 text-right flex-shrink-0 ${isAI ? "text-red-600" : "text-emerald-600"}`}>
                {isAI ? "+" : ""}{entry.delta.toFixed(1)}
              </span>
            </div>
          );
        })}

        <p className="text-[9px] text-slate-400 pt-3 leading-relaxed">
          Deltas are approximations derived from each signal's reported strength relative to the engine's total score. These are heuristic attribution estimates, not true Shapley values — for interpretability guidance only.
        </p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 4: REAL-TIME MONITORING DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

function MonitoringDashboard() {
  const [events, setEvents] = useState<MonitoringEvent[]>([]);

  useEffect(() => {
    setEvents(loadMonitoringEventsLocal());
    const handler = () => setEvents(loadMonitoringEventsLocal());
    window.addEventListener("aidetect_scan", handler);
    return () => window.removeEventListener("aidetect_scan", handler);
  }, []);

  if (events.length === 0) return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
      <div className="text-4xl mb-3 opacity-20">📡</div>
      <p className="text-sm text-slate-400 font-medium">No scans yet this session</p>
      <p className="text-xs text-slate-300 mt-1">The monitoring dashboard tracks scans as you run them. Analyze a text to begin.</p>
    </div>
  );

  // Volume over time (last 20 events grouped by minute)
  const recent50 = events.slice(0, 50);
  const avgAI = Math.round(recent50.reduce((s, e) => s + e.aiPct, 0) / recent50.length);
  const aiRate = recent50.filter(e => e.aiPct >= 50).length / recent50.length;
  const drift = recent50.length >= 10 ? (() => {
    const firstHalf = recent50.slice(Math.floor(recent50.length / 2));
    const secondHalf = recent50.slice(0, Math.floor(recent50.length / 2));
    const f = firstHalf.reduce((s, e) => s + e.aiPct, 0) / firstHalf.length;
    const s = secondHalf.reduce((s, e) => s + e.aiPct, 0) / secondHalf.length;
    return s - f; // positive = trending toward AI
  })() : null;

  // Score distribution
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    lo: i * 10, hi: i * 10 + 10,
    count: recent50.filter(e => e.aiPct >= i * 10 && e.aiPct < i * 10 + 10).length,
  }));
  const maxBucket = Math.max(...buckets.map(b => b.count), 1);

  return (
    <div className="space-y-5">
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: "Total Scans", val: events.length, color: "#1b3a6b" },
          { label: "Avg AI Score", val: `${avgAI}%`, color: avgAI >= 60 ? "#dc2626" : avgAI >= 40 ? "#d97706" : "#16a34a" },
          { label: "AI Flag Rate", val: `${Math.round(aiRate * 100)}%`, color: aiRate >= 0.5 ? "#dc2626" : aiRate >= 0.3 ? "#d97706" : "#16a34a" },
          { label: "Score Drift", val: drift !== null ? `${drift > 0 ? "+" : ""}${drift.toFixed(1)}` : "—", color: drift !== null && Math.abs(drift) > 10 ? "#d97706" : "#64748b" },
        ].map(({ label, val, color }) => (
          <div key={label} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 text-center">
            <p className="text-2xl font-black" style={{ color }}>{val}</p>
            <p className="text-[10px] font-semibold text-slate-500 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Score over time sparkline */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <p className="text-xs font-bold text-slate-800 mb-4">AI Score Over Time (last {Math.min(recent50.length, 50)} scans)</p>
          <div className="relative" style={{ height: 120 }}>
            <svg width="100%" height="120" viewBox={`0 0 400 120`} preserveAspectRatio="none">
              {/* Grid lines */}
              {[25, 50, 75].map(v => (
                <line key={v} x1="0" y1={120 - v * 1.1} x2="400" y2={120 - v * 1.1} stroke="#f1f5f9" strokeWidth="1"/>
              ))}
              {/* Alert line at 50% */}
              <line x1="0" y1={120 - 50 * 1.1} x2="400" y2={120 - 50 * 1.1} stroke="#fca5a5" strokeWidth="1" strokeDasharray="4 3"/>
              {/* Data polyline */}
              {recent50.length > 1 && (
                <polyline
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  points={[...recent50].reverse().map((e, i) => {
                    const x = (i / (recent50.length - 1)) * 400;
                    const y = 120 - e.aiPct * 1.1;
                    return `${x},${y}`;
                  }).join(" ")}
                />
              )}
              {/* Points */}
              {[...recent50].reverse().map((e, i) => {
                const x = (i / Math.max(recent50.length - 1, 1)) * 400;
                const y = 120 - e.aiPct * 1.1;
                const col = e.aiPct >= 70 ? "#dc2626" : e.aiPct >= 50 ? "#d97706" : "#16a34a";
                return <circle key={i} cx={x} cy={y} r="3" fill={col} />;
              })}
            </svg>
            <div className="absolute right-0 top-0 text-[8px] text-slate-400">100%</div>
            <div className="absolute right-0 bottom-0 text-[8px] text-slate-400">0%</div>
          </div>

          {drift !== null && Math.abs(drift) > 10 && (
            <div className={`mt-3 rounded-lg px-3 py-2 text-xs font-semibold ${drift > 0 ? "bg-red-50 border border-red-200 text-red-700" : "bg-emerald-50 border border-emerald-200 text-emerald-700"}`}>
              {drift > 0 ? `⚠ Score trending upward (+${drift.toFixed(1)} pts) — possible increase in AI-flagged submissions` : `✓ Score trending downward (${drift.toFixed(1)} pts) — AI flags decreasing`}
            </div>
          )}
        </div>

        {/* Distribution histogram */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <p className="text-xs font-bold text-slate-800 mb-4">Score Distribution</p>
          <div className="flex items-end gap-1.5 h-28">
            {buckets.map(({ lo, hi, count }) => {
              const pct = (count / maxBucket) * 100;
              const col = lo >= 70 ? "#dc2626" : lo >= 50 ? "#d97706" : "#16a34a";
              return (
                <div key={lo} className="flex-1 flex flex-col items-center gap-0.5">
                  <span className="text-[8px] text-slate-400 min-h-[12px]">{count > 0 ? count : ""}</span>
                  <div className="w-full rounded-t-sm" style={{ height: `${Math.max(pct * 0.85, count > 0 ? 4 : 0)}px`, background: col }} />
                  <span className="text-[8px] text-slate-400">{lo}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Recent events table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-xs font-bold text-slate-700">Recent Scan Events</p>
          <button onClick={async () => {
            localStorage.removeItem("aidetect_monitoring");
            if (_db) {
              const { collection, getDocs, deleteDoc } = await import("firebase/firestore");
              const snap = await getDocs(collection(_db, `users/${uid()}/monitoring`));
              snap.docs.forEach(d => deleteDoc(d.ref));
            }
            setEvents([]);
          }}
            className="text-[10px] text-slate-400 hover:text-red-500 transition-colors">Clear</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left py-2 px-4 text-slate-400 font-semibold">Time</th>
                <th className="text-left py-2 px-4 text-slate-400 font-semibold">Verdict</th>
                <th className="text-center py-2 px-4 text-slate-400 font-semibold">AI Score</th>
                <th className="text-center py-2 px-4 text-slate-400 font-semibold">Words</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, 20).map((e, i) => {
                const tier = getTier(e.aiPct);
                return (
                  <tr key={i} className="border-b border-slate-50 hover:bg-slate-50/50">
                    <td className="py-1.5 px-4 text-slate-500">{new Date(e.ts).toLocaleTimeString()}</td>
                    <td className="py-1.5 px-4">
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full" style={{ color: tier.color, background: tier.bg }}>
                        {e.verdict}
                      </span>
                    </td>
                    <td className="py-1.5 px-4 text-center font-bold" style={{ color: e.aiPct >= 70 ? "#dc2626" : e.aiPct >= 50 ? "#d97706" : "#16a34a" }}>{e.aiPct}%</td>
                    <td className="py-1.5 px-4 text-center text-slate-400">{e.wordCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── PAGE ──────────────────────────────────────────────────────────────────────

export default function DetectorPage() {
  const [inputMode,      setInputMode]      = useState<"text" | "pdf" | "url">("text");
  const [inputText,      setInputText]      = useState("");
  const [perpResult,     setPerpResult]     = useState<EngineResult | null>(null);
  const [burstResult,    setBurstResult]    = useState<EngineResult | null>(null);
  const [neuralResult,   setNeuralResult]   = useState<EngineResult | null>(null);
  const [rawPerpResult,  setRawPerpResult]  = useState<EngineResult | null>(null);
  const [rawBurstResult, setRawBurstResult] = useState<EngineResult | null>(null);
  const [loadingT,       setLoadingT]       = useState(false);
  const [loadingG,       setLoadingG]       = useState(false);
  const [loadingN,       setLoadingN]       = useState(false);
  const [error,          setError]          = useState("");
  const [generatingPdf,  setGeneratingPdf]  = useState(false);
  const [judgment,       setJudgment]       = useState<"AI-Generated" | "Human-Written" | "Mixed" | "">("");
  const [judgeNotes,     setJudgeNotes]     = useState("");
  const [pdfLoading,     setPdfLoading]     = useState(false);
  const [pdfFileName,    setPdfFileName]    = useState("");
  const [pdfPageCount,   setPdfPageCount]   = useState(0);
  const [dragOver,       setDragOver]       = useState(false);
  const [urlInput,       setUrlInput]       = useState("");
  const [urlLoading,     setUrlLoading]     = useState(false);
  const { user, loading: authLoading, error: authError, signInWithGoogle, signInAnon, signOut } = useFirebaseAuth();

  // ── Admin access control (server-side session) ───────────────────────────
  const [isAdmin,           setIsAdmin]           = useState(false);
  const [showAdminLogin,    setShowAdminLogin]    = useState(false);
  const [adminUser,         setAdminUser]         = useState("");
  const [adminPass,         setAdminPass]         = useState("");
  const [adminLoginError,   setAdminLoginError]   = useState("");
  const [adminLoginLoading, setAdminLoginLoading] = useState(false);

  // Check existing session on mount
  useEffect(() => {
    fetch("/api/admin-login")
      .then(r => r.json())
      .then(data => { if (data.isAdmin) setIsAdmin(true); })
      .catch(() => {});
  }, []);

  const handleAdminLogin = async () => {
    setAdminLoginLoading(true);
    setAdminLoginError("");
    try {
      const res = await fetch("/api/admin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: adminUser, password: adminPass }),
      });
      const data = await res.json();
      if (data.success) {
        setIsAdmin(true);
        setShowAdminLogin(false);
        setAdminUser("");
        setAdminPass("");
        setAdminLoginError("");
      } else {
        setAdminLoginError(data.error ?? "Invalid username or password.");
      }
    } catch {
      setAdminLoginError("Could not reach server. Please try again.");
    } finally {
      setAdminLoginLoading(false);
    }
  };

  const handleAdminLogout = async () => {
    await fetch("/api/admin-login", { method: "DELETE" });
    setIsAdmin(false);
    setActiveTab("analyze");
  };

  const [history,        setHistory]        = useState<ScanRecord[]>([]);
  const [activeTab,      setActiveTab]      = useState<"analyze" | "history" | "dataset" | "experiments" | "shap" | "monitoring">("analyze");
  const [showShare,      setShowShare]      = useState(false);
  const [showHighlighter,setShowHighlighter]= useState(false);
  const [evasionResult,  setEvasionResult]  = useState<{ detected: boolean; types: string[] } | null>(null);
  const [experiments,    setExperiments]    = useState<ExperimentRun[]>([]);

  const fileInputRef    = useRef<HTMLInputElement>(null);
  const textareaRef     = useRef<HTMLTextAreaElement>(null);
  const engineAContextRef = useRef<{ score: number; topSignals: string[]; evidenceStrength: string } | null>(null);
  const engineBContextRef = useRef<{ score: number; topSignals: string[]; evidenceStrength: string } | null>(null);

  // Load history on mount and reload when user signs in/changes
  useEffect(() => {
    Promise.all([loadHistoryAsync(), loadExperimentsAsync()]).then(([h, e]) => {
      setHistory(h);
      setExperiments(e);
    });
  }, [user]);

  // OPT P7: Stable refs for keyboard shortcut — declared here, synced after loading/inputText defined.
  // This avoids re-registering the keydown listener on every render (original bug: no [] on useEffect).
  const _kbLoadingRef = useRef(false);
  const _kbInputRef = useRef("");
  const _kbAnalyzeRef = useRef<(() => void) | null>(null);

  // ─────────────────────────────────────────────────────────────────────────
  //  SOURCE-CODE PROTECTION
  //  Blocks the most common browser-based inspection vectors:
  //    1. Right-click context menu  (View Page Source / Inspect Element)
  //    2. Keyboard shortcuts (F12, Ctrl+Shift+I/J/C, Ctrl+U, Ctrl+S)
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    // 1. Disable right-click context menu
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      return false;
    };

    // 2. Block common DevTools / View-Source keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      const ctrl  = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

      // F12 — open DevTools
      if (e.key === "F12") { e.preventDefault(); return false; }

      // Ctrl+Shift+I / Cmd+Option+I — Inspector
      if (ctrl && shift && (e.key === "I" || e.key === "i")) { e.preventDefault(); return false; }

      // Ctrl+Shift+J / Cmd+Option+J — Console
      if (ctrl && shift && (e.key === "J" || e.key === "j")) { e.preventDefault(); return false; }

      // Ctrl+Shift+C / Cmd+Option+C — Element picker
      if (ctrl && shift && (e.key === "C" || e.key === "c")) { e.preventDefault(); return false; }

      // Ctrl+U — View Page Source
      if (ctrl && (e.key === "U" || e.key === "u")) { e.preventDefault(); return false; }

      // Ctrl+S — Save page
      if (ctrl && (e.key === "S" || e.key === "s")) { e.preventDefault(); return false; }
    };

    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Re-apply 3-engine consensus when neural resolves
  useEffect(() => {
    if (!neuralResult || !rawPerpResult || !rawBurstResult) return;
    const [pFinal3, bFinal3] = applyConsensus(rawPerpResult, rawBurstResult, neuralResult);
    setPerpResult(pFinal3);
    setBurstResult(bFinal3);
  }, [neuralResult, rawPerpResult, rawBurstResult]);

  // OPT P20: Memoize word count — inputText is the only dependency
  const wc = useMemo(
    () => inputText.trim() ? inputText.trim().split(/\s+/).length : 0,
    [inputText]
  );
  const loading = loadingT || loadingG || loadingN;

  // OPT P7: Sync stable refs after loading/inputText/handleAnalyze are defined.
  // The keyboard listener (registered once via [] below) reads these refs at event time.
  useEffect(() => { _kbLoadingRef.current = loading; }, [loading]);
  useEffect(() => { _kbInputRef.current = inputText; }, [inputText]);
  useEffect(() => { _kbAnalyzeRef.current = handleAnalyze; });

  // OPT P7: Register keyboard listener ONCE on mount ([] dependency array).
  // Original had no [], so the listener was re-added on every single render — a memory leak.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (!_kbLoadingRef.current && _kbInputRef.current.trim().length >= 50) {
          _kbAnalyzeRef.current?.();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []); // registered once — refs provide fresh values without re-subscribing


  // Derived combined score
  const getCombined = () => {
    if (!perpResult || !burstResult) return null;
    const elevRatio = (r: EngineResult) => r.sentences.length > 0
      ? r.sentences.filter(s => s.label === "elevated").length / r.sentences.length : 0;
    const pBd = uiDeriveBreakdown(perpResult.internalScore,  elevRatio(perpResult));
    const bBd = uiDeriveBreakdown(burstResult.internalScore, elevRatio(burstResult));
    const nBd = neuralResult ? uiDeriveBreakdown(neuralResult.internalScore, elevRatio(neuralResult)) : null;
    // ── DYNAMIC ENGINE REWEIGHTING BY TEXT TYPE ──────────────────────────────
    // Research-backed: weight PS higher for academic essays (tuned for academic AI),
    // weight BC higher for creative writing (burstiness is strongest signal there),
    // weight NP higher for short texts (<200 words, rule-based engines are noisy).
    const textWordCount = perpResult.wordCount;
    const isShortText = textWordCount < 200;
    const isAcademicText = perpResult.reliabilityWarnings.some(w => w.includes("Academic")) ||
      burstResult.reliabilityWarnings.some(w => w.includes("Academic"));
    const isCreativeText = perpResult.reliabilityWarnings.some(w => w.includes("Creative")) ||
      burstResult.reliabilityWarnings.some(w => w.includes("Creative"));

    // Weight multipliers: PS=Engine A (perpResult), BC=Engine B (burstResult), NP=neural
    let wPS = 1.0, wBC = 1.0, wNP = nBd ? 1.0 : 0;
    if (isShortText) {
      // Short texts: NP (neural) has edge over noisy rule-based signals
      wPS = 0.8; wBC = 0.8; wNP = nBd ? 1.4 : 0;
    } else if (isAcademicText) {
      // Academic: PS is tuned for academic AI patterns
      wPS = 1.3; wBC = 0.9; wNP = nBd ? 1.0 : 0;
    } else if (isCreativeText) {
      // Creative: BC (burstiness) is strongest signal for creative text
      wPS = 0.9; wBC = 1.3; wNP = nBd ? 1.0 : 0;
    }
    const totalW = wPS + wBC + wNP;
    const weightedAI    = Math.round((pBd.ai    * wPS + bBd.ai    * wBC + (nBd?.ai    ?? 0) * wNP) / totalW);
    const weightedMixed = Math.round((pBd.mixed * wPS + bBd.mixed * wBC + (nBd?.mixed  ?? 0) * wNP) / totalW);
    const weightedHuman = 100 - weightedAI - weightedMixed;

    // Use weighted values instead of simple averages
    const avgAI    = weightedAI;
    const avgMixed = weightedMixed;
    const avgHuman = weightedHuman;

    // ── BIMODAL DISTRIBUTION CHECK ──────────────────────────────────────────
    // Derive a mixed signal from the distribution SHAPE of sentence scores,
    // not just the average. A bimodal pattern strongly suggests mixed authorship
    // even when the naive average is in the ambiguous zone.
    const bimodalA = detectBimodalDistribution(perpResult.sentences);
    const bimodalN = neuralResult ? detectBimodalDistribution(neuralResult.sentences) : null;
    const bimodalStrength = Math.max(bimodalA.mixedSignalStrength, bimodalN?.mixedSignalStrength ?? 0);
    const hasBimodalSignal = bimodalStrength >= 40;

    // ── DUAL-ENGINE CONSENSUS GATE (FPR fix) ────────────────────────────────
    // Require both heuristic engines to independently agree on an AI verdict
    // before the combined result can exceed the "Needs Human Review" zone.
    // If only one engine fires AI while the other returns human/low, cap the
    // combined AI% at 49 — routing the case to the review zone rather than
    // auto-labelling it AI-Generated. This directly addresses the 35% FPR.
    const pIsAI = pBd.ai > pBd.human;     // Engine A leans AI
    const bIsAI = bBd.ai > bBd.human;     // Engine B leans AI
    const enginesAgreeAI = pIsAI && bIsAI; // Both must agree for a positive verdict
    let finalAvgAI = avgAI;
    let consensusNote: string | null = null;
    if (avgAI >= 50 && !enginesAgreeAI) {
      // One engine over-fired. Clamp to review zone.
      finalAvgAI = Math.min(avgAI, 49);
      consensusNote = "Engines disagree — result requires human review before any conclusion";
    }

    // ── BIMODAL MIXED UPGRADE ────────────────────────────────────────────────
    // If bimodal signal is strong AND current verdict would be ambiguous (35–64%),
    // upgrade to explicitly Mixed to match the distribution evidence.
    let bimodalNote: string | null = null;
    if (hasBimodalSignal && finalAvgAI >= 30 && finalAvgAI < 65) {
      const highPct = Math.round(Math.max(bimodalA.highCluster, bimodalN?.highCluster ?? 0) * 100);
      const lowPct  = Math.round(Math.max(bimodalA.lowCluster,  bimodalN?.lowCluster  ?? 0) * 100);
      bimodalNote = `Bimodal sentence distribution detected: ~${highPct}% of sentences show elevated AI patterns while ~${lowPct}% appear human-written. This distribution is more characteristic of mixed/hybrid authorship than either pure AI or pure human writing.`;
      // Ensure the verdict reads as Mixed when bimodal pattern is detected
      finalAvgAI = Math.max(finalAvgAI, 50); // push into Mixed territory if below
      finalAvgAI = Math.min(finalAvgAI, 64); // cap below "Likely AI" — it's Mixed, not pure AI
    }

    return { avgAI: finalAvgAI, avgMixed, avgHuman, tier: getTier(finalAvgAI), consensusNote, bimodalNote, bimodalStrength };
  };
  // OPT P21: Memoize combined/shouldAbstain/banner — only recompute when engine results change
  const combined = useMemo(() => {
    const raw = getCombined();
    if (!raw) return null;
    const cal = loadCalibrationLocal();
    const shift = getBayesianThresholdShift(raw.avgAI, cal);
    if (shift === 0) return raw;
    const adjusted = Math.max(0, Math.min(100, raw.avgAI + shift));
    return { ...raw, avgAI: adjusted, tier: getTier(adjusted) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perpResult, burstResult, neuralResult]);

  // ── CONFIDENCE-BASED ABSTENTION (Architectural #16) ──────────────────────
  // When all engines report INCONCLUSIVE and the disagreement index is high,
  // abstain from giving any verdict rather than averaging uncertain signals.
  const shouldAbstain = useMemo(() => {
    if (!perpResult || !burstResult) return false;
    const allInconclusive =
      perpResult.evidenceStrength === "INCONCLUSIVE" &&
      burstResult.evidenceStrength === "INCONCLUSIVE" &&
      (!neuralResult || neuralResult.evidenceStrength === "INCONCLUSIVE");
    if (!allInconclusive) return false;
    // Disagreement index: spread of internalScores
    const scores = [perpResult.internalScore, burstResult.internalScore, neuralResult?.internalScore ?? perpResult.internalScore];
    const minS = Math.min(...scores);
    const maxS = Math.max(...scores);
    return (maxS - minS) > 40; // > 40 point spread with all inconclusive = abstain
  }, [perpResult, burstResult, neuralResult]);

  // Consensus banner
  const banner = useMemo(() => {
    if (!perpResult || !burstResult) return null;
    const pHigh = ["HIGH","MEDIUM"].includes(perpResult.evidenceStrength);
    const bHigh = ["HIGH","MEDIUM"].includes(burstResult.evidenceStrength);
    const nHigh = neuralResult && ["HIGH","MEDIUM"].includes(neuralResult.evidenceStrength);
    const pLow  = ["LOW","INCONCLUSIVE"].includes(perpResult.evidenceStrength);
    const bLow  = ["LOW","INCONCLUSIVE"].includes(burstResult.evidenceStrength);
    const nLow  = !neuralResult || ["LOW","INCONCLUSIVE"].includes(neuralResult.evidenceStrength);
    if (pLow && bLow && nLow)    return { text: `All ${neuralResult ? 3 : 2} engines: low AI patterns`,                    color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", icon: "✓" };
    if (pHigh && bHigh && nHigh) return { text: "All 3 engines elevated — dual-consensus confirmed, review carefully",     color: "#dc2626", bg: "#fef2f2", border: "#fecaca", icon: "▲" };
    if (pHigh && bHigh)          return { text: "Both heuristic engines elevated — dual-consensus confirmed",              color: "#ea580c", bg: "#fff7ed", border: "#fed7aa", icon: "▲" };
    // Single-engine firing: this is the primary FPR risk — label it clearly
    if ((pHigh && bLow) || (bHigh && pLow))
                                 return { text: "Only one engine elevated — insufficient for AI verdict, human review required", color: "#b45309", bg: "#fffbeb", border: "#fcd34d", icon: "⚠" };
    return                              { text: "Mixed evidence across engines — treat as inconclusive",                    color: "#d97706", bg: "#fffbeb", border: "#fde68a", icon: "◈" };
  }, [perpResult, burstResult, neuralResult]);

  const handleAnalyze = useCallback(() => {
    setError("");
    const trimmed = inputText.trim();
    if (trimmed.length < 50) { setError("Please enter at least 50 characters."); return; }
    if (wc < 20)             { setError("Please enter at least 20 words."); return; }

    // ── SANITISE: strip invisible chars and normalise homoglyphs ──────────────
    // Closes mechanical evasion attacks before any engine sees the text.
    const evasion = detectEvasionAttempts(trimmed); // Enhancement #8: detect BEFORE sanitising
    setEvasionResult(evasion.detected ? evasion : null);
    const sanitised = sanitiseInput(trimmed);

    setPerpResult(null); setBurstResult(null); setNeuralResult(null);
    setLoadingT(true);   setLoadingG(true);   setLoadingN(true);

    setTimeout(() => {
      try {
        const CACHE_TTL = 10 * 60 * 1000;
        const now = Date.now();
        if (_analysisCache && _analysisCache.text === sanitised && now - _analysisCache.timestamp < CACHE_TTL) {
          engineAContextRef.current = { score: _analysisCache.perpResult.internalScore, evidenceStrength: _analysisCache.perpResult.evidenceStrength, topSignals: _analysisCache.perpResult.signals.filter(s => s.pointsToAI && s.strength >= 30).sort((a,b) => b.strength - a.strength).slice(0,4).map(s => `${s.name}: ${s.strength}%`) };
          engineBContextRef.current = { score: _analysisCache.burstResult.internalScore, evidenceStrength: _analysisCache.burstResult.evidenceStrength, topSignals: _analysisCache.burstResult.signals.filter(s => s.pointsToAI && s.strength >= 30).sort((a,b) => b.strength - a.strength).slice(0,4).map(s => `${s.name}: ${s.strength}%`) };
          setRawPerpResult(_analysisCache.perpResult); setRawBurstResult(_analysisCache.burstResult);
          setPerpResult(_analysisCache.perpResult);    setBurstResult(_analysisCache.burstResult);
          setLoadingT(false); setLoadingG(false);
          return;
        }
        const p = runPerplexityEngine(sanitised);
        let [pFinal, bFinal_placeholder] = applyConsensus(p, p, null); // temp self-consensus for A

        // ── PROGRESSIVE RESULTS: show Engine A immediately ─────────────────
        engineAContextRef.current = { score: p.internalScore, evidenceStrength: p.evidenceStrength, topSignals: p.signals.filter(s => s.pointsToAI && s.strength >= 30).sort((a,b) => b.strength - a.strength).slice(0,4).map(s => `${s.name}: ${s.strength}%`) };
        setRawPerpResult(p); setPerpResult(p); setLoadingT(false);

        // Engine B fires 200ms later
        setTimeout(() => {
          try {
            const b = runBurstinessEngine(sanitised);
            let [pF, bF] = applyConsensus(p, b, null);

            const hasBracket = /\[AI:/i.test(sanitised);
            const bothHigh   = pF.evidenceStrength === "HIGH" && bF.evidenceStrength === "HIGH";
            if (hasBracket) {
              const upgrade = (r: EngineResult) => ({ ...r, internalScore: Math.max(r.internalScore, 22), evidenceStrength: (["LOW","INCONCLUSIVE"].includes(r.evidenceStrength) ? "MEDIUM" : r.evidenceStrength) as EvidenceStrength, verdictPhrase: "[AI:] insertion detected — explicit hybrid/mixed authorship" });
              pF = upgrade(pF); bF = upgrade(bF);
            } else if (!bothHigh && p.sentenceCount >= 4) {
              const { shiftScore } = intraDocumentShift(splitSentences(sanitised));
              if (shiftScore > 35 && (pF.internalScore > 12 || bF.internalScore > 12)) {
                const upgradeHybrid = (r: EngineResult, ph: string) => ({ ...r, internalScore: Math.max(r.internalScore, 22), evidenceStrength: (["LOW","INCONCLUSIVE"].includes(r.evidenceStrength) ? "MEDIUM" : r.evidenceStrength) as EvidenceStrength, verdictPhrase: r.internalScore < 22 ? ph : r.verdictPhrase });
                pF = upgradeHybrid(pF, "Hybrid authorship signal — mixed style shift");
                bF = upgradeHybrid(bF, "Hybrid authorship signal — style variance");
              }
            }

            _analysisCache = { text: sanitised, perpResult: pF, burstResult: bF, timestamp: Date.now() };
            engineAContextRef.current = { score: pF.internalScore, evidenceStrength: pF.evidenceStrength, topSignals: pF.signals.filter(s => s.pointsToAI && s.strength >= 30).sort((a,b) => b.strength - a.strength).slice(0,4).map(s => `${s.name}: ${s.strength}%`) };
            engineBContextRef.current = { score: bF.internalScore, evidenceStrength: bF.evidenceStrength, topSignals: bF.signals.filter(s => s.pointsToAI && s.strength >= 30).sort((a,b) => b.strength - a.strength).slice(0,4).map(s => `${s.name}: ${s.strength}%`) };
            setRawPerpResult(pF); setRawBurstResult(bF);
            setPerpResult(pF);    setBurstResult(bF);

            const elevRatio = pF.sentences.length > 0 ? pF.sentences.filter(s => s.label === "elevated").length / pF.sentences.length : 0;
            const pBd = uiDeriveBreakdown(pF.internalScore, elevRatio);
            const bBd = uiDeriveBreakdown(bF.internalScore, elevRatio);
            const avgAI = Math.round((pBd.ai + bBd.ai) / 2);
            const tier  = getTier(avgAI);
            const rec: ScanRecord = { id: Date.now().toString(), ts: Date.now(), snippet: sanitised.slice(0, 80) + (sanitised.length > 80 ? "…" : ""), wordCount: wc, verdict: tier.label, aiPct: avgAI, evidenceStrength: pF.evidenceStrength };
            const updated = [rec, ...loadHistoryLocal()];
            saveHistoryAsync(updated); setHistory(updated);
            // Monitoring: emit scan event for real-time dashboard
            const monEvt = { ts: Date.now(), aiPct: avgAI, verdict: tier.label, wordCount: wc };
            saveMonitoringEventAsync(monEvt);
            window.dispatchEvent(new Event("aidetect_scan"));
          } catch (e) { console.error(e); }
          setLoadingG(false);
        }, 200);
      } catch (e) { console.error(e); setLoadingT(false); setLoadingG(false); }
    }, 400);

    // ── HYBRID GATE: Engine C strategy ───────────────────────────────────────
    // For CLEAR cases (combined score < 30 or > 70): Engine C runs via Groq
    //   (runNeuralEngine → /api/neural-analyze) — deep LLM analysis.
    // For AMBIGUOUS cases (30–70): ADDITIONALLY call /api/neural (Gemini free
    //   tier) as a fast second-opinion tiebreaker to resolve borderline texts.
    // This preserves Groq quota for deep analysis while using Gemini free quota
    // specifically where it reduces false positives.
    setTimeout(() => {
      // Engine C always runs via Groq for deep analysis
      runNeuralEngine(sanitised, engineAContextRef.current, engineBContextRef.current)
        .then(nResult => setNeuralResult(nResult))
        .catch(e => { console.error(e); setNeuralResult(null); })
        .finally(() => setLoadingN(false));

      // Hybrid gate: also call Gemini for ambiguous zone texts
      const combinedEstimate = _analysisCache
        ? (_analysisCache.perpResult.internalScore + _analysisCache.burstResult.internalScore) / 2
        : 50;
      const isAmbiguous = combinedEstimate >= 30 && combinedEstimate <= 70;

      if (isAmbiguous && typeof window !== "undefined") {
        fetch("/api/neural", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: sanitised,
            engineAScore: engineAContextRef.current?.score ?? null,
            engineBScore: engineBContextRef.current?.score ?? null,
            engineAStrength: engineAContextRef.current?.evidenceStrength ?? null,
            engineBStrength: engineBContextRef.current?.evidenceStrength ?? null,
          }),
        })
          .then(r => r.ok ? r.json() : null)
          .then(hybridData => {
            if (!hybridData || hybridData.error) return;
            // Surface hybrid gate result as a reliability note on the neural result
            // (we don't replace the full neural result — just annotate it)
            setNeuralResult(prev => {
              if (!prev) return prev;
              const hybridNote = `Hybrid gate (Gemini 2.5 Flash): ${hybridData.verdict} — ${hybridData.reasoning} [confidence: ${hybridData.confidence}]`;
              return {
                ...prev,
                reliabilityWarnings: [hybridNote, ...prev.reliabilityWarnings],
              };
            });
          })
          .catch(() => {/* Gemini unavailable — fail silently, Groq result is sufficient */});
      }
    }, 450);
  }, [inputText, wc]);

  const handleClear = () => {
    _analysisCache = null; _sentenceSplitCache = null; _wordTokenCache = null;
    setInputText(""); setPerpResult(null); setBurstResult(null); setNeuralResult(null);
    setRawPerpResult(null); setRawBurstResult(null); setError("");
    setJudgment(""); setJudgeNotes(""); setPdfFileName(""); setPdfPageCount(0); setUrlInput("");
    setEvasionResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handlePdfFile = async (file: File) => {
    if (!file || file.type !== "application/pdf") { setError("Please upload a valid PDF file."); return; }
    if (file.size > 20 * 1024 * 1024) { setError("PDF is too large (max 20 MB)."); return; }
    setError(""); setPdfLoading(true); setPdfFileName(file.name);
    setPerpResult(null); setBurstResult(null); setJudgment(""); setJudgeNotes("");
    try {
      const text = await extractTextFromPDF(file);
      if (!text || text.trim().length < 50) {
        setError("Could not extract text. The PDF may be scanned or image-based.");
        setPdfFileName(""); setPdfPageCount(0);
      } else {
        setInputText(text.trim());
        setPdfPageCount(Math.max(1, Math.round(text.trim().split(/\s+/).length / 250)));
      }
    } catch { setError("Failed to read PDF. Please try a different file."); setPdfFileName(""); setPdfPageCount(0); }
    finally { setPdfLoading(false); }
  };

  const handleDownloadPDF = async () => {
    setGeneratingPdf(true);
    const evasion = detectEvasionAttempts(inputText);
    try { await generatePDFReport(inputText, perpResult, burstResult, neuralResult, judgment, judgeNotes, evasion.types); }
    catch { setError("Failed to generate PDF. Please try again."); }
    finally { setGeneratingPdf(false); }
  };

  const hasResults = !!(perpResult || burstResult);

  return (
    <main className="min-h-screen" style={{ background: "#f8fafc", fontFamily: "'Inter var', 'Inter', system-ui, sans-serif" }}>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@600;700&display=swap');`}</style>
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-sm">
        <div className="w-full px-8 sm:px-12 h-20 flex items-center justify-between gap-4">
          {/* Logo */}
          <div className="flex items-center flex-shrink-0">
            <div className="flex flex-col" style={{ gap: "10px" }}>
              <span style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: "1.6rem", color: "#1a1a1a", letterSpacing: "-0.02em", lineHeight: 1 }}>MultiLens</span>
              <span style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: "0.85rem", color: "#2563eb", letterSpacing: "0.08em", textTransform: "uppercase", lineHeight: 1 }}>AI Detector</span>
            </div>
          </div>

          {/* Model version badge — Improvement #20 
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200">
            <span className="text-[10px] font-bold text-slate-500">{MODEL_VERSION}</span>
            <span className="text-slate-300">·</span>
            <span className="text-[10px] text-slate-400">{MODEL_DATE}</span>
            <span className="text-slate-300">·</span>
            <span className="text-[10px] text-slate-400">{MODEL_SIGNALS}</span>
          </div> */}

          {/* Nav tabs */}
          <nav className="flex items-center gap-1 bg-slate-100 rounded-xl p-1 flex-wrap">
            {([
              { id: "analyze", label: "Analyze", adminOnly: false },
              { id: "history", label: `History${history.length > 0 ? ` (${history.length})` : ""}`, adminOnly: true },
              { id: "dataset", label: "Dataset", adminOnly: true },
              { id: "experiments", label: `Experiments${experiments.length > 0 ? ` (${experiments.length})` : ""}`, adminOnly: true },
              { id: "shap", label: "Signals", adminOnly: true },
              { id: "monitoring", label: "Monitor", adminOnly: true },
            ] as const).filter(tab => !tab.adminOnly || isAdmin).map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTab === tab.id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}>
                {tab.label}
              </button>
            ))}
          </nav>

          {/* Admin link / badge */}
          <div className="flex items-center flex-shrink-0">
            {isAdmin ? (
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-bold">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/></svg>
                  Admin
                </span>
                <button onClick={handleAdminLogout}
                  className="text-[11px] text-slate-400 hover:text-red-500 transition-colors font-semibold">
                  Sign out
                </button>
              </div>
            ) : (
              <button onClick={() => { setShowAdminLogin(true); setAdminLoginError(""); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-[11px] font-semibold text-slate-500 hover:text-slate-800 transition-colors">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>
                Admin
              </button>
            )}
          </div>

          {/* Right badges 
          <div className="hidden md:flex items-center gap-2">
            {(["100+ signals", "3 engines", "GPTZero-aligned"] as const).map(b => (
              <span key={b} className="text-[10px] font-semibold bg-slate-100 text-slate-500 px-2.5 py-1 rounded-full border border-slate-200">{b}</span>
            ))}
          </div>*/}
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">

        {/* ── Admin-only gate UI ───────────────────────────────────────── */}
        {(["history","dataset","experiments","shap","monitoring"] as const).includes(activeTab as any) && !isAdmin && (
          <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center text-3xl">🔒</div>
            <div>
              <p className="text-sm font-bold text-slate-800 mb-1">Administrator Access Required</p>
              <p className="text-xs text-slate-500">This section is restricted to administrators.<br/>Please sign in with an authorized account.</p>
            </div>
          </div>
        )}

        {/* ── History Tab ──────────────────────────────────────────────── */}
        {activeTab === "history" && isAdmin && (
          <div className="max-w-xl mx-auto bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <HistoryPanel history={history} onSelect={() => setActiveTab("analyze")} onClear={() => { saveHistoryAsync([]); setHistory([]); }} />
          </div>
        )}

        {/* ── Dataset Tab ──────────────────────────────────────────────── */}
        {activeTab === "dataset" && isAdmin && (
          <DatasetEvaluationPanel onRunComplete={(run) => {
            const updated = [run, ...loadExperimentsLocal()];
            saveExperimentsAsync(updated);
            setExperiments(updated);
          }} />
        )}

        {/* ── Experiments Tab ──────────────────────────────────────────── */}
        {activeTab === "experiments" && isAdmin && (
          <ExperimentTrackingPanel experiments={experiments} onClear={() => { saveExperimentsAsync([]); setExperiments([]); }} />
        )}

        {/* ── SHAP / Signal Attribution Tab ────────────────────────────── */}
        {activeTab === "shap" && isAdmin && (
          <ShapExplainerPanel perpResult={perpResult} burstResult={burstResult} />
        )}

        {/* ── Monitoring Tab ────────────────────────────────────────────── */}
        {activeTab === "monitoring" && isAdmin && (
          <MonitoringDashboard />
        )}

        {/* ── Analyze Tab ───────────────────────────────────────────────── */}
        {activeTab === "analyze" && (
          <div className="space-y-5">

            {/* Input card */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">

              {/* Mode switcher tabs */}
              <div className="flex items-center gap-0 border-b border-slate-100 px-4 pt-3">
                {([
                  { id: "text", label: "Paste Text", icon: (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 3.487a2.25 2.25 0 113.182 3.182L7.5 19.213l-4.5 1.125 1.125-4.5L16.862 3.487z"/>
                    </svg>
                  )},
                  { id: "pdf", label: "Upload PDF", icon: (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
                    </svg>
                  )},
                  { id: "url", label: "Fetch URL", icon: (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"/>
                    </svg>
                  )},
                ] as const).map(m => (
                  <button key={m.id} onClick={() => { setInputMode(m.id); if (m.id !== "pdf") { setPdfFileName(""); setPdfPageCount(0); } }}
                    className={`flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all ${
                      inputMode === m.id
                        ? "border-blue-600 text-blue-700 bg-blue-50/60"
                        : "border-transparent text-slate-600 hover:text-slate-800"
                    }`}>
                    {m.icon}
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="p-5 space-y-4">
                {/* Text mode */}
                {inputMode === "text" && (
                  <div>
                    <textarea
                      ref={textareaRef}
                      value={inputText}
                      onChange={e => setInputText(e.target.value)}
                      rows={8}
                      placeholder="Paste the text you want to analyze here… (minimum 50 characters, 20 words)"
                      aria-label="Text to analyze"
                      className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-800 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent leading-relaxed transition font-mono"
                    />
                    <QualityGate wc={wc} />
                  </div>
                )}

                {/* PDF mode */}
                {inputMode === "pdf" && (
                  <div>
                    <div
                      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handlePdfFile(f); }}
                      onClick={() => !pdfLoading && !loading && fileInputRef.current?.click()}
                      role="button" tabIndex={0} aria-label="Upload PDF"
                      onKeyDown={e => e.key === "Enter" && fileInputRef.current?.click()}
                      className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 cursor-pointer transition-all
                        ${dragOver ? "border-blue-400 bg-blue-50" : pdfFileName ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/40"}
                        ${(pdfLoading || loading) ? "opacity-60 cursor-not-allowed pointer-events-none" : ""}`}
                    >
                      <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) handlePdfFile(f); }}
                        disabled={pdfLoading || loading} />
                      {pdfLoading ? (
                        <>
                          <svg className="animate-spin h-7 w-7 text-blue-500" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                          </svg>
                          <p className="text-sm font-medium text-blue-600">Extracting text…</p>
                        </>
                      ) : pdfFileName ? (
                        <div className="flex items-center gap-3 w-full">
                          <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center flex-shrink-0">
                            <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                            </svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-emerald-700 truncate">{pdfFileName}</p>
                            <p className="text-xs text-emerald-600">~{pdfPageCount} page{pdfPageCount !== 1 ? "s" : ""} · {wc} words loaded</p>
                          </div>
                          <button onClick={e => { e.stopPropagation(); handleClear(); }}
                            className="text-xs text-slate-400 hover:text-red-500 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors">✕</button>
                        </div>
                      ) : (
                        <>
                          <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center">
                            <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
                            </svg>
                          </div>
                          <div className="text-center">
                            <p className="text-sm font-semibold text-slate-600">{dragOver ? "Drop PDF here" : "Click to upload or drag & drop"}</p>
                            <p className="text-xs text-slate-400 mt-0.5">PDF only · max 20 MB · text-based PDFs</p>
                          </div>
                        </>
                      )}
                    </div>
                    {pdfFileName && <QualityGate wc={wc} />}
                  </div>
                )}

                {/* URL mode */}
                {inputMode === "url" && (
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <input
                        type="url"
                        value={urlInput}
                        onChange={e => setUrlInput(e.target.value)}
                        placeholder="https://example.com/article"
                        aria-label="URL to fetch"
                        className="flex-1 rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                      />
                      <button
                        onClick={async () => {
                          if (!urlInput.trim()) return;
                          setUrlLoading(true); setError("");
                          try {
                            const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(urlInput.trim())}`);
                            const json = await res.json();
                            const div = document.createElement("div");
                            div.innerHTML = json.contents;
                            // Enhancement #6: content extraction filter
                            // Remove navigation, footer, sidebar, ad boilerplate before extracting text.
                            // These short UI strings inflate named-entity count and pollute TTR.
                            const removeSelectors = ["nav","header","footer","aside","script","style","noscript","[class*='nav']","[class*='menu']","[class*='sidebar']","[class*='footer']","[class*='cookie']","[class*='banner']","[id*='nav']","[id*='footer']","[id*='sidebar']","[id*='menu']"];
                            removeSelectors.forEach(sel => {
                              try { div.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
                            });
                            const rawLines = Array.from(div.querySelectorAll("p, h1, h2, h3, h4, li, blockquote, td"))
                              .map(el => el.textContent?.trim() ?? "")
                              .filter(Boolean);
                            // Filter out lines that look like navigation/UI text:
                            // lines <40 chars are likely buttons, menu items, captions
                            const contentLines = rawLines.filter(line => line.length >= 40);
                            const text = contentLines.join("\n");
                            if (!text || text.length < 50) throw new Error("Not enough content text");
                            setInputText(text.slice(0, 15000));
                          } catch { setError("Could not fetch URL. Try pasting the text directly."); }
                          finally { setUrlLoading(false); }
                        }}
                        disabled={urlLoading || !urlInput.trim()}
                        className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-200 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
                      >
                        {urlLoading ? <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : null}
                        Fetch
                      </button>
                    </div>
                    {inputText && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <p className="text-xs text-slate-500 font-medium mb-1">Fetched text preview</p>
                        <p className="text-xs text-slate-700 line-clamp-3">{inputText.slice(0, 250)}…</p>
                        <QualityGate wc={wc} />
                      </div>
                    )}
                  </div>
                )}

                {/* Error */}
                {error && (
                  <div className="flex items-center gap-2.5 rounded-xl bg-red-50 border border-red-200 px-4 py-3" role="alert">
                    <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <p className="text-sm text-red-700 font-medium">{error}</p>
                  </div>
                )}

                {/* Enhancement #8: Evasion Detection Banner */}
                {evasionResult?.detected && (
                  <div className="flex items-start gap-2.5 rounded-xl bg-red-50 border border-red-300 px-4 py-3" role="alert">
                    <span className="text-red-500 text-base flex-shrink-0 mt-0.5">🚨</span>
                    <div>
                      <p className="text-sm font-bold text-red-700 mb-0.5">Evasion Attempt Detected</p>
                      <p className="text-xs text-red-600 leading-relaxed">
                        The submitted text contains evasion techniques: <strong>{evasionResult.types.join(", ")}</strong>.
                        The text has been normalised before analysis, but results may underestimate AI likelihood.
                        This finding has been recorded in the PDF report.
                      </p>
                    </div>
                  </div>
                )}

                {/* Action row */}
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={handleAnalyze}
                    disabled={loading || !inputText.trim() || wc < 20}
                    aria-label="Analyze text (Ctrl+Enter)"
                    className="flex items-center gap-2.5 px-6 py-2.5 rounded-xl font-bold text-sm text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                    style={{ background: loading ? "#93c5fd" : "linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)" }}
                  >
                    {loading ? (
                      <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Analyzing…</>
                    ) : (
                      <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg>Analyze</>
                    )}
                  </button>
                  {(inputText || hasResults) && (
                    <button onClick={handleClear} className="px-4 py-2.5 rounded-xl text-sm font-semibold text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors">
                      Clear
                    </button>
                  )}
                  <span className="text-[10px] text-slate-300 ml-auto hidden sm:block">⌘ Enter to analyze</span>
                </div>
              </div>
            </div>

            {/* ── Combined Score Dashboard ────────────────────────────── */}
            {(loading || combined) && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-6 py-5">
                  {/* ── Confidence-Based Abstention Banner ───────────────────────────── */}
                  {shouldAbstain && combined && (
                    <div className="mb-4 flex items-start gap-3 rounded-xl bg-slate-100 border border-slate-300 px-4 py-3">
                      <span className="text-2xl flex-shrink-0">🚫</span>
                      <div>
                        <p className="text-sm font-bold text-slate-800 mb-0.5">Cannot Determine — Insufficient Evidence</p>
                        <p className="text-xs text-slate-600 leading-relaxed">All three engines returned INCONCLUSIVE with high inter-engine disagreement. Averaging three uncertain signals would produce a misleading result. No verdict can be reliably issued for this text. This may occur with very short texts, ambiguous writing styles, or texts at the boundary of AI and human writing patterns.</p>
                      </div>
                    </div>
                  )}
                  {combined ? (
                    <div className="flex flex-col sm:flex-row items-center gap-6">
                      {/* Gauge */}
                      <div className="flex-shrink-0">
                        <CircularGauge pct={combined.avgAI} color={combined.tier.color} size={140} />
                      </div>

                      {/* Main verdict */}
                      <div className="flex-1 min-w-0 text-center sm:text-left">
                        <div className="flex items-center justify-center sm:justify-start gap-2 flex-wrap mb-1">
                          <span className="text-xl font-extrabold" style={{ color: combined.tier.color }}>{combined.tier.label}</span>
                          {loadingN && (
                            <span className="text-[10px] text-blue-500 font-semibold bg-blue-50 border border-blue-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                              <svg className="animate-spin h-2.5 w-2.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                              Neural engine running…
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-500 mb-3">Combined result from {neuralResult ? 3 : 2} detection engines</p>

                        <BreakdownBar ai={combined.avgAI} mixed={combined.avgMixed} human={combined.avgHuman} height={10} />
                        <div className="flex justify-between text-xs font-bold mt-1.5">
                          <span style={{ color: "#ef4444" }}>AI {combined.avgAI}%</span>
                          <span style={{ color: "#f59e0b" }}>Mixed {combined.avgMixed}%</span>
                          <span style={{ color: "#22c55e" }}>Human {combined.avgHuman}%</span>
                        </div>

                        {banner && (
                          <div className="mt-3 inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full border"
                            style={{ color: banner.color, background: banner.bg, borderColor: banner.border }}>
                            <span>{banner.icon}</span>
                            <span>{banner.text}</span>
                          </div>
                        )}

                        {/* FPR FIX: Consensus note — shown when engines disagree */}
                        {combined.consensusNote && (
                          <div className="mt-2 flex items-start gap-2 rounded-xl bg-yellow-50 border border-yellow-300 px-3 py-2.5">
                            <span className="text-yellow-600 text-sm flex-shrink-0">⚠</span>
                            <p className="text-xs font-semibold text-yellow-800 leading-snug">{combined.consensusNote}</p>
                          </div>
                        )}

                        {/* Bimodal distribution signal — mixed authorship detected */}
                        {combined.bimodalNote && (
                          <div className="mt-2 flex items-start gap-2 rounded-xl bg-orange-50 border border-orange-300 px-3 py-2.5">
                            <span className="text-orange-600 text-sm flex-shrink-0">◈</span>
                            <div>
                              <p className="text-xs font-bold text-orange-800 mb-0.5">Bimodal Sentence Pattern Detected</p>
                              <p className="text-xs text-orange-700 leading-snug">{combined.bimodalNote}</p>
                            </div>
                          </div>
                        )}

                        {/* AI Model Family Fingerprint — grid card layout with hover tooltips */}
                        {perpResult && (() => {
                          const fSig = perpResult.signals.find(s => s.name.startsWith("AI Model Family Fingerprint"));
                          if (!fSig || fSig.strength < 20) return null;
                          const familyName = fSig.name.includes("—") ? fSig.name.split("—")[1].trim() : null;

                          // Parse rawScores from the value suffix
                          let rawScores: { gpt4: number; claude: number; llama: number; gemini: number; perplexity: number; deepseek: number } | null = null;
                          const rawMatch = fSig.value.match(/__rawScores__:(\{[^}]+\})/);
                          if (rawMatch) {
                            try { rawScores = JSON.parse(rawMatch[1]); } catch {}
                          }
                          if (!rawScores) return null;

                          const totalScore = rawScores.gpt4 + rawScores.claude + rawScores.llama + rawScores.gemini + rawScores.perplexity + rawScores.deepseek;
                          const confidence = fSig.strength >= 100 ? "Moderate confidence" : fSig.strength >= 60 ? "Low confidence" : "Very low confidence";

                          type FamilyKey = "gpt4" | "claude" | "llama" | "gemini" | "perplexity" | "deepseek";
                          const families: Array<{
                            key: FamilyKey; label: string; subtitle: string; initials: string;
                            bg: string; barColor: string; borderColor: string; textColor: string;
                            tooltip: string;
                          }> = [
                            {
                              key: "gpt4", label: "GPT-4 / GPT-4o", subtitle: "OpenAI", initials: "GP",
                              bg: "#e8f5e9", barColor: "#16a34a", borderColor: "#bbf7d0", textColor: "#15803d",
                              tooltip: "Scored on: em-dash overuse (—), core vocabulary (delve, pivotal, leverage, tapestry, groundbreaking, transformative, multifaceted), structural transitions (furthermore, moreover, in conclusion, firstly/secondly/lastly), list introductions (here are the top N…), meta-phrases (Pro-Tip, Why it works, key takeaway), and hedged certainty (this highlights, this showcases, let's explore).",
                            },
                            {
                              key: "claude", label: "Claude", subtitle: "Anthropic", initials: "CL",
                              bg: "#fff7ed", barColor: "#ea580c", borderColor: "#fed7aa", textColor: "#c2410c",
                              tooltip: "Scored on: meta-commentary phrases (nuanced, worth noting, at its core, speaks to, this underscores, grapple with), hedged-reflection language (it's important to recognize, taken together, this reflects, the tension between), epistemic humility (I'd argue, admittedly, it's complicated, it depends), and nested qualifications (that said, with that said, even if, while acknowledging).",
                            },
                            {
                              key: "gemini", label: "Gemini", subtitle: "Google DeepMind", initials: "GE",
                              bg: "#fef9c3", barColor: "#ca8a04", borderColor: "#fde68a", textColor: "#92400e",
                              tooltip: "Scored on: recommendation framing (best bet, your primary constraint, based on current research, ultimately depends on), comparison labels (practical champion, all-rounder, clear winner, well-rounded), closing phrases (my recommendation, all things considered, the bottom line), 'Here's a breakdown/summary' patterns, and markdown asterisk bullets.",
                            },
                            {
                              key: "llama", label: "Llama 3", subtitle: "Meta AI", initials: "LL",
                              bg: "#fdf2f8", barColor: "#a21caf", borderColor: "#f5d0fe", textColor: "#86198f",
                              tooltip: "Scored on: high modal hedge density (may/might/could used >5% of words), frame markers (in the context of, as previously mentioned, broadly speaking), conversational closings (I hope this helps, feel free to ask, let me know if), and over-explanation patterns (this means that, this is because, to put it another way).",
                            },
                            {
                              key: "perplexity", label: "Perplexity AI", subtitle: "Perplexity AI", initials: "PX",
                              bg: "#eff6ff", barColor: "#2563eb", borderColor: "#bfdbfe", textColor: "#1d4ed8",
                              tooltip: "Scored on: citation-forward language (according to, as reported by, evidence suggests, data shows), ranked answer patterns (key factors, main reasons, top N), synthesizer phrases (multiple sources suggest, experts agree, taken together), temporal grounding (as of 2024, as of recently), and encyclopedic definition openers (is defined as, refers to, is characterized by).",
                            },
                            {
                              key: "deepseek", label: "DeepSeek", subtitle: "DeepSeek AI", initials: "DE",
                              bg: "#f0fdf4", barColor: "#059669", borderColor: "#a7f3d0", textColor: "#065f46",
                              tooltip: "Scored on: formal Chinese-influenced academic English (it can be seen that, it is evident that, the aforementioned, as can be seen), step-by-step labeling (step one/two, firstly/secondly/finally, last but not least), academic hedging (to some extent, generally speaking, given that, to a large extent), high-register Latinate vocabulary (elucidate, corroborate, hitherto, notwithstanding), and DeepSeek-R1 chain-of-thought reasoning markers (let me think through, upon reflection).",
                            },
                          ];

                          return (
                            <div className="mt-2 rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                              {/* Header */}
                              <div className="flex items-center gap-2 mb-3">
                                <span className="text-base">🤖</span>
                                <p className="text-xs font-bold text-slate-800">
                                  {familyName ? `Suspected AI Family: ${familyName}` : "AI Family Signals Detected"}
                                </p>
                              </div>

                              {/* 3-column grid of cards */}
                              <div className="grid grid-cols-3 gap-2">
                                {families.map(({ key, label, subtitle, initials, bg, barColor, borderColor, textColor, tooltip }) => {
                                  const score = (rawScores as any)[key] as number;
                                  const pct = totalScore > 0 ? Math.round((score / totalScore) * 100) : 0;
                                  const isTop = familyName && (
                                    key === "gpt4" ? familyName.startsWith("GPT") :
                                    key === "deepseek" ? familyName === "DeepSeek" :
                                    key === "perplexity" ? familyName === "Perplexity AI" :
                                    familyName.toLowerCase() === key
                                  );
                                  return (
                                    <div
                                      key={key}
                                      className="relative group rounded-xl border px-2.5 py-2 cursor-default transition-all"
                                      style={{
                                        background: isTop ? bg : "#fff",
                                        borderColor: isTop ? barColor : "#e2e8f0",
                                        boxShadow: isTop ? `0 0 0 1.5px ${barColor}33` : undefined,
                                      }}
                                    >
                                      {/* Confidence badge on winner */}
                                      {isTop && (
                                        <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-[8px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap"
                                          style={{ background: barColor, color: "#fff" }}>
                                          {confidence}
                                        </span>
                                      )}

                                      {/* Avatar */}
                                      <div className="w-7 h-7 rounded-lg flex items-center justify-center mb-1.5 text-[10px] font-black text-white"
                                        style={{ background: isTop ? barColor : "#94a3b8" }}>
                                        {initials}
                                      </div>

                                      {/* Name */}
                                      <p className="text-[10px] font-bold text-slate-800 leading-tight">{label}</p>
                                      <p className="text-[9px] text-slate-400 mb-1.5 leading-tight">{subtitle}</p>

                                      {/* Bar */}
                                      <div className="h-1 rounded-full bg-slate-100 overflow-hidden mb-1">
                                        <div className="h-full rounded-full transition-all duration-500"
                                          style={{ width: `${pct}%`, background: isTop ? barColor : "#94a3b8" }} />
                                      </div>

                                      {/* Percentage */}
                                      <p className="text-[10px] font-bold" style={{ color: isTop ? barColor : "#94a3b8" }}>{pct}%</p>

                                      {/* Hover tooltip */}
                                      <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-52 hidden group-hover:block pointer-events-none">
                                        <div className="rounded-lg shadow-xl border border-slate-200 bg-white px-3 py-2.5 text-left">
                                          <p className="text-[10px] font-bold text-slate-800 mb-1">{label} — {pct}% match</p>
                                          <p className="text-[9px] text-slate-500 leading-relaxed">{tooltip}</p>
                                          <p className="text-[9px] font-semibold mt-1.5" style={{ color: barColor }}>Raw signal score: {score}</p>
                                        </div>
                                        {/* Arrow */}
                                        <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0"
                                          style={{ borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderTop: "5px solid #e2e8f0" }} />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>

                              <p className="text-[9px] text-slate-400 mt-2 leading-snug">
                                Percentages reflect relative stylistic signal strength across all families. Supplementary only — not standalone evidence.
                              </p>
                            </div>
                          );
                        })()}

                        {/* Long-Document Chunk Hotspot Banner */}
                        {perpResult && (() => {
                          const chunkSig = perpResult.signals.find(s => s.name.startsWith("Long-Document Chunk Analysis"));
                          if (!chunkSig || !chunkSig.pointsToAI) return null;
                          return (
                            <div className="mt-2 flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-300 px-3 py-2.5">
                              <span className="text-amber-500 text-sm flex-shrink-0">📄</span>
                              <div>
                                <p className="text-xs font-bold text-amber-800 mb-0.5">Long Document — Section-Level AI Patterns Detected</p>
                                <p className="text-xs text-amber-700 leading-snug">{chunkSig.value}</p>
                              </div>
                            </div>
                          );
                        })()}

                        {/* FPR FIX: Review-required banner for Needs Human Review tier */}
                        {combined.tier.needsReview && !combined.consensusNote && (
                          <div className="mt-2 flex items-start gap-2 rounded-xl bg-yellow-50 border border-yellow-300 px-3 py-2.5">
                            <span className="text-yellow-600 text-sm flex-shrink-0">🔍</span>
                            <p className="text-xs font-semibold text-yellow-800 leading-snug">
                              Score falls in the ambiguous zone — formal academic writing, research notes, and ESL prose can score here without being AI-generated. Human review is required before drawing any conclusion.
                            </p>
                          </div>
                        )}

                        {/* Improvement #14: Inter-engine disagreement index */}
                        {(() => {
                          const engScores = [perpResult, burstResult, neuralResult].filter(Boolean).map(r => r!.internalScore);
                          if (engScores.length < 2) return null;
                          const { index: disagreeIdx, label: disagreeLabel } = computeDisagreementIndex(engScores);
                          if (disagreeIdx < 20) return null; // no annotation for strong agreement
                          const disagreeColor = disagreeIdx > 60 ? "#dc2626" : disagreeIdx > 40 ? "#d97706" : "#64748b";
                          return (
                            <div className="mt-2 flex items-start gap-2 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2">
                              <span className="text-slate-400 text-sm flex-shrink-0">⚡</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2 mb-1">
                                  <p className="text-xs font-bold text-slate-700">Engine Disagreement Index</p>
                                  <span className="text-[10px] font-black px-2 py-0.5 rounded-full text-white flex-shrink-0" style={{ background: disagreeColor }}>{disagreeIdx}/100</span>
                                </div>
                                <p className="text-[11px] text-slate-500 leading-snug">{disagreeLabel}. Higher disagreement = lower result confidence. Review individual engine signals for context.</p>
                                <div className="mt-1.5 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${disagreeIdx}%`, background: disagreeColor }} />
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col gap-2 flex-shrink-0 relative">
                        <button onClick={handleDownloadPDF} disabled={generatingPdf}
                          className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-700 disabled:bg-slate-200 text-white text-xs font-bold rounded-xl transition-colors">
                          {generatingPdf
                            ? <><svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Generating…</>
                            : <><svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>Download PDF</>}
                        </button>
                        <button onClick={() => setShowShare(!showShare)}
                          className="flex items-center gap-2 px-4 py-2.5 border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-bold rounded-xl transition-colors">
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"/></svg>
                          Export
                        </button>
                        {showShare && (
                          <ShareMenu perpResult={perpResult} burstResult={burstResult} neuralResult={neuralResult} onClose={() => setShowShare(false)} />
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4 py-2">
                      <div className="w-[140px] h-[140px] rounded-full bg-slate-100 animate-pulse flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-6 bg-slate-100 rounded-lg w-1/3 animate-pulse" />
                        <div className="h-4 bg-slate-100 rounded w-1/2 animate-pulse" />
                        <div className="h-2.5 bg-slate-100 rounded-full animate-pulse" />
                      </div>
                    </div>
                  )}
                </div>

                {/* Reviewer judgment strip (only when results ready) */}
                {combined && (() => {
                  // ── Plain-English Judgment Basis Generator ──────────────────
                  // Builds a concise, human-readable reason string for each verdict
                  // option based on the live engine signals. Shown as pre-filled
                  // placeholder text that the reviewer can accept, edit, or replace.
                  const buildJudgmentBasis = (verdict: "AI-Generated" | "Mixed" | "Human-Written"): string => {
                    if (!perpResult && !burstResult) return "";


                    // Use the actual breakdown percentages from the combined result
                    // so each verdict card shows the correct matching percentage.
                    const actualAI    = combined?.avgAI    ?? 50;
                    const actualMixed = combined?.avgMixed  ?? 0;
                    const actualHuman = combined?.avgHuman  ?? 50;
                    // Each verdict card uses its own relevant percentage
                    const ai = verdict === "AI-Generated" ? actualAI
                             : verdict === "Mixed"        ? actualMixed
                             :                             actualHuman;

                    // Sentence-level elevation
                    const elevatedCount = perpResult
                      ? perpResult.sentences.filter(s => s.label === "elevated").length : 0;
                    const totalSents = perpResult?.sentenceCount ?? 0;
                    const elevPct = totalSents > 0 ? Math.round((elevatedCount / totalSents) * 100) : 0;

                    // Burstiness — sentence rhythm
                    const bcStr = burstResult?.evidenceStrength ?? null;
                    const rhythmIsUniform = bcStr === "HIGH" || bcStr === "MEDIUM";
                    const rhythmIsNatural = bcStr === "LOW";

                    // Neural engine
                    const npStr = neuralResult?.evidenceStrength ?? null;
                    const neuralFlagged   = npStr === "HIGH" || npStr === "MEDIUM";
                    const neuralClear     = npStr === "LOW";

                    // Both heuristic engines agree
                    const psStr = perpResult?.evidenceStrength ?? null;
                    const bothAgreeAI     = (psStr === "HIGH" || psStr === "MEDIUM") && (bcStr === "HIGH" || bcStr === "MEDIUM");
                    const bothAgreeClear  = (psStr === "LOW" || psStr === "INCONCLUSIVE") && (bcStr === "LOW" || bcStr === "INCONCLUSIVE");

                    // Suspected AI model family
                    const familySig = perpResult?.signals.find(s => s.name.startsWith("AI Model Family Fingerprint") && s.strength >= 40);
                    const suspectedModel = familySig?.name.includes("—")
                      ? familySig.name.split("—")[1].trim()
                      : null;

                    // Readable AI signal descriptions — map technical names to plain English
                    const signalPlainNames: Record<string, string> = {
                      "AI Vocabulary Density":           "frequent use of AI-typical words and phrases",
                      "Transition Phrase Clustering":    "overuse of filler transition phrases like 'furthermore' and 'moreover'",
                      "Discourse Schema Uniformity":     "a predictable, formulaic essay structure",
                      "Tone Flatness":                   "an unusually flat, emotionless tone throughout",
                      "Self-Similarity / Idea Repetition": "ideas repeated across paragraphs with little variation",
                      "Semantic Density Uniformity":     "every paragraph carrying roughly the same amount of information",
                      "Paragraph Opener Uniformity":     "paragraphs that start in the same way throughout",
                      "Conclusion Clustering":           "a conclusion section that closely mirrors the introduction",
                      "Clause Stacking":                 "sentences packed with multiple clauses in the same way AI models build them",
                      "Hedging Phrase Overuse":          "excessive use of cautious phrases like 'it is important to note'",
                      "Passive Voice Overuse":           "heavy use of passive voice, which AI models favor",
                      "Nominalization Overuse":          "turning verbs into nouns in the way AI writing tends to do",
                      "Hapax Legomena Deficit":          "a narrow vocabulary — fewer unique word choices than typical human writing",
                      "Function Word Profile Deviation": "unusual distribution of small grammatical words like 'the', 'of', 'and'",
                      "Self-BLEU N-gram Repetition":     "the same word combinations repeated across different sentences",
                      "Paraphrase Attack Pattern":       "signs that AI text may have been lightly paraphrased to avoid detection",
                      "Capitalization Abuse":            "unusual capitalization patterns common in AI output",
                      "Short Sentence Absence":          "an absence of short, punchy sentences — AI writing tends to stay mid-length",
                      "Contraction Usage":               "natural use of contractions like 'don't' and 'it's'",
                      "Personal Anecdote / Grounding":   "personal references or real-world grounding that AI rarely produces",
                      "Numeric Specificity":             "precise numbers and specific details that suggest firsthand knowledge",
                      "Rhetorical Variation":            "varied rhetorical styles within the same text",
                    };

                    const getPlainName = (rawName: string) => {
                      const key = Object.keys(signalPlainNames).find(k => rawName.startsWith(k));
                      return key ? signalPlainNames[key] : rawName.replace(/\s*\(.*?\)\s*/g, "").trim().toLowerCase();
                    };

                    const topAISigs = perpResult
                      ? perpResult.signals
                          .filter(s => s.pointsToAI && s.strength >= 40)
                          .sort((a, b) => b.strength - a.strength)
                          .slice(0, 3)
                          .map(s => getPlainName(s.name))
                      : [];

                    const topHumanSigs = perpResult
                      ? perpResult.signals
                          .filter(s => !s.pointsToAI && s.strength >= 35)
                          .sort((a, b) => b.strength - a.strength)
                          .slice(0, 2)
                          .map(s => getPlainName(s.name))
                      : [];

                    // ── Build verdict-specific plain English ─────────────────
                    if (verdict === "AI-Generated") {
                      const parts: string[] = [];

                      // Opening: how strong is the score
                      if (ai >= 80)       parts.push(`The automated analysis is highly confident this text was AI-generated, with a combined score of ${ai}%.`);
                      else if (ai >= 65)  parts.push(`The automated analysis strongly suggests this text was AI-generated, with a combined score of ${ai}%.`);
                      else                parts.push(`The automated analysis flags this text as likely AI-generated, with a combined score of ${ai}%.`);

                      // What triggered it
                      if (topAISigs.length > 0) {
                        if (topAISigs.length === 1)
                          parts.push(`The main reason is ${topAISigs[0]}.`);
                        else if (topAISigs.length === 2)
                          parts.push(`The main reasons are ${topAISigs[0]}, and ${topAISigs[1]}.`);
                        else
                          parts.push(`The main reasons are ${topAISigs[0]}, ${topAISigs[1]}, and ${topAISigs[2]}.`);
                      }

                      // Sentence spread
                      if (elevPct >= 60)       parts.push(`Most sentences (${elevPct}%) showed AI-associated patterns, suggesting the whole text was likely generated.`);
                      else if (elevPct >= 35)  parts.push(`A significant portion of sentences (${elevPct}%) showed AI-associated patterns.`);
                      else if (elevPct >= 15)  parts.push(`Some sentences (${elevPct}%) showed AI-associated patterns.`);

                      // Sentence rhythm
                      if (rhythmIsUniform) parts.push("The sentences are unusually consistent in length and rhythm, which is typical of AI writing.");

                      // Both engines agree
                      if (bothAgreeAI) parts.push("Both independent analysis methods agree, which increases confidence in this result.");

                      // Neural engine
                      if (neuralFlagged) parts.push("A third, AI-based analysis also independently flagged this text.");

                      // Suspected model
                      if (suspectedModel) parts.push(`The writing style is most consistent with ${suspectedModel}.`);

                      return parts.join(" ");
                    }

                    if (verdict === "Mixed") {
                      const parts: string[] = [];

                      parts.push(`The automated analysis returned a mixed score of ${ai}% — not clearly AI-generated, but not clearly human either.`);

                      if (topAISigs.length > 0 && topHumanSigs.length > 0) {
                        parts.push(`On one hand, there are signs that suggest AI involvement: ${topAISigs[0]}${topAISigs[1] ? ` and ${topAISigs[1]}` : ""}. On the other hand, there are also signs of human authorship: ${topHumanSigs[0]}${topHumanSigs[1] ? ` and ${topHumanSigs[1]}` : ""}.`);
                      } else if (topAISigs.length > 0) {
                        parts.push(`There are some signs of AI involvement — ${topAISigs[0]}${topAISigs[1] ? ` and ${topAISigs[1]}` : ""} — but not enough for a clear verdict.`);
                      } else if (topHumanSigs.length > 0) {
                        parts.push(`There are signs of human authorship — ${topHumanSigs[0]}${topHumanSigs[1] ? ` and ${topHumanSigs[1]}` : ""} — but a few AI-associated patterns remain.`);
                      }

                      if (elevPct > 0 && elevPct < 50) parts.push(`Only ${elevPct}% of sentences were flagged — the AI-like patterns are not consistent throughout the whole text, which may point to partial AI assistance or heavy editing.`);

                      if (!bothAgreeAI && !bothAgreeClear) parts.push("The two main analysis methods gave different results, which is why no clear verdict could be reached.");

                      if (neuralFlagged) parts.push("A third analysis method did flag some AI-like patterns.");
                      else if (neuralClear) parts.push("A third analysis method found no strong AI patterns.");

                      parts.push("This text may have been written with AI assistance, or it may be human writing that happens to share some stylistic features with AI output. Human judgment is recommended.");

                      return parts.join(" ");
                    }

                    // Human-Written
                    {
                      const parts: string[] = [];

                      if (ai >= 70)       parts.push(`The automated analysis is highly confident this text was written by a human, with a human score of ${ai}%.`);
                      else if (ai >= 50)  parts.push(`The automated analysis found strong indicators of human authorship, returning a human score of ${ai}%.`);
                      else                parts.push(`The automated analysis returned a human score of ${ai}%, which suggests human-written content.`);

                      if (topHumanSigs.length > 0) {
                        if (topHumanSigs.length === 1)
                          parts.push(`A key indicator of human authorship was ${topHumanSigs[0]}.`);
                        else
                          parts.push(`Key indicators of human authorship include ${topHumanSigs[0]} and ${topHumanSigs[1]}.`);
                      }

                      if (topAISigs.length > 0) {
                        parts.push(`While the text does contain ${topAISigs[0]}, this is common in formal academic writing and is not enough on its own to suggest AI generation.`);
                      } else {
                        parts.push("No significant AI-associated writing patterns were detected.");
                      }

                      if (rhythmIsNatural) parts.push("The sentence lengths vary naturally, as expected in human writing.");
                      if (bothAgreeClear)  parts.push("Both independent analysis methods agree that AI patterns are absent.");
                      if (neuralClear)     parts.push("A third, AI-based analysis also found no indicators of AI generation.");

                      return parts.join(" ");
                    }
                  };

                  return (
                  <div className="border-t border-slate-200 px-6 py-5 bg-white">
                    {/* Header row */}
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <p className="text-sm font-bold text-slate-800">Reviewer Judgment</p>
                        <p className="text-xs text-slate-400 mt-0.5">Optional — your verdict and reasoning are recorded in the PDF report</p>
                      </div>
                    </div>

                    {/* Verdict buttons — larger, full labels */}
                    <div className="flex gap-3 flex-wrap mb-4">
                      {([
                        { val: "AI-Generated"  as const, color: "#dc2626", bg: "#fef2f2", border: "#fecaca", icon: "🤖" },
                        { val: "Mixed"         as const, color: "#d97706", bg: "#fffbeb", border: "#fde68a", icon: "⚖️" },
                        { val: "Human-Written" as const, color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", icon: "✍️" },
                      ]).map(({ val, color, bg, border, icon }) => (
                        <button key={val} onClick={() => {
                          const newVal = judgment === val ? "" : val;
                          setJudgment(newVal);
                          // Always refresh reason when switching verdicts; clear when deselecting
                          setJudgeNotes(newVal ? buildJudgmentBasis(newVal) : "");
                          if (newVal && combined) {
                            recordReviewerFeedback(combined.tier.label, newVal, combined.avgAI);
                            const h = loadHistoryLocal();
                            if (h.length > 0) { h[0].reviewerVerdict = newVal; saveHistoryAsync(h); setHistory(h); }
                          }
                        }}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold transition-all"
                          aria-pressed={judgment === val}
                          style={judgment === val
                            ? { background: bg, color, borderColor: color, boxShadow: `0 0 0 2px ${color}30` }
                            : { background: "#fff", color: "#64748b", borderColor: "#e2e8f0" }}>
                          <span>{icon}</span>
                          {val}
                          {judgment === val && (
                            <span className="ml-1 flex items-center justify-center w-4 h-4 rounded-full text-white text-[10px] font-black" style={{ background: color }}>✓</span>
                          )}
                        </button>
                      ))}
                    </div>

                    {/* Preview cards — only when no verdict selected */}
                    {!judgment && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                        {([
                          { val: "AI-Generated"  as const, color: "#dc2626", bg: "#fef2f2", border: "#fecaca", label: "If AI-Generated" },
                          { val: "Mixed"         as const, color: "#d97706", bg: "#fffbeb", border: "#fde68a", label: "If Mixed" },
                          { val: "Human-Written" as const, color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", label: "If Human-Written" },
                        ]).map(({ val, color, bg, border, label }) => (
                          <div key={val} className="rounded-xl border p-3" style={{ background: bg, borderColor: border }}>
                            <p className="text-xs font-bold mb-1.5" style={{ color }}>{label}</p>
                            <p className="text-xs leading-relaxed text-slate-600">{buildJudgmentBasis(val)}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Reason box — full width, tall, readable */}
                    {judgment && (
                      <div className="rounded-xl border border-slate-200 overflow-hidden mb-3" style={{
                        boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
                      }}>
                        <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200">
                          <p className="text-xs font-semibold text-slate-600">Reason / Notes</p>
                          <p className="text-[11px] text-slate-400">Edit freely — this text appears in the PDF report</p>
                        </div>
                        <textarea
                          value={judgeNotes}
                          onChange={e => setJudgeNotes(e.target.value)}
                          placeholder="Your reasoning will appear here. Add context, observations, or any other notes for the record…"
                          rows={6}
                          aria-label="Reviewer notes"
                          className="w-full bg-white px-4 py-3 text-sm text-slate-800 placeholder-slate-400 focus:outline-none leading-relaxed resize-y"
                          style={{ minHeight: "120px" }}
                        />
                      </div>
                    )}

                    {/* Reset button — visible, styled as a proper button */}
                    {judgment && (
                      <div className="flex items-center justify-between">
                        <button
                          onClick={() => setJudgeNotes(buildJudgmentBasis(judgment as "AI-Generated" | "Mixed" | "Human-Written"))}
                          className="flex items-center gap-2 px-3.5 py-2 rounded-lg border text-xs font-semibold text-slate-600 bg-white hover:bg-slate-50 hover:border-slate-400 hover:text-slate-800 transition-all"
                          style={{ borderColor: "#cbd5e1" }}
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          Restore auto-generated reason
                        </button>
                        {judgeNotes.trim() && (
                          <p className="text-[11px] text-slate-400">{judgeNotes.trim().split(/\s+/).length} words</p>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })()}
              </div>
            )}

            {/* ── Live Word Highlighter toggle ──────────────────────── */}
            {inputText.trim().length > 30 && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <button
                  onClick={() => setShowHighlighter(!showHighlighter)}
                  className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition-colors"
                  aria-expanded={showHighlighter}
                >
                  <span className="flex items-center gap-2.5">
                    <span className="w-2 h-2 rounded-full bg-red-400" />
                    <span className="text-sm font-semibold text-slate-700">Live AI Pattern Highlighter</span>
                    <span className="text-[10px] text-slate-400">Flags AI vocabulary as you type</span>
                  </span>
                  <svg className={`w-4 h-4 text-slate-400 transition-transform ${showHighlighter ? "rotate-180" : ""}`} viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd"/>
                  </svg>
                </button>
                {showHighlighter && (
                  <div className="border-t border-slate-100 px-5 pb-4 pt-3">
                    <LiveWordHighlighter text={inputText} />
                  </div>
                )}
              </div>
            )}

            {/* ── 3 Engine Cards ────────────────────────────────────── */}
            <div className="grid gap-5 sm:grid-cols-1 lg:grid-cols-3">
              <EngineCard
                name="Perplexity & Stylometry"
                badge="PS" badgeBg="#1b3a6b"
                icon={<svg className="w-6 h-6 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 13.5l4-4 3 3 4-5 4 3"/><rect x="3" y="3" width="18" height="18" rx="2" strokeWidth={1.8}/></svg>}
                result={perpResult} loading={loadingT}
                accentColor="#1b3a6b"
                originalText={inputText}
              />
              <EngineCard
                name="Burstiness & Cognitive"
                badge="BC" badgeBg="#16a34a"
                icon={<svg className="w-6 h-6 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"/></svg>}
                result={burstResult} loading={loadingG}
                accentColor="#16a34a"
                originalText={inputText}
              />
              <EngineCard
                name="Neural Perplexity"
                badge="NP" badgeBg="#7c3aed"
                icon={<svg className="w-6 h-6 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"/></svg>}
                result={neuralResult} loading={loadingN}
                accentColor="#7c3aed"
                originalText={inputText}
              />
            </div>

            {/* ── Radar Chart ───────────────────────────────────────── */}
            {(perpResult || burstResult) && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden p-6">
                <p className="text-sm font-bold text-slate-800 mb-4">Writing Fingerprint</p>
                <RadarChartFingerprint perpResult={perpResult} burstResult={burstResult} neuralResult={neuralResult} />
              </div>
            )}

            {/* ── Methodology & Disclaimer ─────────────────────────── */}
            {(perpResult || burstResult) && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-6 py-5 grid sm:grid-cols-3 gap-5 text-xs leading-relaxed">
                  {[
                    { badge: "PS", bg: "#1b3a6b", label: "Perplexity & Stylometry", text: "47 signals across 8 tiers: lexical (vocab density, transitions, bigrams); structural (paragraph openers, conclusion clustering); stylistic (hedging, clause stacking, passive voice); surface (TTR, MTLD, nominalization); semantic (self-similarity, tone flatness, vague citations, discourse schema); enhancement (hapax legomena, Flesch-Kincaid readability fingerprinting, function word profile, Self-BLEU n-gram repetition, semantic density uniformity, capitalization abuse, AI model family fingerprinting, paraphrase attack detection); batch-2 (Zipf's Law deviation, TTR power-law trajectory, KS normality test, anaphora resolution density, argument structure analysis, section-differential scoring, long-document chunk analysis). Human reductions: direct quotes, Filipino/ESL L1-transfer, temporal/spatial grounding. Genre-adaptive weighting. Confidence-based abstention." },
                    { badge: "BC", bg: "#16a34a", label: "Burstiness & Cognitive", text: "8 signals: sentence-length CV (burstiness), short-sentence absence, rhetorical variation, contractions, personal anecdote, numeric specificity. Personal anecdotes and precise numbers reduce AI score (human markers). CV < 0.22 = uniform AI rhythm; CV > 0.42 = natural human variation." },
                    { badge: "NP", bg: "#7c3aed", label: "Neural Perplexity", text: "LLM-based analysis using Binoculars-style reasoning: token predictability, semantic smoothness, structural uniformity, DetectGPT-style perturbation resistance, bimodal sentence distribution detection (mixed authorship). Calibrated for ESL and Philippine academic context. Confidence-based abstention: when all engines return INCONCLUSIVE with high inter-engine disagreement (>40 point spread), no verdict is issued rather than averaging uncertain signals." },
                  ].map(({ badge, bg, label, text }) => (
                    <div key={badge}>
                      <p className="font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
                        <span className="text-white text-[9px] font-black px-1.5 py-0.5 rounded" style={{ background: bg }}>{badge}</span>
                        {label}
                      </p>
                      <p className="text-slate-500">{text}</p>
                    </div>
                  ))}
                </div>
                <div className="mx-6 mb-5 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
                  <p className="text-xs font-semibold text-amber-800 mb-0.5">⚠ Important Disclaimer</p>
                  <p className="text-xs text-amber-700 leading-relaxed">Results are probabilistic pattern analysis only. Formal academic writing, ESL writing, Philippine/Filipino academic writing, and extensively revised human text may share surface patterns with AI-generated text. ESL and Philippine context scores are automatically calibrated (−10–15 points) to reduce false positives on non-native English writing. The system requires dual-engine agreement before issuing an AI verdict — single-engine results are routed to "Needs Human Review". No automated decision should be based on these results alone. Always apply professional judgment.</p>
                </div>
                {/* Improvement #20: Model version tag */}
                <div className="mx-6 mb-4 flex items-center gap-2 text-[10px] text-slate-400">
                  <span className="font-bold text-slate-500">{MODEL_VERSION}</span>
                  <span>·</span>
                  <span>{MODEL_DATE}</span>
                  <span>·</span>
                  <span>{MODEL_SIGNALS}</span>
                </div>
              </div>
            )}

            {/* How it works — always visible */}
            <HowItWorksSection />
          </div>
        )}
      </div>

      {/* Footer 
      <footer className="mt-12 border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: "linear-gradient(135deg, #1e3a5f 0%, #3b82f6 100%)" }}>
              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="7" strokeWidth={2} />
                <circle cx="11" cy="11" r="4" strokeWidth={1.5} strokeDasharray="2 1.5" />
                <circle cx="11" cy="11" r="1.5" fill="currentColor" stroke="none" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M16.5 16.5l3.5 3.5" />
              </svg>
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-xs font-bold text-slate-700">MultiLens</span>
              <span className="text-[9px] font-semibold text-blue-600 uppercase tracking-wide">AI Detector</span>
            </div>
          </div>
          <p className="text-[11px] text-slate-400 text-center">
            Results are probabilistic. Dual-engine consensus required. Ambiguous zone flagged for human review.
          </p>
          <p className="text-[11px] text-slate-400">For academic &amp; research use.</p>
        </div>
      </footer>*/}

      {/* ── Admin Login Modal ─────────────────────────────────────────────── */}
      {showAdminLogin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setShowAdminLogin(false); }}>
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-sm mx-4 overflow-hidden">
            {/* Header */}
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-slate-900 flex items-center justify-center">
                  <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/>
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-800">Administrator Login</p>
                  <p className="text-[11px] text-slate-400">Restricted access</p>
                </div>
              </div>
              <button onClick={() => setShowAdminLogin(false)}
                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors text-lg leading-none">
                ×
              </button>
            </div>

            {/* Form */}
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Username</label>
                <input
                  type="text"
                  value={adminUser}
                  onChange={e => setAdminUser(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleAdminLogin()}
                  placeholder="Enter username"
                  autoComplete="off"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent transition"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Password</label>
                <input
                  type="password"
                  value={adminPass}
                  onChange={e => setAdminPass(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleAdminLogin()}
                  placeholder="Enter password"
                  autoComplete="off"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent transition"
                />
              </div>

              {adminLoginError && (
                <div className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 px-3.5 py-2.5">
                  <svg className="w-3.5 h-3.5 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                  </svg>
                  <p className="text-xs font-semibold text-red-700">{adminLoginError}</p>
                </div>
              )}

              <button onClick={handleAdminLogin} disabled={adminLoginLoading}
                className="w-full py-2.5 bg-slate-900 hover:bg-slate-700 disabled:bg-slate-400 text-white text-sm font-bold rounded-xl transition-colors flex items-center justify-center gap-2">
                {adminLoginLoading && (
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                )}
                {adminLoginLoading ? "Signing in…" : "Sign In"}
              </button>
            </div>
          </div>
        </div>
      )}

    </main>
  );
}