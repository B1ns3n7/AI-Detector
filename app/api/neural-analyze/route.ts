import { NextRequest, NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
//  /api/neural-analyze  — Engine C (Neural Perplexity)
//  Uses Groq (free tier, llama-3.3-70b-versatile) to run LLM-based
//  AI detection analysis. Response is normalised to the shape that
//  page.tsx expects: { content: [{ type: "text", text: "..." }] }
//
//  Groq does NOT support logprobs, so this endpoint uses the LLM as a
//  reasoning engine rather than a perplexity scorer. The system prompt
//  instructs it to return structured JSON with per-dimension scores.
//
//  Model fallback order:
//    1. llama-3.3-70b-versatile  (best reasoning, 32K ctx)
//    2. llama3-70b-8192          (fallback if rate-limited)
//    3. mixtral-8x7b-32768       (last resort)
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama3-70b-8192",
  "mixtral-8x7b-32768",
];

export async function POST(req: NextRequest) {
  const { system, messages, max_tokens } = await req.json();

  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not configured" },
      { status: 500 }
    );
  }

  let lastError = "";

  for (const model of GROQ_MODELS) {
    try {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: max_tokens ?? 4000,
          temperature: 0.1,   // low temp for deterministic JSON output
          messages: [
            { role: "system", content: system },
            ...messages,
          ],
        }),
      });

      if (groqRes.status === 429) {
        // Rate limited on this model — try next
        lastError = `${model} rate-limited`;
        continue;
      }

      if (!groqRes.ok) {
        const err = await groqRes.text();
        lastError = `${model}: ${err}`;
        continue;
      }

      const data = await groqRes.json();
      const text = data.choices?.[0]?.message?.content ?? "";

      // Normalise to the shape page.tsx expects:
      // { content: [{ type: "text", text: "..." }] }
      return NextResponse.json({
        content: [{ type: "text", text }],
      });
    } catch (e: any) {
      lastError = `${model}: ${e?.message ?? "unknown error"}`;
      continue;
    }
  }

  // All models failed
  return NextResponse.json(
    { error: `All Groq models failed. Last error: ${lastError}` },
    { status: 503 }
  );
}