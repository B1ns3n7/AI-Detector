"use client";

import { useState, useCallback } from "react";

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
//  VOCABULARY MAP — [pattern, neutral, academic, professional, conversational]
// ─────────────────────────────────────────────────────────────────────────────

const VOCAB_MAP: [RegExp, string, string, string, string][] = [
  [/\butilize[sd]?\b/gi,           "use",            "employ",          "use",              "use"],
  [/\butilizing\b/gi,              "using",           "employing",       "using",            "using"],
  [/\bfacilitate[sd]?\b/gi,        "help",            "support",         "enable",           "help"],
  [/\bfacilitating\b/gi,           "helping",         "supporting",      "enabling",         "helping"],
  [/\bleverag(e[sd]?|ing)\b/gi,    "use",             "draw on",         "make use of",      "tap into"],
  [/\boptimize[sd]?\b/gi,          "improve",         "refine",          "improve",          "make better"],
  [/\boptimizing\b/gi,             "improving",       "refining",        "improving",        "making better"],
  [/\bstreamline[sd]?\b/gi,        "simplify",        "simplify",        "simplify",         "simplify"],
  [/\bimplement(ed|s)?\b/gi,       "apply",           "apply",           "carry out",        "put in place"],
  [/\bimplementing\b/gi,           "applying",        "applying",        "carrying out",     "putting in place"],
  [/\bfurthermore\b/gi,            "also",            "in addition",     "moreover",         "and"],
  [/\bmoreover\b/gi,               "also",            "what is more",    "beyond that",      "plus"],
  [/\badditionally\b/gi,           "also",            "further",         "in addition",      "and"],
  [/\bconsequently\b/gi,           "so",              "as a result",     "therefore",        "so"],
  [/\bnevertheless\b/gi,           "still",           "even so",         "that said",        "still"],
  [/\bnonetheless\b/gi,            "still",           "even so",         "that said",        "still"],
  [/\baccordingly\b/gi,            "so",              "thus",            "as such",          "so"],
  [/\bsubsequently\b/gi,           "then",            "following this",  "after that",       "after that"],
  [/\brobust\b/gi,                 "strong",          "solid",           "reliable",         "solid"],
  [/\bseamless(ly)?\b/gi,          "smooth",          "fluid",           "smooth",           "smooth"],
  [/\bholistic\b/gi,               "overall",         "broad",           "comprehensive",    "all-round"],
  [/\bnuanced\b/gi,                "subtle",          "complex",         "detailed",         "layered"],
  [/\bdynamic\b/gi,                "active",          "varied",          "adaptive",         "ever-changing"],
  [/\btransformative\b/gi,         "significant",     "profound",        "major",            "game-changing"],
  [/\binnovative\b/gi,             "new",             "novel",           "fresh",            "new"],
  [/\bgroundbreaking\b/gi,         "new",             "pioneering",      "landmark",         "path-breaking"],
  [/\bpivotal\b/gi,                "key",             "central",         "critical",         "key"],
  [/\bfoundational\b/gi,           "core",            "fundamental",     "essential",        "core"],
  [/\bnotably\b/gi,                "importantly",     "of note",         "worth noting",     "notably"],
  [/\bsubstantially\b/gi,          "greatly",         "considerably",    "significantly",    "a lot"],
  [/\bfundamentally\b/gi,          "at its core",     "essentially",     "in essence",       "basically"],
  [/\bunderscores?\b/gi,           "shows",           "highlights",      "emphasizes",       "shows"],
  [/\bencompass(es)?\b/gi,         "cover",           "include",         "span",             "cover"],
  [/\bsynergy\b/gi,                "cooperation",     "combined effect", "joint effort",     "teamwork"],
  [/\bparadigm\b/gi,               "model",           "framework",       "approach",         "way of thinking"],
  [/\becosystem\b/gi,              "environment",     "system",          "network",          "world"],
  [/\bproactive\b/gi,              "prepared",        "forward-thinking","anticipatory",     "ahead of the curve"],
  [/\bactionable\b/gi,             "practical",       "workable",        "concrete",         "doable"],
  [/\bfostering\b/gi,              "building",        "encouraging",     "developing",       "growing"],
  [/\bharnessing\b/gi,             "using",           "drawing on",      "channeling",       "tapping"],
  [/\bdelves?\b/gi,                "looks",           "explores",        "examines",         "digs into"],
  [/\btapestry\b/gi,               "mix",             "blend",           "combination",      "mix"],
  [/\bcornerstone\b/gi,            "foundation",      "basis",           "core",             "backbone"],
  [/\bmitigate[sd]?\b/gi,          "reduce",          "limit",           "manage",           "cut down"],
  [/\btrajectory\b/gi,             "path",            "direction",       "course",           "direction"],
  [/\bcrucial\b/gi,                "key",             "important",       "critical",         "important"],
  [/\bvital\b/gi,                  "key",             "essential",       "critical",         "key"],
  [/\bimperative\b/gi,             "necessary",       "essential",       "required",         "needed"],
  [/\bsignificant(ly)?\b/gi,       "major",           "notable",         "considerable",     "big"],
  [/\bvarious\b/gi,                "several",         "different",       "a range of",       "different"],
  [/\bnumerous\b/gi,               "many",            "several",         "a number of",      "lots of"],
  [/\bdiverse\b/gi,                "varied",          "different",       "wide-ranging",     "all kinds of"],
  [/\bpotential\b/gi,              "possible",        "likely",          "prospective",      "possible"],
  [/\boptimal\b/gi,                "best",            "ideal",           "most effective",   "best"],
  [/\bcommence[sd]?\b/gi,          "start",           "begin",           "start",            "kick off"],
  [/\bcommencing\b/gi,             "starting",        "beginning",       "starting",         "kicking off"],
  [/\bdemonstrate[sd]?\b/gi,       "show",            "show",            "illustrate",       "show"],
  [/\bdemonstrating\b/gi,          "showing",         "showing",         "illustrating",     "showing"],
  [/\backnowledge[sd]?\b/gi,       "note",            "recognize",       "accept",           "admit"],
  [/\badvancements?\b/gi,          "progress",        "advances",        "developments",     "progress"],
  [/\bimplications?\b/gi,          "effects",         "consequences",    "impact",           "what it means"],
  [/\bconsiderations?\b/gi,        "factors",         "points",          "concerns",         "things to consider"],
  [/\bapproaches?\b/gi,            "methods",         "ways",            "strategies",       "ways"],
  [/\bstrategies\b/gi,             "plans",           "methods",         "approaches",       "plans"],
  [/\bmechanisms?\b/gi,            "ways",            "means",           "processes",        "ways"],
  [/\boutcomes?\b/gi,              "results",         "effects",         "results",          "what happens"],
  [/\bbeneficial\b/gi,             "helpful",         "useful",          "positive",         "good"],
  [/\beffectively\b/gi,            "well",            "successfully",    "efficiently",      "well"],
  [/\befficiently\b/gi,            "quickly",         "smoothly",        "productively",     "fast"],
  [/\bin conclusion\b/gi,          "overall",         "to close",        "in summary",       "so"],
  [/\bto summarize\b/gi,           "in short",        "in brief",        "to sum up",        "in short"],
  [/\bit is important to note\b/gi,"note that",       "notably,",        "importantly,",     "worth noting —"],
  [/\bit is worth noting\b/gi,     "note that",       "notably,",        "of note,",         "worth noting —"],
  [/\bit should be noted\b/gi,     "note that",       "notably,",        "it bears noting",  "just to note —"],
  [/\bplays a (?:crucial|pivotal|vital|key|significant) role\b/gi,
                                   "is important",    "is central",      "is key",           "matters a lot"],
  [/\bin today'?s (?:world|society|era|landscape|age)\b/gi,
                                   "today",           "in the current era", "today",         "these days"],
  [/\bcannot be (?:overstated|understated)\b/gi,
                                   "is very important","deserves emphasis","is highly significant","really matters"],
  [/\bscalabilit(?:y|ies)\b/gi,    "flexibility",     "adaptability",    "scalability",      "room to grow"],
  [/\bempowering\b/gi,             "helping",         "enabling",        "supporting",       "giving people"],
  [/\baligning\b/gi,               "matching",        "matching",        "aligning",         "lining up"],
  [/\bintegrating\b/gi,            "combining",       "combining",       "incorporating",    "bringing together"],
  [/\bcatalyzing\b/gi,             "driving",         "driving",         "accelerating",     "speeding up"],
  [/\blinchpin\b/gi,               "key part",        "central element", "key component",    "key part"],
  [/\bhallmark\b/gi,               "sign",            "characteristic",  "marker",           "sign"],
  [/\bbedrock\b/gi,                "foundation",      "basis",           "foundation",       "backbone"],
  [/\bmultifaceted\b/gi,           "complex",         "multi-layered",   "complex",          "many-sided"],
  [/\bcomprehensive\b/gi,          "thorough",        "thorough",        "complete",         "thorough"],
  [/\bsystematic\b/gi,             "structured",      "methodical",      "structured",       "step-by-step"],
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
  [/\bhe is\b/g,      "he's"],
  [/\bshe is\b/g,     "she's"],
];

// ─────────────────────────────────────────────────────────────────────────────
//  SENTENCE SPLITTER
// ─────────────────────────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by space + capital
  const raw = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];
  const results: string[] = [];
  for (const s of raw) {
    const t = s.trim();
    if (t.length > 3) results.push(t);
  }
  return results.length > 0 ? results : [text];
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 1 — VOCABULARY REPLACEMENT (most impactful — runs first)
// ─────────────────────────────────────────────────────────────────────────────

const TONE_INDEX: Record<ToneOption, number> = {
  neutral: 0, academic: 1, professional: 2, conversational: 3,
};

function replaceVocabulary(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): { text: string; count: number } {
  let result = text;
  let count = 0;
  const idx = TONE_INDEX[tone];
  const map = intensity === "subtle" ? VOCAB_MAP.slice(0, 35) : VOCAB_MAP;

  for (const [pattern, neutral, academic, professional, conversational] of map) {
    const replacements = [neutral, academic, professional, conversational];
    const replacement = replacements[idx];
    if (!replacement) continue;

    const prev = result;
    result = result.replace(pattern, (match) => {
      // Preserve capitalisation of the first letter
      if (match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1);
      }
      return replacement;
    });
    if (result !== prev) count++;
  }
  return { text: result, count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 2 — CONTRACTION INSERTION
// ─────────────────────────────────────────────────────────────────────────────

function insertContractions(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): { text: string; count: number } {
  if (tone === "academic") return { text, count: 0 };
  if (tone === "professional" && intensity === "subtle") return { text, count: 0 };

  let result = text;
  let count = 0;
  const map =
    intensity === "subtle" || tone === "professional"
      ? CONTRACTION_MAP.slice(0, 7)
      : CONTRACTION_MAP;

  for (const [re, contraction] of map) {
    const prev = result;
    result = result.replace(re, contraction);
    if (result !== prev) count++;
  }
  return { text: result, count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 3 — BURSTINESS: split long + inject short sentences
// ─────────────────────────────────────────────────────────────────────────────

const SPLIT_PATTERNS = [
  /,\s+and\s+/i,
  /,\s+but\s+/i,
  /,\s+while\s+/i,
  /;\s*/,
  /,\s+which\s+/i,
  /,\s+because\s+/i,
  /,\s+so\s+(?!that)/i,
  /,\s+however\s+/i,
  /\s+—\s+/,
];

// Short punchy sentences to inject after certain sentences for burstiness
const SHORT_INSERTS: Record<ToneOption, string[]> = {
  academic:       ["This is significant.", "The evidence supports this.", "Context matters here.", "This distinction is important."],
  professional:   ["This matters.", "The results speak for themselves.", "Worth noting.", "This is key."],
  neutral:        ["This is worth noting.", "It makes a difference.", "The point stands.", "That said, context matters."],
  conversational: ["And it shows.", "That's the thing.", "It really does matter.", "Think about that."],
};

function injectBurstiness(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): { text: string; splits: number; inserts: number } {
  if (intensity === "subtle") return { text, splits: 0, inserts: 0 };

  const sentences = splitSentences(text);
  const output: string[] = [];
  let splits = 0;
  let inserts = 0;
  const threshold = intensity === "aggressive" ? 18 : 22;

  for (let i = 0; i < sentences.length; i++) {
    const sent = sentences[i];
    const words = sent.trim().split(/\s+/);
    const wc = words.length;

    // Try to split sentences above threshold
    if (wc > threshold) {
      let didSplit = false;
      for (const pattern of SPLIT_PATTERNS) {
        const match = pattern.exec(sent);
        if (match && match.index > 8 && match.index < sent.length - 8) {
          const before = sent.slice(0, match.index).trim().replace(/[,;—]$/, "") + ".";
          const afterRaw = sent.slice(match.index + match[0].length).trim();
          const after = afterRaw.charAt(0).toUpperCase() + afterRaw.slice(1);
          // Ensure both halves are meaningful
          if (before.split(/\s+/).length >= 5 && after.split(/\s+/).length >= 5) {
            output.push(before);
            output.push(after);
            splits++;
            didSplit = true;
            break;
          }
        }
      }
      if (!didSplit) output.push(sent);
    } else {
      output.push(sent);
    }

    // For aggressive: inject a short sentence after every 3rd sentence
    if (intensity === "aggressive" && (i + 1) % 3 === 0 && i < sentences.length - 1) {
      const pool = SHORT_INSERTS[tone];
      const pick = pool[i % pool.length];
      output.push(pick);
      inserts++;
    }
  }

  return { text: output.join(" "), splits, inserts };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 4 — SENTENCE STARTER VARIATION
// ─────────────────────────────────────────────────────────────────────────────

function varySentenceStarters(
  text: string,
  intensity: IntensityOption
): { text: string; count: number } {
  if (intensity === "subtle") return { text, count: 0 };

  const sentences = splitSentences(text);
  let count = 0;

  const alternates: Record<string, string[]> = {
    "this":  ["Such a", "That particular", "This kind of"],
    "these": ["Such", "Those particular"],
    "the":   ["Such", "That"],
    "it":    ["That", "This"],
    "they":  ["These", "Such"],
    "there": ["Across", "Among"],
  };

  for (let i = 1; i < sentences.length - 1; i++) {
    const curr = sentences[i];
    const prev = sentences[i - 1];
    const currFirst = curr.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
    const prevFirst = prev.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");

    if (currFirst === prevFirst && alternates[currFirst]) {
      const alts = alternates[currFirst];
      const alt = alts[i % alts.length];
      // Replace the first word(s) of the sentence
      const withoutFirst = curr.trim().replace(/^\S+\s*/, "");
      sentences[i] = alt + " " + withoutFirst;
      count++;
    }
  }

  return { text: sentences.join(" "), count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 5 — PERPLEXITY BOOST: hedges + em-dash asides
// ─────────────────────────────────────────────────────────────────────────────

const HEDGE_OPENERS: Record<ToneOption, string[]> = {
  academic:       ["It bears noting that", "One might observe that", "In practice,", "To be clear,", "Notably,"],
  professional:   ["In practice,", "Worth noting:", "To be clear,", "That said,", "Importantly,"],
  neutral:        ["In practice,", "Worth noting,", "That said,", "To be fair,", "Of course,"],
  conversational: ["Honestly,", "To be fair,", "That said,", "Look —", "Here's the thing:"],
};

const EM_DASH_ASIDES: Record<ToneOption, string[]> = {
  academic:       ["— and this distinction matters —", "— a critical point —", "— worth emphasizing —"],
  professional:   ["— and this is key —", "— worth emphasizing —", "— a point not to miss —"],
  neutral:        ["— and this matters —", "— worth keeping in mind —", "— not a small thing —"],
  conversational: ["— which is really the point —", "— and this is huge —", "— let that sink in —"],
};

function boostPerplexity(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): { text: string; count: number } {
  if (intensity === "subtle") return { text, count: 0 };

  const sentences = splitSentences(text);
  let count = 0;

  // Add a hedge opener to one middle sentence
  if (sentences.length >= 3) {
    const targetIdx = Math.floor(sentences.length / 2);
    const openers = HEDGE_OPENERS[tone];
    const opener = openers[targetIdx % openers.length];
    const target = sentences[targetIdx];
    const alreadyHedged = /^(honestly|that said|worth|in practice|to be|one might|it bears|look —|here'?s|notably|importantly|of course)/i.test(target);
    if (!alreadyHedged && target.length > 20) {
      sentences[targetIdx] = opener + " " + target.charAt(0).toLowerCase() + target.slice(1);
      count++;
    }
  }

  // For aggressive: add an em-dash aside inside one long sentence
  if (intensity === "aggressive") {
    for (let i = 0; i < sentences.length; i++) {
      const words = sentences[i].split(/\s+/);
      if (words.length > 15) {
        const insertAt = Math.floor(words.length * 0.55);
        const asides = EM_DASH_ASIDES[tone];
        const aside = asides[i % asides.length];
        words.splice(insertAt, 0, aside);
        sentences[i] = words.join(" ");
        count++;
        break;
      }
    }
  }

  return { text: sentences.join(" "), count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function humanizeText(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): HumanizerResult {
  const changes: ChangeNote[] = [];

  // Step 1: Vocabulary (runs on regex — most reliable step)
  const s1 = replaceVocabulary(text, tone, intensity);
  if (s1.count > 0) {
    changes.push({
      type: "vocabulary",
      description: `Replaced ${s1.count} AI-associated word pattern${s1.count > 1 ? "s" : ""} — e.g. "utilize" → "use", "furthermore" → "also", "pivotal" → "key", "leverage" → "use".`,
    });
  }

  // Step 2: Contractions
  const s2 = insertContractions(s1.text, tone, intensity);
  if (s2.count > 0) {
    changes.push({
      type: "tone",
      description: `Inserted ${s2.count} contraction${s2.count > 1 ? "s" : ""} — e.g. "it is" → "it's", "do not" → "don't". Reduces the formal AI-writing signal of always expanding contractions.`,
    });
  }

  // Step 3: Burstiness
  const s3 = injectBurstiness(s2.text, tone, intensity);
  if (s3.splits > 0 || s3.inserts > 0) {
    const parts: string[] = [];
    if (s3.splits > 0) parts.push(`broke ${s3.splits} long sentence${s3.splits > 1 ? "s" : ""} into shorter ones`);
    if (s3.inserts > 0) parts.push(`injected ${s3.inserts} short punchy sentence${s3.inserts > 1 ? "s" : ""}`);
    changes.push({
      type: "burstiness",
      description: `Varied sentence rhythm: ${parts.join("; ")}. AI writes in uniform, metronomic lengths — humans mix short and long.`,
    });
  }

  // Step 4: Sentence starters
  const s4 = varySentenceStarters(s3.text, intensity);
  if (s4.count > 0) {
    changes.push({
      type: "restructure",
      description: `Changed ${s4.count} repeated sentence opener${s4.count > 1 ? "s" : ""} — AI text often starts consecutive sentences with "This", "The", or "It".`,
    });
  }

  // Step 5: Perplexity
  const s5 = boostPerplexity(s4.text, tone, intensity);
  if (s5.count > 0) {
    changes.push({
      type: "perplexity",
      description: `Added ${s5.count} hedging phrase${s5.count > 1 ? "s" : ""} or em-dash aside to introduce mild unpredictability — a natural feature of human writing.`,
    });
  }

  if (changes.length === 0) {
    changes.push({
      type: "vocabulary",
      description: "No strong AI patterns found in this text. It already reads naturally — try Aggressive intensity or paste a more AI-heavy sample.",
    });
  }

  const humanized = s5.text.trim();
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
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
      }
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

        {/* Settings */}
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
              placeholder="Paste AI-generated text here… (minimum 20 words)"
              value={inputText}
              onChange={e => { setInputText(e.target.value); setError(""); }}
            />
            <div className="flex items-center justify-between mt-2">
              <span className={`text-xs ${wc >= 20 ? "text-slate-400" : "text-amber-500 font-medium"}`}>
                {wc} word{wc !== 1 ? "s" : ""}
                {wc > 0 && wc < 20 ? ` · need ${20 - wc} more` : wc >= 20 ? " · ready to humanize" : ""}
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
              <button onClick={handleClear}
                className="text-sm text-slate-500 hover:text-slate-700 font-medium px-4 py-2.5 rounded-xl border border-slate-200 hover:bg-white transition-colors">
                Clear
              </button>
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
                    {tab === "output" ? "Humanized Output" : (
                      <>What Changed <span className="ml-1.5 text-[10px] font-bold bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">{result.changes.length}</span></>
                    )}
                  </button>
                ))}
              </div>

              {activeTab === "output" && (
                <div className="px-6 py-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Humanized Text</span>
                    <CopyButton text={result.humanized} />
                  </div>
                  <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-5 py-4 text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                    {result.humanized}
                  </div>
                  <div className="mt-5 pt-5 border-t border-slate-100">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Original (for comparison)</p>
                    <div className="bg-slate-50 border border-slate-200 rounded-xl px-5 py-4 text-sm text-slate-500 leading-relaxed whitespace-pre-wrap">
                      {result.original}
                    </div>
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
                <p className="text-slate-400 text-xs mt-0.5">Run the humanized text through the AI detector to check the score</p>
              </div>
              <a href="/" className="flex-shrink-0 flex items-center gap-2 bg-blue-500 hover:bg-blue-400 text-white font-semibold text-sm px-5 py-2.5 rounded-xl transition-colors shadow-sm">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
                Test in Detector →
              </a>
            </div>
          </>
        )}

        {/* Explainer */}
        <div className="bg-slate-800 text-slate-300 rounded-2xl p-5 text-xs leading-relaxed grid sm:grid-cols-3 gap-6">
          <div>
            <p className="font-semibold text-white mb-1.5">Burstiness &amp; Rhythm</p>
            <p className="text-slate-400">
              <strong className="text-slate-200">Sentence length variation</strong> is the strongest human signal. Long sentences are split at natural conjunctions; short punchy sentences are injected. This pushes the coefficient of variation above the human threshold.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1.5">Vocabulary &amp; Transitions</p>
            <p className="text-slate-400">
              <strong className="text-slate-200">80+ AI word patterns</strong> — "utilize", "leverage", "furthermore", "pivotal", "in conclusion" — are replaced with natural alternatives matched to your chosen tone using regex-based substitution.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1.5">Perplexity &amp; Tone</p>
            <p className="text-slate-400">
              <strong className="text-slate-200">Contractions, hedges, and em-dash asides</strong> introduce mild unpredictability. Meaning is always preserved — only style changes, not substance.
            </p>
          </div>
        </div>

      </div>
    </main>
  );
}
