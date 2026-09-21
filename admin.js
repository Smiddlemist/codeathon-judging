import {
  auth, db, ADMIN_EMAIL, CRITERIA,
  signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "./firebase-init.js";
import {
  collection, doc, addDoc, deleteDoc, setDoc, onSnapshot, query, orderBy,
  writeBatch, getDocs
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const loginScreen = document.getElementById("loginScreen");
const dashboard = document.getElementById("dashboard");
const emailInput = document.getElementById("emailInput");
const passInput = document.getElementById("passInput");
const loginBtn = document.getElementById("loginBtn");
const loginErr = document.getElementById("loginErr");
const logoutBtn = document.getElementById("logoutBtn");
const adminBadge = document.getElementById("adminBadge");

let teams = [];
let judges = [];
let scores = [];

// ---------- Auth ----------
loginBtn.addEventListener("click", async () => {
  loginErr.classList.add("hidden");
  loginBtn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, emailInput.value.trim(), passInput.value);
  } catch (e) {
    loginErr.textContent = "Sign-in failed. Check the email/password.";
    loginErr.classList.remove("hidden");
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user && user.email === ADMIN_EMAIL) {
    loginScreen.classList.add("hidden");
    dashboard.classList.remove("hidden");
    adminBadge.textContent = "👤 " + user.email;
    startListeners();
  } else if (user && user.email !== ADMIN_EMAIL) {
    loginErr.textContent = "This account is not authorized as admin.";
    loginErr.classList.remove("hidden");
    signOut(auth);
  } else {
    dashboard.classList.add("hidden");
    loginScreen.classList.remove("hidden");
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

// ---------- Live data ----------
function startListeners() {
  onSnapshot(query(collection(db, "teams"), orderBy("name")), (snap) => {
    teams = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTeamsTable();
    renderResetSelects();
    renderLeaderboard();
    renderMatrix();
  });
  onSnapshot(query(collection(db, "judges"), orderBy("name")), (snap) => {
    judges = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderJudgesTable();
    renderResetSelects();
    renderMatrix();
  });
  onSnapshot(collection(db, "scores"), (snap) => {
    scores = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderLeaderboard();
    renderMatrix();
    document.getElementById("statScores").textContent = scores.length;
  });
}

// ---------- Leaderboard ----------
function renderLeaderboard() {
  document.getElementById("statTeams").textContent = teams.length;
  document.getElementById("statJudges").textContent = judges.length;

  const rows = teams.map((team) => {
    const teamScores = scores.filter((s) => s.teamId === team.id);
    const n = teamScores.length;
    const avgTotal = n ? teamScores.reduce((a, s) => a + s.total, 0) / n : 0;
    const critAvgs = {};
    CRITERIA.forEach((c) => {
      critAvgs[c.key] = n ? teamScores.reduce((a, s) => a + (s.criteria[c.key] || 0), 0) / n : 0;
    });
    return { team, n, avgTotal, critAvgs };
  });

  rows.sort((a, b) => b.avgTotal - a.avgTotal);

  const tbody = document.querySelector("#leaderboardTable tbody");
  tbody.innerHTML = "";
  rows.forEach((r, i) => {
    const rankClass = i === 0 ? "rank-1" : i === 1 ? "rank-2" : i === 2 ? "rank-3" : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="${rankClass}">${i + 1}</td>
      <td>${escapeHtml(r.team.name)}</td>
      <td class="muted">${escapeHtml(r.team.lead || "—")}</td>
      <td>${r.n}</td>
      <td><strong>${r.avgTotal.toFixed(1)}</strong></td>
      ${CRITERIA.map((c) => `<td>${r.critAvgs[c.key].toFixed(1)}</td>`).join("")}
    `;
    tbody.appendChild(tr);
  });
}

// ---------- Judge coverage matrix ----------
function renderMatrix() {
  const thead = document.querySelector("#matrixTable thead");
  const tbody = document.querySelector("#matrixTable tbody");
  thead.innerHTML = "<tr><th>Judge</th>" + teams.map((t) => `<th>${escapeHtml(t.name)}</th>`).join("") + "</tr>";
  tbody.innerHTML = "";
  judges.forEach((j) => {
    const tr = document.createElement("tr");
    let cells = `<td>${escapeHtml(j.name)}</td>`;
    teams.forEach((t) => {
      const s = scores.find((sc) => sc.judgeId === j.id && sc.teamId === t.id);
      cells += `<td>${s ? "✅ " + s.total : '<span class="muted">—</span>'}</td>`;
    });
    tr.innerHTML = cells;
    tbody.appendChild(tr);
  });
}

// ---------- Teams CRUD ----------
document.getElementById("addTeamBtn").addEventListener("click", async () => {
  const nameEl = document.getElementById("newTeamName");
  const leadEl = document.getElementById("newTeamLead");
  const errEl = document.getElementById("teamErr");
  errEl.classList.add("hidden");
  const name = nameEl.value.trim();
  const lead = leadEl.value.trim();
  if (!name) {
    errEl.textContent = "Team name is required.";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    await addDoc(collection(db, "teams"), { name, lead, createdAt: Date.now() });
    nameEl.value = "";
    leadEl.value = "";
  } catch (e) {
    errEl.textContent = "Failed to add team.";
    errEl.classList.remove("hidden");
  }
});

function renderTeamsTable() {
  const tbody = document.querySelector("#teamsTable tbody");
  tbody.innerHTML = "";
  teams.forEach((t) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(t.name)}</td>
      <td class="muted">${escapeHtml(t.lead || "—")}</td>
      <td><button class="btn danger small">Remove</button></td>
    `;
    tr.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`Remove team "${t.name}"? This also deletes all of its scores.`)) return;
      await deleteDoc(doc(db, "teams", t.id));
      const related = scores.filter((s) => s.teamId === t.id);
      const batch = writeBatch(db);
      related.forEach((s) => batch.delete(doc(db, "scores", s.id)));
      if (related.length) await batch.commit();
    });
    tbody.appendChild(tr);
  });
}

// ---------- Judges CRUD ----------
document.getElementById("addJudgeBtn").addEventListener("click", async () => {
  const nameEl = document.getElementById("newJudgeName");
  const errEl = document.getElementById("judgeErr");
  errEl.classList.add("hidden");
  const name = nameEl.value.trim();
  if (!name) {
    errEl.textContent = "Judge name is required.";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    await addDoc(collection(db, "judges"), { name, active: true, createdAt: Date.now() });
    nameEl.value = "";
  } catch (e) {
    errEl.textContent = "Failed to add judge.";
    errEl.classList.remove("hidden");
  }
});

function renderJudgesTable() {
  const tbody = document.querySelector("#judgesTable tbody");
  tbody.innerHTML = "";
  judges.forEach((j) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(j.name)}</td>
      <td>${j.active === false ? '<span class="muted">Inactive</span>' : "Active"}</td>
      <td><button class="btn danger small">Remove</button></td>
    `;
    tr.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`Remove judge "${j.name}"? Their submitted scores will remain unless you reset them separately.`)) return;
      await deleteDoc(doc(db, "judges", j.id));
    });
    tbody.appendChild(tr);
  });
}

// ---------- Reset selects ----------
function renderResetSelects() {
  const judgeSel = document.getElementById("resetJudgeSelect");
  const teamSel = document.getElementById("resetTeamSelect");
  judgeSel.innerHTML = judges.map((j) => `<option value="${j.id}">${escapeHtml(j.name)}</option>`).join("");
  teamSel.innerHTML = teams.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
}

// ---------- Reset actions ----------
document.getElementById("resetAllBtn").addEventListener("click", async () => {
  if (!confirm("This deletes ALL scorecards from ALL judges for ALL teams. Continue?")) return;
  await deleteAllScores(scores);
  alert("All scores have been reset.");
});

document.getElementById("resetJudgeBtn").addEventListener("click", async () => {
  const judgeId = document.getElementById("resetJudgeSelect").value;
  const judge = judges.find((j) => j.id === judgeId);
  if (!judge) return;
  if (!confirm(`Delete all scores submitted by "${judge.name}"?`)) return;
  const toDelete = scores.filter((s) => s.judgeId === judgeId);
  await deleteAllScores(toDelete);
  alert(`Reset scores for judge "${judge.name}".`);
});

document.getElementById("resetTeamBtn").addEventListener("click", async () => {
  const teamId = document.getElementById("resetTeamSelect").value;
  const team = teams.find((t) => t.id === teamId);
  if (!team) return;
  if (!confirm(`Delete all scores for team "${team.name}" (from every judge)?`)) return;
  const toDelete = scores.filter((s) => s.teamId === teamId);
  await deleteAllScores(toDelete);
  alert(`Reset scores for team "${team.name}".`);
});

async function deleteAllScores(list) {
  // Firestore batches max out at 500 writes
  const chunkSize = 400;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const batch = writeBatch(db);
    chunk.forEach((s) => batch.delete(doc(db, "scores", s.id)));
    await batch.commit();
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
