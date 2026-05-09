"use client";

import { useEffect, useState } from "react";
import { getSession, addStudent, getStudents, GradingSession, Student } from "@/lib/grading";

export default function StudentsPage({ params }: { params: { id: string } }) {
  const [session, setSession] = useState<GradingSession | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetchData();
  }, [params.id]);

  const fetchData = async () => {
    setLoading(true);
    const s = await getSession(params.id);
    if (s) {
      setSession(s);
      const st = await getStudents(params.id);
      setStudents(st);
    }
    setLoading(false);
  };

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    setAdding(true);
    await addStudent(params.id, newName.trim());
    setNewName("");
    const st = await getStudents(params.id);
    setStudents(st);
    setAdding(false);
  };

  if (loading) return <div className="text-center py-12">Loading...</div>;
  if (!session) return <div className="text-center py-12 text-red-500">Session not found.</div>;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Student Roster</h1>
        <p className="text-slate-500 text-sm">Add students who will be presenting in this session.</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <h2 className="text-lg font-semibold text-slate-800 mb-4">Add Student</h2>
        <form onSubmit={handleAddStudent} className="flex gap-3">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Student Full Name"
            className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
            required
          />
          <button
            type="submit"
            disabled={adding || !newName.trim()}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-bold rounded-xl transition-colors"
          >
            {adding ? "Adding..." : "Add Student"}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-bold text-slate-700">Enrolled Students ({students.length})</h2>
        </div>
        <div className="divide-y divide-slate-50">
          {students.length === 0 ? (
            <div className="p-12 text-center text-slate-400 text-sm">No students added yet.</div>
          ) : (
            students.map(student => (
              <div key={student.id} className="px-6 py-4 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">{student.name}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
