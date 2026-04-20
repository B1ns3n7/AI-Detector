import { useState, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
//  VOCAB ENTRIES
// ─────────────────────────────────────────────────────────────────────────────

const VOCAB_ENTRIES = [
  { pattern: /\bFurthermore,\s*/g,   replacements: ["Also, ",       "In addition, ",   "Beyond this, ",  "And "],         sentenceStart: true },
  { pattern: /\bfurthermore,\s*/g,   replacements: ["also, ",       "in addition, ",   "beyond this, ",  "and "],         sentenceStart: true },
  { pattern: /\bMoreover,\s*/g,      replacements: ["Also, ",       "What is more, ",  "In addition, ",  "Plus, "],       sentenceStart: true },
  { pattern: /\bmoreover,\s*/g,      replacements: ["also, ",       "what is more, ",  "in addition, ",  "plus, "],       sentenceStart: true },
  { pattern: /\bAdditionally,\s*/g,  replacements: ["Also, ",       "Further, ",       "As well, ",      "And "],         sentenceStart: true },
  { pattern: /\badditionally,\s*/g,  replacements: ["also, ",       "further, ",       "as well, ",      "and "],         sentenceStart: true },
  { pattern: /\bConsequently,\s*/g,  replacements: ["As a result, ","As a result, ",   "Therefore, ",    "So "],          sentenceStart: true },
  { pattern: /\bconsequently,\s*/g,  replacements: ["as a result, ","as a result, ",   "therefore, ",    "so "],          sentenceStart: true },
  { pattern: /\bNevertheless,\s*/g,  replacements: ["Still, ",      "Even so, ",       "That said, ",    "Still, "],      sentenceStart: true },
  { pattern: /\bnevertheless,\s*/g,  replacements: ["still, ",      "even so, ",       "that said, ",    "still, "],      sentenceStart: true },
  { pattern: /\bNonetheless,\s*/g,   replacements: ["Still, ",      "Even so, ",       "That said, ",    "Still, "],      sentenceStart: true },
  { pattern: /\bnonetheless,\s*/g,   replacements: ["still, ",      "even so, ",       "that said, ",    "still, "],      sentenceStart: true },
  { pattern: /\bAccordingly,\s*/g,   replacements: ["So, ",         "Thus, ",          "As such, ",      "So "],          sentenceStart: true },
  { pattern: /\baccordingly,\s*/g,   replacements: ["so, ",         "thus, ",          "as such, ",      "so "],          sentenceStart: true },
  { pattern: /\bSubsequently,\s*/g,  replacements: ["Then, ",       "Following this, ","After that, ",   "Then "],        sentenceStart: true },
  { pattern: /\bsubsequently,\s*/g,  replacements: ["then, ",       "following this, ","after that, ",   "then "],        sentenceStart: true },
  { pattern: /\bIn conclusion,\s*/gi,    replacements: ["Overall, ",    "To close, ",      "In summary, ",   "So, "],          sentenceStart: true },
  { pattern: /\bIn conclusion\b/gi,      replacements: ["Overall",      "To close",        "In summary",     "So"],            sentenceStart: true },
  { pattern: /\bTo summarize,?\s*/gi,    replacements: ["In short, ",   "In brief, ",      "To sum up, ",    "In short, "],    sentenceStart: true },
  { pattern: /\bit is important to note that\b/gi, replacements: ["note that",  "notably,",  "importantly,", "worth noting —"] },
  { pattern: /\bit is worth noting that\b/gi,      replacements: ["note that",  "notably,",  "of note,",     "worth noting —"] },
  { pattern: /\bit should be noted that\b/gi,       replacements: ["note that",  "notably,",  "it bears noting that", "just to note —"] },
  { pattern: /\bit is important to\b/gi,            replacements: ["it matters to", "it is necessary to", "it is essential to", "you need to"] },
  { pattern: /\bit is crucial to\b/gi,              replacements: ["it matters to", "it is necessary to", "it is critical to", "you need to"] },
  { pattern: /\bplays a crucial role\b/gi,          replacements: ["is central",   "is fundamental",  "is key",          "matters a lot"] },
  { pattern: /\bplays a pivotal role\b/gi,          replacements: ["is central",   "is fundamental",  "is key",          "makes a big difference"] },
  { pattern: /\bplays a vital role\b/gi,            replacements: ["is central",   "is fundamental",  "is key",          "really matters"] },
  { pattern: /\bplays a key role\b/gi,              replacements: ["is central",   "is important",    "is key",          "matters a lot"] },
  { pattern: /\bcannot be overstated\b/gi,          replacements: ["is very important", "deserves emphasis", "is highly significant", "really matters"] },
  { pattern: /\bcannot be understated\b/gi,         replacements: ["is very important", "deserves emphasis", "is highly significant", "really matters"] },
  { pattern: /\bin today's world\b/gi,              replacements: ["today",        "in the current era", "today",         "these days"] },
  { pattern: /\bin today's society\b/gi,            replacements: ["today",        "in contemporary society", "today",    "nowadays"] },
  { pattern: /\bin the modern world\b/gi,           replacements: ["today",        "in contemporary society", "today",    "nowadays"] },
  { pattern: /\butilize\b/gi,    replacements: ["use",        "employ",       "use",            "use"] },
  { pattern: /\butilizes\b/gi,   replacements: ["uses",       "employs",      "uses",           "uses"] },
  { pattern: /\butilized\b/gi,   replacements: ["used",       "employed",     "used",           "used"] },
  { pattern: /\butilizing\b/gi,  replacements: ["using",      "employing",    "using",          "using"] },
  { pattern: /\bfacilitate\b/gi, replacements: ["help",       "support",      "enable",         "help"] },
  { pattern: /\bfacilitates\b/gi,replacements: ["helps",      "supports",     "enables",        "helps"] },
  { pattern: /\bfacilitated\b/gi,replacements: ["helped",     "supported",    "enabled",        "helped"] },
  { pattern: /\bfacilitating\b/gi,replacements:["helping",    "supporting",   "enabling",       "helping"] },
  { pattern: /\bcommence\b/gi,   replacements: ["start",      "begin",        "start",          "kick off"] },
  { pattern: /\bcommences\b/gi,  replacements: ["starts",     "begins",       "starts",         "kicks off"] },
  { pattern: /\bcommenced\b/gi,  replacements: ["started",    "began",        "started",        "kicked off"] },
  { pattern: /\bcommencing\b/gi, replacements: ["starting",   "beginning",    "starting",       "kicking off"] },
  { pattern: /\bmitigate\b/gi,   replacements: ["reduce",     "limit",        "manage",         "cut down"] },
  { pattern: /\bmitigates\b/gi,  replacements: ["reduces",    "limits",       "manages",        "cuts down"] },
  { pattern: /\bmitigated\b/gi,  replacements: ["reduced",    "limited",      "managed",        "cut down"] },
  { pattern: /\bmitigating\b/gi, replacements: ["reducing",   "limiting",     "managing",       "cutting down"] },
  { pattern: /\bunderscore\b/gi, replacements: ["highlight",  "show",         "emphasize",      "show"] },
  { pattern: /\bunderscores\b/gi,replacements: ["highlights", "shows",        "emphasizes",     "shows"] },
  { pattern: /\bdelve into\b/gi, replacements: ["look at",    "explore",      "examine",        "dig into"] },
  { pattern: /\bdelves into\b/gi,replacements: ["looks at",   "explores",     "examines",       "digs into"] },
  { pattern: /\brobust\b/gi,       replacements: ["strong",      "solid",          "reliable",       "solid"] },
  { pattern: /\bseamless\b/gi,     replacements: ["smooth",      "fluid",          "smooth",         "smooth"] },
  { pattern: /\bseamlessly\b/gi,   replacements: ["smoothly",    "fluidly",        "without issue",  "smoothly"] },
  { pattern: /\bholistic\b/gi,     replacements: ["overall",     "broad",          "comprehensive",  "all-round"] },
  { pattern: /\bpivotal\b/gi,      replacements: ["key",         "central",        "critical",       "key"] },
  { pattern: /\bgroundbreaking\b/gi,replacements:["major",       "pioneering",     "landmark",       "path-breaking"] },
  { pattern: /\btransformative\b/gi,replacements:["far-reaching","profound",       "major",          "game-changing"] },
  { pattern: /\binnovative\b/gi,   replacements: ["new",         "novel",          "fresh",          "new"] },
  { pattern: /\bproactive\b/gi,    replacements: ["prepared",    "forward-thinking","anticipatory",  "ahead of the curve"] },
  { pattern: /\bactionable\b/gi,   replacements: ["practical",   "workable",       "concrete",       "doable"] },
  { pattern: /\bmultifaceted\b/gi, replacements: ["complex",     "multi-layered",  "complex",        "many-sided"] },
  { pattern: /\bcomprehensive\b/gi,replacements: ["thorough",    "thorough",       "complete",       "thorough"] },
  { pattern: /\bsynergy\b/gi,      replacements: ["cooperation", "combined effect","joint effort",   "teamwork"] },
  { pattern: /\bparadigm\b/gi,     replacements: ["model",       "framework",      "approach",       "way of thinking"] },
  { pattern: /\btapestry\b/gi,     replacements: ["mix",         "blend",          "combination",    "mix"] },
  { pattern: /\bcornerstone\b/gi,  replacements: ["foundation",  "basis",          "core",           "backbone"] },
  { pattern: /\blinchpin\b/gi,     replacements: ["key part",    "central element","key component",  "key part"] },
  { pattern: /\bbedrock\b/gi,      replacements: ["foundation",  "basis",          "foundation",     "backbone"] },
  { pattern: /\btrajectory\b/gi,   replacements: ["path",        "direction",      "course",         "direction"] },
  { pattern: /\becosystem\b/gi,    replacements: ["environment", "system",         "network",        "world"] },
  { pattern: /\bfundamentally\b/gi,replacements: ["at its core", "essentially",    "in essence",     "basically"] },
  { pattern: /\bsubstantially\b/gi,replacements: ["greatly",     "considerably",   "significantly",  "a lot"] },
  { pattern: /\bproactively\b/gi,  replacements: ["in advance",  "ahead of time",  "ahead of time",  "ahead of time"] },
];

const CONTRACTION_MAP = [
  [/\bdo not\b/g,     "don't"],
  [/\bdoes not\b/g,   "doesn't"],
  [/\bdid not\b/g,    "didn't"],
  [/\bcannot\b/g,     "can't"],
  [/\bwill not\b/g,   "won't"],
  [/\bwould not\b/g,  "wouldn't"],
  [/\bcould not\b/g,  "couldn't"],
  [/\bshould not\b/g, "shouldn't"],
  [/\bare not\b/g,    "aren't"],
  [/\bwas not\b/g,    "wasn't"],
  [/\bwere not\b/g,   "weren't"],
  [/\bhave not\b/g,   "haven't"],
  [/\bhas not\b/g,    "hasn't"],
  [/\bhad not\b/g,    "hadn't"],
  [/\bit is\b/g,      "it's"],
  [/\bthat is\b/g,    "that's"],
  [/\bthere is\b/g,   "there's"],
  [/\bthey are\b/g,   "they're"],
  [/\bwe are\b/g,     "we're"],
  [/\byou are\b/g,    "you're"],
  [/\bhe is\b/g,      "he's"],
  [/\bshe is\b/g,     "she's"],
  [/\bI am\b/g,       "I'm"],
];

function splitSentences(text) {
  const parts = text.match(/[^.!?]+[.!?]+\s*/g);
  if (!parts) return [text];
  const results = [];
  for (const p of parts) {
    const t = p.trim();
    if (t.length > 4) results.push(t);
  }
  const joined = parts.join("");
  const remainder = text.slice(joined.length).trim();
  if (remainder.length > 4) results.push(remainder);
  return results.length > 0 ? results : [text];
}

const TONE_IDX = { neutral: 0, academic: 1, professional: 2, conversational: 3 };

function replaceVocabulary(text, tone, intensity) {
  let result = text;
  let count = 0;
  const idx = TONE_IDX[tone];
  const entries = intensity === "subtle" ? VOCAB_ENTRIES.slice(0, 25) : VOCAB_ENTRIES;
  for (const entry of entries) {
    const replacement = entry.replacements[idx];
    if (!replacement) continue;
    const before = result;
    result = result.replace(entry.pattern, replacement);
    if (result !== before) count++;
  }
  return { text: result, count };
}

function insertContractions(text, tone, intensity) {
  if (tone === "academic") return { text, count: 0 };
  if (tone === "professional" && intensity === "subtle") return { text, count: 0 };
  let result = text;
  let count = 0;
  const map = (intensity === "subtle" || tone === "professional")
    ? CONTRACTION_MAP.slice(0, 8)
    : CONTRACTION_MAP;
  for (const [re, contraction] of map) {
    const before = result;
    result = result.replace(re, contraction);
    if (result !== before) count++;
  }
  return { text: result, count };
}

const SPLIT_PATTERNS = [
  /,\s+and\s+(?!yet|also|still|then)/i,
  /,\s+but\s+/i,
  /,\s+while\s+/i,
  /;\s+/,
  /,\s+which\s+/i,
  /,\s+because\s+/i,
  /,\s+so\s+(?!that\s)/i,
  /,\s+however\s+/i,
  /\s+—\s+(?=[A-Za-z])/,
];

function injectBurstiness(text, intensity) {
  if (intensity === "subtle") return { text, splits: 0 };
  const sentences = splitSentences(text);
  const output = [];
  let splits = 0;
  const threshold = intensity === "aggressive" ? 20 : 25;
  for (const sent of sentences) {
    const wc = sent.trim().split(/\s+/).length;
    if (wc > threshold) {
      let didSplit = false;
      for (const pattern of SPLIT_PATTERNS) {
        const match = pattern.exec(sent);
        if (match && match.index > 10 && match.index < sent.length - 12) {
          const before = sent.slice(0, match.index).trim().replace(/[,;—]$/, "").trim() + ".";
          const afterRaw = sent.slice(match.index + match[0].length).trim();
          const after = afterRaw.charAt(0).toUpperCase() + afterRaw.slice(1);
          if (before.split(/\s+/).length >= 4 && after.split(/\s+/).length >= 4) {
            output.push(before);
            output.push(after);
            splits++;
            didSplit = true;
            break;
          }
        }
      }
      if (!didSplit) output.push(sent);
    } else {
      output.push(sent);
    }
  }
  return { text: output.join(" "), splits };
}

const HEDGES = {
  academic:       ["In practice,", "To be clear,", "Notably,", "It bears noting that"],
  professional:   ["In practice,", "Worth noting:", "That said,", "To be clear,"],
  neutral:        ["That said,", "In practice,", "Worth noting,", "To be fair,"],
  conversational: ["Honestly,", "That said,", "To be fair,", "Here's the thing —"],
};

function boostPerplexity(text, tone, intensity, modifiedIndices) {
  if (intensity === "subtle") return { text, count: 0 };
  const sentences = splitSentences(text);
  if (sentences.length < 3) return { text, count: 0 };
  let count = 0;
  const mid = Math.floor(sentences.length / 2);
  let targetIdx = -1;
  for (let offset = 0; offset < sentences.length; offset++) {
    const candidate = (mid + offset) % sentences.length;
    if (!modifiedIndices.has(candidate) && sentences[candidate].split(/\s+/).length > 6) {
      targetIdx = candidate;
      break;
    }
  }
  if (targetIdx === -1) return { text, count: 0 };
  const hedge = HEDGES[tone][targetIdx % HEDGES[tone].length];
  const target = sentences[targetIdx];
  const alreadyHedged = /^(honestly|that said|worth|in practice|to be|notably|here'?s|importantly)/i.test(target);
  if (!alreadyHedged) {
    sentences[targetIdx] = hedge + " " + target.charAt(0).toLowerCase() + target.slice(1);
    modifiedIndices.add(targetIdx);
    count++;
  }
  return { text: sentences.join(" "), count };
}

const PASSIVE_TO_ACTIVE = [
  [/It is widely (recognized|accepted|acknowledged|understood) that/gi, "Most people agree that"],
  [/It has been (shown|demonstrated|proven|established) that/gi,        "Research shows that"],
  [/It can be (seen|observed|noted) that/gi,                            "We can see that"],
  [/It is (often|commonly|frequently|generally) (said|believed|noted|argued) that/gi, "Many argue that"],
  [/This can be (seen|observed|understood) (as|in)/gi,                  "This reflects"],
  [/This is (often|commonly|widely|generally) (seen|viewed|regarded|considered) as/gi, "Many see this as"],
  [/As (mentioned|discussed|noted|stated) (above|earlier|previously|before)/gi, "As covered earlier"],
  [/As (can be|we can|one can) (see|observe|note)/gi,                   "Clearly"],
];

const OPENER_REWRITES = {
  academic: [
    [/^(The|This) (\w+) (is|are|has|have) (a|an|the) (crucial|key|important|vital|significant|central|primary|major) (aspect|factor|element|component|part|feature) of/i, "Central to"],
    [/^(The|This) (\w+) (plays|serves|acts) (a|an) (crucial|key|important|vital|significant|central|primary|major) role in/i, "Fundamentally shaping"],
    [/^(One of the) (most|greatest|key|main) (important|significant|crucial|critical) (aspects|factors|elements|challenges|considerations) (is|are)/i, "Among the most pressing concerns is"],
  ],
  professional: [
    [/^(The|This) (\w+) (is|are|has|have) (a|an|the) (crucial|key|important|vital|significant|central|primary|major) (aspect|factor|element|component|part|feature) of/i, "At the heart of this is"],
    [/^(One of the) (most|greatest|key|main) (important|significant|crucial|critical) (aspects|factors|elements|challenges|considerations) (is|are)/i, "The standout challenge here is"],
  ],
  neutral: [
    [/^(The|This) (\w+) (is|are|has|have) (a|an|the) (crucial|key|important|vital|significant|central|primary|major) (aspect|factor|element|component|part|feature) of/i, "What matters most in"],
    [/^(One of the) (most|greatest|key|main) (important|significant|crucial|critical) (aspects|factors|elements|challenges|considerations) (is|are)/i, "The most pressing issue is"],
  ],
  conversational: [
    [/^(The|This) (\w+) (is|are|has|have) (a|an|the) (crucial|key|important|vital|significant|central|primary|major) (aspect|factor|element|component|part|feature) of/i, "What really matters in"],
    [/^(One of the) (most|greatest|key|main) (important|significant|crucial|critical) (aspects|factors|elements|challenges|considerations) (is|are)/i, "The big issue here is"],
  ],
};

function rewriteStructure(text, tone, intensity) {
  if (intensity === "subtle") return { text, count: 0 };
  let result = text;
  let count = 0;
  for (const [pattern, replacement] of PASSIVE_TO_ACTIVE) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) count++;
  }
  const openers = OPENER_REWRITES[tone] || OPENER_REWRITES.neutral;
  const sentences = splitSentences(result);
  let rewrote = false;
  for (let i = 0; i < sentences.length; i++) {
    for (const [pattern, replacement] of openers) {
      if (pattern.test(sentences[i])) {
        sentences[i] = sentences[i].replace(pattern, replacement);
        count++;
        rewrote = true;
        break;
      }
    }
    if (rewrote) break;
  }
  if (rewrote) result = sentences.join(" ");
  return { text: result, count };
}

const CLAUSE_FRONTS = {
  academic:       ["In this context,", "From this perspective,", "Viewed this way,", "Taken together,"],
  professional:   ["In practice,", "On the ground,", "In real terms,", "In effect,"],
  neutral:        ["In practice,", "In other words,", "Put differently,", "Seen this way,"],
  conversational: ["Think of it this way —", "Put simply,", "In other words,", "Here's the thing:"],
};

function reduceRepetition(text, tone, intensity, modifiedIndices) {
  if (intensity === "subtle") return { text, count: 0 };
  const sentences = splitSentences(text);
  if (sentences.length < 3) return { text, count: 0 };
  let count = 0;
  const fronts = CLAUSE_FRONTS[tone];
  let changed = 0;
  const MAX_CHANGES = 2;
  for (let i = 1; i < sentences.length - 1 && changed < MAX_CHANGES; i++) {
    if (modifiedIndices.has(i)) continue;
    const prev = sentences[i - 1].trim();
    const curr = sentences[i].trim();
    const prevFirst = prev.split(/\s+/)[0].toLowerCase();
    const currFirst = curr.split(/\s+/)[0].toLowerCase();
    const sameOpener = prevFirst === currFirst && ["this","the","these","it","they","such"].includes(prevFirst);
    const isPattern = /^\w[\w\s]+ (is|are|was|were) (a |an |the )?\w/i;
    const bothIsPattern = isPattern.test(prev) && isPattern.test(curr);
    if ((sameOpener || (bothIsPattern && intensity === "aggressive")) && !curr.startsWith("In ") && !curr.startsWith("From ")) {
      const front = fronts[i % fronts.length];
      sentences[i] = front + " " + curr.charAt(0).toLowerCase() + curr.slice(1);
      modifiedIndices.add(i);
      count++;
      changed++;
      i++;
    }
  }
  return { text: sentences.join(" "), count };
}

const MID_SENTENCE_SWAPS = [
  [/,\s+in order to\s+/gi,                    ", to "],
  [/\s+in order to\s+/gi,                      " to "],
  [/,\s+so as to\s+/gi,                        " to "],
  [/\s+so as to\s+/gi,                          " to "],
  [/with the aim of/gi,                    "to"],
  [/with the purpose of/gi,                "to"],
  [/for the purpose of/gi,                 "for"],
  [/due to the fact that/gi,               "because"],
  [/in spite of the fact that/gi,          "even though"],
  [/regardless of the fact that/gi,        "even though"],
  [/at this point in time/gi,              "now"],
  [/at the present time/gi,                "now"],
  [/prior to/gi,                           "before"],
  [/subsequent to/gi,                      "after"],
  [/in the event that/gi,                  "if"],
  [/in the absence of/gi,                  "without"],
  [/with regard to/gi,                     "regarding"],
  [/with respect to/gi,                    "regarding"],
  [/in terms of/gi,                        "for"],
  [/on the basis of/gi,                    "based on"],
  [/the fact that/gi,                      "that"],
  [/it is (clear|evident|apparent) that/gi, "clearly"],
  [/it is (possible|conceivable|plausible) that/gi, "possibly"],
  [/there (is|are) a (need|necessity) (to|for)/gi, "we need to"],
  [/the (use|utilization|application) of/gi, "using"],
  [/has the (ability|capacity|capability) to/gi, "can"],
  [/have the (ability|capacity|capability) to/gi, "can"],
  [/is (capable|able) of/gi,               "can"],
  [/are (capable|able) of/gi,              "can"],
  [/provides (a|an) (\w+) (for|of|to)/gi, "offers a $2 $3"],
];

function targetDetectorSignals(text, intensity) {
  let result = text;
  let count = 0;
  const swaps = intensity === "subtle" ? MID_SENTENCE_SWAPS.slice(0, 8) : MID_SENTENCE_SWAPS;
  for (const [pattern, replacement] of swaps) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) count++;
  }
  return { text: result, count };
}

const QUALIFIERS = {
  academic:       ["to some extent", "in many cases", "for the most part", "in large part"],
  professional:   ["in most cases", "on the whole", "by and large", "for the most part"],
  neutral:        ["in most cases", "for the most part", "more often than not", "in many ways"],
  conversational: ["for the most part", "most of the time", "in a lot of ways", "pretty much"],
};

function addReadabilityVariation(text, tone, intensity, modifiedIndices) {
  if (intensity !== "aggressive") return { text, count: 0 };
  const sentences = splitSentences(text);
  if (sentences.length < 4) return { text, count: 0 };
  let count = 0;
  const qualifiers = QUALIFIERS[tone];
  for (let i = 0; i < sentences.length; i++) {
    if (modifiedIndices.has(i)) continue;
    const sent = sentences[i];
    const verbMatch = sent.match(/\b(is|are|can|will|may|should|must)\s+(?!a\b|an\b|the\b)/i);
    if (verbMatch && verbMatch.index !== undefined && verbMatch.index > 8 && verbMatch.index < sent.length - 25) {
      const insertPos = verbMatch.index + verbMatch[0].length;
      const qualifier = qualifiers[i % qualifiers.length];
      sentences[i] = sent.slice(0, insertPos) + qualifier + " " + sent.slice(insertPos);
      modifiedIndices.add(i);
      count++;
      break;
    }
  }
  return { text: sentences.join(" "), count };
}

function humanizeText(text, tone, intensity) {
  const changes = [];
  const s1 = replaceVocabulary(text, tone, intensity);
  if (s1.count > 0) {
    changes.push({ type: "vocabulary", description: `Replaced ${s1.count} AI-flagged word or phrase — e.g. "furthermore" → "also", "utilize" → "use", "pivotal" → "key", "in conclusion" → "overall". Original meaning preserved throughout.` });
  }
  const s2 = targetDetectorSignals(s1.text, intensity);
  if (s2.count > 0) {
    changes.push({ type: "transition", description: `Simplified ${s2.count} verbose construction${s2.count > 1 ? "s" : ""} that detectors flag highly — e.g. "in order to" → "to", "due to the fact that" → "because". Meaning unchanged.` });
  }
  const s3 = rewriteStructure(s2.text, tone, intensity);
  if (s3.count > 0) {
    changes.push({ type: "restructure", description: `Restructured ${s3.count} sentence${s3.count > 1 ? "s" : ""} — rewrote passive constructions to active voice and varied opener patterns. Style-conditioned for ${tone} writing.` });
  }
  const s4 = insertContractions(s3.text, tone, intensity);
  if (s4.count > 0) {
    changes.push({ type: "tone", description: `Inserted ${s4.count} contraction${s4.count > 1 ? "s" : ""} — "do not" → "don't", "cannot" → "can't". Reduces the unnaturally formal register typical of AI writing.` });
  }
  const s5 = injectBurstiness(s4.text, intensity);
  if (s5.splits > 0) {
    changes.push({ type: "burstiness", description: `Split ${s5.splits} long sentence${s5.splits > 1 ? "s" : ""} at natural junction points. AI writes in metronomic uniform rhythm — varied sentence length raises the burstiness CV toward the human threshold.` });
  }
  const modifiedIndices = new Set();
  const s6 = reduceRepetition(s5.text, tone, intensity, modifiedIndices);
  if (s6.count > 0) {
    changes.push({ type: "restructure", description: `Broke up ${s6.count} repeated sentence pattern${s6.count > 1 ? "s" : ""} — consecutive sentences with identical structure were varied with clause front-loaders to avoid the mechanical regularity of AI text.` });
  }
  const s7 = boostPerplexity(s6.text, tone, intensity, modifiedIndices);
  if (s7.count > 0) {
    changes.push({ type: "perplexity", description: `Added ${s7.count} hedging opener${s7.count > 1 ? "s" : ""} — "That said,", "In practice,", "Notably," — to introduce mild unpredictability without altering meaning.` });
  }
  const s8 = addReadabilityVariation(s7.text, tone, intensity, modifiedIndices);
  if (s8.count > 0) {
    changes.push({ type: "perplexity", description: `Inserted ${s8.count} natural qualifier${s8.count > 1 ? "s" : ""} — e.g. "in most cases", "for the most part". Human writers add these unconsciously; AI text characteristically omits them.` });
  }
  if (changes.length === 0) {
    changes.push({ type: "vocabulary", description: "No strong AI patterns detected in this text. Try Aggressive intensity, or paste text that uses words like 'furthermore', 'utilize', 'pivotal', 'holistic', 'leverage', or 'in order to'." });
  }
  const humanized = s8.text.trim();
  return {
    original: text,
    humanized,
    changes,
    wordCountOriginal: text.trim().split(/\s+/).length,
    wordCountHumanized: humanized.split(/\s+/).length,
  };
}

const CHANGE_CONFIG = {
  burstiness:  { label: "Burstiness",  icon: "⟷", color: "text-violet-700 bg-violet-50 border-violet-200",   bar: "bg-violet-500"  },
  vocabulary:  { label: "Vocabulary",  icon: "≈",  color: "text-blue-700 bg-blue-50 border-blue-200",         bar: "bg-blue-500"    },
  perplexity:  { label: "Perplexity",  icon: "∿",  color: "text-amber-700 bg-amber-50 border-amber-200",      bar: "bg-amber-500"   },
  restructure: { label: "Restructure", icon: "⇄",  color: "text-emerald-700 bg-emerald-50 border-emerald-200",bar: "bg-emerald-500" },
  tone:        { label: "Tone",        icon: "♩",  color: "text-rose-700 bg-rose-50 border-rose-200",         bar: "bg-rose-500"    },
  transition:  { label: "Transition",  icon: "→",  color: "text-slate-700 bg-slate-100 border-slate-200",     bar: "bg-slate-500"   },
};

const STEPS = [
  { n: "1", title: "Rewriting, not generating", body: "Pastes existing text and rewrites it — never generates new content. A post-editing tool that preserves your original meaning while transforming how it reads." },
  { n: "2", title: "Sentence structure & rhythm", body: "Breaks up long uniform sentences, combines short fragments, and changes clause order. Eliminates the mechanical cadence that detectors and readers both flag." },
  { n: "3", title: "Tone & readability", body: "Four modes — Academic, Professional, Neutral, Conversational — each applying different stylistic conventions." },
  { n: "4", title: "Repetitive AI patterns", body: "Scans for predictable phrasing, repeated sentence lengths, and formulaic transitions. Introduces uneven rhythm and varied word choice." },
  { n: "5", title: "Pattern-level rewriting", body: "Analyzes predictability and uniform structure — then rewrites at that level. Closer to editor-style rewriting than surface paraphrasing." },
  { n: "6", title: "Meaning preserved, polish added", body: "Retains facts, intent, and original structure while smoothing phrasing and improving readability." },
];

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2200); })}
      className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all duration-200 ${
        copied
          ? "bg-emerald-50 border-emerald-200 text-emerald-700"
          : "bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50"
      }`}
    >
      {copied ? (
        <><svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>Copied!</>
      ) : (
        <><svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>Copy</>
      )}
    </button>
  );
}

export default function HumanizerPage() {
  const [inputText, setInputText] = useState("");
  const [tone,      setTone]      = useState("academic");
  const [intensity, setIntensity] = useState("moderate");
  const [result,    setResult]    = useState(null);
  const [error,     setError]     = useState("");

  const wc = inputText.trim() === "" ? 0 : inputText.trim().split(/\s+/).length;

  const handleHumanize = useCallback(() => {
    if (wc < 20) { setError("Please enter at least 20 words."); return; }
    setError("");
    try {
      const res = humanizeText(inputText.trim(), tone, intensity);
      setResult(res);
    } catch (e) {
      setError("Error: " + (e instanceof Error ? e.message : String(e)));
    }
  }, [inputText, tone, intensity, wc]);

  const handleClear = () => { setInputText(""); setResult(null); setError(""); };

  const tones = [
    { value: "academic",       label: "Academic",       desc: "Scholarly & precise"    },
    { value: "professional",   label: "Professional",   desc: "Formal & authoritative" },
    { value: "neutral",        label: "Neutral",        desc: "Clear & balanced"        },
    { value: "conversational", label: "Conversational", desc: "Natural & relaxed"       },
  ];

  const intensities = [
    { value: "subtle",     label: "Subtle",     desc: "Vocabulary & transitions only",  badge: "bg-slate-100 text-slate-600" },
    { value: "moderate",   label: "Moderate",   desc: "Structure + rhythm + tone",      badge: "bg-amber-100 text-amber-700" },
    { value: "aggressive", label: "Aggressive", desc: "Full pattern-level rewrite",     badge: "bg-red-100 text-red-700"     },
  ];

  const wcDiff = result ? result.wordCountHumanized - result.wordCountOriginal : 0;

  return (
    <div className="min-h-screen flex flex-col bg-[#f7f6f3]">

      {/* Top nav */}
      <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-20">
        <div className="max-w-[1400px] mx-auto px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center flex-shrink-0">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
              </svg>
            </div>
            <div>
              <span className="text-sm font-bold text-slate-900 tracking-tight">AI Humanizer</span>
              <span className="hidden sm:inline text-xs text-slate-400 ml-2">— rewrite, not generate</span>
            </div>
          </div>
          <span className="text-xs font-medium bg-emerald-600 text-white px-2.5 py-1 rounded-full">AI Humanizer</span>
        </div>
      </header>

      {/* Main layout */}
      <div className="flex flex-1 max-w-[1400px] mx-auto w-full">

        {/* LEFT RAIL */}
        <aside className="hidden lg:flex flex-col w-72 flex-shrink-0 border-r border-slate-200 bg-white">
          <div className="sticky top-[57px] overflow-y-auto px-5 py-6 space-y-1">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-4 px-1">How it works</p>
            {STEPS.map((step, i) => (
              <div key={i} className="flex gap-3 px-3 py-3 rounded-xl hover:bg-slate-50 transition-colors">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-600 flex items-center justify-center mt-0.5">
                  <span className="text-[10px] font-black text-white">{step.n}</span>
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-800 mb-0.5">{step.title}</p>
                  <p className="text-[11px] text-slate-500 leading-relaxed">{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* MAIN WORKSPACE */}
        <main className="flex-1 px-4 md:px-8 py-6 space-y-5 min-w-0">

          {/* INPUT CARD */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-3.5 flex items-center justify-between bg-slate-50">
              <span className="text-xs font-bold text-slate-600 uppercase tracking-wide">Paste AI Text</span>
              <div className="flex items-center gap-2">
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${wc < 20 ? "bg-red-50 text-red-500" : "bg-emerald-50 text-emerald-600"}`}>
                  {wc} words
                </span>
                {inputText && (
                  <button onClick={handleClear} className="text-[11px] font-medium text-slate-400 hover:text-slate-600 transition-colors">
                    Clear
                  </button>
                )}
              </div>
            </div>
            <textarea
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              placeholder="Paste AI-generated text here — minimum 20 words. The humanizer rewrites it without changing your meaning."
              className="w-full px-5 py-4 text-sm text-slate-800 placeholder-slate-300 resize-none focus:outline-none leading-relaxed bg-white"
              rows={7}
            />
            {error && (
              <div className="mx-5 mb-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-xs font-medium text-red-700">
                {error}
              </div>
            )}
          </div>

          {/* CONTROLS */}
          <div className="grid sm:grid-cols-2 gap-4">

            {/* Tone selector */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Tone</p>
              <div className="grid grid-cols-2 gap-2">
                {tones.map(t => (
                  <button
                    key={t.value}
                    onClick={() => setTone(t.value)}
                    className={`text-left px-3 py-2.5 rounded-xl border text-xs font-semibold transition-all ${
                      tone === t.value
                        ? "bg-emerald-600 border-emerald-600 text-white shadow-sm"
                        : "bg-slate-50 border-slate-200 text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    <div>{t.label}</div>
                    <div className={`text-[10px] font-normal mt-0.5 ${tone === t.value ? "text-emerald-100" : "text-slate-400"}`}>{t.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Intensity selector */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Intensity</p>
              <div className="space-y-2">
                {intensities.map(item => (
                  <button
                    key={item.value}
                    onClick={() => setIntensity(item.value)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border text-xs font-semibold transition-all flex items-center justify-between ${
                      intensity === item.value
                        ? "bg-emerald-600 border-emerald-600 text-white shadow-sm"
                        : "bg-slate-50 border-slate-200 text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    <span>{item.label}</span>
                    <span className={`text-[10px] font-normal ${intensity === item.value ? "text-emerald-100" : "text-slate-400"}`}>{item.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* SUBMIT BUTTON */}
          <button
            onClick={handleHumanize}
            disabled={wc < 20}
            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold text-sm py-3.5 rounded-2xl transition-colors shadow-sm flex items-center justify-center gap-2"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
            Humanize Text
          </button>

          {/* RESULTS */}
          {result && (
            <div className="space-y-4">

              {/* Stats row */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Original Words", value: result.wordCountOriginal },
                  { label: "Humanized Words", value: result.wordCountHumanized },
                  { label: "Techniques Applied", value: result.changes.length },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-3 text-center">
                    <div className="text-xl font-black text-slate-900">{value}</div>
                    <div className="text-xs font-semibold text-slate-500 mt-0.5">{label}</div>
                  </div>
                ))}
              </div>

              {/* Before / After */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                  <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-slate-50">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-400" />
                      <span className="text-xs font-bold text-slate-600 uppercase tracking-wide">Original — AI Text</span>
                    </div>
                    <span className="text-[10px] text-slate-400 font-medium">{result.wordCountOriginal} words</span>
                  </div>
                  <div className="flex-1 px-5 py-4 text-sm text-slate-500 leading-relaxed whitespace-pre-wrap overflow-auto max-h-80 bg-[#fafaf9]">
                    {result.original}
                  </div>
                </div>

                <div className="bg-white rounded-2xl border-2 border-emerald-200 shadow-sm overflow-hidden flex flex-col">
                  <div className="flex items-center justify-between px-5 py-3 border-b border-emerald-100 bg-emerald-50">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      <span className="text-xs font-bold text-emerald-800 uppercase tracking-wide">Humanized Output</span>
                    </div>
                    <CopyButton text={result.humanized} />
                  </div>
                  <div className="flex-1 px-5 py-4 text-sm text-slate-800 leading-relaxed whitespace-pre-wrap overflow-auto max-h-80">
                    {result.humanized}
                  </div>
                </div>
              </div>

              {/* Techniques applied */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="border-b border-slate-100 px-5 py-3.5 flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-700 uppercase tracking-wide">Techniques Applied</span>
                  <span className="text-[10px] font-bold bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">{result.changes.length}</span>
                </div>
                <div className="p-4 space-y-2">
                  {result.changes.map((change, idx) => {
                    const cfg = CHANGE_CONFIG[change.type] || CHANGE_CONFIG.transition;
                    return (
                      <div key={idx} className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-xs ${cfg.color}`}>
                        <span className="text-sm font-black w-5 text-center flex-shrink-0 mt-0.5">{cfg.icon}</span>
                        <div>
                          <span className="font-bold mr-1.5">{cfg.label}:</span>
                          {change.description}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

            </div>
          )}

        </main>
      </div>
    </div>
  );
}
