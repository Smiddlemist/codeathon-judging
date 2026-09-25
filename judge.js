import {
  auth, db, ADMIN_EMAIL, signInWithEmailAndPassword, sendPasswordResetEmail,
  onAuthStateChanged, signOut
} from "./firebase-init.js";
import {
  collection, doc, getDoc, setDoc, updateDoc, deleteField, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

// ---------- Admin detection ----------
// Same login screen for everyone. Whether the extra admin controls (Admin
// Console button, team penalty button) show up depends ONLY on the signed-in
// Firebase Auth account's email matching ADMIN_EMAIL -- no URL trick, no
// separate login. Every write those controls trigger is still checked
// against that same account by the Firestore security rules, so this is
// real security, not just a hidden button.
let showAdminUI = false; // true only when signed in as ADMIN_EMAIL
let teamPenaltyValue = 0; // loaded from config/settings, admin-configured flat point deduction

// ---------- Idle timeout ----------
// After this many milliseconds of no clicks/keystrokes/scrolling/touches
// while signed in, we sign the person out and send them back to the poster
// landing page (index.html). Meant for a shared/kiosk-style device at the
// event so one person's session doesn't stay open indefinitely. Change the
// number below to adjust the timeout.
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

// ---------- element refs ----------
const loginScreen = document.getElementById("loginScreen");
const emailInput = document.getElementById("emailInput");
const passInput = document.getElementById("passInput");
const loginBtn = document.getElementById("loginBtn");
const loginErr = document.getElementById("loginErr");
const forgotBtn = document.getElementById("forgotBtn");

const judgeApp = document.getElementById("judgeApp");
const judgeBadge = document.getElementById("judgeBadge");
const signOutBtn = document.getElementById("signOutBtn");
const adminConsoleBtn = document.getElementById("adminConsoleBtn");

const teamsList = document.getElementById("teamsList");
const noTeamsMsg = document.getElementById("noTeamsMsg");
const progressText = document.getElementById("progressText");

const emptyState = document.getElementById("emptyState");
const scorecardContent = document.getElementById("scorecardContent");

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
const applyPenaltyBtn = document.getElementById("applyPenaltyBtn");
const penaltyBadge = document.getElementById("penaltyBadge");

const NOMINATION_OPTIONS = [
  { key: "recommend", label: "Recommend for further development" },
  { key: "mostCreative", label: "Most creative / innovative" },
  { key: "highestImpact", label: "Highest business impact" },
  { key: "bestDemo", label: "Best demo / presentation" },
  { key: "fanFavorite", label: "Fan favorite" }
];

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
let justSignedIn = false;

loginBtn.addEventListener("click", async () => {
  loginErr.classList.add("hidden");
  loginBtn.disabled = true;
  try {
    justSignedIn = true;
    await signInWithEmailAndPassword(auth, emailInput.value.trim(), passInput.value);
  } catch (e) {
    justSignedIn = false;
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
    showAdminUI = false;
    justSignedIn = false;
    idleActive = false;
    if (idleTimer) clearTimeout(idleTimer);
    return;
  }

  const isAdminAccount = user.email === ADMIN_EMAIL;
  let judgeDocSnap = await getDoc(doc(db, "judges", user.uid));

  if (isAdminAccount && !judgeDocSnap.exists()) {
    // The admin account is also a full judge -- give it a real judges/{uid}
    // record the first time it signs in here, so it scores teams, appears in
    // the admin console's Judges list, and shows up in the Judge Coverage
    // matrix exactly like anyone else.
    await setDoc(doc(db, "judges", user.uid), {
      name: "Admin", email: user.email, active: true, createdAt: Date.now()
    });
    judgeDocSnap = await getDoc(doc(db, "judges", user.uid));
  }

  if (!judgeDocSnap.exists() || judgeDocSnap.data().active === false) {
    loginErr.textContent = "This account isn't set up as an active judge. Contact the event admin.";
    loginErr.classList.remove("hidden");
    await signOut(auth);
    return;
  }

  if (justSignedIn) {
    // They just successfully signed in from this exact login form -- send
    // them to the poster landing page first; they click through from there
    // to actually enter the scorecard. A page load with an already-existing
    // session (e.g. clicking through from index.html, or a refresh while
    // already signed in) skips this and goes straight to the scorecard below.
    justSignedIn = false;
    window.location.href = "index.html";
    return;
  }

  currentJudge = { id: user.uid, ...judgeDocSnap.data() };

  // UI-only gate: purely whether this account's email is the admin email.
  // Firestore security rules are the actual enforcement for any write these
  // buttons trigger -- this only controls what's visible in this browser.
  showAdminUI = isAdminAccount;
  adminConsoleBtn.classList.toggle("hidden", !showAdminUI);

  loginScreen.classList.add("hidden");
  judgeApp.classList.remove("hidden");
  judgeBadge.textContent = "Signed in as " + currentJudge.name;
  loadTeams();
  loadCriteria();
  loadMyScores();
  if (showAdminUI) loadPenaltyConfig();
  flushPendingSaves();
  idleActive = true;
  resetIdleTimer();
});

adminConsoleBtn.addEventListener("click", () => {
  window.location.href = "admin.html";
});

function loadPenaltyConfig() {
  onSnapshot(doc(db, "config", "settings"), (snap) => {
    teamPenaltyValue = snap.exists() && typeof snap.data().teamPenaltyValue === "number"
      ? snap.data().teamPenaltyValue
      : 0;
    if (currentTeam) updatePenaltyUI();
  });
}

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
    if (currentTeam) {
      const fresh = teams.find((t) => t.id === currentTeam.id);
      if (fresh) {
        currentTeam.penalty = fresh.penalty;
        currentTeam.penaltyReason = fresh.penaltyReason;
        updatePenaltyUI();
      }
    }
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

  updatePenaltyUI();

  emptyState.classList.add("hidden");
  scorecardContent.classList.remove("hidden");
  renderTeamsRail(); // refresh active-highlight
  scorecardContent.scrollTo({ top: 0, behavior: "auto" });
}

// ---------- Team penalty (admin-only) ----------
const penaltyPanel = document.getElementById("penaltyPanel");
const penaltyPanelTitle = document.getElementById("penaltyPanelTitle");
const penaltyApplyFields = document.getElementById("penaltyApplyFields");
const penaltyReasonInput = document.getElementById("penaltyReasonInput");
const penaltyPanelMsg = document.getElementById("penaltyPanelMsg");
const penaltyPanelCancelBtn = document.getElementById("penaltyPanelCancelBtn");
const penaltyPanelConfirmBtn = document.getElementById("penaltyPanelConfirmBtn");
let penaltyPanelMode = null; // "apply" | "remove" | null

function updatePenaltyUI() {
  closePenaltyPanel();
  if (!showAdminUI || !currentTeam) {
    applyPenaltyBtn.classList.add("hidden");
    penaltyBadge.classList.add("hidden");
    return;
  }
  const hasPenalty = typeof currentTeam.penalty === "number" && currentTeam.penalty > 0;
  applyPenaltyBtn.classList.remove("hidden");
  applyPenaltyBtn.textContent = hasPenalty
    ? `Remove Team Penalty (-${currentTeam.penalty})`
    : `Apply Team Penalty (-${teamPenaltyValue})`;
  penaltyBadge.classList.toggle("hidden", !hasPenalty);
  if (hasPenalty) {
    penaltyBadge.textContent = `Penalty applied: -${currentTeam.penalty}` +
      (currentTeam.penaltyReason ? ` — ${currentTeam.penaltyReason}` : "");
  }
}

function closePenaltyPanel() {
  penaltyPanelMode = null;
  penaltyPanel.classList.add("hidden");
  penaltyReasonInput.value = "";
  penaltyPanelMsg.textContent = "";
}

applyPenaltyBtn.addEventListener("click", () => {
  if (!showAdminUI || !currentTeam) return;
  const hasPenalty = typeof currentTeam.penalty === "number" && currentTeam.penalty > 0;

  if (hasPenalty) {
    penaltyPanelMode = "remove";
    penaltyPanelTitle.textContent = "Remove team penalty";
    penaltyApplyFields.classList.add("hidden");
    penaltyPanelMsg.textContent = `Remove the ${currentTeam.penalty}-point penalty from "${currentTeam.name}"?`;
    penaltyPanelConfirmBtn.textContent = "Remove penalty";
  } else {
    if (!teamPenaltyValue) {
      penaltyPanelMode = null;
      penaltyPanelTitle.textContent = "Apply team penalty";
      penaltyApplyFields.classList.add("hidden");
      penaltyPanelMsg.textContent = 'The penalty amount is currently 0. Set it in the admin console\u2019s "Penalties" tab first, then come back here.';
      penaltyPanelConfirmBtn.classList.add("hidden");
      penaltyPanel.classList.remove("hidden");
      return;
    }
    penaltyPanelMode = "apply";
    penaltyPanelTitle.textContent = "Apply team penalty";
    penaltyApplyFields.classList.remove("hidden");
    penaltyPanelMsg.textContent = `This subtracts ${teamPenaltyValue} points from "${currentTeam.name}"'s overall score on the leaderboard immediately for everyone.`;
    penaltyPanelConfirmBtn.textContent = `Apply -${teamPenaltyValue} penalty`;
  }
  penaltyPanelConfirmBtn.classList.remove("hidden");
  penaltyPanel.classList.remove("hidden");
  if (penaltyPanelMode === "apply") penaltyReasonInput.focus();
});

penaltyPanelCancelBtn.addEventListener("click", closePenaltyPanel);

penaltyPanelConfirmBtn.addEventListener("click", async () => {
  if (!penaltyPanelMode || !currentTeam) return;
  penaltyPanelConfirmBtn.disabled = true;
  try {
    if (penaltyPanelMode === "remove") {
      await updateDoc(doc(db, "teams", currentTeam.id), { penalty: deleteField(), penaltyReason: deleteField() });
      currentTeam.penalty = undefined;
      currentTeam.penaltyReason = undefined;
    } else {
      const reason = penaltyReasonInput.value.trim();
      await updateDoc(doc(db, "teams", currentTeam.id), { penalty: teamPenaltyValue, penaltyReason: reason });
      currentTeam.penalty = teamPenaltyValue;
      currentTeam.penaltyReason = reason;
    }
    updatePenaltyUI();
    closePenaltyPanel();
  } catch (e) {
    console.error(e);
    penaltyPanelMsg.textContent = e.code === "permission-denied"
      ? "Couldn't update the penalty: permission denied. Check your Firestore rules for the \"teams\" collection."
      : "Couldn't update the penalty. Check your connection and try again.";
  } finally {
    penaltyPanelConfirmBtn.disabled = false;
  }
});

function closeScorecard(persistDraft = true) {
  if (persistDraft) saveDraftLocally();
  scorecardContent.classList.add("hidden");
  emptyState.classList.remove("hidden");
  currentTeam = null;
  renderTeamsRail();
}

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

    for (let n = 1; n <= 5; n++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "score-btn" + (val === n ? " active" : "");
      btn.textContent = String(n);
      btn.dataset.val = String(n);
      btn.addEventListener("click", () => {
        sliderValues[c.id] = n;
        touched[c.id] = true;
        buttonWrap.querySelectorAll(".score-btn").forEach((b) => {
          b.classList.toggle("active", Number(b.dataset.val) === n);
        });
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
  const fraction = Math.max(0, Math.min(1, weighted / 5));
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
