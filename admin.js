import {
  auth, db, ADMIN_EMAIL, DEFAULT_CRITERIA,
  signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "./firebase-init.js";
import {
  collection, doc, addDoc, deleteDoc, updateDoc, onSnapshot, query, orderBy,
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
let criteria = []; // [{id, label, weight, order}]
let criteriaSeeded = false;

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
  onSnapshot(collection(db, "criteria"), async (snap) => {
    criteria = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (criteria.length === 0 && !criteriaSeeded) {
      criteriaSeeded = true;
      await seedDefaultCriteria();
    }
    renderCritTable();
    renderLeaderboard();
    renderMatrix();
  });
}

async function seedDefaultCriteria() {
  const existing = await getDocs(collection(db, "criteria"));
  if (!existing.empty) return; // guard against a race
  for (let i = 0; i < DEFAULT_CRITERIA.length; i++) {
    await addDoc(collection(db, "criteria"), { ...DEFAULT_CRITERIA[i], order: i, createdAt: Date.now() });
  }
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

// ---------- Leaderboard ----------
let lastLeaderboardRows = [];

function renderLeaderboard() {
  document.getElementById("statTeams").textContent = teams.length;
  document.getElementById("statJudges").textContent = judges.length;

  const headRow = document.getElementById("leaderboardHeadRow");
  headRow.innerHTML =
    "<th>#</th><th>Team</th><th>Lead</th><th># Judges</th><th>Weighted Score</th>" +
    criteria.map((c) => `<th title="${escapeHtml(c.description || "")}">${escapeHtml(c.label)}</th>`).join("");

  const rows = teams.map((team) => {
    const teamScores = scores.filter((s) => s.teamId === team.id);
    const n = teamScores.length;
    const weightedAvg = n
      ? teamScores.reduce((a, s) => a + weightedScoreOf(s), 0) / n
      : 0;
    const critAvgs = {};
    criteria.forEach((c) => {
      const vals = teamScores
        .map((s) => s.criteria && s.criteria[c.id])
        .filter((v) => typeof v === "number");
      critAvgs[c.id] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    });
    return { team, n, weightedAvg, critAvgs };
  });

  rows.sort((a, b) => b.weightedAvg - a.weightedAvg);
  lastLeaderboardRows = rows;

  const tbody = document.querySelector("#leaderboardTable tbody");
  tbody.innerHTML = "";
  rows.forEach((r, i) => {
    const rankClass = i === 0 ? "rank-1" : i === 1 ? "rank-2" : i === 2 ? "rank-3" : "";
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.innerHTML = `
      <td class="${rankClass}">${i + 1}</td>
      <td>${escapeHtml(r.team.name)}</td>
      <td class="muted">${escapeHtml(r.team.lead || "—")}</td>
      <td>${r.n}</td>
      <td><strong>${r.weightedAvg.toFixed(1)}</strong></td>
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
  detailTeamLead.textContent = "Lead: " + (team.lead || "—");
  const teamScores = scores.filter((s) => s.teamId === team.id);

  if (teamScores.length === 0) {
    detailContent.innerHTML = `<p class="muted">No judge has scored this team yet.</p>`;
  } else {
    detailContent.innerHTML = teamScores
      .map((s) => {
        const weighted = weightedScoreOf(s).toFixed(1);
        const critLines = criteria
          .map((c) => {
            const val = s.criteria ? s.criteria[c.id] : undefined;
            return typeof val === "number"
              ? `<span class="pill" title="${escapeHtml(c.description || "")}" style="margin:2px;">${escapeHtml(c.label)}: ${val}</span>`
              : "";
          })
          .join("");
        return `
          <div class="card" style="margin-bottom:10px;">
            <div class="row between">
              <strong>${escapeHtml(s.judgeName || "Unknown judge")}</strong>
              <span class="score-badge">${weighted} / 10</span>
            </div>
            <div style="margin:8px 0;">${critLines}</div>
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
  const headers = ["Rank", "Team", "Lead", "# Judges", "Weighted Score", ...criteria.map((c) => c.label)];
  const lines = [headers.map(csvCell).join(",")];
  lastLeaderboardRows.forEach((r, i) => {
    const row = [
      i + 1,
      r.team.name,
      r.team.lead || "",
      r.n,
      r.weightedAvg.toFixed(2),
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
      cells += `<td>${s ? "✅ " + weightedScoreOf(s).toFixed(1) : '<span class="muted">—</span>'}</td>`;
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
      if (related.length) {
        const batch = writeBatch(db);
        related.forEach((s) => batch.delete(doc(db, "scores", s.id)));
        await batch.commit();
      }
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

// ---------- Categories CRUD ----------
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
  try {
    const nextOrder = criteria.length ? Math.max(...criteria.map((c) => c.order ?? 0)) + 1 : 0;
    await addDoc(collection(db, "criteria"), { label, weight, description, order: nextOrder, createdAt: Date.now() });
    labelEl.value = "";
    weightEl.value = "1";
    descEl.value = "";
  } catch (e) {
    errEl.textContent = "Failed to add category.";
    errEl.classList.remove("hidden");
  }
});

document.getElementById("loadDefaultsBtn").addEventListener("click", async () => {
  const msg = criteria.length
    ? "This replaces ALL current categories with the 10 recommended defaults (Business Need Alignment, User Value and Impact, Functionality, and so on). Scorecards already submitted keep their recorded values, but existing categories will stop counting once replaced. Continue?"
    : "Load the 10 recommended default categories?";
  if (!confirm(msg)) return;
  if (criteria.length) {
    const batch = writeBatch(db);
    criteria.forEach((c) => batch.delete(doc(db, "criteria", c.id)));
    await batch.commit();
  }
  for (let i = 0; i < DEFAULT_CRITERIA.length; i++) {
    await addDoc(collection(db, "criteria"), { ...DEFAULT_CRITERIA[i], order: i, createdAt: Date.now() });
  }
});

function renderCritTable() {
  const container = document.getElementById("critList");
  container.innerHTML = "";
  if (criteria.length === 0) {
    container.innerHTML = `<p class="muted">No categories yet. Add one above, or click "Load recommended defaults."</p>`;
    return;
  }
  criteria.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "card";
    row.style.marginBottom = "10px";
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
      await updateDoc(doc(db, "criteria", c.id), { label: newLabel, weight: newWeight, description: newDesc });
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
  const chunkSize = 400; // Firestore batches max out at 500 writes
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
