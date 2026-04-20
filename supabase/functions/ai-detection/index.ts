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

function analyzeAIContent(text: string): {
  aiScore: number;
  humanScore: number;
  signals: ScoredSignal[];
} {
  const words = text.trim().split(/\s+/);
  const wordCount = words.length;
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 5);
  const sentenceCount = Math.max(sentences.length, 1);
  const sentLengths = sentences.map(s => s.trim().split(/\s+/).length);
  const avgSentLen = sentLengths.reduce((a, b) => a + b, 0) / sentenceCount;
  const signals: ScoredSignal[] = [];

  // Context flags
  const hasCitations = /\(\w[^)]*,?\s*\d{4}\)/.test(text);

  // ─── SIGNAL 1: AI Buzzword & Filler Phrases ───
  const aiPhrases = [
    /\b(delve into|dive deep|tapestry|nuanced approach|multifaceted|holistic approach)\b/gi,
    /\b(in today's (world|society|landscape|era|age))\b/gi,
    /\b(rest assured|needless to say|it goes without saying)\b/gi,
    /\b(game-changing|revolutionary|paradigm shift|cutting-edge|state-of-the-art)\b/gi,
    /\b(first and foremost|last but not least|at the end of the day|when all is said and done)\b/gi,
    /\b(shed light on|pave the way|think outside the box|move the needle)\b/gi,
    /\b(leverage(s|d)?|synerg(y|ies|istic)|proactive(ly)?)\b/gi,
    /\b(as an AI|as a language model|I('m| am) designed to)\b/gi,
    /\b(in conclusion,|to summarize,|to sum up,)\b/gi,
    /\b(it is (crucial|essential|vital|imperative) (to|that))\b/gi,
  ];
  let phraseMatches = 0;
  aiPhrases.forEach(pattern => {
    const m = text.match(pattern);
    if (m) phraseMatches += m.length;
  });
  const phraseRate = phraseMatches / wordCount;
  const phraseScore = phraseRate > 0.04 ? 25 : phraseRate > 0.02 ? 15 : phraseRate > 0.01 ? 8 : phraseRate > 0 ? 3 : 0;
  signals.push({
    name: "AI Buzzword Phrases",
    score: phraseScore,
    detail: `${phraseMatches} match(es) — ${(phraseRate * 100).toFixed(1)}% of words`,
  });

  // ─── SIGNAL 2: Sentence Length Uniformity ───
  // Only meaningful with 3+ sentences — gated to avoid false positives on short text
  const variance = sentLengths.reduce((s, l) => s + Math.pow(l - avgSentLen, 2), 0) / sentenceCount;
  const stdDev = Math.sqrt(variance);
  const uniformityScore = sentenceCount >= 3
    ? (stdDev < 3 ? 22 : stdDev < 6 ? 14 : stdDev < 9 ? 7 : stdDev < 13 ? 2 : 0)
    : 0;
  signals.push({
    name: "Sentence Uniformity",
    score: uniformityScore,
    detail: `${sentenceCount} sentence(s), StdDev ${stdDev.toFixed(1)}${sentenceCount < 3 ? " (too few to score)" : ""}`,
  });

  // ─── SIGNAL 3: Dense Short Text (AI definition/explanation pattern) ───
  // AI often writes compact 1–3 sentence explanations with very long sentences
  // Humans rarely write 20+ word sentences when explaining briefly
  const denseScore = avgSentLen > 18 && sentenceCount <= 3 ? 18
    : avgSentLen > 15 && sentenceCount <= 4 ? 10
    : avgSentLen > 20 && sentenceCount <= 5 ? 6
    : 0;
  signals.push({
    name: "Dense Explanation Pattern",
    score: denseScore,
    detail: `${sentenceCount} sentence(s), avg ${avgSentLen.toFixed(1)} words each`,
  });

  // ─── SIGNAL 4: Technical Jargon Density ───
  // AI packs technical terms densely; humans space them out with more plain language
  const techJargon = /\b(deep learning|machine learning|neural network|transformer|embedding|model|algorithm|dataset|parameter|layer|attention|BERT|GPT|LLM|NLP|artificial intelligence|vector|latent|gradient|prediction|classification|inference|training|modali(ty|ties)|multimodal|unimodal|representation|feature|encoder|decoder)\b/gi;
  const jargonMatches = (text.match(techJargon) || []).length;
  const jargonRate = jargonMatches / wordCount;
  const jargonScore = jargonRate > 0.12 ? 18 : jargonRate > 0.07 ? 10 : jargonRate > 0.03 ? 5 : 0;
  signals.push({
    name: "Technical Jargon Density",
    score: jargonScore,
    detail: `${jargonMatches} technical term(s) — ${(jargonRate * 100).toFixed(1)}% of words`,
  });

  // ─── SIGNAL 5: Contraction Absence ───
  // Scaled by text length — short texts need higher rate to count as human
  const contractionCount = (text.match(/\b\w+'(t|s|re|ve|ll|d|m)\b/gi) || []).length;
  const contractionRate = contractionCount / wordCount;
  const contractionThreshold = wordCount < 80 ? 0.03 : 0.015;
  const contractionScore = hasCitations
    ? (contractionRate < 0.002 ? 4 : 0)
    : (contractionRate < 0.005 ? 12 : contractionRate < contractionThreshold ? 6 : 0);
  signals.push({
    name: "Contraction Absence",
    score: contractionScore,
    detail: `${contractionCount} contraction(s) — ${(contractionRate * 100).toFixed(1)}% of words`,
  });

  // ─── SIGNAL 6: Repetitive Sentence Starters ───
  const starterWords = sentences.map(s => s.trim().split(/\s+/)[0]?.toLowerCase() || "");
  const starterCounts: Record<string, number> = {};
  starterWords.forEach(w => { starterCounts[w] = (starterCounts[w] || 0) + 1; });
  const maxRepeat = Math.max(...Object.values(starterCounts));
  const starterRepeatRate = maxRepeat / sentenceCount;
  const starterScore = sentenceCount >= 3
    ? (starterRepeatRate > 0.5 ? 12 : starterRepeatRate > 0.35 ? 6 : 0)
    : 0;
  signals.push({
    name: "Repetitive Starters",
    score: starterScore,
    detail: `Most repeated opener: ${(starterRepeatRate * 100).toFixed(0)}% of sentences`,
  });

  // ─── SIGNAL 7: Low Burstiness ───
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  let burstiScore = 0;
  if (paragraphs.length > 2) {
    const paraLens = paragraphs.map(p => p.trim().split(/\s+/).length);
    const avgPara = paraLens.reduce((a, b) => a + b, 0) / paraLens.length;
    const paraVariance = paraLens.reduce((s, l) => s + Math.pow(l - avgPara, 2), 0) / paraLens.length;
    const paraStdDev = Math.sqrt(paraVariance);
    burstiScore = paraStdDev < 8 ? 10 : paraStdDev < 15 ? 4 : 0;
  }
  signals.push({
    name: "Low Burstiness",
    score: burstiScore,
    detail: `${paragraphs.length} paragraph(s)`,
  });

  // ─── SIGNAL 8: Overly Formal Register ───
  const informalMarkers = [
    /\b(yeah|yep|nope|gonna|wanna|gotta|kinda|sorta|dunno|lemme|gimme)\b/gi,
    /\b(btw|lol|omg|tbh|imo|smh|ngl|fyi)\b/gi,
    /[!]{2,}/,
  ];
  let informalCount = 0;
  informalMarkers.forEach(p => { const m = text.match(p); if (m) informalCount += m.length; });
  const informalScore = !hasCitations && informalCount === 0 ? 8 : 0;
  signals.push({
    name: "Formal Register",
    score: informalScore,
    detail: `${informalCount} informal marker(s)${hasCitations ? " (academic — skipped)" : ""}`,
  });

  // ─── SIGNAL 9: No Rhetorical Questions ───
  const questionCount = (text.match(/\?/g) || []).length;
  const questionScore = questionCount === 0 && sentenceCount > 5 ? 4 : 0;
  signals.push({
    name: "No Rhetorical Questions",
    score: questionScore,
    detail: `${questionCount} question(s) in ${sentenceCount} sentences`,
  });

  // ─── SIGNAL 10: Enumeration / Structural Lists ───
  const wordListMarkers = (text.match(/\b(first(ly)?|second(ly)?|third(ly)?|finally|lastly)\b/gi) || []).length;
  const numberedInline = (text.match(/\(\d+\)/g) || []).length;
  const listTotal = wordListMarkers + numberedInline;
  const listScore = listTotal >= 3 ? 12 : listTotal >= 2 ? 6 : listTotal === 1 ? 2 : 0;
  signals.push({
    name: "List / Enumeration Heavy",
    score: listScore,
    detail: `${wordListMarkers} word markers + ${numberedInline} inline items`,
  });

  // ─── SIGNAL 11: Human Typography Absent ───
  const hasEmDash = /—|–/.test(text);
  const hasEllipsis = /\.{3}|…/.test(text);
  const hasParentheticals = /\([^)]{10,}\)/.test(text) && !hasCitations;
  const typographyScore = (!hasEmDash ? 4 : 0) + (!hasEllipsis ? 2 : 0) + (!hasParentheticals ? 1 : 0);
  signals.push({
    name: "Human Typography Absent",
    score: typographyScore,
    detail: `em-dash: ${hasEmDash}, ellipsis: ${hasEllipsis}, parentheticals: ${hasParentheticals}`,
  });

  // ─── SIGNAL 12: No Short Sentences ───
  const shortSentences = sentLengths.filter(l => l <= 8).length;
  const shortSentenceRatio = shortSentences / sentenceCount;
  const complexityScore = sentenceCount >= 4
    ? (shortSentenceRatio === 0 ? 8 : shortSentenceRatio < 0.1 ? 4 : 0)
    : 0;
  signals.push({
    name: "No Short Sentences",
    score: complexityScore,
    detail: `${shortSentences} short sentence(s) of ${sentenceCount}`,
  });

  // ─── AGGREGATE & CALIBRATE ───
  const rawScore = signals.reduce((sum, s) => sum + s.score, 0);

  // Calibration:
  // raw  0–10 → aiScore  0–20  (clearly human)
  // raw 10–30 → aiScore 20–40  (leaning human)
  // raw 30–50 → aiScore 40–60  (mixed/uncertain)
  // raw 50–70 → aiScore 60–80  (leaning AI)
  // raw  70+  → aiScore 80–100 (clearly AI)
  let aiScore: number;
  if (rawScore <= 10) {
    aiScore = (rawScore / 10) * 20;
  } else if (rawScore <= 30) {
    aiScore = 20 + ((rawScore - 10) / 20) * 20;
  } else if (rawScore <= 50) {
    aiScore = 40 + ((rawScore - 30) / 20) * 20;
  } else if (rawScore <= 70) {
    aiScore = 60 + ((rawScore - 50) / 20) * 20;
  } else {
    aiScore = 80 + Math.min(20, ((rawScore - 70) / 20) * 20);
  }

  aiScore = Math.round(Math.min(100, Math.max(0, aiScore)));
  const humanScore = 100 - aiScore;

  return { aiScore, humanScore, signals };
}

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
    if (wordCount < 15) {
      return new Response(
        JSON.stringify({ error: "Please enter at least 15 words for accurate detection." }),
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
