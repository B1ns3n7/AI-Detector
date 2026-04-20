import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface DetectionRequest {
  text: string;
}

interface ScoredSignal {
  name: string;
  score: number;
  detail: string;
}

// ─────────────────────────────────────────────────────────────
//  LAYER 1 — PERPLEXITY APPROXIMATION  (GPTZero-style)
//  Real perplexity requires a language model. We approximate it
//  via statistical proxies that correlate strongly with LM perplexity:
//  type-token ratio, avg word length, formulaic bigram density,
//  and vocabulary predictability vs. a common-word corpus.
// ─────────────────────────────────────────────────────────────

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
  "during","before","while","where","when","how","why","those","which","who"
]);

// Formulaic bigrams that AI models overuse
const FORMULAIC_BIGRAMS = new Set([
  "in the","of the","to the","and the","for the","on the","at the","by the",
  "with the","from the","it is","this is","there are","that the","of a","in a",
  "as well","such as","as a","in order","in this","can be","may be","are used",
  "is used","is a","has been","have been","based on","refers to","in terms",
  "as well as","in addition","as a result","due to","in order to","with respect",
  "with a","to be","enables the","allows the","provides a","ensures that",
  "is defined","is composed","is designed","is intended","is considered",
]);

function computePerplexityScore(words: string[]): { score: number; detail: string } {
  if (words.length < 10) return { score: 0, detail: "too short" };

  // Type-token ratio: lower = more repetitive = more AI-like
  const uniqueWords = new Set(words);
  const ttr = uniqueWords.size / words.length;

  // Average word length: AI academic text skews longer (>5.8)
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / words.length;

  // Formulaic bigram density
  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) bigrams.push(`${words[i]} ${words[i + 1]}`);
  const formBigrams = bigrams.filter(b => FORMULAIC_BIGRAMS.has(b)).length;
  const bigramRate = formBigrams / Math.max(bigrams.length, 1);

  // Vocabulary richness: ratio of words NOT in common list (AI uses more technical terms uniformly)
  const rareWords = words.filter(w => !COMMON_WORDS.has(w) && w.length > 3);
  const rareRate = rareWords.length / words.length;

  // Combine into a perplexity-proxy score (0–35 points)
  // Low TTR → AI, Long avg word → AI, High bigram rate → AI
  let pScore = 0;

  // TTR contribution (0–12 pts): lower TTR = more AI
  pScore += ttr < 0.50 ? 12 : ttr < 0.60 ? 9 : ttr < 0.70 ? 5 : ttr < 0.80 ? 2 : 0;

  // Avg word length contribution (0–8 pts): longer = more AI (academic)
  pScore += avgWordLen > 7.0 ? 8 : avgWordLen > 6.5 ? 6 : avgWordLen > 6.0 ? 4 : avgWordLen > 5.5 ? 2 : 0;

  // Formulaic bigram contribution (0–8 pts)
  pScore += bigramRate > 0.20 ? 8 : bigramRate > 0.14 ? 6 : bigramRate > 0.09 ? 4 : bigramRate > 0.05 ? 2 : 0;

  // Rare word uniformity (0–7 pts): AI uses consistent technical vocabulary
  // High rare rate + low TTR = AI writes uniform technical prose
  const technicalUniformity = rareRate > 0.45 && ttr < 0.75 ? 7 : rareRate > 0.38 && ttr < 0.80 ? 4 : 1;
  pScore += technicalUniformity;

  return {
    score: Math.min(35, pScore),
    detail: `TTR ${ttr.toFixed(2)}, avg word len ${avgWordLen.toFixed(1)}, formulaic bigrams ${(bigramRate * 100).toFixed(1)}%`,
  };
}

// ─────────────────────────────────────────────────────────────
//  LAYER 2 — BURSTINESS  (GPTZero core metric)
//  Burstiness = coefficient of variation of sentence lengths.
//  AI writes flat, uniform sentences. Humans burst.
//  CV = stdDev / mean. AI: CV < 0.25. Human: CV > 0.45.
// ─────────────────────────────────────────────────────────────

function computeBurstinessScore(sentences: string[]): { score: number; detail: string } {
  if (sentences.length < 2) return { score: 10, detail: "single sentence — cannot measure" };

  const sentLengths = sentences.map(s => s.trim().split(/\s+/).length);
  const avg = sentLengths.reduce((a, b) => a + b, 0) / sentLengths.length;
  const variance = sentLengths.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / sentLengths.length;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / Math.max(avg, 1); // coefficient of variation

  // All long sentences (avg > 25) is an additional AI signal
  const allLong = avg > 25 ? 6 : avg > 20 ? 3 : 0;

  // No short sentences at all (≤8 words) = AI
  const hasShort = sentLengths.some(l => l <= 8);
  const noShortPenalty = !hasShort && sentences.length > 3 ? 5 : 0;

  // CV score (0–24 pts): lower CV = more AI
  const cvScore = cv < 0.15 ? 24 : cv < 0.20 ? 20 : cv < 0.25 ? 16 : cv < 0.35 ? 10 : cv < 0.45 ? 4 : 0;

  return {
    score: Math.min(35, cvScore + allLong + noShortPenalty),
    detail: `CV ${cv.toFixed(3)} (AI<0.25, Human>0.45), avg ${avg.toFixed(1)} words/sent, stdDev ${stdDev.toFixed(1)}`,
  };
}

// ─────────────────────────────────────────────────────────────
//  LAYER 3 — STYLOMETRY  (Undetectable.ai-style multi-signal)
//  Structural, syntactic, and lexical fingerprints of AI writing
// ─────────────────────────────────────────────────────────────

function computeStylometryScore(
  text: string,
  words: string[],
  sentences: string[],
  hasCitations: boolean
): ScoredSignal[] {
  const wordCount = words.length;
  const sentenceCount = Math.max(sentences.length, 1);
  const signals: ScoredSignal[] = [];

  // ── S1: AI Signature Phrases ──
  const aiPhrasePatterns = [
    /\b(delve into|dive deep|tapestry|nuanced approach|holistic approach)\b/gi,
    /\b(game-changing|paradigm shift|cutting-edge|state-of-the-art)\b/gi,
    /\b(shed light on|pave the way|move the needle|think outside the box)\b/gi,
    /\b(leverage[sd]?|synerg\w+|proactive\w*)\b/gi,
    /\b(it is (crucial|essential|vital|imperative) (to|that))\b/gi,
    /\b(in conclusion,?|to summarize,?|to sum up,?|in summary,?)\b/gi,
    /\b(robust\b|seamless\w*|streamline\w*|empower\w*|foster\w*)\b/gi,
    /\b(underpins?|underscores?|facilitates?|encompasses?)\b/gi,
    /\b(notably|importantly|significantly|substantially|fundamentally)\b/gi,
    /\b(complementary|correlated|heterogeneous)\b/gi,
    /\b(as an AI|as a language model)\b/gi,
  ];
  let phraseMatches = 0;
  const matchedList: string[] = [];
  aiPhrasePatterns.forEach(p => {
    const m = text.match(p);
    if (m) { phraseMatches += m.length; matchedList.push(...m); }
  });
  const phraseRate = phraseMatches / wordCount;
  const phraseScore = phraseRate > 0.08 ? 15 : phraseRate > 0.05 ? 12 : phraseRate > 0.03 ? 9 : phraseRate > 0.01 ? 6 : phraseMatches > 0 ? 3 : 0;
  signals.push({
    name: "AI Signature Phrases",
    score: phraseScore,
    detail: `${phraseMatches} match(es): ${matchedList.slice(0, 4).join(", ")}`,
  });

  // ── S2: Nominalization Density ──
  // AI converts verbs to nouns excessively: "integration", "alignment", "performance"
  const nomMatches = (text.match(/\b\w+(tion|tions|ment|ments|ity|ities|ance|ence|ness)\b/gi) || []).length;
  const nomRate = nomMatches / wordCount;
  const nomScore = nomRate > 0.14 ? 10 : nomRate > 0.10 ? 7 : nomRate > 0.07 ? 4 : nomRate > 0.04 ? 2 : 0;
  signals.push({
    name: "Nominalization Density",
    score: nomScore,
    detail: `${nomMatches} nominalizations — ${(nomRate * 100).toFixed(1)}% of words`,
  });

  // ── S3: Passive Voice ──
  const passiveMatches = (text.match(/\b(is|are|was|were|be|been|being)\s+\w+ed\b/gi) || []).length;
  const passiveScore = passiveMatches >= 4 ? 8 : passiveMatches >= 2 ? 5 : passiveMatches === 1 ? 2 : 0;
  signals.push({
    name: "Passive Voice",
    score: passiveScore,
    detail: `${passiveMatches} passive construction(s)`,
  });

  // ── S4: Perfect Parallel Structure ──
  // AI writes textbook-perfect semicolon-separated parallel lists
  const parallelSemicolons = (text.match(/;\s*\(\d+\)|;\s*(and|or)\b/gi) || []).length;
  const parallelScore = hasCitations
    ? (parallelSemicolons >= 2 ? 5 : parallelSemicolons === 1 ? 2 : 0)
    : (parallelSemicolons >= 2 ? 10 : parallelSemicolons === 1 ? 4 : 0);
  signals.push({
    name: "Parallel Structure",
    score: parallelScore,
    detail: `${parallelSemicolons} parallel connector(s)${hasCitations ? " (academic — reduced)" : ""}`,
  });

  // ── S5: Contraction Absence ──
  const contractionCount = (text.match(/\b\w+'(t|s|re|ve|ll|d|m)\b/gi) || []).length;
  const contractionRate = contractionCount / wordCount;
  const contractionScore = hasCitations
    ? (contractionRate < 0.002 ? 3 : 0)
    : (contractionRate < 0.005 ? 10 : contractionRate < 0.015 ? 4 : 0);
  signals.push({
    name: "Contraction Absence",
    score: contractionScore,
    detail: `${contractionCount} contractions${hasCitations ? " (academic — reduced)" : ""}`,
  });

  // ── S6: No Rhetorical Questions ──
  const questionCount = (text.match(/\?/g) || []).length;
  const questionScore = questionCount === 0 && sentenceCount > 4 ? 4 : 0;
  signals.push({
    name: "No Rhetorical Questions",
    score: questionScore,
    detail: `${questionCount} question(s)`,
  });

  // ── S7: Human Typography Absent ──
  const hasEmDash = /—|–/.test(text);
  const hasEllipsis = /\.{3}|…/.test(text);
  const typographyScore = hasCitations
    ? (!hasEllipsis ? 1 : 0)
    : (!hasEmDash ? 4 : 0) + (!hasEllipsis ? 2 : 0);
  signals.push({
    name: "Human Typography Absent",
    score: typographyScore,
    detail: `em-dash: ${hasEmDash}, ellipsis: ${hasEllipsis}${hasCitations ? " (academic — reduced)" : ""}`,
  });

  // ── S8: Informal Register Absent (skip for citations) ──
  const informalPatterns = [
    /\b(yeah|yep|nope|gonna|wanna|gotta|kinda|sorta|dunno|lemme)\b/gi,
    /\b(btw|lol|omg|tbh|imo|ngl|fyi)\b/gi,
    /[!]{2,}/,
  ];
  let informalCount = 0;
  informalPatterns.forEach(p => { const m = text.match(p); if (m) informalCount += m.length; });
  const informalScore = !hasCitations && informalCount === 0 ? 6 : 0;
  signals.push({
    name: "No Informal Register",
    score: informalScore,
    detail: `${informalCount} informal marker(s)${hasCitations ? " (academic — skipped)" : ""}`,
  });

  return signals;
}

// ─────────────────────────────────────────────────────────────
//  MAIN ANALYSIS
// ─────────────────────────────────────────────────────────────

function analyzeAIContent(text: string): {
  aiScore: number;
  humanScore: number;
  signals: ScoredSignal[];
} {
  const rawWords = text.toLowerCase().match(/\b[a-z]+\b/g) || [];
  const wordCount = rawWords.length;

  const hasCitations = /\(\w[^)]*,?\s*\d{4}\)/.test(text);

  // Mask citation periods before sentence splitting
  const maskedText = text
    .replace(/\bet\s+al\./gi, "et al#")
    .replace(/\b(Fig|Vol|No|pp|ed|eds|cf|vs|ibid|etc)\./gi, m => m.replace(".", "#"))
    .replace(/(\(\w[^)]*),?\s*\d{4}\)/g, m => m.replace(/\./g, "#"));
  const sentences = maskedText.split(/[.!?]+/).filter(s => s.trim().length > 5);

  // ── Layer 1: Perplexity proxy ──
  const perplexity = computePerplexityScore(rawWords);
  const perplexitySignal: ScoredSignal = {
    name: "Perplexity (Predictability)",
    score: perplexity.score,
    detail: perplexity.detail,
  };

  // ── Layer 2: Burstiness ──
  const burstiness = computeBurstinessScore(sentences);
  const burstinessSignal: ScoredSignal = {
    name: "Burstiness (Sentence Variation)",
    score: burstiness.score,
    detail: burstiness.detail,
  };

  // ── Layer 3: Stylometry ──
  const stylometrySignals = computeStylometryScore(text, rawWords, sentences, hasCitations);

  const allSignals: ScoredSignal[] = [perplexitySignal, burstinessSignal, ...stylometrySignals];

  // ── Weighted aggregate ──
  // Layer 1 (perplexity) max = 35, weight = 35%
  // Layer 2 (burstiness) max = 35, weight = 35%
  // Layer 3 (stylometry) max = ~56, weight = 30%
  // Total max raw ≈ 126

  const rawScore = allSignals.reduce((sum, s) => sum + s.score, 0);
  const maxRaw = 126;
  const normalized = Math.min(100, (rawScore / maxRaw) * 100);

  // Calibration curve — tuned so:
  //  normalized 0–20  → aiScore 0–25   (clearly human)
  //  normalized 20–40 → aiScore 25–45  (leaning human)
  //  normalized 40–55 → aiScore 45–65  (mixed/uncertain)
  //  normalized 55–75 → aiScore 65–82  (leaning AI)
  //  normalized 75+   → aiScore 82–100 (clearly AI)
  let aiScore: number;
  if (normalized <= 20) {
    aiScore = (normalized / 20) * 25;
  } else if (normalized <= 40) {
    aiScore = 25 + ((normalized - 20) / 20) * 20;
  } else if (normalized <= 55) {
    aiScore = 45 + ((normalized - 40) / 15) * 20;
  } else if (normalized <= 75) {
    aiScore = 65 + ((normalized - 55) / 20) * 17;
  } else {
    aiScore = 82 + Math.min(18, ((normalized - 75) / 25) * 18);
  }

  aiScore = Math.round(Math.min(100, Math.max(0, aiScore)));
  const humanScore = 100 - aiScore;

  return { aiScore, humanScore, signals: allSignals };
}

// ─────────────────────────────────────────────────────────────
//  EDGE FUNCTION HANDLER
// ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { text }: DetectionRequest = await req.json();

    if (!text || text.trim().length < 50) {
      return new Response(
        JSON.stringify({ error: "Please enter at least 50 characters for accurate detection." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const wordCount = text.trim().split(/\s+/).length;
    if (wordCount < 20) {
      return new Response(
        JSON.stringify({ error: "Please enter at least 20 words for accurate detection." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { aiScore, humanScore, signals } = analyzeAIContent(text);

    const verdict =
      aiScore >= 70 ? "Likely AI-Generated" :
      aiScore >= 45 ? "Mixed / Uncertain" :
      "Likely Human-Written";

    const confidence = Math.round(Math.abs(aiScore - 50) * 2);

    return new Response(
      JSON.stringify({
        aiScore,
        humanScore,
        analysis: { verdict, confidence, signals },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message || "Failed to analyze text" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
