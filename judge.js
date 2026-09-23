import {
  auth, db, signInWithEmailAndPassword, sendPasswordResetEmail,
  onAuthStateChanged, signOut
} from "./firebase-init.js";
import {
  collection, doc, getDoc, setDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

// ---------- element refs ----------
const loginScreen = document.getElementById("loginScreen");
const emailInput = document.getElementById("emailInput");
const passInput = document.getElementById("passInput");
const loginBtn = document.getElementById("loginBtn");
const loginErr = document.getElementById("loginErr");
const forgotBtn = document.getElementById("forgotBtn");

const splashScreen = document.getElementById("splashScreen");

const judgeApp = document.getElementById("judgeApp");
const judgeBadge = document.getElementById("judgeBadge");
const signOutBtn = document.getElementById("signOutBtn");

const teamsList = document.getElementById("teamsList");
const noTeamsMsg = document.getElementById("noTeamsMsg");
const progressText = document.getElementById("progressText");

const emptyState = document.getElementById("emptyState");
const scorecardContent = document.getElementById("scorecardContent");
const draftBanner = document.getElementById("draftBanner");
const draftBannerText = document.getElementById("draftBannerText");
const discardDraftBtn = document.getElementById("discardDraftBtn");

const scTeamName = document.getElementById("scTeamName");
const scTeamMeta = document.getElementById("scTeamMeta");
const scTeamDescription = document.getElementById("scTeamDescription");
const liveScoreVal = document.getElementById("liveScoreVal");
const criteriaTotalFill = document.getElementById("criteriaTotalFill");
const criteriaContainer = document.getElementById("criteriaContainer");
const noCriteriaMsg = document.getElementById("noCriteriaMsg");
const strengthsBox = document.getElementById("strengthsBox");
const improvementsBox = document.getElementById("improvementsBox");
const commentsBox = document.getElementById("commentsBox");
const nominationsList = document.getElementById("nominationsList");
const cancelScoreBtn = document.getElementById("cancelScoreBtn");
const submitScoreBtn = document.getElementById("submitScoreBtn");
const scoreErr = document.getElementById("scoreErr");
const scoreOk = document.getElementById("scoreOk");
const unsavedTag = document.getElementById("unsavedTag");

const NOMINATION_OPTIONS = [
  { key: "recommend", label: "Recommend for further development" },
  { key: "mostCreative", label: "Most creative / innovative" },
  { key: "highestImpact", label: "Highest business impact" },
  { key: "bestDemo", label: "Best demo / presentation" },
  { key: "fanFavorite", label: "Fan favorite" }
];

// ---------- Event poster splash ----------
// Shown once per browser tab session, right after a judge signs in: a few
// seconds of the event poster, dismissible early by tapping anywhere.
let splashShown = false;
function showSplashOnce() {
  if (splashShown) return;
  try {
    if (sessionStorage.getItem("codeathonSplashShown")) { splashShown = true; return; }
  } catch (e) {
    // sessionStorage unavailable — fine, it'll just show every time in that case.
  }
  splashShown = true;
  splashScreen.classList.remove("hidden");
  const dismiss = () => {
    splashScreen.classList.add("fade-out");
    setTimeout(() => splashScreen.classList.add("hidden"), 400);
    try { sessionStorage.setItem("codeathonSplashShown", "1"); } catch (e) {}
  };
  splashScreen.addEventListener("click", dismiss, { once: true });
  setTimeout(dismiss, 3000);
}

// ---------- state ----------
let currentJudge = null; // { id: uid, name, email, ... }
let teams = [];
let criteria = [];
let myScores = {};        // teamId -> saved score doc
let currentTeam = null;
let sliderValues = {};    // criterionId -> number | null
let touched = {};         // criterionId -> boolean (has the judge interacted with it)
let nominations = {};     // nominationKey -> boolean
let lastSavedSnapshot = null; // JSON string of last-saved form state, for dirty checking

// ---------- Login ----------
loginBtn.addEventListener("click", async () => {
  loginErr.classList.add("hidden");
  loginBtn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, emailInput.value.trim(), passInput.value);
  } catch (e) {
    loginErr.textContent = "Sign-in failed. Check your email and password.";
    loginErr.classList.remove("hidden");
  } finally {
    loginBtn.disabled = false;
  }
});

forgotBtn.addEventListener("click", async () => {
  const email = emailInput.value.trim();
  if (!email) {
    loginErr.textContent = "Type your email above first, then click 'Forgot your password?' again.";
    loginErr.classList.remove("hidden");
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (e) {
    // Intentionally same message either way, so we don't reveal which emails exist.
  }
  loginErr.classList.add("hidden");
  alert("If that email has an account, a password reset link has been sent to it.");
});

signOutBtn.addEventListener("click", () => {
  if (isDirty()) {
    const ok = confirm("You have unsaved changes on this scorecard. Sign out anyway?");
    if (!ok) return;
  }
  signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    judgeApp.classList.add("hidden");
    loginScreen.classList.remove("hidden");
    currentJudge = null;
    return;
  }
  const judgeDocSnap = await getDoc(doc(db, "judges", user.uid));
  if (!judgeDocSnap.exists() || judgeDocSnap.data().active === false) {
    loginErr.textContent = "This account isn't set up as an active judge. Contact the event admin.";
    loginErr.classList.remove("hidden");
    await signOut(auth);
    return;
  }
  currentJudge = { id: user.uid, ...judgeDocSnap.data() };
  loginScreen.classList.add("hidden");
  judgeApp.classList.remove("hidden");
  judgeBadge.textContent = "Signed in as " + currentJudge.name;
  showSplashOnce();
  loadTeams();
  loadCriteria();
  loadMyScores();
  flushPendingSaves();
});

window.addEventListener("online", flushPendingSaves);

// Auto-save the current scorecard as a local draft the moment the judge leaves it:
// switching tabs/apps, closing the tab, or navigating away. This intentionally does
// NOT save on every keystroke — only when they actually leave — so it stays out of
// the way while scoring and still catches you before anything is lost.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveDraftLocally();
});
window.addEventListener("pagehide", saveDraftLocally);
window.addEventListener("beforeunload", (e) => {
  saveDraftLocally();
  if (isDirty()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---------- Live data ----------
function loadTeams() {
  onSnapshot(query(collection(db, "teams"), orderBy("name")), (snap) => {
    teams = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTeamsRail();
  });
}

function loadCriteria() {
  onSnapshot(collection(db, "criteria"), (snap) => {
    criteria = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    renderTeamsRail();
    // If a scorecard is already open, re-render its criteria against the new list.
    if (currentTeam) renderCriteria();
  });
}

function loadMyScores() {
  onSnapshot(collection(db, "scores"), (snap) => {
    myScores = {};
    snap.docs.forEach((d) => {
      const data = d.data();
      if (currentJudge && data.judgeId === currentJudge.id) {
        myScores[data.teamId] = data;
      }
    });
    renderTeamsRail();
  });
}

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

function weightedScoreOfCurrent() {
  let sum = 0;
  let weightTotal = 0;
  criteria.forEach((c) => {
    const w = c.weight ?? 1;
    const v = sliderValues[c.id];
    if (typeof v === "number") {
      sum += v * w;
      weightTotal += w;
    }
  });
  return weightTotal > 0 ? sum / weightTotal : 0;
}

// ---------- Draft persistence (localStorage, per judge+team) ----------
function draftKey(judgeId, teamId) {
  return `codeathonDraft_${judgeId}_${teamId}`;
}
function pendingKey(scoreId) {
  return `codeathonPending_${scoreId}`;
}

function saveDraftLocally() {
  if (!currentJudge || !currentTeam) return;
  const draft = {
    criteria: { ...sliderValues },
    strengths: strengthsBox.value,
    improvements: improvementsBox.value,
    additionalComments: commentsBox.value,
    nominations: { ...nominations },
    savedAt: Date.now()
  };
  try {
    localStorage.setItem(draftKey(currentJudge.id, currentTeam.id), JSON.stringify(draft));
  } catch (e) {
    // localStorage unavailable (private browsing, quota) — draft recovery just won't work this time.
  }
}

function readDraft(judgeId, teamId) {
  try {
    const raw = localStorage.getItem(draftKey(judgeId, teamId));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearDraft(judgeId, teamId) {
  try {
    localStorage.removeItem(draftKey(judgeId, teamId));
  } catch (e) {}
}

// ---------- Pending (offline) saves ----------
function flushPendingSaves() {
  let keys;
  try {
    keys = Object.keys(localStorage).filter((k) => k.startsWith("codeathonPending_"));
  } catch (e) {
    return;
  }
  keys.forEach(async (key) => {
    let payload;
    try {
      payload = JSON.parse(localStorage.getItem(key));
    } catch (e) {
      localStorage.removeItem(key);
      return;
    }
    const scoreId = key.replace("codeathonPending_", "");
    try {
      await setDoc(doc(db, "scores", scoreId), payload);
      localStorage.removeItem(key);
    } catch (e) {
      // Still offline / still failing — leave it queued, we'll retry next time.
    }
  });
}

// ---------- Dirty-state tracking ----------
function currentFormSnapshot() {
  return JSON.stringify({
    criteria: { ...sliderValues },
    strengths: strengthsBox.value,
    improvements: improvementsBox.value,
    additionalComments: commentsBox.value,
    nominations: { ...nominations }
  });
}

function isDirty() {
  if (!currentTeam) return false;
  return currentFormSnapshot() !== lastSavedSnapshot;
}

function refreshDirtyIndicator() {
  unsavedTag.classList.toggle("hidden", !isDirty());
}

// ---------- Team rail ----------
function renderTeamsRail() {
  if (!currentJudge) return;
  teamsList.innerHTML = "";
  if (teams.length === 0) {
    noTeamsMsg.classList.remove("hidden");
    progressText.textContent = "No teams yet";
    return;
  }
  noTeamsMsg.classList.add("hidden");

  let scoredCount = 0;
  teams.forEach((team) => {
    const existing = myScores[team.id];
    const draft = !existing ? readDraft(currentJudge.id, team.id) : null;
    if (existing) scoredCount++;

    const item = document.createElement("button");
    item.type = "button";
    item.className = "rail-item" + (existing ? " scored" : draft ? " has-draft" : "");
    if (currentTeam && currentTeam.id === team.id) item.classList.add("active");

    let statusLabel;
    if (existing) statusLabel = weightedScoreOf(existing).toFixed(1);
    else if (draft) statusLabel = "draft";
    else statusLabel = "unscored";

    item.innerHTML = `
      <span class="rail-team-name">${escapeHtml(team.name)}</span>
      <span class="rail-status">${statusLabel}</span>
    `;
    item.addEventListener("click", () => openScorecard(team));
    teamsList.appendChild(item);
  });

  progressText.textContent = `Scored ${scoredCount} of ${teams.length} teams`;
}

// ---------- Scorecard ----------
function openScorecard(team) {
  if (currentTeam && currentTeam.id !== team.id && isDirty()) {
    const ok = confirm("You have unsaved changes for the current team. Switch teams anyway? (Your changes are auto-saved as a draft on this device.)");
    if (!ok) return;
  }
  saveDraftLocally(); // preserve whatever we were doing on the previous team

  currentTeam = team;
  const existing = myScores[team.id];
  const draft = !existing ? readDraft(currentJudge.id, team.id) : null;

  sliderValues = {};
  touched = {};
  criteria.forEach((c) => {
    const savedVal = existing && existing.criteria ? existing.criteria[c.id] : undefined;
    const draftVal = draft && draft.criteria ? draft.criteria[c.id] : undefined;
    if (typeof savedVal === "number") {
      sliderValues[c.id] = savedVal;
      touched[c.id] = true;
    } else if (typeof draftVal === "number") {
      sliderValues[c.id] = draftVal;
      touched[c.id] = true;
    } else {
      sliderValues[c.id] = null;
      touched[c.id] = false;
    }
  });

  scTeamName.textContent = team.name;
  const metaParts = [];
  if (team.lead) metaParts.push("Lead: " + team.lead);
  if (team.members) metaParts.push("Team: " + team.members);
  scTeamMeta.textContent = metaParts.join("   \u00b7   ");
  scTeamDescription.textContent = team.description || "";
  strengthsBox.value = existing ? existing.strengths || "" : draft ? draft.strengths || "" : "";
  improvementsBox.value = existing ? existing.improvements || "" : draft ? draft.improvements || "" : "";
  commentsBox.value = existing ? existing.additionalComments || "" : draft ? draft.additionalComments || "" : "";

  nominations = {};
  NOMINATION_OPTIONS.forEach((n) => {
    const savedVal = existing && existing.nominations ? existing.nominations[n.key] : undefined;
    const draftVal = draft && draft.nominations ? draft.nominations[n.key] : undefined;
    nominations[n.key] = typeof savedVal === "boolean" ? savedVal : typeof draftVal === "boolean" ? draftVal : false;
  });
  renderNominationsSection();

  scoreErr.classList.add("hidden");
  scoreOk.classList.add("hidden");

  if (!existing && draft) {
    const when = new Date(draft.savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    draftBannerText.textContent = `Restored an unsaved draft from ${when} on this device.`;
    draftBanner.classList.remove("hidden");
  } else {
    draftBanner.classList.add("hidden");
  }

  renderCriteria();

  // Baseline for the "unsaved changes" comparison: if this team already has a saved
  // score, the baseline is those saved values. Otherwise the baseline is "nothing
  // entered yet" — even when we've just restored a local draft into the visible
  // fields above, that draft hasn't been saved to Firestore, so it should read as
  // dirty (prompting the judge to save it) rather than as a fresh, untouched form.
  if (existing) {
    lastSavedSnapshot = currentFormSnapshot();
  } else {
    const emptyCriteria = {};
    criteria.forEach((c) => { emptyCriteria[c.id] = null; });
    const emptyNominations = {};
    NOMINATION_OPTIONS.forEach((n) => { emptyNominations[n.key] = false; });
    lastSavedSnapshot = JSON.stringify({
      criteria: emptyCriteria, strengths: "", improvements: "", additionalComments: "",
      nominations: emptyNominations
    });
  }
  refreshDirtyIndicator();

  emptyState.classList.add("hidden");
  scorecardContent.classList.remove("hidden");
  renderTeamsRail(); // refresh active-highlight
  scorecardContent.scrollTo({ top: 0, behavior: "auto" });
}

function closeScorecard(persistDraft = true) {
  if (persistDraft) saveDraftLocally();
  scorecardContent.classList.add("hidden");
  emptyState.classList.remove("hidden");
  currentTeam = null;
  renderTeamsRail();
}

discardDraftBtn.addEventListener("click", () => {
  if (!currentJudge || !currentTeam) return;
  clearDraft(currentJudge.id, currentTeam.id);
  const team = currentTeam;
  currentTeam = null; // prevents openScorecard from re-persisting the discarded values as a new draft
  openScorecard(team);
});

cancelScoreBtn.addEventListener("click", () => {
  if (isDirty()) {
    const ok = confirm("Discard your changes to this scorecard?");
    if (!ok) return;
    if (currentJudge && currentTeam) clearDraft(currentJudge.id, currentTeam.id);
    closeScorecard(false);
    return;
  }
  closeScorecard();
});

function renderNominationsSection() {
  renderNominationCheckboxes();
}

function renderNominationCheckboxes() {
  nominationsList.innerHTML = "";
  NOMINATION_OPTIONS.forEach((n) => {
    const label = document.createElement("label");
    label.className = "nom-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!nominations[n.key];
    checkbox.addEventListener("change", () => {
      nominations[n.key] = checkbox.checked;
      refreshDirtyIndicator();
      scoreOk.classList.add("hidden");
    });
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(" " + n.label));
    nominationsList.appendChild(label);
  });
}

function renderCriteria() {
  criteriaContainer.innerHTML = "";
  if (criteria.length === 0) {
    noCriteriaMsg.classList.remove("hidden");
    submitScoreBtn.disabled = true;
    liveScoreVal.textContent = "0.0";
    setTotalBar(0);
    return;
  }
  noCriteriaMsg.classList.add("hidden");
  submitScoreBtn.disabled = false;

  criteria.forEach((c) => {
    const row = document.createElement("div");
    row.className = "crit-row criterion-block";
    row.dataset.key = c.id;
    const weightBadge = c.weight && c.weight !== 1 ? `<span class="pill">weight &times;${c.weight}</span>` : "";
    const infoBtn = c.description ? `<button type="button" class="info-btn" aria-expanded="false" aria-label="Show description">i</button>` : "";
    const descHtml = c.description ? `<div class="crit-desc hidden">${escapeHtml(c.description)}</div>` : "";
    const val = sliderValues[c.id];

    row.innerHTML = `
      <div class="crit-row-info">
        <div class="crit-top">
          <span class="crit-label">${escapeHtml(c.label)}</span>
          ${weightBadge}
          ${infoBtn}
        </div>
        ${descHtml}
      </div>
      <div class="crit-buttons"></div>
      <div class="crit-score-col${typeof val === "number" ? "" : " unscored"}">${typeof val === "number" ? val : "\u2013"}</div>
    `;

    const buttonWrap = row.querySelector(".crit-buttons");
    const scoreCol = row.querySelector(".crit-score-col");
    const info = row.querySelector(".info-btn");
    const desc = row.querySelector(".crit-desc");

    for (let n = 0; n <= 10; n++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "score-btn" + (val === n ? " active" : "");
      btn.textContent = String(n);
      btn.addEventListener("click", () => {
        sliderValues[c.id] = n;
        touched[c.id] = true;
        buttonWrap.querySelectorAll(".score-btn").forEach((b, idx) => b.classList.toggle("active", idx === n));
        scoreCol.textContent = String(n);
        scoreCol.classList.remove("unscored");
        row.classList.remove("untouched-error");
        updateLiveScore();
        refreshDirtyIndicator();
        scoreOk.classList.add("hidden");
      });
      buttonWrap.appendChild(btn);
    }

    if (info) {
      info.addEventListener("click", () => {
        const isOpen = !desc.classList.contains("hidden");
        desc.classList.toggle("hidden", isOpen);
        info.setAttribute("aria-expanded", String(!isOpen));
      });
    }

    criteriaContainer.appendChild(row);
  });
  updateLiveScore();
}

function updateLiveScore() {
  const weighted = weightedScoreOfCurrent();
  liveScoreVal.textContent = weighted.toFixed(1);
  setTotalBar(weighted);
}

function setTotalBar(weighted) {
  const fraction = Math.max(0, Math.min(1, weighted / 10));
  criteriaTotalFill.style.width = (fraction * 100) + "%";
}

[strengthsBox, improvementsBox, commentsBox].forEach((el) => {
  el.addEventListener("input", refreshDirtyIndicator);
});

submitScoreBtn.addEventListener("click", async () => {
  if (!currentJudge || !currentTeam || criteria.length === 0) return;

  scoreErr.classList.add("hidden");
  scoreOk.classList.add("hidden");

  // Validate: every criterion needs a score before we'll save.
  const missing = criteria.filter((c) => !touched[c.id]);
  if (missing.length > 0) {
    document.querySelectorAll(".criterion-block").forEach((b) => b.classList.remove("untouched-error"));
    missing.forEach((c) => {
      const block = criteriaContainer.querySelector(`.criterion-block[data-key="${c.id}"]`);
      if (block) block.classList.add("untouched-error");
    });
    scoreErr.textContent = `Score every criterion before saving (missing: ${missing.map((c) => c.label).join(", ")}).`;
    scoreErr.classList.remove("hidden");
    return;
  }

  submitScoreBtn.disabled = true;
  const scoreId = `${currentJudge.id}_${currentTeam.id}`;
  const payload = {
    judgeId: currentJudge.id,
    judgeName: currentJudge.name,
    teamId: currentTeam.id,
    teamName: currentTeam.name,
    criteria: { ...sliderValues },
    strengths: strengthsBox.value.trim(),
    improvements: improvementsBox.value.trim(),
    additionalComments: commentsBox.value.trim(),
    nominations: { ...nominations },
    updatedAt: Date.now()
  };

  try {
    await setDoc(doc(db, "scores", scoreId), payload);
    clearDraft(currentJudge.id, currentTeam.id);
    lastSavedSnapshot = currentFormSnapshot();
    refreshDirtyIndicator();
    draftBanner.classList.add("hidden");
    scoreOk.textContent = "Score saved.";
    scoreOk.classList.remove("hidden");
    renderTeamsRail();
  } catch (e) {
    console.error(e);
    // Offline-safe fallback: keep it locally and sync automatically once we're back online.
    try {
      localStorage.setItem(pendingKey(scoreId), JSON.stringify(payload));
      lastSavedSnapshot = currentFormSnapshot();
      refreshDirtyIndicator();
      scoreOk.textContent = "Couldn't reach the server — saved on this device and will sync automatically once you're back online.";
      scoreOk.classList.remove("hidden");
    } catch (e2) {
      scoreErr.textContent = "Couldn't save your score. Check your connection and try again.";
      scoreErr.classList.remove("hidden");
    }
  } finally {
    submitScoreBtn.disabled = false;
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
