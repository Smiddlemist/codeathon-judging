# Code-A-Thon Judging App

A simple website for judging a Code-A-Thon: judges score each team on 5
criteria (0–10 each), and an admin console shows live results, manages
teams/judges, and can reset scores.

- **Judge page** (`judge.html`) — a judge picks their name, sees all teams,
  and scores each one. Scores can be edited any time before the event ends.
- **Admin page** (`admin.html`) — password-protected. Shows a live
  leaderboard (average score per team), a judge-coverage matrix (who has
  scored whom), team management, judge management, and score resets.

No backend server is needed — it's a static site that talks directly to
Firebase (Firestore for data, Firebase Auth for login).

---

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and create a new project.
2. **Build → Firestore Database → Create database.** Start in **production
   mode** (we'll paste in our own rules below). Pick any region.
3. **Build → Authentication → Get started.**
   - Under **Sign-in method**, enable **Anonymous** (this is what lets
     judges use the app without creating individual accounts).
   - Also enable **Email/Password** (this is only used for the admin login).
   - Under **Users**, click **Add user** and create ONE user — this is the
     admin account. Remember the email + password you set.
4. **Project settings (gear icon) → General → Your apps → Add app → Web (`</>`).**
   Give it any nickname, you don't need Firebase Hosting. Copy the
   `firebaseConfig` object it shows you.

## 2. Plug in your config

Open `firebase-init.js` and:

- Paste your `firebaseConfig` values in place of the placeholders.
- Set `ADMIN_EMAIL` to the exact email of the admin user you created in
  step 1.3.

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};

export const ADMIN_EMAIL = "admin@example.com"; // <-- your admin login email
```

## 3. Set the Firestore security rules

In the Firebase console: **Firestore Database → Rules**, replace everything
with this (swap in your admin email in the one spot marked below — it must
match `ADMIN_EMAIL` in `firebase-init.js`):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isAdmin() {
      return request.auth != null && request.auth.token.email == "admin@example.com"; // <-- match ADMIN_EMAIL
    }
    function isSignedIn() {
      return request.auth != null;
    }

    match /teams/{teamId} {
      allow read: if isSignedIn();
      allow write: if isAdmin();
    }

    match /judges/{judgeId} {
      allow read: if isSignedIn();
      allow write: if isAdmin();
    }

    match /criteria/{criterionId} {
      allow read: if isSignedIn();
      allow write: if isAdmin();
    }

    match /scores/{scoreId} {
      allow read: if isSignedIn();
      // scoreId is always "<judgeId>_<teamId>" — this stops a client from
      // writing a score under someone else's judgeId.
      allow create, update: if isSignedIn() &&
        request.resource.data.judgeId == scoreId.split('_')[0];
      allow delete: if isAdmin();
    }
  }
}
```

Click **Publish**.

> **Security note:** Judges sign in anonymously and simply pick their name
> from a list — there's no individual judge password. This keeps things
> quick for a live event with a small, trusted group of judges, but it does
> mean any judge could technically pick someone else's name from the
> dropdown. If you need to guarantee only judge X can submit as judge X,
> the app would need per-judge passwords (a bit more setup) — happy to add
> that if you want stronger guarantees.

## 4. Test locally (optional but recommended)

Because the pages use JS modules (`type="module"`), opening `index.html`
directly by double-clicking it won't work in most browsers. Serve it
locally instead, e.g.:

```bash
cd codeathon-judging
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

## 5. Deploy to GitHub Pages

1. Create a new GitHub repository and push all these files to it (they can
   sit at the repo root, or in a `/docs` folder — your choice).
2. In the repo: **Settings → Pages.**
3. Under **Build and deployment → Source**, choose **Deploy from a branch.**
4. Pick your branch (e.g. `main`) and the folder (`/ (root)` or `/docs`).
5. Save. GitHub will give you a URL like
   `https://yourusername.github.io/your-repo-name/` within a minute or two.
6. In the Firebase console: **Authentication → Settings → Authorized
   domains → Add domain**, and add your `github.io` URL's domain
   (e.g. `yourusername.github.io`). Without this, sign-in will fail on the
   live site even though it works locally.

That's it — share the Judge link with your judges and the Admin link with
yourself.

## 6. Running the event

**Before judging starts (as admin):**
1. Go to the Admin Console → **Judges** tab → add each judge by name (10–15
   names).
2. Go to the **Teams** tab → add each team's name and team lead (10–20
   teams).

**During judging:**
- Send judges the link to `judge.html`. Each judge picks their name once
  (it's remembered in their browser after that) and scores each team as
  they present. Scores save instantly and can be edited any time.
- Watch the **Leaderboard** and **Judge Coverage** tabs on the Admin
  Console update live as scores come in — the coverage matrix is a quick
  way to see which judges still need to score which teams.

**If something needs correcting:**
- **Reset Scores** tab lets you wipe all scores, just one judge's scores, or
  just one team's scores.
- **Teams/Judges** tabs let you remove a team or judge (removing a team also
  deletes its scores).

## Scoring categories and weights

Scoring categories are no longer hardcoded — they live in Firestore and are
managed from the **Admin Console → ⚖️ Categories** tab. The first time an
admin logs in, five defaults are created automatically (Innovation &
Creativity, Technical Execution, Design & UX, Presentation & Communication,
Impact & Usefulness), each with a weight of 1.

From that tab you can:
- **Add** a new category with any name and weight.
- **Reorder** categories with the ↑/↓ buttons (this controls the order
  judges see them in).
- **Change a weight** at any time — the leaderboard recalculates
  immediately for every existing scorecard, since weighting is applied at
  display time, not baked into each score.
- **Remove** a category — existing scorecards keep whatever value a judge
  gave for it, but it stops counting toward anyone's weighted score once
  removed.

**How weighting works:** each category is still scored 0–10 by judges. A
team's weighted score is the weighted average across categories:
`(score₁ × weight₁ + score₂ × weight₂ + …) ÷ (weight₁ + weight₂ + …)`,
which always lands on a 0–10 scale no matter how many categories you have
or what weights you use. Weights are relative — `2` simply counts twice as
much as `1`; they don't need to sum to 100 or any other number.

Judges see each category's weight as a small badge next to its slider
(only shown when the weight isn't 1), so they understand which categories
matter more, even though they still just score 0–10 on each.

## Scorecard notes

Each scorecard now has three feedback fields instead of one general
comments box:
- **Strengths** — what the team did well
- **Areas to improve** — constructive feedback
- **Additional comments** — anything else

These are visible to admins via the leaderboard's **team detail view**
(click any row in the Leaderboard tab) — useful for compiling feedback to
send back to teams after the event.

## Exporting results

The Leaderboard tab has an **⬇️ Export CSV** button that downloads the
current standings (rank, team, lead, judge count, weighted score, and each
category's average) as a spreadsheet-ready file — handy for archiving
results or sharing with sponsors/organizers who don't need Admin Console
access.

## Ideas for later (not built yet)

A few things that would be reasonable next steps if you want them —
just ask and I can add any of these:

- **Lock scoring after a deadline.** A toggle in the admin console that
  closes the judge scorecard once judging time is up, so no more edits can
  sneak in while you're tallying results.
- **Per-judge PINs or logins.** Right now any judge can pick any name from
  the dropdown (see the security note in Stage 3 above). Real per-judge
  credentials would close that gap if it matters for your event.
- **Randomized team order per judge.** Currently every judge sees teams in
  the same (alphabetical) order, which can subtly bias later-viewed teams.
  Shuffling the order per judge (consistently, so it doesn't reshuffle
  every time they reload) would reduce that.
- **Highlight best/worst score per category** on the leaderboard, so
  standout categories are easy to spot at a glance.
- **Tie-breaker rules**, e.g. falling back to a specific category's average
  when two teams' weighted scores are equal.
- **A public results/leaderboard page** (read-only, no login) to project
  on a screen during the closing ceremony.

## File overview

```
index.html        Landing page (links to Judge / Admin)
judge.html/.js     Judge scorecard flow
admin.html/.js     Admin dashboard (leaderboard, teams, judges, resets)
firebase-init.js   Firebase config + shared constants (EDIT THIS FIRST)
style.css          Shared styling
```
