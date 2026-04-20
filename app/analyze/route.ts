import { NextRequest, NextResponse } from "next/server";
import { analyzeText } from "@/lib/aiDetector";

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();

    if (!text || typeof text !== "string") {
      return NextResponse.json(
        { error: "No text provided." },
        { status: 400 }
      );
    }

    const trimmed = text.trim();

    if (trimmed.length < 50) {
      return NextResponse.json(
        { error: "Please enter at least 50 characters for accurate detection." },
        { status: 400 }
      );
    }

    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount < 20) {
      return NextResponse.json(
        { error: "Please enter at least 20 words for accurate detection." },
        { status: 400 }
      );
    }

    const result = analyzeText(trimmed);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Analysis failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
