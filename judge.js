import {
  auth, db, signInWithEmailAndPassword, sendPasswordResetEmail,
  onAuthStateChanged, signOut
} from "./firebase-init.js";
import {
  collection, doc, getDoc, setDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const loginScreen = document.getElementById("loginScreen");
const emailInput = document.getElementById("emailInput");
const passInput = document.getElementById("passInput");
const loginBtn = document.getElementById("loginBtn");
const loginErr = document.getElementById("loginErr");
const forgotBtn = document.getElementById("forgotBtn");

const judgeApp = document.getElementById("judgeApp");
const judgeBadge = document.getElementById("judgeBadge");
const signOutBtn = document.getElementById("signOutBtn");

const teamsView = document.getElementById("teamsView");
const teamsGrid = document.getElementById("teamsGrid");
const noTeamsMsg = document.getElementById("noTeamsMsg");
const progressText = document.getElementById("progressText");

const scorecardView = document.getElementById("scorecardView");
const backToTeamsBtn = document.getElementById("backToTeamsBtn");
const scTeamName = document.getElementById("scTeamName");
const scTeamLead = document.getElementById("scTeamLead");
const liveScoreVal = document.getElementById("liveScoreVal");
const criteriaContainer = document.getElementById("criteriaContainer");
const noCriteriaMsg = document.getElementById("noCriteriaMsg");
const strengthsBox = document.getElementById("strengthsBox");
const improvementsBox = document.getElementById("improvementsBox");
const commentsBox = document.getElementById("commentsBox");
const cancelScoreBtn = document.getElementById("cancelScoreBtn");
const submitScoreBtn = document.getElementById("submitScoreBtn");
const scoreErr = document.getElementById("scoreErr");

let currentJudge = null; // { id: uid, name, email }
let teams = [];
let criteria = [];
let myScores = {};
let currentTeam = null;
let sliderValues = {};

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
    loginErr.classList.add("hidden");
    alert("If that email has an account, a password reset link has been sent to it.");
  } catch (e) {
    alert("If that email has an account, a password reset link has been sent to it.");
  }
});

signOutBtn.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    judgeApp.classList.add("hidden");
    loginScreen.classList.remove("hidden");
    currentJudge = null;
    return;
  }
  // Confirm this account is a registered, active judge.
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
  judgeBadge.textContent = "👤 " + currentJudge.name;
  loadTeams();
  loadCriteria();
  loadMyScores();
});

// ---------- Live data ----------
function loadTeams() {
  onSnapshot(query(collection(db, "teams"), orderBy("name")), (snap) => {
    teams = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTeams();
  });
}

function loadCriteria() {
  onSnapshot(collection(db, "criteria"), (snap) => {
    criteria = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    renderTeams();
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
    renderTeams();
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

// ---------- Team list view ----------
function renderTeams() {
  if (!currentJudge) return;
  teamsGrid.innerHTML = "";
  if (teams.length === 0) {
    noTeamsMsg.classList.remove("hidden");
    progressText.textContent = "No teams yet";
    return;
  }
  noTeamsMsg.classList.add("hidden");

  let scoredCount = 0;
  teams.forEach((team) => {
    const existing = myScores[team.id];
    if (existing) scoredCount++;
    const weighted = existing ? weightedScoreOf(existing).toFixed(1) : null;

    const card = document.createElement("div");
    card.className = "card team-card";
    card.innerHTML = `
      <div class="team-name">${escapeHtml(team.name)}</div>
      <div class="team-lead">Lead: ${escapeHtml(team.lead || "—")}</div>
      ${
        existing
          ? `<span class="score-badge">✅ Scored — ${weighted}/10</span>`
          : `<span class="score-badge pending">⏳ Not scored yet</span>`
      }
      <button class="btn ${existing ? "secondary" : ""}" style="margin-top:8px;">
        ${existing ? "Edit Score" : "Score this team"}
      </button>
    `;
    card.querySelector("button").addEventListener("click", () => openScorecard(team));
    teamsGrid.appendChild(card);
  });

  progressText.textContent = `Scored ${scoredCount} of ${teams.length} teams`;
}

// ---------- Full-page scorecard ----------
function openScorecard(team) {
  currentTeam = team;
  const existing = myScores[team.id];
  sliderValues = {};
  criteria.forEach((c) => {
    const existingVal = existing && existing.criteria ? existing.criteria[c.id] : undefined;
    sliderValues[c.id] = typeof existingVal === "number" ? existingVal : 5;
  });

  scTeamName.textContent = team.name;
  scTeamLead.textContent = "Lead: " + (team.lead || "—");
  strengthsBox.value = existing ? existing.strengths || "" : "";
  improvementsBox.value = existing ? existing.improvements || "" : "";
  commentsBox.value = existing ? existing.additionalComments || "" : "";
  scoreErr.classList.add("hidden");
  renderCriteria();

  teamsView.classList.add("hidden");
  scorecardView.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function closeScorecard() {
  scorecardView.classList.add("hidden");
  teamsView.classList.remove("hidden");
  currentTeam = null;
}

backToTeamsBtn.addEventListener("click", closeScorecard);
cancelScoreBtn.addEventListener("click", closeScorecard);

function renderCriteria() {
  criteriaContainer.innerHTML = "";
  if (criteria.length === 0) {
    noCriteriaMsg.classList.remove("hidden");
    submitScoreBtn.disabled = true;
    liveScoreVal.textContent = "0.0";
    return;
  }
  noCriteriaMsg.classList.add("hidden");
  submitScoreBtn.disabled = false;

  criteria.forEach((c) => {
    const block = document.createElement("div");
    block.className = "criterion-block";
    const weightBadge = c.weight && c.weight !== 1 ? ` <span class="pill">weight ×${c.weight}</span>` : "";
    const descHtml = c.description ? `<div class="crit-desc">${escapeHtml(c.description)}</div>` : "";
    block.innerHTML = `
      <div class="crit-label">${escapeHtml(c.label)}${weightBadge}</div>
      ${descHtml}
      <div class="slider-row">
        <input type="range" min="0" max="10" step="1" value="${sliderValues[c.id]}" data-key="${c.id}" />
        <div class="val">${sliderValues[c.id]}</div>
      </div>
    `;
    const input = block.querySelector("input");
    const valDiv = block.querySelector(".val");
    input.addEventListener("input", () => {
      sliderValues[c.id] = Number(input.value);
      valDiv.textContent = input.value;
      updateLiveScore();
    });
    criteriaContainer.appendChild(block);
  });
  updateLiveScore();
}

function updateLiveScore() {
  let sum = 0;
  let weightTotal = 0;
  criteria.forEach((c) => {
    const w = c.weight ?? 1;
    sum += (sliderValues[c.id] ?? 0) * w;
    weightTotal += w;
  });
  const weighted = weightTotal > 0 ? sum / weightTotal : 0;
  liveScoreVal.textContent = weighted.toFixed(1);
}

submitScoreBtn.addEventListener("click", async () => {
  if (!currentJudge || !currentTeam || criteria.length === 0) return;
  submitScoreBtn.disabled = true;
  scoreErr.classList.add("hidden");
  try {
    const scoreId = `${currentJudge.id}_${currentTeam.id}`;
    await setDoc(doc(db, "scores", scoreId), {
      judgeId: currentJudge.id,
      judgeName: currentJudge.name,
      teamId: currentTeam.id,
      teamName: currentTeam.name,
      criteria: { ...sliderValues },
      strengths: strengthsBox.value.trim(),
      improvements: improvementsBox.value.trim(),
      additionalComments: commentsBox.value.trim(),
      updatedAt: Date.now()
    });
    closeScorecard();
  } catch (e) {
    console.error(e);
    scoreErr.textContent = "Couldn't save your score. Check your connection and try again.";
    scoreErr.classList.remove("hidden");
  } finally {
    submitScoreBtn.disabled = false;
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
