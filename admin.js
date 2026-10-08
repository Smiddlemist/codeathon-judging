import {
  auth, db, ADMIN_EMAIL, firebaseConfig,
  sendPasswordResetEmail, onAuthStateChanged, signOut
} from "./firebase-init.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signOut as secondarySignOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  collection, doc, addDoc, setDoc, deleteDoc, updateDoc, deleteField, onSnapshot, query, orderBy,
  writeBatch, getDocs, getDoc, limit
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const notAdminScreen = document.getElementById("notAdminScreen");
const dashboard = document.getElementById("dashboard");
const logoutBtn = document.getElementById("logoutBtn");
const adminBadge = document.getElementById("adminBadge");

let teams = [];
let judges = [];
let scores = [];
let criteria = []; // [{id, label, weight, description, levels, order}]  levels = array of 5 strings (score 1..5), or [] if not set
const LEVEL_COUNT = 5;
let minJudgesPerTeam = 3; // teams with fewer submitted scorecards than this are flagged as under-covered
let teamPenaltyValue = 0; // flat points deducted from a team's overall weighted score when penalized

// Tracks whether each collection's FIRST snapshot has arrived yet, so tables
// can show a "Loading…" state instead of a misleading empty flash before
// data shows up.
const loaded = { teams: false, judges: false, scores: false, criteria: false };
function loadingRow(colspan) {
  return `<tr><td colspan="${colspan}" class="muted">Loading…</td></tr>`;
}

// ---------- Idle timeout ----------
// Same as judge.html: after this many milliseconds of no activity while
// signed in, sign out and send the admin back to the poster landing page.
// Keeps a shared/kiosk device from staying logged into the admin console
// indefinitely. Change the number below to adjust the timeout.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
let idleActive = false;
let idleTimer = null;

function resetIdleTimer() {
  if (!idleActive) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    idleActive = false;
    try { await signOut(auth); } catch (e) { /* already signed out elsewhere */ }
    window.location.href = "index.html";
  }, IDLE_TIMEOUT_MS);
}

["mousemove", "mousedown", "keydown", "touchstart", "scroll"].forEach((evt) => {
  window.addEventListener(evt, resetIdleTimer, { passive: true });
});

const NOMINATION_LABELS = {
  recommend: "Recommend for further development",
  mostCreative: "Most creative / innovative",
  highestImpact: "Highest business impact",
  bestDemo: "Best demo / presentation",
  fanFavorite: "Fan favorite"
};

// ---------- Auth ----------
// admin.html has no login form of its own -- the only supported entry point
// is signing in at judge.html and clicking "Admin Console." If someone lands
// here directly without an active admin session, we send them there instead
// of showing a redundant second login screen.
logoutBtn.addEventListener("click", () => signOut(auth));

document.getElementById("backToScorecardBtn").addEventListener("click", () => {
  window.location.href = "judge.html";
});

onAuthStateChanged(auth, (user) => {
  if (user && user.email === ADMIN_EMAIL) {
    notAdminScreen.classList.add("hidden");
    dashboard.classList.remove("hidden");
    adminBadge.textContent = "👤 " + user.email;
    startListeners();
    idleActive = true;
    resetIdleTimer();
  } else {
    // Either signed out, or signed in as some other account elsewhere in this
    // browser (e.g. a judge's session in another tab, sharing the same
    // Firebase Auth session). Either way, bounce to the single sign-in page --
    // don't sign anything out from a passive listener, since that would also
    // kill that other, legitimate session.
    dashboard.classList.add("hidden");
    idleActive = false;
    if (idleTimer) clearTimeout(idleTimer);
    window.location.href = "judge.html";
  }
});

// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});


// ---------- Firestore rules check ----------
// Listener failures used to be silent (tables just sat on "Loading..."). Now any failure
// shows a banner naming what was blocked and the usual causes, and the "Check rules"
// button in the header runs a read test on every collection plus a harmless write test.
const rulesBanner = document.getElementById("rulesBanner");
const failedTargets = {}; // target -> error code

function signedInEmail() {
  return (auth.currentUser && auth.currentUser.email) || "(unknown)";
}

function permissionHelpHtml() {
  const who = escapeHtml(signedInEmail());
  const adminCfg = escapeHtml(String(ADMIN_EMAIL || "(not set)"));
  return `
    <p style="margin:6px 0 4px;">Usual causes, most likely first:</p>
    <ol style="margin:0 0 6px 18px;padding:0;font-size:13px;line-height:1.5;">
      <li>The Firestore rules still contain a <strong>placeholder admin email</strong> (such as admin@example.com) instead of the real one. You are signed in as <strong>${who}</strong>, and the app's ADMIN_EMAIL is <strong>${adminCfg}</strong>; the rules must name that exact address.</li>
      <li>The rules were edited but <strong>not published</strong> in the Firebase Console (Firestore Database &rarr; Rules &rarr; Publish).</li>
      <li>The rules don't cover this collection at all, so it falls through to deny.</li>
    </ol>`;
}

function showRulesBanner(kind, innerHtml) {
  if (!rulesBanner) return;
  const color = kind === "ok" ? "#4FD1A5" : "var(--sundt-red)";
  rulesBanner.style.borderColor = color;
  rulesBanner.innerHTML = `
    <div class="row between" style="align-items:flex-start;">
      <div style="flex:1;min-width:0;">${innerHtml}</div>
      <button id="rulesBannerClose" class="btn secondary small">Dismiss</button>
    </div>`;
  rulesBanner.classList.remove("hidden");
  document.getElementById("rulesBannerClose").addEventListener("click", () => rulesBanner.classList.add("hidden"));
}

function reportListenerError(target, e) {
  console.error("Listener error on " + target, e);
  failedTargets[target] = e && e.code ? e.code : "error";
  const denied = Object.keys(failedTargets).filter((t) => failedTargets[t] === "permission-denied");
  const other = Object.keys(failedTargets).filter((t) => failedTargets[t] !== "permission-denied");
  let html = "";
  if (denied.length) {
    html += `<strong>⚠ Firestore rules blocked a read of: ${denied.map(escapeHtml).join(", ")}.</strong>` + permissionHelpHtml();
  }
  if (other.length) {
    html += `<p style="margin:6px 0 0;"><strong>⚠ Couldn't load: ${other.map(escapeHtml).join(", ")}</strong> (${other.map((t) => escapeHtml(failedTargets[t])).join(", ")}). Check your connection and reload.</p>`;
  }
  showRulesBanner("error", html);
}

async function runRulesCheck() {
  const btn = document.getElementById("rulesCheckBtn");
  btn.disabled = true;
  const origLabel = btn.textContent;
  btn.textContent = "Checking…";
  const results = [];
  const tryOp = async (label, fn) => {
    try { await fn(); results.push({ label, ok: true }); }
    catch (e) { results.push({ label, ok: false, code: e && e.code ? e.code : "error" }); }
  };
  for (const name of ["teams", "judges", "scores", "criteria"]) {
    await tryOp("Read " + name, () => getDocs(query(collection(db, name), limit(1))));
  }
  await tryOp("Read config/settings", () => getDoc(doc(db, "config", "settings")));
  await tryOp("Write config/settings", () => setDoc(doc(db, "config", "settings"), { rulesCheckedAt: Date.now() }, { merge: true }));

  const failed = results.filter((r) => !r.ok);
  const lines = results.map((r) => `<li>${r.ok ? "✅" : "❌"} ${escapeHtml(r.label)}${r.ok ? "" : ` <span class="muted">(${escapeHtml(r.code)})</span>`}</li>`).join("");
  const list = `<ul style="list-style:none;margin:6px 0;padding:0;font-size:13px;line-height:1.6;">${lines}</ul>`;
  if (failed.length === 0) {
    showRulesBanner("ok", `<strong>✅ Rules check passed.</strong> The admin account can read every collection and write settings.${list}<p class="muted" style="font-size:12px;margin:0;">This tests the admin account only. Judge-side saves (writing scorecards) can't be tested from here, so do one test judge save after any rules change. The write test sets a harmless "rulesCheckedAt" field on config/settings.</p>`);
  } else {
    const anyDenied = failed.some((r) => r.code === "permission-denied");
    showRulesBanner("error", `<strong>❌ Rules check found ${failed.length} problem${failed.length === 1 ? "" : "s"}.</strong>${list}${anyDenied ? permissionHelpHtml() : `<p style="margin:0;">These weren't permission errors, so check your connection and try again.</p>`}`);
  }
  btn.disabled = false;
  btn.textContent = origLabel;
}

document.getElementById("rulesCheckBtn").addEventListener("click", runRulesCheck);

// ---------- Live data ----------
function startListeners() {
  onSnapshot(query(collection(db, "teams"), orderBy("name")), (snap) => {
    teams = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    loaded.teams = true;
    renderTeamsTable();
    renderResetSelects();
    renderLeaderboard();
    renderMatrix();
    renderNominationsTable();
    renderPenaltiesTable();
    renderCoverageAlerts();
    renderCalibration();
  }, (e) => reportListenerError("teams", e));
  onSnapshot(query(collection(db, "judges"), orderBy("name")), (snap) => {
    judges = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    loaded.judges = true;
    renderJudgesTable();
    renderResetSelects();
    renderMatrix();
    renderCoverageAlerts();
    renderCalibration();
  }, (e) => reportListenerError("judges", e));
  onSnapshot(collection(db, "scores"), (snap) => {
    scores = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    loaded.scores = true;
    renderLeaderboard();
    renderMatrix();
    renderNominationsTable();
    renderCoverageAlerts();
    renderCalibration();
    document.getElementById("statScores").textContent = scores.length;
  }, (e) => reportListenerError("scores", e));
  onSnapshot(collection(db, "criteria"), (snap) => {
    criteria = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    loaded.criteria = true;
    renderCritTable();
    renderLeaderboard();
    renderMatrix();
    renderCoverageAlerts();
    renderCalibration();
  }, (e) => reportListenerError("criteria", e));
  onSnapshot(doc(db, "config", "settings"), (snap) => {
    teamPenaltyValue = snap.exists() && typeof snap.data().teamPenaltyValue === "number"
      ? snap.data().teamPenaltyValue
      : 0;
    const input = document.getElementById("penaltyValueInput");
    if (input && document.activeElement !== input) input.value = teamPenaltyValue;
    const minVal = snap.exists() ? snap.data().minJudgesPerTeam : undefined;
    minJudgesPerTeam = Number.isInteger(minVal) && minVal >= 1 ? minVal : 3;
    const minInput = document.getElementById("minJudgesInput");
    if (minInput && document.activeElement !== minInput) minInput.value = minJudgesPerTeam;
    renderCoverageAlerts();
    renderCalibration();
    renderLeaderboard();
  }, (e) => reportListenerError("config/settings", e));
}

// ---------- Weighted scoring ----------
function weightedScoreOf(scoreDoc) {
  if (!scoreDoc || !scoreDoc.criteria) return 0;
  let sum = 0;
  let weightTotal = 0;
  criteria.forEach((c) => {
    const val = scoreDoc.criteria[c.id];
    if (typeof val === "number") {
      const w = c.weight ?? 1;
      sum += val * w;
      weightTotal += w;
    }
  });
  return weightTotal > 0 ? sum / weightTotal : 0;
}


// ---------- Outlier detection ----------
// A score is flagged when it is 2+ points away from the median of the OTHER judges'
// scores for the same team and category. Needs at least 3 judges on that team/category
// (so there are 2+ "others" to compare against). Admin-only; judges never see this.
const OUTLIER_GAP = 2;

function medianOf(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Returns a Map keyed "scoreId|criterionId" -> { team, score, criterion, value, median }
function computeOutliers() {
  const out = new Map();
  if (!(loaded.teams && loaded.scores && loaded.criteria)) return out;
  teams.forEach((team) => {
    const teamScores = scores.filter((s) => s.teamId === team.id);
    criteria.forEach((c) => {
      const entries = teamScores
        .map((s) => ({ s, v: s.criteria ? s.criteria[c.id] : undefined }))
        .filter((e) => typeof e.v === "number");
      if (entries.length < 3) return;
      entries.forEach((e) => {
        const others = entries.filter((o) => o !== e).map((o) => o.v);
        const med = medianOf(others);
        if (Math.abs(e.v - med) >= OUTLIER_GAP) {
          out.set(e.s.id + "|" + c.id, { team, score: e.s, criterion: c, value: e.v, median: med });
        }
      });
    });
  });
  return out;
}

// ---------- Coverage alerts + flagged scores ----------
function renderCoverageAlerts() {
  const alertsEl = document.getElementById("coverageAlerts");
  const flagsEl = document.getElementById("outlierList");
  if (!alertsEl || !flagsEl) return;
  if (!(loaded.teams && loaded.judges && loaded.scores && loaded.criteria)) {
    alertsEl.innerHTML = `<p class="muted">Loading…</p>`;
    flagsEl.innerHTML = "";
    return;
  }

  const activeJudges = judges.filter((j) => j.active !== false);
  const under = teams
    .map((t) => {
      const scored = new Set(scores.filter((s) => s.teamId === t.id).map((s) => s.judgeId));
      const missing = activeJudges.filter((j) => !scored.has(j.id)).map((j) => j.name);
      return { team: t, n: scored.size, missing };
    })
    .filter((r) => r.n < minJudgesPerTeam)
    .sort((a, b) => a.n - b.n || (a.team.name || "").localeCompare(b.team.name || ""));

  if (teams.length === 0) {
    alertsEl.innerHTML = `<p class="muted">No teams yet.</p>`;
  } else if (under.length === 0) {
    alertsEl.innerHTML = `<p class="ok-msg" style="margin:0;">✅ Every team has at least ${minJudgesPerTeam} judge${minJudgesPerTeam === 1 ? "" : "s"}.</p>`;
  } else {
    alertsEl.innerHTML =
      `<p style="margin:0 0 8px;color:var(--warn);font-weight:600;">⚠ ${under.length} team${under.length === 1 ? "" : "s"} below the ${minJudgesPerTeam}-judge minimum</p>` +
      `<div class="table-scroll" style="max-height:240px;"><table><thead><tr><th>Team</th><th>Judges so far</th><th>Active judges who haven't scored it</th></tr></thead><tbody>` +
      under.map((r) => `<tr><td>${escapeHtml(r.team.name)}</td><td>${r.n} / ${minJudgesPerTeam}</td><td class="muted" style="white-space:normal;">${r.missing.length ? escapeHtml(r.missing.join(", ")) : "—"}</td></tr>`).join("") +
      `</tbody></table></div>`;
  }

  const flags = [...computeOutliers().values()].sort(
    (a, b) => (a.team.name || "").localeCompare(b.team.name || "") || (a.criterion.label || "").localeCompare(b.criterion.label || "")
  );
  if (flags.length === 0) {
    flagsEl.innerHTML = `<p class="ok-msg" style="margin:0;">✅ No outlier scores (nothing ${OUTLIER_GAP}+ points from the other judges' median).</p>`;
  } else {
    flagsEl.innerHTML =
      `<p style="margin:0 0 8px;color:var(--warn);font-weight:600;">⚠ ${flags.length} score${flags.length === 1 ? "" : "s"} ${OUTLIER_GAP}+ points from the other judges' median</p>` +
      `<div class="table-scroll" style="max-height:300px;"><table><thead><tr><th>Team</th><th>Category</th><th>Judge</th><th>Gave</th><th>Others' median</th></tr></thead><tbody>` +
      flags.map((f) => `<tr><td>${escapeHtml(f.team.name)}</td><td>${escapeHtml(f.criterion.label)}</td><td>${escapeHtml(f.score.judgeName || "Unknown judge")}</td><td><strong>${f.value}</strong></td><td>${Number.isInteger(f.median) ? f.median : f.median.toFixed(1)}</td></tr>`).join("") +
      `</tbody></table></div>`;
  }
}

document.getElementById("saveMinJudgesBtn").addEventListener("click", async () => {
  const input = document.getElementById("minJudgesInput");
  const okEl = document.getElementById("minJudgesOk");
  const errEl = document.getElementById("minJudgesErr");
  errEl.classList.add("hidden");
  okEl.classList.add("hidden");
  const val = Number(input.value);
  if (!Number.isInteger(val) || val < 1) {
    errEl.textContent = "Enter a whole number of 1 or more.";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    await setDoc(doc(db, "config", "settings"), { minJudgesPerTeam: val }, { merge: true });
    okEl.classList.remove("hidden");
    setTimeout(() => okEl.classList.add("hidden"), 2000);
  } catch (e) {
    console.error(e);
    errEl.textContent = e.code === "permission-denied"
      ? "Save failed: permission denied. Your Firestore rules need to let the admin account write the \"config\" collection."
      : "Couldn't save. Check your connection and try again.";
    errEl.classList.remove("hidden");
  }
});


// ---------- Judge calibration + adjusted ranking ----------
// Some judges score harshly, some generously, some barely vary. This view shows each
// judge's average and spread, and a second ranking where every judge's scores are put
// on a common scale (z-score per judge, then mapped back onto the overall mean/spread).
// The raw leaderboard stays the official ranking; this is a sanity check only.
// Judges with fewer than MIN_CARDS_FOR_ADJUST scorecards (or no spread) are left unadjusted.
const MIN_CARDS_FOR_ADJUST = 3;

function meanOf(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function sdOf(a) {
  if (a.length < 2) return 0;
  const m = meanOf(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length);
}

function renderCalibration() {
  const judgeBody = document.querySelector("#calibJudgeTable tbody");
  const teamBody = document.querySelector("#calibTeamTable tbody");
  const summary = document.getElementById("calibSummary");
  if (!judgeBody || !teamBody) return; // tab not in the DOM yet
  if (!(loaded.teams && loaded.judges && loaded.scores && loaded.criteria)) {
    judgeBody.innerHTML = loadingRow(6);
    teamBody.innerHTML = loadingRow(7);
    return;
  }

  const cards = scores
    .filter((s) => s.criteria && criteria.some((c) => typeof s.criteria[c.id] === "number"))
    .map((s) => ({ s, w: weightedScoreOf(s) }));

  if (cards.length === 0) {
    summary.textContent = "";
    judgeBody.innerHTML = `<tr><td colspan="6" class="muted">No scorecards submitted yet.</td></tr>`;
    teamBody.innerHTML = `<tr><td colspan="7" class="muted">No scorecards submitted yet.</td></tr>`;
    return;
  }

  const grandMean = meanOf(cards.map((c) => c.w));
  const grandSD = sdOf(cards.map((c) => c.w));
  summary.textContent = `Across all ${cards.length} scorecards: average ${grandMean.toFixed(2)}, spread (std dev) ${grandSD.toFixed(2)}.`;

  // per-judge stats
  const byJudge = {};
  cards.forEach((c) => {
    const id = c.s.judgeId;
    if (!byJudge[id]) {
      const j = judges.find((x) => x.id === id);
      byJudge[id] = { id, name: (j && j.name) || c.s.judgeName || "Unknown judge", vals: [] };
    }
    byJudge[id].vals.push(c.w);
  });
  Object.values(byJudge).forEach((j) => {
    j.n = j.vals.length;
    j.mean = meanOf(j.vals);
    j.sd = sdOf(j.vals);
    j.bias = j.mean - grandMean;
    j.adjustable = j.n >= MIN_CARDS_FOR_ADJUST && j.sd > 0;
  });

  const judgeRows = Object.values(byJudge).sort((a, b) => b.bias - a.bias);
  judgeBody.innerHTML = "";
  judgeRows.forEach((j) => {
    const notes = [];
    if (j.n < MIN_CARDS_FOR_ADJUST) notes.push(`Too few scorecards (<${MIN_CARDS_FOR_ADJUST}), left unadjusted`);
    else if (j.sd === 0) notes.push("Gave the same score everywhere, left unadjusted");
    else if (j.sd < 0.3) notes.push("Very little spread");
    if (j.n >= MIN_CARDS_FOR_ADJUST && j.bias >= 0.5) notes.push("Scores generously");
    if (j.n >= MIN_CARDS_FOR_ADJUST && j.bias <= -0.5) notes.push("Scores harshly");
    const biasTxt = (j.bias >= 0 ? "+" : "") + j.bias.toFixed(2);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(j.name)}</td>
      <td>${j.n}</td>
      <td>${j.mean.toFixed(2)}</td>
      <td>${j.sd.toFixed(2)}</td>
      <td${Math.abs(j.bias) >= 0.5 && j.n >= MIN_CARDS_FOR_ADJUST ? ' style="color:var(--warn);font-weight:700;"' : ""}>${biasTxt}</td>
      <td class="muted" style="white-space:normal;">${notes.length ? escapeHtml(notes.join("; ")) : "—"}</td>
    `;
    judgeBody.appendChild(tr);
  });

  // adjusted score for one scorecard
  const adjustedOf = (c) => {
    const j = byJudge[c.s.judgeId];
    if (!j || !j.adjustable || grandSD === 0) return c.w;
    const z = (c.w - j.mean) / j.sd;
    return Math.min(5, Math.max(1, grandMean + z * grandSD));
  };

  const teamRows = teams.map((team) => {
    const tc = cards.filter((c) => c.s.teamId === team.id);
    const penalty = typeof team.penalty === "number" ? team.penalty : 0;
    if (!tc.length) return { team, n: 0, raw: null, adj: null };
    const raw = Math.max(0, meanOf(tc.map((c) => c.w)) - penalty);
    const adj = Math.max(0, meanOf(tc.map(adjustedOf)) - penalty);
    return { team, n: tc.length, raw, adj };
  });

  const scored = teamRows.filter((r) => r.raw !== null);
  [...scored].sort((a, b) => b.raw - a.raw).forEach((r, i) => { r.rawRank = i + 1; });
  [...scored].sort((a, b) => b.adj - a.adj).forEach((r, i) => { r.adjRank = i + 1; });
  scored.sort((a, b) => a.adjRank - b.adjRank);

  teamBody.innerHTML = "";
  scored.forEach((r) => {
    const move = r.rawRank - r.adjRank; // positive = moves up when adjusted
    const moveTxt = move === 0 ? "—" : move > 0 ? `▲ ${move}` : `▼ ${-move}`;
    const moveColor = move === 0 ? "" : move > 0 ? "color:#4FD1A5;" : "color:var(--warn);";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.adjRank}</td>
      <td>${escapeHtml(r.team.name)}</td>
      <td>${r.n}</td>
      <td>${r.adj.toFixed(2)}</td>
      <td>${r.raw.toFixed(2)}</td>
      <td>${r.rawRank}</td>
      <td style="${moveColor}font-weight:700;">${moveTxt}</td>
    `;
    teamBody.appendChild(tr);
  });
  if (!scored.length) teamBody.innerHTML = `<tr><td colspan="7" class="muted">No team has been scored yet.</td></tr>`;
}

// ---------- Leaderboard ----------
let lastLeaderboardRows = [];

function renderLeaderboard() {
  document.getElementById("statTeams").textContent = teams.length;
  document.getElementById("statJudges").textContent = judges.length;

  const headRow = document.getElementById("leaderboardHeadRow");
  const tbody = document.querySelector("#leaderboardTable tbody");

  if (!(loaded.teams && loaded.scores && loaded.criteria)) {
    tbody.innerHTML = loadingRow(6);
    return;
  }

  headRow.innerHTML =
    "<th>#</th><th>Team</th><th>Lead</th><th># Judges</th><th>Weighted Score</th>" +
    criteria.map((c) => `<th title="${escapeHtml(c.description || "")}">${escapeHtml(c.label)}</th>`).join("");

  const rows = teams.map((team) => {
    const teamScores = scores.filter((s) => s.teamId === team.id);
    const n = teamScores.length;
    const rawAvg = n
      ? teamScores.reduce((a, s) => a + weightedScoreOf(s), 0) / n
      : 0;
    const penalty = typeof team.penalty === "number" ? team.penalty : 0;
    const weightedAvg = Math.max(0, rawAvg - penalty);
    const critAvgs = {};
    criteria.forEach((c) => {
      const vals = teamScores
        .map((s) => s.criteria && s.criteria[c.id])
        .filter((v) => typeof v === "number");
      critAvgs[c.id] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    });
    return { team, n, weightedAvg, rawAvg, penalty, critAvgs };
  });

  rows.sort((a, b) => b.weightedAvg - a.weightedAvg);
  lastLeaderboardRows = rows;
  const outliers = computeOutliers();
  const flagCountByTeam = {};
  outliers.forEach((f) => { flagCountByTeam[f.team.id] = (flagCountByTeam[f.team.id] || 0) + 1; });

  tbody.innerHTML = "";
  rows.forEach((r, i) => {
    const rankClass = i === 0 ? "rank-1" : i === 1 ? "rank-2" : i === 2 ? "rank-3" : "";
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.innerHTML = `
      <td class="${rankClass}">${i + 1}</td>
      <td>${escapeHtml(r.team.name)}${flagCountByTeam[r.team.id] ? ` <span class="pill" title="${flagCountByTeam[r.team.id]} outlier score(s). Open the team to see them." style="color:var(--warn);border-color:var(--warn);">⚠ ${flagCountByTeam[r.team.id]}</span>` : ""}</td>
      <td class="muted">${escapeHtml(r.team.lead || "—")}</td>
      <td${r.n < minJudgesPerTeam ? ` style="color:var(--warn);font-weight:700;" title="Below the ${minJudgesPerTeam}-judge minimum"` : ""}>${r.n}${r.n < minJudgesPerTeam ? " ⚠" : ""}</td>
      <td><strong>${r.weightedAvg.toFixed(2)}</strong>${r.penalty ? ` <span class="pill" title="Raw score ${r.rawAvg.toFixed(2)} minus ${r.penalty}-pt penalty${r.team.penaltyReason ? ": " + escapeHtml(r.team.penaltyReason) : ""}" style="background:#C42931;color:#fff;">-${r.penalty}</span>` : ""}</td>
      ${criteria.map((c) => `<td>${r.critAvgs[c.id] === null ? "—" : r.critAvgs[c.id].toFixed(1)}</td>`).join("")}
    `;
    tr.addEventListener("click", () => openTeamDetail(r.team));
    tbody.appendChild(tr);
  });
}

// ---------- Team detail modal ----------
const teamDetailModal = document.getElementById("teamDetailModal");
const detailTeamName = document.getElementById("detailTeamName");
const detailTeamLead = document.getElementById("detailTeamLead");
const detailContent = document.getElementById("detailContent");
document.getElementById("closeDetailBtn").addEventListener("click", () => {
  teamDetailModal.classList.add("hidden");
});

function openTeamDetail(team) {
  detailTeamName.textContent = team.name;
  const metaParts = [];
  if (team.lead) metaParts.push("Lead: " + team.lead);
  if (team.members) metaParts.push("Team: " + team.members);
  detailTeamLead.textContent = metaParts.length ? metaParts.join("   \u00b7   ") : "\u2014";
  if (team.description) {
    detailTeamLead.innerHTML += `<div style="margin-top:6px;">${escapeHtml(team.description)}</div>`;
  }
  if (typeof team.penalty === "number" && team.penalty > 0) {
    detailTeamLead.innerHTML += `<div style="margin-top:6px;"><span class="pill" style="background:#C42931;color:#fff;">Penalty applied: -${team.penalty}</span>${team.penaltyReason ? ` <span class="muted">${escapeHtml(team.penaltyReason)}</span>` : ""}</div>`;
  }
  const teamScores = scores.filter((s) => s.teamId === team.id);

  if (teamScores.length === 0) {
    detailContent.innerHTML = `<p class="muted">No judge has scored this team yet.</p>`;
  } else {
    const detailOutliers = computeOutliers();
    detailContent.innerHTML = teamScores
      .map((s) => {
        const weighted = weightedScoreOf(s).toFixed(2);
        const critLines = criteria
          .map((c) => {
            const val = s.criteria ? s.criteria[c.id] : undefined;
            if (typeof val !== "number") return "";
            const flag = detailOutliers.get(s.id + "|" + c.id);
            return flag
              ? `<span class="pill" title="Outlier: other judges' median is ${Number.isInteger(flag.median) ? flag.median : flag.median.toFixed(1)}" style="margin:2px;color:var(--warn);border-color:var(--warn);">⚠ ${escapeHtml(c.label)}: ${val}</span>`
              : `<span class="pill" title="${escapeHtml(c.description || "")}" style="margin:2px;">${escapeHtml(c.label)}: ${val}</span>`;
          })
          .join("");
        const nomLines = s.nominations
          ? Object.keys(s.nominations)
              .filter((k) => s.nominations[k])
              .map((k) => `<span class="pill" style="margin:2px;">${escapeHtml(NOMINATION_LABELS[k] || k)}</span>`)
              .join("")
          : "";
        return `
          <div class="card" style="margin-bottom:10px;">
            <div class="row between">
              <strong>${escapeHtml(s.judgeName || "Unknown judge")}</strong>
              <span class="score-badge">${weighted} / 5</span>
            </div>
            <div style="margin:8px 0;">${critLines}</div>
            ${nomLines ? `<div style="margin-top:4px;">${nomLines}</div>` : ""}
            ${s.strengths ? `<div style="margin-top:8px;"><div class="muted" style="font-size:12px;">Strengths</div>${escapeHtml(s.strengths)}</div>` : ""}
            ${s.improvements ? `<div style="margin-top:8px;"><div class="muted" style="font-size:12px;">Areas to improve</div>${escapeHtml(s.improvements)}</div>` : ""}
            ${s.additionalComments ? `<div style="margin-top:8px;"><div class="muted" style="font-size:12px;">Additional comments</div>${escapeHtml(s.additionalComments)}</div>` : ""}
          </div>
        `;
      })
      .join("");
  }
  teamDetailModal.classList.remove("hidden");
}

// ---------- CSV export ----------
document.getElementById("exportCsvBtn").addEventListener("click", () => {
  const headers = ["Rank", "Team", "Lead", "# Judges", "Weighted Score", "Penalty", "Penalty Reason", ...criteria.map((c) => c.label)];
  const lines = [headers.map(csvCell).join(",")];
  lastLeaderboardRows.forEach((r, i) => {
    const row = [
      i + 1,
      r.team.name,
      r.team.lead || "",
      r.n,
      r.weightedAvg.toFixed(2),
      r.penalty ? `-${r.penalty}` : "",
      r.penalty ? (r.team.penaltyReason || "") : "",
      ...criteria.map((c) => (r.critAvgs[c.id] === null ? "" : r.critAvgs[c.id].toFixed(2)))
    ];
    lines.push(row.map(csvCell).join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "codeathon-results.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

function csvCell(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- Detailed CSV export (one row per judge per team, with comments) ----------
// Button is injected next to the existing leaderboard export so admin.html needs no change.
(function addDetailedExportButton() {
  const baseBtn = document.getElementById("exportCsvBtn");
  if (!baseBtn || document.getElementById("exportDetailedCsvBtn")) return;
  const btn = document.createElement("button");
  btn.id = "exportDetailedCsvBtn";
  btn.type = "button";
  btn.className = baseBtn.className;
  btn.textContent = "Export detailed scores + comments";
  btn.style.marginLeft = "8px";
  baseBtn.insertAdjacentElement("afterend", btn);

  // Stop spreadsheet apps from running judge-typed text as a formula.
  const safeText = (v) => {
    const t = String(v ?? "");
    return /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
  };

  btn.addEventListener("click", () => {
    if (!(loaded.teams && loaded.scores && loaded.criteria)) {
      alert("Data is still loading. Try again in a moment.");
      return;
    }
    if (scores.length === 0) {
      alert("There are no submitted scores to export yet.");
      return;
    }

    // Same team order as the leaderboard when available, otherwise by name.
    const orderedTeams = lastLeaderboardRows.length
      ? lastLeaderboardRows.map((r) => r.team)
      : [...teams].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const judgeNameById = {};
    judges.forEach((j) => { judgeNameById[j.id] = j.name; });

    const headers = [
      "Team", "Judge",
      ...criteria.map((c) => c.label),
      "Strengths", "Areas to Improve", "Additional Comments"
    ];
    const lines = [headers.map(csvCell).join(",")];

    orderedTeams.forEach((team) => {
      scores
        .filter((s) => s.teamId === team.id)
        .sort((a, b) => (a.judgeName || "").localeCompare(b.judgeName || ""))
        .forEach((s) => {
          const row = [
            team.name,
            s.judgeName || judgeNameById[s.judgeId] || "Unknown judge",
            ...criteria.map((c) => {
              const v = s.criteria ? s.criteria[c.id] : undefined;
              return typeof v === "number" ? v : "";
            }),
            safeText(s.strengths),
            safeText(s.improvements),
            safeText(s.additionalComments)
          ];
          lines.push(row.map(csvCell).join(","));
        });
    });

    // BOM so Excel reads the file as UTF-8 (keeps accents/quotes in comments intact).
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "codeathon-detailed-scores.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
})();

// ---------- Judge coverage matrix ----------
function renderMatrix() {
  const thead = document.querySelector("#matrixTable thead");
  const tbody = document.querySelector("#matrixTable tbody");
  if (!(loaded.teams && loaded.judges && loaded.scores)) {
    thead.innerHTML = "";
    tbody.innerHTML = loadingRow(1);
    return;
  }
  thead.innerHTML = "<tr><th>Judge</th>" + teams.map((t) => `<th>${escapeHtml(t.name)}</th>`).join("") + "</tr>";
  tbody.innerHTML = "";
  judges.forEach((j) => {
    const tr = document.createElement("tr");
    let cells = `<td>${escapeHtml(j.name)}</td>`;
    teams.forEach((t) => {
      const s = scores.find((sc) => sc.judgeId === j.id && sc.teamId === t.id);
      cells += `<td>${s ? "✅ " + weightedScoreOf(s).toFixed(2) : '<span class="muted">—</span>'}</td>`;
    });
    tr.innerHTML = cells;
    tbody.appendChild(tr);
  });
}

// ---------- Nomination totals ----------
function renderNominationsTable() {
  const table = document.getElementById("nominationsTable");
  if (!table) return; // tab not in the DOM yet on first paint
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  const nomKeys = Object.keys(NOMINATION_LABELS);

  if (!(loaded.teams && loaded.scores)) {
    tbody.innerHTML = loadingRow(nomKeys.length + 2);
    return;
  }

  thead.innerHTML =
    "<tr><th>Team</th>" +
    nomKeys.map((k) => `<th>${escapeHtml(NOMINATION_LABELS[k])}</th>`).join("") +
    "<th>Total</th></tr>";

  const rows = teams.map((t) => {
    const teamScores = scores.filter((s) => s.teamId === t.id);
    const counts = {};
    let total = 0;
    nomKeys.forEach((k) => {
      const count = teamScores.filter((s) => s.nominations && s.nominations[k]).length;
      counts[k] = count;
      total += count;
    });
    return { team: t, counts, total };
  });
  rows.sort((a, b) => b.total - a.total);

  tbody.innerHTML = "";
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${nomKeys.length + 2}" class="muted">No teams yet.</td></tr>`;
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${escapeHtml(r.team.name)}</td>` +
      nomKeys.map((k) => `<td>${r.counts[k] || ""}</td>`).join("") +
      `<td><strong>${r.total}</strong></td>`;
    tbody.appendChild(tr);
  });
}

// ---------- Teams CRUD ----------
document.getElementById("addTeamBtn").addEventListener("click", async () => {
  const nameEl = document.getElementById("newTeamName");
  const leadEl = document.getElementById("newTeamLead");
  const membersEl = document.getElementById("newTeamMembers");
  const descEl = document.getElementById("newTeamDescription");
  const errEl = document.getElementById("teamErr");
  errEl.classList.add("hidden");
  const name = nameEl.value.trim();
  const lead = leadEl.value.trim();
  const members = membersEl.value.trim();
  const description = descEl.value.trim();
  if (!name) {
    errEl.textContent = "Team name is required.";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    await addDoc(collection(db, "teams"), { name, lead, members, description, createdAt: Date.now() });
    nameEl.value = "";
    leadEl.value = "";
    membersEl.value = "";
    descEl.value = "";
  } catch (e) {
    errEl.textContent = "Failed to add team.";
    errEl.classList.remove("hidden");
  }
});

function renderTeamsTable() {
  const container = document.getElementById("teamsListContainer");
  container.innerHTML = "";
  if (teams.length === 0) {
    container.innerHTML = `<p class="muted">No teams yet. Add one above.</p>`;
    return;
  }
  teams.forEach((t) => {
    const row = document.createElement("div");
    row.className = "card";
    row.style.marginBottom = "10px";
    row.innerHTML = `
      <div class="row between">
        <strong>${escapeHtml(t.name)}</strong>
        <button class="btn danger small removeTeamBtn">Remove</button>
      </div>
      <div class="row">
        <div style="flex:1;"><label>Team name</label><input class="nameInput" value="${escapeHtml(t.name)}" /></div>
        <div style="flex:1;"><label>Team lead</label><input class="leadInput" value="${escapeHtml(t.lead || "")}" /></div>
      </div>
      <label>Team members</label>
      <input class="membersInput" value="${escapeHtml(t.members || "")}" placeholder="e.g. Sydney Fox, Jaron Witt, Gnaneshwar Pabbathi" />
      <label>Project description</label>
      <textarea class="descInput" style="min-height:44px;" placeholder="A sentence or two on what the team built">${escapeHtml(t.description || "")}</textarea>
      <button class="btn saveTeamBtn" style="margin-top:10px;">Save changes</button>
    `;

    row.querySelector(".removeTeamBtn").addEventListener("click", async () => {
      if (!confirm(`Remove team "${t.name}"? This also deletes all of its scores.`)) return;
      await deleteDoc(doc(db, "teams", t.id));
      const related = scores.filter((s) => s.teamId === t.id);
      if (related.length) {
        const batch = writeBatch(db);
        related.forEach((s) => batch.delete(doc(db, "scores", s.id)));
        await batch.commit();
      }
    });

    row.querySelector(".saveTeamBtn").addEventListener("click", async () => {
      const newName = row.querySelector(".nameInput").value.trim();
      if (!newName) {
        alert("Team name can't be empty.");
        return;
      }
      await updateDoc(doc(db, "teams", t.id), {
        name: newName,
        lead: row.querySelector(".leadInput").value.trim(),
        members: row.querySelector(".membersInput").value.trim(),
        description: row.querySelector(".descInput").value.trim()
      });
    });

    container.appendChild(row);
  });
}

// ---------- Teams CSV import ----------
// Minimal CSV parser: handles quoted fields (with embedded commas/newlines)
// and "" as an escaped quote inside a quoted field. Good enough for a
// roster export from Sheets/Excel/Forms without pulling in a library.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

document.getElementById("importTeamsCsvBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("teamsCsvInput");
  const errEl = document.getElementById("teamsCsvErr");
  const okEl = document.getElementById("teamsCsvOk");
  errEl.classList.add("hidden");
  okEl.classList.add("hidden");

  const file = fileInput.files[0];
  if (!file) {
    errEl.textContent = "Choose a CSV file first.";
    errEl.classList.remove("hidden");
    return;
  }

  try {
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) {
      errEl.textContent = "That CSV doesn't have any data rows below the header.";
      errEl.classList.remove("hidden");
      return;
    }

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const nameIdx = header.findIndex((h) => h === "name" || h === "team name" || h === "team");
    const leadIdx = header.findIndex((h) => h === "lead" || h === "team lead");
    const membersIdx = header.findIndex((h) => h.includes("member"));
    const descIdx = header.findIndex((h) => h.includes("desc"));

    if (nameIdx === -1) {
      errEl.textContent = 'The CSV needs a "name" column at minimum.';
      errEl.classList.remove("hidden");
      return;
    }

    // Match against teams already loaded, case-insensitively by name.
    const existingByName = {};
    teams.forEach((t) => { existingByName[t.name.trim().toLowerCase()] = t; });

    let added = 0, updated = 0, skipped = 0;
    const batches = [writeBatch(db)];
    let opsInBatch = 0;
    const nextWrite = () => {
      if (opsInBatch >= 400) { batches.push(writeBatch(db)); opsInBatch = 0; }
      opsInBatch++;
      return batches[batches.length - 1];
    };

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = (row[nameIdx] || "").trim();
      if (!name) { skipped++; continue; }
      const lead = leadIdx !== -1 ? (row[leadIdx] || "").trim() : "";
      const members = membersIdx !== -1 ? (row[membersIdx] || "").trim() : "";
      const description = descIdx !== -1 ? (row[descIdx] || "").trim() : "";

      const existing = existingByName[name.toLowerCase()];
      if (existing) {
        // Only fill in blanks -- don't clobber anything already entered in the admin console.
        const updates = {};
        if (lead && !existing.lead) updates.lead = lead;
        if (members && !existing.members) updates.members = members;
        if (description && !existing.description) updates.description = description;
        if (Object.keys(updates).length > 0) {
          nextWrite().set(doc(db, "teams", existing.id), updates, { merge: true });
          updated++;
        }
      } else {
        const newRef = doc(collection(db, "teams"));
        nextWrite().set(newRef, { name, lead, members, description, createdAt: Date.now() });
        existingByName[name.toLowerCase()] = { id: newRef.id, name, lead, members, description }; // avoid dupes within the same file
        added++;
      }
    }

    for (const b of batches) {
      await b.commit();
    }

    const parts = [`${added} team${added === 1 ? "" : "s"} added`, `${updated} updated`];
    if (skipped) parts.push(`${skipped} row${skipped === 1 ? "" : "s"} skipped (no name)`);
    okEl.textContent = "Import complete: " + parts.join(", ") + ".";
    okEl.classList.remove("hidden");
    fileInput.value = "";
  } catch (e) {
    console.error(e);
    errEl.textContent = "Couldn't read or import that file. Make sure it's a valid CSV.";
    errEl.classList.remove("hidden");
  }
});

// ---------- Judges CRUD ----------
// Creating a judge means creating them a real Firebase Auth login. The
// client SDK's createUserWithEmailAndPassword() normally signs in AS the
// new user, which would kick the admin out of their own session -- so we
// spin up a second, throwaway Firebase app instance just for this one
// call, then tear it down immediately. The admin's own session (on the
// primary `auth` instance) is never touched.
async function createJudgeAccount(name, email) {
  const tempPassword = crypto.randomUUID(); // never shown/used -- the judge sets their own via email
  const secondaryApp = initializeApp(firebaseConfig, "judge-creator-" + Date.now());
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, tempPassword);
    const uid = cred.user.uid;
    await secondarySignOut(secondaryAuth);
    await setDoc(doc(db, "judges", uid), { name, email, active: true, createdAt: Date.now() });
    await sendPasswordResetEmail(auth, email); // lets the judge set their own password
    return uid;
  } finally {
    await deleteApp(secondaryApp);
  }
}

document.getElementById("addJudgeBtn").addEventListener("click", async () => {
  const nameEl = document.getElementById("newJudgeName");
  const emailEl = document.getElementById("newJudgeEmail");
  const errEl = document.getElementById("judgeErr");
  const okEl = document.getElementById("judgeOk");
  errEl.classList.add("hidden");
  okEl.classList.add("hidden");
  const name = nameEl.value.trim();
  const email = emailEl.value.trim();
  if (!name || !email) {
    errEl.textContent = "Judge name and email are both required.";
    errEl.classList.remove("hidden");
    return;
  }
  const addBtn = document.getElementById("addJudgeBtn");
  addBtn.disabled = true;
  try {
    await createJudgeAccount(name, email);
    nameEl.value = "";
    emailEl.value = "";
    okEl.textContent = `Judge account created for ${name}. A password-setup email was sent to ${email} -- ask them to check their inbox (and spam folder).`;
    okEl.classList.remove("hidden");
  } catch (e) {
    console.error(e);
    errEl.textContent = e.code === "auth/email-already-in-use"
      ? "That email already has a judge account."
      : "Failed to create judge account.";
    errEl.classList.remove("hidden");
  } finally {
    addBtn.disabled = false;
  }
});

document.getElementById("removeAllJudgesBtn").addEventListener("click", async () => {
  if (judges.length === 0) {
    alert("There are no judges to remove.");
    return;
  }
  const ok = confirm(
    `Remove all ${judges.length} judge${judges.length === 1 ? "" : "s"}? ` +
    `Their judge.html logins stop working immediately. Submitted scores are NOT deleted -- ` +
    `use the Reset Scores tab separately if you also want those gone.\n\n` +
    `Note: this removes their judge records here, but can't delete the underlying Firebase Auth ` +
    `accounts (only the Firebase console can do that). Their email addresses will still show as ` +
    `"in use" and can't be reused for a new judge until you remove them manually under Firebase ` +
    `console -> Authentication -> Users.`
  );
  if (!ok) return;
  await deleteAllJudges(judges);
  alert("All judges have been removed.");
});

async function deleteAllJudges(list) {
  const chunkSize = 400; // Firestore batches max out at 500 writes
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const batch = writeBatch(db);
    chunk.forEach((j) => batch.delete(doc(db, "judges", j.id)));
    await batch.commit();
  }
}

function renderJudgesTable() {
  const tbody = document.querySelector("#judgesTable tbody");
  if (!loaded.judges) {
    tbody.innerHTML = loadingRow(4);
    return;
  }
  tbody.innerHTML = "";
  judges.forEach((j) => {
    const isActive = j.active !== false;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(j.name)}</td>
      <td class="muted">${escapeHtml(j.email || "—")}</td>
      <td><span class="status-badge ${isActive ? "active" : "inactive"}">${isActive ? "Active" : "Deactivated"}</span></td>
      <td class="row">
        <button class="btn secondary small resendBtn">Resend password email</button>
        <button class="btn warn small toggleActiveBtn">${isActive ? "Deactivate" : "Reactivate"}</button>
        <button class="btn danger small removeBtn">Remove</button>
      </td>
    `;
    tr.querySelector(".resendBtn").addEventListener("click", async () => {
      if (!j.email) { alert("This judge has no email on file."); return; }
      try {
        await sendPasswordResetEmail(auth, j.email);
        alert(`Password setup/reset email sent to ${j.email}.`);
      } catch (e) {
        alert("Couldn't send the email. Check the address is correct.");
      }
    });
    tr.querySelector(".toggleActiveBtn").addEventListener("click", async () => {
      await updateDoc(doc(db, "judges", j.id), { active: !isActive });
    });
    tr.querySelector(".removeBtn").addEventListener("click", async () => {
      if (!confirm(`Remove judge "${j.name}"? Their submitted scores will remain unless you reset them separately. Their login will stop working immediately.`)) return;
      await deleteDoc(doc(db, "judges", j.id));
    });
    tbody.appendChild(tr);
  });
}

// ---------- Categories CRUD ----------
// Reads the five score-level textareas. All five filled in, or all five blank;
// anything in between is an error so a category never ends up half-described.
function collectLevels(textareas) {
  const vals = textareas.map((el) => el.value.trim());
  const filled = vals.filter(Boolean).length;
  if (filled === 0) return { levels: [] };
  if (filled < LEVEL_COUNT) {
    return { error: `Fill in all ${LEVEL_COUNT} score level descriptions, or leave all of them blank (${filled} of ${LEVEL_COUNT} filled in).` };
  }
  return { levels: vals };
}

document.getElementById("addCritBtn").addEventListener("click", async () => {
  const labelEl = document.getElementById("newCritLabel");
  const weightEl = document.getElementById("newCritWeight");
  const descEl = document.getElementById("newCritDesc");
  const errEl = document.getElementById("critErr");
  errEl.classList.add("hidden");
  const label = labelEl.value.trim();
  const weight = Number(weightEl.value);
  const description = descEl.value.trim();
  if (!label) {
    errEl.textContent = "Category name is required.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!(weight > 0)) {
    errEl.textContent = "Weight must be a positive number.";
    errEl.classList.remove("hidden");
    return;
  }
  const levelEls = Array.from({ length: LEVEL_COUNT }, (_, i) => document.getElementById(`newCritLevel${i + 1}`));
  const lv = collectLevels(levelEls);
  if (lv.error) {
    errEl.textContent = lv.error;
    errEl.classList.remove("hidden");
    return;
  }
  try {
    const nextOrder = criteria.length ? Math.max(...criteria.map((c) => c.order ?? 0)) + 1 : 0;
    await addDoc(collection(db, "criteria"), { label, weight, description, levels: lv.levels, order: nextOrder, createdAt: Date.now() });
    labelEl.value = "";
    weightEl.value = "1";
    descEl.value = "";
    levelEls.forEach((el) => { el.value = ""; });
  } catch (e) {
    errEl.textContent = "Failed to add category.";
    errEl.classList.remove("hidden");
  }
});

function renderCritTable() {
  const container = document.getElementById("critList");
  container.innerHTML = "";
  if (criteria.length === 0) {
    container.innerHTML = `<p class="muted">No categories yet. Import them from an Excel file above, or add one manually.</p>`;
    return;
  }
  criteria.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "card";
    row.style.marginBottom = "10px";
    const savedLevels = Array.isArray(c.levels) ? c.levels : [];
    const hasLevels = savedLevels.length === LEVEL_COUNT;
    const levelFieldsHtml = Array.from({ length: LEVEL_COUNT }, (_, i) => `
        <label>Score ${i + 1}${i === 0 ? " (poor)" : i === LEVEL_COUNT - 1 ? " (excellent)" : ""}</label>
        <textarea class="levelInput" style="min-height:44px;">${escapeHtml(savedLevels[i] || "")}</textarea>`).join("");
    row.innerHTML = `
      <div class="row between">
        <div class="row">
          <button class="btn secondary small" data-dir="up" ${idx === 0 ? "disabled" : ""}>↑</button>
          <button class="btn secondary small" data-dir="down" ${idx === criteria.length - 1 ? "disabled" : ""}>↓</button>
        </div>
        <button class="btn danger small removeCritBtn">Remove</button>
      </div>
      <label>Category name</label>
      <input class="labelInput" value="${escapeHtml(c.label)}" />
      <label>Weight</label>
      <input class="weightInput" type="number" min="0.1" step="0.1" value="${c.weight ?? 1}" style="max-width:120px;" />
      <label>Description (what judges should look for)</label>
      <textarea class="descInput" style="min-height:44px;">${escapeHtml(c.description || "")}</textarea>
      <details style="margin-top:12px;">
        <summary class="muted" style="cursor:pointer;font-size:13px;">Score level descriptions (${hasLevels ? "set" : "not set"})</summary>
        ${levelFieldsHtml}
      </details>
      <button class="btn saveCritBtn" style="margin-top:10px;">Save changes</button>
    `;

    row.querySelector('[data-dir="up"]').addEventListener("click", () => moveCriterion(idx, -1));
    row.querySelector('[data-dir="down"]').addEventListener("click", () => moveCriterion(idx, 1));

    row.querySelector(".removeCritBtn").addEventListener("click", async () => {
      if (!confirm(`Remove category "${c.label}"? Past scores keep their recorded value, but it will no longer count toward anyone's weighted score.`)) return;
      await deleteDoc(doc(db, "criteria", c.id));
    });

    row.querySelector(".saveCritBtn").addEventListener("click", async () => {
      const newLabel = row.querySelector(".labelInput").value.trim();
      const newWeight = Number(row.querySelector(".weightInput").value);
      const newDesc = row.querySelector(".descInput").value.trim();
      if (!newLabel) {
        alert("Category name can't be empty.");
        return;
      }
      if (!(newWeight > 0)) {
        alert("Weight must be a positive number.");
        return;
      }
      const lv = collectLevels(Array.from(row.querySelectorAll(".levelInput")));
      if (lv.error) {
        alert(lv.error);
        return;
      }
      await updateDoc(doc(db, "criteria", c.id), { label: newLabel, weight: newWeight, description: newDesc, levels: lv.levels });
    });

    container.appendChild(row);
  });
}

async function moveCriterion(idx, dir) {
  const other = idx + dir;
  if (other < 0 || other >= criteria.length) return;
  const a = criteria[idx];
  const b = criteria[other];
  const batch = writeBatch(db);
  batch.update(doc(db, "criteria", a.id), { order: b.order ?? other });
  batch.update(doc(db, "criteria", b.id), { order: a.order ?? idx });
  await batch.commit();
}

// ---------- Categories Excel import / export ----------
// SheetJS is loaded on demand the first time it's needed, so it never slows
// down page load for people who don't use the import.
const XLSX_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
let xlsxLib = null;
async function getXlsx() {
  if (!xlsxLib) xlsxLib = await import(XLSX_URL);
  return xlsxLib;
}

const CRIT_SHEET_HEADERS = ["Order", "Category", "Weight", "Question", "Level 1", "Level 2", "Level 3", "Level 4", "Level 5"];
let pendingImportRows = null; // parsed + validated rows waiting for the admin to confirm

// <pure-import-logic>
// Reads the workbook and validates every row. Returns { rows, errors }.
// Nothing is written anywhere here; errors name the Excel row and column.
function parseCategoriesWorkbook(XLSX, wb) {
  const sheetName = wb.SheetNames.find((n) => n.trim().toLowerCase() === "categories") || wb.SheetNames[0];
  if (!sheetName) return { rows: [], errors: ["The workbook has no sheets."] };
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "", blankrows: true });
  if (!grid.length) return { rows: [], errors: [`Sheet "${sheetName}" is empty.`] };

  const headerRow = grid[0].map((h) => String(h).trim().toLowerCase());
  const find = (...names) => headerRow.findIndex((h) => names.includes(h));
  const col = {
    order: find("order"),
    label: find("category"),
    weight: find("weight"),
    question: find("question", "description"),
    levels: [1, 2, 3, 4, 5].map((n) => find(`level ${n}`))
  };
  const missing = [];
  if (col.label < 0) missing.push("Category");
  if (col.weight < 0) missing.push("Weight");
  if (col.question < 0) missing.push("Question");
  col.levels.forEach((idx, i) => { if (idx < 0) missing.push(`Level ${i + 1}`); });
  if (missing.length) {
    return { rows: [], errors: [`Sheet "${sheetName}" is missing required column(s): ${missing.join(", ")}. The first row must contain the headers.`] };
  }

  const text = (row, idx) => String(row[idx] ?? "").trim();
  const errors = [];
  const rows = [];
  const seen = new Map(); // lowercase label -> first Excel row

  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i];
    if (cells.every((v) => String(v ?? "").trim() === "")) continue; // skip fully blank rows
    const xr = i + 1; // Excel row number (header is row 1)

    const label = text(cells, col.label);
    if (!label) {
      errors.push(`Row ${xr}: Category is empty.`);
    } else {
      const key = label.toLowerCase();
      if (seen.has(key)) errors.push(`Row ${xr}: Category "${label}" is a duplicate of row ${seen.get(key)}.`);
      else seen.set(key, xr);
    }

    const weightRaw = text(cells, col.weight);
    const weight = Number(weightRaw);
    if (weightRaw === "" || !Number.isFinite(weight) || !(weight > 0)) {
      errors.push(`Row ${xr}: Weight must be a number greater than 0${weightRaw === "" ? " (it is empty)" : ` (found "${weightRaw}")`}.`);
    }

    const description = text(cells, col.question);
    if (!description) errors.push(`Row ${xr}: Question is empty.`);

    const levels = col.levels.map((idx) => text(cells, idx));
    levels.forEach((lv, n) => { if (!lv) errors.push(`Row ${xr}: Level ${n + 1} is empty.`); });

    let order = null;
    if (col.order >= 0) {
      const orderRaw = text(cells, col.order);
      if (orderRaw !== "") {
        order = Number(orderRaw);
        if (!Number.isFinite(order)) {
          errors.push(`Row ${xr}: Order must be a number (found "${orderRaw}").`);
          order = null;
        }
      }
    }
    rows.push({ xr, label, weight, description, levels, order, pos: rows.length });
  }
  if (!rows.length && !errors.length) errors.push("No category rows found below the header row.");
  return { rows, errors };
}

// Compares the validated rows to the categories currently in Firestore.
// Matching is by name (case-insensitive), so existing documents are updated in
// place and the scores keyed to them stay attached.
function buildImportPlan(rows, existing) {
  const byLabel = new Map(existing.map((c) => [String(c.label).trim().toLowerCase(), c]));
  const sorted = rows
    .slice()
    .sort((a, b) => ((a.order ?? a.pos + 1) - (b.order ?? b.pos + 1)) || (a.pos - b.pos));
  const matchedIds = new Set();
  const items = sorted.map((r, i) => {
    const match = byLabel.get(r.label.toLowerCase());
    const item = { row: r, order: i, match: match || null, changes: [] };
    if (!match) return item;
    matchedIds.add(match.id);
    if (match.label !== r.label) item.changes.push("name text");
    if (match.weight !== r.weight) item.changes.push(`weight ${match.weight} → ${r.weight}`);
    if ((match.description || "") !== r.description) item.changes.push("question");
    const oldLv = Array.isArray(match.levels) ? match.levels : [];
    if (oldLv.length !== 5 || oldLv.some((v, n) => v !== r.levels[n])) item.changes.push("level descriptions");
    if ((match.order ?? -1) !== i) item.changes.push("order");
    return item;
  });
  const removals = existing.filter((c) => !matchedIds.has(c.id));
  return { items, removals };
}
// </pure-import-logic>

function showCritImportErrors(lines) {
  const el = document.getElementById("critImportErr");
  el.innerHTML = lines.map((l) => escapeHtml(l)).join("<br>");
  el.classList.remove("hidden");
  document.getElementById("critImportOk").classList.add("hidden");
}
function clearCritImportMessages() {
  document.getElementById("critImportErr").classList.add("hidden");
  document.getElementById("critImportOk").classList.add("hidden");
}
function clearCritImportPreview() {
  pendingImportRows = null;
  const box = document.getElementById("critImportPreview");
  box.innerHTML = "";
  box.classList.add("hidden");
}

function renderCritImportPreview(plan) {
  const box = document.getElementById("critImportPreview");
  const added = plan.items.filter((it) => !it.match);
  const updated = plan.items.filter((it) => it.match && it.changes.length);
  const unchanged = plan.items.filter((it) => it.match && !it.changes.length);

  const statusOf = (it) => !it.match ? "New" : it.changes.length ? "Update" : "No change";
  const rowsHtml =
    plan.items.map((it) => `
      <tr>
        <td>${statusOf(it)}</td>
        <td>${escapeHtml(it.row.label)}</td>
        <td>${it.row.weight}</td>
        <td>${it.match ? escapeHtml(it.changes.join(", ") || "—") : "—"}</td>
      </tr>`).join("") +
    plan.removals.map((c) => `
      <tr style="color:#C42931;">
        <td><strong>Remove</strong></td>
        <td>${escapeHtml(c.label)}</td>
        <td>${c.weight ?? ""}</td>
        <td>not in the file</td>
      </tr>`).join("");

  let warn = "";
  if (plan.removals.length) {
    warn += `<p class="err" style="display:block;">${plan.removals.length} categor${plan.removals.length === 1 ? "y" : "ies"} will be removed. Scorecards already submitted keep their recorded values for ${plan.removals.length === 1 ? "it" : "them"}, but ${plan.removals.length === 1 ? "it" : "they"} will no longer count toward any team's weighted score.`;
    if (added.length) warn += ` If you renamed a category in the sheet, it appears here as one removal plus one new category and its old scores will not carry over -- rename it in its category card instead.`;
    warn += `</p>`;
  }
  if (scores.length && (updated.some((it) => it.changes.some((c) => c.startsWith("weight"))) || plan.removals.length || added.length)) {
    warn += `<p class="muted" style="font-size:12.5px;">${scores.length} scorecard${scores.length === 1 ? " has" : "s have"} already been submitted. The leaderboard recalculates immediately. A judge reopening a previously scored team will need to score any newly added category before saving.</p>`;
  }

  box.innerHTML = `
    <h3 style="margin:18px 0 6px;">Preview: ${added.length} new, ${updated.length} updated, ${unchanged.length} unchanged, ${plan.removals.length} removed</h3>
    ${warn}
    <div class="table-scroll">
      <table>
        <thead><tr><th>Action</th><th>Category</th><th>Weight</th><th>Details</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:12px;">
      <button id="critImportCancelBtn" class="btn secondary">Cancel</button>
      <button id="critImportApplyBtn" class="btn ${plan.removals.length ? "danger" : ""}">Apply import</button>
    </div>`;
  box.classList.remove("hidden");

  document.getElementById("critImportCancelBtn").addEventListener("click", clearCritImportPreview);
  document.getElementById("critImportApplyBtn").addEventListener("click", applyCritImport);
}

async function previewCritImport() {
  clearCritImportMessages();
  clearCritImportPreview();
  const input = document.getElementById("critXlsxInput");
  const file = input.files && input.files[0];
  if (!file) { showCritImportErrors(["Choose an .xlsx file first."]); return; }
  if (!/\.xlsx$/i.test(file.name)) { showCritImportErrors([`"${file.name}" is not an .xlsx file. Save the workbook as Excel Workbook (.xlsx).`]); return; }

  let XLSX;
  try {
    XLSX = await getXlsx();
  } catch (e) {
    showCritImportErrors(["Could not load the Excel reader (SheetJS) from cdn.sheetjs.com. Check your connection or network filtering and try again.", String(e && e.message || e)]);
    return;
  }
  let parsed;
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    parsed = parseCategoriesWorkbook(XLSX, wb);
  } catch (e) {
    showCritImportErrors([`Could not read "${file.name}" as an Excel workbook.`, String(e && e.message || e)]);
    return;
  }
  if (parsed.errors.length) {
    showCritImportErrors([`Fix ${parsed.errors.length} problem${parsed.errors.length === 1 ? "" : "s"} in the file, then preview again. Nothing was changed.`, ...parsed.errors]);
    return;
  }
  pendingImportRows = parsed.rows;
  renderCritImportPreview(buildImportPlan(parsed.rows, criteria));
}

async function applyCritImport() {
  if (!pendingImportRows) return;
  clearCritImportMessages();
  const applyBtn = document.getElementById("critImportApplyBtn");
  const cancelBtn = document.getElementById("critImportCancelBtn");

  // Re-check against the live categories in case they changed after the preview.
  const plan = buildImportPlan(pendingImportRows, criteria);
  const shown = document.getElementById("critImportPreview").querySelector("h3").textContent;
  const added = plan.items.filter((it) => !it.match).length;
  const updated = plan.items.filter((it) => it.match && it.changes.length).length;
  const unchanged = plan.items.filter((it) => it.match && !it.changes.length).length;
  const nowSummary = `Preview: ${added} new, ${updated} updated, ${unchanged} unchanged, ${plan.removals.length} removed`;
  if (shown !== nowSummary) {
    renderCritImportPreview(plan);
    showCritImportErrors(["The categories changed since this preview was made. Review the updated preview, then apply again. Nothing was changed."]);
    return;
  }

  applyBtn.disabled = true;
  cancelBtn.disabled = true;
  try {
    const batch = writeBatch(db);
    plan.items.forEach((it) => {
      const data = {
        label: it.row.label,
        weight: it.row.weight,
        description: it.row.description,
        levels: it.row.levels,
        order: it.order
      };
      if (it.match) batch.update(doc(db, "criteria", it.match.id), data);
      else batch.set(doc(collection(db, "criteria")), { ...data, createdAt: Date.now() });
    });
    plan.removals.forEach((c) => batch.delete(doc(db, "criteria", c.id)));
    await batch.commit();
    clearCritImportPreview();
    document.getElementById("critXlsxInput").value = "";
    const ok = document.getElementById("critImportOk");
    ok.textContent = `Import complete: ${added} added, ${updated} updated, ${unchanged} unchanged, ${plan.removals.length} removed.`;
    ok.classList.remove("hidden");
  } catch (e) {
    applyBtn.disabled = false;
    cancelBtn.disabled = false;
    showCritImportErrors([
      "The import failed and nothing was changed (all changes are applied together or not at all).",
      String(e && e.message || e),
      "If this says permission denied, confirm the deployed Firestore rules allow admin writes to /criteria."
    ]);
  }
}

async function downloadCategoriesWorkbook(rows, filename) {
  clearCritImportMessages();
  try {
    const XLSX = await getXlsx();
    const ws = XLSX.utils.aoa_to_sheet([CRIT_SHEET_HEADERS, ...rows]);
    ws["!cols"] = [8, 26, 9, 40, 40, 40, 40, 40, 40].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Categories");
    XLSX.writeFile(wb, filename);
  } catch (e) {
    showCritImportErrors(["Could not create the Excel file.", String(e && e.message || e)]);
  }
}

document.getElementById("critTemplateBtn").addEventListener("click", () => {
  downloadCategoriesWorkbook([], "codeathon-categories-template.xlsx");
});
document.getElementById("critExportBtn").addEventListener("click", () => {
  if (!criteria.length) { showCritImportErrors(["There are no categories to download yet."]); return; }
  const rows = criteria.map((c, i) => {
    const lv = Array.isArray(c.levels) ? c.levels : [];
    return [i + 1, c.label, c.weight, c.description || "", lv[0] || "", lv[1] || "", lv[2] || "", lv[3] || "", lv[4] || ""];
  });
  downloadCategoriesWorkbook(rows, "codeathon-scoring-categories.xlsx");
});
document.getElementById("critPreviewBtn").addEventListener("click", previewCritImport);
document.getElementById("critXlsxInput").addEventListener("change", () => { clearCritImportMessages(); clearCritImportPreview(); });

// ---------- Reset selects ----------
function renderResetSelects() {
  const judgeSel = document.getElementById("resetJudgeSelect");
  const teamSel = document.getElementById("resetTeamSelect");
  judgeSel.innerHTML = judges.map((j) => `<option value="${j.id}">${escapeHtml(j.name)}</option>`).join("");
  teamSel.innerHTML = teams.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
}

// ---------- Reset actions ----------
// Each reset stamps a "scoresResetAt" marker (global, per-judge, or per-team)
// so that a judge's browser knows to discard any local draft saved before the
// reset, instead of resurrecting a stale score after the reset. Without this,
// "Reset Scores" only clears Firestore -- each judge's own device would keep
// showing their old local draft as if nothing happened.
document.getElementById("resetAllBtn").addEventListener("click", async () => {
  if (!confirm("This deletes ALL scorecards from ALL judges for ALL teams. Continue?")) return;
  await deleteAllScores(scores);
  await setDoc(doc(db, "config", "settings"), { scoresResetAt: Date.now() }, { merge: true });
  alert("All scores have been reset.");
});

document.getElementById("resetJudgeBtn").addEventListener("click", async () => {
  const judgeId = document.getElementById("resetJudgeSelect").value;
  const judge = judges.find((j) => j.id === judgeId);
  if (!judge) return;
  if (!confirm(`Delete all scores submitted by "${judge.name}"?`)) return;
  const toDelete = scores.filter((s) => s.judgeId === judgeId);
  await deleteAllScores(toDelete);
  await updateDoc(doc(db, "judges", judgeId), { scoresResetAt: Date.now() });
  alert(`Reset scores for judge "${judge.name}".`);
});

document.getElementById("resetTeamBtn").addEventListener("click", async () => {
  const teamId = document.getElementById("resetTeamSelect").value;
  const team = teams.find((t) => t.id === teamId);
  if (!team) return;
  if (!confirm(`Delete all scores for team "${team.name}" (from every judge)?`)) return;
  const toDelete = scores.filter((s) => s.teamId === teamId);
  await deleteAllScores(toDelete);
  await updateDoc(doc(db, "teams", teamId), { scoresResetAt: Date.now() });
  alert(`Reset scores for team "${team.name}".`);
});

async function deleteAllScores(list) {
  const chunkSize = 400; // Firestore batches max out at 500 writes
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const batch = writeBatch(db);
    chunk.forEach((s) => batch.delete(doc(db, "scores", s.id)));
    await batch.commit();
  }
}

// ---------- Team penalties ----------
document.getElementById("savePenaltyValueBtn").addEventListener("click", async () => {
  const input = document.getElementById("penaltyValueInput");
  const okEl = document.getElementById("penaltyValueOk");
  const errEl = document.getElementById("penaltyValueErr");
  errEl.classList.add("hidden");
  okEl.classList.add("hidden");
  const val = Number(input.value);
  if (!(val >= 0)) {
    errEl.textContent = "Penalty amount must be zero or a positive number.";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    await setDoc(doc(db, "config", "settings"), { teamPenaltyValue: val }, { merge: true });
    okEl.classList.remove("hidden");
    setTimeout(() => okEl.classList.add("hidden"), 2000);
  } catch (e) {
    console.error(e);
    errEl.textContent = e.code === "permission-denied"
      ? "Save failed: permission denied. Your Firestore rules need a rule for the \"config\" collection allowing the admin account to write it."
      : "Couldn't save the penalty amount. Check your connection and try again.";
    errEl.classList.remove("hidden");
  }
});

function renderPenaltiesTable() {
  const tbody = document.querySelector("#penaltiesTable tbody");
  if (!tbody) return; // tab not in the DOM yet on first paint
  if (!loaded.teams) {
    tbody.innerHTML = loadingRow(4);
    return;
  }
  const penalized = teams.filter((t) => typeof t.penalty === "number" && t.penalty > 0);
  tbody.innerHTML = "";
  if (penalized.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No teams currently penalized.</td></tr>`;
    return;
  }
  penalized.forEach((t) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(t.name)}</td>
      <td>-${t.penalty}</td>
      <td class="muted">${escapeHtml(t.penaltyReason || "—")}</td>
      <td><button class="btn danger small removePenaltyBtn">Remove</button></td>
    `;
    tr.querySelector(".removePenaltyBtn").addEventListener("click", async () => {
      if (!confirm(`Remove the penalty from "${t.name}"?`)) return;
      try {
        await updateDoc(doc(db, "teams", t.id), { penalty: deleteField(), penaltyReason: deleteField() });
      } catch (e) {
        console.error(e);
        alert("Couldn't remove the penalty. Check your connection and try again.");
      }
    });
    tbody.appendChild(tr);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
