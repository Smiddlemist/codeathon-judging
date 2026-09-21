// firebase-init.js
// -----------------------------------------------------------------------
// 1. Go to https://console.firebase.google.com -> create a project
// 2. Project Settings -> General -> "Your apps" -> Add app -> Web (</>)
// 3. Copy the config object it gives you and paste the values below
// 4. Enable Authentication -> Sign-in method -> turn ON "Anonymous"
// 5. Enable Authentication -> Sign-in method -> turn ON "Email/Password"
// 6. Authentication -> Users -> Add user -> use the SAME email you put
//    in ADMIN_EMAIL below, pick any password (this is the admin login)
// 7. Firestore Database -> Create database -> start in production mode
// 8. Firestore -> Rules -> paste the rules from README.md
// -----------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBzeJSdAqHr_VSjqdPdbTy-hszKrIAUpSQ",
  authDomain: "codeathon-judging.firebaseapp.com",
  projectId: "codeathon-judging",
  storageBucket: "codeathon-judging.firebasestorage.app",
  messagingSenderId: "842941749247",
  appId: "1:842941749247:web:457b7245930c068041f9ca"
};

// This must be the exact email of the Firebase Auth user you create for
// the admin (step 6 above). It's also referenced in the Firestore rules.
export const ADMIN_EMAIL = "smiddlemist@sundt.com";

// Scoring categories now live in Firestore (the "criteria" collection) and
// are managed from the Admin Console's "Categories" tab -- add, remove,
// rename, and set a weight for each. This list is ONLY used once, the very
// first time the app runs, to seed sensible defaults into Firestore if the
// "criteria" collection is empty. After that it's ignored -- edit categories
// from the Admin Console instead.
export const DEFAULT_CRITERIA = [
  { label: "Innovation & Creativity", weight: 1 },
  { label: "Technical Execution", weight: 1 },
  { label: "Design & UX", weight: 1 },
  { label: "Presentation & Communication", weight: 1 },
  { label: "Impact & Usefulness", weight: 1 }
];

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  signInAnonymously,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
};
