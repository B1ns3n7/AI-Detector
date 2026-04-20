import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RephraseRequest {
  text: string;
}

function humanizeText(text: string): string {
  const sentences = text.split(/([.!?]+)/).filter(s => s.trim().length > 0);
  const result: string[] = [];

  const transitions = [
    "But", "And", "So", "Well", "Now", "Also", "Plus", "Then"
  ];

  const fillerPhrases = [
    "I think", "I believe", "In my opinion", "It seems like", "From what I can tell",
    "As far as I know", "To be honest", "Honestly", "Actually", "Basically"
  ];

  const informalReplacements: Record<string, string[]> = {
    "furthermore": ["also", "plus", "and", "besides"],
    "moreover": ["also", "plus", "what's more", "and"],
    "additionally": ["also", "plus", "on top of that"],
    "consequently": ["so", "as a result", "that's why"],
    "therefore": ["so", "that's why", "which means"],
    "thus": ["so", "this way", "like this"],
    "hence": ["so", "that's why"],
    "utilize": ["use", "try", "work with"],
    "leverage": ["use", "take advantage of", "make use of"],
    "facilitate": ["help", "make easier", "enable"],
    "implement": ["use", "add", "put in place", "set up"],
    "various": ["different", "many", "several"],
    "numerous": ["many", "lots of", "plenty of"],
    "multiple": ["many", "several", "a few"],
    "it is important to note": ["note that", "keep in mind", "remember"],
    "it's worth noting": ["worth mentioning", "interesting that", "note that"],
    "in conclusion": ["to wrap up", "in the end", "overall"],
    "to summarize": ["in short", "basically", "so"],
  };

  for (let i = 0; i < sentences.length; i++) {
    let sentence = sentences[i];

    if (sentence.match(/[.!?]/)) {
      result.push(sentence);
      continue;
    }

    for (const [formal, informal] of Object.entries(informalReplacements)) {
      const regex = new RegExp(`\\b${formal}\\b`, "gi");
      if (regex.test(sentence)) {
        const replacement = informal[Math.floor(Math.random() * informal.length)];
        sentence = sentence.replace(regex, replacement);
      }
    }

    if (i > 0 && Math.random() > 0.6) {
      const transition = transitions[Math.floor(Math.random() * transitions.length)];
      sentence = transition + ", " + sentence.charAt(0).toLowerCase() + sentence.slice(1);
    }

    if (Math.random() > 0.7 && i < sentences.length - 2) {
      const filler = fillerPhrases[Math.floor(Math.random() * fillerPhrases.length)];
      sentence = filler + ", " + sentence.charAt(0).toLowerCase() + sentence.slice(1);
    }

    const words = sentence.split(/\s+/);
    if (words.length > 25 && Math.random() > 0.5) {
      const midPoint = Math.floor(words.length / 2);
      sentence = words.slice(0, midPoint).join(" ") + ". " +
                 words[midPoint].charAt(0).toUpperCase() + words[midPoint].slice(1) + " " +
                 words.slice(midPoint + 1).join(" ");
    }

    if (Math.random() > 0.8) {
      sentence = sentence.replace(/\.$/, "!");
    }

    result.push(sentence);
  }

  let finalText = result.join(" ").replace(/\s+([.!?,;:])/g, "$1").replace(/\s+/g, " ");

  if (Math.random() > 0.7) {
    const contractions: Record<string, string> = {
      "do not": "don't",
      "does not": "doesn't",
      "did not": "didn't",
      "is not": "isn't",
      "are not": "aren't",
      "was not": "wasn't",
      "were not": "weren't",
      "have not": "haven't",
      "has not": "hasn't",
      "had not": "hadn't",
      "will not": "won't",
      "would not": "wouldn't",
      "cannot": "can't",
      "could not": "couldn't",
      "should not": "shouldn't",
      "it is": "it's",
      "that is": "that's",
      "there is": "there's",
      "what is": "what's",
    };

    for (const [full, contracted] of Object.entries(contractions)) {
      const regex = new RegExp(`\\b${full}\\b`, "gi");
      finalText = finalText.replace(regex, contracted);
    }
  }

  return finalText.trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { text }: RephraseRequest = await req.json();

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

    const rephrasedText = humanizeText(text);

    return new Response(
      JSON.stringify({
        rephrasedText,
        originalLength: text.length,
        newLength: rephrasedText.length
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
        error: error.message || "Failed to rephrase text"
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
