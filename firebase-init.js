// firebase-init.js
// -----------------------------------------------------------------------
// 1. Go to https://console.firebase.google.com -> create a project
// 2. Project Settings -> General -> "Your apps" -> Add app -> Web (</>)
// 3. Copy the config object it gives you and paste the values below
// 4. Authentication -> Sign-in method -> turn ON "Email/Password"
//    (this is used for BOTH the admin login and every judge's login)
// 5. Authentication -> Templates -> check the "Password reset" email
//    template looks right (Firebase's default is fine as-is)
// 6. Authentication -> Users -> Add user -> use the SAME email you put
//    in ADMIN_EMAIL below, pick any password (this is the admin login)
// 7. Firestore Database -> Create database -> start in production mode
// 8. Firestore -> Rules -> paste the rules from README.md
// -----------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

// Exported (not just used locally) because the admin page needs it again to
// spin up a second, throwaway Firebase app instance when creating judge
// accounts -- that's how it can create a new login for a judge without
// accidentally signing itself out. See the "secondary app" note in admin.js.
export const firebaseConfig = {
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

// Scoring categories live entirely in Firestore (the "criteria" collection).
// There are no defaults in code: an admin loads them from an Excel file (or
// adds them one by one) on the Admin Console's "Categories" tab. A brand-new
// project starts with no categories until that's done.

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut
};
