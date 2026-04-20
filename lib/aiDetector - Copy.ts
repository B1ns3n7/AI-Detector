// ─────────────────────────────────────────────────────────────────────────────
//  AI DETECTION ENGINE
//  Methodology mirrors GPTZero (perplexity + burstiness) and
//  Undetectable.ai (stylometric multi-signal fingerprinting).
//  Extended with per-sentence scoring for inline highlighting.
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoredSignal {
  name: string;
  score: number;
  maxScore: number;
  detail: string;
}

export interface SentenceResult {
  text: string;
  aiScore: number;       // 0–100
  label: "ai" | "human" | "mixed";
  signals: string[];     // short reason labels
}

export interface AnalysisResult {
  aiScore: number;
  humanScore: number;
  verdict: "Likely AI-Generated" | "Mixed / Uncertain" | "Likely Human-Written";
  confidence: number;
  signals: ScoredSignal[];
  sentences: SentenceResult[];
  wordCount: number;
  sentenceCount: number;
}

// ─── Vocabulary ───────────────────────────────────────────────────────────────

const COMMON_WORDS = new Set([
  "the","be","to","of","and","a","in","that","have","it","for","not","on","with",
  "he","as","you","do","at","this","but","his","by","from","they","we","say","her",
  "she","or","an","will","my","one","all","would","there","their","what","so","up",
  "out","if","about","who","get","which","go","me","when","make","can","like","time",
  "no","just","him","know","take","people","into","year","your","good","some","could",
  "them","see","other","than","then","now","look","only","come","its","over","think",
  "also","back","after","use","two","how","our","work","first","well","way","even",
  "new","want","because","any","these","give","day","most","us","is","are","was",
  "were","has","had","been","being","does","did","may","might","should","must",
  "shall","each","both","many","such","more","very","here","between","through",
  "during","before","while","where","when","how","why","those","which","who",
]);

const FORMULAIC_BIGRAMS = new Set([
  "in the","of the","to the","and the","for the","on the","at the","by the",
  "with the","from the","it is","this is","there are","that the","of a","in a",
  "as well","such as","as a","in order","in this","can be","may be","are used",
  "is used","is a","has been","have been","based on","refers to","in terms",
  "as well as","in addition","as a result","due to","in order to","with respect",
  "with a","to be","enables the","allows the","provides a","ensures that",
  "is defined","is composed","is designed","is intended","is considered",
]);

// AI signature phrase regexes (Undetectable.ai–style stylometry)
const AI_PHRASE_PATTERNS = [
  /\b(delve into|dive deep|tapestry|nuanced approach|holistic approach)\b/gi,
  /\b(game-changing|paradigm shift|cutting-edge|state-of-the-art)\b/gi,
  /\b(shed light on|pave the way|move the needle|think outside the box)\b/gi,
  /\b(leverage[sd]?|synerg\w+|proactive\w*)\b/gi,
  /\b(it is (crucial|essential|vital|imperative) (to|that))\b/gi,
  /\b(in conclusion,?|to summarize,?|to sum up,?|in summary,?)\b/gi,
  /\b(robust|seamless\w*|streamline\w*|empower\w*|foster\w*)\b/gi,
  /\b(underpins?|underscores?|facilitates?|encompasses?)\b/gi,
  /\b(notably|importantly|significantly|substantially|fundamentally)\b/gi,
  /\b(complementary|correlated|heterogeneous)\b/gi,
  /\b(as an AI|as a language model)\b/gi,
];

// ─── Layer 1: Perplexity proxy (GPTZero-style) ────────────────────────────────

function computePerplexityScore(words: string[]): { score: number; detail: string } {
  if (words.length < 5) return { score: 0, detail: "too short" };

  const uniqueWords = new Set(words);
  const ttr = uniqueWords.size / words.length;
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / words.length;

  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) bigrams.push(`${words[i]} ${words[i + 1]}`);
  const formBigrams = bigrams.filter((b) => FORMULAIC_BIGRAMS.has(b)).length;
  const bigramRate = formBigrams / Math.max(bigrams.length, 1);

  const rareWords = words.filter((w) => !COMMON_WORDS.has(w) && w.length > 3);
  const rareRate = rareWords.length / words.length;

  let pScore = 0;
  pScore += ttr < 0.50 ? 12 : ttr < 0.60 ? 9 : ttr < 0.70 ? 5 : ttr < 0.80 ? 2 : 0;
  pScore += avgWordLen > 7.0 ? 8 : avgWordLen > 6.5 ? 6 : avgWordLen > 6.0 ? 4 : avgWordLen > 5.5 ? 2 : 0;
  pScore += bigramRate > 0.20 ? 8 : bigramRate > 0.14 ? 6 : bigramRate > 0.09 ? 4 : bigramRate > 0.05 ? 2 : 0;
  const technicalUniformity =
    rareRate > 0.45 && ttr < 0.75 ? 7 : rareRate > 0.38 && ttr < 0.80 ? 4 : 1;
  pScore += technicalUniformity;

  return {
    score: Math.min(35, pScore),
    detail: `TTR ${ttr.toFixed(2)}, avg word len ${avgWordLen.toFixed(1)}, formulaic bigrams ${(bigramRate * 100).toFixed(1)}%`,
  };
}

// ─── Layer 2: Burstiness (GPTZero core metric) ────────────────────────────────

function computeBurstinessScore(sentences: string[]): { score: number; detail: string } {
  if (sentences.length < 2) return { score: 10, detail: "single sentence — cannot measure" };

  const sentLengths = sentences.map((s) => s.trim().split(/\s+/).length);
  const avg = sentLengths.reduce((a, b) => a + b, 0) / sentLengths.length;
  const variance =
    sentLengths.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / sentLengths.length;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / Math.max(avg, 1);

  const allLong = avg > 25 ? 6 : avg > 20 ? 3 : 0;
  const hasShort = sentLengths.some((l) => l <= 8);
  const noShortPenalty = !hasShort && sentences.length > 3 ? 5 : 0;
  const cvScore =
    cv < 0.15 ? 24 : cv < 0.20 ? 20 : cv < 0.25 ? 16 : cv < 0.35 ? 10 : cv < 0.45 ? 4 : 0;

  return {
    score: Math.min(35, cvScore + allLong + noShortPenalty),
    detail: `CV ${cv.toFixed(3)} (AI<0.25, Human>0.45), avg ${avg.toFixed(1)} words/sent, stdDev ${stdDev.toFixed(1)}`,
  };
}

// ─── Layer 3: Stylometry (Undetectable.ai–style) ─────────────────────────────

function computeStylometrySignals(
  text: string,
  words: string[],
  sentences: string[],
  hasCitations: boolean
): ScoredSignal[] {
  const wordCount = words.length;
  const sentenceCount = Math.max(sentences.length, 1);
  const signals: ScoredSignal[] = [];

  // S1: AI Signature Phrases
  let phraseMatches = 0;
  const matchedList: string[] = [];
  AI_PHRASE_PATTERNS.forEach((p) => {
    const m = text.match(p);
    if (m) { phraseMatches += m.length; matchedList.push(...m); }
  });
  const phraseRate = phraseMatches / Math.max(wordCount, 1);
  const phraseScore =
    phraseRate > 0.08 ? 15 : phraseRate > 0.05 ? 12 : phraseRate > 0.03 ? 9 :
    phraseRate > 0.01 ? 6 : phraseMatches > 0 ? 3 : 0;
  signals.push({
    name: "AI Signature Phrases",
    score: phraseScore,
    maxScore: 15,
    detail: phraseMatches > 0
      ? `${phraseMatches} match(es): ${matchedList.slice(0, 4).join(", ")}`
      : "No AI phrases detected",
  });

  // S2: Nominalization Density
  const nomMatches = (text.match(/\b\w+(tion|tions|ment|ments|ity|ities|ance|ence|ness)\b/gi) || []).length;
  const nomRate = nomMatches / Math.max(wordCount, 1);
  const nomScore =
    nomRate > 0.14 ? 10 : nomRate > 0.10 ? 7 : nomRate > 0.07 ? 4 : nomRate > 0.04 ? 2 : 0;
  signals.push({
    name: "Nominalization Density",
    score: nomScore,
    maxScore: 10,
    detail: `${nomMatches} nominalizations — ${(nomRate * 100).toFixed(1)}% of words`,
  });

  // S3: Passive Voice
  const passiveMatches = (text.match(/\b(is|are|was|were|be|been|being)\s+\w+ed\b/gi) || []).length;
  const passiveScore = passiveMatches >= 4 ? 8 : passiveMatches >= 2 ? 5 : passiveMatches === 1 ? 2 : 0;
  signals.push({
    name: "Passive Voice",
    score: passiveScore,
    maxScore: 8,
    detail: `${passiveMatches} passive construction(s)`,
  });

  // S4: Parallel Structure
  const parallelSemicolons = (text.match(/;\s*\(\d+\)|;\s*(and|or)\b/gi) || []).length;
  const parallelScore = hasCitations
    ? (parallelSemicolons >= 2 ? 5 : parallelSemicolons === 1 ? 2 : 0)
    : (parallelSemicolons >= 2 ? 10 : parallelSemicolons === 1 ? 4 : 0);
  signals.push({
    name: "Parallel Structure",
    score: parallelScore,
    maxScore: hasCitations ? 5 : 10,
    detail: `${parallelSemicolons} parallel connector(s)${hasCitations ? " (academic — reduced)" : ""}`,
  });

  // S5: Contraction Absence
  const contractionCount = (text.match(/\b\w+'(t|s|re|ve|ll|d|m)\b/gi) || []).length;
  const contractionRate = contractionCount / Math.max(wordCount, 1);
  const contractionScore = hasCitations
    ? (contractionRate < 0.002 ? 3 : 0)
    : (contractionRate < 0.005 ? 10 : contractionRate < 0.015 ? 4 : 0);
  signals.push({
    name: "Contraction Absence",
    score: contractionScore,
    maxScore: hasCitations ? 3 : 10,
    detail: `${contractionCount} contractions found${hasCitations ? " (academic — reduced)" : ""}`,
  });

  // S6: No Rhetorical Questions
  const questionCount = (text.match(/\?/g) || []).length;
  const questionScore = questionCount === 0 && sentenceCount > 4 ? 4 : 0;
  signals.push({
    name: "No Rhetorical Questions",
    score: questionScore,
    maxScore: 4,
    detail: `${questionCount} question mark(s) found`,
  });

  // S7: Human Typography Absent
  const hasEmDash = /—|–/.test(text);
  const hasEllipsis = /\.{3}|…/.test(text);
  const typographyScore = hasCitations
    ? (!hasEllipsis ? 1 : 0)
    : (!hasEmDash ? 4 : 0) + (!hasEllipsis ? 2 : 0);
  signals.push({
    name: "Human Typography Absent",
    score: typographyScore,
    maxScore: hasCitations ? 1 : 6,
    detail: `em-dash: ${hasEmDash ? "✓" : "✗"}, ellipsis: ${hasEllipsis ? "✓" : "✗"}${hasCitations ? " (academic — reduced)" : ""}`,
  });

  // S8: Informal Register Absent
  const informalPatterns = [
    /\b(yeah|yep|nope|gonna|wanna|gotta|kinda|sorta|dunno|lemme)\b/gi,
    /\b(btw|lol|omg|tbh|imo|ngl|fyi)\b/gi,
    /[!]{2,}/,
  ];
  let informalCount = 0;
  informalPatterns.forEach((p) => {
    const m = text.match(p);
    if (m) informalCount += m.length;
  });
  const informalScore = !hasCitations && informalCount === 0 ? 6 : 0;
  signals.push({
    name: "No Informal Register",
    score: informalScore,
    maxScore: 6,
    detail: `${informalCount} informal marker(s)${hasCitations ? " (academic — skipped)" : ""}`,
  });

  return signals;
}

// ─── Per-sentence scoring ─────────────────────────────────────────────────────
// Each sentence is independently scored across signals to produce inline highlights.

function scoreSentence(sent: string, hasCitations: boolean): SentenceResult {
  const words = sent.toLowerCase().match(/\b[a-z]+\b/g) || [];
  const wc = Math.max(words.length, 1);
  const signals: string[] = [];
  let rawScore = 0;
  const maxRaw = 70; // calibrated max for a single sentence

  // Perplexity signals
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / wc;
  if (avgWordLen > 6.5) { rawScore += 12; signals.push("long words"); }
  else if (avgWordLen > 5.8) { rawScore += 6; }

  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) bigrams.push(`${words[i]} ${words[i + 1]}`);
  const formBigramCount = bigrams.filter((b) => FORMULAIC_BIGRAMS.has(b)).length;
  const bigramRate = formBigramCount / Math.max(bigrams.length, 1);
  if (bigramRate > 0.20) { rawScore += 10; signals.push("formulaic phrasing"); }
  else if (bigramRate > 0.10) { rawScore += 5; }

  // AI phrase patterns
  let phraseHits = 0;
  AI_PHRASE_PATTERNS.forEach((p) => {
    const m = sent.match(p);
    if (m) phraseHits += m.length;
  });
  if (phraseHits > 0) {
    rawScore += Math.min(20, phraseHits * 10);
    signals.push("AI signature phrase");
  }

  // Nominalization density
  const nomCount = (sent.match(/\b\w+(tion|tions|ment|ments|ity|ities|ance|ence|ness)\b/gi) || []).length;
  const nomRate = nomCount / wc;
  if (nomRate > 0.15) { rawScore += 10; signals.push("high nominalization"); }
  else if (nomRate > 0.09) { rawScore += 5; }

  // Passive voice
  const passiveCount = (sent.match(/\b(is|are|was|were|be|been|being)\s+\w+ed\b/gi) || []).length;
  if (passiveCount >= 2) { rawScore += 8; signals.push("passive voice"); }
  else if (passiveCount === 1) { rawScore += 4; }

  // Contraction absence (only flag if sentence is long enough)
  if (words.length >= 10) {
    const contractionCount = (sent.match(/\b\w+'(t|s|re|ve|ll|d|m)\b/gi) || []).length;
    if (contractionCount === 0 && !hasCitations) {
      rawScore += 8;
      signals.push("no contractions");
    }
  }

  // Informal markers (presence = human signal; reduce score)
  const hasInformal =
    /\b(yeah|yep|nope|gonna|wanna|kinda|sorta|dunno|lemme|btw|lol|omg|tbh)\b/i.test(sent) ||
    /[!]{2,}/.test(sent);
  if (hasInformal) rawScore = Math.max(0, rawScore - 20);

  // Presence of em-dash or ellipsis = human signal
  if (/—|–|\.{3}|…/.test(sent)) rawScore = Math.max(0, rawScore - 10);

  // Sentence length bonus: very long uniform sentences = AI
  if (words.length > 30) { rawScore += 6; signals.push("very long sentence"); }
  else if (words.length <= 6 && words.length > 0) {
    // Very short sentence = human burst
    rawScore = Math.max(0, rawScore - 15);
  }

  const normalized = Math.min(100, (rawScore / maxRaw) * 100);

  // Calibrate to aiScore
  let aiScore: number;
  if (normalized <= 20) aiScore = (normalized / 20) * 25;
  else if (normalized <= 40) aiScore = 25 + ((normalized - 20) / 20) * 20;
  else if (normalized <= 55) aiScore = 45 + ((normalized - 40) / 15) * 20;
  else if (normalized <= 75) aiScore = 65 + ((normalized - 55) / 20) * 17;
  else aiScore = 82 + Math.min(18, ((normalized - 75) / 25) * 18);

  aiScore = Math.round(Math.min(100, Math.max(0, aiScore)));

  const label: SentenceResult["label"] =
    aiScore >= 68 ? "ai" : aiScore >= 38 ? "mixed" : "human";

  return { text: sent, aiScore, label, signals };
}

// ─── Master analysis function ─────────────────────────────────────────────────

export function analyzeText(text: string): AnalysisResult {
  const rawWords = text.toLowerCase().match(/\b[a-z]+\b/g) || [];
  const wordCount = rawWords.length;
  const hasCitations = /\(\w[^)]*,?\s*\d{4}\)/.test(text);

  // Mask abbreviation periods before splitting to sentences
  const maskedText = text
    .replace(/\bet\s+al\./gi, "et al#")
    .replace(/\b(Fig|Vol|No|pp|ed|eds|cf|vs|ibid|etc)\./gi, (m) => m.replace(".", "#"))
    .replace(/(\(\w[^)]*),?\s*\d{4}\)/g, (m) => m.replace(/\./g, "#"));

  // Split into sentences, preserving original text spans
  const rawSentenceTexts = splitIntoSentences(text, maskedText);
  const sentenceStrings = rawSentenceTexts.map((s) => s.trim()).filter((s) => s.length > 5);

  // Layer 1: Perplexity
  const perplexity = computePerplexityScore(rawWords);
  const perplexitySignal: ScoredSignal = {
    name: "Perplexity (Predictability)",
    score: perplexity.score,
    maxScore: 35,
    detail: perplexity.detail,
  };

  // Layer 2: Burstiness
  const burstiness = computeBurstinessScore(sentenceStrings);
  const burstinessSignal: ScoredSignal = {
    name: "Burstiness (Sentence Variation)",
    score: burstiness.score,
    maxScore: 35,
    detail: burstiness.detail,
  };

  // Layer 3: Stylometry
  const stylometrySignals = computeStylometrySignals(text, rawWords, sentenceStrings, hasCitations);

  const allSignals: ScoredSignal[] = [perplexitySignal, burstinessSignal, ...stylometrySignals];

  // Aggregate score
  const rawScore = allSignals.reduce((sum, s) => sum + s.score, 0);
  const maxRaw = 126;
  const normalized = Math.min(100, (rawScore / maxRaw) * 100);

  let aiScore: number;
  if (normalized <= 20) aiScore = (normalized / 20) * 25;
  else if (normalized <= 40) aiScore = 25 + ((normalized - 20) / 20) * 20;
  else if (normalized <= 55) aiScore = 45 + ((normalized - 40) / 15) * 20;
  else if (normalized <= 75) aiScore = 65 + ((normalized - 55) / 20) * 17;
  else aiScore = 82 + Math.min(18, ((normalized - 75) / 25) * 18);

  aiScore = Math.round(Math.min(100, Math.max(0, aiScore)));
  const humanScore = 100 - aiScore;

  const verdict =
    aiScore >= 70 ? "Likely AI-Generated" :
    aiScore >= 45 ? "Mixed / Uncertain" :
    "Likely Human-Written";

  const confidence = Math.round(Math.abs(aiScore - 50) * 2);

  // Per-sentence scoring
  const sentences: SentenceResult[] = rawSentenceTexts
    .filter((s) => s.trim().length > 5)
    .map((s) => scoreSentence(s, hasCitations));

  return {
    aiScore,
    humanScore,
    verdict,
    confidence,
    signals: allSignals,
    sentences,
    wordCount,
    sentenceCount: sentences.length,
  };
}

// ─── Sentence splitter preserving original text ───────────────────────────────

function splitIntoSentences(original: string, masked: string): string[] {
  // Find sentence boundaries in the masked text, apply to original
  const results: string[] = [];
  const regex = /[^.!?]*[.!?]+/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = regex.exec(masked)) !== null) {
    const segment = original.slice(match.index, match.index + match[0].length);
    if (segment.trim().length > 5) results.push(segment.trim());
    lastIndex = match.index + match[0].length;
  }

  // Trailing text without terminal punctuation
  const trailing = original.slice(lastIndex).trim();
  if (trailing.length > 5) results.push(trailing);

  return results.length > 0 ? results : [original];
}
