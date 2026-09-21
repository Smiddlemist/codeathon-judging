import {
  auth, db, signInAnonymously, onAuthStateChanged, CRITERIA
} from "./firebase-init.js";
import {
  collection, doc, getDocs, setDoc, onSnapshot, query, orderBy
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
const commentsBox = document.getElementById("commentsBox");
const totalVal = document.getElementById("totalVal");
const cancelScoreBtn = document.getElementById("cancelScoreBtn");
const submitScoreBtn = document.getElementById("submitScoreBtn");
const scoreErr = document.getElementById("scoreErr");

let judges = [];
let teams = [];
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
  }
});

function loadJudges() {
  const judgesRef = collection(db, "judges");
  onSnapshot(judgesRef, (snap) => {
    judges = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((j) => j.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name));
    renderJudgeSelect();
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
    selectJudge(savedId, true);
  }
}

function selectJudge(judgeId, skipUI) {
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
  const scoresRef = collection(db, "scores");
  onSnapshot(scoresRef, (snap) => {
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

    const card = document.createElement("div");
    card.className = "card team-card";
    card.innerHTML = `
      <div class="team-name">${escapeHtml(team.name)}</div>
      <div class="team-lead">Lead: ${escapeHtml(team.lead || "—")}</div>
      ${
        existing
          ? `<span class="score-badge">✅ Scored — ${existing.total}/50</span>`
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
  CRITERIA.forEach((c) => {
    sliderValues[c.key] = existing ? existing.criteria[c.key] : 5;
  });

  modalTeamName.textContent = team.name;
  modalTeamLead.textContent = "Lead: " + (team.lead || "—");
  commentsBox.value = existing ? existing.comments || "" : "";
  scoreErr.classList.add("hidden");
  renderCriteria();
  scoreModal.classList.remove("hidden");
}

function renderCriteria() {
  criteriaContainer.innerHTML = "";
  CRITERIA.forEach((c) => {
    const row = document.createElement("div");
    row.innerHTML = `
      <label>${c.label}</label>
      <div class="slider-row">
        <input type="range" min="0" max="10" step="1" value="${sliderValues[c.key]}" data-key="${c.key}" />
        <div class="val">${sliderValues[c.key]}</div>
      </div>
    `;
    const input = row.querySelector("input");
    const valDiv = row.querySelector(".val");
    input.addEventListener("input", () => {
      sliderValues[c.key] = Number(input.value);
      valDiv.textContent = input.value;
      updateTotal();
    });
    criteriaContainer.appendChild(row);
  });
  updateTotal();
}

function updateTotal() {
  const total = Object.values(sliderValues).reduce((a, b) => a + b, 0);
  totalVal.textContent = total;
}

cancelScoreBtn.addEventListener("click", () => {
  scoreModal.classList.add("hidden");
});

submitScoreBtn.addEventListener("click", async () => {
  if (!currentJudge || !currentTeam) return;
  submitScoreBtn.disabled = true;
  scoreErr.classList.add("hidden");
  try {
    const total = Object.values(sliderValues).reduce((a, b) => a + b, 0);
    const scoreId = `${currentJudge.id}_${currentTeam.id}`;
    await setDoc(doc(db, "scores", scoreId), {
      judgeId: currentJudge.id,
      judgeName: currentJudge.name,
      teamId: currentTeam.id,
      teamName: currentTeam.name,
      criteria: { ...sliderValues },
      total,
      comments: commentsBox.value.trim(),
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
