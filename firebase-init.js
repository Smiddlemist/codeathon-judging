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
// rename, reweight, or redescribe any category at any time. This list is
// only used to seed Firestore: automatically the very first time the app
// runs (if the "criteria" collection is empty), or manually later if the
// admin clicks "Load recommended defaults" on the Categories tab.
export const DEFAULT_CRITERIA = [
  {
    label: "Business Need Alignment",
    weight: 10,
    description: "Does the application clearly address the stated business problem?"
  },
  {
    label: "User Value and Impact",
    weight: 10,
    description: "How useful, meaningful, or beneficial would this be to its intended users?"
  },
  {
    label: "Functionality",
    weight: 5,
    description: "Does the core application work as demonstrated?"
  },
  {
    label: "Innovation and Creativity",
    weight: 5,
    description: "Is the approach original, clever, or meaningfully different?"
  },
  {
    label: "User Experience and Design",
    weight: 5,
    description: "Is it intuitive, accessible, and pleasant to use?"
  },
  {
    label: "Technical Execution",
    weight: 5,
    description: "How well-built, reliable, and thoughtfully engineered is it?"
  },
  {
    label: "Feasibility and Scalability",
    weight: 5,
    description: "Could the idea realistically be developed or deployed further?"
  },
  {
    label: "Completeness and Polish",
    weight: 5,
    description: "Does the solution feel cohesive and ready for the next step?"
  },
  {
    label: "Demo Quality and Storytelling",
    weight: 5,
    description: "Is the presentation clear, engaging, and focused on the solution's value?"
  },
  {
    label: "Team Execution and Collaboration",
    weight: 5,
    description: "Did the team make effective use of the limited time and work cohesively?"
  }
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
