"use client";

import { useEffect, useState } from "react";
import { getSessions, createSession, GradingSession } from "@/lib/grading";
import { initFirebase } from "@/lib/firebase";
import Link from "next/link";

export default function GradingDashboard() {
  const [sessions, setSessions] = useState<GradingSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [newSessionName, setNewSessionName] = useState("");
  const [creating, setCreating] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    initFirebase().then(firebase => {
      if (firebase?.user) {
        setUserId(firebase.user.uid);
      }
    });
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    setLoading(true);
    const data = await getSessions();
    setSessions(data);
    setLoading(false);
  };

  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSessionName.trim() || !userId) return;

    setCreating(true);
    const id = await createSession(newSessionName.trim(), userId);
    if (id) {
      setNewSessionName("");
      fetchSessions();
    }
    setCreating(false);
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Grading Sessions</h1>
          <p className="text-slate-500 text-sm">Manage your individual presentation grading sessions.</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <h2 className="text-lg font-semibold text-slate-800 mb-4">Create New Session</h2>
        <form onSubmit={handleCreateSession} className="flex gap-3">
          <input
            type="text"
            value={newSessionName}
            onChange={e => setNewSessionName(e.target.value)}
            placeholder="Session Name (e.g., Final Presentation 2024)"
            className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
            required
          />
          <button
            type="submit"
            disabled={creating || !newSessionName.trim()}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-bold rounded-xl transition-colors"
          >
            {creating ? "Creating..." : "Create Session"}
          </button>
        </form>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-2xl border border-slate-200 border-dashed">
          <p className="text-slate-400">No grading sessions found. Create one to get started.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map(session => (
            <div key={session.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden hover:border-blue-300 transition-colors">
              <div className="p-6">
                <h3 className="font-bold text-slate-800 mb-2 truncate">{session.name}</h3>
                <p className="text-xs text-slate-400 mb-4">
                  {session.criteria?.length || 0} criteria defined
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/grading/session/${session.id}/criteria`}
                    className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-bold rounded-lg transition-colors"
                  >
                    Criteria
                  </Link>
                  <Link
                    href={`/grading/session/${session.id}/students`}
                    className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-bold rounded-lg transition-colors"
                  >
                    Students
                  </Link>
                  <Link
                    href={`/grading/session/${session.id}/results`}
                    className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-600 text-[10px] font-bold rounded-lg transition-colors"
                  >
                    Results
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
