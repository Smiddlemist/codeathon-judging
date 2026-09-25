import {
  auth, db, ADMIN_EMAIL, DEFAULT_CRITERIA, firebaseConfig,
  signInWithEmailAndPassword, sendPasswordResetEmail, onAuthStateChanged, signOut
} from "./firebase-init.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signOut as secondarySignOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  collection, doc, addDoc, setDoc, deleteDoc, updateDoc, deleteField, onSnapshot, query, orderBy,
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
let teamPenaltyValue = 0; // flat points deducted from a team's overall weighted score when penalized

const NOMINATION_LABELS = {
  recommend: "Recommend for further development",
  mostCreative: "Most creative / innovative",
  highestImpact: "Highest business impact",
  bestDemo: "Best demo / presentation",
  fanFavorite: "Fan favorite"
};

// ---------- Auth ----------
loginBtn.addEventListener("click", async () => {
  loginErr.classList.add("hidden");
  loginBtn.disabled = true;
  try {
    const cred = await signInWithEmailAndPassword(auth, emailInput.value.trim(), passInput.value);
    if (cred.user.email !== ADMIN_EMAIL) {
      // Only reject here, as a direct result of THIS sign-in attempt -- not from
      // onAuthStateChanged below, which also fires for auth changes happening in
      // other tabs (e.g. a judge signing in to judge.html shares this same
      // browser's auth session). Signing out there would kill that other,
      // perfectly legitimate session too.
      await signOut(auth);
      loginErr.textContent = "This account is not authorized as admin.";
      loginErr.classList.remove("hidden");
    }
  } catch (e) {
    loginErr.textContent = "Sign-in failed. Check the email/password.";
    loginErr.classList.remove("hidden");
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", () => signOut(auth));

document.getElementById("backToScorecardBtn").addEventListener("click", () => {
  window.location.href = "judge.html";
});

onAuthStateChanged(auth, (user) => {
  if (user && user.email === ADMIN_EMAIL) {
    loginScreen.classList.add("hidden");
    dashboard.classList.remove("hidden");
    adminBadge.textContent = "👤 " + user.email;
    startListeners();
  } else {
    // Either signed out, or signed in as some other account elsewhere in this
    // browser (e.g. a judge's session in another tab, sharing the same Firebase
    // Auth session). Either way, just show the admin login screen here --
    // don't sign anything out from a passive listener, since that would also
    // kill that other, legitimate session.
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
    renderNominationsTable();
    renderPenaltiesTable();
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
    renderNominationsTable();
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
  onSnapshot(doc(db, "config", "settings"), (snap) => {
    teamPenaltyValue = snap.exists() && typeof snap.data().teamPenaltyValue === "number"
      ? snap.data().teamPenaltyValue
      : 0;
    const input = document.getElementById("penaltyValueInput");
    if (input && document.activeElement !== input) input.value = teamPenaltyValue;
    renderLeaderboard();
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
      <td><strong>${r.weightedAvg.toFixed(1)}</strong>${r.penalty ? ` <span class="pill" title="Raw score ${r.rawAvg.toFixed(1)} minus ${r.penalty}-pt penalty${r.team.penaltyReason ? ": " + escapeHtml(r.team.penaltyReason) : ""}" style="background:#c0392b;color:#fff;">-${r.penalty}</span>` : ""}</td>
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
    detailTeamLead.innerHTML += `<div style="margin-top:6px;"><span class="pill" style="background:#c0392b;color:#fff;">Penalty applied: -${team.penalty}</span>${team.penaltyReason ? ` <span class="muted">${escapeHtml(team.penaltyReason)}</span>` : ""}</div>`;
  }
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

// ---------- Nomination totals ----------
function renderNominationsTable() {
  const table = document.getElementById("nominationsTable");
  if (!table) return; // tab not in the DOM yet on first paint
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  const nomKeys = Object.keys(NOMINATION_LABELS);

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
