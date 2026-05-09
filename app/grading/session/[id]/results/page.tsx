"use client";

import { useEffect, useState } from "react";
import { getSession, getStudents, getGradingResults, GradingSession, Student } from "@/lib/grading";
import Link from "next/link";

export default function SessionResultsPage({ params }: { params: { id: string } }) {
  const [session, setSession] = useState<GradingSession | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [results, setResults] = useState<{ [studentId: string]: { avgScore: number, teacherCount: number } }>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, [params.id]);

  const fetchData = async () => {
    setLoading(true);
    const s = await getSession(params.id);
    if (s) {
      setSession(s);
      const [st, res] = await Promise.all([
        getStudents(params.id),
        getGradingResults(params.id)
      ]);
      setStudents(st);
      setResults(res);
    }
    setLoading(false);
  };

  if (loading) return <div className="text-center py-12">Loading...</div>;
  if (!session) return <div className="text-center py-12 text-red-500">Session not found.</div>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Session Results: {session.name}</h1>
        <p className="text-slate-500 text-sm">Average grades computed from all participating teachers.</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              <th className="text-left px-6 py-4">Student Name</th>
              <th className="text-center px-6 py-4">Teachers Graded</th>
              <th className="text-center px-6 py-4">Average Score</th>
              <th className="text-right px-6 py-4">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {students.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-6 py-12 text-center text-slate-400">No students enrolled in this session.</td>
              </tr>
            ) : (
              students.map(student => {
                const res = results[student.id];
                return (
                  <tr key={student.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4 font-semibold text-slate-700">{student.name}</td>
                    <td className="px-6 py-4 text-center">
                      <span className="px-2 py-1 rounded-lg bg-slate-100 text-slate-600 font-bold text-xs">
                        {res?.teacherCount || 0}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className={`text-lg font-black ${res ? "text-blue-600" : "text-slate-300"}`}>
                        {res ? res.avgScore.toFixed(1) : "—"}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link
                        href={`/grading/session/${params.id}/grade/${student.id}`}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 hover:bg-slate-700 text-white text-xs font-bold rounded-xl transition-colors"
                      >
                        Grade Student
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between items-center bg-blue-50 border border-blue-100 rounded-2xl p-6">
        <div>
          <h3 className="text-blue-800 font-bold">Multi-Teacher Average</h3>
          <p className="text-blue-600 text-xs">Grades are automatically averaged as teachers submit their scores.</p>
        </div>
        <Link
          href="/grading"
          className="px-6 py-2.5 bg-white border border-blue-200 text-blue-600 text-sm font-bold rounded-xl hover:bg-blue-100 transition-colors"
        >
          Back to Sessions
        </Link>
      </div>
    </div>
  );
}
