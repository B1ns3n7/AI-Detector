"use client";

import { useState, useCallback } from "react";
import Link from "next/link";

type ToneOption = "academic" | "professional" | "neutral" | "conversational";
type IntensityOption = "subtle" | "moderate" | "aggressive";

interface HumanizerResult {
  original: string;
  humanized: string;
  changes: ChangeNote[];
  wordCountOriginal: number;
  wordCountHumanized: number;
}

interface ChangeNote {
  type: "burstiness" | "vocabulary" | "perplexity" | "restructure" | "tone" | "transition";
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HUMANIZE AI PRO CORE ENGINE: RESTRUCTURING & RHYTHM
// ─────────────────────────────────────────────────────────────────────────────

function humanizeEngine(text: string, tone: ToneOption, intensity: IntensityOption): HumanizerResult {
  const changeNotes: ChangeNote[] = [];
  const sentenceRegex = /[^.!?]+[.!?]+\s*/g;
  let sentences = text.match(sentenceRegex) || [text];
  let processedSentences: string[] = [];

  const humanQualifiers = ["to be honest,", "in many ways,", "effectively,", "as it happens,", "for the most part,"];
  const transitions = ["Actually,", "Surprisingly enough,", "That being said,", "Essentially,"];

  for (let i = 0; i < sentences.length; i++) {
    let s = sentences[i].trim();
    let words = s.split(/\s+/);

    // 1. BURSTINESS: Breaking "Metronomic" AI Rhythms
    if (i > 0 && intensity !== "subtle") {
      const prevLen = processedSentences[i - 1]?.split(/\s+/).length || 0;
      if (Math.abs(prevLen - words.length) < 4 && words.length > 12) {
        const splitIdx = Math.floor(words.length / 2);
        s = words.slice(0, splitIdx).join(" ") + ". " + words.slice(splitIdx).join(" ");
        changeNotes.push({ type: "burstiness", description: "Broke uniform sentence length to create natural rhythm variation." });
      }
    }

    // 2. PERPLEXITY: Injecting Low-Probability Qualifiers
    if (words.length > 10 && Math.random() > 0.5) {
      const qual = humanQualifiers[Math.floor(Math.random() * humanQualifiers.length)];
      s = s.replace(/ (is|are|was|were|can|will|often|starts|works) /i, ` ${qual} $1 `);
      changeNotes.push({ type: "perplexity", description: "Injected non-linear qualifiers to spike perplexity scores." });
    }

    // 3. RESTRUCTURING: Syntax Flip
    if (intensity === "aggressive" && i % 3 === 0) {
      const trans = transitions[Math.floor(Math.random() * transitions.length)];
      s = trans + " " + s.charAt(0).toLowerCase() + s.slice(1);
      changeNotes.push({ type: "restructure", description: "Front-loaded a subordinate clause to shift the syntactic fingerprint." });
    }

    // 4. TONE: Stylistic Conditioning
    if (tone === "conversational") {
      s = s.replace(/\bdo not\b/gi, "don't").replace(/\bdoes not\b/gi, "doesn't").replace(/\bit is\b/gi, "it's");
    }

    processedSentences.push(s);
  }

  const finalOutput = processedSentences.join(" ");
  return {
    original: text,
    humanized: finalOutput,
    changes: changeNotes,
    wordCountOriginal: text.split(/\s+/).length,
    wordCountHumanized: finalOutput.split(/\s+/).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 text-center shadow-sm">
      <div className="text-lg font-bold text-slate-900">{value}</div>
      <div className="text-xs font-medium text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

export default function HumanizerPage() {
  const [inputText, setInputText] = useState("");
  const [tone, setTone] = useState<ToneOption>("neutral");
  const [intensity, setIntensity] = useState<IntensityOption>("aggressive");
  const [result, setResult] = useState<HumanizerResult | null>(null);
  const [error, setError] = useState("");

  const handleHumanize = useCallback(() => {
    if (inputText.trim().split(/\s+/).length < 15) {
      setError("Please enter at least 15 words.");
      return;
    }
    setError("");
    const res = humanizeEngine(inputText.trim(), tone, intensity);
    setResult(res);
  }, [inputText, tone, intensity]);

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 p-4 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center text-white font-bold">H</div>
            <h1 className="text-xl font-bold text-slate-900">Humanize AI Pro</h1>
          </div>
          <Link href="/" className="text-sm font-semibold text-blue-600 hover:text-blue-700">
            ← Back to AI Detector
          </Link>
        </div>
      </header>

      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <div className="grid sm:grid-cols-2 gap-6 mb-6">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-3">Tone Mode</label>
              <div className="flex flex-wrap gap-2">
                {(["academic", "professional", "neutral", "conversational"] as ToneOption[]).map((t) => (
                  <button key={t} onClick={() => setTone(t)} className={`px-4 py-2 rounded-xl border text-xs capitalize transition-all ${tone === t ? "bg-blue-600 text-white border-blue-600 shadow-md" : "bg-slate-50 text-slate-600 hover:bg-slate-100"}`}>{t}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-3">Bypass Intensity</label>
              <div className="flex flex-wrap gap-2">
                {(["subtle", "moderate", "aggressive"] as IntensityOption[]).map((i) => (
                  <button key={i} onClick={() => setIntensity(i)} className={`px-4 py-2 rounded-xl border text-xs capitalize transition-all ${intensity === i ? "bg-emerald-600 text-white border-emerald-700 shadow-md" : "bg-slate-50 text-slate-600 hover:bg-slate-100"}`}>{i}</button>
                ))}
              </div>
            </div>
          </div>

          <textarea
            className="w-full h-56 p-5 border border-slate-200 rounded-2xl text-sm focus:ring-2 focus:ring-emerald-500 outline-none leading-relaxed shadow-inner"
            placeholder="Paste text here to rewrite and bypass AI detection..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
          
          <div className="flex justify-between items-center mt-4">
            <button onClick={handleHumanize} className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 px-10 rounded-xl shadow-lg transition-transform active:scale-95">
              Humanize Text
            </button>
            {error && <p className="text-red-500 text-xs font-bold bg-red-50 px-3 py-1 rounded-full">{error}</p>}
          </div>
        </div>

        {result && (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="grid grid-cols-3 gap-4">
              <StatChip label="Original Words" value={String(result.wordCountOriginal)} />
              <StatChip label="New Words" value={String(result.wordCountHumanized)} />
              <StatChip label="Patterns Broken" value={String(result.changes.length)} />
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-emerald-50/50">
                <span className="text-xs font-bold text-emerald-800 uppercase tracking-widest">Bypass-Ready Output</span>
                <button 
                  onClick={() => navigator.clipboard.writeText(result.humanized)}
                  className="text-xs font-bold text-slate-600 hover:text-emerald-600 transition-colors"
                >
                  Copy Content
                </button>
              </div>
              <div className="p-8 text-sm text-slate-800 leading-loose whitespace-pre-wrap font-medium">
                {result.humanized}
              </div>
              <div className="p-6 bg-slate-50 border-t border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Detection Bypass Logs</p>
                <div className="space-y-2">
                  {result.changes.map((c, i) => (
                    <div key={i} className="text-[11px] p-3 bg-white border border-slate-200 rounded-xl text-slate-600 flex gap-2 items-center">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      <span className="font-bold text-emerald-600 uppercase w-20">{c.type}:</span> {c.description}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}