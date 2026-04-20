"use client";

import { useState, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────────────────────────────────────

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
//  CLAUDE API CALL
// ─────────────────────────────────────────────────────────────────────────────

async function callClaudeHumanizer(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): Promise<HumanizerResult> {
  const toneDescriptions: Record<ToneOption, string> = {
    academic: "formal academic writing with precise terminology, complex sentence structures, and scholarly tone",
    professional: "professional business writing that is clear, authoritative, and polished",
    neutral: "neutral, balanced writing that is clear and natural without being too formal or too casual",
    conversational: "natural, conversational writing with varied rhythm, contractions where appropriate, and relatable phrasing",
  };

  const intensityDescriptions: Record<IntensityOption, string> = {
    subtle: "Make minimal changes — only adjust the most obvious AI patterns. Preserve roughly 80% of the original phrasing.",
    moderate: "Make moderate changes — restructure sentences, vary vocabulary, and improve rhythm throughout.",
    aggressive: "Transform the text substantially — fully rewrite sentence structures, replace AI vocabulary, and create strong burstiness throughout.",
  };

  const systemPrompt = `You are an expert AI text humanizer. Your job is to rewrite AI-generated text to sound authentically human-written, specifically targeting the signals that AI detectors use.

You must apply ALL of these humanization techniques:

1. BURSTINESS (most important): Deliberately vary sentence lengths. Mix very short sentences (4-8 words) with medium ones (12-18 words) and occasionally longer ones (20-30 words). Never let 3+ consecutive sentences be similar in length. This is the single strongest signal for human writing.

2. VOCABULARY VARIATION: Replace generic AI vocabulary (furthermore, moreover, additionally, consequently, utilize, facilitate, leverage, pivotal, crucial, comprehensive, robust, seamless, etc.) with natural alternatives. Use contractions (don't, it's, they're, can't) where appropriate for the tone.

3. PERPLEXITY INCREASE: Introduce mild unpredictability — use idioms, occasional rhetorical questions, unexpected word choices, or colloquial phrasing that fits the tone. Avoid always choosing the "safest" word.

4. SENTENCE RESTRUCTURING: Split run-on sentences. Merge some short choppy ones. Occasionally start a sentence with "And" or "But." Use fragments sparingly for emphasis.

5. HUMAN TYPOGRAPHY: Where natural, use em-dashes (—) for asides, ellipses (...) for trailing thoughts, parenthetical asides.

6. REMOVE AI TRANSITIONS: Replace "Furthermore," "Moreover," "Additionally," "In conclusion," "It is important to note" with natural connectors like "Also," "Plus," "What's more," "That said," "Still," or no connector at all.

7. PRESERVE MEANING: All original ideas, facts, and arguments must be retained. Only style changes, not substance.

Tone target: ${toneDescriptions[tone]}
Intensity: ${intensityDescriptions[intensity]}

Respond ONLY with a JSON object in this exact format (no markdown, no backticks):
{
  "humanized": "the full rewritten text here",
  "changes": [
    {"type": "burstiness", "description": "specific change made"},
    {"type": "vocabulary", "description": "specific change made"},
    {"type": "perplexity", "description": "specific change made"},
    {"type": "restructure", "description": "specific change made"},
    {"type": "tone", "description": "specific change made"},
    {"type": "transition", "description": "specific change made"}
  ]
}

The "changes" array should list 4-8 specific, concrete changes you made (not generic descriptions).`;

  // Call our own Next.js API route (server-side) so the API key stays secure
  const response = await fetch("/api/humanize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, tone, intensity, systemPrompt }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error);

  const raw: string = data.content
    .map((b: { type: string; text?: string }) => b.type === "text" ? b.text : "")
    .join("");

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse response JSON");
  const parsed = JSON.parse(jsonMatch[0]);

  return {
    original: text,
    humanized: parsed.humanized,
    changes: parsed.changes || [],
    wordCountOriginal: text.trim().split(/\s+/).length,
    wordCountHumanized: parsed.humanized.trim().split(/\s+/).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CHANGE TYPE CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const CHANGE_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  burstiness:   { label: "Burstiness",      color: "bg-purple-50 border-purple-200 text-purple-800",  dot: "bg-purple-500"  },
  vocabulary:   { label: "Vocabulary",      color: "bg-blue-50 border-blue-200 text-blue-800",        dot: "bg-blue-500"    },
  perplexity:   { label: "Perplexity",      color: "bg-amber-50 border-amber-200 text-amber-800",     dot: "bg-amber-500"   },
  restructure:  { label: "Restructure",     color: "bg-emerald-50 border-emerald-200 text-emerald-800", dot: "bg-emerald-500" },
  tone:         { label: "Tone",            color: "bg-rose-50 border-rose-200 text-rose-800",         dot: "bg-rose-500"    },
  transition:   { label: "Transition",      color: "bg-slate-100 border-slate-200 text-slate-700",    dot: "bg-slate-500"   },
};

// ─────────────────────────────────────────────────────────────────────────────
//  DIFF: simple word-level highlight helper (unchanged | changed)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  COPY BUTTON
// ─────────────────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition-colors"
    >
      {copied ? (
        <>
          <svg className="h-3.5 w-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-emerald-600">Copied!</span>
        </>
      ) : (
        <>
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  STAT CHIP
// ─────────────────────────────────────────────────────────────────────────────

function StatChip({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 text-center">
      <div className="text-lg font-bold text-slate-900">{value}</div>
      <div className="text-xs font-medium text-slate-500 mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function HumanizerPage() {
  const [inputText, setInputText] = useState("");
  const [tone, setTone] = useState<ToneOption>("neutral");
  const [intensity, setIntensity] = useState<IntensityOption>("moderate");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HumanizerResult | null>(null);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"output" | "changes">("output");

  const wc = inputText.trim() === "" ? 0 : inputText.trim().split(/\s+/).length;

  const handleHumanize = useCallback(async () => {
    if (wc < 20) { setError("Please enter at least 20 words."); return; }
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await callClaudeHumanizer(inputText.trim(), tone, intensity);
      setResult(res);
      setActiveTab("output");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Error: ${msg}`);
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [inputText, tone, intensity, wc]);

  const handleClear = () => {
    setInputText("");
    setResult(null);
    setError("");
  };

  const tones: { value: ToneOption; label: string; desc: string }[] = [
    { value: "academic",       label: "Academic",       desc: "Scholarly & precise" },
    { value: "professional",   label: "Professional",   desc: "Formal & authoritative" },
    { value: "neutral",        label: "Neutral",        desc: "Clear & balanced" },
    { value: "conversational", label: "Conversational", desc: "Natural & relaxed" },
  ];

  const intensities: { value: IntensityOption; label: string; desc: string; color: string }[] = [
    { value: "subtle",     label: "Subtle",     desc: "Minimal changes",      color: "border-emerald-400 bg-emerald-50 text-emerald-800" },
    { value: "moderate",   label: "Moderate",   desc: "Balanced rewrite",     color: "border-amber-400 bg-amber-50 text-amber-800"       },
    { value: "aggressive", label: "Aggressive", desc: "Full transformation",  color: "border-red-400 bg-red-50 text-red-800"             },
  ];

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">

      {/* Header — matches page.tsx exactly */}
      <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">AI Content Detector</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Turnitin methodology vs GPTZero methodology · side-by-side comparison
            </p>
          </div>
          <div className="hidden sm:flex gap-1.5">
            <a href="/" className="text-xs font-medium bg-slate-50 text-slate-500 border border-slate-200 px-2.5 py-1 rounded-full hover:bg-slate-100 transition-colors">
              ← AI Detector
            </a>
            <span className="text-xs font-medium bg-emerald-600 text-white px-2.5 py-1 rounded-full">AI Humanizer</span>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-5">

        {/* Settings row */}
        <div className="grid sm:grid-cols-2 gap-4">

          {/* Tone selector */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
            <label className="block text-sm font-semibold text-slate-700 mb-3">Output Tone</label>
            <div className="grid grid-cols-2 gap-2">
              {tones.map(t => (
                <button
                  key={t.value}
                  onClick={() => setTone(t.value)}
                  className={`text-left px-3 py-2.5 rounded-xl border text-xs transition-all ${
                    tone === t.value
                      ? "border-blue-500 bg-blue-50 text-blue-800"
                      : "border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-white"
                  }`}
                >
                  <div className="font-semibold">{t.label}</div>
                  <div className="text-[10px] opacity-70 mt-0.5">{t.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Intensity selector */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
            <label className="block text-sm font-semibold text-slate-700 mb-3">Humanization Intensity</label>
            <div className="space-y-2">
              {intensities.map(i => (
                <button
                  key={i.value}
                  onClick={() => setIntensity(i.value)}
                  className={`w-full text-left px-4 py-2.5 rounded-xl border text-xs transition-all ${
                    intensity === i.value
                      ? i.color + " border-current"
                      : "border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-white"
                  }`}
                >
                  <span className="font-semibold">{i.label}</span>
                  <span className="opacity-60 ml-2">— {i.desc}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Input card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 pt-5 pb-4">
            <label className="block text-sm font-semibold text-slate-700 mb-2">Paste your AI-generated text</label>
            <textarea
              className="w-full h-44 resize-none border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition leading-relaxed"
              placeholder="Paste the AI-generated text you want to humanize… (minimum 20 words)"
              value={inputText}
              onChange={e => { setInputText(e.target.value); setError(""); }}
              disabled={loading}
            />
            <div className="flex items-center justify-between mt-2">
              <span className={`text-xs ${wc >= 20 ? "text-slate-400" : "text-amber-500 font-medium"}`}>
                {wc} word{wc !== 1 ? "s" : ""}{wc > 0 && wc < 20 ? ` · need ${20 - wc} more` : wc >= 20 ? " · ready to humanize" : ""}
              </span>
              {error && <span className="text-xs text-red-500 font-medium">{error}</span>}
            </div>
          </div>
          <div className="bg-slate-50 border-t border-slate-100 px-6 py-4 flex items-center gap-3">
            <button
              onClick={handleHumanize}
              disabled={loading || wc < 20}
              className="flex-1 sm:flex-none bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-semibold text-sm px-8 py-2.5 rounded-xl transition-colors shadow-sm"
            >
              {loading ? (
                <span className="flex items-center gap-2 justify-center">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                  Humanizing…
                </span>
              ) : "Humanize Text"}
            </button>
            {(result || inputText) && !loading && (
              <button
                onClick={handleClear}
                className="text-sm text-slate-500 hover:text-slate-700 font-medium px-4 py-2.5 rounded-xl border border-slate-200 hover:bg-white transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Loading shimmer */}
        {loading && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-3 animate-pulse">
            <div className="h-3 bg-slate-100 rounded-full w-1/4" />
            <div className="h-3 bg-slate-100 rounded-full w-full" />
            <div className="h-3 bg-slate-100 rounded-full w-5/6" />
            <div className="h-3 bg-slate-100 rounded-full w-full" />
            <div className="h-3 bg-slate-100 rounded-full w-3/4" />
            <div className="h-3 bg-slate-100 rounded-full w-full" />
          </div>
        )}

        {/* Result */}
        {result && !loading && (
          <>
            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3">
              <StatChip
                label="Original Words"
                value={String(result.wordCountOriginal)}
              />
              <StatChip
                label="Humanized Words"
                value={String(result.wordCountHumanized)}
                sub={result.wordCountHumanized > result.wordCountOriginal
                  ? `+${result.wordCountHumanized - result.wordCountOriginal} added`
                  : result.wordCountHumanized < result.wordCountOriginal
                    ? `${result.wordCountHumanized - result.wordCountOriginal} removed`
                    : "same length"}
              />
              <StatChip
                label="Changes Applied"
                value={String(result.changes.length)}
                sub="techniques used"
              />
            </div>

            {/* Output tabs */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">

              {/* Tab bar */}
              <div className="border-b border-slate-100 px-6 pt-4 flex items-center gap-1">
                <button
                  onClick={() => setActiveTab("output")}
                  className={`text-sm font-semibold px-4 py-2 rounded-t-lg border-b-2 transition-colors ${
                    activeTab === "output"
                      ? "border-emerald-500 text-emerald-700"
                      : "border-transparent text-slate-400 hover:text-slate-600"
                  }`}
                >
                  Humanized Output
                </button>
                <button
                  onClick={() => setActiveTab("changes")}
                  className={`text-sm font-semibold px-4 py-2 rounded-t-lg border-b-2 transition-colors ${
                    activeTab === "changes"
                      ? "border-emerald-500 text-emerald-700"
                      : "border-transparent text-slate-400 hover:text-slate-600"
                  }`}
                >
                  What Changed
                  <span className="ml-1.5 text-[10px] font-bold bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">
                    {result.changes.length}
                  </span>
                </button>
              </div>

              {/* Output tab */}
              {activeTab === "output" && (
                <div className="px-6 py-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Humanized Text</span>
                    <CopyButton text={result.humanized} />
                  </div>
                  <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-5 py-4 text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                    {result.humanized}
                  </div>

                  {/* Side-by-side comparison */}
                  <div className="mt-5 pt-5 border-t border-slate-100">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Original (for comparison)</p>
                    <div className="bg-slate-50 border border-slate-200 rounded-xl px-5 py-4 text-sm text-slate-500 leading-relaxed whitespace-pre-wrap">
                      {result.original}
                    </div>
                  </div>
                </div>
              )}

              {/* Changes tab */}
              {activeTab === "changes" && (
                <div className="px-6 py-5 space-y-2.5">
                  <p className="text-xs text-slate-400 mb-4">Specific humanization techniques applied to your text:</p>
                  {result.changes.map((change, idx) => {
                    const cfg = CHANGE_CONFIG[change.type] ?? CHANGE_CONFIG.transition;
                    return (
                      <div key={idx} className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-xs ${cfg.color}`}>
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-0.5 ${cfg.dot}`} />
                        <div>
                          <span className="font-bold mr-1.5">{cfg.label}:</span>
                          {change.description}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Detect button banner */}
            <div className="bg-slate-900 rounded-2xl px-5 py-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-white text-sm font-semibold">Ready to verify?</p>
                <p className="text-slate-400 text-xs mt-0.5">
                  Run the humanized text through the AI detector to check how well it passes
                </p>
              </div>
              <a
                href="/"
                className="flex-shrink-0 flex items-center gap-2 bg-blue-500 hover:bg-blue-400 text-white font-semibold text-sm px-5 py-2.5 rounded-xl transition-colors shadow-sm"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Test in Detector →
              </a>
            </div>
          </>
        )}

        {/* Methodology explainer — mirrors page.tsx explainer style */}
        <div className="bg-slate-800 text-slate-300 rounded-2xl p-5 text-xs leading-relaxed grid sm:grid-cols-3 gap-6">
          <div>
            <p className="font-semibold text-white mb-1.5">Burstiness & Rhythm</p>
            <p className="text-slate-400">
              <strong className="text-slate-200">Sentence length variation</strong> is the strongest human signal. This tool deliberately mixes short punchy sentences with longer ones, targeting a CV above 0.55 — the threshold human writers naturally produce.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1.5">Vocabulary & Perplexity</p>
            <p className="text-slate-400">
              <strong className="text-slate-200">AI vocabulary</strong> (furthermore, utilize, leverage, pivotal…) is replaced with natural alternatives. Contractions, idioms, and mildly unpredictable phrasing are introduced to raise token-level perplexity.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1.5">Meaning Preserved</p>
            <p className="text-slate-400">
              <strong className="text-slate-200">All original ideas</strong> are retained. Only style changes, not substance. Tone control lets you target academic, professional, neutral, or conversational registers for your specific context.
            </p>
          </div>
        </div>

      </div>
    </main>
  );
}
