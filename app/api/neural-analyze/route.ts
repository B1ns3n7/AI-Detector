import { NextRequest, NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
//  /api/neural-analyze  — Engine C (True Neural Perplexity)
//  Calls the Neural Perplexity Service deployed on Hugging Face Spaces.
//
//  The service computes REAL token-level perplexity using:
//    - GPT-2           (scorer model)
//    - GPT-2-medium    (reference model — for Binoculars cross-perplexity)
//
//  This replaces the previous LLM-estimation approach (Groq/HF Inference API)
//  with mathematically grounded perplexity computation.
//
//  Reference: Hans et al. (2024). Spotting LLMs With Binoculars. ICML 2024.
//
//  SETUP:
//    1. Deploy perplexity-service/ to Hugging Face Spaces (see README.md)
//    2. Add PERPLEXITY_SERVICE_URL to Vercel environment variables:
//         PERPLEXITY_SERVICE_URL = https://YOUR-HF-USERNAME-neural-perplexity-service.hf.space
//    3. Push — Vercel auto-deploys
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  if (!process.env.PERPLEXITY_SERVICE_URL) {
    return NextResponse.json(
      { error: "PERPLEXITY_SERVICE_URL is not configured" },
      { status: 500 }
    );
  }

  // Extract the raw text from the messages array
  // Engine C passes the text-to-analyze as the user message content
  const userContent: string = messages?.[0]?.content ?? "";

  // Strip any system prompt wrapper if present — we only want the raw text
  // The perplexity service does not use a system prompt
  const textToAnalyze = extractRawText(userContent);

  if (!textToAnalyze || textToAnalyze.length < 50) {
    return NextResponse.json(
      { error: "Text too short for perplexity analysis (minimum 50 characters)" },
      { status: 400 }
    );
  }

  try {
    const serviceRes = await fetch(
      `${process.env.PERPLEXITY_SERVICE_URL}/analyze`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: textToAnalyze,
          max_length: 512,
          include_sentences: true,
        }),
        // Vercel hobby plan: 10s timeout. Pro plan: 60s.
        // Perplexity on CPU takes ~3-8s for 512 tokens — should be fine.
        signal: AbortSignal.timeout(55000),
      }
    );

    if (!serviceRes.ok) {
      const err = await serviceRes.text();
      return NextResponse.json(
        { error: `Perplexity service error: ${err}` },
        { status: 503 }
      );
    }

    const scores = await serviceRes.json();

    // Serialize scores as JSON string — this is what page.tsx expects from
    // Engine C: data.content[0].text parsed as JSON
    const text = JSON.stringify(scores);

    return NextResponse.json({
      content: [{ type: "text", text }],
      model_used: "gpt2+gpt2-medium (binoculars)",
      used_fallback: false,
    });

  } catch (e: any) {
    // Timeout or network error — log details for Vercel function logs
    const msg = e?.message ?? "unknown error";
    console.error("[neural-analyze] Perplexity service error:", msg);
    console.error("[neural-analyze] PERPLEXITY_SERVICE_URL:", process.env.PERPLEXITY_SERVICE_URL ?? "NOT SET");
    return NextResponse.json(
      { error: `Perplexity service unreachable: ${msg}` },
      { status: 503 }
    );
  }
}

/**
 * Extract the raw student text from the user message content.
 * Engine C wraps the text in a prompt — we need just the text portion.
 * Adjust this function if your system prompt format changes.
 */
function extractRawText(content: string): string {
  // USER_PROMPT format from page.tsx runNeuralEngine():
  //   "[optional engine context block]
Analyze this text:

<actual text>"
  //   or for sliding-window: "[DOCUMENT HEAD — first N words]
<text>

[DOCUMENT TAIL...]"
  //
  // We extract only the raw text portion — the perplexity service does not
  // need the engine context block or the "Analyze this text:" instruction.

  // Pattern 1: "Analyze this text:

<text>"  (standard)
  const analyzeMatch = content.match(/Analyze this text:\s*
+([\s\S]+)$/i);
  if (analyzeMatch) {
    return analyzeMatch[1].trim();
  }

  // Pattern 2: sliding-window format starting with [DOCUMENT HEAD...]
  const headMatch = content.match(/\[DOCUMENT HEAD[^\]]*\]\s*
+([\s\S]+)$/i);
  if (headMatch) {
    return headMatch[1].trim();
  }

  // Fallback: return full content
  return content.trim();
}