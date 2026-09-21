import {
  auth, db, signInAnonymously, onAuthStateChanged
} from "./firebase-init.js";
import {
  collection, doc, setDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const judgeSelect = document.getElementById("judgeSelect");
const selectJudgeCard = document.getElementById("selectJudgeCard");
const continueBtn = document.getElementById("continueBtn");
const noJudgesMsg = document.getElementById("noJudgesMsg");
const teamsSection = document.getElementById("teamsSection");
const teamsGrid = document.getElementById("teamsGrid");
const noTeamsMsg = document.getElementById("noTeamsMsg");
const progressText = document.getElementById("progressText");
const judgeBadge = document.getElementById("judgeBadge");
const switchJudgeBtn = document.getElementById("switchJudgeBtn");

const scoreModal = document.getElementById("scoreModal");
const modalTeamName = document.getElementById("modalTeamName");
const modalTeamLead = document.getElementById("modalTeamLead");
const criteriaContainer = document.getElementById("criteriaContainer");
const noCriteriaMsg = document.getElementById("noCriteriaMsg");
const strengthsBox = document.getElementById("strengthsBox");
const improvementsBox = document.getElementById("improvementsBox");
const commentsBox = document.getElementById("commentsBox");
const totalVal = document.getElementById("totalVal");
const cancelScoreBtn = document.getElementById("cancelScoreBtn");
const submitScoreBtn = document.getElementById("submitScoreBtn");
const scoreErr = document.getElementById("scoreErr");

let judges = [];
let teams = [];
let criteria = []; // [{id, label, weight, order}]
let myScores = {}; // teamId -> score doc
let currentJudge = null;
let currentTeam = null;
let sliderValues = {};

// ---- Auth: sign in anonymously so Firestore rules allow read/write ----
signInAnonymously(auth).catch((e) => console.error("Anon sign-in failed", e));

onAuthStateChanged(auth, (user) => {
  if (user) {
    loadJudges();
    loadTeams();
    loadCriteria();
  }
});

function loadJudges() {
  onSnapshot(collection(db, "judges"), (snap) => {
    judges = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((j) => j.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name));
    renderJudgeSelect();
  });
}

function loadCriteria() {
  onSnapshot(collection(db, "criteria"), (snap) => {
    criteria = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    renderTeams(); // re-render so score badges reflect the current weighting
  });
}

function renderJudgeSelect() {
  judgeSelect.innerHTML = "";
  if (judges.length === 0) {
    noJudgesMsg.classList.remove("hidden");
    continueBtn.disabled = true;
    return;
  }
  noJudgesMsg.classList.add("hidden");
  continueBtn.disabled = false;
  judges.forEach((j) => {
    const opt = document.createElement("option");
    opt.value = j.id;
    opt.textContent = j.name;
    judgeSelect.appendChild(opt);
  });
  const savedId = localStorage.getItem("judgeId");
  if (savedId && judges.some((j) => j.id === savedId)) {
    judgeSelect.value = savedId;
    selectJudge(savedId);
  }
}

function selectJudge(judgeId) {
  currentJudge = judges.find((j) => j.id === judgeId);
  if (!currentJudge) return;
  localStorage.setItem("judgeId", judgeId);
  selectJudgeCard.classList.add("hidden");
  teamsSection.classList.remove("hidden");
  judgeBadge.textContent = "👤 " + currentJudge.name;
  judgeBadge.classList.remove("hidden");
  switchJudgeBtn.classList.remove("hidden");
  loadMyScores();
}

continueBtn.addEventListener("click", () => selectJudge(judgeSelect.value));
switchJudgeBtn.addEventListener("click", () => {
  localStorage.removeItem("judgeId");
  location.reload();
});

function loadTeams() {
  const teamsRef = query(collection(db, "teams"), orderBy("name"));
  onSnapshot(teamsRef, (snap) => {
    teams = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
    card.querySelector("button").addEventListener("click", () => openModal(team));
    teamsGrid.appendChild(card);
  });

  progressText.textContent = `Scored ${scoredCount} of ${teams.length} teams`;
}

function openModal(team) {
  currentTeam = team;
  const existing = myScores[team.id];
  sliderValues = {};
  criteria.forEach((c) => {
    const existingVal = existing && existing.criteria ? existing.criteria[c.id] : undefined;
    sliderValues[c.id] = typeof existingVal === "number" ? existingVal : 5;
  });

  modalTeamName.textContent = team.name;
  modalTeamLead.textContent = "Lead: " + (team.lead || "—");
  strengthsBox.value = existing ? existing.strengths || "" : "";
  improvementsBox.value = existing ? existing.improvements || "" : "";
  commentsBox.value = existing ? existing.additionalComments || "" : "";
  scoreErr.classList.add("hidden");
  renderCriteria();
  scoreModal.classList.remove("hidden");
}

function renderCriteria() {
  criteriaContainer.innerHTML = "";
  if (criteria.length === 0) {
    noCriteriaMsg.classList.remove("hidden");
    submitScoreBtn.disabled = true;
    totalVal.textContent = "0.0";
    return;
  }
  noCriteriaMsg.classList.add("hidden");
  submitScoreBtn.disabled = false;

  criteria.forEach((c) => {
    const row = document.createElement("div");
    const weightBadge = c.weight && c.weight !== 1 ? ` <span class="pill">weight ×${c.weight}</span>` : "";
    row.innerHTML = `
      <label>${escapeHtml(c.label)}${weightBadge}</label>
      <div class="slider-row">
        <input type="range" min="0" max="10" step="1" value="${sliderValues[c.id]}" data-key="${c.id}" />
        <div class="val">${sliderValues[c.id]}</div>
      </div>
    `;
    const input = row.querySelector("input");
    const valDiv = row.querySelector(".val");
    input.addEventListener("input", () => {
      sliderValues[c.id] = Number(input.value);
      valDiv.textContent = input.value;
      updateTotal();
    });
    criteriaContainer.appendChild(row);
  });
  updateTotal();
}

function updateTotal() {
  let sum = 0;
  let weightTotal = 0;
  criteria.forEach((c) => {
    const w = c.weight ?? 1;
    sum += (sliderValues[c.id] ?? 0) * w;
    weightTotal += w;
  });
  const weighted = weightTotal > 0 ? sum / weightTotal : 0;
  totalVal.textContent = weighted.toFixed(1);
}

cancelScoreBtn.addEventListener("click", () => {
  scoreModal.classList.add("hidden");
});

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
    scoreModal.classList.add("hidden");
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
