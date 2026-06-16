"use client";

import { useEffect, useState } from "react";
import { initFirebase } from "@/lib/firebase";
import { User, onAuthStateChanged, getAuth, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import Link from "next/link";

export default function GradingLayout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    initFirebase().then((firebase) => {
      if (!firebase) {
        setLoading(false);
        return;
      }
      const unsub = onAuthStateChanged(firebase.auth, (u) => {
        setUser(u);
        setLoading(false);
      });
      return unsub;
    });
  }, []);

  const handleGoogleSignIn = async () => {
    const firebase = await initFirebase();
    if (!firebase) return;
    const provider = new GoogleAuthProvider();
    await signInWithPopup(firebase.auth, provider);
  };

  const handleSignOut = async () => {
    const firebase = await initFirebase();
    if (!firebase) return;
    await signOut(firebase.auth);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-slate-200 p-8 text-center">
          <h1 className="text-2xl font-bold text-slate-800 mb-6">Teacher Grading System</h1>
          <p className="text-slate-600 mb-8">Please sign in to access the grading platform.</p>
          <button
            onClick={handleGoogleSignIn}
            className="w-full flex items-center justify-center gap-3 px-6 py-3 bg-white border border-slate-300 rounded-xl hover:bg-slate-50 transition-colors shadow-sm text-slate-700 font-semibold"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/grading" className="flex items-center gap-2">
            <span className="font-bold text-xl text-slate-800">Grading System</span>
          </Link>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100">
              {user.photoURL && <img src={user.photoURL} className="w-5 h-5 rounded-full" alt="" />}
              <span className="text-xs font-semibold text-slate-700">{user.displayName || user.email}</span>
            </div>
            <button onClick={handleSignOut} className="text-xs font-semibold text-slate-500 hover:text-red-500 transition-colors">
              Sign Out
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {children}
      </main>
    </div>
  );
}
