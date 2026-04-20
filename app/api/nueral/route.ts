import { NextRequest, NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
//  /api/neural  — Hybrid Gate Engine (Gemini 2.5 Flash, free tier)
//
//  This endpoint is called ONLY when Engines A+B produce an ambiguous
//  combined score (30–70%). It uses Google's free Gemini 2.5 Flash API
//  to provide a second-opinion LLM judgment, helping to resolve borderline
//  cases — particularly formal academic writing vs. AI-generated text.
//
//  Free tier limits (as of April 2026):
//    - 500 requests/day
//    - No credit card required
//    - Get key at: https://aistudio.google.com
//
//  Environment variable required:
//    GEMINI_API_KEY=your_key_from_aistudio
//
//  Response shape (consumed by runNeuralEngine fallback or hybrid gate):
//  {
//    internalScore: number,      // 0-100 AI likelihood
//    confidence: string,         // low | medium | high
//    verdict: string,            // Human-Written | Needs Human Review | AI-Generated
//    reasoning: string,          // one-sentence explanation
//    signals: string[],          // key signals detected
//  }
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-2.5-flash";

export async function POST(req: NextRequest) {
  const { text, engineAScore, engineBScore, engineAStrength, engineBStrength } =
    await req.json();

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured. Get a free key at aistudio.google.com" },
      { status: 500 }
    );
  }

  if (!text || text.trim().length < 50) {
    return NextResponse.json({ error: "Text too short" }, { status: 400 });
  }

  // Truncate to keep within token budget (Gemini Flash is generous but be safe)
  const analysisText = text.trim().split(/\s+/).slice(0, 1000).join(" ");

  const prompt = `You are an expert AI content detector providing a second-opinion judgment on a borderline text.

Two rule-based heuristic engines have already analyzed this text:
- Engine A (Perplexity & Stylometry): internalScore=${engineAScore ?? "N/A"}/100, strength=${engineAStrength ?? "N/A"}
- Engine B (Burstiness & Cognitive Markers): internalScore=${engineBScore ?? "N/A"}/100, strength=${engineBStrength ?? "N/A"}

The combined score is ambiguous (in the 30-70% range), meaning the text could be either formal human writing or AI-generated text. Your job is to resolve this ambiguity using deeper contextual judgment.

Analyze the text below for:
1. Token-level predictability — does every word feel like the statistically "safe" choice?
2. Register consistency — is the tone unnaturally uniform throughout, or does it shift naturally?
3. Personal voice — are there any genuine first-person markers, specific memories, or idiosyncratic opinions?
4. Structural formulas — does the text follow a rigid AI essay template (intro → points → ethics → conclusion)?
5. Semantic repetition — are the same conceptual frames expressed multiple times with different vocabulary?
6. Named grounding — does the text reference specific real people, dates, publications, or places?

Respond with ONLY a valid JSON object, no explanation, no markdown fences:
{
  "aiScore": <integer 0-100>,
  "confidence": "<low|medium|high>",
  "verdict": "<Human-Written|Needs Human Review|AI-Generated>",
  "reasoning": "<one concise sentence explaining the key deciding factor>",
  "signals": ["<signal 1>", "<signal 2>", "<signal 3>"]
}

Rules:
- Use "AI-Generated" only when aiScore >= 70 AND you are confident
- Use "Needs Human Review" for aiScore 35-69 — do not auto-label borderline texts
- Use "Human-Written" only when aiScore < 35 AND clear human signals are present
- Keep "signals" to the 2-3 most diagnostic observations

Text to analyze:
${analysisText}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 300,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("Gemini API error:", err);
      return NextResponse.json(
        { error: `Gemini API error: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    const rawText =
      data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // Strip any accidental markdown fences
    const clean = rawText.replace(/```json|```/gi, "").trim();

    let parsed: any;
    try {
      parsed = JSON.parse(clean);
    } catch {
      // Gemini sometimes wraps in extra text — try to extract JSON
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error(`Failed to parse Gemini response: ${clean.slice(0, 200)}`);
      }
    }

    return NextResponse.json({
      internalScore: Math.max(0, Math.min(100, Math.round(parsed.aiScore ?? 50))),
      confidence: parsed.confidence ?? "low",
      verdict: parsed.verdict ?? "Needs Human Review",
      reasoning: parsed.reasoning ?? "Hybrid gate analysis complete",
      signals: parsed.signals ?? [],
    });
  } catch (err: any) {
    console.error("Hybrid gate error:", err);
    return NextResponse.json(
      { error: err?.message ?? "Hybrid gate analysis failed" },
      { status: 500 }
    );
  }
}