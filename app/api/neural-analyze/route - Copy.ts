import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { system, messages, max_tokens } = await req.json();

  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile", // or swap to "mixtral-8x7b-32768" / "llama3-8b-8192"
      max_tokens: max_tokens ?? 4000,
      messages: [
        { role: "system", content: system },
        ...messages,
      ],
    }),
  });

  if (!groqRes.ok) {
    const err = await groqRes.text();
    return NextResponse.json({ error: err }, { status: groqRes.status });
  }

  const data = await groqRes.json();

  // Normalize to the shape page.tsx expects: { content: [{ type: "text", text: "..." }] }
  const text = data.choices?.[0]?.message?.content ?? "";
  return NextResponse.json({ content: [{ type: "text", text }] });
}