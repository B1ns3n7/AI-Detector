import { NextRequest, NextResponse } from "next/server";

// /api/neural-analyze - Engine C (True Neural Perplexity)
// Calls the Neural Perplexity Service deployed on Hugging Face Spaces.
// Uses GPT-2 (scorer) + GPT-2-medium (reference) via Binoculars method.
// Reference: Hans et al. (2024). Spotting LLMs With Binoculars. ICML 2024.

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  if (!process.env.PERPLEXITY_SERVICE_URL) {
    return NextResponse.json(
      { error: "PERPLEXITY_SERVICE_URL is not configured" },
      { status: 500 }
    );
  }

  const userContent: string = messages?.[0]?.content ?? "";
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
        signal: AbortSignal.timeout(50000),
      }
    );

    if (!serviceRes.ok) {
      const err = await serviceRes.text();
      console.error("[neural-analyze] Service returned error:", err);
      return NextResponse.json(
        { error: `Perplexity service error: ${err}` },
        { status: 503 }
      );
    }

    const scores = await serviceRes.json();
    const text = JSON.stringify(scores);

    return NextResponse.json({
      content: [{ type: "text", text }],
      model_used: "gpt2+gpt2-medium (binoculars)",
      used_fallback: false,
    });

  } catch (e: any) {
    const msg = e?.message ?? "unknown error";
    console.error("[neural-analyze] Perplexity service unreachable:", msg);
    console.error("[neural-analyze] PERPLEXITY_SERVICE_URL:", process.env.PERPLEXITY_SERVICE_URL ?? "NOT SET");
    return NextResponse.json(
      { error: `Perplexity service unreachable: ${msg}` },
      { status: 503 }
    );
  }
}

function extractRawText(content: string): string {
  const marker = "Analyze this text:";
  const idx = content.indexOf(marker);
  if (idx !== -1) {
    return content.slice(idx + marker.length).trim();
  }

  const headMarker = "[DOCUMENT HEAD";
  const headIdx = content.indexOf(headMarker);
  if (headIdx !== -1) {
    return content.slice(headIdx).trim();
  }

  return content.trim();
}