import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface DetectionRequest {
  text: string;
}

function analyzeAIContent(text: string): { aiScore: number; humanScore: number } {
  const textLength = text.length;
  const words = text.trim().split(/\s+/);
  const wordCount = words.length;

  let aiScore = 0;

  const aiPatterns = [
    /\b(furthermore|moreover|additionally|consequently|therefore|thus|hence)\b/gi,
    /\b(it is important to note|it's worth noting|notably|significantly)\b/gi,
    /\b(in conclusion|to summarize|in summary|overall)\b/gi,
    /\b(various|numerous|multiple|several)\b/gi,
    /\b(utilize|leverage|facilitate|implement)\b/gi,
  ];

  let patternMatches = 0;
  aiPatterns.forEach(pattern => {
    const matches = text.match(pattern);
    if (matches) {
      patternMatches += matches.length;
    }
  });

  const avgWordLength = words.reduce((sum, word) => sum + word.length, 0) / wordCount;

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const avgSentenceLength = wordCount / sentences.length;

  const uniqueWords = new Set(words.map(w => w.toLowerCase()));
  const lexicalDiversity = uniqueWords.size / wordCount;

  if (avgWordLength > 5.5) aiScore += 15;
  if (avgSentenceLength > 20) aiScore += 20;
  if (lexicalDiversity < 0.5) aiScore += 15;
  if (patternMatches > wordCount * 0.02) aiScore += 25;

  const hasVariedPunctuation = /[;:—–]/.test(text);
  const hasContractions = /\b\w+'\w+\b/.test(text);
  const hasQuestions = /\?/.test(text);

  if (!hasVariedPunctuation) aiScore += 10;
  if (!hasContractions) aiScore += 10;
  if (!hasQuestions && sentences.length > 3) aiScore += 5;

  aiScore = Math.min(100, Math.max(0, aiScore));
  const humanScore = 100 - aiScore;

  return {
    aiScore: Math.round(aiScore),
    humanScore: Math.round(humanScore)
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { text }: DetectionRequest = await req.json();

    if (!text || text.trim().length < 10) {
      return new Response(
        JSON.stringify({
          error: "Text must be at least 10 characters long"
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const { aiScore, humanScore } = analyzeAIContent(text);

    return new Response(
      JSON.stringify({
        aiScore,
        humanScore,
        analysis: {
          verdict: aiScore > 70 ? "Likely AI-Generated" : aiScore > 40 ? "Mixed/Uncertain" : "Likely Human-Written",
          confidence: Math.abs(aiScore - 50) * 2
        }
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error.message || "Failed to analyze text"
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
