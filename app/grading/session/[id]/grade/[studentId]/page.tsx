"use client";

import { useEffect, useState } from "react";
import { getSession, getStudents, submitGrade, GradingSession, Student } from "@/lib/grading";
import { initFirebase } from "@/lib/firebase";
import { useRouter } from "next/navigation";

export default function GradeStudentPage({ params }: { params: { id: string, studentId: string } }) {
  const [session, setSession] = useState<GradingSession | null>(null);
  const [student, setStudent] = useState<Student | null>(null);
  const [scores, setScores] = useState<{ [criterionId: string]: number }>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [teacher, setTeacher] = useState<{ id: string, name: string } | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetchData();
  }, [params.id, params.studentId]);

  const fetchData = async () => {
    setLoading(true);
    const firebase = await initFirebase();
    if (firebase?.user) {
      setTeacher({ id: firebase.user.uid, name: firebase.user.displayName || firebase.user.email || "Unknown Teacher" });
    }

    const s = await getSession(params.id);
    if (s) {
      setSession(s);
      const st = await getStudents(params.id);
      const target = st.find(std => std.id === params.studentId);
      if (target) setStudent(target);

      const initialScores: { [id: string]: number } = {};
      s.criteria.forEach(c => initialScores[c.id] = 0);
      setScores(initialScores);
    }
    setLoading(false);
  };

  const handleScoreChange = (id: string, value: number) => {
    setScores({ ...scores, [id]: Math.min(100, Math.max(0, value)) });
  };

  const handleSubmit = async () => {
    if (!teacher || !session) return;
    setSubmitting(true);
    await submitGrade(params.id, params.studentId, teacher.id, teacher.name, scores, session.criteria);
    setSubmitting(false);
    router.push(`/grading/session/${params.id}/results`);
  };

  if (loading) return <div className="text-center py-12">Loading...</div>;
  if (!session || !student) return <div className="text-center py-12 text-red-500">Not found.</div>;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Grade Student</h1>
        <p className="text-slate-500 text-sm">Grading <span className="font-bold text-slate-700">{student.name}</span> for <span className="font-bold text-slate-700">{session.name}</span>.</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-6">
        {session.criteria.map((criterion) => (
          <div key={criterion.id} className="space-y-2">
            <div className="flex justify-between items-center">
              <label className="block text-sm font-bold text-slate-700">{criterion.name} ({criterion.weight}%)</label>
              <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-lg">Score: {scores[criterion.id] || 0} / 100</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={scores[criterion.id] || 0}
              onChange={e => handleScoreChange(criterion.id, Number(e.target.value))}
              className="w-full h-2 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <div className="flex justify-between text-[10px] text-slate-400 font-bold uppercase">
              <span>Poor</span>
              <span>Average</span>
              <span>Excellent</span>
            </div>
          </div>
        ))}

        <div className="pt-6 border-t border-slate-100">
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-bold rounded-xl transition-colors shadow-lg shadow-blue-200"
          >
            {submitting ? "Submitting..." : "Submit Grades"}
          </button>
        </div>
      </div>
    </div>
  );
}
