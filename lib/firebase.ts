import { initializeApp, getApps, FirebaseApp } from "firebase/app";
import { getFirestore, Firestore } from "firebase/firestore";
import { getAuth, Auth, User, onAuthStateChanged, signInAnonymously } from "firebase/auth";

const FIREBASE_CONFIG = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY            ?? "",
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN        ?? "",
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID         ?? "",
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET     ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID             ?? "",
};

let app: FirebaseApp;
let db: Firestore;
let auth: Auth;

let _firebaseReady = false;
let _firebaseError = "";
let _currentUser: User | null = null;

export async function initFirebase(): Promise<{ db: Firestore; auth: Auth; user: User | null } | null> {
  if (typeof window === "undefined") return null;

  if (_firebaseReady) return { db, auth, user: _currentUser };

  if (!FIREBASE_CONFIG.apiKey) {
    _firebaseError = "Firebase config missing. Set NEXT_PUBLIC_FIREBASE_* env vars.";
    console.warn(_firebaseError);
    return null;
  }

  try {
    app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
    db = getFirestore(app);
    auth = getAuth(app);

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn("Firebase onAuthStateChanged timed out");
        resolve();
      }, 5000);

      const unsubscribe = onAuthStateChanged(auth, async (user) => {
        clearTimeout(timeout);
        if (user) {
          _currentUser = user;
          resolve();
        } else {
          try {
            const cred = await signInAnonymously(auth);
            _currentUser = cred.user;
            resolve();
          } catch (e) {
            console.error("Sign in anonymously failed", e);
            resolve();
          }
        }
        unsubscribe();
      });
    });

    _firebaseReady = true;
    return { db, auth, user: _currentUser };
  } catch (e: any) {
    _firebaseError = `Firebase init failed: ${e.message}`;
    console.error(_firebaseError);
    return null;
  }
}

export { db, auth, _currentUser as currentUser };
