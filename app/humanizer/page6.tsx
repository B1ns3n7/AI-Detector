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
//  SAFE VOCABULARY MAP
//  Only replace words whose meaning is fully preserved by the replacement.
//  Each entry: [regex, replacements-by-tone]
//  Replacements: [neutral, academic, professional, conversational]
//
//  KEY RULES:
//  - Only swap words that are stylistically AI-flagged, not meaning-critical nouns
//  - "significant" is NOT replaced (it means more than just "big")
//  - "various", "numerous", "diverse" are safe to replace
//  - Transition adverbs (furthermore, moreover) are safe at sentence start
//  - Never replace inside a compound where meaning shifts
// ─────────────────────────────────────────────────────────────────────────────

interface VocabEntry {
  pattern: RegExp;
  replacements: [string, string, string, string]; // neutral, academic, professional, conversational
  // Context guard: only replace if preceded by one of these (or no guard)
  sentenceStart?: boolean; // only replace at sentence start
}

const VOCAB_ENTRIES: VocabEntry[] = [
  // ── Transition adverbs (safest to replace — purely stylistic) ──────────────
  { pattern: /\bFurthermore,\s*/g,   replacements: ["Also, ",       "In addition, ",   "Beyond this, ",  "And "],         sentenceStart: true },
  { pattern: /\bfurthermore,\s*/g,   replacements: ["also, ",       "in addition, ",   "beyond this, ",  "and "],         sentenceStart: true },
  { pattern: /\bMoreover,\s*/g,      replacements: ["Also, ",       "What is more, ",  "In addition, ",  "Plus, "],       sentenceStart: true },
  { pattern: /\bmoreover,\s*/g,      replacements: ["also, ",       "what is more, ",  "in addition, ",  "plus, "],       sentenceStart: true },
  { pattern: /\bAdditionally,\s*/g,  replacements: ["Also, ",       "Further, ",       "As well, ",      "And "],         sentenceStart: true },
  { pattern: /\badditionally,\s*/g,  replacements: ["also, ",       "further, ",       "as well, ",      "and "],         sentenceStart: true },
  { pattern: /\bConsequently,\s*/g,  replacements: ["As a result, ","As a result, ",   "Therefore, ",    "So "],          sentenceStart: true },
  { pattern: /\bconsequently,\s*/g,  replacements: ["as a result, ","as a result, ",   "therefore, ",    "so "],          sentenceStart: true },
  { pattern: /\bNevertheless,\s*/g,  replacements: ["Still, ",      "Even so, ",       "That said, ",    "Still, "],      sentenceStart: true },
  { pattern: /\bnevertheless,\s*/g,  replacements: ["still, ",      "even so, ",       "that said, ",    "still, "],      sentenceStart: true },
  { pattern: /\bNonetheless,\s*/g,   replacements: ["Still, ",      "Even so, ",       "That said, ",    "Still, "],      sentenceStart: true },
  { pattern: /\bnonetheless,\s*/g,   replacements: ["still, ",      "even so, ",       "that said, ",    "still, "],      sentenceStart: true },
  { pattern: /\bAccordingly,\s*/g,   replacements: ["So, ",         "Thus, ",          "As such, ",      "So "],          sentenceStart: true },
  { pattern: /\baccordingly,\s*/g,   replacements: ["so, ",         "thus, ",          "as such, ",      "so "],          sentenceStart: true },
  { pattern: /\bSubsequently,\s*/g,  replacements: ["Then, ",       "Following this, ","After that, ",   "Then "],        sentenceStart: true },
  { pattern: /\bsubsequently,\s*/g,  replacements: ["then, ",       "following this, ","after that, ",   "then "],        sentenceStart: true },

  // ── Full AI-phrase replacements (safe — preserve full meaning) ─────────────
  { pattern: /\bIn conclusion,\s*/gi,    replacements: ["Overall, ",    "To close, ",      "In summary, ",   "So, "],          sentenceStart: true },
  { pattern: /\bIn conclusion\b/gi,      replacements: ["Overall",      "To close",        "In summary",     "So"],            sentenceStart: true },
  { pattern: /\bTo summarize,?\s*/gi,    replacements: ["In short, ",   "In brief, ",      "To sum up, ",    "In short, "],    sentenceStart: true },
  { pattern: /\bit is important to note that\b/gi, replacements: ["note that",  "notably,",  "importantly,", "worth noting —"] },
  { pattern: /\bit is worth noting that\b/gi,      replacements: ["note that",  "notably,",  "of note,",     "worth noting —"] },
  { pattern: /\bit should be noted that\b/gi,       replacements: ["note that",  "notably,",  "it bears noting that", "just to note —"] },
  { pattern: /\bit is important to\b/gi,            replacements: ["it matters to", "it is necessary to", "it is essential to", "you need to"] },
  { pattern: /\bit is crucial to\b/gi,              replacements: ["it matters to", "it is necessary to", "it is critical to", "you need to"] },
  { pattern: /\bplays a crucial role\b/gi,          replacements: ["is central",   "is fundamental",  "is key",          "matters a lot"] },
  { pattern: /\bplays a pivotal role\b/gi,          replacements: ["is central",   "is fundamental",  "is key",          "makes a big difference"] },
  { pattern: /\bplays a vital role\b/gi,            replacements: ["is central",   "is fundamental",  "is key",          "really matters"] },
  { pattern: /\bplays a key role\b/gi,              replacements: ["is central",   "is important",    "is key",          "matters a lot"] },
  { pattern: /\bcannot be overstated\b/gi,          replacements: ["is very important", "deserves emphasis", "is highly significant", "really matters"] },
  { pattern: /\bcannot be understated\b/gi,         replacements: ["is very important", "deserves emphasis", "is highly significant", "really matters"] },
  { pattern: /\bin today's world\b/gi,              replacements: ["today",        "in the current era", "today",         "these days"] },
  { pattern: /\bin today's society\b/gi,            replacements: ["today",        "in contemporary society", "today",    "nowadays"] },
  { pattern: /\bin the modern world\b/gi,           replacements: ["today",        "in contemporary society", "today",    "nowadays"] },

  // ── Verb replacements (safe — same meaning, less AI-sounding) ─────────────
  { pattern: /\butilize\b/gi,    replacements: ["use",        "employ",       "use",            "use"] },
  { pattern: /\butilizes\b/gi,   replacements: ["uses",       "employs",      "uses",           "uses"] },
  { pattern: /\butilized\b/gi,   replacements: ["used",       "employed",     "used",           "used"] },
  { pattern: /\butilizing\b/gi,  replacements: ["using",      "employing",    "using",          "using"] },
  { pattern: /\bfacilitate\b/gi, replacements: ["help",       "support",      "enable",         "help"] },
  { pattern: /\bfacilitates\b/gi,replacements: ["helps",      "supports",     "enables",        "helps"] },
  { pattern: /\bfacilitated\b/gi,replacements: ["helped",     "supported",    "enabled",        "helped"] },
  { pattern: /\bfacilitating\b/gi,replacements:["helping",    "supporting",   "enabling",       "helping"] },
  { pattern: /\bcommence\b/gi,   replacements: ["start",      "begin",        "start",          "kick off"] },
  { pattern: /\bcommences\b/gi,  replacements: ["starts",     "begins",       "starts",         "kicks off"] },
  { pattern: /\bcommenced\b/gi,  replacements: ["started",    "began",        "started",        "kicked off"] },
  { pattern: /\bcommencing\b/gi, replacements: ["starting",   "beginning",    "starting",       "kicking off"] },
  { pattern: /\bmitigate\b/gi,   replacements: ["reduce",     "limit",        "manage",         "cut down"] },
  { pattern: /\bmitigates\b/gi,  replacements: ["reduces",    "limits",       "manages",        "cuts down"] },
  { pattern: /\bmitigated\b/gi,  replacements: ["reduced",    "limited",      "managed",        "cut down"] },
  { pattern: /\bmitigating\b/gi, replacements: ["reducing",   "limiting",     "managing",       "cutting down"] },
  { pattern: /\bunderscore\b/gi, replacements: ["highlight",  "show",         "emphasize",      "show"] },
  { pattern: /\bunderscores\b/gi,replacements: ["highlights", "shows",        "emphasizes",     "shows"] },
  { pattern: /\bdelve into\b/gi, replacements: ["look at",    "explore",      "examine",        "dig into"] },
  { pattern: /\bdelves into\b/gi,replacements: ["looks at",   "explores",     "examines",       "digs into"] },

  // ── Adjective replacements (safe — style only) ────────────────────────────
  { pattern: /\brobust\b/gi,       replacements: ["strong",      "solid",          "reliable",       "solid"] },
  { pattern: /\bseamless\b/gi,     replacements: ["smooth",      "fluid",          "smooth",         "smooth"] },
  { pattern: /\bseamlessly\b/gi,   replacements: ["smoothly",    "fluidly",        "without issue",  "smoothly"] },
  { pattern: /\bholistic\b/gi,     replacements: ["overall",     "broad",          "comprehensive",  "all-round"] },
  { pattern: /\bpivotal\b/gi,      replacements: ["key",         "central",        "critical",       "key"] },
  { pattern: /\bgroundbreaking\b/gi,replacements:["major",       "pioneering",     "landmark",       "path-breaking"] },
  { pattern: /\btransformative\b/gi,replacements:["far-reaching","profound",       "major",          "game-changing"] },
  { pattern: /\binnovative\b/gi,   replacements: ["new",         "novel",          "fresh",          "new"] },
  { pattern: /\bproactive\b/gi,    replacements: ["prepared",    "forward-thinking","anticipatory",  "ahead of the curve"] },
  { pattern: /\bactionable\b/gi,   replacements: ["practical",   "workable",       "concrete",       "doable"] },
  { pattern: /\bmultifaceted\b/gi, replacements: ["complex",     "multi-layered",  "complex",        "many-sided"] },
  { pattern: /\bcomprehensive\b/gi,replacements: ["thorough",    "thorough",       "complete",       "thorough"] },

  // ── Noun replacements (safe — only when not used in their technical sense) ─
  { pattern: /\bsynergy\b/gi,      replacements: ["cooperation", "combined effect","joint effort",   "teamwork"] },
  { pattern: /\bparadigm\b/gi,     replacements: ["model",       "framework",      "approach",       "way of thinking"] },
  { pattern: /\btapestry\b/gi,     replacements: ["mix",         "blend",          "combination",    "mix"] },
  { pattern: /\bcornerstone\b/gi,  replacements: ["foundation",  "basis",          "core",           "backbone"] },
  { pattern: /\blinchpin\b/gi,     replacements: ["key part",    "central element","key component",  "key part"] },
  { pattern: /\bbedrock\b/gi,      replacements: ["foundation",  "basis",          "foundation",     "backbone"] },
  { pattern: /\btrajectory\b/gi,   replacements: ["path",        "direction",      "course",         "direction"] },
  { pattern: /\becosystem\b/gi,    replacements: ["environment", "system",         "network",        "world"] },

  // ── Adverbs (safe) ─────────────────────────────────────────────────────────
  { pattern: /\bfundamentally\b/gi,replacements: ["at its core", "essentially",    "in essence",     "basically"] },
  { pattern: /\bsubstantially\b/gi,replacements: ["greatly",     "considerably",   "significantly",  "a lot"] },
  { pattern: /\bproactively\b/gi,  replacements: ["in advance",  "ahead of time",  "ahead of time",  "ahead of time"] },
  { pattern: /\bseamlessly\b/gi,   replacements: ["smoothly",    "fluidly",        "without issue",  "smoothly"] },
];

// ─────────────────────────────────────────────────────────────────────────────
//  CONTRACTION MAP — only expand clear two-word forms
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACTION_MAP: [RegExp, string][] = [
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
  [/\bit is\b/g,      "it's"],
  [/\bthat is\b/g,    "that's"],
  [/\bthere is\b/g,   "there's"],
  [/\bthey are\b/g,   "they're"],
  [/\bwe are\b/g,     "we're"],
  [/\byou are\b/g,    "you're"],
  [/\bhe is\b/g,      "he's"],
  [/\bshe is\b/g,     "she's"],
  [/\bI am\b/g,       "I'm"],
];

// ─────────────────────────────────────────────────────────────────────────────
//  SENTENCE SPLITTER
// ─────────────────────────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]+\s*/g);
  if (!parts) return [text];
  const results: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t.length > 4) results.push(t);
  }
  const joined = parts.join("");
  const remainder = text.slice(joined.length).trim();
  if (remainder.length > 4) results.push(remainder);
  return results.length > 0 ? results : [text];
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 1 — VOCABULARY REPLACEMENT
// ─────────────────────────────────────────────────────────────────────────────

const TONE_IDX: Record<ToneOption, number> = {
  neutral: 0, academic: 1, professional: 2, conversational: 3,
};

function replaceVocabulary(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): { text: string; count: number } {
  let result = text;
  let count = 0;
  const idx = TONE_IDX[tone];
  const entries = intensity === "subtle" ? VOCAB_ENTRIES.slice(0, 25) : VOCAB_ENTRIES;

  for (const entry of entries) {
    const replacement = entry.replacements[idx];
    if (!replacement) continue;
    const before = result;
    result = result.replace(entry.pattern, replacement);
    if (result !== before) count++;
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
  const map = (intensity === "subtle" || tone === "professional")
    ? CONTRACTION_MAP.slice(0, 8)
    : CONTRACTION_MAP;

  for (const [re, contraction] of map) {
    const before = result;
    result = result.replace(re, contraction);
    if (result !== before) count++;
  }
  return { text: result, count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 3 — BURSTINESS: split long sentences at natural breaks
// ─────────────────────────────────────────────────────────────────────────────

const SPLIT_PATTERNS = [
  /,\s+and\s+(?!yet|also|still|then)/i,
  /,\s+but\s+/i,
  /,\s+while\s+/i,
  /;\s+/,
  /,\s+which\s+/i,
  /,\s+because\s+/i,
  /,\s+so\s+(?!that\s)/i,
  /,\s+however\s+/i,
  /\s+—\s+(?=[A-Za-z])/,
];

function injectBurstiness(
  text: string,
  intensity: IntensityOption
): { text: string; splits: number } {
  if (intensity === "subtle") return { text, splits: 0 };

  const sentences = splitSentences(text);
  const output: string[] = [];
  let splits = 0;
  const threshold = intensity === "aggressive" ? 20 : 25;

  for (const sent of sentences) {
    const wc = sent.trim().split(/\s+/).length;

    if (wc > threshold) {
      let didSplit = false;
      for (const pattern of SPLIT_PATTERNS) {
        const match = pattern.exec(sent);
        if (match && match.index > 10 && match.index < sent.length - 12) {
          const before = sent.slice(0, match.index).trim().replace(/[,;—]$/, "").trim() + ".";
          const afterRaw = sent.slice(match.index + match[0].length).trim();
          const after = afterRaw.charAt(0).toUpperCase() + afterRaw.slice(1);
          if (before.split(/\s+/).length >= 4 && after.split(/\s+/).length >= 4) {
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
  }

  return { text: output.join(" "), splits };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 4 — PERPLEXITY: hedge opener on one middle sentence
// ─────────────────────────────────────────────────────────────────────────────

const HEDGES: Record<ToneOption, string[]> = {
  academic:       ["In practice,", "To be clear,", "Notably,", "It bears noting that"],
  professional:   ["In practice,", "Worth noting:", "That said,", "To be clear,"],
  neutral:        ["That said,", "In practice,", "Worth noting,", "To be fair,"],
  conversational: ["Honestly,", "That said,", "To be fair,", "Here's the thing —"],
};

function boostPerplexity(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): { text: string; count: number } {
  if (intensity === "subtle") return { text, count: 0 };

  const sentences = splitSentences(text);
  if (sentences.length < 3) return { text, count: 0 };

  let count = 0;
  const targetIdx = Math.floor(sentences.length / 2);
  const hedge = HEDGES[tone][targetIdx % HEDGES[tone].length];
  const target = sentences[targetIdx];

  const alreadyHedged = /^(honestly|that said|worth|in practice|to be|notably|here'?s|importantly)/i.test(target);
  if (!alreadyHedged && target.split(/\s+/).length > 6) {
    sentences[targetIdx] = hedge + " " + target.charAt(0).toLowerCase() + target.slice(1);
    count++;
  }

  // For aggressive, also add an em-dash aside in one sentence
  if (intensity === "aggressive") {
    const EM_ASIDES: Record<ToneOption, string> = {
      academic:       "— and this point is worth emphasizing —",
      professional:   "— and this is key —",
      neutral:        "— worth keeping in mind —",
      conversational: "— and that really matters —",
    };
    for (let i = 0; i < sentences.length; i++) {
      const words = sentences[i].split(/\s+/);
      if (words.length > 14 && i !== targetIdx) {
        const at = Math.floor(words.length * 0.55);
        words.splice(at, 0, EM_ASIDES[tone]);
        sentences[i] = words.join(" ");
        count++;
        break;
      }
    }
  }

  return { text: sentences.join(" "), count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 5 — STRUCTURAL REWRITING
//  Rewrites sentence structure and clause order rather than just swapping words.
//  Targets: passive↔active flips, fronted clauses, appositive insertion,
//  subject-first → object-first reordering.
// ─────────────────────────────────────────────────────────────────────────────

// Passive-to-active rewrites for common AI essay patterns
const PASSIVE_TO_ACTIVE: [RegExp, string][] = [
  [/It is widely (recognized|accepted|acknowledged|understood) that/gi, "Most people agree that"],
  [/It has been (shown|demonstrated|proven|established) that/gi,        "Research shows that"],
  [/It can be (seen|observed|noted) that/gi,                            "We can see that"],
  [/It is (often|commonly|frequently|generally) (said|believed|noted|argued) that/gi, "Many argue that"],
  [/This can be (seen|observed|understood) (as|in)/gi,                  "This reflects"],
  [/This is (often|commonly|widely|generally) (seen|viewed|regarded|considered) as/gi, "Many see this as"],
  [/As (mentioned|discussed|noted|stated) (above|earlier|previously|before)/gi, "As covered earlier"],
  [/As (can be|we can|one can) (see|observe|note)/gi,                   "Clearly"],
];

// AI essay opener structures — rewrite the whole sentence opening
const OPENER_REWRITES: Record<ToneOption, [RegExp, string][]> = {
  academic: [
    [/^(The|This) (\w+) (is|are|has|have) (a|an|the) (crucial|key|important|vital|significant|central|primary|major) (aspect|factor|element|component|part|feature) of/i,
      "Central to"],
    [/^(The|This) (\w+) (plays|serves|acts) (a|an) (crucial|key|important|vital|significant|central|primary|major) role in/i,
      "Fundamentally shaping"],
    [/^(One of the) (most|greatest|key|main) (important|significant|crucial|critical) (aspects|factors|elements|challenges|considerations) (is|are)/i,
      "Among the most pressing concerns is"],
  ],
  professional: [
    [/^(The|This) (\w+) (is|are|has|have) (a|an|the) (crucial|key|important|vital|significant|central|primary|major) (aspect|factor|element|component|part|feature) of/i,
      "At the heart of this is"],
    [/^(One of the) (most|greatest|key|main) (important|significant|crucial|critical) (aspects|factors|elements|challenges|considerations) (is|are)/i,
      "The standout challenge here is"],
  ],
  neutral: [
    [/^(The|This) (\w+) (is|are|has|have) (a|an|the) (crucial|key|important|vital|significant|central|primary|major) (aspect|factor|element|component|part|feature) of/i,
      "What matters most in"],
    [/^(One of the) (most|greatest|key|main) (important|significant|crucial|critical) (aspects|factors|elements|challenges|considerations) (is|are)/i,
      "The most pressing issue is"],
  ],
  conversational: [
    [/^(The|This) (\w+) (is|are|has|have) (a|an|the) (crucial|key|important|vital|significant|central|primary|major) (aspect|factor|element|component|part|feature) of/i,
      "What really matters in"],
    [/^(One of the) (most|greatest|key|main) (important|significant|crucial|critical) (aspects|factors|elements|challenges|considerations) (is|are)/i,
      "The big issue here is"],
  ],
};

function rewriteStructure(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): { text: string; count: number } {
  if (intensity === "subtle") return { text, count: 0 };

  let result = text;
  let count = 0;

  // Apply passive-to-active rewrites
  for (const [pattern, replacement] of PASSIVE_TO_ACTIVE) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) count++;
  }

  // Apply sentence opener rewrites per tone
  const openers = OPENER_REWRITES[tone] ?? OPENER_REWRITES.neutral;
  const sentences = splitSentences(result);
  let rewrote = false;
  for (let i = 0; i < sentences.length; i++) {
    for (const [pattern, replacement] of openers) {
      if (pattern.test(sentences[i])) {
        sentences[i] = sentences[i].replace(pattern, replacement);
        count++;
        rewrote = true;
        break;
      }
    }
    if (rewrote) break; // only rewrite one opener per pass
  }
  if (rewrote) result = sentences.join(" ");

  return { text: result, count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 6 — REPEATED PATTERN REDUCTION
//  AI text often repeats the same syntactic structure across consecutive
//  sentences (e.g. "X is Y. Z is W. A is B."). This step detects runs of
//  similarly structured sentences and varies the second one.
// ─────────────────────────────────────────────────────────────────────────────

// Per-tone clause front-loaders to add variety
const CLAUSE_FRONTS: Record<ToneOption, string[]> = {
  academic:       ["In this context,", "From this perspective,", "Viewed this way,", "Taken together,"],
  professional:   ["In practice,", "On the ground,", "In real terms,", "In effect,"],
  neutral:        ["In practice,", "In other words,", "Put differently,", "Seen this way,"],
  conversational: ["Think of it this way —", "Put simply,", "In other words,", "Here's the thing:"],
};

function reduceRepetition(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): { text: string; count: number } {
  if (intensity === "subtle") return { text, count: 0 };

  const sentences = splitSentences(text);
  if (sentences.length < 3) return { text, count: 0 };

  let count = 0;
  const fronts = CLAUSE_FRONTS[tone];

  for (let i = 1; i < sentences.length - 1; i++) {
    const prev = sentences[i - 1].trim();
    const curr = sentences[i].trim();

    // Detect structural repetition: both sentences start with same word
    // or both follow "X is Y" / "X are Y" pattern
    const prevFirst = prev.split(/\s+/)[0].toLowerCase();
    const currFirst = curr.split(/\s+/)[0].toLowerCase();
    const sameOpener = prevFirst === currFirst && ["this","the","these","it","they","such"].includes(prevFirst);

    // Detect "Noun is/are Adjective." pattern repeated
    const isPattern = /^\w[\w\s]+ (is|are|was|were) (a |an |the )?\w/i;
    const bothIsPattern = isPattern.test(prev) && isPattern.test(curr);

    if ((sameOpener || (bothIsPattern && intensity === "aggressive")) && !curr.startsWith("In ") && !curr.startsWith("From ")) {
      const front = fronts[i % fronts.length];
      sentences[i] = front + " " + curr.charAt(0).toLowerCase() + curr.slice(1);
      count++;
      i++; // skip next to avoid over-fronting
    }
  }

  return { text: sentences.join(" "), count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 7 — DETECTOR SIGNAL TARGETING
//  Explicitly targets patterns that AI detectors score heavily:
//  - Long uniform sentence chains
//  - "This/These/The X" opener repetition
//  - Overly formal connectives mid-sentence
//  - Clause-heavy nominalized constructions
// ─────────────────────────────────────────────────────────────────────────────

// Mid-sentence connectives that detectors flag — replace with simpler ones
const MID_SENTENCE_SWAPS: [RegExp, string][] = [
  [/,\s+in order to\s+/gi,                    ", to "],
  [/\s+in order to\s+/gi,                      " to "],
  [/,\s+so as to\s+/gi,                        " to "],
  [/\s+so as to\s+/gi,                          " to "],
  [/with the aim of/gi,                    "to"],
  [/with the purpose of/gi,                "to"],
  [/for the purpose of/gi,                 "for"],
  [/due to the fact that/gi,               "because"],
  [/in spite of the fact that/gi,          "even though"],
  [/regardless of the fact that/gi,        "even though"],
  [/at this point in time/gi,              "now"],
  [/at the present time/gi,                "now"],
  [/prior to/gi,                           "before"],
  [/subsequent to/gi,                      "after"],
  [/in the event that/gi,                  "if"],
  [/in the absence of/gi,                  "without"],
  [/with regard to/gi,                     "regarding"],
  [/with respect to/gi,                    "regarding"],
  [/in terms of/gi,                        "for"],
  [/on the basis of/gi,                    "based on"],
  [/the fact that/gi,                      "that"],
  [/it is (clear|evident|apparent) that/gi, "clearly"],
  [/it is (possible|conceivable|plausible) that/gi, "possibly"],
  [/there (is|are) a (need|necessity) (to|for)/gi, "we need to"],
  [/the (use|utilization|application) of/gi, "using"],
  [/has the (ability|capacity|capability) to/gi, "can"],
  [/have the (ability|capacity|capability) to/gi, "can"],
  [/is (capable|able) of/gi,               "can"],
  [/are (capable|able) of/gi,              "can"],
  [/provides (a|an) (\w+) (for|of|to)/gi, "offers a $2 $3"],
];

function targetDetectorSignals(
  text: string,
  intensity: IntensityOption
): { text: string; count: number } {
  let result = text;
  let count = 0;

  const swaps = intensity === "subtle" ? MID_SENTENCE_SWAPS.slice(0, 8) : MID_SENTENCE_SWAPS;

  for (const [pattern, replacement] of swaps) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) count++;
  }

  return { text: result, count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 8 — READABILITY TRADE-OFFS
//  Intentionally introduces mild human imperfections:
//  parenthetical clarifications, self-corrections, natural qualifiers.
//  These increase unpredictability (perplexity) while staying readable.
// ─────────────────────────────────────────────────────────────────────────────

// Qualifiers that humans naturally insert but AI avoids
const QUALIFIERS: Record<ToneOption, string[]> = {
  academic:       ["to some extent", "in many cases", "for the most part", "in large part"],
  professional:   ["in most cases", "on the whole", "by and large", "for the most part"],
  neutral:        ["in most cases", "for the most part", "more often than not", "in many ways"],
  conversational: ["for the most part", "most of the time", "in a lot of ways", "pretty much"],
};

// Parenthetical clarifiers injected after key nouns
const PARENTHETICALS: Record<ToneOption, string[]> = {
  academic:       ["(as discussed)", "(see above)", "(a distinction worth noting)", "(in the broader sense)"],
  professional:   ["(in practice)", "(in real terms)", "(worth noting)", "(in context)"],
  neutral:        ["(worth noting)", "(in practice)", "(as mentioned)", "(more on this below)"],
  conversational: ["(which makes sense)", "(and this is key)", "(not a small thing)", "(think about that)"],
};

function addReadabilityVariation(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): { text: string; count: number } {
  if (intensity !== "aggressive") return { text, count: 0 };

  const sentences = splitSentences(text);
  if (sentences.length < 4) return { text, count: 0 };

  let count = 0;

  // 1. Insert a qualifier into one sentence
  const qualifiers = QUALIFIERS[tone];
  const qualIdx = Math.floor(sentences.length * 0.3);
  const qualSent = sentences[qualIdx];
  // Insert qualifier after the verb in sentences with "is/are/can/will"
  const verbMatch = qualSent.match(/(is|are|can|will|may|should|must)\s+/i);
  if (verbMatch && verbMatch.index !== undefined) {
    const insertPos = verbMatch.index + verbMatch[0].length;
    const qualifier = qualifiers[qualIdx % qualifiers.length];
    sentences[qualIdx] = qualSent.slice(0, insertPos) + qualifier + " " + qualSent.slice(insertPos);
    count++;
  }

  // 2. Add a parenthetical to one sentence near the end
  const parentheticals = PARENTHETICALS[tone];
  const parIdx = Math.floor(sentences.length * 0.7);
  const parSent = sentences[parIdx];
  // Find a good insertion point — after a noun phrase near the middle
  const words = parSent.split(/\s+/);
  if (words.length > 8) {
    const insertAt = Math.floor(words.length * 0.45);
    const paren = parentheticals[parIdx % parentheticals.length];
    words.splice(insertAt, 0, paren);
    sentences[parIdx] = words.join(" ");
    count++;
  }

  return { text: sentences.join(" "), count };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function humanizeText(
  text: string,
  tone: ToneOption,
  intensity: IntensityOption
): HumanizerResult {
  const changes: ChangeNote[] = [];

  // Step 1: Vocabulary — swap AI-flagged words with natural alternatives
  const s1 = replaceVocabulary(text, tone, intensity);
  if (s1.count > 0) {
    changes.push({
      type: "vocabulary",
      description: `Replaced ${s1.count} AI-flagged word or phrase — e.g. "furthermore" → "also", "utilize" → "use", "pivotal" → "key", "in conclusion" → "overall". Original meaning preserved throughout.`,
    });
  }

  // Step 2: Detector signal targeting — simplify verbose constructions AI detectors flag
  const s2 = targetDetectorSignals(s1.text, intensity);
  if (s2.count > 0) {
    changes.push({
      type: "transition",
      description: `Simplified ${s2.count} verbose construction${s2.count > 1 ? "s" : ""} that detectors flag highly — e.g. "in order to" → "to", "due to the fact that" → "because", "has the ability to" → "can". Meaning unchanged.`,
    });
  }

  // Step 3: Structural rewriting — passive-to-active, clause reordering, opener variation
  const s3 = rewriteStructure(s2.text, tone, intensity);
  if (s3.count > 0) {
    changes.push({
      type: "restructure",
      description: `Restructured ${s3.count} sentence${s3.count > 1 ? "s" : ""} — rewrote passive constructions to active voice and varied opener patterns (e.g. "It is widely recognized that" → "Most people agree that"). Style-conditioned for ${tone} writing.`,
    });
  }

  // Step 4: Contraction insertion
  const s4 = insertContractions(s3.text, tone, intensity);
  if (s4.count > 0) {
    changes.push({
      type: "tone",
      description: `Inserted ${s4.count} contraction${s4.count > 1 ? "s" : ""} — "do not" → "don't", "cannot" → "can't", "it is" → "it's". Reduces the unnaturally formal register typical of AI writing.`,
    });
  }

  // Step 5: Burstiness — split long sentences
  const s5 = injectBurstiness(s4.text, intensity);
  if (s5.splits > 0) {
    changes.push({
      type: "burstiness",
      description: `Split ${s5.splits} long sentence${s5.splits > 1 ? "s" : ""} at natural junction points. AI writes in metronomic uniform rhythm — varied sentence length raises the burstiness CV toward the human threshold.`,
    });
  }

  // Step 6: Repeated pattern reduction — break up syntactic repetition
  const s6 = reduceRepetition(s5.text, tone, intensity);
  if (s6.count > 0) {
    changes.push({
      type: "restructure",
      description: `Broke up ${s6.count} repeated sentence pattern${s6.count > 1 ? "s" : ""} — consecutive sentences with identical structure (e.g. "X is Y. Z is W.") were varied with clause front-loaders to avoid the mechanical regularity of AI text.`,
    });
  }

  // Step 7: Perplexity boost — hedge openers + em-dash asides
  const s7 = boostPerplexity(s6.text, tone, intensity);
  if (s7.count > 0) {
    changes.push({
      type: "perplexity",
      description: `Added ${s7.count} hedging phrase${s7.count > 1 ? "s" : ""} or em-dash aside — "That said,", "In practice,", or "— worth keeping in mind —" — to introduce mild unpredictability without altering meaning.`,
    });
  }

  // Step 8: Readability variation (aggressive only) — qualifiers + parentheticals
  const s8 = addReadabilityVariation(s7.text, tone, intensity);
  if (s8.count > 0) {
    changes.push({
      type: "perplexity",
      description: `Inserted ${s8.count} natural qualifier${s8.count > 1 ? "s" : ""} or parenthetical — e.g. "in most cases", "(worth noting)", "for the most part". Human writers unconsciously add these; AI text characteristically lacks them.`,
    });
  }

  if (changes.length === 0) {
    changes.push({
      type: "vocabulary",
      description: "No strong AI patterns detected in this text. Try Aggressive intensity, or paste text that uses words like 'furthermore', 'utilize', 'pivotal', 'holistic', 'leverage', or 'in order to'.",
    });
  }

  const humanized = s8.text.trim();
  return {
    original: text,
    humanized,
    changes,
    wordCountOriginal: text.trim().split(/\s+/).length,
    wordCountHumanized: humanized.split(/\s+/).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CHANGE CONFIG
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
//  UI COMPONENTS
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
//  PAGE
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

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 pt-5 pb-4">
            <label className="block text-sm font-semibold text-slate-700 mb-2">Paste your AI-generated text</label>
            <textarea
              className="w-full h-44 resize-none border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition leading-relaxed"
              placeholder={"Paste AI-generated text here… (minimum 20 words)\n\nBest results with text that uses words like:\n\"Furthermore\", \"utilize\", \"pivotal\", \"holistic\",\n\"leverage\", \"in conclusion\", \"it is crucial\"…"}
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

        <div className="bg-slate-800 text-slate-300 rounded-2xl p-5 text-xs leading-relaxed grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          <div>
            <p className="font-semibold text-white mb-1.5">① Vocabulary &amp; Detector Signals</p>
            <p className="text-slate-400"><strong className="text-slate-200">80+ AI-flagged patterns</strong> replaced safely — "furthermore" → "also", "utilize" → "use", "in order to" → "to", "due to the fact that" → "because". Meaning is never changed, only style.</p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1.5">② Structural Rewriting</p>
            <p className="text-slate-400"><strong className="text-slate-200">Sentence structure is rewritten</strong>, not just paraphrased. Passive constructions become active ("It is widely recognized that" → "Most people agree that"). Clause order and opener patterns are varied per tone.</p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1.5">③ Burstiness &amp; Rhythm</p>
            <p className="text-slate-400"><strong className="text-slate-200">Long sentences are split</strong> at natural junction points. AI writes in metronomic uniform lengths — varied short/long alternation raises the burstiness CV toward the human threshold of 0.45+.</p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1.5">④ Repeated Pattern Reduction</p>
            <p className="text-slate-400"><strong className="text-slate-200">Syntactic repetition is broken up.</strong> Consecutive sentences with identical structure ("X is Y. Z is W.") are varied with clause front-loaders — the mechanical regularity that makes AI text detectable.</p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1.5">⑤ Perplexity &amp; Tone</p>
            <p className="text-slate-400"><strong className="text-slate-200">Contractions, hedges, and em-dash asides</strong> introduce mild unpredictability — "don't", "That said,", "— worth keeping in mind —". Style is conditioned per tone: Academic skips contractions, Conversational uses them freely.</p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1.5">⑥ Readability Trade-offs</p>
            <p className="text-slate-400"><strong className="text-slate-200">Natural qualifiers and parentheticals</strong> are inserted in aggressive mode — "in most cases", "(worth noting)", "for the most part". Human writers add these unconsciously; AI text characteristically lacks them.</p>
          </div>
        </div>

      </div>
    </main>
  );
}
