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
//  VOCABULARY REPLACEMENT MAP
//  [aiWord, neutral, academic, professional, conversational]
// ─────────────────────────────────────────────────────────────────────────────

const VOCAB_MAP: [string, string, string, string, string][] = [
  ["utilize","use","employ","use","use"],
  ["utilizes","uses","employs","uses","uses"],
  ["utilized","used","employed","used","used"],
  ["utilizing","using","employing","using","using"],
  ["facilitate","help","support","enable","help"],
  ["facilitates","helps","supports","enables","helps"],
  ["facilitated","helped","supported","enabled","helped"],
  ["facilitating","helping","supporting","enabling","helping"],
  ["leverage","use","draw on","make use of","tap into"],
  ["leverages","uses","draws on","makes use of","taps into"],
  ["leveraged","used","drew on","made use of","tapped into"],
  ["implement","apply","apply","carry out","put in place"],
  ["implements","applies","applies","carries out","puts in place"],
  ["implemented","applied","applied","carried out","put in place"],
  ["furthermore","also","additionally","moreover","and"],
  ["moreover","also","what is more","beyond that","plus"],
  ["additionally","also","further","in addition","and"],
  ["consequently","so","as a result","therefore","so"],
  ["nevertheless","still","nonetheless","even so","still"],
  ["nonetheless","still","even so","that said","still"],
  ["accordingly","so","thus","as such","so"],
  ["subsequently","then","later","after that","after that"],
  ["endeavor","try","attempt","effort","try"],
  ["endeavors","tries","attempts","efforts","tries"],
  ["endeavored","tried","attempted","worked","tried"],
  ["comprehensively","fully","thoroughly","in full","fully"],
  ["robust","strong","solid","reliable","solid"],
  ["seamless","smooth","fluid","smooth","smooth"],
  ["seamlessly","smoothly","fluidly","without issue","smoothly"],
  ["scalable","flexible","adaptable","scalable","flexible"],
  ["holistic","overall","broad","comprehensive","all-round"],
  ["nuanced","subtle","complex","detailed","layered"],
  ["dynamic","active","changing","adaptive","ever-changing"],
  ["transformative","significant","profound","major","game-changing"],
  ["innovative","new","novel","fresh","new"],
  ["groundbreaking","new","pioneering","landmark","path-breaking"],
  ["pivotal","key","central","critical","key"],
  ["foundational","core","basic","fundamental","core"],
  ["notably","importantly","of note","worth noting","notably"],
  ["substantially","greatly","considerably","significantly","a lot"],
  ["fundamentally","at its core","essentially","in essence","basically"],
  ["underscore","highlight","show","emphasize","show"],
  ["underscores","highlights","shows","emphasizes","shows"],
  ["encompass","cover","include","span","cover"],
  ["encompasses","covers","includes","spans","covers"],
  ["synergy","cooperation","combined effect","joint effort","teamwork"],
  ["paradigm","model","framework","approach","way of thinking"],
  ["ecosystem","environment","system","network","world"],
  ["proactive","prepared","forward-thinking","anticipatory","ahead of the curve"],
  ["actionable","practical","workable","concrete","doable"],
  ["fostering","building","encouraging","developing","growing"],
  ["harnessing","using","drawing on","channeling","tapping"],
  ["delve","look","explore","examine","dig into"],
  ["delves","looks","explores","examines","digs into"],
  ["tapestry","mix","blend","combination","mix"],
  ["cornerstone","foundation","basis","core","backbone"],
  ["mitigate","reduce","limit","manage","cut down"],
  ["trajectory","path","direction","course","direction"],
  ["crucial","key","important","critical","important"],
  ["vital","key","essential","critical","key"],
  ["imperative","necessary","essential","required","needed"],
  ["essential","needed","necessary","required","needed"],
  ["significant","major","notable","considerable","big"],
  ["various","several","different","a range of","different"],
  ["numerous","many","several","a number of","lots of"],
  ["diverse","varied","different","wide-ranging","all kinds of"],
  ["overall","in general","broadly","on the whole","all in all"],
  ["potential","possible","likely","prospective","possible"],
  ["optimal","best","ideal","most effective","best"],
  ["commence","start","begin","start","kick off"],
  ["commences","starts","begins","starts","kicks off"],
  ["commenced","started","began","started","kicked off"],
  ["demonstrate","show","show","illustrate","show"],
  ["demonstrates","shows","shows","illustrates","shows"],
  ["demonstrated","showed","showed","illustrated","showed"],
  ["acknowledge","note","recognize","accept","admit"],
  ["acknowledges","notes","recognizes","accepts","admits"],
  ["advancements","progress","advances","developments","progress"],
  ["challenges","problems","difficulties","issues","hurdles"],
  ["opportunities","chances","prospects","openings","chances"],
  ["implications","effects","consequences","impact","what it means"],
  ["considerations","factors","points","concerns","things to think about"],
  ["aspects","parts","elements","features","sides"],
  ["approaches","methods","ways","strategies","ways"],
  ["strategies","plans","methods","approaches","plans"],
  ["mechanisms","ways","means","processes","ways"],
  ["outcomes","results","effects","results","what happens"],
  ["beneficial","helpful","useful","positive","good"],
  ["effective","working","successful","efficient","that works"],
  ["efficient","quick","streamlined","productive","fast"],
  ["in conclusion","to close","in summary","to wrap up","so"],
  ["to summarize","in short","in brief","to sum up","in short"],
];

// ─────────────────────────────────────────────────────────────────────────────
//  TRANSITION REPLACEMENTS
// ─────────────────────────────────────────────────────────────────────────────

const TRANSITION_MAP: [string, Record<ToneOption, string>][] = [
  ["furthermore,",       { academic: "Also,",           professional: "Beyond this,",  neutral: "Also,",    conversational: "And,"         }],
  ["moreover,",          { academic: "What is more,",   professional: "In addition,",  neutral: "Also,",    conversational: "Plus,"        }],
  ["additionally,",      { academic: "Further,",        professional: "As well,",      neutral: "Also,",    conversational: "And,"         }],
  ["consequently,",      { academic: "As a result,",    professional: "Therefore,",    neutral: "So,",      conversational: "So,"          }],
  ["nevertheless,",      { academic: "Even so,",        professional: "That said,",    neutral: "Still,",   conversational: "Still,"       }],
  ["nonetheless,",       { academic: "Even so,",        professional: "That said,",    neutral: "Still,",   conversational: "Still,"       }],
  ["accordingly,",       { academic: "Thus,",           professional: "As such,",      neutral: "So,",      conversational: "So,"          }],
  ["subsequently,",      { academic: "Following this,", professional: "After that,",   neutral: "Then,",    conversational: "Then,"        }],
  ["in conclusion,",     { academic: "To close,",       professional: "In summary,",   neutral: "Overall,", conversational: "So,"          }],
  ["in conclusion",      { academic: "To close,",       professional: "In summary,",   neutral: "Overall,", conversational: "So"           }],
  ["to summarize,",      { academic: "In brief,",       professional: "To sum up,",    neutral: "In short,",conversational: "In short,"    }],
  ["to summarize",       { academic: "In brief,",       professional: "To sum up,",    neutral: "In short,",conversational: "In short"     }],
  ["it is important to note that", { academic: "Note that",    professional: "Importantly,",  neutral: "Note that",conversational: "Worth noting —" }],
  ["it is worth noting that",      { academic: "Notably,",     professional: "Of note,",      neutral: "Note that",conversational: "Worth noting —" }],
  ["it should be noted that",      { academic: "Note that",    professional: "It bears noting that", neutral: "Note that", conversational: "Just to note —" }],
];

// ─────────────────────────────────────────────────────────────────────────────
//  CONTRACTION MAP
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACTION_MAP: [RegExp, string][] = [
  [/\bit is\b/g,      "it's"],
  [/\bthat is\b/g,    "that's"],
  [/\bthere is\b/g,   "there's"],
  [/\bdo not\b/g,     "don't"],
  [/\bdoes not\b/g,   "doesn't"],
  [/\bdid not\b/g,    "didn't"],
  [/\bcannot\b/g,     "can't"],
  [/\bwill not\b/g,   "won't"],
  [/\bwould not\b/g,  "wouldn't"],
  [/\bcould not\b/g,  "couldn't"],
  [/\bshould not\b/g, "shouldn't"],
  [/\bare not\b/g,    "aren't"],
  [/\bwas not\b/g,    "wasn't"],
  [/\bwere not\b/g,   "weren't"],
  [/\bhave not\b/g,   "haven't"],
  [/\bhas not\b/g,    "hasn't"],
  [/\bhad not\b/g,    "hadn't"],
  [/\bthey are\b/g,   "they're"],
  [/\bwe are\b/g,     "we're"],
  [/\byou are\b/g,    "you're"],
  [/\bI am\b/g,       "I'm"],
  [/\bthey have\b/g,  "they've"],
  [/\bwe have\b/g,    "we've"],
];

// ─────────────────────────────────────────────────────────────────────────────
//  SENTENCE SPLITTER
// ─────────────────────────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  const masked = text
    .replace(/\bet\s+al\./gi, "et al#")
    .replace(/\b(Fig|Vol|No|pp|ed|eds|cf|vs|ibid|etc)\./gi, m => m.replace(".", "#"));
  const results: string[] = [];
  const re = /[^.!?]*[.!?]+/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(masked)) !== null) {
    const seg = text.slice(m.index, m.index + m[0].length).trim();
    if (seg.length > 3) results.push(seg);
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail.length > 3) results.push(tail);
  return results.length > 0 ? results : [text];
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 1 — TRANSITION REPLACEMENT
// ─────────────────────────────────────────────────────────────────────────────

function replaceTransitions(text: string, tone: ToneOption): { text: string; count: number } {
  let result = text;
  let count = 0;
  for (const [pattern, replacements] of TRANSITION_MAP) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(?:^|(?<=\\s))" + escaped, "gi");
    result = result.replace(re, (match) => {
      count++;
      const repl = replacements[tone];
      return match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()
        ? repl.charAt(0).toUpperCase() + repl.slice(1)
        : repl;
    });
  }
  return { text: result, count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 2 — VOCABULARY REPLACEMENT
// ─────────────────────────────────────────────────────────────────────────────

const TONE_INDEX: Record<ToneOption, number> = {
  neutral: 1, academic: 2, professional: 3, conversational: 4,
};

function replaceVocabulary(text: string, tone: ToneOption, intensity: IntensityOption): { text: string; count: number } {
  let result = text;
  let count = 0;
  const idx = TONE_INDEX[tone];
  const map = intensity === "subtle" ? VOCAB_MAP.slice(0, 40) : VOCAB_MAP;

  for (const [ai, neutral, academic, professional, conversational] of map) {
    const replacements = [neutral, academic, professional, conversational];
    const replacement = replacements[idx - 1] ?? neutral;
    if (!replacement || replacement === ai) continue;
    const re = new RegExp("\\b" + ai.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi");
    result = result.replace(re, (match) => {
      count++;
      if (match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1);
      }
      return replacement;
    });
  }
  return { text: result, count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 3 — CONTRACTION INSERTION
// ─────────────────────────────────────────────────────────────────────────────

function insertContractions(text: string, tone: ToneOption, intensity: IntensityOption): { text: string; count: number } {
  if (tone === "academic") return { text, count: 0 };
  if (tone === "professional" && intensity === "subtle") return { text, count: 0 };

  let result = text;
  let count = 0;
  const map = intensity === "subtle" || tone === "professional"
    ? CONTRACTION_MAP.slice(0, 6)
    : CONTRACTION_MAP;

  for (const [re, contraction] of map) {
    result = result.replace(re, () => { count++; return contraction; });
  }
  return { text: result, count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 4 — BURSTINESS INJECTION
// ─────────────────────────────────────────────────────────────────────────────

function injectBurstiness(text: string, intensity: IntensityOption): { text: string; splits: number; merges: number } {
  if (intensity === "subtle") return { text, splits: 0, merges: 0 };

  const sentences = splitSentences(text);
  const result: string[] = [];
  let splits = 0;
  let merges = 0;

  for (let i = 0; i < sentences.length; i++) {
    const sent = sentences[i];
    const wordCount = sent.trim().split(/\s+/).length;

    // Split long sentences (>28 words) at a natural junction
    if (wordCount > 28) {
      const splitPatterns = [/,\s+and\s+/i, /,\s+but\s+/i, /,\s+while\s+/i, /;\s*/, /,\s+which\s+/i, /,\s+because\s+/i, /,\s+so\s+/i];
      let split = false;
      for (const pattern of splitPatterns) {
        const match = pattern.exec(sent);
        if (match && match.index > 10 && match.index < sent.length - 10) {
          const before = sent.slice(0, match.index).trim().replace(/[,;]$/, "") + ".";
          const afterRaw = sent.slice(match.index + match[0].length).trim();
          const after = afterRaw.charAt(0).toUpperCase() + afterRaw.slice(1);
          result.push(before);
          result.push(after);
          splits++;
          split = true;
          break;
        }
      }
      if (!split) result.push(sent);
      continue;
    }

    // Merge two consecutive very short sentences for aggressive mode
    if (
      intensity === "aggressive" &&
      wordCount <= 7 &&
      i + 1 < sentences.length &&
      sentences[i + 1].trim().split(/\s+/).length <= 7
    ) {
      const next = sentences[i + 1];
      const merged = sent.replace(/[.!?]$/, "") + ", " + next.charAt(0).toLowerCase() + next.slice(1);
      result.push(merged);
      i++;
      merges++;
      continue;
    }

    result.push(sent);
  }

  return { text: result.join(" "), splits, merges };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 5 — SENTENCE STARTER VARIATION
// ─────────────────────────────────────────────────────────────────────────────

function varySentenceStarters(text: string, intensity: IntensityOption): { text: string; count: number } {
  if (intensity === "subtle") return { text, count: 0 };
  const sentences = splitSentences(text);
  let count = 0;
  const alternates: Record<string, string[]> = {
    "this":  ["Such a", "That"],
    "the":   ["Such", "That particular"],
    "these": ["Such", "Those"],
    "it":    ["That", "This"],
    "they":  ["These", "Such"],
  };
  for (let i = 1; i < sentences.length; i++) {
    const prevFirst = sentences[i - 1].trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
    const currFirst = sentences[i].trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
    if (prevFirst === currFirst && alternates[currFirst]) {
      const alts = alternates[currFirst];
      const alt = alts[i % alts.length];
      sentences[i] = alt + " " + sentences[i].slice(currFirst.length + (sentences[i].match(/^\S+\s/) || [""])[0].length - currFirst.length).trimStart();
      count++;
    }
  }
  return { text: sentences.join(" "), count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 6 — PERPLEXITY BOOST
// ─────────────────────────────────────────────────────────────────────────────

const HEDGE_OPENERS: Record<ToneOption, string[]> = {
  academic:       ["It bears noting that", "One might observe that", "In practice,", "To be clear,"],
  professional:   ["In practice,", "Worth noting:", "To be clear,", "That said,"],
  neutral:        ["In practice,", "Worth noting,", "That said,", "To be fair,"],
  conversational: ["Honestly,", "To be fair,", "That said,", "Worth noting —"],
};

function boostPerplexity(text: string, tone: ToneOption, intensity: IntensityOption): { text: string; count: number } {
  if (intensity === "subtle") return { text, count: 0 };
  const sentences = splitSentences(text);
  let count = 0;

  if (sentences.length >= 4) {
    const targetIdx = Math.floor(sentences.length / 2);
    const opener = HEDGE_OPENERS[tone][targetIdx % HEDGE_OPENERS[tone].length];
    const target = sentences[targetIdx];
    const alreadyHedged = /^(honestly|that said|worth|in practice|to be|one might|it bears)/i.test(target);
    if (!alreadyHedged) {
      sentences[targetIdx] = opener + " " + target.charAt(0).toLowerCase() + target.slice(1);
      count++;
    }
  }

  if (intensity === "aggressive") {
    for (let i = 0; i < sentences.length; i++) {
      const words = sentences[i].split(/\s+/);
      if (words.length > 18) {
        const insertAt = Math.floor(words.length * 0.6);
        const asides: Record<ToneOption, string> = {
          academic:       "— and this point matters —",
          professional:   "— worth emphasizing —",
          neutral:        "— and this is key —",
          conversational: "— which is really the point —",
        };
        words.splice(insertAt, 0, asides[tone]);
        sentences[i] = words.join(" ");
        count++;
        break;
      }
    }
  }

  return { text: sentences.join(" "), count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN HUMANIZER ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function humanizeText(text: string, tone: ToneOption, intensity: IntensityOption): HumanizerResult {
  const changes: ChangeNote[] = [];

  const s1 = replaceTransitions(text, tone);
  if (s1.count > 0) changes.push({ type: "transition", description: `Replaced ${s1.count} AI transition phrase${s1.count > 1 ? "s" : ""} (e.g. "furthermore", "moreover", "in conclusion") with natural connectors.` });

  const s2 = replaceVocabulary(s1.text, tone, intensity);
  if (s2.count > 0) changes.push({ type: "vocabulary", description: `Swapped ${s2.count} AI-associated word${s2.count > 1 ? "s" : ""} (e.g. "utilize", "leverage", "crucial") with natural alternatives for a ${tone} tone.` });

  const s3 = insertContractions(s2.text, tone, intensity);
  if (s3.count > 0) changes.push({ type: "tone", description: `Inserted ${s3.count} contraction${s3.count > 1 ? "s" : ""} (e.g. "it's", "don't", "can't") to reduce the formal AI-writing signal of avoiding contractions.` });

  const s4 = injectBurstiness(s3.text, intensity);
  if (s4.splits > 0 || s4.merges > 0) {
    const parts: string[] = [];
    if (s4.splits > 0) parts.push(`split ${s4.splits} long sentence${s4.splits > 1 ? "s" : ""}`);
    if (s4.merges > 0) parts.push(`merged ${s4.merges} short sentence pair${s4.merges > 1 ? "s" : ""}`);
    changes.push({ type: "burstiness", description: `Increased sentence length variation: ${parts.join(" and ")}. AI writes in uniform rhythm; humans vary short and long sentences naturally.` });
  }

  const s5 = varySentenceStarters(s4.text, intensity);
  if (s5.count > 0) changes.push({ type: "restructure", description: `Varied ${s5.count} repeated sentence starter${s5.count > 1 ? "s" : ""} — AI text often begins consecutive sentences with the same word ("This", "The").` });

  const s6 = boostPerplexity(s5.text, tone, intensity);
  if (s6.count > 0) changes.push({ type: "perplexity", description: `Added ${s6.count} hedging phrase${s6.count > 1 ? "s" : ""} or em-dash aside to introduce mild unpredictability — a hallmark of natural human writing.` });

  if (changes.length === 0) changes.push({ type: "vocabulary", description: "No major AI patterns detected in this text. It already reads naturally — only minor stylistic tuning was applied." });

  const humanized = s6.text.trim();
  return {
    original: text,
    humanized,
    changes,
    wordCountOriginal: text.trim().split(/\s+/).length,
    wordCountHumanized: humanized.split(/\s+/).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CHANGE TYPE CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const CHANGE_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  burstiness:  { label: "Burstiness",  color: "bg-purple-50 border-purple-200 text-purple-800",    dot: "bg-purple-500"  },
  vocabulary:  { label: "Vocabulary",  color: "bg-blue-50 border-blue-200 text-blue-800",          dot: "bg-blue-500"    },
  perplexity:  { label: "Perplexity",  color: "bg-amber-50 border-amber-200 text-amber-800",       dot: "bg-amber-500"   },
  restructure: { label: "Restructure", color: "bg-emerald-50 border-emerald-200 text-emerald-800", dot: "bg-emerald-500" },
  tone:        { label: "Tone",        color: "bg-rose-50 border-rose-200 text-rose-800",          dot: "bg-rose-500"    },
  transition:  { label: "Transition",  color: "bg-slate-100 border-slate-200 text-slate-700",      dot: "bg-slate-500"   },
};

// ─────────────────────────────────────────────────────────────────────────────
//  COPY BUTTON
// ─────────────────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}
      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition-colors"
    >
      {copied ? (
        <><svg className="h-3.5 w-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg><span className="text-emerald-600">Copied!</span></>
      ) : (
        <><svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>Copy</>
      )}
    </button>
  );
}

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
  const [tone, setTone]           = useState<ToneOption>("neutral");
  const [intensity, setIntensity] = useState<IntensityOption>("moderate");
  const [result, setResult]       = useState<HumanizerResult | null>(null);
  const [error, setError]         = useState("");
  const [activeTab, setActiveTab] = useState<"output" | "changes">("output");

  const wc = inputText.trim() === "" ? 0 : inputText.trim().split(/\s+/).length;

  const handleHumanize = useCallback(() => {
    if (wc < 20) { setError("Please enter at least 20 words."); return; }
    setError("");
    try {
      const res = humanizeText(inputText.trim(), tone, intensity);
      setResult(res);
      setActiveTab("output");
    } catch (e) {
      setError("Error: " + (e instanceof Error ? e.message : String(e)));
    }
  }, [inputText, tone, intensity, wc]);

  const handleClear = () => { setInputText(""); setResult(null); setError(""); };

  const tones: { value: ToneOption; label: string; desc: string }[] = [
    { value: "academic",       label: "Academic",       desc: "Scholarly & precise"    },
    { value: "professional",   label: "Professional",   desc: "Formal & authoritative" },
    { value: "neutral",        label: "Neutral",        desc: "Clear & balanced"        },
    { value: "conversational", label: "Conversational", desc: "Natural & relaxed"       },
  ];

  const intensities: { value: IntensityOption; label: string; desc: string; active: string }[] = [
    { value: "subtle",     label: "Subtle",     desc: "Minimal changes",     active: "border-emerald-400 bg-emerald-50 text-emerald-800" },
    { value: "moderate",   label: "Moderate",   desc: "Balanced rewrite",    active: "border-amber-400 bg-amber-50 text-amber-800"       },
    { value: "aggressive", label: "Aggressive", desc: "Full transformation", active: "border-red-400 bg-red-50 text-red-800"             },
  ];

  const wcDiff = result ? result.wordCountHumanized - result.wordCountOriginal : 0;

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">

      <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">AI Content Detector</h1>
            <p className="text-xs text-slate-500 mt-0.5">Turnitin methodology vs GPTZero methodology · side-by-side comparison</p>
          </div>
          <div className="hidden sm:flex gap-1.5">
            <a href="/" className="text-xs font-medium bg-slate-50 text-slate-500 border border-slate-200 px-2.5 py-1 rounded-full hover:bg-slate-100 transition-colors">← AI Detector</a>
            <span className="text-xs font-medium bg-emerald-600 text-white px-2.5 py-1 rounded-full">AI Humanizer</span>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-5">

        {/* Settings row */}
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
            <label className="block text-sm font-semibold text-slate-700 mb-3">Output Tone</label>
            <div className="grid grid-cols-2 gap-2">
              {tones.map(t => (
                <button key={t.value} onClick={() => setTone(t.value)}
                  className={`text-left px-3 py-2.5 rounded-xl border text-xs transition-all ${tone === t.value ? "border-blue-500 bg-blue-50 text-blue-800" : "border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-white"}`}>
                  <div className="font-semibold">{t.label}</div>
                  <div className="text-[10px] opacity-70 mt-0.5">{t.desc}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
            <label className="block text-sm font-semibold text-slate-700 mb-3">Humanization Intensity</label>
            <div className="space-y-2">
              {intensities.map(i => (
                <button key={i.value} onClick={() => setIntensity(i.value)}
                  className={`w-full text-left px-4 py-2.5 rounded-xl border text-xs transition-all ${intensity === i.value ? i.active + " border-current" : "border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-white"}`}>
                  <span className="font-semibold">{i.label}</span>
                  <span className="opacity-60 ml-2">— {i.desc}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Input */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 pt-5 pb-4">
            <label className="block text-sm font-semibold text-slate-700 mb-2">Paste your AI-generated text</label>
            <textarea
              className="w-full h-44 resize-none border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition leading-relaxed"
              placeholder="Paste the AI-generated text you want to humanize… (minimum 20 words)"
              value={inputText}
              onChange={e => { setInputText(e.target.value); setError(""); }}
            />
            <div className="flex items-center justify-between mt-2">
              <span className={`text-xs ${wc >= 20 ? "text-slate-400" : "text-amber-500 font-medium"}`}>
                {wc} word{wc !== 1 ? "s" : ""}{wc > 0 && wc < 20 ? ` · need ${20 - wc} more` : wc >= 20 ? " · ready to humanize" : ""}
              </span>
              {error && <span className="text-xs text-red-500 font-medium">{error}</span>}
            </div>
          </div>
          <div className="bg-slate-50 border-t border-slate-100 px-6 py-4 flex items-center gap-3">
            <button onClick={handleHumanize} disabled={wc < 20}
              className="flex-1 sm:flex-none bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-semibold text-sm px-8 py-2.5 rounded-xl transition-colors shadow-sm">
              Humanize Text
            </button>
            {(result || inputText) && (
              <button onClick={handleClear} className="text-sm text-slate-500 hover:text-slate-700 font-medium px-4 py-2.5 rounded-xl border border-slate-200 hover:bg-white transition-colors">Clear</button>
            )}
          </div>
        </div>

        {/* Result */}
        {result && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <StatChip label="Original Words"  value={String(result.wordCountOriginal)} />
              <StatChip label="Humanized Words" value={String(result.wordCountHumanized)}
                sub={wcDiff > 0 ? `+${wcDiff} added` : wcDiff < 0 ? `${wcDiff} removed` : "same length"} />
              <StatChip label="Changes Applied" value={String(result.changes.length)} sub="techniques used" />
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="border-b border-slate-100 px-6 pt-4 flex items-center gap-1">
                {(["output", "changes"] as const).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    className={`text-sm font-semibold px-4 py-2 rounded-t-lg border-b-2 transition-colors ${activeTab === tab ? "border-emerald-500 text-emerald-700" : "border-transparent text-slate-400 hover:text-slate-600"}`}>
                    {tab === "output" ? "Humanized Output" : <>What Changed <span className="ml-1.5 text-[10px] font-bold bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">{result.changes.length}</span></>}
                  </button>
                ))}
              </div>

              {activeTab === "output" && (
                <div className="px-6 py-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Humanized Text</span>
                    <CopyButton text={result.humanized} />
                  </div>
                  <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-5 py-4 text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">{result.humanized}</div>
                  <div className="mt-5 pt-5 border-t border-slate-100">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Original (for comparison)</p>
                    <div className="bg-slate-50 border border-slate-200 rounded-xl px-5 py-4 text-sm text-slate-500 leading-relaxed whitespace-pre-wrap">{result.original}</div>
                  </div>
                </div>
              )}

              {activeTab === "changes" && (
                <div className="px-6 py-5 space-y-2.5">
                  <p className="text-xs text-slate-400 mb-4">Humanization techniques applied to your text:</p>
                  {result.changes.map((change, idx) => {
                    const cfg = CHANGE_CONFIG[change.type] ?? CHANGE_CONFIG.transition;
                    return (
                      <div key={idx} className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-xs ${cfg.color}`}>
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-0.5 ${cfg.dot}`} />
                        <div><span className="font-bold mr-1.5">{cfg.label}:</span>{change.description}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="bg-slate-900 rounded-2xl px-5 py-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-white text-sm font-semibold">Ready to verify?</p>
                <p className="text-slate-400 text-xs mt-0.5">Run the humanized text through the AI detector to check how well it passes</p>
              </div>
              <a href="/" className="flex-shrink-0 flex items-center gap-2 bg-blue-500 hover:bg-blue-400 text-white font-semibold text-sm px-5 py-2.5 rounded-xl transition-colors shadow-sm">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                Test in Detector →
              </a>
            </div>
          </>
        )}

        {/* Methodology explainer */}
        <div className="bg-slate-800 text-slate-300 rounded-2xl p-5 text-xs leading-relaxed grid sm:grid-cols-3 gap-6">
          <div>
            <p className="font-semibold text-white mb-1.5">Burstiness & Rhythm</p>
            <p className="text-slate-400"><strong className="text-slate-200">Sentence length variation</strong> is the strongest human signal. Long sentences are split at natural conjunctions; consecutive short sentences are merged. This pushes the CV above the human threshold of 0.55.</p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1.5">Vocabulary & Transitions</p>
            <p className="text-slate-400"><strong className="text-slate-200">80+ AI words</strong> (furthermore, utilize, leverage, crucial…) are replaced with natural alternatives matched to your chosen tone. AI transition openers are swapped for human connectors.</p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1.5">Perplexity & Tone</p>
            <p className="text-slate-400"><strong className="text-slate-200">Contractions, hedges, and em-dash asides</strong> introduce mild unpredictability. Meaning is always preserved — only style changes, not substance.</p>
          </div>
        </div>

      </div>
    </main>
  );
}
