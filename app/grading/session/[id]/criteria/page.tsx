"use client";

import { useEffect, useState } from "react";
import { getSession, updateCriteria, GradingSession, Criterion } from "@/lib/grading";
import { useRouter } from "next/navigation";

export default function CriteriaPage({ params }: { params: { id: string } }) {
  const [session, setSession] = useState<GradingSession | null>(null);
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  useEffect(() => {
    fetchSession();
  }, [params.id]);

  const fetchSession = async () => {
    setLoading(true);
    const data = await getSession(params.id);
    if (data) {
      setSession(data);
      setCriteria(data.criteria || []);
    }
    setLoading(false);
  };

  const addCriterion = () => {
    setCriteria([...criteria, { id: Date.now().toString(), name: "", weight: 0 }]);
  };

  const removeCriterion = (id: string) => {
    setCriteria(criteria.filter(c => c.id !== id));
  };

  const updateCriterion = (id: string, field: keyof Criterion, value: string | number) => {
    setCriteria(criteria.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  const totalWeight = criteria.reduce((sum, c) => sum + Number(c.weight), 0);

  const handleSave = async () => {
    if (totalWeight !== 100) {
      alert("Total weight must sum to 100%");
      return;
    }
    setSaving(true);
    await updateCriteria(params.id, criteria);
    setSaving(false);
    router.push("/grading");
  };

  if (loading) return <div className="text-center py-12">Loading...</div>;
  if (!session) return <div className="text-center py-12 text-red-500">Session not found.</div>;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Grading Criteria</h1>
        <p className="text-slate-500 text-sm">Define what students will be graded on and the weight of each criterion.</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
        {criteria.map((criterion, index) => (
          <div key={criterion.id} className="flex gap-4 items-end">
            <div className="flex-1">
              <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Criterion Name</label>
              <input
                type="text"
                value={criterion.name}
                onChange={e => updateCriterion(criterion.id, "name", e.target.value)}
                placeholder="e.g., Content Accuracy"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
              />
            </div>
            <div className="w-24">
              <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Weight (%)</label>
              <input
                type="number"
                value={criterion.weight}
                onChange={e => updateCriterion(criterion.id, "weight", Number(e.target.value))}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
              />
            </div>
            <button
              onClick={() => removeCriterion(criterion.id)}
              className="p-2 text-slate-400 hover:text-red-500 transition-colors"
            >
              ✕
            </button>
          </div>
        ))}

        <button
          onClick={addCriterion}
          className="w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-sm font-semibold text-slate-500 hover:border-blue-300 hover:text-blue-500 transition-all"
        >
          + Add Criterion
        </button>

        <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
          <div className={`text-sm font-bold ${totalWeight === 100 ? "text-emerald-600" : "text-red-500"}`}>
            Total Weight: {totalWeight}%
          </div>
          <button
            onClick={handleSave}
            disabled={saving || totalWeight !== 100}
            className="px-8 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-bold rounded-xl transition-colors"
          >
            {saving ? "Saving..." : "Save Criteria"}
          </button>
        </div>
      </div>
    </div>
  );
}
