import { NextRequest, NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
//  /api/neural-analyze  — Engine C (Neural Perplexity)
//  Uses Groq (free tier) to run LLM-based AI detection analysis.
//
//  DETERMINISM FIXES (v4.1):
//    1. temperature: 0     — greedy decoding, same output for same input
//    2. seed: 42           — Groq honours this for extra reproducibility
//    3. top_p: 1           — disable nucleus sampling when temp=0
//    4. model_used         — returned in response so frontend can warn if
//                            a fallback model was used (different models
//                            produce different scores even at temp=0)
//
//  Model fallback order (only used on rate-limit, never on bad output):
//    1. llama-3.3-70b-versatile  (best reasoning, 32K ctx)
//    2. llama3-70b-8192          (fallback if rate-limited)
//    3. mixtral-8x7b-32768       (last resort)
//
//  ⚠ Score consistency guarantee: only holds when the SAME model is used.
//     If a fallback model is used, the response includes model_used so the
//     frontend can surface a "fallback model" warning to the user.
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama3-70b-8192",
  "mixtral-8x7b-32768",
] as const;

const PRIMARY_MODEL = GROQ_MODELS[0];

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

          // ── Determinism settings ──────────────────────────────────────────
          // temperature: 0  → greedy decoding (argmax), no sampling variance.
          // Previously 0.1 which introduced token-level stochasticity.
          temperature: 0,

          // seed: fixed integer → Groq uses this to seed its RNG for any
          // remaining non-determinism (e.g. internal parallelism rounding).
          seed: 42,

          // top_p: 1 → no nucleus sampling cutoff when temperature is 0.
          top_p: 1,
          // ─────────────────────────────────────────────────────────────────

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

      // Return the model actually used so the frontend can warn if it
      // differs from the primary model (different models = different scores).
      const modelUsed = data.model ?? model;
      const usedFallback = modelUsed !== PRIMARY_MODEL;

      return NextResponse.json({
        content: [{ type: "text", text }],
        model_used: modelUsed,
        used_fallback: usedFallback,
      });
    } catch (e: any) {
      lastError = `${model}: ${e?.message ?? "unknown error"}`;
      continue;
    }
  }

  return NextResponse.json(
    { error: `All Groq models failed. Last error: ${lastError}` },
    { status: 503 }
  );
}