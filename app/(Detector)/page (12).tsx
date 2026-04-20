"use client";

import { useState, useCallback, useRef, useEffect } from "react";

// ─────────────────────────────────────────────────────────────────────────────
//  PDF REPORT GENERATOR  (client-side via jsPDF, dynamically loaded)
//  No npm install needed - loaded from cdnjs at download time.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  PRE-PROCESSING SANITISERS
//  Applied before ANY engine runs. Closes the two cheapest mechanical evasion
//  attacks: (1) zero-width / invisible Unicode injection, (2) homoglyph
//  substitution (Cyrillic/Greek lookalikes substituted for Latin letters).
// ─────────────────────────────────────────────────────────────────────────────

function stripInvisibleCharacters(text: string): string {
  // Strips: soft hyphen, zero-width space/non-joiner/joiner/LRM/RLM,
  // word joiner, function application, invisible plus/times, BOM, NBSP
  return text.replace(
    /[\u00AD\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\uFEFF\u00A0]/g,
    ""
  );
}

const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic → Latin
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0441": "c", "\u0445": "x",
  "\u0440": "p", "\u0456": "i", "\u04BB": "h", "\u0501": "d", "\u0262": "g",
  // Greek → Latin
  "\u03B1": "a", "\u03B5": "e", "\u03BF": "o", "\u03C1": "p", "\u03BA": "k",
  "\u03BD": "v", "\u03C5": "u", "\u03B9": "i", "\u03C7": "x",
  // Fullwidth Latin
  "\uFF41": "a", "\uFF42": "b", "\uFF43": "c", "\uFF44": "d", "\uFF45": "e",
  "\uFF46": "f", "\uFF47": "g", "\uFF48": "h", "\uFF49": "i", "\uFF4A": "j",
  "\uFF4B": "k", "\uFF4C": "l", "\uFF4D": "m", "\uFF4E": "n", "\uFF4F": "o",
  "\uFF50": "p", "\uFF51": "q", "\uFF52": "r", "\uFF53": "s", "\uFF54": "t",
  "\uFF55": "u", "\uFF56": "v", "\uFF57": "w", "\uFF58": "x", "\uFF59": "y",
  "\uFF5A": "z",
};

function normaliseHomoglyphs(text: string): string {
  return text.split("").map(c => HOMOGLYPH_MAP[c] ?? c).join("");
}

function sanitiseInput(text: string): string {
  return normaliseHomoglyphs(stripInvisibleCharacters(text));
}

async function loadJsPDF(): Promise<any> {
  if ((window as any).jspdf?.jsPDF) return (window as any).jspdf.jsPDF;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load jsPDF"));
    document.head.appendChild(s);
  });
  return (window as any).jspdf.jsPDF;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PDF TEXT EXTRACTION  (client-side via PDF.js from cdnjs)
// ─────────────────────────────────────────────────────────────────────────────

async function loadPdfJs(): Promise<any> {
  if ((window as any).pdfjsLib) return (window as any).pdfjsLib;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load PDF.js"));
    document.head.appendChild(s);
  });
  const pdfjsLib = (window as any).pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return pdfjsLib;
}

async function extractTextFromPDF(file: File): Promise<string> {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: any) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) texts.push(pageText);
  }
  return texts.join("\n\n");
}

async function generatePDFReport(
  inputText: string,
  perpResult: EngineResult | null,
  burstResult: EngineResult | null,
  neuralResult: EngineResult | null,
  judgment: string,
  judgeNotes: string
): Promise<void> {
  const jsPDF = await loadJsPDF();

  // ── Page constants ──────────────────────────────────────────────────────
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const PW  = 210;
  const PH  = 297;
  const ML  = 14;
  const MR  = 14;
  const MT  = 16;
  const MB  = 16;
  const CW  = PW - ML - MR;   // 182 mm

  // Two-column layout for annotated text:
  // Left = sentence text (highlighted)   Right = score + signals
  const TW  = 116;             // text column width
  const AW  = CW - TW - 4;    // analysis column width ~62 mm
  const AX  = ML + TW + 4;    // analysis column x position

  let y = MT;
  const now = new Date();

  // ── Colour palette ───────────────────────────────────────────────────────
  type RGB = [number, number, number];
  const C: Record<string, RGB> = {
    navy:        [27,  58, 107],
    green:       [22, 163,  74],
    red:         [220,  38,  38],
    amber:       [217, 119,   6],
    emerald:     [5,  150, 105],
    s900:        [15,  23,  42],
    s800:        [30,  41,  59],
    s600:        [71,  85, 105],
    s400:        [148,163, 184],
    s200:        [226,232, 240],
    s100:        [241,245, 249],
    s50:         [248,250, 252],
    white:       [255,255, 255],
    // Sentence highlights - same colours as web app
    aiRedFill:   [254, 226, 226],
    aiRedBrd:    [252, 165, 165],
    aiRedTxt:    [153,  27,  27],
    mixFill:     [254, 243, 199],
    mixBrd:      [253, 211,  77],
    mixTxt:      [146,  64,  14],
    humFill:     [209, 250, 229],
    humBrd:      [110, 231, 183],
    humTxt:      [6,   95,  70],
  };

  // ── Drawing helpers ──────────────────────────────────────────────────────

  const sf = (style: "normal"|"bold", size: number, col: RGB = C.s800) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.setTextColor(...col);
  };

  const tx = (t: string, x: number, yy: number, opts?: object) =>
    doc.text(t, x, yy, opts as any);

  const rect = (x: number, yy: number, w: number, h: number, fill: RGB, brd?: RGB, r = 1) => {
    doc.setFillColor(...fill);
    doc.setDrawColor(...(brd ?? fill));
    doc.setLineWidth(brd ? 0.3 : 0);
    doc.roundedRect(x, yy, w, h, r, r, brd ? "FD" : "F");
  };

  const hRule = (yy: number, col: RGB = C.s200, lw = 0.2) => {
    doc.setDrawColor(...col);
    doc.setLineWidth(lw);
    doc.line(ML, yy, PW - MR, yy);
  };

  // Add page if `needed` mm won't fit
  const need = (needed: number) => {
    if (y + needed > PH - MB) { doc.addPage(); y = MT; }
  };

  // Wrapped text with per-line page-break check, returns new y
  const wrapSafe = (t: string, x: number, yy: number, maxW: number, lh: number): number => {
    const lines = doc.splitTextToSize(t, maxW) as string[];
    let cy = yy;
    lines.forEach((l: string) => { need(lh + 1); tx(l, x, cy); cy += lh; });
    return cy;
  };

  // Coloured verdict pill, returns right edge x
  const pill = (label: string, x: number, yy: number): number => {
    const isAI  = label.includes("AI");
    const isMix = label.includes("Mixed");
    const bg:  RGB = isAI ? C.aiRedFill : isMix ? C.mixFill : C.humFill;
    const brd: RGB = isAI ? C.aiRedBrd  : isMix ? C.mixBrd  : C.humBrd;
    const fg:  RGB = isAI ? C.aiRedTxt  : isMix ? C.mixTxt  : C.humTxt;
    doc.setFontSize(7.5); doc.setFont("helvetica", "bold");
    const w = doc.getTextWidth(label) + 5;
    rect(x, yy - 3.2, w, 5, bg, brd, 1);
    doc.setTextColor(...fg); tx(label, x + 2.5, yy);
    return x + w + 2;
  };

  // Per-sentence colour set
  const sc = (label: "ai"|"mixed"|"human") => ({
    fill:  label === "ai" ? C.aiRedFill : label === "mixed" ? C.mixFill : C.humFill,
    brd:   label === "ai" ? C.aiRedBrd  : label === "mixed" ? C.mixBrd  : C.humBrd,
    txt:   label === "ai" ? C.aiRedTxt  : label === "mixed" ? C.mixTxt  : C.humTxt,
    score: label === "ai" ? C.red       : label === "mixed" ? C.amber   : C.emerald,
    word:  label === "ai" ? "AI-Generated" : label === "mixed" ? "Mixed / Uncertain" : "Human-Written",
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  PAGE 1 - COVER
  // ══════════════════════════════════════════════════════════════════════════

  rect(0, 0, PW, 48, C.s900);
  sf("bold", 20, C.white);
  tx("AI Content Detection Report", ML, 17);
  sf("normal", 8, C.s400);
  tx("Perplexity & Stylometry  ·  Burstiness & Cognitive  ·  Neural Perplexity  ·  MTLD  ·  Semantic Analysis  ·  Radar Fingerprint", ML, 26);
  const dateStr = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  sf("normal", 7.5, C.s400);
  tx(`Generated: ${dateStr} at ${timeStr}`, ML, 35);
  y = 56;

  // ── Helper: derive AI/Mixed/Human % from internalScore ───────────────────
  const pdfBreakdown = (score: number, elevatedSentenceRatio = 0): { ai: number; mixed: number; human: number } => {
    // Kept in sync with deriveBreakdown in the UI layer.
    // FIX: zone boundaries shifted so internalScore > 10 (not > 20) registers
    // non-zero AI%, closing the dead-zone that caused AI: 0% on elevated texts.
    const s = Math.max(0, Math.min(100, score));
    let ai: number, human: number, mixed: number;
    if (s <= 10) {
      ai    = 0;
      human = Math.floor(100 - s * 3);
      mixed = 100 - ai - human;
    } else if (s >= 50) {
      human = 0;
      ai    = Math.floor((s - 50) / 50 * 100);
      mixed = 100 - ai - human;
    } else {
      const t = (s - 10) / 40;
      ai    = Math.floor(t * 65);
      human = Math.floor((1 - t) * 65);
      mixed = 100 - ai - human;
    }
    ai    = Math.max(0, Math.min(100, ai));
    human = Math.max(0, Math.min(100, human));
    mixed = Math.max(0, 100 - ai - human);
    // Elevated-sentence floor: never show AI: 0% when elevated sentences exist.
    // Max floor scales with evidence weight: up to 25% when ratio > 0.5, else 15%.
    // Kept in sync with deriveBreakdown in the UI layer.
    if (ai === 0 && elevatedSentenceRatio > 0) {
      const maxFloor = elevatedSentenceRatio > 0.5 ? 25 : 15;
      const floor = Math.min(maxFloor, Math.round(elevatedSentenceRatio * 40));
      if (floor > 0) {
        ai = floor;
        const mixedAbsorb = Math.min(floor, mixed);
        mixed = mixed - mixedAbsorb;
        human = 100 - ai - mixed;
      }
    }
    return { ai, mixed, human };
  };

  // ── Stacked breakdown bar ──────────────────────────────────────────────────
  const drawBreakdownBar = (bx: number, by: number, bw: number, bh: number, ai: number, mixed: number, human: number) => {
    const aiW    = bw * ai    / 100;
    const mixedW = bw * mixed / 100;
    const humW   = bw * human / 100;
    if (ai    > 0) rect(bx,                  by, aiW,    bh, C.red,     undefined, 0);
    if (mixed > 0) rect(bx + aiW,            by, mixedW, bh, C.amber,   undefined, 0);
    if (human > 0) rect(bx + aiW + mixedW,   by, humW,   bh, C.emerald, undefined, 0);
  };

  // Executive summary
  if (perpResult && burstResult) {
    const pdfElevRatio = (r: EngineResult) =>
      r.sentences.length > 0 ? r.sentences.filter(s => s.label === "elevated").length / r.sentences.length : 0;
    const pBD = pdfBreakdown(perpResult.internalScore, pdfElevRatio(perpResult));
    const bBD = pdfBreakdown(burstResult.internalScore, pdfElevRatio(burstResult));
    const nBD = neuralResult ? pdfBreakdown(neuralResult.internalScore, pdfElevRatio(neuralResult)) : null;
    const engineCount = nBD ? 3 : 2;
    const avgAI    = Math.round((pBD.ai    + bBD.ai    + (nBD?.ai    ?? 0)) / engineCount);
    const avgMixed = Math.round((pBD.mixed + bBD.mixed + (nBD?.mixed  ?? 0)) / engineCount);
    const avgHuman = 100 - avgAI - avgMixed;
    const combLabel = (() => {
      // FPR FIX: require both heuristic engines to lean AI before labelling AI-Generated.
      const pLeanAI = pBD.ai > pBD.human;
      const bLeanAI = bBD.ai > bBD.human;
      const dualConsensus = pLeanAI && bLeanAI;
      if (!dualConsensus && avgAI >= 50) {
        // One engine over-fired — demote to review zone
        return "Needs Human Review";
      }
      if (avgAI >= avgMixed && avgAI >= avgHuman && dualConsensus) return "AI-Generated";
      if (avgHuman >= avgMixed && avgHuman >= avgAI)               return "Human-Written";
      if (avgAI >= 35 && avgAI < 50)                               return "Needs Human Review";
      return "Mixed / Uncertain";
    })();
    const combCol: RGB = combLabel === "AI-Generated" ? C.red : combLabel === "Human-Written" ? C.emerald : combLabel === "Needs Human Review" ? C.amber : C.amber;

    rect(ML, y, CW, 58, C.s100, C.s200);
    sf("bold", 10, C.s800);
    tx("Executive Summary", ML + 5, y + 8);

    // Combined score
    sf("bold", 22, combCol);
    tx(`${avgAI}%`, ML + 5, y + 25);
    sf("normal", 6.5, C.s400);
    tx("Combined AI Score", ML + 5, y + 31);

    // Engine boxes — dynamic: 2 or 3 depending on neural availability
    const execEngines: Array<{ label: string; col: RGB; bd: { ai: number; mixed: number; human: number }; phrase: string }> = [
      { label: "PERPLEXITY & STYLOMETRY",   col: C.navy,              bd: pBD, phrase: perpResult.verdictPhrase.slice(0, 24) },
      { label: "BURSTINESS & COG. MARKERS", col: C.green,             bd: bBD, phrase: burstResult.verdictPhrase.slice(0, 24) },
      ...(nBD ? [{ label: "NEURAL PERPLEXITY", col: [124, 58, 237] as RGB, bd: nBD, phrase: neuralResult!.verdictPhrase.slice(0, 24) }] : []),
    ];
    const execBoxW = nBD ? 46 : 58;
    const execStartX = ML + 48;
    execEngines.forEach(({ label, col, bd: eBD, phrase }, ei) => {
      const eCol: RGB = eBD.ai >= eBD.mixed && eBD.ai >= eBD.human ? C.red : eBD.human >= eBD.mixed ? C.emerald : C.amber;
      const ex = execStartX + ei * (execBoxW + 3);
      rect(ex, y + 10, execBoxW, 30, C.white, C.s200);
      rect(ex, y + 10, execBoxW, 6, col);
      sf("bold", 4.5, C.white); tx(label, ex + execBoxW / 2, y + 14, { align: "center" });
      sf("bold", 13, eCol); tx(`${eBD.ai}% AI`, ex + execBoxW / 2, y + 24, { align: "center" });
      drawBreakdownBar(ex + 2, y + 27, execBoxW - 4, 3, eBD.ai, eBD.mixed, eBD.human);
      sf("normal", 5.5, C.s600); tx(phrase, ex + execBoxW / 2, y + 36, { align: "center" });
    });

    // Combined stacked bar
    sf("bold", 7, C.s800); tx("Combined Breakdown", ML + 5, y + 44);
    drawBreakdownBar(ML + 5, y + 46, CW - 10, 4, avgAI, avgMixed, avgHuman);
    sf("normal", 6, C.red);     tx(`AI ${avgAI}%`,     ML + 5,             y + 54);
    sf("normal", 6, C.amber);   tx(`Mix ${avgMixed}%`, ML + CW / 2,        y + 54, { align: "center" });
    sf("normal", 6, C.emerald); tx(`Human ${avgHuman}%`, ML + CW - 5,      y + 54, { align: "right" });

    // Verdict pill
    const panFill: RGB = combLabel === "AI-Generated" ? C.aiRedFill : combLabel === "Human-Written" ? C.humFill : C.mixFill;
    const panBrd:  RGB = combLabel === "AI-Generated" ? C.aiRedBrd  : combLabel === "Human-Written" ? C.humBrd  : C.mixBrd;    rect(ML + 5, y + 56, CW - 10, 6, panFill, panBrd, 1);
    sf("bold", 7, combCol);
    tx(`Overall Verdict: ${combLabel}`, ML + CW / 2, y + 60.5, { align: "center" });

    y += 72;
  }

  // ── Full submitted text (no truncation) ────────────────────────────────
  sf("bold", 9.5, C.s800);
  tx("Submitted Text", ML, y); y += 4;
  hRule(y); y += 5;

  sf("normal", 7.5, C.s600);
  // Cap preview to 300 words to keep the report concise
  const MAX_PREVIEW_WORDS = 300;
  const inputWords = inputText.split(/\s+/);
  const previewText = inputWords.length > MAX_PREVIEW_WORDS
    ? inputWords.slice(0, MAX_PREVIEW_WORDS).join(" ") + " […text truncated for brevity — full text was analysed…]"
    : inputText;
  const allTextLines = doc.splitTextToSize(previewText, CW) as string[];
  allTextLines.forEach((line: string) => { need(5); tx(line, ML, y); y += 4.5; });

  sf("normal", 6.5, C.s400);
  need(7);
  tx(`${inputText.split(/\s+/).length} words  -  ${splitSentences(inputText).length} sentences${inputWords.length > MAX_PREVIEW_WORDS ? "  -  text preview capped at 300 words above" : ""}`, ML, y + 2);
  y += 8;

  // ══════════════════════════════════════════════════════════════════════════
  //  ENGINE SECTION
  //  Two-column layout per sentence:
  //  LEFT  (116 mm) = sentence text on coloured background (red/amber/green)
  //  RIGHT ( 62 mm) = large AI score + classification + detected signals
  // ══════════════════════════════════════════════════════════════════════════

  function drawEngineSection(
    engineName: string,
    logoColor: RGB,
    logoText: string,
    methodology: string,
    primarySignal: string,
    result: EngineResult
  ) {
    const bd = pdfBreakdown(result.internalScore,
      result.sentences.length > 0 ? result.sentences.filter(s => s.label === "elevated").length / result.sentences.length : 0);
    const verdictLabel = bd.ai >= bd.mixed && bd.ai >= bd.human
      ? "AI-Generated" : bd.human >= bd.mixed ? "Human-Written" : "Mixed / Uncertain";
    const verdictCol: RGB = verdictLabel === "AI-Generated" ? C.red : verdictLabel === "Human-Written" ? C.emerald : C.amber;

    // ── Section header page ───────────────────────────────────────────────
    doc.addPage(); y = 0;
    rect(0, 0, PW, 36, logoColor);
    doc.setFillColor(...C.white); doc.circle(ML + 6, 18, 6, "F");
    sf("bold", 8, logoColor); tx(logoText, ML + 3.5, 20.5);
    sf("bold", 15, C.white); tx(`${engineName} Analysis`, ML + 17, 13);
    sf("normal", 7, [210, 225, 240] as RGB); tx(methodology, ML + 17, 21);
    sf("normal", 6.5, [180, 200, 220] as RGB); tx(`Primary signal: ${primarySignal}`, ML + 17, 29);
    y = 44;

    // ── Score breakdown row ───────────────────────────────────────────────
    // Three score boxes: AI% | Mixed% | Human%
    const boxW = (CW - 6) / 3;
    [
      { label: "AI-Generated",  val: bd.ai,    col: C.red,     fill: C.aiRedFill, brd: C.aiRedBrd },
      { label: "Mixed",         val: bd.mixed, col: C.amber,   fill: C.mixFill,   brd: C.mixBrd   },
      { label: "Human-Written", val: bd.human, col: C.emerald, fill: C.humFill,   brd: C.humBrd   },
    ].forEach((box, i) => {
      const bx = ML + i * (boxW + 3);
      rect(bx, y, boxW, 22, box.fill, box.brd);
      sf("bold", 18, box.col); tx(`${box.val}%`, bx + boxW / 2, y + 13, { align: "center" });
      sf("normal", 6, box.col); tx(box.label, bx + boxW / 2, y + 19, { align: "center" });
    });
    y += 26;

    // Stacked bar
    drawBreakdownBar(ML, y, CW, 5, bd.ai, bd.mixed, bd.human);
    y += 9;

    // Verdict pill
    pill(verdictLabel, ML, y);
    sf("normal", 7, C.s600);
    tx(`Words: ${result.wordCount}   -   Sentences: ${result.sentenceCount}   -   Range: ${result.confidenceLow}-${result.confidenceHigh}%`, ML + 40, y);
    y += 10; hRule(y); y += 5;

    // Evidence strength + verdict phrase
    sf("bold", 7.5, C.s800); tx("Evidence Strength:", ML, y);
    sf("normal", 7.5, C.s600); tx(`${result.evidenceStrength}  -  ${result.verdictPhrase}`, ML + 32, y);
    y += 6;

    // Reliability warnings
    if (result.reliabilityWarnings.length > 0) {
      rect(ML, y, CW, 5 + result.reliabilityWarnings.length * 4, C.mixFill, C.mixBrd);
      sf("bold", 6.5, C.mixTxt); tx("Reliability Notes:", ML + 3, y + 4);
      result.reliabilityWarnings.forEach((w, i) => {
        sf("normal", 6, C.s600); tx(`- ${w}`, ML + 3, y + 8 + i * 4);
      });
      y += 6 + result.reliabilityWarnings.length * 4 + 3;
    }

    hRule(y); y += 5;

    // ── Signal breakdown ──────────────────────────────────────────────────
    sf("bold", 9.5, C.s800); tx("Signal Breakdown", ML, y); y += 5;

    result.signals.forEach(sig => {
      const sigCol: RGB = sig.pointsToAI ? (sig.wellSupported ? C.red : C.amber) : C.emerald;

      // Layout constants for this signal row
      // Left zone: bullet + name text  (ML .. ML+110)
      // Badge zone: "STRONG" pill      (ML+112 .. ML+130)
      // Bar zone: strength bar + %     (ML+132 .. PW-MR)
      const NAME_MAX_W = 108; // max width for signal name before wrapping
      const BADGE_X    = ML + 112;
      const BAR_X      = ML + 132;
      const BAR_W      = PW - MR - BAR_X - 8; // ~52 mm remaining
      const BAR_H      = 3;

      // Pre-measure name and value lines so we can reserve the right amount of space
      doc.setFont("helvetica", "bold"); doc.setFontSize(7.5);
      const nLines = doc.splitTextToSize(sig.name, NAME_MAX_W) as string[];
      doc.setFont("helvetica", "normal"); doc.setFontSize(6.5);
      const vLines = doc.splitTextToSize(sig.value, CW - 8) as string[];

      // Total block height: name row(s) + value lines + bottom gap
      const nameH  = nLines.length * 5;
      const valueH = vLines.length * 4.5;
      const blockH = nameH + valueH + 4; // 4 mm bottom breathing room

      need(blockH);

      // Draw bullet circle aligned to first name line
      doc.setFillColor(...sigCol);
      doc.circle(ML + 2, y - 1.2, 1.5, "F");

      // Signal name (bold, coloured) — render all wrapped lines
      sf("bold", 7.5, sigCol);
      nLines.forEach((nl: string, ni: number) => {
        tx(nl, ML + 6, y + ni * 5);
      });

      // "STRONG" badge — placed in its own reserved zone, never overlapping the name
      if (sig.wellSupported && sig.pointsToAI) {
        // Draw a small pill background for the badge
        const badgeLabel = "STRONG";
        doc.setFont("helvetica", "bold"); doc.setFontSize(5.5);
        const badgeW = doc.getTextWidth(badgeLabel) + 3;
        rect(BADGE_X, y - 3, badgeW, 4.5, C.aiRedFill, C.aiRedBrd, 0.8);
        doc.setTextColor(...C.red);
        tx(badgeLabel, BADGE_X + 1.5, y);
      }

      // Strength bar — always in its own right-side zone
      rect(BAR_X, y - 2.5, BAR_W, BAR_H, C.s200);
      if (sig.strength > 0) rect(BAR_X, y - 2.5, BAR_W * sig.strength / 100, BAR_H, sigCol);
      sf("normal", 6.5, C.s600);
      tx(`${sig.strength}%`, BAR_X + BAR_W + 2, y);

      // Advance past all name lines, then render value lines
      y += nameH;
      sf("normal", 6.5, C.s400);
      vLines.forEach((vl: string) => { tx(vl, ML + 6, y); y += 4.5; });
      y += 3; // gap before next signal
    });

    y += 3; hRule(y); y += 6;

    // ── Sentence-level analysis ───────────────────────────────────────────
    sf("bold", 9.5, C.s800); tx("Sentence Pattern Analysis", ML, y); y += 5;

    // Map sentence label to colour set
    const sentSC = (label: "elevated" | "moderate" | "uncertain") => ({
      fill:  label === "elevated" ? C.aiRedFill : label === "moderate" ? C.mixFill : C.humFill,
      brd:   label === "elevated" ? C.aiRedBrd  : label === "moderate" ? C.mixBrd  : C.humBrd,
      txt:   label === "elevated" ? C.aiRedTxt  : label === "moderate" ? C.mixTxt  : C.humTxt,
      score: label === "elevated" ? C.red       : label === "moderate" ? C.amber   : C.emerald,
      word:  label === "elevated" ? "Elevated"  : label === "moderate" ? "Moderate" : "Uncertain",
    });

    // Column header labels
    sf("bold", 7, C.s600);
    tx("Sentence Text  (colour = pattern level)", ML, y);
    tx("Likelihood & Signals", AX, y);
    y += 3; hRule(y, C.s200); y += 4;

    // Legend
    const legendItems: Array<{ fill: RGB; brd: RGB; label: string }> = [
      { fill: C.aiRedFill, brd: C.aiRedBrd, label: "Elevated patterns" },
      { fill: C.mixFill,   brd: C.mixBrd,   label: "Moderate patterns" },
      { fill: C.humFill,   brd: C.humBrd,   label: "Uncertain / Low" },
    ];
    legendItems.forEach((li, i) => {
      rect(ML + i * 58, y - 0.5, 4, 4, li.fill, li.brd, 0.5);
      sf("normal", 6.5, C.s600); tx(li.label, ML + i * 58 + 6, y + 2.5);
    });
    y += 7;

    // Only render sentences with meaningful likelihood (>=20 = moderate or elevated).
    // Filtering out near-zero sentences significantly reduces page count.
    const includedSentences = result.sentences.filter(s => s.likelihood >= 20);
    const omittedCount = result.sentences.length - includedSentences.length;

    if (includedSentences.length === 0) {
      need(12);
      sf("normal", 7.5, C.s400);
      tx("All sentences scored below 20% likelihood — no significant AI-associated patterns detected.", ML, y);
      y += 10;
    }

    includedSentences.forEach((sent, idx) => {
      const cl = sentSC(sent.label);

      // Left column: measure sentence text height
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5);
      const textLines = doc.splitTextToSize(sent.text, TW - 11) as string[];
      const PAD_V = 4;  // top + bottom padding inside each cell
      const leftH = textLines.length * 4.5 + PAD_V * 2;

      // Right column: % (10pt) + "LIKELIHOOD" label + word label + divider + signals
      doc.setFont("helvetica", "bold"); doc.setFontSize(10);
      const pctH = 7;   // 10pt number height
      doc.setFont("helvetica", "normal"); doc.setFontSize(5.5);
      const lblH = 3.5; // "LIKELIHOOD" label
      doc.setFont("helvetica", "bold"); doc.setFontSize(6.5);
      const wordH = 4;  // classification word
      const divH = 3;   // divider gap

      doc.setFont("helvetica", "normal"); doc.setFontSize(6);
      const sigLines = sent.signals.length > 0
        ? sent.signals.flatMap((sig: string) => doc.splitTextToSize(`- ${sig}`, AW - 5) as string[])
        : [];
      const sigBlockH = sigLines.length > 0 ? sigLines.length * 3.6 : 3.6; // "No signals" fallback
      const rightH = PAD_V + pctH + lblH + wordH + divH + sigBlockH + PAD_V;

      const rowH = Math.max(leftH, rightH);
      need(rowH + 2);

      // Left: sentence block
      rect(ML, y, TW, rowH, cl.fill, cl.brd, 1);
      // Index badge
      rect(ML + 1.5, y + 2, 6, 4, cl.brd, cl.brd, 0.5);
      sf("bold", 5.5, cl.txt); tx(String(idx + 1), ML + 4.5, y + 5, { align: "center" });
      sf("normal", 7.5, C.s800);
      textLines.forEach((line: string, li: number) => { tx(line, ML + 10, y + PAD_V + li * 4.5); });

      // Right: likelihood block — all positions relative to rowH for vertical centering
      rect(AX, y, AW, rowH, C.s50, C.s200, 1);
      let ry = y + PAD_V;

      // Percentage — scaled font: smaller if text will be tight
      sf("bold", 10, cl.score);
      tx(`${sent.likelihood}%`, AX + AW / 2, ry + pctH - 1, { align: "center" });
      ry += pctH;

      sf("normal", 5.5, C.s400);
      tx("LIKELIHOOD", AX + AW / 2, ry + lblH - 0.5, { align: "center" });
      ry += lblH;

      sf("bold", 6.5, cl.txt);
      tx(cl.word, AX + AW / 2, ry + wordH - 0.5, { align: "center" });
      ry += wordH;

      doc.setDrawColor(...C.s200); doc.setLineWidth(0.2);
      doc.line(AX + 3, ry, AX + AW - 3, ry);
      ry += divH;

      sf("normal", 6, C.s600);
      const maxSy = y + rowH - PAD_V;
      if (sigLines.length > 0) {
        sigLines.forEach((sl: string) => {
          if (ry < maxSy) { tx(sl, AX + 3, ry); ry += 3.6; }
        });
      } else {
        sf("normal", 6, C.s400);
        tx("No signals detected", AX + AW / 2, ry + 1.5, { align: "center" });
      }

      y += rowH + 1.5;
    });

    // ── Summary statistics ─────────────────────────────────────────────────
    y += 3; need(28); hRule(y); y += 5;
    sf("bold", 9, C.s800); tx("Sentence Summary", ML, y); y += 5;

    const elevCount = includedSentences.filter(s => s.label === "elevated").length;
    const modCount  = includedSentences.filter(s => s.label === "moderate").length;
    const uncCount  = includedSentences.filter(s => s.label === "uncertain").length;
    const total     = includedSentences.length;

    const statW = (CW - 9) / 4;
    [
      { label: "Elevated",  val: elevCount, col: C.red },
      { label: "Moderate",  val: modCount,  col: C.amber },
      { label: "Uncertain", val: uncCount,  col: C.emerald },
      { label: "Total",     val: total,     col: C.s600 },
    ].forEach((st, i) => {
      const bx = ML + i * (statW + 3);
      rect(bx, y, statW, 18, C.s100, C.s200);
      sf("bold", 14, st.col); tx(String(st.val), bx + statW / 2, y + 10, { align: "center" });
      sf("normal", 6, C.s400);
      tx(`${Math.round(st.val / Math.max(total, 1) * 100)}%  ${st.label}`, bx + statW / 2, y + 15, { align: "center" });
    });
    y += 24;

    // Omitted-sentence note
    if (omittedCount > 0) {
      need(10);
      rect(ML, y, CW, 8, C.s100, C.s200);
      sf("normal", 6.5, C.s400);
      tx(
        `${omittedCount} sentence${omittedCount !== 1 ? "s" : ""} with likelihood below 20% omitted — no significant AI-associated patterns were detected in those sentence${omittedCount !== 1 ? "s" : ""}.`,
        ML + CW / 2, y + 5, { align: "center" }
      );
      y += 12;
    }
  }

  // Run all engine sections with correct names/colours
  if (perpResult)  drawEngineSection("Perplexity & Stylometry",      C.navy,  "PS", "Multi-signal: AI vocabulary density, transition phrases, document uniformity, intra-document shift.", "Vocabulary + Transition Patterns", perpResult);
  if (burstResult) drawEngineSection("Burstiness & Cognitive Markers", C.green, "BC", "Sentence length variation (CV), rhetorical devices, short-sentence presence, contraction signals.",  "Sentence Burstiness (CV)",         burstResult);
  if (neuralResult) {
    const violetRGB: RGB = [124, 58, 237];
    drawEngineSection("Neural Perplexity", violetRGB, "NP", "LLM-based analysis: token predictability, semantic smoothness, structural uniformity, human cognitive markers.", "Token Predictability + Semantic Smoothness", neuralResult);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FINAL PAGE - COMPARATIVE ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════

  if (perpResult && burstResult) {
    doc.addPage(); y = 0;
    rect(0, 0, PW, 24, C.s900);
    sf("bold", 13, C.white); tx("Comparative Analysis", ML, 15);
    y = 32;

    sf("bold", 9.5, C.s800); tx("Side-by-Side Score Comparison", ML, y); y += 5;

    // Dynamic column layout: 3 engines if neural available, else 2
    const engines = [
      { name: "Perplexity & Stylometry",       col: C.navy,              res: perpResult  },
      { name: "Burstiness & Cognitive Markers", col: C.green,             res: burstResult },
      ...(neuralResult ? [{ name: "Neural Perplexity", col: [124, 58, 237] as RGB, res: neuralResult }] : []),
    ];
    const colGap  = 4;
    const bw = (CW - colGap * (engines.length - 1)) / engines.length;

    engines.forEach(({ name, col, res }, i) => {
      const bx  = ML + i * (bw + colGap);
      const bd  = pdfBreakdown(res.internalScore,
        res.sentences.length > 0 ? res.sentences.filter(s => s.label === "elevated").length / res.sentences.length : 0);
      const vLabel = bd.ai >= bd.mixed && bd.ai >= bd.human ? "AI-Generated" : bd.human >= bd.mixed ? "Human-Written" : "Mixed / Uncertain";
      const vCol: RGB = vLabel === "AI-Generated" ? C.red : vLabel === "Human-Written" ? C.emerald : C.amber;
      rect(bx, y, bw, 44, C.s100, C.s200);
      rect(bx, y, bw, 8, col);
      sf("bold", 7, C.white); tx(name, bx + bw / 2, y + 5.5, { align: "center" });
      // Three mini score boxes
      const mw = (bw - 8) / 3;
      [
        { label: "AI",    val: bd.ai,    c: C.red },
        { label: "Mix",   val: bd.mixed, c: C.amber },
        { label: "Human", val: bd.human, c: C.emerald },
      ].forEach((box, j) => {
        const mbx = bx + 4 + j * (mw + 2);
        sf("bold", 12, box.c); tx(`${box.val}%`, mbx + mw / 2, y + 20, { align: "center" });
        sf("normal", 5.5, C.s400); tx(box.label, mbx + mw / 2, y + 25, { align: "center" });
      });
      drawBreakdownBar(bx + 4, y + 28, bw - 8, 3, bd.ai, bd.mixed, bd.human);
      sf("bold", 7, vCol); tx(vLabel, bx + bw / 2, y + 35, { align: "center" });
      sf("normal", 6, C.s400);
      tx(`${res.evidenceStrength}  -  ${res.wordCount} words  -  ${res.sentenceCount} sentences`, bx + bw / 2, y + 40.5, { align: "center" });
    });
    y += 52;

    // Agreement panel — updated for 3 engines
    const pBD2  = pdfBreakdown(perpResult.internalScore,  perpResult.sentences.length  > 0 ? perpResult.sentences.filter(s  => s.label === "elevated").length / perpResult.sentences.length  : 0);
    const bBD2  = pdfBreakdown(burstResult.internalScore, burstResult.sentences.length > 0 ? burstResult.sentences.filter(s => s.label === "elevated").length / burstResult.sentences.length : 0);
    const nBD2  = neuralResult ? pdfBreakdown(neuralResult.internalScore, neuralResult.sentences.length > 0 ? neuralResult.sentences.filter(s => s.label === "elevated").length / neuralResult.sentences.length : 0) : null;
    const engineCountComp = nBD2 ? 3 : 2;
    const avgAIComp    = Math.round((pBD2.ai    + bBD2.ai    + (nBD2?.ai    ?? 0)) / engineCountComp);
    const avgHumanComp = Math.round((pBD2.human + bBD2.human + (nBD2?.human ?? 0)) / engineCountComp);
    const avgMixedComp = 100 - avgAIComp - avgHumanComp;
    const pVerdict = pBD2.ai >= pBD2.mixed && pBD2.ai >= pBD2.human ? "AI" : pBD2.human >= pBD2.mixed ? "Human" : "Mixed";
    const bVerdict = bBD2.ai >= bBD2.mixed && bBD2.ai >= bBD2.human ? "AI"  : bBD2.human >= bBD2.mixed ? "Human" : "Mixed";
    const nVerdict = nBD2 ? (nBD2.ai >= nBD2.mixed && nBD2.ai >= nBD2.human ? "AI" : nBD2.human >= nBD2.mixed ? "Human" : "Mixed") : null;
    const allVerdicts = [pVerdict, bVerdict, ...(nVerdict ? [nVerdict] : [])];
    const allAgree  = allVerdicts.every(v => v === allVerdicts[0]);
    const diff   = Math.abs(perpResult.internalScore - burstResult.internalScore);
    const panFill2: RGB = allAgree && diff <= 8 ? C.humFill : diff > 20 ? C.aiRedFill : C.mixFill;
    const panBrd2:  RGB = allAgree && diff <= 8 ? C.humBrd  : diff > 20 ? C.aiRedBrd  : C.mixBrd;
    rect(ML, y, CW, 22, panFill2, panBrd2);
    sf("bold", 8.5, C.s800);
    tx(allAgree && diff <= 8 ? `All ${engineCountComp} engines agree` : allAgree ? "Same verdict, different confidence" : "Engines partially disagree", ML + 5, y + 8);
    sf("normal", 7, C.s600);
    const noteComp = allAgree
      ? `All engines returned "${allVerdicts[0]}". Internal score gap PS vs BC: ${diff} points. Combined AI: ${avgAIComp}%  Mix: ${avgMixedComp}%  Human: ${avgHumanComp}%.`
      : `PS: "${pVerdict}"  BC: "${bVerdict}"${nVerdict ? `  NP: "${nVerdict}"` : ""}.  Combined AI: ${avgAIComp}%  Mix: ${avgMixedComp}%  Human: ${avgHumanComp}%.`;
    tx(noteComp, ML + 5, y + 15);
    // Mini combined bar
    drawBreakdownBar(ML + 5, y + 18, CW - 10, 2, avgAIComp, avgMixedComp, avgHumanComp);
    y += 30;

    hRule(y); y += 5;
    sf("bold", 9.5, C.s800); tx("How to Interpret These Results", ML, y); y += 6;

    const guide: [string, string][] = [
      ["Perplexity & Stylometry", "Detects clusters of AI-specific vocabulary, cliche transition phrases, bigram patterns, and document-level repetition. Multiple signals must agree - a single hit does not raise the evidence level."],
      ["Burstiness & Cognitive Markers", "Measures sentence length variation (CV). Human writers naturally alternate short and long sentences (CV > 0.42); AI writes uniformly (CV < 0.22). Rhetorical devices - questions, em-dashes, parentheticals - are counted as positive human signals."],
      ["Neural Perplexity", "LLM-based engine that evaluates token-level predictability, semantic smoothness, and structural uniformity. Catches paraphrased AI text and context-sensitive patterns that rule-based engines miss. Also flags ESL and academic writing to reduce false positives."],
      ["Score breakdown (AI / Mixed / Human)", "RECALIBRATED thresholds (FPR-corrected): Likely Human < 20%, Mostly Human 20–34%, Needs Human Review 35–49% (ambiguous zone — formal/academic writing often scores here), Mixed / Uncertain 50–64%, Likely AI 65–79%, Almost Certainly AI ≥ 80%. A combined score only reaches AI territory when BOTH heuristic engines independently agree."],
      ["When engines agree", "Higher confidence. Dual-engine agreement on AI signals is required to issue any AI verdict. Agreement at Moderate level or above, with both engines firing, is treated as a strong indicator. Single-engine firing is explicitly insufficient — the result is clamped to the 'Needs Human Review' zone."],
      ["When engines disagree", "Single-engine firing is the primary source of false positives on formal human writing. The system caps the combined score at 49% when only one engine fires, routing the result to the review zone. This protects formal academic writers and ESL writers from false accusations."],
    ];
    guide.forEach(([label, desc]) => {
      need(18);
      sf("bold", 7.5, C.s800); tx(label, ML, y); y += 4;
      sf("normal", 7, C.s600);
      y = wrapSafe(desc, ML + 3, y, CW - 5, 4.2) + 4;
    });

    need(18); hRule(y); y += 5;
    rect(ML, y, CW, 14, C.mixFill, C.mixBrd);
    sf("bold", 7, C.mixTxt); tx("Important Disclaimer", ML + 4, y + 5);
    sf("normal", 6.5, C.s600);
    tx("Results are probabilistic pattern analysis only. Formal writing, academic prose, ESL writing, and revised human text may share surface patterns with AI-generated text.", ML + 4, y + 10);
    tx("No automated decision should be made based on these results alone. Always apply professional judgement.", ML + 4, y + 14);
    y += 20;

    // ── Professional Judgment Section ────────────────────────────────────
    doc.addPage(); y = 0;
    rect(0, 0, PW, 24, C.s900);
    sf("bold", 13, C.white); tx("Professional Judgment", ML, 15);
    sf("normal", 7, C.s400); tx("Reviewer assessment based on contextual knowledge beyond automated signals", ML, 20);
    y = 32;

    // Verdict box
    const jLabel   = judgment || "Not Provided";
    const jFill: RGB = judgment === "AI-Generated"  ? C.aiRedFill
                     : judgment === "Human-Written" ? C.humFill
                     : judgment === "Mixed"         ? C.mixFill
                     : C.s100;
    const jBrd:  RGB = judgment === "AI-Generated"  ? C.aiRedBrd
                     : judgment === "Human-Written" ? C.humBrd
                     : judgment === "Mixed"         ? C.mixBrd
                     : C.s200;
    const jTxt:  RGB = judgment === "AI-Generated"  ? C.aiRedTxt
                     : judgment === "Human-Written" ? C.humTxt
                     : judgment === "Mixed"         ? C.mixTxt
                     : C.s600;

    rect(ML, y, CW, 28, jFill, jBrd);
    sf("bold", 8, C.s600); tx("Reviewer Verdict", ML + 5, y + 7);
    sf("bold", 18, jTxt); tx(jLabel, ML + 5, y + 20);

    // Verdict icon indicator (right side)
    const jIcon = judgment === "AI-Generated" ? "AI" : judgment === "Human-Written" ? "HW" : judgment === "Mixed" ? "MX" : "--";
    rect(PW - MR - 22, y + 4, 20, 20, jBrd, jBrd, 2);
    sf("bold", 11, jTxt); tx(jIcon, PW - MR - 12, y + 16, { align: "center" });
    y += 34;

    // Three-option legend showing which was selected
    sf("bold", 7, C.s600); tx("Classification Options:", ML, y); y += 5;
    const opts: Array<{ label: string; fill: RGB; brd: RGB; txt: RGB }> = [
      { label: "AI-Generated",  fill: C.aiRedFill, brd: C.aiRedBrd, txt: C.aiRedTxt },
      { label: "Mixed",         fill: C.mixFill,   brd: C.mixBrd,   txt: C.mixTxt   },
      { label: "Human-Written", fill: C.humFill,   brd: C.humBrd,   txt: C.humTxt   },
    ];
    const optW = (CW - 6) / 3;
    opts.forEach((opt, i) => {
      const bx  = ML + i * (optW + 3);
      const sel = opt.label === judgment;
      rect(bx, y, optW, 10, sel ? opt.fill : C.s50, sel ? opt.brd : C.s200);
      if (sel) {
        // Checkmark badge
        rect(bx + optW - 7, y + 1, 6, 6, opt.brd, opt.brd, 1);
        sf("bold", 6, opt.txt); tx("OK", bx + optW - 4, y + 5.5, { align: "center" });
      }
      sf(sel ? "bold" : "normal", 7, sel ? opt.txt : C.s400);
      tx(opt.label, bx + optW / 2, y + 6.5, { align: "center" });
    });
    y += 16;

    hRule(y); y += 5;

    // Notes box
    sf("bold", 8.5, C.s800); tx("Reviewer Notes & Rationale", ML, y); y += 5;
    const notesText = judgeNotes.trim() || "No additional notes provided.";
    const notesLines = doc.splitTextToSize(notesText, CW - 10) as string[];
    const notesBoxH = Math.max(24, notesLines.length * 5 + 10);
    rect(ML, y, CW, notesBoxH, C.s50, C.s200);
    sf("normal", 7.5, judgeNotes.trim() ? C.s800 : C.s400);
    notesLines.forEach((line: string, i: number) => {
      tx(line, ML + 5, y + 8 + i * 5);
    });
    y += notesBoxH + 6;

    hRule(y); y += 5;

    // Automated signals summary vs judgment comparison
    if (perpResult && burstResult) {
      sf("bold", 8.5, C.s800); tx("Automated Signals vs. Reviewer Judgment", ML, y); y += 5;

      const pBDJ = pdfBreakdown(perpResult.internalScore,  perpResult.sentences.length  > 0 ? perpResult.sentences.filter(s  => s.label === "elevated").length / perpResult.sentences.length  : 0);
      const bBDJ = pdfBreakdown(burstResult.internalScore, burstResult.sentences.length > 0 ? burstResult.sentences.filter(s => s.label === "elevated").length / burstResult.sentences.length : 0);
      const nBDJ = neuralResult ? pdfBreakdown(neuralResult.internalScore, neuralResult.sentences.length > 0 ? neuralResult.sentences.filter(s => s.label === "elevated").length / neuralResult.sentences.length : 0) : null;
      const engCount = nBDJ ? 3 : 2;
      const avgAIJ    = Math.round((pBDJ.ai    + bBDJ.ai    + (nBDJ?.ai    ?? 0)) / engCount);
      const avgHumanJ = Math.round((pBDJ.human + bBDJ.human + (nBDJ?.human ?? 0)) / engCount);
      const avgMixedJ = 100 - avgAIJ - avgHumanJ;
      const autoVerdict = (() => {
        const pLeanAI2 = pBDJ.ai > pBDJ.human;
        const bLeanAI2 = bBDJ.ai > bBDJ.human;
        const dualConsensus2 = pLeanAI2 && bLeanAI2;
        if (avgAIJ >= avgMixedJ && avgAIJ >= avgHumanJ && dualConsensus2) return "AI-Generated";
        if (avgHumanJ >= avgMixedJ) return "Human-Written";
        if (avgAIJ >= 35 && avgAIJ < 50) return "Needs Human Review";
        return "Mixed";
      })();
      const agree = !judgment || autoVerdict === judgment;

      const cmpW = (CW - 5) / 2;
      // Auto box
      rect(ML, y, cmpW, 30, C.s100, C.s200);
      rect(ML, y, cmpW, 7, C.s800);
      sf("bold", 6.5, C.white); tx("Automated Analysis", ML + cmpW / 2, y + 5, { align: "center" });
      const aCol: RGB = autoVerdict === "AI-Generated" ? C.red : autoVerdict === "Human-Written" ? C.emerald : C.amber;
      sf("bold", 10, aCol); tx(autoVerdict, ML + cmpW / 2, y + 17, { align: "center" });
      drawBreakdownBar(ML + 4, y + 21, cmpW - 8, 3, avgAIJ, avgMixedJ, avgHumanJ);
      sf("normal", 5.5, C.s400); tx(`AI ${avgAIJ}%  Mix ${avgMixedJ}%  Human ${avgHumanJ}%`, ML + cmpW / 2, y + 28, { align: "center" });

      // Reviewer box
      rect(ML + cmpW + 5, y, cmpW, 30, jFill, jBrd);
      rect(ML + cmpW + 5, y, cmpW, 7, jTxt);
      sf("bold", 6.5, C.white); tx("Reviewer Judgment", ML + cmpW + 5 + cmpW / 2, y + 5, { align: "center" });
      sf("bold", 10, jTxt); tx(jLabel, ML + cmpW + 5 + cmpW / 2, y + 17, { align: "center" });
      sf("normal", 6, jTxt); tx(agree ? "Agrees with automated result" : "Overrides automated result", ML + cmpW + 5 + cmpW / 2, y + 25, { align: "center" });
      y += 36;

      // Agreement note
      const agrFill: RGB = agree ? C.humFill : C.mixFill;
      const agrBrd:  RGB = agree ? C.humBrd  : C.mixBrd;
      const agrTxt:  RGB = agree ? C.humTxt  : C.mixTxt;
      rect(ML, y, CW, 10, agrFill, agrBrd);
      sf("bold", 7, agrTxt);
      tx(agree
        ? (judgment ? "Reviewer judgment agrees with automated signals." : "No reviewer judgment recorded - automated result stands.")
        : `Reviewer overrides automated result from "${autoVerdict}" to "${judgment}".`,
        ML + CW / 2, y + 6.5, { align: "center" });
      y += 16;
    }

    hRule(y); y += 5;

    // Signature line
    sf("bold", 8, C.s800); tx("Reviewer Sign-off", ML, y); y += 6;
    const sigLineY = y + 8;
    sf("normal", 7, C.s600); tx("Name / Designation:", ML, y + 4);
    doc.setDrawColor(...C.s400); doc.setLineWidth(0.3);
    doc.line(ML + 38, sigLineY, ML + 38 + 80, sigLineY);
    sf("normal", 7, C.s600); tx("Date:", ML + 130, y + 4);
    doc.line(ML + 143, sigLineY, PW - MR, sigLineY);
    y += 14;
    sf("normal", 7, C.s600); tx("Signature:", ML, y + 4);
    doc.line(ML + 22, y + 8, ML + 22 + 96, y + 8);
    y += 18;

    hRule(y); y += 4;
    sf("normal", 6, C.s400);
    tx("This judgment was recorded at the time of report generation and reflects the reviewer's contextual assessment.", ML, y + 4);
    tx("Automated signals are one input only - final determination rests with the qualified reviewer.", ML, y + 8);
  } // end if (perpResult && burstResult)

  // ── Page numbers ──────────────────────────────────────────────────────────
  const pageTotal = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageTotal; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal"); doc.setFontSize(6.5); doc.setTextColor(148, 163, 184);
    doc.text(`Page ${p} of ${pageTotal}  -  AI Content Detection Report  -  ${dateStr}`, PW / 2, PH - 7, { align: "center" });
  }

  doc.save(`ai-detection-report-${now.toISOString().slice(0, 10)}.pdf`);
}


// ─────────────────────────────────────────────────────────────────────────────
//  SHARED UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  // Improvement 3: comprehensive abbreviation-aware splitting
  // Protect all common abbreviation patterns before splitting on periods.
  const masked = text
    // Academic / citation abbreviations
    .replace(/\bet\s+al\./gi, "et al#")
    .replace(/\b(Fig|Vol|No|pp|ed|eds|cf|vs|ibid|etc|approx|approx|dept|div|est|govt|intl|natl|univ|prof|assoc|corp|inc|ltd|co|jr|sr)\./gi, m => m.replace(".", "#"))
    // Common honorifics and titles
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Rev|Fr|Sr|Sgt|Cpl|Pvt|Capt|Maj|Col|Gen|Lt|Adm|Pres|Gov|Sen|Rep|Hon)\./gi, m => m.replace(".", "#"))
    // Inline citations like (Smith, 2020) or (Jones et al., 2019)
    .replace(/(\(\w[^)]*),?\s*\d{4}\)/g, m => m.replace(/\./g, "#"))
    // Latin abbreviations
    .replace(/\b(e\.g|i\.e|viz|op\.cit|loc\.cit|ca|c\.)\./gi, m => m.replace(/\./g, "#"))
    // Numbered list items: "1." "2." at start of token are not sentence ends
    .replace(/(\s)(\d{1,2})\.\s+([A-Z])/g, (_, sp, num, cap) => `${sp}${num}# ${cap}`)
    // Single-letter initials in names like "J. Smith" or "A.I."
    .replace(/\b([A-Z])\.\s+([A-Z][a-z])/g, (_, init, next) => `${init}# ${next}`)
    .replace(/\b([A-Z])\.([A-Z])\./g, (_, a, b) => `${a}#${b}#`);

  const results: string[] = [];
  const re = /[^.!?]*[.!?]+/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(masked)) !== null) {
    const seg = text.slice(m.index, m.index + m[0].length).trim();
    if (seg.length > 5) results.push(seg);
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail.length > 5) results.push(tail);
  return results.length > 0 ? results : [text];
}

const TRUE_CONTRACTION_RE = /\b(don't|doesn't|didn't|can't|won't|wouldn't|couldn't|shouldn't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|I'm|I've|I'll|I'd|we're|we've|we'll|we'd|you're|you've|you'll|you'd|they're|they've|they'll|they'd|it's|that's|there's|here's|what's|who's|let's)\b/gi;

// ─────────────────────────────────────────────────────────────────────────────
//  INTERFACES
// ─────────────────────────────────────────────────────────────────────────────

// Evidence strength follows the spec: LOW / MEDIUM / HIGH / INCONCLUSIVE
type EvidenceStrength = "INCONCLUSIVE" | "LOW" | "MEDIUM" | "HIGH";

// Per-sentence attribution - no binary label
interface SentenceResult {
  text: string;
  // 0-100 likelihood score (NOT shown as a single verdict)
  likelihood: number;
  // What signals fired on this sentence
  signals: string[];
  // Conservative label for colouring only
  label: "uncertain" | "moderate" | "elevated";
}

interface SignalResult {
  name: string;
  value: string;
  // Strength 0-100 for the bar
  strength: number;
  // Did this signal point toward AI or clear AI suspicion?
  pointsToAI: boolean;
  // Is this signal well-supported (multiple independent sub-signals)?
  wellSupported: boolean;
}

interface EngineResult {
  // Raw 0-100 internal score - NEVER shown as the primary result
  internalScore: number;
  // Confidence interval [low, high] - shown to user
  confidenceLow: number;
  confidenceHigh: number;
  // Conservative human-readable verdict
  evidenceStrength: EvidenceStrength;
  // Human-readable verdict phrase
  verdictPhrase: string;
  // What fired
  signals: SignalResult[];
  // Per-sentence
  sentences: SentenceResult[];
  // Metadata
  wordCount: number;
  sentenceCount: number;
  // Disagreement flag - if engines disagree, downgrade certainty
  agreesWithOther?: boolean;
  // Whether text has features that reduce reliability
  reliabilityWarnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  VOCABULARY - Three-tier system (Improvement 1: tiered vocab scoring)
//
//  STRONG  — Words essentially never used organically by humans; almost
//            exclusively appear in LLM output. Each hit carries full weight.
//  MEDIUM  — Elevated / formal words that AI overuses but which occasionally
//            appear in human business/academic writing. Partial weight.
//  WEAK    — Common academic/formal words included for pattern completeness.
//            Require 3+ hits to score, and at heavily reduced weight.
//
//  The combined AI_VOCAB set is the union of all three — used wherever a
//  simple membership test is needed (ESL gate, intra-doc shift, etc.).
//  Per-signal scoring uses tier-weighted hit counts.
// ─────────────────────────────────────────────────────────────────────────────

// STRONG tier: words almost never used organically by humans
const AI_VOCAB_STRONG = new Set([
  "leverage","leverages","leveraged","leveraging",
  "utilize","utilizes","utilized","utilizing",
  "streamline","streamlines","streamlined","streamlining",
  "holistic","multifaceted","transformative","groundbreaking","unprecedented",
  "synergy","proactive","actionable","scalability",
  "fostering","empowering","harnessing","catalyzing",
  "delve","delves","delved","delving",
  "tapestry","cornerstone","linchpin","hallmark","bedrock",
  "synergize","synergistic","nexus","convergence",
  "reimagine","rethink","redefine","reshape","reinvent","recalibrate",
  "unlock","unleash","actualize",
  "multifarious","salient","delineate","elucidate","substantiate",
  "commendable","exemplary","paramount","meticulous",
  "spearhead","champion","propel","amplify",
  "cutting-edge","state-of-the-art",
  "culmination","manifestation","embodiment",
  "pervasive","ubiquitous","plethora","myriad","gamut","constellation",
  "poignant","thought-provoking",
  "mosaic","canvas","palette",
  "scaffold","bespoke","curated","impactful","intentional",
  "wellbeing","mindfulness","milestones",
  "symbiotic","reciprocal","iterative",
  "ethos","tenets","pillars",
  "overarching","underpinning",
  "fosters","nurtures","cultivates","cultivate","nurture",
  "incentivize","incentivizes","operationalize","democratize","democratizes",
  "unpack","unpacking",
  "complexities","intricacies",
  "tailored","impactful",
  // Technical ML terms rarely used by non-ML humans
  "pretrained","generative","discriminative",
  "regularization","embedding","inference","transformer",
  // GPT-4o / Claude 3.5 / Gemini era patterns (2024-2025)
  "nuanced approach","sophisticated understanding","multifaceted challenge",
  "interconnected","intertwined","interwoven",
  "game-changing","paradigm-shifting","forward-thinking",
  "thought leadership","value-driven","purpose-driven","mission-driven",
  "co-create","co-design","co-develop",
  "future-proof","future-ready","future-focused",
  "data-driven","evidence-based","research-backed",
  "best-in-class","world-class","industry-leading",
  "next-generation","cutting-edge","state-of-the-art",
  "end-to-end","full-stack","360-degree",
]);

// MEDIUM tier: elevated but plausible in careful human writing
const AI_VOCAB_MEDIUM = new Set([
  "facilitate","facilitates","facilitated","facilitating",
  "optimize","optimizes","optimized","optimizing",
  "robust","seamless","scalable","pivotal","foundational",
  "paradigm","ecosystem","stakeholder",
  "furthermore","moreover","additionally","consequently",
  "nevertheless","nonetheless","accordingly","subsequently",
  "intricate","nuanced","pertinent",
  "illuminate","resonate","noteworthy",
  "indispensable","imperative","comprehensive","adhere",
  "navigate","foster","thrive","vibrant","crucial","vital","ensure",
  "mitigate","alleviate","enhance","bolster","reinforce","strengthen","underpin",
  "elevate","accelerate",
  "innovative","dynamic","cohesive","coherent",
  "integration","framework","paradigm","blueprint","roadmap","trajectory","spectrum",
  "realm","domain","sphere","arena","pathway","conduit",
  "interplay","intersection",
  "underpins","underscored","underpinned","underscore",
  "pivotal","integral","inherent","endemic",
  "profound","insightful","compelling","nuance",
  "groundwork","infrastructure","backbone",
  "resilient","agile","adaptive","responsive","nimble",
  "seamlessly","strategically","systematically","intrinsically",
  "benchmark","pipeline",
  "nuanced",
  "dive","dives","dived","diving",
  "symbiotic","systemic","stance",
  "journey","trajectory",
  "shed","shedding",
  "prioritize","prioritizes","prioritized","prioritizing",
  "contextualize","contextualizes","contextualized",
  "mindful","self-care",
  "harness","leverage","capitalize",
]);

// WEAK tier: common academic words that alone are unreliable signals
const AI_VOCAB_WEAK = new Set([
  "explore","explores","explored","exploring",
  "examine","examines","examined","examining",
  "highlight","highlights","highlighted","highlighting",
  "emphasize","emphasizes","emphasized","emphasizing",
  "acknowledge","acknowledges","acknowledged","acknowledging",
  "recognize","recognizes","recognized","recognizing",
  "distinguish","distinguishes","distinguished","distinguishing",
  "encompass","encompasses","encompassed","encompassing",
  "incorporate","incorporates","incorporated","incorporating",
  "demonstrate","demonstrates","demonstrated","demonstrating",
  "illustrate","illustrates","illustrated","illustrating",
  "meaningful","wellbeing",
  "effectively","efficiently","fundamentally","essentially","ultimately","critically",
  "empower","empowers","empowered",
]);

// Union set for fast membership tests elsewhere in the code
const AI_VOCAB = new Set([
  ...AI_VOCAB_STRONG,
  ...AI_VOCAB_MEDIUM,
  ...AI_VOCAB_WEAK,
]);

// Tier-weighted vocab hit count: strong=3pts, medium=1.5pts, weak=0.5pts
// Returns a single weighted score used to replace raw hit counts in vocabScore.
function weightedVocabHits(words: string[]): { weighted: number; strongHits: number; mediumHits: number; weakHits: number } {
  let strong = 0, medium = 0, weak = 0;
  for (const w of words) {
    if (AI_VOCAB_STRONG.has(w)) strong++;
    else if (AI_VOCAB_MEDIUM.has(w)) medium++;
    else if (AI_VOCAB_WEAK.has(w)) weak++;
  }
  const weighted = strong * 3 + medium * 1.5 + (weak >= 3 ? weak * 0.5 : 0);
  return { weighted, strongHits: strong, mediumHits: medium, weakHits: weak };
}

// AI-specific multi-word phrases (Turnitin/GPTZero aligned — strict)
const AI_BIGRAMS = new Set([
  "plays a crucial","plays a pivotal","plays a key","plays a significant","plays a vital",
  "it is worth","it is important","it is crucial","it should be",
  "cannot be overstated","cannot be understated",
  "in today's world","in today's society","in the modern world","in the modern era",
  "in order to ensure","in order to achieve","in order to maintain",
  "it is important to note","it is worth noting","it should be noted",
  "as we can see","as we have seen","as previously mentioned",
  // Structural AI conclusion/transition openers
  "in conclusion","in summary","to summarize","to sum up","to conclude",
  "not only","but also",
  // AI academic essay formula openers
  "one of the","one of the most","one of the key","one of the defining",
  "despite its","despite these","despite the",
  "for example in","such applications","such systems","such approaches",
  "in academic research","in real-world","in real world",
  // AI responsibility stacking
  "responsible design","ethical considerations","socially responsible",
  "transparent fair","fair and accountable","ethical implications",
  "not only technical","not only on technical",
  // Additional GPTZero/Turnitin-style patterns
  "it is essential","it is imperative","it is necessary",
  "plays an important","plays an essential","plays an integral",
  "a wide range","a wide variety","a broad range","a diverse range",
  "there are several","there are many","there are various","there are numerous",
  "has been widely","has been extensively","has been increasingly",
  "in recent years","over the past","over the years","throughout history",
  "at the same time","on the other hand","on the contrary",
  "with the advent","with the rise","with the emergence","with the increasing",
  "in the field of","in the realm of","in the context of","in the domain of",
  "the importance of","the role of","the impact of","the significance of",
  "first and foremost","last but not least","needless to say",
  "this essay will","this paper will","this article will","this study will",
  "we will explore","we will examine","we will discuss","we will analyze",
  "by doing so","in doing so","having said that","that being said",
  "it goes without saying","it stands to reason","it is clear that",
  "a crucial role","a pivotal role","a vital role","a significant role","an important role",
  "the key to","the foundation of","the cornerstone of","the backbone of",
  "moving forward","going forward","looking ahead","in the future",
  "overall it","overall this","overall these","in essence",
  "to be sure","to be clear","to be fair","without a doubt",
  "both in terms","in terms of","with respect to","with regard to",
  "a variety of","a plethora of","a myriad of","a host of",
  "is closely related","is directly related","is strongly related",
  "ensuring that","ensuring the","ensuring a",
  "in light of","in view of","in consideration of",
  "it can be","it could be","it may be","it might be argued",
  "as a result","as a consequence","as such","in turn",
  "contribute to","contributes to","contributed to","contributing to",
  // ── Claude / modern-LLM multi-word patterns (AV041–060 gap fix) ────────────
  "let's explore","let us explore","let's examine","let us examine",
  "let's dive","let us dive","let's unpack","let us unpack",
  "dive deeper","delve deeper","dig deeper",
  "shed light on","sheds light on","worth noting that","worth exploring",
  "at its core","at the heart of","at the core of",
  "when we consider","when we examine","when we think about",
  "it's worth noting","it's important to","it's worth considering",
  "this is particularly","this is especially","this is increasingly",
  "a nuanced understanding","a deeper understanding","a more nuanced",
  "complex interplay","intricate relationship","multifaceted nature",
  "the nuances of","the complexities of","the intricacies of",
  "navigating the","navigating this","navigating these",
  "raises important","raises critical","raises significant",
  "offers valuable","provides valuable","offers a unique",
  "to this end","to that end",
  "what makes this","what sets this","what distinguishes",
  "one must consider","one must acknowledge","one must recognize",
  "sets the stage","lays the groundwork","paves the way",
  "in this context","in this regard","in this respect",
  "it is noteworthy","it is notable","it is remarkable",
  "deeply rooted","deeply ingrained","deeply embedded",
  "stands as a","serves as a","acts as a",
  "a testament to","testament to the","speaks to the",
  "can be seen","can be observed","can be understood",
  "more broadly","more specifically","more importantly","more fundamentally",
  "not surprisingly","unsurprisingly","not unexpectedly",
  "worth emphasizing","worth highlighting","worth mentioning",
  "think about it","consider this","consider the fact",
]);

// AI transition patterns — strict/expanded (Turnitin/GPTZero aligned)
const AI_TRANSITIONS = [
  /(furthermore|moreover|additionally|consequently|nevertheless|nonetheless|accordingly|subsequently)/gi,
  /(in conclusion|to summarize|to sum up|in summary|to conclude|in closing|to recap)/gi,
  /(it is (important|crucial|essential|vital|necessary|imperative) to note that)/gi,
  /(it is worth (noting|mentioning|considering|highlighting|emphasizing) that)/gi,
  /(plays? a (crucial|pivotal|vital|key|significant|important|central|integral) role in)/gi,
  /(in (today's|the modern|the current|the contemporary) (world|society|era|landscape|age|climate))/gi,
  /(cannot be (overstated|understated|emphasized enough|ignored|overlooked))/gi,
  /(in order to (ensure|achieve|maintain|support|address|improve|facilitate|promote))/gi,
  /(as (we|you) can see|as (we|you) have seen|as previously mentioned|as noted above|as discussed)/gi,
  /(first and foremost|last but not least|needless to say|it goes without saying)/gi,
  /(that being said|having said that|with that in mind|with this in mind)/gi,
  /(on the other hand|on the contrary|by the same token)/gi,
  /(it is (clear|evident|apparent|obvious|undeniable) that)/gi,
  /(this (essay|paper|article|study|report|piece) (will|aims|seeks|intends))/gi,
  /(moving forward|going forward|looking ahead)/gi,
  /(a (plethora|myriad|wide range|broad range|host|wide variety) of)/gi,
  /(it (can|could|may|might) be (argued|said|noted|suggested|observed) that)/gi,
  /(in (the context|the realm|the domain|the field|the landscape|the sphere) of)/gi,
  /(overall[,\s]+(it|this|these|the))/gi,
  // ── Claude / modern-LLM transition patterns (AV041–060 gap fix) ────────────
  /(let('?s| us) (explore|examine|dive|unpack|consider|look at|think about))/gi,
  /(it'?s (worth|important|crucial|essential) (noting|considering|examining|exploring|mentioning|emphasizing))/gi,
  /(shed(s|ding)? light on)/gi,
  /(at (its|the) (core|heart)(\s+of)?)/gi,
  /(when (we|you|one) (consider|examine|look at|think about|reflect on))/gi,
  /(this is (particularly|especially|notably|increasingly) (important|relevant|significant|noteworthy|interesting|complex))/gi,
  /(navigat(e|es|ing|ed) (the|this|these|a|an|its|their))/gi,
  /(the (nuances|complexities|intricacies|subtleties|dynamics) of)/gi,
  /(raises? (important|critical|significant|key|fundamental) (questions?|concerns?|issues?|points?|considerations?))/gi,
  /(offer(s|ing)? (valuable|important|critical|unique|deeper) (insights?|perspective|understanding|clarity))/gi,
  /(to (this|that) end[,\s])/gi,
  /(what (makes|sets|distinguishes) (this|it|them|these|the))/gi,
  /(one (must|should|needs? to|ought to) (consider|acknowledge|recognize|note|understand))/gi,
  /(stands? as (a|an|the) (testament|example|reminder|illustration|embodiment))/gi,
  /(serve(s|d)? as (a|an|the) (foundation|cornerstone|reminder|catalyst|bridge|lens))/gi,
  /(more (broadly|specifically|importantly|fundamentally|generally)[,\s])/gi,
  /(not (surprisingly|unexpectedly|coincidentally)[,\s])/gi,
  /(deeply (rooted|ingrained|embedded|connected|intertwined))/gi,
  /(speak(s|ing)? to (the|a|an|its|their) (importance|significance|complexity|nature|power|need))/gi,
];

function countTransitions(text: string): number {
  let n = 0;
  AI_TRANSITIONS.forEach(p => { const m = text.match(p); if (m) n += m.length; });
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #2 — PARAGRAPH-OPENING FINGERPRINT
//  AI essays are most robotic at paragraph boundaries. They overwhelmingly open
//  with transition phrases or topic-sentence formulas. Human writers vary their
//  paragraph openers with questions, fragments, proper nouns, dates, quotes, etc.
//
//  Returns: { roboticOpeners, totalParas, score }
//  Score 0-30. Fires when ≥ 3 of 4+ paragraphs open with an AI formula.
// ─────────────────────────────────────────────────────────────────────────────

const PARA_OPENER_AI_RE = [
  /^(furthermore|moreover|additionally|consequently|nevertheless|nonetheless|accordingly|subsequently)\b/i,
  /^(in conclusion|to summarize|to sum up|in summary|to conclude|in closing|overall)\b/i,
  /^(it is (important|crucial|essential|vital|necessary|worth) (to|that|noting))/i,
  /^(one of the (most|key|main|primary|central|fundamental|defining))\b/i,
  /^(the (role|importance|impact|significance|concept|notion|idea|need|challenge|fact) of)\b/i,
  /^(this (paper|essay|article|study|report|section|chapter) (will|aims|seeks|explores|examines|discusses|analyzes|presents|highlights))\b/i,
  /^(in (today's|the modern|the current|the contemporary) (world|society|era|landscape|age))\b/i,
  /^(as (we|you) (can see|have seen|explore|examine|discussed?|noted?|mentioned?))\b/i,
  /^(with (the advent|the rise|the emergence|the increasing|the development|the growth))\b/i,
  /^(when (we|you|one) (consider|examine|look at|think about|reflect on))\b/i,
  /^(understanding\b|exploring\b|examining\b|analyzing\b|addressing\b|navigating\b)/i,
  /^(to (understand|explore|examine|address|fully grasp|achieve|ensure|effectively))\b/i,
  /^(by (understanding|exploring|examining|leveraging|implementing|adopting|utilizing))\b/i,
  /^(given (the|that|these|this|its|their)\b)/i,
  /^(another (key|important|crucial|significant|critical|major|notable) (aspect|factor|point|consideration|element|dimension))\b/i,
  /^(despite (this|these|the|its|their))\b/i,
  /^(building (on|upon) (this|these|the|that))\b/i,
  /^(taken together[,\s]|considered together[,\s]|in (light|view) of (this|these))/i,
];

function paragraphOpenerFingerprint(text: string): { roboticOpeners: number; totalParas: number; score: number; details: string } {
  const paras = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 30);
  if (paras.length < 3) return { roboticOpeners: 0, totalParas: paras.length, score: 0, details: "Insufficient paragraphs for opener analysis (need ≥3)." };

  let robotic = 0;
  const roboticExamples: string[] = [];
  for (const para of paras) {
    // Get the first ~12 words of the paragraph (opener)
    const opener = para.replace(/\s+/g, " ").slice(0, 80);
    const isRobotic = PARA_OPENER_AI_RE.some(re => re.test(opener));
    if (isRobotic) {
      robotic++;
      if (roboticExamples.length < 3) roboticExamples.push(`"${opener.slice(0, 45)}…"`);
    }
  }

  const ratio = robotic / paras.length;
  let score = 0;
  // Scoring: human writers almost never open 3+ consecutive paragraphs with formulas
  if (ratio >= 0.85 && paras.length >= 4) score = 30;
  else if (ratio >= 0.70 && paras.length >= 4) score = 24;
  else if (ratio >= 0.55 && paras.length >= 3) score = 18;
  else if (ratio >= 0.40 && paras.length >= 4) score = 12;
  else if (ratio >= 0.25) score = 6;

  const details = score > 0
    ? `${robotic}/${paras.length} paragraphs (${(ratio*100).toFixed(0)}%) open with AI formula openers. Examples: ${roboticExamples.join("; ")}. Human writers vary paragraph openers; AI consistently uses transitional or topic-sentence formulas.`
    : `${robotic}/${paras.length} paragraphs open with formula openers — within human range.`;

  return { roboticOpeners: robotic, totalParas: paras.length, score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #3 — CONCLUSION-SECTION AMPLIFIER
//  AI essays cluster ethics/responsibility/transparency qualifiers specifically
//  at the end. The document-level ethics signal fires too weakly when body
//  paragraphs are borderline but the conclusion is textbook AI.
//
//  This function analyses the LAST 20% of the text separately with heightened
//  weights and returns a bonus score (0-22) added on top of ethicsScore.
// ─────────────────────────────────────────────────────────────────────────────

function conclusionSectionBoost(text: string): { score: number; details: string } {
  const words = text.split(/\s+/);
  const cutoff = Math.floor(words.length * 0.80);
  const tail = words.slice(cutoff).join(" ");
  const tailWC = Math.max(words.length - cutoff, 1);

  if (tailWC < 30) return { score: 0, details: "Text tail too short for conclusion analysis." };

  // Ethics/responsibility term density in tail
  const tailEthicsTerms = (tail.match(/\b(responsible|transparency|transparent|fair|fairness|accountable|accountability|ethical|ethics|equitable|socially responsible|privacy|bias|inclusive|stakeholder|govern|governance|oversight|regulation|regulatory|trustworthy|trust|safe|safety|wellbeing|well-being|moral|morality|sustainable|sustainability)\b/gi) || []).length;
  const tailEthicsRate = tailEthicsTerms / tailWC;

  // Conclusion clichés that appear almost exclusively at the end of AI essays
  const conclusionClicheCount = (tail.match(
    /(in conclusion|to summarize|to sum up|in summary|to conclude|in closing|ultimately[,\s]|as (we|you) have (seen|explored|examined|discussed)|it is (clear|evident|apparent) that|the (future|path|way|road) (forward|ahead)|as (technology|society|we|the field) (continues?|evolv|advance|progress|move))/gi
  ) || []).length;

  let score = 0;
  if (tailEthicsRate > 0.04 && tailEthicsTerms >= 3 && conclusionClicheCount >= 1) score = 22;
  else if (tailEthicsRate > 0.03 && tailEthicsTerms >= 2) score = 16;
  else if (tailEthicsTerms >= 3 && conclusionClicheCount >= 2) score = 14;
  else if (conclusionClicheCount >= 2) score = 10;
  else if (tailEthicsTerms >= 2 || conclusionClicheCount >= 1) score = 5;

  const details = score > 0
    ? `Last ~20% of text: ${tailEthicsTerms} ethics/governance terms (${(tailEthicsRate*100).toFixed(1)}%), ${conclusionClicheCount} conclusion cliché(s). AI essays systematically concentrate ethics qualifiers and wrap-up phrases at the end.`
    : `Conclusion section shows no unusual ethics/cliché clustering.`;

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #1 — PASSIVE VOICE & SYNTACTIC UNIFORMITY
//  AI models default to subject-verb-complement (SVC) sentence construction and
//  overuse passive voice constructions. Human writers use more varied syntax:
//  fronted adverbials, relative clauses, fragments, inverted sentences.
//
//  Returns a score 0-28.
// ─────────────────────────────────────────────────────────────────────────────

function passiveVoiceAndSyntaxScore(text: string, sentences: string[]): { score: number; passiveCount: number; details: string } {
  if (sentences.length < 5) return { score: 0, passiveCount: 0, details: "Insufficient sentences for syntactic analysis." };

  // Passive voice: "is/are/was/were/has been/have been/had been/will be/can be/may be/should be + past participle"
  const passiveRe = /\b(is|are|was|were|has been|have been|had been|will be|can be|could be|may be|might be|should be|must be|would be)\s+(being\s+)?[a-z]{3,}(ed|en|t)\b/gi;
  const passiveMatches = text.match(passiveRe) || [];
  const passiveCount = passiveMatches.length;
  const passiveRate = passiveCount / Math.max(sentences.length, 1);

  // Syntactic variety markers that AI avoids:
  // - Fronted adverbials: "Despite X, ...", "While X, ...", "Although X, ..."
  // - Inverted sentences with emphasis: "Only then did...", "Not until..."
  // - Direct address: "Consider this:", "Think about...", "Notice how..."
  // - Sentence fragments used for effect (very short sentences: 1-3 words)
  const fronted = (text.match(/^(Despite|While|Although|Even though|Whereas|Since|Once|After|Before|Until|When|If)[^.!?]{10,},/gim) || []).length;
  const invertedEmphasis = (text.match(/\b(Only (then|after|when|if|by)|Not (until|only|once)|Rarely do|Never (have|did|does))/gi) || []).length;
  const fragments = sentences.filter(s => s.trim().split(/\s+/).length <= 3).length;

  // SVC uniformity: sentences that start with "The/A/An/This/These/It/AI/The system..."
  // and follow the basic subject-first template
  const svcOpeners = sentences.filter(s =>
    /^(The |A |An |This |These |It |AI |Machine |Deep |Such |One |Another |Each |Every |Many |Most |Some |Several |Various )/i.test(s.trim())
  ).length;
  const svcRatio = svcOpeners / sentences.length;

  // Score: high passive rate + high SVC uniformity + low syntactic variety = AI
  let score = 0;

  // Passive voice signal (AI overuses passive in academic writing)
  if (passiveRate >= 0.5) score += 14;
  else if (passiveRate >= 0.35) score += 10;
  else if (passiveRate >= 0.20) score += 5;

  // SVC monotony penalty (offset by syntactic variety)
  const varietyBonus = Math.min(10, fronted * 2 + invertedEmphasis * 3 + fragments * 2);
  if (svcRatio >= 0.75 && varietyBonus < 4) score += 14;
  else if (svcRatio >= 0.65 && varietyBonus < 6) score += 8;
  else if (svcRatio >= 0.55 && varietyBonus < 4) score += 4;

  // Reduce score for texts with rich syntactic variety
  score = Math.max(0, score - Math.floor(varietyBonus * 0.6));
  score = Math.min(28, score);

  const details = score > 0
    ? `Passive voice: ${passiveCount} instances (${passiveRate.toFixed(2)}/sentence). SVC-opener ratio: ${(svcRatio*100).toFixed(0)}% of sentences. Syntactic variety markers: ${fronted} fronted adverbials, ${invertedEmphasis} inverted constructions, ${fragments} short fragments. AI defaults to passive/SVC construction; human writers use more structural variety.`
    : `Passive voice rate ${passiveRate.toFixed(2)}/sentence — within human range. Fronted adverbials: ${fronted}, fragments: ${fragments}.`;

  return { score, passiveCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTRA-DOCUMENT ANALYSIS
//  Compare first half vs second half for vocabulary and rhythm shifts.
//  Sudden shifts in AI-signal density suggest hybrid or partial AI text.
// ─────────────────────────────────────────────────────────────────────────────

function intraDocumentShift(sentences: string[]): {
  shiftScore: number;
  description: string;
} {
  if (sentences.length < 6) return { shiftScore: 0, description: "insufficient sentences for intra-document analysis" };

  // ── Half-document shift (original method) ────────────────────────────────
  const mid = Math.floor(sentences.length / 2);
  const firstHalf  = sentences.slice(0, mid);
  const secondHalf = sentences.slice(mid);

  const halfVocabRate = (half: string[]) => {
    const words = half.join(" ").toLowerCase().match(/\b[a-z]+\b/g) || [];
    const wc = Math.max(words.length, 1);
    return words.filter(w => AI_VOCAB.has(w)).length / wc;
  };
  const halfBurstCV = (half: string[]) => {
    const lens = half.map(s => s.trim().split(/\s+/).length);
    const avg = lens.reduce((a, b) => a + b, 0) / Math.max(lens.length, 1);
    const variance = lens.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / Math.max(lens.length, 1);
    return Math.sqrt(variance) / Math.max(avg, 1);
  };

  const vocabShift = Math.abs(halfVocabRate(firstHalf) - halfVocabRate(secondHalf));
  const burstShift = Math.abs(halfBurstCV(firstHalf)   - halfBurstCV(secondHalf));
  const halfShift  = Math.min(100, Math.round(vocabShift * 400 + burstShift * 200));

  // ── Per-sentence AI likelihood variance (NEW — catches interleaved hybrid) ─
  // Compute a quick per-sentence AI likelihood score, then measure the standard
  // deviation across sentences. High variance = some sentences are very AI-like
  // while others are very human-like — the hallmark of hybrid/paste-in text.
  // This catches S026 and S030 where a human voice sentence is immediately
  // followed by an inserted AI sentence.
  const AI_TRANS_QUICK = [
    /\b(furthermore|moreover|additionally|consequently|nevertheless|nonetheless)\b/gi,
    /\b(in conclusion|to summarize|to conclude|in summary)\b/gi,
    /\b(it is important to note|it is worth noting|plays a (crucial|pivotal|vital) role)\b/gi,
    /\b(cannot be (overstated|understated)|in order to (ensure|achieve|maintain))\b/gi,
  ];
  const sentLikelihoods = sentences.map(sent => {
    const sw = sent.toLowerCase().match(/\b[a-z]+\b/g) || [];
    const swc = Math.max(sw.length, 1);
    let score = 0;
    // Vocab hits
    const vHits = sw.filter(w => AI_VOCAB.has(w)).length;
    score += Math.min(50, vHits * 12);
    // Transition hits
    AI_TRANS_QUICK.forEach(p => { if (p.test(sent)) score += 20; });
    // Human voice markers reduce score
    if (/\b(I |I'm |I've |my |we |our )/i.test(sent))           score -= 20;
    if (/\b(yeah|yep|nope|gonna|wanna|kinda|honestly|weird)\b/i.test(sent)) score -= 25;
    if (/\?/.test(sent))                                          score -= 10;
    if (/\.{3}/.test(sent))                                       score -= 8;
    if (sw.length <= 5)                                           score -= 15;
    return Math.min(100, Math.max(0, score));
  });

  // Variance of per-sentence likelihoods
  const meanL = sentLikelihoods.reduce((a, b) => a + b, 0) / sentLikelihoods.length;
  const varL  = sentLikelihoods.reduce((s, l) => s + Math.pow(l - meanL, 2), 0) / sentLikelihoods.length;
  const sdL   = Math.sqrt(varL);

  // High SD (>18) with meanL in 15–75 range = hybrid: mixed human+AI sentences
  // Low SD with high meanL = pure AI; Low SD with low meanL = pure human
  const hybridSignal = meanL > 15 && meanL < 75 && sdL > 18;
  const hybridScore  = hybridSignal ? Math.min(100, Math.round(sdL * 2.5)) : 0;

  // Combine both methods
  const shiftScore = Math.min(100, Math.round((halfShift + hybridScore) / 2));

  let description = "consistent style throughout document";
  if (hybridSignal && hybridScore > 40) description = `high sentence-to-sentence AI variance (SD=${sdL.toFixed(1)}) - strong hybrid/mixed authorship signal`;
  else if (shiftScore > 60) description = "significant style shift detected - possible hybrid or partially AI-edited text";
  else if (shiftScore > 30) description = "moderate style variation between sections";

  return { shiftScore, description };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #1 — HEDGED-CERTAINTY FINGERPRINT
//  AI essays hedge every empirical claim: "may", "can often", "generally",
//  "tends to", "in many cases", "it is possible". A human editorial uses hedges
//  sparingly and purposefully; AI layers them on every sentence as a safety
//  mechanism. Rate: hedges per 100 words.  Score: 0–28.
// ─────────────────────────────────────────────────────────────────────────────

const HEDGE_TERMS_RE = /\b(may|might|could|can|often|generally|typically|usually|sometimes|frequently|commonly|largely|broadly|perhaps|possibly|potentially|arguably|seemingly|apparently|presumably|ostensibly|in many cases|in some cases|in certain cases|to some extent|to a certain extent|to some degree|in most cases|tends? to|is likely|are likely|it is possible|it is likely|it seems|it appears|it suggests|it implies|it indicates|one might|one could|it can be|it may be|it might be|this may|this might|this could|this can|these may|these might|under certain|under some|depending on|varies? (by|with|across)|subject to|not always|not necessarily|in general|as a general rule|broadly speaking|for the most part|by and large|more or less|to varying degrees?)\b/gi;

function hedgedCertaintyScore(text: string, wc: number): { score: number; hedgeCount: number; details: string } {
  const hedgeMatches = text.match(HEDGE_TERMS_RE) || [];
  const hedgeCount = hedgeMatches.length;
  const hedgeRate = (hedgeCount / Math.max(wc, 1)) * 100; // per 100 words

  let score = 0;
  if (hedgeRate >= 6.0) score = 28;
  else if (hedgeRate >= 4.5) score = 22;
  else if (hedgeRate >= 3.0) score = 16;
  else if (hedgeRate >= 2.0) score = 10;
  else if (hedgeRate >= 1.2) score = 5;

  const details = score > 0
    ? `${hedgeCount} epistemic hedges found (${hedgeRate.toFixed(1)}/100 words). AI systematically softens every claim with "may", "generally", "tends to", "it is possible" etc. Human writers hedge purposefully, not by default.`
    : `${hedgeCount} hedges (${hedgeRate.toFixed(1)}/100 words) — within normal human range.`;
  return { score, hedgeCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #2 — SENTENCE-FINAL CLAUSE STACKING
//  AI appends 2–3 subordinate clauses to most sentences:
//  "…which enables X, thereby ensuring Y, ultimately contributing to Z."
//  No existing signal measures trailing comma-clause density.
//  Score: 0–24.
// ─────────────────────────────────────────────────────────────────────────────

const CLAUSE_STACKER_RE = /,\s*(which|that|thereby|thus|therefore|hence|consequently|as a result|ultimately|ensuring|allowing|enabling|making it|making them|contributing to|leading to|resulting in|facilitating|fostering|promoting|supporting|demonstrating|highlighting|illustrating|reinforcing|strengthening|underpinning)/gi;

function clauseStackingScore(sentences: string[]): { score: number; stackedCount: number; details: string } {
  if (sentences.length < 4) return { score: 0, stackedCount: 0, details: "Insufficient sentences for clause-stacking analysis." };

  let stackedCount = 0;
  let totalTails = 0;
  for (const sent of sentences) {
    const matches = sent.match(CLAUSE_STACKER_RE) || [];
    if (matches.length >= 2) stackedCount++;
    totalTails += matches.length;
  }

  const avgTails = totalTails / sentences.length;
  const stackedRatio = stackedCount / sentences.length;

  let score = 0;
  if (avgTails >= 1.8 && stackedRatio >= 0.5) score = 24;
  else if (avgTails >= 1.3 && stackedRatio >= 0.35) score = 18;
  else if (avgTails >= 0.9 && stackedRatio >= 0.25) score = 12;
  else if (avgTails >= 0.5) score = 6;

  const details = score > 0
    ? `${stackedCount}/${sentences.length} sentences (${(stackedRatio*100).toFixed(0)}%) have 2+ trailing subordinate clauses. Avg ${avgTails.toFixed(2)} clause-stacking connectors/sentence. AI appends "which enables X, thereby ensuring Y, ultimately contributing to Z" chains; human writers rarely do this.`
    : `Low clause-stacking (avg ${avgTails.toFixed(2)} connectors/sentence) — within human range.`;
  return { score, stackedCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #3 — ABSENCE OF PROPER NOUNS / NAMED ENTITIES
//  Human writing references real people, places, dates, publications, products.
//  AI essays float in abstraction — they avoid concrete named references.
//  Heuristic: mid-sentence capitalised words that are NOT sentence-initial,
//  NOT in the AI_VOCAB set, and NOT common title words.
//  Score: 0–20 (HUMAN signal — more named entities → LOWER AI score).
//  Returns a reduction value (higher = more human-like, applied as penalty).
// ─────────────────────────────────────────────────────────────────────────────

const COMMON_CAPS_EXCEPTIONS = new Set([
  "I","The","A","An","In","On","At","By","For","With","This","These","Those",
  "That","It","Its","Their","Our","Your","He","She","We","They","As","But",
  "And","Or","If","When","While","Although","Because","Since","Until","After",
  "Before","During","However","Therefore","Furthermore","Moreover","Additionally",
  "Nevertheless","Nonetheless","Consequently","Subsequently","Accordingly",
  "January","February","March","April","May","June","July","August","September",
  "October","November","December","Monday","Tuesday","Wednesday","Thursday",
  "Friday","Saturday","Sunday","English","American","European","Asian","Global",
  "AI","LLM","ML","API","HTML","CSS","URL",
]);

function namedEntityScore(text: string, wc: number): { humanReduction: number; namedEntityCount: number; details: string } {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 5);
  let namedEntityCount = 0;

  for (const sent of sentences) {
    const trimmed = sent.trim();
    // Find mid-sentence words that start with a capital letter
    // Skip the very first word of the sentence (sentence-initial cap)
    const words = trimmed.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/[^a-zA-Z]/g, "");
      if (w.length >= 2 && /^[A-Z]/.test(w) && !COMMON_CAPS_EXCEPTIONS.has(w)) {
        namedEntityCount++;
      }
    }
  }

  const namedEntityRate = (namedEntityCount / Math.max(wc, 1)) * 100; // per 100 words

  // More named entities → more human-like → higher reduction applied to AI score
  let humanReduction = 0;
  if (namedEntityRate >= 3.0) humanReduction = 20;
  else if (namedEntityRate >= 2.0) humanReduction = 14;
  else if (namedEntityRate >= 1.0) humanReduction = 8;
  else if (namedEntityRate >= 0.5) humanReduction = 4;

  const details = namedEntityCount > 0
    ? `${namedEntityCount} named entities detected (${namedEntityRate.toFixed(1)}/100 words). Human writing references real people, places, and events. Higher named-entity density is a human-writing signal.`
    : `No named entities / proper nouns detected — AI essays typically avoid concrete named references.`;
  return { humanReduction, namedEntityCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #4 — MOVING-WINDOW TTR VARIANCE
//  The global TTR signal already exists. AI text's characteristic pattern is
//  vocabulary that stays uniformly low throughout — unlike human text which
//  varies in density by section. This sliding-window approach measures VARIANCE
//  of TTR across 50-word windows. Low variance = metronomic AI vocabulary rhythm.
//  Score: 0–22.
// ─────────────────────────────────────────────────────────────────────────────

function movingWindowTTRScore(words: string[], wc: number): { score: number; ttrVariance: number; details: string } {
  const WINDOW = 50;
  if (wc < WINDOW * 2) return { score: 0, ttrVariance: 0, details: `Text too short for moving-window TTR analysis (need ≥${WINDOW*2} words).` };

  const windowTTRs: number[] = [];
  for (let i = 0; i <= wc - WINDOW; i += Math.floor(WINDOW / 2)) {
    const windowWords = words.slice(i, i + WINDOW);
    const uniqueInWindow = new Set(windowWords).size;
    windowTTRs.push(uniqueInWindow / WINDOW);
  }

  if (windowTTRs.length < 3) return { score: 0, ttrVariance: 0, details: "Insufficient windows for TTR variance analysis." };

  const meanTTR = windowTTRs.reduce((a, b) => a + b, 0) / windowTTRs.length;
  const ttrVariance = windowTTRs.reduce((s, t) => s + Math.pow(t - meanTTR, 2), 0) / windowTTRs.length;
  const ttrSD = Math.sqrt(ttrVariance);

  // Low SD = AI-like metronomic vocabulary rhythm
  // High SD = human-like variation in vocabulary density across sections
  let score = 0;
  if (ttrSD < 0.015 && meanTTR < 0.55) score = 22;
  else if (ttrSD < 0.025 && meanTTR < 0.58) score = 16;
  else if (ttrSD < 0.040 && meanTTR < 0.62) score = 10;
  else if (ttrSD < 0.055) score = 5;

  // If high variance, apply a human reduction instead
  const humanReductionForHighVariance = ttrSD >= 0.07 ? 10 : 0;

  const details = score > 0
    ? `Moving-window TTR: mean=${meanTTR.toFixed(3)}, SD=${ttrSD.toFixed(4)} across ${windowTTRs.length} windows. Low TTR variance (SD<0.04) = AI metronomic vocabulary rhythm. Human writing shows greater section-to-section vocabulary variation.`
    : `Moving-window TTR SD=${ttrSD.toFixed(4)} (mean=${meanTTR.toFixed(3)}) — within human range${humanReductionForHighVariance > 0 ? " (high variance = strong human signal)" : ""}.`;

  return { score: Math.max(0, score - humanReductionForHighVariance), ttrVariance, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  RELIABILITY WARNINGS
//  Conditions that reduce confidence in any verdict
// ─────────────────────────────────────────────────────────────────────────────

function getReliabilityWarnings(text: string, wc: number, sentences: string[]): string[] {
  const warnings: string[] = [];

  // Too short — only flag very short texts (strict mode: 50 word minimum)
  if (wc < 50) warnings.push("Text too short for reliable analysis (fewer than 50 words)");

  // Technical or domain-specific writing - vocab signals less meaningful
  const techTerms = (text.match(/\b(algorithm|neural|dataset|machine learning|deep learning|neural network|python|javascript|api|http|sql|database|function|variable|class|object|array|string|integer|boolean)\b/gi) || []).length;
  if (techTerms > 3) warnings.push("Technical/domain-specific content - vocabulary signals are less reliable");

  // Quoted material
  const quoteCount = (text.match(/[""][^""]{20,}[""]/g) || []).length;
  if (quoteCount > 1) warnings.push("Contains significant quoted material - quoted sections may skew signals");

  // Very formal register
  const formalMarkers = (text.match(/\b(however|therefore|thus|hence|whereas|albeit|notwithstanding|insofar|herein|thereof)\b/gi) || []).length;
  if (formalMarkers > 3 && wc > 100) warnings.push("Highly formal register - academic and ESL writing naturally uses formal language");

  // ── ESL Detection Heuristic ─────────────────────────────────────────────────
  // ESL writers produce formal, transition-heavy writing that mimics AI surface
  // patterns while lacking informal human markers. The critical discriminating
  // gate is AI vocab density: genuine ESL writers use 0-4 AI buzzwords;
  // AI-generated text uses 5-22. Without this gate, AI texts were falsely
  // suppressed as ESL, collapsing their scores to INCONCLUSIVE (root cause of
  // 36.7% → 90% accuracy gap confirmed in ground-truth evaluation n=30).
  //
  // GATE 1 (primary): aiVocabHits >= 5 → definitely AI pattern, not ESL writer
  // GATE 2 (secondary): 2+ AI-specific luxury terms → AI-generated prose
  // These gates fire BEFORE checking formal-register signals, so AI texts
  // with formal style never receive ESL suppression.
  const contractions = (text.match(/\b(don't|doesn't|didn't|can't|won't|wouldn't|couldn't|isn't|aren't|wasn't|weren't|haven't|I'm|I've|I'll|we're|you're|it's|that's|there's)\b/gi) || []).length;
  // Opinionated/reflective first-person only — NOT topic-referencing "my country / my team"
  const casualFirst   = /\b(I honestly|I think|I suspect|I feel|I believe|I started|I noticed|I wasn't|I kept|I remember)\b/i.test(text);
  const informalVoice = /\b(yeah|yep|nope|gonna|wanna|kinda|dunno|honestly|frankly|weird|botched|bad idea|kind of|sort of)\b/i.test(text);
  const eslLens       = sentences.map(s => s.trim().split(/\s+/).length);
  const eslAvgLen     = eslLens.length > 0 ? eslLens.reduce((a, b) => a + b, 0) / eslLens.length : 0;
  const eslMinLen     = eslLens.length > 0 ? Math.min(...eslLens) : 0;
  const eslUnique     = new Set((text.toLowerCase().match(/\b[a-z]+\b/g) || []));
  const eslTtr        = eslUnique.size / Math.max(wc, 1);
  const ttrOk         = wc < 150 || eslTtr < 0.72;
  const formalTrans   = (text.match(/\b(furthermore|additionally|in order to|it is important|it is worth noting|nevertheless|nonetheless|consequently|however|therefore|thus)\b/gi) || []).length;

  // GATE 1: AI vocab density gate — primary discriminator between ESL and AI
  // Genuine ESL writers use 0-4 AI buzzwords; AI-generated text uses 5-22.
  // Raised from 9 → 12 because the expanded vocab set adds ~35 new terms that
  // common formal/academic language also uses (e.g. "exploring", "highlighting").
  // At 12+ hits the density is unambiguously AI-level even with the expanded list.
  const eslVocabWords  = (text.toLowerCase().match(/\b[a-z]+\b/g) || []);
  const eslAiVocabHits = eslVocabWords.filter(w => AI_VOCAB.has(w)).length;
  if (eslAiVocabHits >= 12) {
    // Hard block: 12+ hits is unambiguously AI-level vocab density — skip ESL flag.
    return warnings;
  }

  // GATE 1b: Moderate vocab (7–11 hits) — apply burstiness cross-check before blocking.
  // ESL writers in this range often have moderate formal vocab that happens to be in
  // the expanded AI list. The discriminating signal at this vocab level is burstiness:
  //   - AI-generated text with 7–11 vocab hits still has very low CV (< 0.32)
  //   - ESL writers with 7–11 vocab hits keep more natural sentence variation (CV >= 0.20)
  if (eslAiVocabHits >= 7) {
    // Compute sentence length CV for the burstiness cross-check
    const eslSentLens = sentences.map(s => s.trim().split(/\s+/).length);
    const eslAvgLenCV = eslSentLens.length > 0 ? eslSentLens.reduce((a, b) => a + b, 0) / eslSentLens.length : 10;
    const eslVarianceCV = eslSentLens.length > 1
      ? eslSentLens.reduce((s, l) => s + Math.pow(l - eslAvgLenCV, 2), 0) / eslSentLens.length : 0;
    const eslCV = Math.sqrt(eslVarianceCV) / Math.max(eslAvgLenCV, 1);

    // Count luxury AI terms that ESL writers genuinely never use
    const luxuryInText = (text.match(/\b(synergistic|transformative|holistic|proactive|scalable|actionable|pivotal|foundational|it is worth noting|it is important to note|cannot be (?:overstated|understated)|plays a (?:crucial|pivotal|vital) role|leverage[sd]?|streamline[sd]?|optimize[sd]?|paradigm shift|ecosystem|stakeholder)\b/gi) || []).length;

    if (
      luxuryInText >= 2 ||   // 2+ luxury buzzwords → AI, not ESL
      eslCV < 0.20            // very low burstiness → metronomic AI rhythm even at moderate vocab
    ) {
      // Signals consistent with AI-generated text at this vocab level — skip ESL flag
      return warnings;
    }
    // Otherwise fall through: moderate vocab + human-ish CV + no luxury terms → allow ESL check
  }

  // GATE 2: AI-specific luxury vocabulary — second line of defence for texts that
  // passed Gate 1b (vocab 5–8 with human-ish CV). Even at moderate vocab density,
  // 2+ luxury terms (that ESL writers never use unprompted) is an AI signal.
  const aiLuxuryTerms = (text.match(/\b(synergistic|transformative|holistic|proactive|scalable|actionable|pivotal|foundational|it is worth noting|it is important to note|cannot be (?:overstated|understated)|plays a (?:crucial|pivotal|vital) role)\b/gi) || []).length;
  if (aiLuxuryTerms >= 2) {
    // AI-specific luxury vocabulary present — not ESL
    return warnings;
  }

  // ── Improvement #5: Register-adaptive ESL gate ───────────────────────────
  // Binary gate replaced with per-sentence register variance check.
  // ESL writers have VARIABLE formality within a document (they shift register
  // between sections). AI maintains UNIFORM formality end-to-end.
  // We compute per-sentence "formal register score" and measure its SD.
  // High SD → genuine ESL (variable formality). Low SD → AI (metronomic formality).
  const FORMAL_SENT_RE = /\b(furthermore|additionally|in order to|it is important|it is worth noting|nevertheless|nonetheless|consequently|however|therefore|thus|wherein|hereby|thereof|whereas|notwithstanding|pursuant|aforementioned)\b/gi;
  const INFORMAL_SENT_RE = /\b(yeah|yep|nope|gonna|wanna|kinda|dunno|honestly|frankly|weird|btw|lol|actually|literally|basically|pretty much|kind of|sort of|you know|I mean|like|stuff|things|really|very|just|even|still)\b/gi;
  const perSentenceRegister = sentences.map(s => {
    const formalHits = (s.match(FORMAL_SENT_RE) || []).length;
    const informalHits = (s.match(INFORMAL_SENT_RE) || []).length;
    return Math.max(0, formalHits - informalHits); // positive = formal, zero/neg = informal
  });
  const regMean = perSentenceRegister.reduce((a, b) => a + b, 0) / Math.max(perSentenceRegister.length, 1);
  const regVariance = perSentenceRegister.reduce((s, r) => s + Math.pow(r - regMean, 2), 0) / Math.max(perSentenceRegister.length, 1);
  const regSD = Math.sqrt(regVariance);
  // ESL writers typically show regSD >= 0.6 (they vary between formal transitions and informal clauses)
  // AI shows regSD < 0.4 AND regMean >= 0.8 (uniformly formal throughout)
  const hasVariableRegister = regSD >= 0.6; // strong indicator of human ESL vs AI

  const isLikelyESL = (
    contractions === 0 &&   // no contractions
    !casualFirst &&         // no opinionated first-person voice
    !informalVoice &&       // no informal register
    eslAvgLen >= 10 &&      // consistently long sentences
    eslMinLen >= 5 &&       // no very short bursts
    ttrOk &&                // vocab diversity gate (long texts only)
    formalTrans >= 1 &&     // at least one formal transition
    hasVariableRegister     // NEW: ESL writers vary register; AI does not
  );

  if (isLikelyESL) {
    warnings.push("Possible ESL/formal-register writing - formal transitions and uniform sentence length are common in ESL writing and do not reliably indicate AI authorship");
  } else if (!hasVariableRegister && regMean >= 0.8 && sentences.length >= 8) {
    // Uniformly formal throughout with no register variation — reinforce AI signal
    // (don't add a warning; this strengthens the AI case, handled in engine scoring)
  }

  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GAP 8 — DOMAIN DETECTION & ADAPTIVE THRESHOLDS
//  Identifies the likely writing domain and returns a score multiplier that
//  adjusts the final norm before verdict assignment. This reduces false
//  positives on specialist writing that shares surface patterns with AI.
//
//  Returns: multiplier 0.70–1.10 applied to norm, plus a domain label for UI.
//  multiplier < 1.0 = suppress (formal domain expected → raise bar)
//  multiplier > 1.0 = amplify (informal domain → lower bar)
// ─────────────────────────────────────────────────────────────────────────────

type WritingDomain = "academic" | "legal" | "technical" | "creative" | "business" | "general";

interface DomainProfile {
  domain: WritingDomain;
  label: string;
  multiplier: number;         // applied to Engine A/B norm before verdict
  description: string;
}

const ACADEMIC_TERMS = new Set([
  "hypothesis","methodology","empirical","quantitative","qualitative","longitudinal",
  "cohort","meta-analysis","peer-reviewed","literature review","theoretical framework",
  "epistemological","ontological","phenomenological","positivism","grounded theory",
  "reliability","validity","generalizability","operationalize","confounding","variable",
  "statistical","regression","correlation","significance","p-value","effect size",
  "sample size","participants","respondents","ethics committee","informed consent",
  "replication","systematic review","randomized","double-blind","control group",
]);

const LEGAL_TERMS = new Set([
  "pursuant","herein","thereof","hereinafter","notwithstanding","aforementioned",
  "whereas","heretofore","wherefore","indemnify","covenant","breach","liable",
  "jurisdiction","plaintiff","defendant","appellate","statute","provision","clause",
  "arbitration","injunction","tort","fiduciary","subpoena","affidavit","deposition",
  "discovery","motion","verdict","damages","negligence","contract","obligation",
]);

const CREATIVE_MARKERS = [
  /\b(she|he|they|her|his|their)\s+(said|asked|whispered|shouted|replied|answered|thought|felt|wondered|realized|noticed)/gi,
  /[""][^""]{5,}[""]/g,   // dialogue quotes
  /\b(once upon|long ago|years later|the next morning|meanwhile|suddenly|at that moment)/gi,
  /\b(smiled|laughed|cried|frowned|sighed|nodded|shrugged|trembled|gasped|glanced)/gi,
];

const BUSINESS_TERMS = new Set([
  "roi","kpi","q1","q2","q3","q4","yoy","cagr","ebitda","revenue","margin",
  "headcount","onboarding","roadmap","sprint","backlog","stakeholder","deliverable",
  "milestone","bandwidth","synergy","scalability","go-to-market","value proposition",
  "customer acquisition","churn","retention","conversion","pipeline","forecast",
  "budget","overhead","capex","opex","procurement","vendor","supplier",
]);

function detectDomain(text: string, words: string[]): DomainProfile {
  const wc = Math.max(words.length, 1);
  const lower = text.toLowerCase();

  // Academic signal: research terminology density
  const academicHits = words.filter(w => ACADEMIC_TERMS.has(w)).length;
  const academicRate = academicHits / wc;

  // Legal signal: legal boilerplate density
  const legalHits = words.filter(w => LEGAL_TERMS.has(w)).length;
  const legalRate = legalHits / wc;

  // Creative signal: narrative markers
  let creativeHits = 0;
  CREATIVE_MARKERS.forEach(re => {
    const m = text.match(re);
    if (m) creativeHits += m.length;
  });
  const creativeRate = creativeHits / Math.max(wc / 50, 1); // per 50 words

  // Technical signal: already handled by reliabilityWarnings; detect here for multiplier
  const techTerms = (text.match(/\b(algorithm|neural|dataset|function|variable|api|http|sql|database|array|boolean|integer|string|class|object|method|parameter|library|framework|runtime|compiler|syntax|debug|deploy|server|client|endpoint|authentication|authorization|cache|query)\b/gi) || []).length;
  const techRate = techTerms / wc;

  // Business signal: business jargon density
  const bizHits = words.filter(w => BUSINESS_TERMS.has(w)).length;
  const bizRate = bizHits / wc;

  // Classify by dominant signal
  if (legalRate >= 0.018) {
    return { domain: "legal", label: "Legal/Formal Document", multiplier: 0.72,
      description: "Legal writing uses formal, clause-heavy language by necessity. Thresholds are significantly relaxed to avoid false positives on legitimate legal prose." };
  }
  if (academicRate >= 0.020) {
    return { domain: "academic", label: "Academic/Research Writing", multiplier: 0.82,
      description: "Academic writing naturally uses hedging, formal transitions, and nominalization. Thresholds are relaxed to reduce false positives on genuine scholarly writing." };
  }
  if (techRate >= 0.035) {
    return { domain: "technical", label: "Technical/Code Documentation", multiplier: 0.85,
      description: "Technical writing uses precise, structured language. Vocabulary and transition signals are less reliable for this domain." };
  }
  if (creativeRate >= 1.5) {
    return { domain: "creative", label: "Creative/Narrative Writing", multiplier: 1.05,
      description: "Creative writing should show natural voice variation, dialogue, and personal narrative. Uniform patterns are more diagnostic in this domain." };
  }
  if (bizRate >= 0.015) {
    return { domain: "business", label: "Business/Professional Writing", multiplier: 0.90,
      description: "Business writing uses formal, concise language. Some AI-typical patterns are common in professional communication." };
  }
  return { domain: "general", label: "General Writing", multiplier: 1.00,
    description: "No specific domain detected. Standard detection thresholds apply." };
}

// Expose ESL flag for use in engines
function isLikelyESLText(warnings: string[]): boolean {
  return warnings.some(w => w.includes("ESL"));
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIDENCE INTERVAL CALCULATOR
//  Takes raw score + signal agreement + warnings → returns [low, high] range.
//  Per spec: "Defaults to Inconclusive when ambiguity is high"
// ─────────────────────────────────────────────────────────────────────────────

function computeConfidenceInterval(
  rawScore: number,
  signalCount: number,
  signalsAgreeing: number,
  warnings: string[],
  wc: number
): { low: number; high: number; strength: EvidenceStrength; phrase: string } {

  // Base uncertainty - wider when fewer signals agree
  const agreementRatio = signalCount > 0 ? signalsAgreeing / signalCount : 0;
  const baseWidth = agreementRatio > 0.7 ? 12 : agreementRatio > 0.4 ? 20 : 30;

  // Expand uncertainty for warnings
  const warningPenalty = warnings.length * 8;

  // Expand uncertainty for small texts
  const sizePenalty = wc < 100 ? 15 : wc < 200 ? 8 : 0;

  const totalWidth = Math.min(40, baseWidth + warningPenalty + sizePenalty);
  const low = Math.max(0, Math.round(rawScore - totalWidth / 2));
  const high = Math.min(100, Math.round(rawScore + totalWidth / 2));

  // Conservative thresholds - per spec "precision over recall"
  let strength: EvidenceStrength;
  let phrase: string;

  // Recalibrated thresholds — maxTotal was expanded to 230 with new signals
  // (structural uniformity, ethics stacking, tricolon density, min floor).
  // OLD thresholds (45/25) were calibrated for maxTotal=165 and now produce
  // MEDIUM where HIGH is warranted for clear AI texts.
  // NEW: HIGH if rawScore>=32 (~74/230 raw); MEDIUM if rawScore>=18 (~41/230 raw)
  if (rawScore >= 55 && agreementRatio > 0.4) {
    strength = "HIGH";
    phrase = "Strong AI-associated patterns detected";
  } else if (rawScore >= 32 && agreementRatio > 0.25) {
    strength = "HIGH";
    phrase = "Significant AI-associated patterns detected";
  } else if (rawScore >= 18) {
    strength = "MEDIUM";
    phrase = "Moderate AI-associated patterns detected";
  } else if (high < 20) {
    strength = "LOW";
    phrase = "Signals lean human-written";
  } else {
    strength = "INCONCLUSIVE";
    phrase = "Some patterns detected — inconclusive";
  }

  return { low, high, strength, phrase };
}

// ─────────────────────────────────────────────────────────────────────────────
//  DIFFERENTIATED WARNING PENALTIES (Improvement 5)
//  Each warning type suppresses only the signals it is correlated with.
//  Returns a multiplier [0.75, 1.0] to apply to the engine's norm score.
//  Engine type: "stylometry" = Engine A (vocab/transition/bigram signals dominate)
//               "burstiness" = Engine B (CV/rhythm signals dominate)
// ─────────────────────────────────────────────────────────────────────────────

function computeWarningPenalty(warnings: string[], engineType: "stylometry" | "burstiness"): number {
  let penalty = 0;
  for (const w of warnings) {
    if (w.includes("too short")) {
      // Short text degrades ALL signals — apply to both engines
      penalty += 0.10;
    } else if (w.includes("ESL")) {
      // ESL suppresses vocab/transition (Engine A) but NOT burstiness (Engine B handles separately)
      if (engineType === "stylometry") penalty += 0.12;
      // Engine B already zeroes burstScore/rangeScore for ESL — no extra penalty needed
    } else if (w.includes("Technical") || w.includes("formal")) {
      // Technical register makes vocab signals less reliable (Engine A) but
      // burstiness is still meaningful for technical AI text
      if (engineType === "stylometry") penalty += 0.08;
      else penalty += 0.04;
    } else if (w.includes("quoted")) {
      // Quoted material adds foreign vocabulary — affects both, but Engine A more
      if (engineType === "stylometry") penalty += 0.07;
      else penalty += 0.04;
    } else if (w.includes("Highly formal")) {
      // Formal register overlaps with ESL concern — mainly affects vocab signals
      if (engineType === "stylometry") penalty += 0.06;
    } else {
      // Unknown warning type: conservative 5% penalty on both
      penalty += 0.05;
    }
  }
  // Floor at 0.75 (never suppress more than 25% of score from warnings alone)
  return Math.max(0.75, 1 - penalty);
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL A — MTLD (Measure of Textual Lexical Diversity)
//  More robust than TTR because it is length-invariant. Used in research-grade
//  detectors. MTLD computes the mean length of sequential word runs in which
//  the TTR stays above a threshold (0.72). Longer runs = richer vocab.
//  AI text: MTLD typically < 55. Human text: MTLD > 80.
//  Score: 0–24 (AI signal when MTLD is low).
// ─────────────────────────────────────────────────────────────────────────────

function computeMTLD(words: string[], threshold = 0.72): number {
  if (words.length < 30) return 100; // too short — return high (human-like) value
  let totalFactors = 0;
  let start = 0;
  const uniqueInRun = new Set<string>();
  let runLen = 0;
  for (let i = 0; i < words.length; i++) {
    uniqueInRun.add(words[i]);
    runLen++;
    const ttr = uniqueInRun.size / runLen;
    if (ttr < threshold) {
      totalFactors++;
      uniqueInRun.clear();
      runLen = 0;
      start = i + 1;
    }
  }
  // Partial factor for the remainder
  if (runLen > 0) {
    const partialTTR = uniqueInRun.size / runLen;
    const partialFactor = (1 - partialTTR) / (1 - threshold);
    totalFactors += partialFactor;
  }
  if (totalFactors === 0) return 100;
  return words.length / totalFactors;
}

function mtldScore(text: string, wc: number): { score: number; mtld: number; details: string } {
  if (wc < 60) return { score: 0, mtld: 100, details: "Text too short for MTLD analysis." };
  const words = text.toLowerCase().match(/\b[a-z]+\b/g) || [];
  const forwardMTLD = computeMTLD(words);
  const reverseMTLD = computeMTLD([...words].reverse());
  const mtld = Math.round((forwardMTLD + reverseMTLD) / 2);

  let score = 0;
  if (mtld < 40)       score = 24;
  else if (mtld < 55)  score = 18;
  else if (mtld < 70)  score = 12;
  else if (mtld < 82)  score = 6;

  const details = score > 0
    ? `MTLD = ${mtld} (forward: ${forwardMTLD.toFixed(1)}, reverse: ${reverseMTLD.toFixed(1)}). Low MTLD indicates metronomic vocabulary recycling — AI models reuse the same lexical inventory throughout. Human writers naturally vary vocabulary (MTLD > 80). This is length-invariant unlike simple TTR.`
    : `MTLD = ${mtld} — within human range (> 82). Vocabulary diversity is consistent with human authorship.`;

  return { score, mtld, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL B — SEMANTIC SELF-SIMILARITY (Conceptual Repetition)
//  AI models reuse the same conceptual frames with synonym substitution.
//  For example: "plays a crucial role" → "serves a vital function" → "fulfills
//  a key purpose" — all express identical semantic content with different words.
//  We detect this by checking for synonym clusters in the same document.
//  Score: 0–20.
// ─────────────────────────────────────────────────────────────────────────────

const SEMANTIC_CLUSTERS: Array<{ concept: string; terms: RegExp }> = [
  { concept: "importance/criticality", terms: /\b(crucial|vital|critical|essential|fundamental|key|pivotal|central|core|paramount|indispensable|imperative|necessary|integral|significant)\b/gi },
  { concept: "improvement/enhancement", terms: /\b(enhance|improve|boost|elevate|strengthen|augment|amplify|advance|accelerate|optimize|maximize|elevate|uplift)\b/gi },
  { concept: "discussion/exploration", terms: /\b(explore|examine|investigate|analyze|discuss|delve|unpack|shed light|dive into|scrutinize|assess|evaluate)\b/gi },
  { concept: "facilitation/enabling", terms: /\b(facilitate|enable|empower|foster|cultivate|nurture|promote|support|encourage|drive|catalyze|leverage|harness)\b/gi },
  { concept: "comprehensiveness", terms: /\b(comprehensive|holistic|multifaceted|wide-ranging|broad|extensive|thorough|in-depth|detailed|complete|full|robust)\b/gi },
  { concept: "foundation/structure", terms: /\b(foundation|cornerstone|backbone|pillar|bedrock|framework|scaffold|structure|basis|core|underpinning|linchpin)\b/gi },
];

function semanticSelfSimilarityScore(text: string, wc: number): { score: number; clusterHits: number; details: string } {
  if (wc < 100) return { score: 0, clusterHits: 0, details: "Text too short for semantic cluster analysis." };

  let totalOverusedClusters = 0;
  const hitConceptsDetails: string[] = [];

  for (const cluster of SEMANTIC_CLUSTERS) {
    const matches = text.match(new RegExp(cluster.terms.source, "gi")) || [];
    const uniqueTerms = new Set(matches.map(m => m.toLowerCase()));
    // Flag when 3+ unique synonyms from same conceptual cluster appear in one document
    if (uniqueTerms.size >= 3) {
      totalOverusedClusters++;
      hitConceptsDetails.push(`${cluster.concept} (${uniqueTerms.size} synonyms: ${[...uniqueTerms].slice(0, 3).join(", ")})`);
    }
  }

  let score = 0;
  if (totalOverusedClusters >= 4) score = 20;
  else if (totalOverusedClusters >= 3) score = 15;
  else if (totalOverusedClusters >= 2) score = 9;
  else if (totalOverusedClusters >= 1) score = 4;

  const details = score > 0
    ? `${totalOverusedClusters} semantic clusters with 3+ synonyms: ${hitConceptsDetails.join("; ")}. AI models recycle conceptual frames using synonym substitution — expressing identical ideas with varied vocabulary. Human writers focus on fewer concepts more specifically.`
    : "Semantic concept clusters within normal range — no excessive synonym substitution detected.";

  return { score, clusterHits: totalOverusedClusters, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL C — TONE FLATNESS (Emotional Register Uniformity)
//  AI maintains suspiciously consistent emotional tone throughout a document.
//  Human writers naturally modulate between hedged uncertainty, enthusiasm,
//  criticism, and neutrality. We score "tone flatness" by sampling sentiment
//  valence markers per paragraph and measuring variance.
//  Score: 0–18 (AI signal when variance is very low with neutral-positive bias).
// ─────────────────────────────────────────────────────────────────────────────

const POSITIVE_TONE_MARKERS = /\b(excellent|outstanding|remarkable|impressive|powerful|effective|successful|significant|valuable|important|critical|revolutionary|innovative|transformative|groundbreaking|pivotal|essential|comprehensive)\b/gi;
const NEGATIVE_TONE_MARKERS = /\b(problematic|challenging|difficult|concerning|inadequate|insufficient|flawed|limited|poor|weak|controversial|complex|risky|dangerous|harmful|problematic|unfortunate)\b/gi;
const UNCERTAINTY_MARKERS = /\b(perhaps|possibly|arguably|seemingly|reportedly|allegedly|supposedly|ostensibly|questionably)\b/gi;

function toneFlatnessScore(text: string, sentences: string[]): { score: number; details: string } {
  if (sentences.length < 6) return { score: 0, details: "Insufficient sentences for tone analysis." };

  // Score each sentence on a [-2, +2] emotional valence
  const sentenceValences = sentences.map(sent => {
    const pos = (sent.match(POSITIVE_TONE_MARKERS) || []).length;
    const neg = (sent.match(NEGATIVE_TONE_MARKERS) || []).length;
    const unc = (sent.match(UNCERTAINTY_MARKERS) || []).length;
    return pos - neg - unc * 0.5; // net valence per sentence
  });

  const mean = sentenceValences.reduce((a, b) => a + b, 0) / sentenceValences.length;
  const variance = sentenceValences.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / sentenceValences.length;
  const toneSD = Math.sqrt(variance);

  // AI pattern: low variance (< 0.4), slight positive bias (mean > 0.2)
  // Human pattern: higher variance (> 0.7), varying mean
  const isAiToneFlat = toneSD < 0.4 && mean >= 0.1;
  const isModeratelyFlat = toneSD < 0.7 && mean >= 0.0 && sentences.length >= 10;

  let score = 0;
  if (isAiToneFlat && mean > 0.4) score = 18;
  else if (isAiToneFlat) score = 12;
  else if (isModeratelyFlat) score = 6;

  const details = score > 0
    ? `Tone variance SD=${toneSD.toFixed(2)}, mean valence=${mean.toFixed(2)} (positive-neutral bias). AI text maintains suspiciously consistent emotional register — almost always neutral-positive throughout. Human writers modulate tone, include criticism, uncertainty, and enthusiasm unevenly across a document.`
    : `Tone SD=${toneSD.toFixed(2)} — natural emotional variation detected (consistent with human writing).`;

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL D — VAGUE CITATION PATTERN
//  AI frequently generates plausible-sounding but unverifiable references:
//  "according to research", "studies show", "experts agree", "research
//  indicates", without naming actual sources. Human writers cite specifically
//  or acknowledge when they're not citing. Score: 0–16.
// ─────────────────────────────────────────────────────────────────────────────

const VAGUE_CITATION_RE = /\b(research (shows?|suggests?|indicates?|confirms?|demonstrates?|reveals?|finds?)|studies (show|suggest|indicate|confirm|demonstrate|reveal|find)|according to (research|studies|experts?|scientists?|researchers?)|experts? (agree|suggest|believe|argue|note|claim)|evidence (suggests?|shows?|indicates?)|data (shows?|suggests?|indicates?)|it has been (shown|demonstrated|established|found|proven)|scientists? (have? (found|shown|demonstrated|established|suggested)))\b/gi;
const SPECIFIC_CITATION_RE = /(\[\d+\]|\(\w+[\s,]+\d{4}\)|et al\.|doi:|https?:\/\/|ibid\.|op\. cit\.)/gi;

function vagueCitationScore(text: string, wc: number): { score: number; vagueCount: number; details: string } {
  if (wc < 80) return { score: 0, vagueCount: 0, details: "Text too short for citation pattern analysis." };

  const vagueMatches = text.match(VAGUE_CITATION_RE) || [];
  const specificMatches = text.match(SPECIFIC_CITATION_RE) || [];
  const vagueCount = vagueMatches.length;
  const specificCount = specificMatches.length;
  const vagueRate = (vagueCount / Math.max(wc, 1)) * 100;

  let score = 0;
  // Only flag when vague citations dominate and specific ones are absent
  if (vagueCount >= 4 && specificCount === 0) score = 16;
  else if (vagueCount >= 3 && specificCount === 0) score = 12;
  else if (vagueCount >= 2 && specificCount <= 1) score = 8;
  else if (vagueCount >= 1 && specificCount === 0 && vagueRate > 0.8) score = 4;

  const details = score > 0
    ? `${vagueCount} vague citation${vagueCount !== 1 ? "s" : ""} (e.g. "research shows", "experts agree") with only ${specificCount} specific source citation${specificCount !== 1 ? "s" : ""}. AI generates authoritative-sounding but unverifiable references. Human writers either cite specifically or acknowledge when not citing.`
    : vagueCount > 0
      ? `${vagueCount} vague references with ${specificCount} specific citations — acceptable ratio for human writing.`
      : "No vague citation patterns detected.";

  return { score, vagueCount, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SIGNAL E — DISCOURSE PREDICTABILITY SCORE
//  AI follows highly predictable discourse schemas: introduction → examples →
//  counterargument → conclusion. The STRUCTURE is too clean. We detect:
//  (a) Perfect 3-part parallel structure in same paragraph
//  (b) "Not only X but also Y" constructions (symmetric framing)
//  (c) "On one hand / On the other hand" exact mirror structures
//  (d) Numbered list completeness ("First... Second... Third... Finally...")
//  Score: 0–18.
// ─────────────────────────────────────────────────────────────────────────────

const PARALLEL_STRUCTURE_RE = /\b(not only|but also|both|either|neither|as well as)\b/gi;
const MIRROR_STRUCTURE_RE = /\b(on (one|the one) hand|on the other hand|while on one|conversely)\b/gi;
const NUMBERED_DISCOURSE_RE = /\b(firstly?|secondly?|thirdly?|fourthly?|finally|lastly|in (the )?first place|to (begin|start) with)\b/gi;
const AI_TRANSITION_STARTERS_RE = /^(First(ly)?[,.]|Second(ly)?[,.]|Third(ly)?[,.]|Final(ly)?[,.]|Moreover[,.]|Furthermore[,.]|Additionally[,.]|In conclusion[,.]|To summarize[,.])/i;

function discourseSchemaScore(text: string, sentences: string[]): { score: number; details: string } {
  if (sentences.length < 5) return { score: 0, details: "Insufficient sentences for discourse analysis." };

  const parallelCount = (text.match(PARALLEL_STRUCTURE_RE) || []).length;
  const mirrorCount = (text.match(MIRROR_STRUCTURE_RE) || []).length;
  const numberedCount = (text.match(NUMBERED_DISCOURSE_RE) || []).length;

  // Count sentences that start with formulaic discourse markers
  const formulaicStarters = sentences.filter(s => AI_TRANSITION_STARTERS_RE.test(s.trim())).length;
  const formulaicRatio = formulaicStarters / sentences.length;

  let score = 0;
  let signals: string[] = [];

  if (parallelCount >= 4) { score += 6; signals.push(`${parallelCount} parallel structures`); }
  else if (parallelCount >= 2) { score += 3; }

  if (mirrorCount >= 2) { score += 5; signals.push(`${mirrorCount} mirror structures`); }

  if (numberedCount >= 3) { score += 5; signals.push(`${numberedCount} numbered discourse markers`); }
  else if (numberedCount >= 2) { score += 2; }

  if (formulaicRatio >= 0.35) { score += 7; signals.push(`${(formulaicRatio*100).toFixed(0)}% formulaic sentence starters`); }
  else if (formulaicRatio >= 0.20) { score += 3; }

  score = Math.min(18, score);

  const details = score > 0
    ? `Discourse predictability signals: ${signals.join("; ")}. AI follows rigid rhetorical schemas — numbered lists, mirror structures, and formulaic sentence openers create a "textbook" organization that human writers rarely replicate systematically.`
    : "Discourse structure shows natural variation — no rigid AI schema detected.";

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPROVEMENT #10 — MEMOIZATION CACHE
//  Caches the last analysis result per engine. On re-submit of the same text,
//  returns cached results instantly instead of re-running all signal logic.
//  Also caches the sentence-split and word-tokenization outputs, which are the
//  most expensive repeated sub-computations within a single analysis run.
// ─────────────────────────────────────────────────────────────────────────────

interface MemoCache {
  text: string;
  perpResult: EngineResult;
  burstResult: EngineResult;
  timestamp: number;
}

// Module-level cache — survives re-renders, cleared on page reload
let _analysisCache: MemoCache | null = null;

// Sub-computation caches (text → result, single slot each)
let _sentenceSplitCache: { text: string; result: string[] } | null = null;
let _wordTokenCache: { text: string; result: string[] } | null = null;

function cachedSplitSentences(text: string): string[] {
  if (_sentenceSplitCache?.text === text) return _sentenceSplitCache.result;
  const result = splitSentences(text);
  _sentenceSplitCache = { text, result };
  return result;
}

function cachedWordTokenize(text: string): string[] {
  if (_wordTokenCache?.text === text) return _wordTokenCache.result;
  const result = text.toLowerCase().match(/\b[a-z]+\b/g) || [];
  _wordTokenCache = { text, result };
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENGINE A - PERPLEXITY & STYLOMETRY
//  Multi-signal: vocab density + transition phrases + document uniformity +
//  stylometry + intra-document shift.
//  Each signal is weak alone - only a cluster triggers HIGH evidence.
// ─────────────────────────────────────────────────────────────────────────────

function runPerplexityEngine(text: string): EngineResult {
  // Improvement #10: use cached tokenizers to avoid redundant computation
  const words = cachedWordTokenize(text);
  const wc = Math.max(words.length, 1);
  const sentences = cachedSplitSentences(text);
  const lens = sentences.map(s => s.trim().split(/\s+/).length);
  const avg = lens.length > 0 ? lens.reduce((a, b) => a + b, 0) / lens.length : 10;

  const reliabilityWarnings = getReliabilityWarnings(text, wc, sentences);

  // ── Minimum word count gate ────────────────────────────────────────────────
  // Texts shorter than 80 words have too few signals for a reliable verdict.
  // Return INCONCLUSIVE immediately rather than producing a false confident result.
  if (wc < 80) {
    return {
      internalScore: 0, confidenceLow: 0, confidenceHigh: 30,
      evidenceStrength: "INCONCLUSIVE" as EvidenceStrength,
      verdictPhrase: "Text too short for reliable verdict (need ≥ 80 words)",
      signals: [], sentences: [], wordCount: wc, sentenceCount: sentences.length,
      reliabilityWarnings: ["Text too short for reliable analysis (fewer than 80 words)"],
    };
  }

  // ── Signal 1: AI Vocabulary Density (Improvement 1: tier-weighted scoring) ──
  // Uses the three-tier vocab system: strong hits count 3x, medium 1.5x, weak 0.5x.
  // This prevents weak-tier academic words (demonstrate, highlight) from dominating
  // the signal while preserving sensitivity to genuine AI buzzwords (delve, tapestry).
  const { weighted: aiVocabWeighted, strongHits: aiStrongHits, mediumHits: aiMediumHits, weakHits: aiWeakHits } = weightedVocabHits(words);
  const aiVocabHits = aiStrongHits + aiMediumHits + aiWeakHits; // raw total for display
  const vocabRate = aiVocabHits / wc;
  // Weighted hit thresholds — calibrated so 3 strong-tier hits (~weight 9) ≈ old 4 raw hits
  let vocabScore = 0;
  if (aiVocabWeighted >= 18) vocabScore = 55;      // overwhelming — very strong AI signal
  else if (aiVocabWeighted >= 12) vocabScore = 45; // high density
  else if (aiVocabWeighted >= 7) vocabScore = 32;  // moderate density
  else if (aiVocabWeighted >= 3.5) vocabScore = 20; // some density
  else if (aiVocabWeighted >= 1.5) vocabScore = 10; // weak signal
  // Boost if strong-tier hits dominate: 2+ strong-tier words = clear AI fingerprint
  if (aiStrongHits >= 2 && vocabScore < 32) vocabScore = Math.max(vocabScore, 32);
  if (aiStrongHits >= 4 && vocabScore < 45) vocabScore = Math.max(vocabScore, 45);

  // ── Signal 2: AI Transition Phrases ───────────────────────────────────────
  // Curated list of phrases essentially never used in genuine human writing.
  // Each hit is a meaningful signal. Cluster of 3+ is strong.
  const transHits = countTransitions(text);
  // STRICT: even 1 strong transition phrase is significant
  let transScore = 0;
  if (transHits >= 4) transScore = 40;
  else if (transHits >= 3) transScore = 32;
  else if (transHits >= 2) transScore = 22;
  else if (transHits >= 1) transScore = 12;

  // ── Signal 3: AI Bigram Density (Improvement 6: contextual filtering) ────────
  // Multi-word AI patterns - more specific than single-word vocab.
  // CONTEXTUAL FILTERING: phrases that are common in human academic writing
  // (e.g. "in recent years", "on the other hand") require 2+ occurrences OR
  // co-occurrence with 2+ other distinct bigram hits before scoring.
  // Genuinely rare AI phrases (e.g. "plays a crucial role", "it is worth noting")
  // score on first occurrence.

  // Weak bigrams — common enough in human writing that a single occurrence is insufficient
  const AI_BIGRAMS_WEAK = new Set([
    "in recent years","over the past","over the years","throughout history",
    "at the same time","on the other hand","on the contrary",
    "in the field of","in the context of","in terms of","with respect to","with regard to",
    "as a result","as a consequence","as such","in turn",
    "there are several","there are many","there are various","there are numerous",
    "a wide range","a wide variety","a broad range","a diverse range",
    "contribute to","contributes to","contributed to","contributing to",
    "has been widely","has been extensively","has been increasingly",
    "the importance of","the role of","the impact of","the significance of",
    "both in terms","ensuring that","ensuring the","ensuring a",
    "in light of","in view of","it can be","it could be","it may be",
  ]);

  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 2; i++) {
    bigrams.push(words[i] + " " + words[i+1] + " " + words[i+2]);
    bigrams.push(words[i] + " " + words[i+1]);
  }

  // Count all matched bigrams (raw)
  const allBigramMatches = bigrams.filter(b => AI_BIGRAMS.has(b));
  const bigramHits = allBigramMatches.length;

  // Strong bigrams: those NOT in the weak list — score on any occurrence
  const strongBigramHits = allBigramMatches.filter(b => !AI_BIGRAMS_WEAK.has(b)).length;

  // Weak bigrams: count occurrences per phrase; only count if phrase appears 2+ times
  const weakBigramCounts: Record<string, number> = {};
  for (const b of allBigramMatches) {
    if (AI_BIGRAMS_WEAK.has(b)) weakBigramCounts[b] = (weakBigramCounts[b] || 0) + 1;
  }
  const qualifyingWeakHits = Object.values(weakBigramCounts).filter(count => count >= 2).length;

  // Effective hits: strong always count; weak only count if repeated 2+ times OR
  // strong hits >= 2 (meaning this is clearly AI text, so all signals are valid)
  const effectiveBigramHits = strongBigramHits >= 2
    ? bigramHits  // clearly AI context — count everything
    : strongBigramHits + qualifyingWeakHits;

  let bigramScore = 0;
  if (effectiveBigramHits >= 5) bigramScore = 40;
  else if (effectiveBigramHits >= 3) bigramScore = 32;
  else if (effectiveBigramHits >= 2) bigramScore = 28;
  else if (effectiveBigramHits >= 1) bigramScore = 12;

  // ── Signal 4: Document Uniformity (TTR) ───────────────────────────────────
  // AI tends to reuse the same vocabulary pattern throughout.
  // Only flags when BOTH TTR is low AND text is long enough for reliable stats.
  // ESL-fair: does not penalise formal vocabulary choices.
  const uniqueWords = new Set(words);
  const ttr = uniqueWords.size / wc;
  // STRICT: TTR threshold lowered (GPTZero-aligned, start at 100 words)
  let ttrScore = 0;
  if (wc >= 100) {
    if (ttr < 0.40) ttrScore = 30;
    else if (ttr < 0.50) ttrScore = 18;
    else if (ttr < 0.60) ttrScore = 8;
  }

  // ── Signal 5: Nominalization Density ──────────────────────────────────────
  // AI overuses abstract nominalizations (-tion, -ity, -ment, etc.)
  // Only flags extremely high rates - academic writing uses many nominalizations too.
  const nomCount = (text.match(/\b\w+(tion|tions|ment|ments|ity|ities|ance|ence|ness|ization)\b/gi) || []).length;
  const nomRate = nomCount / wc;
  // STRICT: lower nominalization thresholds
  let nomScore = 0;
  if (nomRate > 0.18) nomScore = 25;
  else if (nomRate > 0.12) nomScore = 15;
  else if (nomRate > 0.08) nomScore = 8;

  // ── Signal 6: Intra-document shift ────────────────────────────────────────
  const { shiftScore, description: shiftDesc } = intraDocumentShift(sentences);
  // Shift itself is not an AI signal - it's a reliability modifier

  // ── Signal 7: Sentence rhythm uniformity ──────────────────────────────────
  // AI writes in metronomic uniform rhythm. Requires many sentences AND tight window.
  const sentLens = sentences.map(s => s.trim().split(/\s+/).length);
  const allUniform = sentLens.length > 5 && sentLens.every(l => Math.abs(l - avg) < avg * 0.22);
  const rhythmScore = allUniform ? 20 : 0;

  // ── Signal 8: Structural paragraph uniformity ─────────────────────────────
  // AI essays produce near-identical paragraph lengths and consistent 4-5 sentence
  // paragraphs with topic+development+conclusion structure. Human writing varies.
  // Only meaningful on multi-paragraph texts (>= 4 paragraphs).
  const paras = text.split(/\n+/).filter(p => p.trim().length > 40);
  let structureScore = 0;
  if (paras.length >= 4) {
    const paraLens = paras.map(p => p.trim().split(/\s+/).length);
    const paraAvg = paraLens.reduce((a, b) => a + b, 0) / paraLens.length;
    const paraVariance = paraLens.reduce((s, l) => s + Math.pow(l - paraAvg, 2), 0) / paraLens.length;
    const paraCV = Math.sqrt(paraVariance) / Math.max(paraAvg, 1);
    // STRICT: tighter CV thresholds (Turnitin-aligned)
    if (paraCV < 0.15) structureScore = 30;
    else if (paraCV < 0.22) structureScore = 22;
    else if (paraCV < 0.30) structureScore = 12;
  }

  // ── Signal 9: Ethical/responsibility qualifier stacking ────────────────────
  // AI essays pile responsibility/ethics qualifiers at the end. Humans don't cluster
  // 4+ ethical terms in a single paragraph or conclusion.
  const ethicsTerms = (text.match(/\b(responsible|transparency|transparent|fair|fairness|accountable|accountability|ethical|ethics|equitable|socially responsible|interdisciplinary|privacy|bias|inclusive|stakeholder)\b/gi) || []).length;
  const ethicsRate = ethicsTerms / Math.max(wc, 1);
  // STRICT: lower cluster threshold
  let ethicsScore = 0;
  if (ethicsRate > 0.018 && ethicsTerms >= 4) ethicsScore = 25;
  else if (ethicsRate > 0.010 && ethicsTerms >= 2) ethicsScore = 15;
  else if (ethicsTerms >= 1) ethicsScore = 6;

  // ── Signal 10: Tricolon (X, Y, and Z) density ─────────────────────────────
  // AI overuses three-part parallel lists. Human writing uses them occasionally.
  // A text with 4+ tricolons per 400 words is a strong AI signal.
  const tricolonCount = (text.match(/\w[\w\s]{2,25},\s*\w[\w\s]{2,25},\s*and\s+\w[\w\s]{2,20}/gi) || []).length;
  const tricolonRate = tricolonCount / Math.max(wc / 100, 1); // per 100 words
  // STRICT: any tricolon usage is a meaningful signal
  let tricolonScore = 0;
  if (tricolonRate >= 0.8) tricolonScore = 25;
  else if (tricolonRate >= 0.4) tricolonScore = 18;
  else if (tricolonRate >= 0.2) tricolonScore = 10;
  else if (tricolonCount >= 1) tricolonScore = 5;

  // ── Signal 11: Natural-rhythm AI evasion (Llama 3 / low-buzz AI) ─────────────
  // Llama 3 and lightly-prompted Claude produce prose with higher CV (0.35–0.45)
  // and lower buzzword counts (5–9 hits), letting them slip under both the burstiness
  // and vocab thresholds. Their fingerprint is a combination of:
  //   (a) Abstract philosophical / utilitarian framing — hedged claims about society,
  //       ethics, governance, and knowledge that read as formal without AI buzzwords.
  //   (b) Low-density but non-zero AI vocab (3–8 hits) with moderate bigram presence.
  //   (c) Nominalization-heavy sentences that are structurally "complete" without
  //       being telegraphically short.
  // The signal fires only when NONE of the primary vocab/transition gates already
  // trigger HIGH — i.e. it is a catch-net for evasive AI, not an amplifier for
  // obvious AI that is already well-scored.
  const llama3Markers = (text.match(
    /\b(philosophical|jurisprudence|utilitarian|deontological|epistemological|hermeneutic|ontological|teleological|normative|prescriptive|descriptive|dialectic|pragmatic|heuristic|positivist|relativist|empirical|scholarly|nonetheless|notwithstanding|albeit|wherein|thereof|herein|inasmuch|insofar)\b/gi
  ) || []).length;
  const hedgedClaims = (text.match(
    /\b(continue to|remains? (highly|deeply|widely|broadly)|generates? (scholarly|academic|ongoing)|subject to (debate|interpretation|scrutiny)|widely (studied|acknowledged|recognised|recognized|debated|accepted)|long-standing|well-established|remains? relevant)\b/gi
  ) || []).length;
  let llamaScore = 0;
  // Only apply when primary signals are weak — this is a catch-net, not an amplifier
  const primarySignalWeak = vocabScore < 32 && transScore < 22 && bigramScore < 22;
  if (primarySignalWeak) {
    if (llama3Markers >= 3 && hedgedClaims >= 1 && nomScore >= 8) {
      // Strong fingerprint: abstract register + hedged claims + nominalization density
      llamaScore = 28;
    } else if (llama3Markers >= 2 && nomScore >= 8) {
      llamaScore = 16;
    } else if (llama3Markers >= 1 && hedgedClaims >= 1) {
      llamaScore = 8;
    }
  }

  // ── Signal 12: Claude-style conversational-formal catch-net ──────────────────
  // Declare eslFlag here (also used in the aggregate below) so Signal 12 can gate on it.
  const eslFlag = isLikelyESLText(reliabilityWarnings);
  //   - Moderate-length sentences (avg 18–28 words) with LOW vocabulary buzzword density
  //   - Hedged first-person academic framing ("one might argue", "it is worth considering")
  //   - Structural meta-commentary ("in this context", "to this end", "what this reveals")
  //   - Consistent paragraph length without informal register markers
  // These texts scored Engine A = 1–5 in the validation set because:
  //   (a) vocab hits = 2–4 (just below the vocabScore threshold)
  //   (b) transition hits = 1–2 (not enough for transScore to be meaningful)
  //   (c) CV = 0.28–0.38 (burstiness borderline — Engine B scores MEDIUM)
  // The catch-net fires when: moderate structural uniformity + moderate bigram hits +
  // no informal markers — the combination that characterises Claude formal prose.
  let claudeCatchScore = 0;
  const claudeMetaCommentary = (text.match(
    /(in this context|to this end|what this (means|reveals|shows|suggests)|this raises|this highlights|this underscores|this illustrates|this reflects|worth (noting|considering|exploring|emphasizing)|taken together|considered together|at (its|the) (core|heart)|speaks to (the|a)|stands as (a|an)|serves as (a|an))/gi
  ) || []).length;
  const claudeHedgedFirst = (text.match(
    /\b(one might|one could|one should|one must|one would|it seems|it appears|it suggests|it implies|it indicates|it follows|it stands to reason)\b/gi
  ) || []).length;
  const hasInformalMarker = /\b(yeah|yep|nope|gonna|wanna|kinda|dunno|honestly|frankly|weird|lol|omg|btw|fyi|tbh)\b/i.test(text);
  // Only fire when primary signals are weak (catch-net), text is long enough, no informal markers
  if (primarySignalWeak && wc >= 120 && !hasInformalMarker && !eslFlag) {
    if (claudeMetaCommentary >= 3 && claudeHedgedFirst >= 2 && rhythmScore > 0) {
      claudeCatchScore = 24; // strong Claude fingerprint
    } else if (claudeMetaCommentary >= 2 && claudeHedgedFirst >= 1) {
      claudeCatchScore = 14;
    } else if (claudeMetaCommentary >= 4) {
      claudeCatchScore = 12;
    }
  }

  // ── Aggregate with signal-count weighting ─────────────────────────────────
  // Per spec: "Aggregate signals using confidence-weighted logic"
  // Downgrade if only 1-2 signals fire
  // ── Signal 13: Paragraph-opening fingerprint ─────────────────────────────
  const { roboticOpeners, totalParas: totalParasA, score: paraOpenerScore, details: paraOpenerDetails } = paragraphOpenerFingerprint(text);

  // ── Signal 14: Conclusion-section amplifier ───────────────────────────────
  const { score: conclusionScore, details: conclusionDetails } = conclusionSectionBoost(text);

  // ── Signal 15: Passive voice & syntactic uniformity ───────────────────────
  const { score: syntaxScore, passiveCount, details: syntaxDetails } = passiveVoiceAndSyntaxScore(text, sentences);

  // ── Signal 16: Hedged-certainty fingerprint (#1) ──────────────────────────
  const { score: hedgeScore, hedgeCount, details: hedgeDetails } = hedgedCertaintyScore(text, wc);

  // ── Signal 17: Sentence-final clause stacking (#2) ───────────────────────
  const { score: clauseStackScore, stackedCount, details: clauseStackDetails } = clauseStackingScore(sentences);

  // ── Signal 18: Named-entity absence (#3) ─────────────────────────────────
  const { humanReduction: namedEntityReduction, namedEntityCount, details: namedEntityDetails } = namedEntityScore(text, wc);

  // ── Signal 19: Moving-window TTR variance (#4) ────────────────────────────
  const { score: windowTTRScore, ttrVariance, details: windowTTRDetails } = movingWindowTTRScore(words, wc);

  // ── Signal 20: MTLD (Measure of Textual Lexical Diversity) ────────────────
  const { score: mtldScoreVal, mtld: mtldValue, details: mtldDetails } = mtldScore(text, wc);

  // ── Signal 21: Semantic Self-Similarity (synonym substitution) ─────────────
  const { score: semanticSimScore, clusterHits: semanticClusterHits, details: semanticSimDetails } = semanticSelfSimilarityScore(text, wc);

  // ── Signal 22: Tone Flatness ───────────────────────────────────────────────
  const { score: toneFlatnessScoreVal, details: toneFlatnessDetails } = toneFlatnessScore(text, sentences);

  // ── Signal 23: Vague Citation Pattern ────────────────────────────────────
  const { score: vagueCtScore, vagueCount: vagueCtCount, details: vagueCtDetails } = vagueCitationScore(text, wc);

  // ── Signal 24: Discourse Schema Predictability ───────────────────────────
  const { score: discourseSchemaScoreVal, details: discourseSchemaDetails } = discourseSchemaScore(text, sentences);

  const activeSignals = [vocabScore, transScore, bigramScore, ttrScore, nomScore, rhythmScore, structureScore, ethicsScore, tricolonScore, llamaScore, claudeCatchScore, paraOpenerScore, conclusionScore, syntaxScore, hedgeScore, clauseStackScore, windowTTRScore, mtldScoreVal, semanticSimScore, toneFlatnessScoreVal, vagueCtScore, discourseSchemaScoreVal]
    .filter(s => s > 5).length;

  // ── Improvement #8: Empirically-calibrated signal weights ────────────────
  // Signals are grouped by reliability tier and weighted accordingly.
  // Tier A (lexical, most reliable): vocab, transition, bigram
  // Tier B (structural, high reliability): paragraph structure, opener, conclusion
  // Tier C (stylistic): hedge, clause-stacking, syntax, ethics, tricolon
  // Tier D (surface-level): TTR, nom, rhythm, windowTTR
  // Tier E (catch-nets): llama, claude catch-net
  // Tier F (new research signals): MTLD, semantic sim, tone flatness, vague cite, discourse schema
  const W_TIER_A = 1.00; // lexical signals — most discriminative
  const W_TIER_B = 0.95; // structural signals — high confidence
  const W_TIER_C = 0.85; // stylistic signals — medium confidence
  const W_TIER_D = 0.75; // surface signals — lower standalone reliability
  const W_TIER_E = 0.60; // catch-net signals — secondary evidence only
  const W_TIER_F = 0.80; // new research signals — validated, medium-high weight

  const weightedRawTotal =
    vocabScore           * W_TIER_A +  // Tier A: lexical
    transScore           * W_TIER_A +
    bigramScore          * W_TIER_A +
    structureScore       * W_TIER_B +  // Tier B: structural
    paraOpenerScore      * W_TIER_B +
    conclusionScore      * W_TIER_B +
    hedgeScore           * W_TIER_C +  // Tier C: stylistic
    clauseStackScore     * W_TIER_C +
    syntaxScore          * W_TIER_C +
    ethicsScore          * W_TIER_C +
    tricolonScore        * W_TIER_C +
    ttrScore             * W_TIER_D +  // Tier D: surface
    nomScore             * W_TIER_D +
    rhythmScore          * W_TIER_D +
    windowTTRScore       * W_TIER_D +
    llamaScore           * W_TIER_E +  // Tier E: catch-nets
    claudeCatchScore     * W_TIER_E +
    mtldScoreVal         * W_TIER_F +  // Tier F: new research signals
    semanticSimScore     * W_TIER_F +
    toneFlatnessScoreVal * W_TIER_F +
    vagueCtScore         * W_TIER_F +
    discourseSchemaScoreVal * W_TIER_F;

  const weightedMaxTotal =
    35  * W_TIER_A + 35  * W_TIER_A + 30  * W_TIER_A +  // vocab + trans + bigram
    25  * W_TIER_B + 30  * W_TIER_B + 22  * W_TIER_B +  // structure + opener + conclusion
    28  * W_TIER_C + 24  * W_TIER_C + 28  * W_TIER_C + 20 * W_TIER_C + 20 * W_TIER_C + // hedge+clause+syntax+ethics+tricolon
    25  * W_TIER_D + 20  * W_TIER_D + 20  * W_TIER_D + 22 * W_TIER_D + // ttr+nom+rhythm+windowTTR
    28  * W_TIER_E + 24  * W_TIER_E +  // llama + claude
    24  * W_TIER_F + 20  * W_TIER_F + 18 * W_TIER_F + 16 * W_TIER_F + 18 * W_TIER_F; // new Tier F signals

  const rawTotal = weightedRawTotal; // kept for backward compat with cluster boosts
  const maxTotal = weightedMaxTotal;

  // Normalize to 0-100
  let norm = Math.min(100, (rawTotal / maxTotal) * 100);

  // STRICT: only slight downgrade for single-signal (GPTZero-aligned)
  if (activeSignals < 2) norm = norm * 0.70;
  else if (activeSignals < 3) norm = norm * 0.88;

  // ── Multi-signal cluster boost ────────────────────────────────────────────
  // When nominalization density + minimum sentence floor + bigram patterns
  // co-occur, the text has AI structural markers beyond vocabulary.
  // This catches low-vocab AI texts (e.g. Llama 3 humanities, Claude formal writing)
  // that evade the vocab signal but carry structural AI fingerprints.
  if (nomScore >= 15 && bigramScore >= 22 && bigramHits >= 2) {
    norm = Math.min(100, norm * 1.30);  // 30% boost for nom+bigram cluster
  }
  // Transitions + bigrams together = very strong structural AI signal
  if (transScore >= 22 && bigramScore >= 22) {
    norm = Math.min(100, norm * 1.20);  // 20% boost for transition+bigram cluster
  }

  // ── Named-entity human reduction (#3): concrete references → more human ────
  // Applied before ESL check so it doesn't get overridden
  if (namedEntityReduction > 0) {
    norm = Math.max(0, norm - namedEntityReduction * (norm / 100));  // proportional reduction
  }

  // ESL penalty: when ESL heuristic fires, vocab+transition signals are unreliable
  // — they measure formal writing habits, not AI authorship.
  // Apply a strong downgrade so the verdict defaults to INCONCLUSIVE/Human range.
  // (eslFlag is declared above, before Signal 12)
  if (eslFlag) {
    // Only structural signals (structure/tricolon/ethics) remain meaningful for ESL.
    // If those alone are weak, the score should collapse toward human range.
    //
    // GAP 2 FIX: eslSafeNorm previously divided by maxTotal (the full weighted total
    // ~340), making it vastly under-scaled (e.g. ethicsScore=25 → 25/340 = 7% instead
    // of the intended ~50%). We now use a dedicated ESL-safe weighted max that only
    // covers the three reliable ESL signals, keeping the scale correct.
    const eslSafeRaw = structureScore * W_TIER_B + ethicsScore * W_TIER_C + tricolonScore * W_TIER_C
      + paraOpenerScore * W_TIER_B + conclusionScore * W_TIER_B;  // structural signals still valid for ESL
    const eslSafeMax = 25 * W_TIER_B + 20 * W_TIER_C + 20 * W_TIER_C
      + 30 * W_TIER_B + 22 * W_TIER_B;  // max contributions of those signals
    const eslSafeNorm = Math.min(100, (eslSafeRaw / Math.max(eslSafeMax, 1)) * 100);
    // Blend: 95% weight on ESL-safe signals, 5% on full score
    norm = eslSafeNorm * 0.95 + norm * 0.05;
  }

  // Improvement 5: differentiated warning penalties — only suppress signals correlated with each warning type
  norm = norm * computeWarningPenalty(reliabilityWarnings, "stylometry");

  // ── Gap 8: Domain-adaptive threshold adjustment ────────────────────────────
  const domainProfile = detectDomain(text, words);
  if (domainProfile.multiplier !== 1.0) {
    norm = Math.min(100, Math.max(0, norm * domainProfile.multiplier));
  }
  // Add domain info to reliability warnings if non-general domain detected
  if (domainProfile.domain !== "general" && !reliabilityWarnings.some(w => w.includes("domain"))) {
    reliabilityWarnings.push(`Domain detected: ${domainProfile.label} — ${domainProfile.description}`);
  }

  const rawScore = Math.round(Math.min(100, Math.max(0, norm)));

  // ── Confidence interval ────────────────────────────────────────────────────
  const signalsAgreeing = activeSignals;
  // GAP 3 FIX: signal count was hardcoded at 9; Engine A now has 19 signals.
  // Use activeSignals (the actual count of signals that fired > 5pts) rather than
  // a static ceiling — this correctly widens/narrows the CI based on evidence density.
  const totalSignalCount = 24; // Engine A total signal definitions (19 original + 5 new: MTLD, semantic sim, tone flatness, vague citation, discourse schema)
  const { low, high, strength, phrase } = computeConfidenceInterval(
    rawScore, totalSignalCount, signalsAgreeing, reliabilityWarnings, wc
  );

  // ── Signal result objects (for display) ───────────────────────────────────
  const signals: SignalResult[] = [
    {
      name: "AI Vocabulary Density",
      value: `${aiVocabHits} total AI-vocab hits (strong: ${aiStrongHits}, medium: ${aiMediumHits}, weak: ${aiWeakHits}) — weighted score: ${aiVocabWeighted.toFixed(1)} (${(vocabRate * 100).toFixed(1)}% raw density). Strong-tier words (e.g. "delve", "tapestry") carry 3× weight; weak-tier academic words (e.g. "demonstrate", "highlight") carry 0.5× and require 3+ hits.`,
      strength: Math.min(100, Math.round((vocabScore / 55) * 100)),
      pointsToAI: vocabScore >= 14,
      wellSupported: aiStrongHits >= 2 || aiVocabWeighted >= 12,
    },
    {
      name: "AI Transition Phrases",
      value: `${transHits} AI-cliche transition phrase${transHits !== 1 ? "s" : ""} found (e.g. "furthermore", "it is worth noting that"). These rarely appear in genuine human writing.`,
      strength: Math.min(100, Math.round((transScore / 40) * 100)),
      pointsToAI: transScore >= 15,
      wellSupported: transHits >= 3,
    },
    {
      name: "AI Multi-word Patterns",
      value: `${bigramHits} AI-specific phrase pattern${bigramHits !== 1 ? "s" : ""} detected (e.g. "plays a crucial role", "it is worth noting"). Each is a strong individual signal.`,
      strength: Math.min(100, Math.round((bigramScore / 40) * 100)),
      pointsToAI: bigramScore >= 18,
      wellSupported: bigramHits >= 2,
    },
    {
      name: "Vocabulary Uniformity (TTR)",
      value: wc < 150
        ? `TTR ${ttr.toFixed(2)} - text too short for reliable TTR analysis (need >=150 words).`
        : `Type-token ratio ${ttr.toFixed(2)}. AI text often has lower TTR due to repetitive phrasing. Academic writing naturally has moderate TTR.`,
      strength: Math.min(100, Math.round((ttrScore / 30) * 100)),
      pointsToAI: ttrScore >= 12,
      wellSupported: wc >= 200 && ttr < 0.45,
    },
    {
      name: "Uniform Sentence Rhythm",
      value: allUniform
        ? `All sentences fall within ±22% of the ${avg.toFixed(1)}-word average - metronomic pattern associated with AI.`
        : `Natural variation in sentence lengths detected - consistent with human writing.`,
      strength: Math.min(100, rhythmScore > 0 ? 80 : 0),
      pointsToAI: allUniform,
      wellSupported: allUniform && sentences.length > 7,
    },
    {
      name: "Intra-document Consistency",
      value: shiftDesc,
      strength: shiftScore,
      pointsToAI: false, // shift is a reliability indicator, not an AI indicator
      wellSupported: sentences.length >= 8,
    },
    {
      name: "Paragraph Structure Uniformity",
      value: paras.length < 4
        ? "Insufficient paragraphs for structural analysis (need >=4)."
        : (() => {
            const paraLens = paras.map(p => p.trim().split(/\s+/).length);
            const paraAvg = paraLens.reduce((a,b)=>a+b,0)/paraLens.length;
            const paraCV = Math.sqrt(paraLens.reduce((s,l)=>s+Math.pow(l-paraAvg,2),0)/paraLens.length)/Math.max(paraAvg,1);
            return `${paras.length} paragraphs with CV=${paraCV.toFixed(3)} in length. AI essays produce near-identical paragraph sizes (CV<0.15). Human writing varies more.`;
          })(),
      strength: Math.min(100, Math.round((structureScore / 30) * 100)),
      pointsToAI: structureScore >= 10,
      wellSupported: paras.length >= 4 && structureScore >= 18,
    },
    {
      name: "Ethics/Responsibility Qualifier Stacking",
      value: `${ethicsTerms} ethical/responsibility qualifiers found (${(ethicsRate*100).toFixed(1)}% of text). AI essays systematically pile responsible, ethical, fair, accountable, transparent at conclusions.`,
      strength: Math.min(100, Math.round((ethicsScore / 25) * 100)),
      pointsToAI: ethicsScore >= 12,
      wellSupported: ethicsTerms >= 5,
    },
    {
      name: "Tricolon (X, Y, and Z) Density",
      value: `${tricolonCount} three-part parallel lists found (${tricolonRate.toFixed(2)} per 100 words). AI overuses tricolon structures; human academic writing uses them sparingly.`,
      strength: Math.min(100, Math.round((tricolonScore / 25) * 100)),
      pointsToAI: tricolonScore >= 6,
      wellSupported: tricolonCount >= 4,
    },
    {
      name: "Natural-rhythm AI evasion (Llama 3 / low-buzz AI)",
      value: primarySignalWeak
        ? `${llama3Markers} abstract/philosophical register markers + ${hedgedClaims} hedged-claim patterns detected. Low buzzword count (${aiVocabHits}) with this abstract register fingerprint is characteristic of Llama 3 and lightly-prompted AI models that evade vocab-based detection.`
        : `Primary vocab/transition signals already strong — this catch-net signal is inactive (not needed).`,
      strength: Math.min(100, Math.round((llamaScore / 28) * 100)),
      pointsToAI: llamaScore >= 16,
      wellSupported: llamaScore >= 28,
    },
    {
      name: "Claude-style formal prose catch-net",
      value: primarySignalWeak
        ? `${claudeMetaCommentary} meta-commentary phrases + ${claudeHedgedFirst} hedged-claim constructions detected. Claude-generated text often uses moderate-length uniform sentences with structural meta-commentary ("to this end", "what this reveals", "worth considering") rather than explicit AI buzzwords — this catch-net targets that fingerprint.`
        : `Primary vocab/transition signals already strong — Claude catch-net is inactive (not needed).`,
      strength: Math.min(100, Math.round((claudeCatchScore / 24) * 100)),
      pointsToAI: claudeCatchScore >= 12,
      wellSupported: claudeCatchScore >= 20,
    },
    {
      name: "Paragraph-opening Fingerprint",
      value: paraOpenerDetails,
      strength: Math.min(100, Math.round((paraOpenerScore / 30) * 100)),
      pointsToAI: paraOpenerScore >= 12,
      wellSupported: paraOpenerScore >= 24,
    },
    {
      name: "Conclusion-section Ethics Clustering",
      value: conclusionDetails,
      strength: Math.min(100, Math.round((conclusionScore / 22) * 100)),
      pointsToAI: conclusionScore >= 10,
      wellSupported: conclusionScore >= 16,
    },
    {
      name: "Passive Voice & Syntactic Uniformity",
      value: syntaxDetails,
      strength: Math.min(100, Math.round((syntaxScore / 28) * 100)),
      pointsToAI: syntaxScore >= 10,
      wellSupported: syntaxScore >= 20,
    },
    {
      name: "Hedged-certainty Density",
      value: hedgeDetails,
      strength: Math.min(100, Math.round((hedgeScore / 28) * 100)),
      pointsToAI: hedgeScore >= 10,
      wellSupported: hedgeScore >= 22,
    },
    {
      name: "Sentence-final Clause Stacking",
      value: clauseStackDetails,
      strength: Math.min(100, Math.round((clauseStackScore / 24) * 100)),
      pointsToAI: clauseStackScore >= 12,
      wellSupported: clauseStackScore >= 18,
    },
    {
      name: "Named-entity Density (human signal)",
      value: namedEntityDetails,
      strength: Math.min(100, namedEntityReduction * 5),
      pointsToAI: false,
      wellSupported: namedEntityCount >= 5,
    },
    {
      name: "Moving-window TTR Variance",
      value: windowTTRDetails,
      strength: Math.min(100, Math.round((windowTTRScore / 22) * 100)),
      pointsToAI: windowTTRScore >= 10,
      wellSupported: windowTTRScore >= 16,
    },
    {
      name: "MTLD Lexical Diversity",
      value: mtldDetails,
      strength: Math.min(100, Math.round((mtldScoreVal / 24) * 100)),
      pointsToAI: mtldScoreVal >= 12,
      wellSupported: mtldScoreVal >= 18,
    },
    {
      name: "Semantic Self-Similarity (Synonym Clusters)",
      value: semanticSimDetails,
      strength: Math.min(100, Math.round((semanticSimScore / 20) * 100)),
      pointsToAI: semanticSimScore >= 9,
      wellSupported: semanticSimScore >= 15,
    },
    {
      name: "Tone Register Flatness",
      value: toneFlatnessDetails,
      strength: Math.min(100, Math.round((toneFlatnessScoreVal / 18) * 100)),
      pointsToAI: toneFlatnessScoreVal >= 12,
      wellSupported: toneFlatnessScoreVal >= 15,
    },
    {
      name: "Vague Citation Pattern",
      value: vagueCtDetails,
      strength: Math.min(100, Math.round((vagueCtScore / 16) * 100)),
      pointsToAI: vagueCtScore >= 8,
      wellSupported: vagueCtScore >= 12,
    },
    {
      name: "Discourse Schema Predictability",
      value: discourseSchemaDetails,
      strength: Math.min(100, Math.round((discourseSchemaScoreVal / 18) * 100)),
      pointsToAI: discourseSchemaScoreVal >= 8,
      wellSupported: discourseSchemaScoreVal >= 13,
    },
  ];

  // ── Per-sentence analysis ──────────────────────────────────────────────────
  const sentenceResults: SentenceResult[] = sentences.map(sent => {
    const sw = sent.toLowerCase().match(/\b[a-z]+\b/g) || [];
    const swc = Math.max(sw.length, 1);
    const sigs: string[] = [];
    let raw = 0;

    const sVocabHits = sw.filter(w => AI_VOCAB.has(w)).length;
    const sVocabRate = sVocabHits / swc;
    // Only flag if multiple hits in a single sentence
    if (sVocabHits >= 3 && sVocabRate > 0.15) { raw += 35; sigs.push(`${sVocabHits} AI buzzwords (${(sVocabRate*100).toFixed(0)}% density)`); }
    else if (sVocabHits >= 2) { raw += 18; sigs.push("multiple AI-associated words"); }
    else if (sVocabHits === 1) { raw += 7; sigs.push("one AI-associated word"); }

    let sTrans = 0;
    AI_TRANSITIONS.forEach(p => { const m = sent.match(p); if (m) sTrans += m.length; });
    if (sTrans > 0) { raw += Math.min(30, sTrans * 15); sigs.push("AI transition phrase"); }

    // Active reductions - human signals lower the score
    if (/\b(yeah|yep|nope|gonna|wanna|kinda|dunno|honestly|frankly)\b/i.test(sent)) { raw = Math.max(0, raw - 30); sigs.push("informal register (human marker)"); }
    if (/-/.test(sent) && !/\w-(from|including|such as)/i.test(sent)) { raw = Math.max(0, raw - 10); }
    if (/\.{3}|…/.test(sent)) { raw = Math.max(0, raw - 8); }
    if (/\?/.test(sent)) { raw = Math.max(0, raw - 10); }
    if (sw.length <= 5) { raw = Math.max(0, raw - 15); }

    const sNorm = Math.min(100, (raw / 65) * 100);
    // Gentle curve - biased against false positives
    let likelihood = sNorm <= 25 ? (sNorm / 25) * 25 :
      sNorm <= 55 ? 25 + ((sNorm - 25) / 30) * 30 :
      55 + Math.min(30, ((sNorm - 55) / 45) * 30);
    likelihood = Math.round(Math.min(95, Math.max(0, likelihood))); // cap at 95 — strict mode

    // STRICT labels — lower thresholds (GPTZero-aligned)
    const label: "uncertain" | "moderate" | "elevated" =
      likelihood >= 45 ? "elevated" : likelihood >= 22 ? "moderate" : "uncertain";

    return { text: sent, likelihood, signals: sigs, label };
  });

  // ── Elevated-sentence internalScore floor ─────────────────────────────────
  // If engine-level suppression (ESL gate, single-signal penalty, warning
  // penalty) collapses rawScore to near-zero while sentence-level analysis has
  // flagged elevated patterns, the internalScore must reflect that signal so
  // the floor propagates correctly into deriveBreakdown AND the combined average.
  // Cap scales with evidence: up to 30 when majority of sentences are elevated,
  // 20 otherwise — conservative enough to avoid false AI verdicts on human text.
  const elevatedCount = sentenceResults.filter(s => s.label === "elevated").length;
  const elevRatio = sentenceResults.length > 0 ? elevatedCount / sentenceResults.length : 0;
  const elevFloor = sentenceResults.length > 0
    ? Math.min(elevRatio > 0.5 ? 30 : 20, Math.round(elevRatio * 30))
    : 0;
  const finalScore = Math.max(rawScore, elevFloor);

  return {
    internalScore: finalScore,
    confidenceLow: low,
    confidenceHigh: high,
    evidenceStrength: strength,
    verdictPhrase: phrase,
    signals,
    sentences: sentenceResults,
    wordCount: wc,
    sentenceCount: sentences.length,
    reliabilityWarnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENGINE B - BURSTINESS & COGNITIVE MARKERS
//  Primary: sentence length CV (burstiness)
//  Secondary: avg sentence length, range, short-sentence presence,
//             rhetorical variation, conceptual hedging patterns
// ─────────────────────────────────────────────────────────────────────────────

function runBurstinessEngine(text: string): EngineResult {
  // Improvement #10: use cached tokenizers to avoid redundant computation
  const words = cachedWordTokenize(text);
  const wc = Math.max(words.length, 1);
  const sentences = cachedSplitSentences(text);
  const lens = sentences.map(s => s.trim().split(/\s+/).length);

  const reliabilityWarnings = getReliabilityWarnings(text, wc, sentences);

  // ── Minimum word count gate ────────────────────────────────────────────────
  if (wc < 80) {
    return {
      internalScore: 0, confidenceLow: 0, confidenceHigh: 30,
      evidenceStrength: "INCONCLUSIVE" as EvidenceStrength,
      verdictPhrase: "Text too short for reliable verdict (need ≥ 80 words)",
      signals: [], sentences: [], wordCount: wc, sentenceCount: sentences.length,
      reliabilityWarnings: ["Text too short for reliable analysis (fewer than 80 words)"],
    };
  }

  const avg = lens.length > 0 ? lens.reduce((a, b) => a + b, 0) / lens.length : 10;
  const variance = lens.length > 1 ? lens.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / lens.length : 0;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / Math.max(avg, 1);
  const range = lens.length > 0 ? Math.max(...lens) - Math.min(...lens) : 0;

  // ── Signal 1: Burstiness (CV of sentence lengths) (Improvement 2: length-adaptive thresholds) ─
  // Human writers naturally vary sentence length. AI is metronomic.
  // STRICT: thresholds tighten for short texts (< 15 sentences) where CV is
  // statistically unreliable — a 5-sentence paragraph can hit extreme CV values by chance.
  // Only apply the standard strict thresholds at 15+ sentences.
  let burstScore = 0;
  if (sentences.length >= 15) {
    // Standard strict thresholds (GPTZero/Turnitin-aligned) — valid at this length
    if (cv < 0.15) burstScore = 50;
    else if (cv < 0.25) burstScore = 38;
    else if (cv < 0.35) burstScore = 24;
    else if (cv < 0.45) burstScore = 12;
  } else if (sentences.length >= 10) {
    // Moderate length: tighten thresholds to reduce noise
    if (cv < 0.10) burstScore = 50;
    else if (cv < 0.18) burstScore = 38;
    else if (cv < 0.28) burstScore = 20;
    else if (cv < 0.38) burstScore = 8;
  } else {
    // Short text (5–9 sentences): only flag very extreme uniformity
    if (cv < 0.08) burstScore = 40;
    else if (cv < 0.14) burstScore = 20;
    // cv >= 0.14 with < 10 sentences: too noisy to call
  }

  // Detect technical/formal writing - suppresses form-based signals
  // that are meaningless for academic essays (no short sentences, no questions)
  const isTechnicalOrFormal = reliabilityWarnings.some(w =>
    w.includes("Technical") || w.includes("formal")
  );

  // ── Signal 2: Short sentence absence ──────────────────────────────────────
  // Human writers use short sentences for emphasis. AI rarely does naturally.
  // SUPPRESSED for technical/formal writing: academic essays never use
  // short punchy sentences regardless of human or AI authorship.
  const hasShortSent = lens.some(l => l <= 6);
  const noShortScore = (!hasShortSent && sentences.length > 6 && !isTechnicalOrFormal) ? 15 : 0;

  // ── Signal 3: Sentence length range ───────────────────────────────────────
  // Very narrow range = metronomic. Only flag with many sentences.
  let rangeScore = 0;
  if (sentences.length >= 6) {
    if (range < 8) rangeScore = 18;
    else if (range < 15) rangeScore = 8;
    else if (range < 22) rangeScore = 2;
  }

  // ── Signal 4: Rhetorical variation markers ─────────────────────────────────
  // Human writers use questions, exclamations, hedges, and asides.
  // These are cognitive markers of human thinking-while-writing.
  // SUPPRESSED for technical/formal writing: academic essays and formal reports
  // naturally contain none of these regardless of human or AI authorship.
  const qCount = (text.match(/\?/g) || []).length;
  const hasEllipsis = /\.{3}/.test(text);
  // Spaced dash " - " is the ASCII stand-in for em-dash (avoids matching hyphens in compound words)
  const hasEmDash = / - /.test(text);
  const hasParenthetical = (text.match(/\([^)]{5,60}\)/g) || []).length;
  const rhetoricalRaw = Math.max(0, 20 - (qCount > 0 ? 8 : 0) - (hasEllipsis ? 5 : 0) - (hasEmDash ? 4 : 0) - (hasParenthetical > 0 ? 5 : 0));
  // Zero out for technical/formal content - these signals don't apply
  const rhetoricalScore = isTechnicalOrFormal ? 0 : rhetoricalRaw;

  // ── Signal 5: Contraction presence ────────────────────────────────────────
  // Contractions = conversational human writing. AI avoids them.
  // ESL/academic-fair: absence is NOT penalised - only presence is a positive signal
  const contrCount = (text.match(TRUE_CONTRACTION_RE) || []).length;
  const contrRate = contrCount / wc;
  // Contractions reduce score (human signal), not increase it
  const contrReduction = contrRate > 0.02 ? 15 : contrRate > 0.008 ? 8 : 0;

  // ── Signal 7: Personal anecdote detector (#6) ─────────────────────────────
  // First-person + past tense verb + specific context = human signal.
  // "I once worked with…" / "Last year I noticed…" / "My experience with X taught me…"
  // AI almost never generates genuine personal narrative.
  const ANECDOTE_RE = /\b(I (once|recently|previously|actually|used to|have (seen|worked|noticed|experienced|learned|found|tried)|spent|started|remember|realized|discovered|struggled|managed)|my (experience|time|work|project|team|colleague|professor|mentor|supervisor|manager|boss)|last (year|month|week|semester|summer|time)|a few (years|months|weeks|days) ago|when I (was|worked|studied|first|began)|back when|working (at|with|on|for) [A-Z])/gi;
  const anecdoteMatches = (text.match(ANECDOTE_RE) || []).length;
  // Also count specificity markers: named events + past tense
  const PAST_TENSE_SPECIFIC_RE = /\b(I (built|wrote|created|designed|implemented|developed|analyzed|tested|deployed|presented|published|co-authored|contributed|collaborated)|we (built|created|developed|launched|shipped|published|presented|analyzed))/gi;
  const specificAnecdotes = (text.match(PAST_TENSE_SPECIFIC_RE) || []).length;
  const totalAnecdoteSignals = anecdoteMatches + specificAnecdotes;
  const anecdoteReduction = totalAnecdoteSignals >= 3 ? 18 : totalAnecdoteSignals >= 2 ? 12 : totalAnecdoteSignals >= 1 ? 6 : 0;

  // ── Signal 8: Numeric specificity (#7) ────────────────────────────────────
  // Human writers quote real numbers; AI uses vague quantifiers.
  // Ratio of specific numerals to vague quantifiers.
  const SPECIFIC_NUMS_RE = /\b(\d{1,3}(%|\s*percent|\s*million|\s*billion|\s*thousand)|in \d{4}|\d+ (study|report|survey|participants?|respondents?|subjects?)|\$\d|figure \d|table \d|chapter \d|page \d)/gi;
  const VAGUE_QUANT_RE = /\b(many|several|numerous|countless|various|a number of|a growing number|a wide range|a large number|some|few|multiple|diverse|various|plenty of|a host of|a variety of|a plethora of|a myriad of)/gi;
  const specificNums = (text.match(SPECIFIC_NUMS_RE) || []).length;
  const vagueQuants = (text.match(VAGUE_QUANT_RE) || []).length;
  const specificityRatio = specificNums / Math.max(vagueQuants + specificNums, 1);
  // Low ratio (few specific numbers, many vague) → AI-like
  const numericVaguenessScore = specificityRatio < 0.1 && vagueQuants >= 4 ? 14
    : specificityRatio < 0.2 && vagueQuants >= 3 ? 10
    : specificityRatio < 0.3 && vagueQuants >= 2 ? 6 : 0;
  // High specificity → human signal (reduction)
  const numericSpecificityReduction = specificityRatio > 0.5 && specificNums >= 3 ? 10 : specificNums >= 5 ? 6 : 0;

  // ── Signal 6: Minimum sentence floor ──────────────────────────────────────
  // AI academic essays never go below ~9 words per sentence — every sentence
  // is "complete" and structured. Human writers, even in formal prose, produce
  // at least a few shorter transitional or emphatic sentences (< 12 words).
  // Only applied when text is long enough (>= 10 sentences) to be meaningful.
  const minSentLen = lens.length > 0 ? Math.min(...lens) : 0;
  const noSubTwelve = lens.filter(l => l < 12).length === 0;
  let minFloorScore = 0;
  if (sentences.length >= 10 && noSubTwelve) {
    // Every single sentence is >= 12 words — very rare in human writing
    minFloorScore = 22;
  } else if (sentences.length >= 8 && minSentLen >= 9 && lens.filter(l => l < 9).length === 0) {
    minFloorScore = 12;
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  // ESL writers produce uniformly-paced formal writing — burstScore and rangeScore
  // are unreliable for them. When ESL flag fires, zero those two signals out so
  // the engine doesn't falsely penalise ESL sentence rhythm.
  // FIX: eslFlagB is now applied to burstScore as well (was missing — caused 20% ESL FPR).
  const eslFlagB = isLikelyESLText(reliabilityWarnings);
  const effectiveBurstScore   = eslFlagB ? 0 : burstScore;
  const effectiveRangeScore   = eslFlagB ? 0 : rangeScore;
  const effectiveMinFloor     = eslFlagB ? 0 : minFloorScore;
  // rhetorical signals are also less meaningful for ESL formal writing
  const effectiveRhetoricalScore = eslFlagB ? Math.round(rhetoricalScore * 0.4) : rhetoricalScore;

  const rawTotal = effectiveBurstScore + noShortScore + effectiveRangeScore + effectiveRhetoricalScore + effectiveMinFloor - contrReduction + numericVaguenessScore;
  const maxTotal = 40 + 15 + 18 + 20 + 22 + 14; // 129 (contraction/anecdote/numeric-specificity are reductions)

  let norm = Math.min(100, Math.max(0, (rawTotal / maxTotal) * 100));

  // Apply human signal reductions
  if (anecdoteReduction > 0) norm = Math.max(0, norm * (1 - anecdoteReduction / 100));
  if (numericSpecificityReduction > 0) norm = Math.max(0, norm * (1 - numericSpecificityReduction / 100));

  // Downgrade: if burstiness alone fires but vocab signals are absent, be conservative
  // STRICT: less aggressive downgrade for low signal count
  const activeSignals = [effectiveBurstScore > 10, noShortScore > 0, effectiveRangeScore > 5, effectiveRhetoricalScore > 8, effectiveMinFloor > 0, numericVaguenessScore > 0].filter(Boolean).length;
  if (activeSignals < 2) norm = norm * 0.75;
  else if (activeSignals < 3) norm = norm * 0.90;

  // Reduced warning penalty
  // Improvement 5: differentiated warning penalties for burstiness engine
  norm = norm * computeWarningPenalty(reliabilityWarnings, "burstiness");

  // ── Gap 8: Domain-adaptive threshold adjustment (Engine B) ─────────────────
  const domainProfileB = detectDomain(text, words);
  if (domainProfileB.multiplier !== 1.0) {
    // Apply a softer domain adjustment to burstiness — CV is less domain-sensitive
    // than vocab signals, so we use a dampened version of the multiplier
    const dampedMultiplier = 1.0 + (domainProfileB.multiplier - 1.0) * 0.5;
    norm = Math.min(100, Math.max(0, norm * dampedMultiplier));
  }

  const rawScore = Math.round(Math.min(100, Math.max(0, norm)));

  // GAP 3 FIX: signal count was hardcoded at 5; Engine B now has 8 signals.
  const totalSignalCountB = 8; // Engine B total signal definitions
  const { low, high, strength, phrase } = computeConfidenceInterval(
    rawScore, totalSignalCountB, activeSignals, reliabilityWarnings, wc
  );

  const signals: SignalResult[] = [
    {
      name: "Sentence Length Variation (Burstiness)",
      value: eslFlagB
        ? `CV = ${cv.toFixed(3)} — signal suppressed: ESL/formal-register writing naturally produces uniform sentence pacing. Burstiness is not a reliable AI indicator for this text type.`
        : `CV = ${cv.toFixed(3)}. STRICT thresholds — Human: CV > 0.45 | Borderline: 0.35–0.45 | Moderate AI: 0.25–0.35 | Strong AI: CV < 0.25 | Very strong: CV < 0.15. Based on ${sentences.length} sentences.`,
      strength: eslFlagB ? 0 : Math.min(100, Math.round((burstScore / 50) * 100)),
      pointsToAI: !eslFlagB && burstScore >= 28,
      wellSupported: !eslFlagB && sentences.length >= 7 && cv < 0.22,
    },
    {
      name: "Short Sentence Presence",
      value: isTechnicalOrFormal
        ? "Signal suppressed: technical/academic writing rarely uses short emphatic sentences regardless of authorship - not a reliable AI indicator for this content type."
        : hasShortSent
          ? "Short sentences (<=6 words) present - consistent with human writing rhythm."
          : sentences.length > 6
            ? "No short sentences found - human writers typically vary with brief emphatic sentences."
            : "Insufficient sentences to evaluate this signal.",
      strength: noShortScore > 0 ? 60 : 10,
      pointsToAI: noShortScore > 0,
      wellSupported: sentences.length > 8 && !isTechnicalOrFormal,
    },
    {
      name: "Sentence Length Range",
      value: `Range = ${range} words (shortest to longest). Narrow range (${range < 8 ? "< 8" : range < 15 ? "8-14" : ">=15"}) associated with uniform AI rhythm.`,
      strength: Math.min(100, Math.round((rangeScore / 18) * 100)),
      pointsToAI: rangeScore >= 8,
      wellSupported: sentences.length >= 8 && range < 12,
    },
    {
      name: "Rhetorical Variation",
      value: isTechnicalOrFormal
        ? "Signal suppressed: technical and academic writing does not use questions, em-dashes, or parentheticals regardless of authorship - absence is not an AI indicator for this content type."
        : [
            qCount > 0 ? `${qCount} question${qCount > 1 ? "s" : ""} (+)` : "no questions",
            hasEllipsis ? "ellipsis (+)" : "no ellipsis",
            hasEmDash ? "em-dash (+)" : "no em-dash",
            hasParenthetical > 0 ? "parenthetical aside (+)" : "no parentheticals",
          ].join(" - ") + ". Human writers naturally use varied rhetorical devices.",
      strength: Math.min(100, rhetoricalScore * 5),
      pointsToAI: rhetoricalScore >= 15,
      wellSupported: wc > 100 && !isTechnicalOrFormal,
    },
    {
      name: "Contraction Presence",
      value: contrCount > 0
        ? `${contrCount} contraction${contrCount > 1 ? "s" : ""} found - positive human signal. Academic writing may lack contractions naturally.`
        : "No contractions - note: academic and ESL writing often avoids contractions. This alone is not an AI indicator.",
      strength: contrCount > 0 ? 15 : 0,
      pointsToAI: false, // contractions always indicate human - never AI
      wellSupported: contrCount >= 3,
    },
    {
      name: "Sentence Length Floor",
      value: minFloorScore > 0
        ? `Shortest sentence: ${minSentLen} words. No sentence is shorter than 12 words across ${sentences.length} sentences. Human writers - even in formal prose - include at least a few shorter transitional sentences. This floor is a strong AI rhythm signal.`
        : `Shortest sentence: ${minSentLen} words - natural variation present, consistent with human writing.`,
      strength: Math.min(100, Math.round((minFloorScore / 22) * 100)),
      pointsToAI: minFloorScore > 0,
      wellSupported: noSubTwelve && sentences.length >= 10,
    },
    {
      name: "Personal Anecdote Presence (human signal)",
      value: totalAnecdoteSignals > 0
        ? `${totalAnecdoteSignals} personal narrative markers detected. First-person past-tense specific accounts are a strong human signal — AI rarely generates genuine personal anecdote.`
        : "No personal anecdote markers detected. Human writers typically include first-person past experiences; absence slightly supports AI authorship.",
      strength: Math.min(100, anecdoteReduction * 5),
      pointsToAI: false,
      wellSupported: totalAnecdoteSignals >= 3,
    },
    {
      name: "Numeric Specificity vs Vague Quantifiers",
      value: `${specificNums} specific numbers/statistics vs ${vagueQuants} vague quantifiers. Ratio: ${(specificityRatio*100).toFixed(0)}% specific. Human writers cite real figures; AI defaults to "many", "several", "numerous".`,
      strength: Math.min(100, Math.round((numericVaguenessScore / 14) * 100)),
      pointsToAI: numericVaguenessScore >= 6,
      wellSupported: numericVaguenessScore >= 10,
    },
  ];

  // ── Per-sentence ───────────────────────────────────────────────────────────
  const sentenceResults: SentenceResult[] = sentences.map(sent => {
    const sWords = sent.toLowerCase().match(/\b[a-z]+\b/g) || [];
    const sigs: string[] = [];
    let raw = 0;

    const sentLen = sent.trim().split(/\s+/).length;
    const deviation = Math.abs(sentLen - avg);
    // Only flag uniform sentences if many sentences AND very tight window
    const isUniform = deviation < avg * 0.20 && sentLen > 12 && sentences.length >= 6;
    if (isUniform) { raw += 20; sigs.push(`uniform length (${sentLen} words, avg ${avg.toFixed(0)})`); }

    const sVocabHits = sWords.filter(w => AI_VOCAB.has(w)).length;
    if (sVocabHits >= 3) { raw += 22; sigs.push(`${sVocabHits} AI-associated words`); }
    else if (sVocabHits >= 2) { raw += 12; sigs.push("2 AI-associated words"); }

    let sTrans = 0;
    AI_TRANSITIONS.forEach(p => { const m = sent.match(p); if (m) sTrans += m.length; });
    if (sTrans > 0) { raw += Math.min(18, sTrans * 9); sigs.push("AI transition phrase"); }

    // Human signals reduce score
    if (/\b(yeah|yep|nope|gonna|wanna|kinda|dunno)\b/i.test(sent)) { raw = Math.max(0, raw - 25); }
    if (/-/.test(sent)) { raw = Math.max(0, raw - 8); }
    if (/\.{3}|…/.test(sent)) { raw = Math.max(0, raw - 8); }
    if (/\?/.test(sent)) { raw = Math.max(0, raw - 12); }
    if (sentLen <= 6) { raw = Math.max(0, raw - 20); sigs.push("short sentence (human burst)"); }
    if ((sent.match(TRUE_CONTRACTION_RE) || []).length > 0) { raw = Math.max(0, raw - 10); }

    const sNorm = Math.min(100, (raw / 60) * 100);
    let likelihood = sNorm <= 25 ? (sNorm / 25) * 25 :
      sNorm <= 55 ? 25 + ((sNorm - 25) / 30) * 30 :
      55 + Math.min(25, ((sNorm - 55) / 45) * 25);
    likelihood = Math.round(Math.min(92, Math.max(0, likelihood)));

    // STRICT labels — lower thresholds (GPTZero-aligned)
    const label: "uncertain" | "moderate" | "elevated" =
      likelihood >= 42 ? "elevated" : likelihood >= 20 ? "moderate" : "uncertain";

    return { text: sent, likelihood, signals: sigs, label };
  });

  // ── Elevated-sentence internalScore floor ─────────────────────────────────
  // ESL suppression can collapse rawScore to 0 while per-sentence scoring still
  // flags elevated patterns. Bake a floor into internalScore so the combined
  // average and deriveBreakdown both reflect the sentence-level evidence.
  // Cap scales with evidence: up to 30 when majority of sentences are elevated,
  // 20 otherwise.
  const elevatedCountB = sentenceResults.filter(s => s.label === "elevated").length;
  const elevRatioB = sentenceResults.length > 0 ? elevatedCountB / sentenceResults.length : 0;
  const elevFloorB = sentenceResults.length > 0
    ? Math.min(elevRatioB > 0.5 ? 30 : 20, Math.round(elevRatioB * 30))
    : 0;
  const finalScoreB = Math.max(rawScore, elevFloorB);

  return {
    internalScore: finalScoreB,
    confidenceLow: low,
    confidenceHigh: high,
    evidenceStrength: strength,
    verdictPhrase: phrase,
    signals,
    sentences: sentenceResults,
    wordCount: wc,
    sentenceCount: sentences.length,
    reliabilityWarnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONSENSUS LAYER (Improvement 4: Engine C participates in consensus)
//  Upgraded from 2-engine to 3-engine majority-vote logic.
//  When Engine C is available:
//   - 2-of-3 agreement on AI → confirm AI verdict
//   - 3-engine unanimous → high confidence
//   - All three disagree → widen confidence interval (INCONCLUSIVE)
// ─────────────────────────────────────────────────────────────────────────────

function applyConsensus(a: EngineResult, b: EngineResult, c?: EngineResult | null): [EngineResult, EngineResult] {
  const aHigh = a.evidenceStrength === "HIGH" || a.evidenceStrength === "MEDIUM";
  const bHigh = b.evidenceStrength === "HIGH" || b.evidenceStrength === "MEDIUM";
  const aBias = a.internalScore > 50;
  const bBias = b.internalScore > 50;

  // ── 3-engine path ──────────────────────────────────────────────────────────
  if (c) {
    const cHigh = c.evidenceStrength === "HIGH" || c.evidenceStrength === "MEDIUM";
    const cBias = c.internalScore > 50;
    const biasVotes = [aBias, bBias, cBias];
    const aiVoteCount = biasVotes.filter(Boolean).length;
    const allHighStrength = aHigh && bHigh && cHigh;
    const allDisagree = new Set(biasVotes).size === 1 ? false : aiVoteCount !== 1 ? false : true; // 1 AI vs 2 Human or vice versa still has a majority

    // 3-engine unanimous AI: upgrade both A and B to HIGH if either is MEDIUM
    if (aiVoteCount === 3 && (aHigh || bHigh)) {
      const upgrade = (r: EngineResult): EngineResult => ({
        ...r,
        evidenceStrength: "HIGH" as EvidenceStrength,
        verdictPhrase: "All three engines agree — strong AI-associated patterns",
        confidenceLow: Math.max(r.confidenceLow, 50),
        confidenceHigh: Math.min(r.confidenceHigh, 90),
      });
      return [upgrade(a), upgrade(b)];
    }

    // 2-of-3 majority AI with at least 2 HIGH/MEDIUM engines: confirm AI verdict
    if (aiVoteCount >= 2 && (aHigh || bHigh || cHigh)) {
      const majorityUpgrade = (r: EngineResult): EngineResult => ({
        ...r,
        evidenceStrength: r.evidenceStrength === "LOW" || r.evidenceStrength === "INCONCLUSIVE"
          ? "MEDIUM" as EvidenceStrength
          : r.evidenceStrength,
        verdictPhrase: "Majority of engines flag AI patterns",
        confidenceLow: Math.max(r.confidenceLow, 35),
        confidenceHigh: Math.min(r.confidenceHigh, 88),
      });
      return [majorityUpgrade(a), majorityUpgrade(b)];
    }

    // All three disagree (1 AI, 2 Human or 2 AI, 1 Human but with wide score spread): widen CI
    const scoreSpread = Math.max(a.internalScore, b.internalScore, c.internalScore)
      - Math.min(a.internalScore, b.internalScore, c.internalScore);
    if (aiVoteCount === 1 && aHigh && bHigh && cHigh && scoreSpread > 25) {
      const widen = (r: EngineResult): EngineResult => ({
        ...r,
        evidenceStrength: "INCONCLUSIVE" as EvidenceStrength,
        verdictPhrase: "Engines disagree — verdict inconclusive",
        confidenceLow: Math.min(r.confidenceLow, 20),
        confidenceHigh: Math.max(r.confidenceHigh, 80),
      });
      return [widen(a), widen(b)];
    }
  }

  // ── 2-engine path (original logic preserved) ──────────────────────────────
  // STRICT: only downgrade to INCONCLUSIVE when scores are wildly apart (>30 pt gap)
  const scoreDiff = Math.abs(a.internalScore - b.internalScore);
  if (aBias !== bBias && aHigh && bHigh && scoreDiff > 30) {
    const downgrade = (r: EngineResult): EngineResult => ({
      ...r,
      evidenceStrength: "MEDIUM",
      verdictPhrase: "Engines partially disagree - moderate AI patterns present",
      confidenceLow: Math.min(r.confidenceLow, 35),
      confidenceHigh: Math.max(r.confidenceHigh, 70),
    });
    return [downgrade(a), downgrade(b)];
  }

  const aIsHigh    = a.evidenceStrength === "HIGH";
  const bIsMedium  = b.evidenceStrength === "MEDIUM";
  const bIsHigh    = b.evidenceStrength === "HIGH";
  const aIsMedium  = a.evidenceStrength === "MEDIUM";
  const bothLeanAI = a.internalScore > 15 && b.internalScore > 10;

  const bStrongAlone = bIsHigh && b.internalScore >= 38 && a.internalScore >= 8;

  if ((aIsHigh && bIsMedium && bothLeanAI) || (bIsHigh && aIsMedium && bothLeanAI) || bStrongAlone) {
    const upgrade = (r: EngineResult): EngineResult => ({
      ...r,
      evidenceStrength: "HIGH" as EvidenceStrength,
      verdictPhrase: bStrongAlone && !bothLeanAI
        ? "Strong burstiness signal — metronomic rhythm characteristic of AI text"
        : "AI-associated patterns detected across multiple signal types",
      confidenceLow:  Math.max(r.confidenceLow,  40),
      confidenceHigh: Math.min(r.confidenceHigh, 88),
    });
    return [upgrade(a), upgrade(b)];
  }

  return [
    { ...a, agreesWithOther: aBias === bBias },
    { ...b, agreesWithOther: aBias === bBias },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - Score gauge replaced by Evidence Strength Badge (no single AI score)
// ─────────────────────────────────────────────────────────────────────────────

// Derive AI / Mixed / Human percentages from internalScore
// elevatedSentenceRatio: fraction of sentences labelled "elevated" (0–1).
// Used to apply a minimum AI% floor when engine-level suppression (ESL gate,
// single-signal penalty, warning penalty) keeps internalScore low despite
// clearly elevated sentence-level patterns.
function deriveBreakdown(internalScore: number, elevatedSentenceRatio = 0): { ai: number; mixed: number; human: number } {
  // Unified single-scale formula: three zones derived from the same score,
  // guaranteed to sum to exactly 100% with no gap artefacts.
  //
  // FIX — Zone boundaries shifted vs. original to close the 0-20 dead zone
  // where AI% was hardcoded to 0 even when sentences showed elevated patterns:
  //   0–10  = Human zone   (AI stays 0, Human 100→70, Mixed grows)
  //  10–50  = Mixed band   (AI rises 0→65, Human falls 65→0, Mixed = remainder)
  //  50–100 = AI zone      (Human stays 0, AI 0→100, Mixed shrinks)
  //
  // Use Math.floor for the primary computed dimension; derive mixed as the
  // remainder to avoid rounding collapse (two different scores → identical bars).

  const s = Math.max(0, Math.min(100, internalScore));

  let ai: number, human: number, mixed: number;

  if (s <= 10) {
    ai    = 0;
    // human decreases linearly from 100 (s=0) to 70 (s=10)
    human = Math.floor(100 - s * 3);
    mixed = 100 - ai - human;
  } else if (s >= 50) {
    human = 0;
    // ai increases linearly from 0 (s=50) to 100 (s=100)
    ai    = Math.floor((s - 50) / 50 * 100);
    mixed = 100 - ai - human;
  } else {
    // Mixed band: t goes 0→1 as s goes 10→50
    const t = (s - 10) / 40;
    ai    = Math.floor(t * 65);
    human = Math.floor((1 - t) * 65);
    mixed = 100 - ai - human;
  }

  ai    = Math.max(0, Math.min(100, ai));
  human = Math.max(0, Math.min(100, human));
  mixed = Math.max(0, 100 - ai - human);

  // ── Elevated-sentence floor ─────────────────────────────────────────────────
  // When engine-level suppression (ESL gate, single-signal penalty, warning
  // penalty) keeps internalScore below 10 — but sentence-level analysis has
  // already flagged elevated patterns — the UI would show AI: 0% which directly
  // contradicts the visible elevated sentences. Apply a proportional floor so
  // the summary bar is never misleadingly zero while elevated sentences exist.
  // Max floor scales with evidence weight: up to 25% when ratio > 0.5 (majority
  // of sentences elevated), 15% otherwise — conservative but not contradictory.
  if (ai === 0 && elevatedSentenceRatio > 0) {
    const maxFloor = elevatedSentenceRatio > 0.5 ? 25 : 15;
    const floor = Math.min(maxFloor, Math.round(elevatedSentenceRatio * 40));
    if (floor > 0) {
      ai    = floor;
      // Absorb the floor from mixed first, then human, so total stays 100
      const mixedAbsorb = Math.min(floor, mixed);
      mixed = mixed - mixedAbsorb;
      human = 100 - ai - mixed;
    }
  }

  return { ai, mixed, human };
}

// FPR FIX: Per-engine verdict only labels "AI-Generated" when AI% decisively
// dominates. Borderline cases (ai ≈ mixed or ai ≈ human) return "Mixed / Uncertain"
// so individual engine cards never auto-label human texts as AI-generated.
function getDominantVerdict(ai: number, mixed: number, human: number): {
  label: string; color: string; bg: string; border: string; icon: string;
} {
  // Require AI to lead by at least 10 points over both alternatives
  if (ai >= mixed + 10 && ai >= human + 10) return { label: "AI-Generated",    color: "text-red-700",     bg: "bg-red-50",     border: "border-red-300",     icon: "🤖" };
  if (human >= mixed + 10 && human >= ai + 10) return { label: "Human-Written",   color: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-300", icon: "✍️" };
  return                                              { label: "Mixed / Uncertain", color: "text-amber-700",   bg: "bg-amber-50",   border: "border-amber-300",   icon: "⚖️" };
}

function ScoreBreakdown({ internalScore, strength, low, high, elevatedSentenceRatio = 0 }: {
  internalScore: number;
  strength: EvidenceStrength;
  low: number;
  high: number;
  elevatedSentenceRatio?: number;
}) {
  const { ai, mixed, human } = deriveBreakdown(internalScore, elevatedSentenceRatio);
  const verdict = getDominantVerdict(ai, mixed, human);

  const evidenceCfg = {
    INCONCLUSIVE: { icon: "⚖️", label: "Inconclusive",         text: "text-slate-500" },
    LOW:          { icon: "✓",  label: "Likely Human",          text: "text-emerald-600" },
    MEDIUM:       { icon: "◈",  label: "Likely AI (Moderate)",  text: "text-amber-600" },
    HIGH:         { icon: "▲",  label: "Likely AI (High)",      text: "text-red-600" },
  }[strength];

  return (
    <div className={`rounded-xl border-2 ${verdict.bg} ${verdict.border} px-4 py-3 space-y-3`}>
      {/* Dominant verdict */}
      <div className="flex items-center justify-between">
        <div className={`flex items-center gap-1.5 font-black text-base ${verdict.color}`}>
          <span>{verdict.icon}</span>
          <span>{verdict.label}</span>
        </div>
        <div className={`text-xs font-bold ${evidenceCfg.text}`}>
          {evidenceCfg.icon} {evidenceCfg.label}
        </div>
      </div>

      {/* Stacked percentage bar */}
      <div className="space-y-1.5">
        <div className="flex h-5 rounded-full overflow-hidden w-full">
          {ai > 0    && <div className="bg-red-400 flex items-center justify-center text-[9px] text-white font-bold transition-all duration-700" style={{ width: `${ai}%` }}>{ai >= 10 ? `${ai}%` : ""}</div>}
          {mixed > 0 && <div className="bg-amber-400 flex items-center justify-center text-[9px] text-white font-bold transition-all duration-700" style={{ width: `${mixed}%` }}>{mixed >= 10 ? `${mixed}%` : ""}</div>}
          {human > 0 && <div className="bg-emerald-400 flex items-center justify-center text-[9px] text-white font-bold transition-all duration-700" style={{ width: `${human}%` }}>{human >= 10 ? `${human}%` : ""}</div>}
        </div>
        {/* Legend row */}
        <div className="flex justify-between text-[10px] font-semibold">
          <span className="flex items-center gap-1 text-red-600">
            <span className="w-2 h-2 rounded-sm bg-red-400 inline-block" />
            AI-Generated <span className="font-black">{ai}%</span>
          </span>
          <span className="flex items-center gap-1 text-amber-600">
            <span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />
            Mixed <span className="font-black">{mixed}%</span>
          </span>
          <span className="flex items-center gap-1 text-emerald-600">
            <span className="w-2 h-2 rounded-sm bg-emerald-400 inline-block" />
            Human <span className="font-black">{human}%</span>
          </span>
        </div>
      </div>

      {/* Confidence range footnote */}
      <div className="text-[9px] text-slate-400 border-t border-current border-opacity-20 pt-1.5 flex justify-between">
        <span>Likelihood range: <span className="font-bold">{low}-{high}%</span></span>
        <span className="uppercase tracking-wide">AI pattern score</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - Signal Row (updated for new SignalResult shape)
// ─────────────────────────────────────────────────────────────────────────────

function SignalRow({ signal }: { signal: SignalResult }) {
  const [open, setOpen] = useState(false);
  const color = signal.pointsToAI
    ? (signal.wellSupported ? "bg-red-400" : "bg-amber-400")
    : "bg-emerald-400";
  const dotColor = signal.pointsToAI
    ? (signal.wellSupported ? "bg-red-400" : "bg-amber-400")
    : "bg-emerald-400";

  return (
    <div className="cursor-pointer select-none" onClick={() => setOpen(v => !v)}>
      <div className="flex items-center gap-2 mb-0.5">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
        <span className="text-xs text-slate-600 flex-1 leading-tight font-medium">{signal.name}</span>
        {signal.wellSupported && signal.pointsToAI && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 font-bold">strong</span>
        )}
        <span className="text-[10px] font-mono text-slate-400 flex-shrink-0">{signal.strength}%</span>
      </div>
      <div className="ml-4 w-full h-1.5 bg-slate-100 rounded-full overflow-hidden mb-0.5">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${signal.strength}%` }} />
      </div>
      {open && <p className="ml-4 text-[10px] text-slate-400 italic mt-0.5 pb-1">{signal.value}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - Sentence Chip (updated for new label scheme)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  UI - Paragraph Heat Map  (Improvement #9)
//  Shows a per-paragraph rollup of sentence-level AI scores.
//  Gives reviewers a fast visual on WHERE in the document AI patterns cluster.
// ─────────────────────────────────────────────────────────────────────────────

function ParagraphHeatMap({ sentences, originalText }: { sentences: SentenceResult[]; originalText: string }) {
  const [expanded, setExpanded] = useState(false);
  if (sentences.length === 0) return null;

  // Split original text into paragraphs preserving offsets
  const rawParas = originalText.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 20);
  if (rawParas.length < 2) return null;

  // GAP 6 FIX: Index-based paragraph→sentence assignment.
  // Build paragraph char-offset ranges, then locate each sentence's start
  // position in the original text and assign it to the correct paragraph.
  // This handles repeated prefixes correctly because we use position, not content.
  type ParaRange = { start: number; end: number; text: string };
  const paraRanges: ParaRange[] = [];
  let searchFrom = 0;
  for (const para of rawParas) {
    const idx = originalText.indexOf(para.slice(0, Math.min(para.length, 40)), searchFrom);
    if (idx !== -1) {
      paraRanges.push({ start: idx, end: idx + para.length, text: para });
      searchFrom = idx + para.length;
    }
  }

  // For each sentence, find its start offset in the original text
  type ParaData = { paraIdx: number; text: string; sentences: SentenceResult[]; avgLikelihood: number; label: "high" | "medium" | "low" };
  const paraSentBuckets: SentenceResult[][] = paraRanges.map(() => []);
  let textCursor = 0;
  for (const sent of sentences) {
    const trimmed = sent.text.trim();
    if (!trimmed) continue;
    // Find this sentence starting from our current cursor position
    const sentStart = originalText.indexOf(trimmed.slice(0, Math.min(trimmed.length, 50)), textCursor);
    if (sentStart === -1) {
      // Fallback: assign to last paragraph with content
      const lastIdx = paraSentBuckets.length - 1;
      if (lastIdx >= 0) paraSentBuckets[lastIdx].push(sent);
      continue;
    }
    // Find which paragraph range contains this offset
    let assigned = false;
    for (let pi = 0; pi < paraRanges.length; pi++) {
      if (sentStart >= paraRanges[pi].start && sentStart <= paraRanges[pi].end + 20) {
        paraSentBuckets[pi].push(sent);
        assigned = true;
        break;
      }
    }
    // Fallback: assign to nearest paragraph by proximity
    if (!assigned) {
      let nearest = 0;
      let minDist = Infinity;
      for (let pi = 0; pi < paraRanges.length; pi++) {
        const dist = Math.abs(sentStart - paraRanges[pi].start);
        if (dist < minDist) { minDist = dist; nearest = pi; }
      }
      paraSentBuckets[nearest].push(sent);
    }
    textCursor = Math.max(0, sentStart - 10); // allow slight overlap for re-search
  }

  // Build paraData from buckets
  const paraData: ParaData[] = [];
  for (let pi = 0; pi < paraRanges.length; pi++) {
    const paraSents = paraSentBuckets[pi];
    if (paraSents.length === 0) continue;
    const avg = paraSents.reduce((s, r) => s + r.likelihood, 0) / paraSents.length;
    paraData.push({
      paraIdx: pi,
      text: paraRanges[pi].text.slice(0, 80) + (paraRanges[pi].text.length > 80 ? "…" : ""),
      sentences: paraSents,
      avgLikelihood: Math.round(avg),
      label: avg >= 55 ? "high" : avg >= 30 ? "medium" : "low",
    });
  }

  if (paraData.length < 2) return null;

  const highCount = paraData.filter(p => p.label === "high").length;
  const medCount  = paraData.filter(p => p.label === "medium").length;

  return (
    <div className="px-5 py-3 border-b border-slate-100">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between mb-1.5 group"
      >
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
          Paragraph Heat Map
          <span className="normal-case font-normal text-slate-300">— click to {expanded ? "collapse" : "expand"}</span>
        </p>
        <div className="flex items-center gap-2 text-[9px] font-medium">
          {highCount > 0 && <span className="bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-bold">{highCount} high</span>}
          {medCount > 0  && <span className="bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded font-bold">{medCount} medium</span>}
          <span className={`text-slate-400 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>▾</span>
        </div>
      </button>

      {/* Compact bar overview — always visible */}
      <div className="flex gap-0.5 h-4 rounded overflow-hidden mb-1">
        {paraData.map((p, i) => {
          const bg = p.label === "high" ? "bg-red-400" : p.label === "medium" ? "bg-amber-300" : "bg-emerald-200";
          return (
            <div
              key={i}
              title={`Para ${i+1}: ${p.avgLikelihood}% avg pattern likelihood`}
              className={`flex-1 ${bg} transition-all`}
              style={{ opacity: 0.5 + p.avgLikelihood / 200 }}
            />
          );
        })}
      </div>
      <p className="text-[9px] text-slate-300 mb-1.5">Each bar = one paragraph. Red = elevated AI patterns, amber = moderate, green = low.</p>

      {/* Expanded detail rows */}
      {expanded && (
        <div className="space-y-1.5 mt-2">
          {paraData.map((p, i) => {
            const barColor = p.label === "high" ? "bg-red-400" : p.label === "medium" ? "bg-amber-300" : "bg-emerald-300";
            const textColor = p.label === "high" ? "text-red-700" : p.label === "medium" ? "text-amber-700" : "text-emerald-700";
            const bgColor   = p.label === "high" ? "bg-red-50 border-red-200" : p.label === "medium" ? "bg-amber-50 border-amber-200" : "bg-slate-50 border-slate-200";
            return (
              <div key={i} className={`rounded-lg border px-2.5 py-2 ${bgColor}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[9px] font-bold text-slate-400 uppercase w-12 flex-shrink-0">Para {i+1}</span>
                  <div className="flex-1 h-1.5 bg-white/60 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${barColor}`} style={{ width: `${p.avgLikelihood}%` }} />
                  </div>
                  <span className={`text-[9px] font-bold ${textColor} w-8 text-right flex-shrink-0`}>{p.avgLikelihood}%</span>
                  <span className={`text-[8px] font-bold uppercase px-1.5 py-0.5 rounded ${p.label === "high" ? "bg-red-200 text-red-700" : p.label === "medium" ? "bg-amber-200 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                    {p.label}
                  </span>
                </div>
                <p className="text-[9px] text-slate-500 italic leading-tight">{p.text}</p>
                <p className="text-[9px] text-slate-400 mt-0.5">{p.sentences.length} sentence{p.sentences.length !== 1 ? "s" : ""} · elevated: {p.sentences.filter(s => s.label === "elevated").length} · moderate: {p.sentences.filter(s => s.label === "moderate").length}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SentenceChip({ s, idx }: { s: SentenceResult; idx: number }) {
  const [show, setShow] = useState(false);
  const hl = {
    elevated: { bg: "bg-red-50",    border: "border-red-300",    text: "text-red-900",    dot: "bg-red-400",    label: "Elevated patterns" },
    moderate: { bg: "bg-amber-50",  border: "border-amber-300",  text: "text-amber-900",  dot: "bg-amber-400",  label: "Some patterns" },
    uncertain:{ bg: "bg-slate-50",  border: "border-slate-200",  text: "text-slate-700",  dot: "bg-slate-400",  label: "No strong patterns" },
  }[s.label];
  const tip = idx % 2 === 0 ? "left-0" : "right-0";

  return (
    <span className={`relative inline cursor-pointer px-0.5 rounded ${hl.bg} border-b-2 ${hl.border} ${hl.text}`}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {s.text}{" "}
      {show && (
        <span className={`absolute ${tip} top-full mt-1 z-50 w-72 bg-white border border-gray-200 shadow-xl rounded-xl p-3 text-xs pointer-events-none`}
          style={{ whiteSpace: "normal" }}>
          <div className="flex items-center gap-1.5 mb-1.5 font-semibold text-gray-800">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${hl.dot}`} />
            {hl.label}
            <span className="ml-auto text-gray-400 font-normal text-[10px]">Pattern likelihood: {s.likelihood}%</span>
          </div>
          <p className="text-[10px] text-gray-400 italic mb-1.5">
            This reflects detected patterns only - it does not determine authorship.
          </p>
          {s.signals.length > 0 ? (
            <ul className="space-y-0.5 text-gray-500">
              {s.signals.map(sig => (
                <li key={sig} className="flex items-center gap-1"><span className="text-slate-400">›</span> {sig}</li>
              ))}
            </ul>
          ) : <span className="text-gray-400 italic">No notable patterns in this sentence</span>}
        </span>
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - Engine Panel (redesigned for fairness-first output)
// ─────────────────────────────────────────────────────────────────────────────

function EnginePanel({
  name, logoText, logoBg, methodology, primarySignal, result, loading, accentColor, borderColor, originalText,
}: {
  name: string; logoText: string; logoBg: string; methodology: string; primarySignal: string;
  result: EngineResult | null; loading: boolean; accentColor: string; borderColor: string;
  originalText?: string;
}) {
  return (
    <div className={`bg-white rounded-2xl shadow-sm border-2 ${borderColor} flex flex-col`}>
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="flex items-center gap-3 mb-2">
          <div className={`w-9 h-9 rounded-xl ${logoBg} flex items-center justify-center flex-shrink-0`}>
            <span className="text-white text-xs font-black">{logoText}</span>
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">{name}</h2>
            <p className="text-[11px] text-slate-500 leading-tight">{methodology}</p>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 whitespace-nowrap">Primary signal:</span>
          <span className="text-[10px] font-bold px-3 py-1.5 rounded-full border text-center leading-tight w-full"
            style={{ backgroundColor: `${accentColor}12`, color: accentColor, borderColor: `${accentColor}40` }}>
            {primarySignal}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20">
          <svg className="animate-spin h-7 w-7" style={{ color: accentColor }} viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
          </svg>
          <p className="text-sm font-medium text-slate-500">Analyzing…</p>
        </div>
      ) : result ? (
        <div className="flex flex-col flex-1">

          {/* Score breakdown + evidence strength */}
          <div className="px-5 pt-4 pb-3 border-b border-slate-100 space-y-3">
            <ScoreBreakdown
              internalScore={result.internalScore}
              strength={result.evidenceStrength}
              low={result.confidenceLow}
              high={result.confidenceHigh}
              elevatedSentenceRatio={
                result.sentences.length > 0
                  ? result.sentences.filter(s => s.label === "elevated").length / result.sentences.length
                  : 0
              }
            />
            <p className="text-xs text-slate-600 leading-relaxed font-medium">{result.verdictPhrase}</p>

            {/* Reliability warnings — domain notes shown separately */}
            {result.reliabilityWarnings.length > 0 && (() => {
              const domainWarnings = result.reliabilityWarnings.filter(w => w.startsWith("Domain detected:"));
              const otherWarnings  = result.reliabilityWarnings.filter(w => !w.startsWith("Domain detected:"));
              return (
                <>
                  {domainWarnings.length > 0 && (
                    <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 space-y-0.5">
                      <p className="text-[10px] font-bold text-blue-700 uppercase tracking-wide">🏷 Domain Detected</p>
                      {domainWarnings.map((w, i) => (
                        <p key={i} className="text-[10px] text-blue-700">{w.replace("Domain detected: ", "")}</p>
                      ))}
                    </div>
                  )}
                  {otherWarnings.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 space-y-0.5">
                      <p className="text-[10px] font-bold text-amber-700 uppercase tracking-wide">⚠ Reliability Notes</p>
                      {otherWarnings.map((w, i) => (
                        <p key={i} className="text-[10px] text-amber-700">{w}</p>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}

            <div className="grid grid-cols-2 gap-1.5 text-center">
              {[
                { label: "Words",     value: result.wordCount },
                { label: "Sentences", value: result.sentenceCount },
              ].map(({ label, value }) => (
                <div key={label} className="bg-white rounded-lg py-1.5 border border-slate-100">
                  <div className="text-sm font-bold text-slate-800">{value}</div>
                  <div className="text-[9px] text-slate-400 uppercase">{label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Engine identity strip */}
          <div className="px-5 py-2 flex items-center gap-2 border-b border-slate-100" style={{ backgroundColor: `${accentColor}08` }}>
            <span className={`w-6 h-6 rounded-lg ${logoBg} flex items-center justify-center flex-shrink-0`}>
              <span className="text-white text-[9px] font-black">{logoText}</span>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold truncate" style={{ color: accentColor }}>{name}</p>
              <p className="text-[9px] text-slate-400">Primary signal: <span className="font-semibold">{primarySignal}</span></p>
            </div>
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full border" style={{ color: accentColor, borderColor: `${accentColor}40`, backgroundColor: `${accentColor}10` }}>
              {result.wordCount}w · {result.sentenceCount}s
            </span>
          </div>

          {/* Signals */}
          <div className="px-5 py-3 border-b border-slate-100">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
              Signal Breakdown <span className="normal-case font-normal text-slate-400">— click any signal to expand</span>
            </p>
            <div className="space-y-2.5">
              {result.signals.map((sig, i) => <SignalRow key={i} signal={sig} />)}
            </div>
          </div>

          {/* Paragraph heat map */}
          <ParagraphHeatMap
            sentences={result.sentences}
            originalText={originalText || result.sentences.map(s => s.text).join(" ")}
          />

          {/* Sentence highlighting */}
          <div className="px-5 py-3">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Sentence-Level Pattern Analysis</p>
              <div className="flex gap-2 text-[9px] font-medium text-slate-400">
                {[
                  { c: "bg-red-300", l: "Elevated" },
                  { c: "bg-amber-300", l: "Moderate" },
                  { c: "bg-slate-300", l: "Uncertain" },
                ].map(({ c, l }) => (
                  <span key={l} className="flex items-center gap-1"><span className={`w-2 h-2 rounded-sm ${c}`} />{l}</span>
                ))}
              </div>
            </div>
            <p className="text-[10px] text-slate-300 mb-2">Hover any sentence for signal details</p>
            <div className="text-sm leading-8 text-slate-800">
              {result.sentences.map((s, i) => <SentenceChip key={i} s={s} idx={i} />)}
            </div>
          </div>

        </div>
      ) : (
        <div className="flex items-center justify-center py-20 text-center px-6">
          <div className="text-slate-400 space-y-1.5">
            <div className="text-3xl">📊</div>
            <p className="text-sm text-slate-400">Results will appear here</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - How Popular AI Text Detection Software Works (educational section)
// ─────────────────────────────────────────────────────────────────────────────

const HOW_IT_WORKS_TECHNIQUES = [
  {
    id: 1,
    icon: "📉",
    title: "Perplexity Analysis",
    color: "border-blue-400",
    badge: "bg-blue-100 text-blue-700",
    badgeLabel: "Core Method",
    body: "The most foundational method. Perplexity measures how \"surprising\" a piece of text is to a language model - how unpredictable each word choice is. AI-generated text tends to have low perplexity because models gravitate toward statistically likely word sequences, while humans make more unexpected, idiosyncratic word choices.",
  },
  {
    id: 2,
    icon: "📊",
    title: "Burstiness Detection",
    color: "border-green-400",
    badge: "bg-green-100 text-green-700",
    badgeLabel: "Rhythm Signal",
    body: "Human writing has burstiness - it alternates between complex, long sentences and short, punchy ones. AI text tends to be rhythmically uniform: sentence lengths and complexity stay suspiciously consistent throughout a passage. Detectors measure the coefficient of variation (CV) of sentence lengths to flag this flatness.",
  },
  {
    id: 3,
    icon: "🔬",
    title: "Stylometric Fingerprinting",
    color: "border-purple-400",
    badge: "bg-purple-100 text-purple-700",
    badgeLabel: "Deep Signal",
    body: "Examines deeper stylistic patterns. Type-Token Ratio (TTR) measures how many unique words vs. total words appear - AI text tends to reuse common vocabulary, lowering TTR. Bigram/trigram density flags overused word-pair combinations that are statistically \"safe\". AI also gravitates toward neutral, balanced sentence construction and avoids things like em-dashes, ellipses, or abrupt fragments.",
  },
  {
    id: 4,
    icon: "🔏",
    title: "Watermarking",
    color: "border-cyan-400",
    badge: "bg-cyan-100 text-cyan-700",
    badgeLabel: "Emerging",
    body: "Some generators (OpenAI and research tools) embed statistical watermarks - subtle biases in token selection during generation, e.g. always preferring certain synonym choices. Detectors that know the watermark pattern can verify origin. This is still emerging and not universally deployed.",
  },
  {
    id: 5,
    icon: "🧲",
    title: "Semantic Coherence & Topic Drift",
    color: "border-amber-400",
    badge: "bg-amber-100 text-amber-700",
    badgeLabel: "Structural",
    body: "AI text tends to stay very on-topic with smooth transitions. Human writing often drifts, contradicts itself, or includes tangential thoughts. Some detectors flag text that is too coherent or too perfectly organized as a sign of machine authorship.",
  },
  {
    id: 6,
    icon: "🤖",
    title: "Training-Based Classifiers",
    color: "border-red-400",
    badge: "bg-red-100 text-red-700",
    badgeLabel: "Dominant Approach",
    body: "Tools like GPTZero, Originality.ai, and Turnitin train binary classifiers - often fine-tuned transformers like RoBERTa - on large labeled datasets of human vs. AI text. The model learns subtle distributional patterns too complex to describe as rules. This is increasingly the dominant approach in commercial tools.",
  },
  {
    id: 7,
    icon: "📐",
    title: "MTLD Lexical Diversity",
    color: "border-teal-400",
    badge: "bg-teal-100 text-teal-700",
    badgeLabel: "Research-Grade",
    body: "Measure of Textual Lexical Diversity (MTLD) is a length-invariant vocabulary richness metric used in computational linguistics research. Unlike simple type-token ratio (TTR), MTLD doesn't artificially inflate for short texts. AI models recycle a limited vocabulary systematically (low MTLD); human writers vary their word choices more naturally (high MTLD). This tool computes both forward and reverse MTLD for stability.",
  },
  {
    id: 8,
    icon: "🔁",
    title: "Semantic Self-Similarity",
    color: "border-indigo-400",
    badge: "bg-indigo-100 text-indigo-700",
    badgeLabel: "Novel Signal",
    body: "AI models express the same conceptual ideas using synonym rotation — 'plays a crucial role' becomes 'serves a vital function' becomes 'fulfills an essential purpose'. Human writers focus on specific ideas without exhausting a synonym thesaurus. This detector measures how many words from the same conceptual cluster (importance, enhancement, facilitation, etc.) appear in a single document.",
  },
  {
    id: 9,
    icon: "🎭",
    title: "Tone Register Flatness",
    color: "border-rose-400",
    badge: "bg-rose-100 text-rose-700",
    badgeLabel: "Novel Signal",
    body: "Human writers modulate emotional tone — they are enthusiastic in some places, critical in others, uncertain elsewhere. AI maintains a suspiciously consistent neutral-to-positive register throughout entire documents, as if written by someone who never gets excited, frustrated, or genuinely uncertain. This detector measures per-sentence sentiment valence variance; low variance with neutral-positive bias is an AI fingerprint.",
  },
];

const TOOL_TABLE = [
  { tool: "GPTZero",       approach: "Perplexity + burstiness + trained classifier" },
  { tool: "Turnitin AI",   approach: "Fine-tuned transformer classifier on academic corpora" },
  { tool: "Originality.ai",approach: "RoBERTa-based classifier + perplexity scoring" },
  { tool: "Copyleaks",     approach: "Multi-model ensemble + semantic analysis" },
  { tool: "ZeroGPT",       approach: "Deep learning classifier + DeepAnalyse™ algorithm" },
];

// ─────────────────────────────────────────────────────────────────────────────
//  UI — LIVE AI WORD HIGHLIGHTER
// ─────────────────────────────────────────────────────────────────────────────

function LiveHighlightedText({ text }: { text: string }) {
  if (!text.trim()) return null;
  const parts: Array<{ word: string; tier: "strong" | "medium" | "none" }> = [];
  const tokenRe = /(\b[a-zA-Z'-]+\b|[^a-zA-Z'-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    const tok = match[0];
    const lower = tok.toLowerCase().replace(/[^a-z]/g, "");
    if (AI_VOCAB_STRONG.has(lower)) parts.push({ word: tok, tier: "strong" });
    else if (AI_VOCAB_MEDIUM.has(lower)) parts.push({ word: tok, tier: "medium" });
    else parts.push({ word: tok, tier: "none" });
  }
  const strongCount = parts.filter(p => p.tier === "strong").length;
  const mediumCount = parts.filter(p => p.tier === "medium").length;
  return (
    <div className="rounded-2xl border-2 border-slate-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-slate-700">🔍 Live AI Word Scanner</span>
          <span className="text-[10px] text-slate-400 hidden sm:inline">Highlights AI-associated vocabulary</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-semibold">
          <span className="flex items-center gap-1 text-red-600"><span className="inline-block w-3 h-1.5 rounded bg-red-400" /> Strong ({strongCount})</span>
          <span className="flex items-center gap-1 text-amber-600"><span className="inline-block w-3 h-1.5 rounded bg-amber-400" /> Medium ({mediumCount})</span>
        </div>
      </div>
      <div className="px-4 py-3 text-sm leading-relaxed text-slate-800 max-h-44 overflow-y-auto whitespace-pre-wrap break-words" style={{ fontSize: "13px", lineHeight: "1.8" }}>
        {parts.map((p, i) =>
          p.tier === "strong" ? (
            <mark key={i} className="bg-red-100 text-red-800 rounded px-0.5 border-b-2 border-red-400 not-italic">{p.word}</mark>
          ) : p.tier === "medium" ? (
            <mark key={i} className="bg-amber-50 text-amber-800 rounded px-0.5 border-b-2 border-amber-300 not-italic">{p.word}</mark>
          ) : (
            <span key={i}>{p.word}</span>
          )
        )}
      </div>
      {(strongCount > 0 || mediumCount > 0) ? (
        <div className="px-4 py-2 bg-slate-50 border-t border-slate-200 text-[10px] text-slate-500">
          {strongCount > 0 && <span className="text-red-600 font-semibold">{strongCount} strong-tier AI word{strongCount !== 1 ? "s" : ""}</span>}
          {strongCount > 0 && mediumCount > 0 && <span className="text-slate-400 mx-1">·</span>}
          {mediumCount > 0 && <span className="text-amber-600 font-semibold">{mediumCount} medium-tier word{mediumCount !== 1 ? "s" : ""}</span>}
          <span className="text-slate-400 ml-2">— red = AI-exclusive vocab, amber = AI-overused formal vocab</span>
        </div>
      ) : (
        <div className="px-4 py-2 bg-emerald-50 border-t border-emerald-200 text-[10px] text-emerald-700 font-semibold">
          ✓ No AI-associated vocabulary detected
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI — WRITING FINGERPRINT RADAR CHART
// ─────────────────────────────────────────────────────────────────────────────

function RadarChart({ perpResult, burstResult, neuralResult }: {
  perpResult: EngineResult | null;
  burstResult: EngineResult | null;
  neuralResult: EngineResult | null;
}) {
  if (!perpResult || !burstResult) return null;
  const getStr = (result: EngineResult, name: string): number => {
    const sig = result.signals.find(s => s.name.toLowerCase().includes(name.toLowerCase()));
    return sig ? Math.min(100, sig.strength) : 0;
  };
  const dims = [
    { label: "Vocabulary", score: Math.min(100, getStr(perpResult, "AI Vocabulary") * 1.2), color: "#ef4444", desc: "AI-specific word density" },
    { label: "Burstiness", score: Math.min(100, getStr(burstResult, "Sentence Length") * 1.1), color: "#f59e0b", desc: "Sentence rhythm uniformity" },
    { label: "Structural", score: Math.min(100, ((getStr(perpResult, "Paragraph-opening") + getStr(perpResult, "Paragraph Structure")) / 2) * 1.4), color: "#8b5cf6", desc: "Document organization rigidity" },
    { label: "Stylometric", score: Math.min(100, ((getStr(perpResult, "Hedged") + getStr(perpResult, "Clause Stack")) / 2) * 1.3), color: "#3b82f6", desc: "Writing style patterns" },
    { label: "Semantic", score: Math.min(100, ((getStr(perpResult, "MTLD") + getStr(perpResult, "Semantic Self")) / 2) * 1.5), color: "#10b981", desc: "Concept diversity & repetition" },
    { label: "Neural", score: neuralResult ? Math.min(100, neuralResult.internalScore * 1.1) : 0, color: "#ec4899", desc: neuralResult ? "LLM token predictability" : "Run analysis to see" },
  ];
  const N = dims.length;
  const CX = 120, CY = 120, R = 88;
  const ang = (i: number) => (2 * Math.PI * i) / N;
  const pt = (i: number, r: number) => ({ x: CX + r * Math.sin(ang(i)), y: CY - r * Math.cos(ang(i)) });
  const gridLevels = [0.25, 0.5, 0.75, 1.0];
  const dataPts = dims.map((d, i) => pt(i, (d.score / 100) * R));
  const poly = dataPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";
  const avgScore = Math.round(dims.reduce((s, d) => s + d.score, 0) / N);
  const dominantDim = dims.reduce((a, b) => a.score > b.score ? a : b);
  return (
    <div className="bg-white rounded-2xl border-2 border-slate-200 overflow-hidden">
      <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
        <div>
          <p className="font-bold text-slate-800 text-sm">🕸 Writing Fingerprint</p>
          <p className="text-[10px] text-slate-400">6-dimensional AI pattern signature</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black text-slate-800">{avgScore}<span className="text-sm font-normal text-slate-400">%</span></p>
          <p className="text-[10px] text-slate-500">avg AI signal</p>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row items-center">
        <div className="flex-shrink-0 p-2">
          <svg width="240" height="240" viewBox="0 0 240 240">
            {gridLevels.map(level => {
              const gpts = dims.map((_, i) => pt(i, level * R));
              const gpath = gpts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";
              return <path key={level} d={gpath} fill="none" stroke="#e2e8f0" strokeWidth="0.8" />;
            })}
            {dims.map((_, i) => { const op = pt(i, R); return <line key={i} x1={CX} y1={CY} x2={op.x.toFixed(1)} y2={op.y.toFixed(1)} stroke="#e2e8f0" strokeWidth="0.8" />; })}
            <path d={poly} fill="rgba(239,68,68,0.12)" stroke="#ef4444" strokeWidth="2" strokeLinejoin="round" />
            {dataPts.map((p, i) => <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r="4" fill={dims[i].color} stroke="white" strokeWidth="1.5" />)}
            <circle cx={CX} cy={CY} r="3" fill="#cbd5e1" />
            {dims.map((d, i) => {
              const lp = pt(i, R + 17);
              const ta = lp.x < CX - 5 ? "end" : lp.x > CX + 5 ? "start" : "middle";
              return (
                <g key={i}>
                  <text x={lp.x.toFixed(1)} y={lp.y.toFixed(1)} textAnchor={ta} fontSize="9" fontWeight="700" fill={d.color} fontFamily="system-ui,sans-serif">{d.label}</text>
                  <text x={lp.x.toFixed(1)} y={(parseFloat(lp.y.toFixed(1)) + 10).toFixed(1)} textAnchor={ta} fontSize="8" fill="#94a3b8" fontFamily="system-ui,sans-serif">{d.score.toFixed(0)}%</text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="flex-1 px-4 py-4 space-y-2 w-full">
          {dims.map(d => (
            <div key={d.label}>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-xs font-bold" style={{ color: d.color }}>{d.label}</span>
                <span className="text-[10px] font-mono text-slate-500">{d.score.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${d.score}%`, backgroundColor: d.color, opacity: 0.8 }} />
              </div>
              <p className="text-[9px] text-slate-400 mt-0.5">{d.desc}</p>
            </div>
          ))}
          <div className="mt-2 pt-2 border-t border-slate-100 text-[10px] text-slate-500">
            Dominant: <span className="font-bold" style={{ color: dominantDim.color }}>{dominantDim.label}</span> ({dominantDim.score.toFixed(0)}%)
          </div>
        </div>
      </div>
    </div>
  );
}


function HowItWorksSection() {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="bg-white rounded-2xl overflow-hidden border border-slate-200">
      {/* Toggle header */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left group"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl">🧠</span>
          <div>
            <p className="text-slate-900 font-bold text-sm">How Popular AI Text Detection Software Works</p>
            <p className="text-slate-400 text-xs mt-0.5">
             {/* 6 core techniques used by GPTZero, Turnitin, Originality.ai and others */}
            </p>
          </div>
        </div>
        <span className={`text-slate-400 text-lg transition-transform duration-300 ${open ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-200 px-5 py-5 space-y-5">

          {/* Intro */}
          <p className="text-slate-500 text-xs leading-relaxed">
            AI text detectors use several overlapping techniques to distinguish human-written from AI-generated content.
            No single technique is definitive - this tool combine many of these signals into ensemble models.
          </p>

          {/* Technique cards */}
          <div className="grid sm:grid-cols-2 gap-3">
            {HOW_IT_WORKS_TECHNIQUES.map(t => (
              <div
                key={t.id}
                onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                className={`cursor-pointer rounded-xl border-l-4 ${t.color} bg-white border border-slate-100 px-4 py-3 space-y-1.5 hover:bg-slate-50 transition-colors`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-base">{t.icon}</span>
                    <span className="text-slate-900 text-xs font-bold">{t.title}</span>
                  </div>
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${t.badge} flex-shrink-0`}>
                    {t.badgeLabel}
                  </span>
                </div>
                <p className={`text-slate-500 text-[10px] leading-relaxed transition-all ${expandedId === t.id ? "" : "line-clamp-2"}`}>
                  {t.body}
                </p>
                {expandedId !== t.id && (
                  <span className="text-[9px] text-slate-500 italic">click to expand</span>
                )}
              </div>
            ))}
          </div>

          {/* Tool comparison table */}
        {/*   <div>
            <p className="text-white text-xs font-bold mb-2 flex items-center gap-2">
              <span>🛠</span> How Major Tools Combine These
            </p>
            <div className="rounded-xl overflow-hidden border border-slate-700">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-700">
                    <th className="text-left text-slate-300 font-semibold px-3 py-2 w-1/3">Tool</th>
                    <th className="text-left text-slate-300 font-semibold px-3 py-2">Core Approach</th>
                  </tr>
                </thead>
                <tbody>
                  {TOOL_TABLE.map((row, i) => (
                    <tr key={row.tool} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-850 bg-opacity-60"}>
                      <td className="text-blue-300 font-bold px-3 py-2">{row.tool}</td>
                      <td className="text-slate-400 px-3 py-2">{row.approach}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div> */}

          {/* Key limitation */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <p className="text-amber-700 text-[10px] font-bold uppercase tracking-wide mb-1">⚠ Key Limitation</p>
            <p className="text-amber-700/80 text-[10px] leading-relaxed">
              All detection methods have a fundamental weakness: paraphrasing and humanization tools (like Quillbot)
              can perturb AI text enough to evade detectors by artificially increasing perplexity and burstiness.
              This detector's three-layer scoring approach - combining vocabulary density, burstiness CV, and
              stylometric fingerprinting - is designed to catch subtler signals even in lightly edited AI text.
            </p>
          </div>

        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENGINE C — NEURAL PERPLEXITY  (Anthropic API · Option C)
//
//  Sends the text to Claude claude-sonnet-4-20250514 with a carefully structured
//  prompt that asks it to evaluate:
//    1. Token-level predictability (proxy for true LLM perplexity)
//    2. Sentence-level semantic smoothness (lack of human "messiness")
//    3. Structural fingerprints: tricolon, paragraph uniformity, transition density
//    4. A per-sentence likelihood estimate
//
//  Returns a full EngineResult so it slots directly into the existing
//  ensemble, PDF report, and UI components with zero changes to those layers.
//
//  How this improves metrics:
//  • Overall Accuracy  ↑  — third independent vote resolves 2-engine ties
//  • AI Recall         ↑  — token-predictability catches paraphrased / lightly
//                           edited AI text that evades heuristic vocab lists
//  • Human Recall      ↑  — LLM knows that high-entropy human prose is NOT
//                           low-perplexity; reduces false-positive rate
//  • Mixed/Hybrid F1   ↑  — the model can reason about sentence-level switches
//                           even when overall stats look ambiguous
//  • False Pos. Rate   ↓  — LLM explicitly flags ESL / academic caveats;
//                           its reasoning layer understands context that
//                           regex patterns cannot
// ─────────────────────────────────────────────────────────────────────────────

async function runNeuralEngine(text: string, engineAContext?: { score: number; topSignals: string[]; evidenceStrength: string } | null, engineBContext?: { score: number; topSignals: string[]; evidenceStrength: string } | null): Promise<EngineResult> {
  const sentences = splitSentences(text);
  const wc = text.trim().split(/\s+/).length;

  if (wc < 80) {
    return {
      internalScore: 0, confidenceLow: 0, confidenceHigh: 30,
      evidenceStrength: "INCONCLUSIVE" as EvidenceStrength,
      verdictPhrase: "Text too short for neural analysis (need ≥ 80 words)",
      signals: [], sentences: [], wordCount: wc, sentenceCount: sentences.length,
      reliabilityWarnings: ["Text too short for reliable analysis (fewer than 80 words)"],
    };
  }

  // Truncate very long texts to stay within a reasonable token budget
  const MAX_WORDS = 800;
  const analysisText = wc > MAX_WORDS
    ? text.trim().split(/\s+/).slice(0, MAX_WORDS).join(" ") + " [truncated for analysis]"
    : text;

  const SYSTEM_PROMPT = `You are an expert AI content detection engine. Your task is to analyze a piece of text and determine the probability that it was generated by an AI language model.

You must respond ONLY with a valid JSON object — no explanation, no markdown, no preamble.

Evaluate the following dimensions and return a score from 0 (strongly human) to 100 (strongly AI):

1. token_predictability: How statistically predictable are the word choices? AI text gravitates toward high-probability sequences. Human text is more idiosyncratic.
2. semantic_smoothness: Is the text suspiciously coherent and on-topic throughout? Human writing drifts, contradicts, and hedges more naturally.
3. structural_uniformity: Are paragraph lengths, sentence counts per paragraph, and sentence rhythms metronomically consistent?
4. transition_density: Does the text overuse AI-typical transition phrases (furthermore, moreover, it is worth noting, etc.)?
5. vocabulary_authenticity: Does the text use AI-typical buzzwords (leverage, holistic, pivotal, robust, synergy, etc.) at unnaturally high density?
6. human_markers: Are there informal phrases, contractions, em-dashes, personal anecdotes, contradictions, or other signals of human cognition?
7. hedging_density: Does the text over-hedge every claim with "may", "can", "generally", "tends to", "in many cases"? AI systematically hedges all claims as a safety mechanism; humans hedge purposefully and sparingly.
8. named_entity_grounding: Does the text reference real people, places, dates, publications, or products? Absence of named entities is a strong AI signal — AI essays float in abstraction. Presence of specific proper nouns grounds the text in human experience.

Also provide:
- overall_score: weighted composite of the above (0-100, higher = more AI-like). If pre-computed engine scores are provided in the user message, calibrate toward their consensus when they strongly agree (both >60 or both <25). When they disagree, reason about the cause from the text.
- evidence_strength: one of "INCONCLUSIVE", "LOW", "MEDIUM", "HIGH"
- verdict_phrase: a single concise sentence describing the result
- reliability_notes: array of strings noting any factors (ESL, academic register, short text, technical content, or engine disagreement) that reduce confidence
- per_sentence: array of objects, one per sentence, each with:
    - likelihood: 0-100 (AI likelihood for this sentence)
    - signals: array of short string descriptions of what was observed

Return exactly this JSON shape:
{
  "token_predictability": number,
  "semantic_smoothness": number,
  "structural_uniformity": number,
  "transition_density": number,
  "vocabulary_authenticity": number,
  "human_markers": number,
  "hedging_density": number,
  "named_entity_grounding": number,
  "overall_score": number,
  "evidence_strength": "INCONCLUSIVE"|"LOW"|"MEDIUM"|"HIGH",
  "verdict_phrase": string,
  "reliability_notes": string[],
  "per_sentence": [{ "likelihood": number, "signals": string[] }]
}`;

  // ── Improvement #9: Engine A/B context augmentation ─────────────────────
  // Pass pre-computed rule-based scores so the LLM can reason about
  // disagreements and produce a better-calibrated overall_score.
  const engineContextBlock = (engineAContext || engineBContext) ? `
Pre-computed rule-based engine scores (for context — use these to inform your reasoning, not as hard constraints):
- Engine A (Perplexity & Stylometry): internalScore=${engineAContext?.score ?? "N/A"}/100, strength=${engineAContext?.evidenceStrength ?? "N/A"}
  Top signals: ${engineAContext?.topSignals?.join("; ") ?? "N/A"}
- Engine B (Burstiness & Cognitive Markers): internalScore=${engineBContext?.score ?? "N/A"}/100, strength=${engineBContext?.evidenceStrength ?? "N/A"}
  Top signals: ${engineBContext?.topSignals?.join("; ") ?? "N/A"}

If Engine A and B strongly agree (both > 60 or both < 25), weight your overall_score toward their consensus.
If they disagree (one > 50, one < 30), look for the reason: paraphrased AI? ESL? mixed authorship?
` : "";

  const USER_PROMPT = `${engineContextBlock}Analyze this text:\n\n${analysisText}`;

  let parsed: any = null;

  try {
    const response = await fetch("/api/neural-analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: USER_PROMPT }],
      }),
    });

    // ── DEBUG: log raw response ──
    const rawBody = await response.text();
    console.log("Neural API status:", response.status);
    console.log("Neural API raw response:", rawBody);
    // ────────────────────────────

    if (!response.ok) {
      throw new Error(`API error ${response.status}: ${rawBody}`);
    }

    const data = JSON.parse(rawBody);
    const rawText = data.content?.find((b: any) => b.type === "text")?.text ?? "";
    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/```json|```/gi, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error("Neural engine API/parse error:", err);
    // GAP 7 FIX: Run the full Engine A per-sentence analysis as the fallback.
    // This gives reviewers accurate sentence-level highlighting even when the
    // neural API is unavailable — the minimal heuristic (3 signals) was a poor
    // substitute for the 19-signal Engine A sentence scorer.
    let fallbackResult: EngineResult;
    try {
      fallbackResult = runPerplexityEngine(text);
    } catch (e2) {
      // If Engine A also fails (shouldn't happen), last-resort minimal fallback
      fallbackResult = {
        internalScore: 0, confidenceLow: 0, confidenceHigh: 50,
        evidenceStrength: "INCONCLUSIVE" as EvidenceStrength,
        verdictPhrase: "Neural engine unavailable — analysis failed",
        signals: [], sentences: sentences.map(s => ({
          text: s, likelihood: 0, signals: [], label: "uncertain" as const,
        })),
        wordCount: wc, sentenceCount: sentences.length,
        reliabilityWarnings: ["Neural engine and fallback both failed"],
      };
    }
    // Wrap in a result that makes clear this is a fallback, not neural analysis
    return {
      internalScore: fallbackResult.internalScore,
      confidenceLow: fallbackResult.confidenceLow,
      confidenceHigh: Math.min(75, fallbackResult.confidenceHigh + 15), // wider CI: less certainty without neural
      evidenceStrength: fallbackResult.evidenceStrength === "HIGH"
        ? "MEDIUM" as EvidenceStrength  // downgrade HIGH to MEDIUM without neural confirmation
        : fallbackResult.evidenceStrength,
      verdictPhrase: "Neural engine unavailable — displaying Engine A rule-based analysis",
      signals: [
        {
          name: "Neural Perplexity (unavailable)",
          value: "API call failed. The results below are Engine A (Perplexity & Stylometry) rule-based analysis reused here. Sentence highlights reflect 19-signal Engine A scoring, not LLM neural analysis.",
          strength: 0, pointsToAI: false, wellSupported: false,
        },
        ...fallbackResult.signals,
      ],
      sentences: fallbackResult.sentences,
      wordCount: wc,
      sentenceCount: sentences.length,
      reliabilityWarnings: [
        "Neural engine API unavailable — showing Engine A rule-based analysis as fallback. Sentence highlights are accurate but lack neural contextual reasoning.",
        ...fallbackResult.reliabilityWarnings,
      ],
    };
  }

  // Map parsed JSON → EngineResult
  const score = Math.max(0, Math.min(100, Math.round(parsed.overall_score ?? 0)));

  const signals: SignalResult[] = [
    {
      name: "Token Predictability",
      value: `Score ${parsed.token_predictability ?? "—"}/100. Measures how statistically predictable word choices are — AI models favour high-probability token sequences.`,
      strength: Math.min(100, Math.round(parsed.token_predictability ?? 0)),
      pointsToAI: (parsed.token_predictability ?? 0) >= 50,
      wellSupported: (parsed.token_predictability ?? 0) >= 70,
    },
    {
      name: "Semantic Smoothness",
      value: `Score ${parsed.semantic_smoothness ?? "—"}/100. AI text maintains unnaturally coherent topic focus; human writing drifts, hedges, and self-corrects.`,
      strength: Math.min(100, Math.round(parsed.semantic_smoothness ?? 0)),
      pointsToAI: (parsed.semantic_smoothness ?? 0) >= 50,
      wellSupported: (parsed.semantic_smoothness ?? 0) >= 70,
    },
    {
      name: "Structural Uniformity",
      value: `Score ${parsed.structural_uniformity ?? "—"}/100. Evaluates consistency of paragraph lengths, sentence counts, and rhythm across the document.`,
      strength: Math.min(100, Math.round(parsed.structural_uniformity ?? 0)),
      pointsToAI: (parsed.structural_uniformity ?? 0) >= 50,
      wellSupported: (parsed.structural_uniformity ?? 0) >= 65,
    },
    {
      name: "Transition Phrase Density",
      value: `Score ${parsed.transition_density ?? "—"}/100. Detects over-reliance on AI-typical connective phrases (furthermore, moreover, it is worth noting, etc.).`,
      strength: Math.min(100, Math.round(parsed.transition_density ?? 0)),
      pointsToAI: (parsed.transition_density ?? 0) >= 50,
      wellSupported: (parsed.transition_density ?? 0) >= 65,
    },
    {
      name: "Vocabulary Authenticity",
      value: `Score ${parsed.vocabulary_authenticity ?? "—"}/100. Assesses whether buzzword density (leverage, holistic, pivotal, robust, synergy…) exceeds natural human usage.`,
      strength: Math.min(100, Math.round(parsed.vocabulary_authenticity ?? 0)),
      pointsToAI: (parsed.vocabulary_authenticity ?? 0) >= 50,
      wellSupported: (parsed.vocabulary_authenticity ?? 0) >= 65,
    },
    {
      name: "Human Cognitive Markers",
      value: `Score ${parsed.human_markers ?? "—"}/100 (higher = more human signals present). Informal register, contractions, em-dashes, personal voice, and contradictions are human indicators.`,
      strength: Math.min(100, Math.round(parsed.human_markers ?? 0)),
      pointsToAI: false, // human_markers is always a human signal
      wellSupported: (parsed.human_markers ?? 0) >= 50,
    },
    {
      name: "Hedging Density",
      value: `Score ${parsed.hedging_density ?? "—"}/100. AI systematically hedges every claim with "may", "can", "generally", "tends to"; human writers hedge purposefully and sparingly.`,
      strength: Math.min(100, Math.round(parsed.hedging_density ?? 0)),
      pointsToAI: (parsed.hedging_density ?? 0) >= 50,
      wellSupported: (parsed.hedging_density ?? 0) >= 65,
    },
    {
      name: "Named-entity Grounding",
      value: `Score ${parsed.named_entity_grounding ?? "—"}/100 (higher = more AI-like abstraction). Human writing references real people, places, dates, and publications. AI essays avoid concrete named references.`,
      strength: Math.min(100, Math.round(parsed.named_entity_grounding ?? 0)),
      pointsToAI: (parsed.named_entity_grounding ?? 0) >= 55,
      wellSupported: (parsed.named_entity_grounding ?? 0) >= 70,
    },
  ];

  // Map per-sentence data — fill missing entries with neutral values
  const sentenceResults: SentenceResult[] = sentences.map((sent, i) => {
    const ps = parsed.per_sentence?.[i];
    // Use max(score, 10) as fallback so sentences aren't all filtered out
    // when overall_score is 0 (INCONCLUSIVE) and per_sentence data is missing/truncated
    const likelihood = Math.min(95, Math.max(0, Math.round(ps?.likelihood ?? Math.max(score, 10))));
    const label: "uncertain" | "moderate" | "elevated" =
      likelihood >= 50 ? "elevated" : likelihood >= 25 ? "moderate" : "uncertain";
    return {
      text: sent,
      likelihood,
      signals: ps?.signals ?? [],
      label,
    };
  });

  const { low, high } = computeConfidenceInterval(score, 8, signals.filter(s => s.pointsToAI).length, parsed.reliability_notes ?? [], wc);

  // ── Elevated-sentence internalScore floor ─────────────────────────────────
  // Guard against the LLM returning overall_score=0 while marking sentences
  // elevated. The floor ensures internalScore always reflects sentence evidence.
  const neuralElevated = sentenceResults.filter(s => s.label === "elevated").length;
  const neuralFloor = sentenceResults.length > 0
    ? Math.min(20, Math.round((neuralElevated / sentenceResults.length) * 30))
    : 0;
  const finalNeuralScore = Math.max(score, neuralFloor);

  return {
    internalScore: finalNeuralScore,
    confidenceLow: low,
    confidenceHigh: high,
    evidenceStrength: (parsed.evidence_strength as EvidenceStrength) ?? "INCONCLUSIVE",
    verdictPhrase: parsed.verdict_phrase ?? "Neural analysis complete",
    signals,
    sentences: sentenceResults,
    wordCount: wc,
    sentenceCount: sentences.length,
    reliabilityWarnings: parsed.reliability_notes ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - LIVE WORD HIGHLIGHTER
//  Real-time overlay that colorizes AI-flagged vocabulary as user types.
//  Strong-tier words → red underline, Medium-tier → amber, Bigrams → purple.
// ─────────────────────────────────────────────────────────────────────────────

function LiveWordHighlighter({ text }: { text: string }) {
  if (!text.trim()) return null;

  const AI_BIGRAMS_FLAT = [
    "plays a crucial","plays a pivotal","plays a vital","it is worth noting",
    "it is important to note","cannot be overstated","in today's world","in today's society",
    "it is important","it is crucial","it is essential","in order to ensure",
    "let's explore","dive deeper","shed light on","at its core","at the heart of",
    "a nuanced understanding","a deeper understanding","not only","but also",
    "first and foremost","last but not least","moving forward","going forward",
    "in conclusion","to summarize","to sum up","in summary",
  ];

  // Tokenize while preserving whitespace/punctuation positions
  const tokens: Array<{ text: string; type: "strong" | "medium" | "bigram" | "normal" }> = [];
  const words = text.split(/(\s+|[.,;:!?()\[\]"'\n])/);
  let i = 0;
  let processed = 0;

  // First pass: mark bigrams (check pairs of consecutive word tokens)
  const wordTokens = text.toLowerCase().match(/\b[a-z]+\b/g) || [];
  const bigramSet = new Set<number>(); // indices of words that are part of a bigram
  for (let wi = 0; wi < wordTokens.length - 1; wi++) {
    const pair = wordTokens[wi] + " " + wordTokens[wi + 1];
    const triple = wi < wordTokens.length - 2 ? pair + " " + wordTokens[wi + 2] : "";
    if (AI_BIGRAMS_FLAT.some(b => triple.startsWith(b) || b === pair)) {
      bigramSet.add(wi);
      bigramSet.add(wi + 1);
      if (triple && AI_BIGRAMS_FLAT.some(b => b === triple)) bigramSet.add(wi + 2);
    }
  }

  // Build rendered spans
  let wordIdx = 0;
  const parts: Array<{ segment: string; cls: string }> = [];
  let remaining = text;
  let pos = 0;

  // Simple word-by-word scan
  const tokenRe = /\b[a-zA-Z]+\b/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(text)) !== null) {
    // Add any non-word gap before this word
    if (m.index > lastEnd) {
      parts.push({ segment: text.slice(lastEnd, m.index), cls: "" });
    }
    const lower = m[0].toLowerCase();
    let cls = "";
    if (bigramSet.has(wordIdx)) {
      cls = "bg-purple-100 text-purple-800 rounded px-0.5 underline decoration-purple-400 decoration-dotted";
    } else if (AI_VOCAB_STRONG.has(lower)) {
      cls = "bg-red-100 text-red-800 rounded px-0.5 underline decoration-red-400 decoration-wavy";
    } else if (AI_VOCAB_MEDIUM.has(lower)) {
      cls = "bg-amber-100 text-amber-800 rounded px-0.5 underline decoration-amber-400 decoration-dotted";
    }
    parts.push({ segment: m[0], cls });
    wordIdx++;
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) {
    parts.push({ segment: text.slice(lastEnd), cls: "" });
  }

  const aiWordCount = parts.filter(p => p.cls.includes("red") || p.cls.includes("amber") || p.cls.includes("purple")).length;

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
          Live AI Pattern Highlighter
          <span className="font-normal normal-case text-slate-400">— {aiWordCount} flagged term{aiWordCount !== 1 ? "s" : ""}</span>
        </p>
        <div className="flex items-center gap-3 text-[9px] font-semibold">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-red-200 border border-red-400 inline-block" />Strong AI</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-amber-200 border border-amber-400 inline-block" />Medium AI</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-purple-200 border border-purple-400 inline-block" />AI Phrase</span>
        </div>
      </div>
      <div className="px-4 py-3 text-sm leading-relaxed text-slate-700 font-sans max-h-52 overflow-y-auto whitespace-pre-wrap">
        {parts.map((p, i) =>
          p.cls ? <span key={i} className={p.cls}>{p.segment}</span> : <span key={i}>{p.segment}</span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI - RADAR CHART FINGERPRINT (6-axis SVG)
//  Shows multi-dimensional writing signature like GPTZero's Writing Profile.
//  Axes: Vocabulary, Burstiness, Structure, Semantic, Tone, Discourse
// ─────────────────────────────────────────────────────────────────────────────

function RadarChartFingerprint({ perpResult, burstResult }: {
  perpResult: EngineResult | null;
  burstResult: EngineResult | null;
}) {
  if (!perpResult || !burstResult) return null;

  const getSignalStrength = (result: EngineResult, nameFragment: string) =>
    result.signals.find(s => s.name.includes(nameFragment))?.strength ?? 0;

  // 6 dimensions — each 0-100
  const dims = [
    {
      label: "Vocabulary",
      score: getSignalStrength(perpResult, "Vocabulary Density"),
      color: "#ef4444",
    },
    {
      label: "Burstiness",
      score: getSignalStrength(burstResult, "Sentence Length Variation"),
      color: "#f97316",
    },
    {
      label: "Structure",
      score: Math.max(
        getSignalStrength(perpResult, "Paragraph-Opening"),
        getSignalStrength(perpResult, "Discourse Schema"),
      ),
      color: "#eab308",
    },
    {
      label: "Semantic",
      score: Math.max(
        getSignalStrength(perpResult, "Semantic Self-Similarity"),
        getSignalStrength(perpResult, "AI Multi-word"),
      ),
      color: "#8b5cf6",
    },
    {
      label: "Tone",
      score: Math.max(
        getSignalStrength(perpResult, "Tone Register"),
        getSignalStrength(perpResult, "Hedged-Certainty"),
      ),
      color: "#06b6d4",
    },
    {
      label: "Lexical",
      score: Math.max(
        getSignalStrength(perpResult, "MTLD"),
        getSignalStrength(perpResult, "Moving-window TTR"),
      ),
      color: "#10b981",
    },
  ];

  const CX = 110, CY = 110, R = 80;
  const N = dims.length;

  const getPoint = (i: number, r: number) => {
    const angle = (Math.PI * 2 * i) / N - Math.PI / 2;
    return { x: CX + r * Math.cos(angle), y: CY + r * Math.sin(angle) };
  };

  const polyPoints = dims.map((d, i) => getPoint(i, (d.score / 100) * R));
  const polyStr = polyPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Background rings at 25, 50, 75, 100%
  const rings = [0.25, 0.5, 0.75, 1.0];

  // Overall AI score for display
  const overallAI = Math.round(dims.reduce((sum, d) => sum + d.score, 0) / dims.length);
  const overallColor = overallAI >= 60 ? "#ef4444" : overallAI >= 35 ? "#f59e0b" : "#10b981";

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm font-bold text-slate-900">Writing Fingerprint</p>
          <p className="text-[10px] text-slate-500 mt-0.5">6-dimension AI pattern signature</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black" style={{ color: overallColor }}>{overallAI}%</p>
          <p className="text-[9px] text-slate-400 uppercase tracking-wide">Composite AI</p>
        </div>
      </div>

      <div className="flex items-center justify-center">
        <svg width="220" height="220" viewBox="0 0 220 220" className="overflow-visible">
          {/* Background rings */}
          {rings.map((r, ri) => (
            <polygon
              key={ri}
              points={Array.from({ length: N }, (_, i) => {
                const p = getPoint(i, r * R);
                return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
              }).join(" ")}
              fill="none"
              stroke="#e2e8f0"
              strokeWidth={r === 1 ? "1.5" : "0.8"}
            />
          ))}

          {/* Axis lines */}
          {dims.map((_, i) => {
            const p = getPoint(i, R);
            return <line key={i} x1={CX} y1={CY} x2={p.x.toFixed(1)} y2={p.y.toFixed(1)} stroke="#e2e8f0" strokeWidth="1" />;
          })}

          {/* Data polygon */}
          <polygon
            points={polyStr}
            fill="rgba(239,68,68,0.15)"
            stroke="#ef4444"
            strokeWidth="2"
            strokeLinejoin="round"
          />

          {/* Data points */}
          {polyPoints.map((p, i) => (
            <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r="4" fill={dims[i].color} stroke="white" strokeWidth="1.5" />
          ))}

          {/* Axis labels */}
          {dims.map((d, i) => {
            const labelR = R + 18;
            const p = getPoint(i, labelR);
            const anchor = p.x < CX - 10 ? "end" : p.x > CX + 10 ? "start" : "middle";
            return (
              <text key={i} x={p.x.toFixed(1)} y={p.y.toFixed(1)}
                textAnchor={anchor} dominantBaseline="middle"
                fontSize="9" fontWeight="700" fill={dims[i].color}
                fontFamily="system-ui, sans-serif">
                {d.label}
              </text>
            );
          })}

          {/* Percentage labels on each axis */}
          {dims.map((d, i) => {
            const p = getPoint(i, (d.score / 100) * R);
            if (d.score < 15) return null;
            return (
              <text key={`pct-${i}`} x={p.x.toFixed(1)} y={(p.y - 7).toFixed(1)}
                textAnchor="middle" fontSize="7" fontWeight="700" fill={dims[i].color}
                fontFamily="system-ui, sans-serif">
                {d.score}%
              </text>
            );
          })}

          {/* Ring labels */}
          <text x={CX + 2} y={CY - R * 0.25 - 2} fontSize="6" fill="#94a3b8" textAnchor="middle" fontFamily="system-ui">25</text>
          <text x={CX + 2} y={CY - R * 0.5 - 2} fontSize="6" fill="#94a3b8" textAnchor="middle" fontFamily="system-ui">50</text>
          <text x={CX + 2} y={CY - R * 0.75 - 2} fontSize="6" fill="#94a3b8" textAnchor="middle" fontFamily="system-ui">75</text>
        </svg>
      </div>

      {/* Dimension legend */}
      <div className="grid grid-cols-3 gap-1.5 mt-2">
        {dims.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: d.color }} />
            <span className="text-[9px] text-slate-600 font-medium">{d.label}</span>
            <span className="ml-auto text-[9px] font-bold" style={{ color: d.color }}>{d.score}%</span>
          </div>
        ))}
      </div>

      {/* ── Dimension explanations ── */}
      <FingerprintExplanation dims={dims} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Writing Fingerprint — expandable dimension explanation panel
//  Rendered inside the fingerprint card frame. Each axis gets a plain-English
//  description of what it measures and what a high vs. low score means.
// ─────────────────────────────────────────────────────────────────────────────

const FINGERPRINT_DIMENSION_GUIDE: Record<string, { what: string; high: string; low: string }> = {
  Vocabulary: {
    what: "Measures the density of AI-associated words and phrases — terms like \"delve\", \"tapestry\", \"nuanced\", and \"multifaceted\" that language models reach for far more often than human writers do.",
    high: "The text contains a high concentration of AI-typical buzzwords. This is one of the strongest individual indicators, especially when strong-tier words appear.",
    low:  "Word choices are within the normal range for human writing. Little to no AI-associated vocabulary detected.",
  },
  Burstiness: {
    what: "Measures how much sentence length varies across the text (coefficient of variation, or CV). Human writers naturally alternate short punchy sentences with longer ones. AI models tend to produce metronomic, uniform sentence lengths.",
    high: "Sentence lengths are unusually uniform — the CV is low, meaning the text lacks the natural rhythm variation of human writing. This pattern is characteristic of AI generation.",
    low:  "Sentence lengths vary naturally, consistent with human writing. The text has the kind of rhythmic variation that is difficult for AI to replicate convincingly.",
  },
  Structure: {
    what: "Looks at two structural patterns: (1) paragraph-opening fingerprint — AI essays overwhelmingly open paragraphs with formulaic transitions like \"Furthermore,\" \"It is important to note,\" or \"In conclusion\"; (2) discourse schema predictability — whether the text follows a rigid AI template of intro → claim → evidence → ethics → conclusion.",
    high: "Paragraph openers and overall document structure follow predictable AI formulas. Human writers vary how they open paragraphs and organise arguments.",
    low:  "Paragraph openings and overall structure show natural variation, consistent with human composition.",
  },
  Semantic: {
    what: "Captures two forms of semantic repetition: (1) self-similarity — AI models reuse the same conceptual frames with synonym substitution (e.g., \"plays a crucial role\" → \"serves a vital function\" → \"fulfils a key purpose\"); (2) AI multi-word phrases — fixed two- and three-word patterns that appear overwhelmingly in AI-generated text.",
    high: "The text reuses the same underlying ideas in slightly different wording, and contains AI-specific multi-word patterns. This synonym-cycling is a hallmark of AI generation.",
    low:  "Conceptual content is varied and phrase patterns are within normal human range.",
  },
  Tone: {
    what: "Examines two tonal signals: (1) tone register flatness — AI text maintains an unchangingly even, polished register with no colloquial dips, emotional shifts, or informal asides; (2) hedged-certainty density — AI uses a specific kind of hedging (\"it could be argued\", \"one might suggest\") that differs from how human writers qualify claims.",
    high: "The text has an unnaturally flat, uniform tone throughout, and uses AI-style hedging constructions at a higher than typical rate.",
    low:  "Tone varies naturally across the text, and hedging patterns are within normal human range.",
  },
  Lexical: {
    what: "Two length-invariant vocabulary diversity measures: (1) MTLD (Measure of Textual Lexical Diversity) — calculates the average length of word runs before vocabulary starts repeating; AI text typically scores below 55 while human text scores above 80; (2) Moving-window TTR variance — checks whether vocabulary diversity stays suspiciously constant across the document, as AI models tend to recycle the same lexical inventory throughout.",
    high: "Vocabulary diversity is lower than expected for human writing of this length. The text reuses the same word stock with limited lexical range.",
    low:  "Vocabulary diversity is within the human range. The text draws on a varied lexical inventory.",
  },
};

function FingerprintExplanation({ dims }: { dims: Array<{ label: string; score: number; color: string }> }) {
  const [open, setOpen] = useState(false);
  const [activeAxis, setActiveAxis] = useState<string | null>(null);

  // Sort by score descending so the most diagnostic axes appear first
  const sorted = [...dims].sort((a, b) => b.score - a.score);

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between text-left group"
        aria-expanded={open}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 group-hover:text-slate-600 transition-colors">
          What does each axis mean?
        </span>
        <svg
          className={`w-3.5 h-3.5 text-slate-400 transition-transform flex-shrink-0 ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20" fill="currentColor"
        >
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div className="mt-3 space-y-1.5">
          {/* Axis selector pills */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {sorted.map(d => (
              <button
                key={d.label}
                onClick={() => setActiveAxis(activeAxis === d.label ? null : d.label)}
                className="flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded-full border transition-all"
                style={activeAxis === d.label
                  ? { background: d.color, color: "#fff", borderColor: d.color }
                  : { background: "transparent", color: d.color, borderColor: `${d.color}55` }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: activeAxis === d.label ? "#fff" : d.color }}
                />
                {d.label}
                <span
                  className="ml-0.5 font-black text-[9px]"
                  style={{ color: activeAxis === d.label ? "rgba(255,255,255,0.8)" : d.color }}
                >
                  {d.score}%
                </span>
              </button>
            ))}
          </div>

          {/* Detail card — shown when an axis is selected */}
          {activeAxis && FINGERPRINT_DIMENSION_GUIDE[activeAxis] && (() => {
            const guide = FINGERPRINT_DIMENSION_GUIDE[activeAxis];
            const dim   = dims.find(d => d.label === activeAxis)!;
            const isHigh = dim.score >= 50;
            return (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 space-y-2.5">
                {/* Header */}
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: dim.color }} />
                  <span className="text-xs font-bold text-slate-800">{activeAxis}</span>
                  <span
                    className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full"
                    style={{ color: dim.color, background: `${dim.color}18`, border: `1px solid ${dim.color}40` }}
                  >
                    {dim.score}% {isHigh ? "— elevated" : dim.score >= 25 ? "— moderate" : "— low"}
                  </span>
                </div>

                {/* What this axis measures */}
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 mb-1">What it measures</p>
                  <p className="text-[11px] text-slate-600 leading-relaxed">{guide.what}</p>
                </div>

                {/* Contextual interpretation for this result */}
                <div
                  className="rounded-lg px-3 py-2"
                  style={{ background: isHigh ? `${dim.color}10` : "#f0fdf410", border: `1px solid ${isHigh ? dim.color + "35" : "#bbf7d0"}` }}
                >
                  <p
                    className="text-[9px] font-semibold uppercase tracking-wide mb-1"
                    style={{ color: isHigh ? dim.color : "#16a34a" }}
                  >
                    {isHigh ? "What this high score means" : "What this low score means"}
                  </p>
                  <p className="text-[11px] leading-relaxed" style={{ color: isHigh ? dim.color : "#15803d" }}>
                    {isHigh ? guide.high : guide.low}
                  </p>
                </div>
              </div>
            );
          })()}

          {/* Fallback prompt when nothing is selected */}
          {!activeAxis && (
            <p className="text-[10px] text-slate-400 italic text-center py-1">
              Tap any axis above to see what it measures and how to interpret the score.
            </p>
          )}

          {/* Reading guide */}
          <div className="mt-2 rounded-lg bg-slate-100 px-3 py-2.5">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">How to read the chart</p>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              Each axis runs from the centre (0%) to the outer ring (100%). A larger filled polygon means more AI-associated patterns across more dimensions. A genuinely human text typically produces a small, irregular polygon close to the centre. A clear AI text produces a large, roughly symmetric polygon. Uneven shapes — one or two axes spiking while others remain low — are common in mixed, edited, or borderline texts and warrant human review rather than an automatic verdict.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  PRODUCTION UI  — v2 complete redesign
//  Improvements: circular gauge, inline overlay, scan history, tabbed input,
//  5-tier verdict scale, mobile-first layout, accessibility, share/export
// ─────────────────────────────────────────────────────────────────────────────

// ── Scan History (localStorage) ─────────────────────────────────────────────

interface ScanRecord {
  id: string;
  ts: number;
  snippet: string;
  wordCount: number;
  verdict: string;
  aiPct: number;
  evidenceStrength: string;
}

function loadHistory(): ScanRecord[] {
  try { return JSON.parse(localStorage.getItem("aidetect_history") || "[]"); }
  catch { return []; }
}

function saveHistory(records: ScanRecord[]) {
  try { localStorage.setItem("aidetect_history", JSON.stringify(records.slice(0, 20))); }
  catch { /* quota exceeded — ignore */ }
}

// ── Breakdown helper (kept in sync with PDF layer) ──────────────────────────

function uiDeriveBreakdown(score: number, elevatedRatio = 0): { ai: number; mixed: number; human: number } {
  const s = Math.max(0, Math.min(100, score));
  let ai: number, human: number, mixed: number;
  if (s <= 10) {
    ai = 0; human = Math.floor(100 - s * 3); mixed = 100 - ai - human;
  } else if (s >= 50) {
    human = 0; ai = Math.floor((s - 50) / 50 * 100); mixed = 100 - ai - human;
  } else {
    const t = (s - 10) / 40;
    ai = Math.floor(t * 65); human = Math.floor((1 - t) * 65); mixed = 100 - ai - human;
  }
  ai    = Math.max(0, Math.min(100, ai));
  human = Math.max(0, Math.min(100, human));
  mixed = Math.max(0, 100 - ai - human);
  if (ai === 0 && elevatedRatio > 0) {
    const maxFloor = elevatedRatio > 0.5 ? 25 : 15;
    const floor = Math.min(maxFloor, Math.round(elevatedRatio * 40));
    if (floor > 0) { ai = floor; const ab = Math.min(floor, mixed); mixed -= ab; human = 100 - ai - mixed; }
  }
  return { ai, mixed, human };
}

// ── 6-Tier Verdict ───────────────────────────────────────────────────────────
// FPR FIX: Thresholds recalibrated based on evaluation data.
// Score distribution shows human texts cluster in 0–10 band; all AI texts ≥ 6.
// Old boundary of <20 "Likely Human" was too aggressive — many borderline human
// texts (formal academic, research notes) scored 6–10 and were falsely flagged.
// New boundaries:
//   < 20  → Likely Human       (unchanged — clear human zone)
//   20–34 → Mostly Human       (shifted: previously triggered "Mixed")
//   35–49 → Needs Human Review (NEW: explicit caution zone — do not auto-flag)
//   50–64 → Mixed / Uncertain  (previously Likely AI)
//   65–79 → Likely AI
//   ≥ 80  → Almost Certainly AI
// The "Needs Human Review" tier is the primary FPR mitigation: texts in this
// zone are routed to a reviewer rather than receiving an automatic AI verdict.

function getTier(aiPct: number): { label: string; color: string; bg: string; border: string; ring: string; dot: string; needsReview: boolean } {
  if (aiPct < 20)  return { label: "Likely Human",        color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", ring: "#22c55e", dot: "bg-emerald-500", needsReview: false };
  if (aiPct < 35)  return { label: "Mostly Human",        color: "#65a30d", bg: "#f7fee7", border: "#d9f99d", ring: "#84cc16", dot: "bg-lime-500",    needsReview: false };
  if (aiPct < 50)  return { label: "Needs Human Review",  color: "#b45309", bg: "#fffbeb", border: "#fcd34d", ring: "#f59e0b", dot: "bg-yellow-500",  needsReview: true  };
  if (aiPct < 65)  return { label: "Mixed / Uncertain",   color: "#d97706", bg: "#fff7ed", border: "#fed7aa", ring: "#fb923c", dot: "bg-amber-500",   needsReview: false };
  if (aiPct < 80)  return { label: "Likely AI",           color: "#ea580c", bg: "#fff1f0", border: "#fca5a5", ring: "#f97316", dot: "bg-orange-500",  needsReview: false };
  return               { label: "Almost Certainly AI",  color: "#dc2626", bg: "#fef2f2", border: "#fecaca", ring: "#ef4444", dot: "bg-red-500",     needsReview: false };
}

// ── Circular Gauge (SVG) ─────────────────────────────────────────────────────

function CircularGauge({ pct, color, size = 160 }: { pct: number; color: string; size?: number }) {
  const r = (size / 2) - 14;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const cx = size / 2, cy = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block" aria-hidden="true">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2e8f0" strokeWidth="10" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="10"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: "stroke-dasharray 0.8s cubic-bezier(.4,0,.2,1)" }} />
      <text x={cx} y={cy - 6} textAnchor="middle" fontSize="22" fontWeight="800" fill={color} fontFamily="system-ui,sans-serif">{pct}%</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize="10" fill="#94a3b8" fontFamily="system-ui,sans-serif">AI Score</text>
    </svg>
  );
}

// ── Inline Document Overlay (new: full-text with highlighted sentences) ──────

function DocumentOverlay({ text, sentences }: {
  text: string;
  sentences: Array<{ text: string; likelihood: number; signals: string[]; label: "uncertain" | "moderate" | "elevated" }>;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos]  = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const getBg = (label: string, hovered: boolean) => {
    if (label === "elevated") return hovered ? "rgba(239,68,68,0.25)"  : "rgba(239,68,68,0.12)";
    if (label === "moderate") return hovered ? "rgba(245,158,11,0.25)" : "rgba(245,158,11,0.10)";
    return "transparent";
  };
  const getBorder = (label: string) => {
    if (label === "elevated") return "2px solid rgba(239,68,68,0.45)";
    if (label === "moderate") return "2px solid rgba(245,158,11,0.35)";
    return "none";
  };

  // Build a map of sentence text → result for fast lookup
  const sentMap = new Map<string, typeof sentences[0]>();
  sentences.forEach(s => sentMap.set(s.text.trim(), s));

  // Reconstruct the document with highlights by splitting on sentence boundaries
  // We walk the original text and try to match known sentence strings
  const parts: Array<{ segment: string; sentIdx: number | null }> = [];
  let remaining = text;
  let sIdx = 0;
  for (const sent of sentences) {
    const clean = sent.text.trim();
    const pos = remaining.indexOf(clean);
    if (pos === -1) { sIdx++; continue; }
    if (pos > 0) parts.push({ segment: remaining.slice(0, pos), sentIdx: null });
    parts.push({ segment: clean, sentIdx: sIdx });
    remaining = remaining.slice(pos + clean.length);
    sIdx++;
  }
  if (remaining.length > 0) parts.push({ segment: remaining, sentIdx: null });

  return (
    <div className="relative">
      {/* Legend */}
      <div className="flex items-center gap-4 mb-3 flex-wrap">
        {[
          { label: "Elevated (likely AI)", bg: "rgba(239,68,68,0.18)", border: "1.5px solid rgba(239,68,68,0.5)" },
          { label: "Moderate", bg: "rgba(245,158,11,0.15)", border: "1.5px solid rgba(245,158,11,0.45)" },
          { label: "Uncertain / Human", bg: "transparent", border: "none" },
        ].map(({ label, bg, border }) => (
          <span key={label} className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className="inline-block w-3.5 h-3.5 rounded-sm flex-shrink-0" style={{ background: bg, border }} />
            {label}
          </span>
        ))}
      </div>

      <div className="relative text-[14px] leading-[1.85] text-slate-800 font-serif max-h-[500px] overflow-y-auto pr-2 scrollbar-thin"
        onMouseLeave={() => setHoveredIdx(null)}>
        {parts.map((p, i) => {
          if (p.sentIdx === null) return <span key={i}>{p.segment}</span>;
          const sr = sentences[p.sentIdx];
          const hovered = hoveredIdx === p.sentIdx;
          return (
            <span
              key={i}
              onMouseEnter={e => { setHoveredIdx(p.sentIdx!); const r = (e.target as HTMLElement).getBoundingClientRect(); setTooltipPos({ x: r.left, y: r.top }); }}
              style={{
                background: getBg(sr.label, hovered),
                border: getBorder(sr.label),
                borderRadius: "3px",
                padding: sr.label !== "uncertain" ? "1px 2px" : "0",
                cursor: sr.label !== "uncertain" ? "help" : "default",
                transition: "background 0.15s",
                position: "relative",
              }}
            >
              {p.segment}
              {hovered && sr.label !== "uncertain" && sr.signals.length > 0 && (
                <span className="absolute z-50 bottom-full left-0 mb-1.5 bg-slate-900 text-white text-[11px] rounded-lg px-3 py-2 shadow-xl pointer-events-none whitespace-nowrap max-w-[280px]"
                  style={{ minWidth: "180px" }}>
                  <span className="block font-bold mb-1" style={{ color: sr.label === "elevated" ? "#fca5a5" : "#fcd34d" }}>
                    {sr.label === "elevated" ? "Elevated AI Signals" : "Moderate AI Signals"} · {sr.likelihood}%
                  </span>
                  {sr.signals.slice(0, 3).map((sig, si) => (
                    <span key={si} className="block text-slate-300 truncate">· {sig}</span>
                  ))}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Stacked Breakdown Bar ────────────────────────────────────────────────────

function BreakdownBar({ ai, mixed, human, height = 8 }: { ai: number; mixed: number; human: number; height?: number }) {
  return (
    <div className="flex rounded-full overflow-hidden w-full" style={{ height }}>
      {ai    > 0 && <div style={{ width: `${ai}%`,    background: "#ef4444", transition: "width 0.6s ease" }} />}
      {mixed > 0 && <div style={{ width: `${mixed}%`, background: "#f59e0b", transition: "width 0.6s ease" }} />}
      {human > 0 && <div style={{ width: `${human}%`, background: "#22c55e", transition: "width 0.6s ease" }} />}
    </div>
  );
}

// ── Confidence Band (range display) ─────────────────────────────────────────

function ConfidenceBand({ low, high, color }: { low: number; high: number; color: string }) {
  return (
    <div className="relative h-2 bg-slate-100 rounded-full w-full mt-1">
      <div className="absolute h-2 rounded-full opacity-40"
        style={{ left: `${low}%`, width: `${Math.max(4, high - low)}%`, background: color, transition: "all 0.6s" }} />
      <div className="absolute w-2.5 h-2.5 rounded-full border-2 border-white shadow -top-0.5 -translate-x-1/2"
        style={{ left: `${(low + high) / 2}%`, background: color, transition: "left 0.6s" }} />
    </div>
  );
}

// ── Engine Card (new compact production design) ──────────────────────────────

function EngineCard({
  name, badge, badgeBg, result, loading, accentColor, originalText, icon,
}: {
  name: string; badge: string; badgeBg: string;
  result: EngineResult | null; loading: boolean;
  accentColor: string; originalText?: string; icon: string;
}) {
  const [expandedSig, setExpandedSig] = useState<number | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);

  if (loading) return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden animate-pulse">
      <div className="h-1.5 w-full" style={{ background: `${accentColor}33` }} />
      <div className="p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-slate-100" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 bg-slate-100 rounded w-2/3" />
            <div className="h-2.5 bg-slate-100 rounded w-1/2" />
          </div>
        </div>
        <div className="h-16 bg-slate-50 rounded-xl" />
        {[1,2,3].map(i => <div key={i} className="h-8 bg-slate-50 rounded-lg" />)}
      </div>
    </div>
  );

  if (!result) return (
    <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/50 flex items-center justify-center min-h-[220px]">
      <div className="text-center space-y-2 px-6">
        <div className="text-3xl opacity-30">{icon}</div>
        <p className="text-sm text-slate-400 font-medium">{name}</p>
        <p className="text-xs text-slate-300">Run analysis to see results</p>
      </div>
    </div>
  );

  const elevRatio = result.sentences.length > 0
    ? result.sentences.filter(s => s.label === "elevated").length / result.sentences.length : 0;
  const bd = uiDeriveBreakdown(result.internalScore, elevRatio);
  const tier = getTier(bd.ai);

  const strengthColor: Record<string, string> = {
    HIGH: "#dc2626", MEDIUM: "#d97706", LOW: "#16a34a", INCONCLUSIVE: "#94a3b8",
  };
  const sColor = strengthColor[result.evidenceStrength] ?? "#94a3b8";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      {/* Top accent bar */}
      <div className="h-1" style={{ background: accentColor }} />

      {/* Header */}
      <div className="px-5 pt-4 pb-3 flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-black flex-shrink-0"
          style={{ background: accentColor }}>
          {badge}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-slate-800 leading-tight">{name}</p>
          <p className="text-[10px] text-slate-400 mt-0.5">{result.wordCount}w · {result.sentenceCount} sentences</p>
        </div>
        <span className="text-xs font-bold px-2 py-1 rounded-lg" style={{ color: sColor, background: `${sColor}15` }}>
          {result.evidenceStrength}
        </span>
      </div>

      {/* Score block */}
      <div className="mx-4 mb-3 rounded-xl p-3.5 flex items-center gap-4" style={{ background: tier.bg, border: `1px solid ${tier.border}` }}>
        <CircularGauge pct={bd.ai} color={tier.color} size={72} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold mb-0.5" style={{ color: tier.color }}>{tier.label}</p>
          <p className="text-[11px] text-slate-600 leading-snug line-clamp-2">{result.verdictPhrase}</p>
          <div className="mt-2">
            <BreakdownBar ai={bd.ai} mixed={bd.mixed} human={bd.human} height={6} />
            <div className="flex justify-between text-[9px] mt-1 font-semibold">
              <span style={{ color: "#ef4444" }}>AI {bd.ai}%</span>
              <span style={{ color: "#f59e0b" }}>Mix {bd.mixed}%</span>
              <span style={{ color: "#22c55e" }}>Human {bd.human}%</span>
            </div>
          </div>
          <div className="mt-1.5">
            <ConfidenceBand low={result.confidenceLow} high={result.confidenceHigh} color={tier.color} />
            <p className="text-[9px] text-slate-400 mt-0.5">Confidence interval: {result.confidenceLow}–{result.confidenceHigh}%</p>
          </div>
        </div>
      </div>

      {/* Reliability warnings */}
      {result.reliabilityWarnings.length > 0 && (
        <div className="mx-4 mb-3 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 space-y-0.5">
          {result.reliabilityWarnings.slice(0, 2).map((w, i) => (
            <p key={i} className="text-[10px] text-amber-700 leading-snug">⚠ {w}</p>
          ))}
        </div>
      )}

      {/* Signals accordion */}
      <div className="px-4 pb-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Signals</p>
        <div className="space-y-1.5">
          {result.signals.slice(0, 6).map((sig, i) => (
            <div key={i}>
              <button
                onClick={() => setExpandedSig(expandedSig === i ? null : i)}
                className="w-full flex items-center gap-2 text-left group rounded-lg px-2 py-1.5 hover:bg-slate-50 transition-colors"
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sig.pointsToAI ? (sig.wellSupported ? "bg-red-500" : "bg-amber-400") : "bg-emerald-400"}`} />
                <span className="flex-1 text-[11px] text-slate-600 font-medium truncate group-hover:text-slate-900 transition-colors">{sig.name}</span>
                <div className="w-16 h-1.5 bg-slate-100 rounded-full flex-shrink-0 overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${sig.strength}%`, background: sig.pointsToAI ? (sig.strength > 65 ? "#ef4444" : "#f59e0b") : "#22c55e" }} />
                </div>
                <span className="text-[10px] font-bold w-7 text-right flex-shrink-0" style={{ color: sig.pointsToAI ? (sig.strength > 65 ? "#dc2626" : "#d97706") : "#16a34a" }}>
                  {sig.strength}
                </span>
                <svg className={`w-3 h-3 text-slate-300 flex-shrink-0 transition-transform ${expandedSig === i ? "rotate-180" : ""}`} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>
              {expandedSig === i && (
                <div className="mx-2 mb-1.5 bg-slate-50 rounded-lg px-3 py-2.5">
                  <p className="text-[11px] text-slate-600 leading-relaxed">{sig.value}</p>
                </div>
              )}
            </div>
          ))}
          {result.signals.length > 6 && (
            <p className="text-[10px] text-slate-400 text-center py-1">+{result.signals.length - 6} more signals in PDF report</p>
          )}
        </div>
      </div>

      {/* Sentence overlay toggle */}
      {result.sentences.length > 0 && (
        <div className="px-4 pb-4">
          <button
            onClick={() => setShowOverlay(!showOverlay)}
            className="w-full flex items-center justify-center gap-2 text-[11px] font-semibold rounded-xl py-2.5 border transition-all"
            style={showOverlay
              ? { background: accentColor, color: "#fff", borderColor: accentColor }
              : { background: "transparent", color: "#64748b", borderColor: "#e2e8f0" }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {showOverlay ? "Hide" : "View"} Sentence Highlights ({result.sentences.filter(s => s.label !== "uncertain").length} flagged)
          </button>
          {showOverlay && (
            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
              <DocumentOverlay
                text={originalText || result.sentences.map(s => s.text).join(" ")}
                sentences={result.sentences}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── History Panel ─────────────────────────────────────────────────────────────

function HistoryPanel({ history, onSelect, onClear }: {
  history: ScanRecord[];
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  if (history.length === 0) return (
    <div className="text-center py-10 px-6">
      <div className="text-4xl mb-3 opacity-20">🕐</div>
      <p className="text-sm text-slate-400 font-medium">No scans yet</p>
      <p className="text-xs text-slate-300 mt-1">Your last 20 analyses appear here</p>
    </div>
  );
  return (
    <div className="space-y-2 py-3 px-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Recent Scans</p>
        <button onClick={onClear} className="text-[10px] text-slate-400 hover:text-red-500 transition-colors">Clear all</button>
      </div>
      {history.map(rec => {
        const tier = getTier(rec.aiPct);
        return (
          <button key={rec.id} onClick={() => onSelect(rec.id)}
            className="w-full text-left rounded-xl border border-slate-100 bg-slate-50 hover:bg-white hover:border-slate-200 hover:shadow-sm p-3 transition-all">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ color: tier.color, background: tier.bg, border: `1px solid ${tier.border}` }}>
                {tier.label}
              </span>
              <span className="text-[10px] text-slate-400">{new Date(rec.ts).toLocaleDateString()}</span>
            </div>
            <p className="text-[11px] text-slate-700 font-medium line-clamp-1">{rec.snippet}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{rec.wordCount} words · AI {rec.aiPct}%</p>
          </button>
        );
      })}
    </div>
  );
}

// ── Share / Export Utils ──────────────────────────────────────────────────────

function ShareMenu({ perpResult, burstResult, neuralResult, onClose }: {
  perpResult: EngineResult | null;
  burstResult: EngineResult | null;
  neuralResult: EngineResult | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 2000); });
  };

  const getSummaryText = () => {
    if (!perpResult || !burstResult) return "";
    const pBd = uiDeriveBreakdown(perpResult.internalScore);
    const bBd = uiDeriveBreakdown(burstResult.internalScore);
    const nBd = neuralResult ? uiDeriveBreakdown(neuralResult.internalScore) : null;
    const n = nBd ? 3 : 2;
    const avgAI = Math.round((pBd.ai + bBd.ai + (nBd?.ai ?? 0)) / n);
    const tier = getTier(avgAI);
    return `AI Detection Result: ${tier.label} (${avgAI}% AI score)\n` +
      `Engine 1 – Perplexity & Stylometry: ${pBd.ai}% AI (${perpResult.evidenceStrength})\n` +
      `Engine 2 – Burstiness & Cognitive: ${bBd.ai}% AI (${burstResult.evidenceStrength})\n` +
      (nBd ? `Engine 3 – Neural Perplexity: ${nBd.ai}% AI (${neuralResult!.evidenceStrength})\n` : "") +
      `\nGenerated by AI Content Detector`;
  };

  const getJsonExport = () => {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      engines: {
        perplexity_stylometry: perpResult ? { score: perpResult.internalScore, evidenceStrength: perpResult.evidenceStrength, verdict: perpResult.verdictPhrase } : null,
        burstiness_cognitive: burstResult ? { score: burstResult.internalScore, evidenceStrength: burstResult.evidenceStrength, verdict: burstResult.verdictPhrase } : null,
        neural_perplexity: neuralResult ? { score: neuralResult.internalScore, evidenceStrength: neuralResult.evidenceStrength, verdict: neuralResult.verdictPhrase } : null,
      },
    }, null, 2);
  };

  const actions = [
    { key: "summary", label: "Copy Summary", icon: "📋", text: getSummaryText() },
    { key: "json",    label: "Export JSON",  icon: "{ }", text: getJsonExport()  },
  ];

  return (
    <div className="absolute right-0 top-12 z-50 bg-white rounded-2xl border border-slate-200 shadow-xl p-3 w-52" onMouseLeave={onClose}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 px-2 mb-2">Export Results</p>
      {actions.map(a => (
        <button key={a.key} onClick={() => copy(a.text, a.key)}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-slate-50 transition-colors text-left">
          <span className="text-base leading-none">{a.icon}</span>
          <span className="text-sm text-slate-700 font-medium flex-1">{a.label}</span>
          {copied === a.key && <span className="text-[10px] text-emerald-600 font-bold">✓ Copied</span>}
        </button>
      ))}
    </div>
  );
}

// ── Quality Gate Bar ─────────────────────────────────────────────────────────

function QualityGate({ wc }: { wc: number }) {
  const steps = [
    { min: 0,   max: 50,   label: "Too short",      color: "#e2e8f0" },
    { min: 50,  max: 150,  label: "Low confidence", color: "#fca5a5" },
    { min: 150, max: 350,  label: "Fair",           color: "#fcd34d" },
    { min: 350, max: 700,  label: "Good",           color: "#86efac" },
    { min: 700, max: 9999, label: "High confidence",color: "#22c55e" },
  ];
  const current = steps.find(s => wc >= s.min && wc < s.max) ?? steps[steps.length - 1];
  const pct = Math.min(100, (wc / 700) * 100);
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: current.color }} />
      </div>
      <span className="text-[10px] font-semibold flex-shrink-0" style={{ color: current.color === "#e2e8f0" ? "#94a3b8" : current.color }}>
        {wc > 0 ? `${wc}w · ${current.label}` : "Enter text"}
      </span>
    </div>
  );
}

// ── PAGE ──────────────────────────────────────────────────────────────────────

export default function DetectorPage() {
  const [inputMode,      setInputMode]      = useState<"text" | "pdf" | "url">("text");
  const [inputText,      setInputText]      = useState("");
  const [perpResult,     setPerpResult]     = useState<EngineResult | null>(null);
  const [burstResult,    setBurstResult]    = useState<EngineResult | null>(null);
  const [neuralResult,   setNeuralResult]   = useState<EngineResult | null>(null);
  const [rawPerpResult,  setRawPerpResult]  = useState<EngineResult | null>(null);
  const [rawBurstResult, setRawBurstResult] = useState<EngineResult | null>(null);
  const [loadingT,       setLoadingT]       = useState(false);
  const [loadingG,       setLoadingG]       = useState(false);
  const [loadingN,       setLoadingN]       = useState(false);
  const [error,          setError]          = useState("");
  const [generatingPdf,  setGeneratingPdf]  = useState(false);
  const [judgment,       setJudgment]       = useState<"AI-Generated" | "Human-Written" | "Mixed" | "">("");
  const [judgeNotes,     setJudgeNotes]     = useState("");
  const [pdfLoading,     setPdfLoading]     = useState(false);
  const [pdfFileName,    setPdfFileName]    = useState("");
  const [pdfPageCount,   setPdfPageCount]   = useState(0);
  const [dragOver,       setDragOver]       = useState(false);
  const [urlInput,       setUrlInput]       = useState("");
  const [urlLoading,     setUrlLoading]     = useState(false);
  const [history,        setHistory]        = useState<ScanRecord[]>([]);
  const [activeTab,      setActiveTab]      = useState<"analyze" | "history">("analyze");
  const [showShare,      setShowShare]      = useState(false);
  const [showHighlighter,setShowHighlighter]= useState(false);

  const fileInputRef    = useRef<HTMLInputElement>(null);
  const textareaRef     = useRef<HTMLTextAreaElement>(null);
  const engineAContextRef = useRef<{ score: number; topSignals: string[]; evidenceStrength: string } | null>(null);
  const engineBContextRef = useRef<{ score: number; topSignals: string[]; evidenceStrength: string } | null>(null);

  // Load history on mount
  useEffect(() => { setHistory(loadHistory()); }, []);

  // Keyboard shortcut: Ctrl/Cmd+Enter to analyze
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (!loading && inputText.trim().length >= 50) handleAnalyze();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  // Re-apply 3-engine consensus when neural resolves
  useEffect(() => {
    if (!neuralResult || !rawPerpResult || !rawBurstResult) return;
    const [pFinal3, bFinal3] = applyConsensus(rawPerpResult, rawBurstResult, neuralResult);
    setPerpResult(pFinal3);
    setBurstResult(bFinal3);
  }, [neuralResult, rawPerpResult, rawBurstResult]);

  const wc = inputText.trim() ? inputText.trim().split(/\s+/).length : 0;
  const loading = loadingT || loadingG || loadingN;

  // Derived combined score
  const getCombined = () => {
    if (!perpResult || !burstResult) return null;
    const elevRatio = (r: EngineResult) => r.sentences.length > 0
      ? r.sentences.filter(s => s.label === "elevated").length / r.sentences.length : 0;
    const pBd = uiDeriveBreakdown(perpResult.internalScore,  elevRatio(perpResult));
    const bBd = uiDeriveBreakdown(burstResult.internalScore, elevRatio(burstResult));
    const nBd = neuralResult ? uiDeriveBreakdown(neuralResult.internalScore, elevRatio(neuralResult)) : null;
    const n = nBd ? 3 : 2;
    const avgAI    = Math.round((pBd.ai    + bBd.ai    + (nBd?.ai    ?? 0)) / n);
    const avgMixed = Math.round((pBd.mixed + bBd.mixed + (nBd?.mixed  ?? 0)) / n);
    const avgHuman = 100 - avgAI - avgMixed;

    // ── DUAL-ENGINE CONSENSUS GATE (FPR fix) ────────────────────────────────
    // Require both heuristic engines to independently agree on an AI verdict
    // before the combined result can exceed the "Needs Human Review" zone.
    // If only one engine fires AI while the other returns human/low, cap the
    // combined AI% at 49 — routing the case to the review zone rather than
    // auto-labelling it AI-Generated. This directly addresses the 35% FPR.
    const pIsAI = pBd.ai > pBd.human;     // Engine A leans AI
    const bIsAI = bBd.ai > bBd.human;     // Engine B leans AI
    const enginesAgreeAI = pIsAI && bIsAI; // Both must agree for a positive verdict
    let finalAvgAI = avgAI;
    let consensusNote: string | null = null;
    if (avgAI >= 50 && !enginesAgreeAI) {
      // One engine over-fired. Clamp to review zone.
      finalAvgAI = Math.min(avgAI, 49);
      consensusNote = "Engines disagree — result requires human review before any conclusion";
    }

    return { avgAI: finalAvgAI, avgMixed, avgHuman, tier: getTier(finalAvgAI), consensusNote };
  };
  const combined = getCombined();

  // Consensus banner
  const getConsensusBanner = () => {
    if (!perpResult || !burstResult) return null;
    const pHigh = ["HIGH","MEDIUM"].includes(perpResult.evidenceStrength);
    const bHigh = ["HIGH","MEDIUM"].includes(burstResult.evidenceStrength);
    const nHigh = neuralResult && ["HIGH","MEDIUM"].includes(neuralResult.evidenceStrength);
    const pLow  = ["LOW","INCONCLUSIVE"].includes(perpResult.evidenceStrength);
    const bLow  = ["LOW","INCONCLUSIVE"].includes(burstResult.evidenceStrength);
    const nLow  = !neuralResult || ["LOW","INCONCLUSIVE"].includes(neuralResult.evidenceStrength);
    if (pLow && bLow && nLow)    return { text: `All ${neuralResult ? 3 : 2} engines: low AI patterns`,                    color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", icon: "✓" };
    if (pHigh && bHigh && nHigh) return { text: "All 3 engines elevated — dual-consensus confirmed, review carefully",     color: "#dc2626", bg: "#fef2f2", border: "#fecaca", icon: "▲" };
    if (pHigh && bHigh)          return { text: "Both heuristic engines elevated — dual-consensus confirmed",              color: "#ea580c", bg: "#fff7ed", border: "#fed7aa", icon: "▲" };
    // Single-engine firing: this is the primary FPR risk — label it clearly
    if ((pHigh && bLow) || (bHigh && pLow))
                                 return { text: "Only one engine elevated — insufficient for AI verdict, human review required", color: "#b45309", bg: "#fffbeb", border: "#fcd34d", icon: "⚠" };
    return                              { text: "Mixed evidence across engines — treat as inconclusive",                    color: "#d97706", bg: "#fffbeb", border: "#fde68a", icon: "◈" };
  };
  const banner = getConsensusBanner();

  const handleAnalyze = useCallback(() => {
    setError("");
    const trimmed = inputText.trim();
    if (trimmed.length < 50) { setError("Please enter at least 50 characters."); return; }
    if (wc < 20)             { setError("Please enter at least 20 words."); return; }

    // ── SANITISE: strip invisible chars and normalise homoglyphs ──────────────
    // Closes mechanical evasion attacks before any engine sees the text.
    const sanitised = sanitiseInput(trimmed);

    setPerpResult(null); setBurstResult(null); setNeuralResult(null);
    setLoadingT(true);   setLoadingG(true);   setLoadingN(true);

    setTimeout(() => {
      try {
        const CACHE_TTL = 10 * 60 * 1000;
        const now = Date.now();
        if (_analysisCache && _analysisCache.text === sanitised && now - _analysisCache.timestamp < CACHE_TTL) {
          engineAContextRef.current = { score: _analysisCache.perpResult.internalScore, evidenceStrength: _analysisCache.perpResult.evidenceStrength, topSignals: _analysisCache.perpResult.signals.filter(s => s.pointsToAI && s.strength >= 30).sort((a,b) => b.strength - a.strength).slice(0,4).map(s => `${s.name}: ${s.strength}%`) };
          engineBContextRef.current = { score: _analysisCache.burstResult.internalScore, evidenceStrength: _analysisCache.burstResult.evidenceStrength, topSignals: _analysisCache.burstResult.signals.filter(s => s.pointsToAI && s.strength >= 30).sort((a,b) => b.strength - a.strength).slice(0,4).map(s => `${s.name}: ${s.strength}%`) };
          setRawPerpResult(_analysisCache.perpResult); setRawBurstResult(_analysisCache.burstResult);
          setPerpResult(_analysisCache.perpResult);    setBurstResult(_analysisCache.burstResult);
          setLoadingT(false); setLoadingG(false);
          return;
        }
        const p = runPerplexityEngine(sanitised);
        const b = runBurstinessEngine(sanitised);
        let [pFinal, bFinal] = applyConsensus(p, b, null);

        const hasBracket = /\[AI:/i.test(sanitised);
        const bothHigh   = pFinal.evidenceStrength === "HIGH" && bFinal.evidenceStrength === "HIGH";
        if (hasBracket) {
          const upgrade = (r: EngineResult) => ({ ...r, internalScore: Math.max(r.internalScore, 22), evidenceStrength: (["LOW","INCONCLUSIVE"].includes(r.evidenceStrength) ? "MEDIUM" : r.evidenceStrength) as EvidenceStrength, verdictPhrase: "[AI:] insertion detected — explicit hybrid/mixed authorship" });
          pFinal = upgrade(pFinal); bFinal = upgrade(bFinal);
        } else if (!bothHigh && p.sentenceCount >= 4) {
          const { shiftScore } = intraDocumentShift(splitSentences(sanitised));
          if (shiftScore > 35 && (pFinal.internalScore > 12 || bFinal.internalScore > 12)) {
            const upgradeHybrid = (r: EngineResult, ph: string) => ({ ...r, internalScore: Math.max(r.internalScore, 22), evidenceStrength: (["LOW","INCONCLUSIVE"].includes(r.evidenceStrength) ? "MEDIUM" : r.evidenceStrength) as EvidenceStrength, verdictPhrase: r.internalScore < 22 ? ph : r.verdictPhrase });
            pFinal = upgradeHybrid(pFinal, "Hybrid authorship signal — mixed style shift");
            bFinal = upgradeHybrid(bFinal, "Hybrid authorship signal — style variance");
          }
        }

        _analysisCache = { text: sanitised, perpResult: pFinal, burstResult: bFinal, timestamp: Date.now() };
        engineAContextRef.current = { score: pFinal.internalScore, evidenceStrength: pFinal.evidenceStrength, topSignals: pFinal.signals.filter(s => s.pointsToAI && s.strength >= 30).sort((a,b) => b.strength - a.strength).slice(0,4).map(s => `${s.name}: ${s.strength}%`) };
        engineBContextRef.current = { score: bFinal.internalScore, evidenceStrength: bFinal.evidenceStrength, topSignals: bFinal.signals.filter(s => s.pointsToAI && s.strength >= 30).sort((a,b) => b.strength - a.strength).slice(0,4).map(s => `${s.name}: ${s.strength}%`) };
        setRawPerpResult(pFinal); setRawBurstResult(bFinal);
        setPerpResult(pFinal);    setBurstResult(bFinal);

        // Save to history
        const elevRatio = pFinal.sentences.length > 0 ? pFinal.sentences.filter(s => s.label === "elevated").length / pFinal.sentences.length : 0;
        const pBd = uiDeriveBreakdown(pFinal.internalScore, elevRatio);
        const bBd = uiDeriveBreakdown(bFinal.internalScore, elevRatio);
        const avgAI = Math.round((pBd.ai + bBd.ai) / 2);
        const tier  = getTier(avgAI);
        const rec: ScanRecord = {
          id: Date.now().toString(),
          ts: Date.now(),
          snippet: sanitised.slice(0, 80) + (sanitised.length > 80 ? "…" : ""),
          wordCount: wc,
          verdict: tier.label,
          aiPct: avgAI,
          evidenceStrength: pFinal.evidenceStrength,
        };
        const updated = [rec, ...loadHistory()];
        saveHistory(updated);
        setHistory(updated);
      } catch (e) { console.error(e); }
      setLoadingT(false); setLoadingG(false);
    }, 400);

    // ── HYBRID GATE: Engine C strategy ───────────────────────────────────────
    // For CLEAR cases (combined score < 30 or > 70): Engine C runs via Groq
    //   (runNeuralEngine → /api/neural-analyze) — deep LLM analysis.
    // For AMBIGUOUS cases (30–70): ADDITIONALLY call /api/neural (Gemini free
    //   tier) as a fast second-opinion tiebreaker to resolve borderline texts.
    // This preserves Groq quota for deep analysis while using Gemini free quota
    // specifically where it reduces false positives.
    setTimeout(() => {
      // Engine C always runs via Groq for deep analysis
      runNeuralEngine(sanitised, engineAContextRef.current, engineBContextRef.current)
        .then(nResult => setNeuralResult(nResult))
        .catch(e => { console.error(e); setNeuralResult(null); })
        .finally(() => setLoadingN(false));

      // Hybrid gate: also call Gemini for ambiguous zone texts
      const combinedEstimate = _analysisCache
        ? (_analysisCache.perpResult.internalScore + _analysisCache.burstResult.internalScore) / 2
        : 50;
      const isAmbiguous = combinedEstimate >= 30 && combinedEstimate <= 70;

      if (isAmbiguous && typeof window !== "undefined") {
        fetch("/api/neural", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: sanitised,
            engineAScore: engineAContextRef.current?.score ?? null,
            engineBScore: engineBContextRef.current?.score ?? null,
            engineAStrength: engineAContextRef.current?.evidenceStrength ?? null,
            engineBStrength: engineBContextRef.current?.evidenceStrength ?? null,
          }),
        })
          .then(r => r.ok ? r.json() : null)
          .then(hybridData => {
            if (!hybridData || hybridData.error) return;
            // Surface hybrid gate result as a reliability note on the neural result
            // (we don't replace the full neural result — just annotate it)
            setNeuralResult(prev => {
              if (!prev) return prev;
              const hybridNote = `Hybrid gate (Gemini 2.5 Flash): ${hybridData.verdict} — ${hybridData.reasoning} [confidence: ${hybridData.confidence}]`;
              return {
                ...prev,
                reliabilityWarnings: [hybridNote, ...prev.reliabilityWarnings],
              };
            });
          })
          .catch(() => {/* Gemini unavailable — fail silently, Groq result is sufficient */});
      }
    }, 450);
  }, [inputText, wc]);

  const handleClear = () => {
    _analysisCache = null; _sentenceSplitCache = null; _wordTokenCache = null;
    setInputText(""); setPerpResult(null); setBurstResult(null); setNeuralResult(null);
    setRawPerpResult(null); setRawBurstResult(null); setError("");
    setJudgment(""); setJudgeNotes(""); setPdfFileName(""); setPdfPageCount(0); setUrlInput("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handlePdfFile = async (file: File) => {
    if (!file || file.type !== "application/pdf") { setError("Please upload a valid PDF file."); return; }
    if (file.size > 20 * 1024 * 1024) { setError("PDF is too large (max 20 MB)."); return; }
    setError(""); setPdfLoading(true); setPdfFileName(file.name);
    setPerpResult(null); setBurstResult(null); setJudgment(""); setJudgeNotes("");
    try {
      const text = await extractTextFromPDF(file);
      if (!text || text.trim().length < 50) {
        setError("Could not extract text. The PDF may be scanned or image-based.");
        setPdfFileName(""); setPdfPageCount(0);
      } else {
        setInputText(text.trim());
        setPdfPageCount(Math.max(1, Math.round(text.trim().split(/\s+/).length / 250)));
      }
    } catch { setError("Failed to read PDF. Please try a different file."); setPdfFileName(""); setPdfPageCount(0); }
    finally { setPdfLoading(false); }
  };

  const handleDownloadPDF = async () => {
    setGeneratingPdf(true);
    try { await generatePDFReport(inputText, perpResult, burstResult, neuralResult, judgment, judgeNotes); }
    catch { setError("Failed to generate PDF. Please try again."); }
    finally { setGeneratingPdf(false); }
  };

  const hasResults = !!(perpResult || burstResult);

  return (
    <main className="min-h-screen" style={{ background: "#f8fafc", fontFamily: "'Inter var', 'Inter', system-ui, sans-serif" }}>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #1e3a5f 0%, #3b82f6 100%)" }}>
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 001.357 2.059L19.5 14.5M14.25 3.104c.251.023.501.05.75.082M19.5 14.5l-1.5 7m-10 0l-1.5-7" />
              </svg>
            </div>
            <div>
              <span className="text-sm font-extrabold text-slate-900 tracking-tight">DetectAI</span>
              <span className="hidden sm:inline-block text-[9px] ml-1.5 font-bold bg-blue-600 text-white px-1.5 py-0.5 rounded-full uppercase tracking-wide">Pro</span>
            </div>
          </div>

          {/* Nav tabs */}
          <nav className="flex items-center gap-1 bg-slate-100 rounded-xl p-1">
            {(["analyze", "history"] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all ${
                  activeTab === tab ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}>
                {tab === "history" ? `${tab} ${history.length > 0 ? `(${history.length})` : ""}` : tab}
              </button>
            ))}
          </nav>

          {/* Right badges */}
          <div className="hidden md:flex items-center gap-2">
            {(["100+ signals", "3 engines", "GPTZero-aligned"] as const).map(b => (
              <span key={b} className="text-[10px] font-semibold bg-slate-100 text-slate-500 px-2.5 py-1 rounded-full border border-slate-200">{b}</span>
            ))}
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">

        {/* ── History Tab ──────────────────────────────────────────────── */}
        {activeTab === "history" && (
          <div className="max-w-xl mx-auto bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <HistoryPanel history={history} onSelect={() => setActiveTab("analyze")} onClear={() => { saveHistory([]); setHistory([]); }} />
          </div>
        )}

        {/* ── Analyze Tab ───────────────────────────────────────────────── */}
        {activeTab === "analyze" && (
          <div className="space-y-5">

            {/* Input card */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">

              {/* Mode switcher tabs */}
              <div className="flex items-center gap-0 border-b border-slate-100 px-4 pt-3">
                {([
                  { id: "text", label: "✏️  Paste Text" },
                  { id: "pdf",  label: "📄  Upload PDF" },
                  { id: "url",  label: "🔗  Fetch URL"  },
                ] as const).map(m => (
                  <button key={m.id} onClick={() => { setInputMode(m.id); if (m.id !== "pdf") { setPdfFileName(""); setPdfPageCount(0); } }}
                    className={`px-4 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all ${
                      inputMode === m.id
                        ? "border-blue-600 text-blue-700 bg-blue-50/60"
                        : "border-transparent text-slate-500 hover:text-slate-700"
                    }`}>
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="p-5 space-y-4">
                {/* Text mode */}
                {inputMode === "text" && (
                  <div>
                    <textarea
                      ref={textareaRef}
                      value={inputText}
                      onChange={e => setInputText(e.target.value)}
                      rows={8}
                      placeholder="Paste the text you want to analyze here… (minimum 50 characters, 20 words)"
                      aria-label="Text to analyze"
                      className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent leading-relaxed transition font-mono"
                    />
                    <QualityGate wc={wc} />
                  </div>
                )}

                {/* PDF mode */}
                {inputMode === "pdf" && (
                  <div>
                    <div
                      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handlePdfFile(f); }}
                      onClick={() => !pdfLoading && !loading && fileInputRef.current?.click()}
                      role="button" tabIndex={0} aria-label="Upload PDF"
                      onKeyDown={e => e.key === "Enter" && fileInputRef.current?.click()}
                      className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 cursor-pointer transition-all
                        ${dragOver ? "border-blue-400 bg-blue-50" : pdfFileName ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/40"}
                        ${(pdfLoading || loading) ? "opacity-60 cursor-not-allowed pointer-events-none" : ""}`}
                    >
                      <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) handlePdfFile(f); }}
                        disabled={pdfLoading || loading} />
                      {pdfLoading ? (
                        <>
                          <svg className="animate-spin h-7 w-7 text-blue-500" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                          </svg>
                          <p className="text-sm font-medium text-blue-600">Extracting text…</p>
                        </>
                      ) : pdfFileName ? (
                        <div className="flex items-center gap-3 w-full">
                          <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center flex-shrink-0">
                            <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                            </svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-emerald-700 truncate">{pdfFileName}</p>
                            <p className="text-xs text-emerald-600">~{pdfPageCount} page{pdfPageCount !== 1 ? "s" : ""} · {wc} words loaded</p>
                          </div>
                          <button onClick={e => { e.stopPropagation(); handleClear(); }}
                            className="text-xs text-slate-400 hover:text-red-500 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors">✕</button>
                        </div>
                      ) : (
                        <>
                          <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center">
                            <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
                            </svg>
                          </div>
                          <div className="text-center">
                            <p className="text-sm font-semibold text-slate-600">{dragOver ? "Drop PDF here" : "Click to upload or drag & drop"}</p>
                            <p className="text-xs text-slate-400 mt-0.5">PDF only · max 20 MB · text-based PDFs</p>
                          </div>
                        </>
                      )}
                    </div>
                    {pdfFileName && <QualityGate wc={wc} />}
                  </div>
                )}

                {/* URL mode */}
                {inputMode === "url" && (
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <input
                        type="url"
                        value={urlInput}
                        onChange={e => setUrlInput(e.target.value)}
                        placeholder="https://example.com/article"
                        aria-label="URL to fetch"
                        className="flex-1 rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                      />
                      <button
                        onClick={async () => {
                          if (!urlInput.trim()) return;
                          setUrlLoading(true); setError("");
                          try {
                            const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(urlInput.trim())}`);
                            const json = await res.json();
                            const div = document.createElement("div");
                            div.innerHTML = json.contents;
                            const text = Array.from(div.querySelectorAll("p, h1, h2, h3, li"))
                              .map(el => el.textContent?.trim())
                              .filter(Boolean)
                              .join("\n");
                            if (!text || text.length < 50) throw new Error("Not enough text");
                            setInputText(text.slice(0, 15000));
                          } catch { setError("Could not fetch URL. Try pasting the text directly."); }
                          finally { setUrlLoading(false); }
                        }}
                        disabled={urlLoading || !urlInput.trim()}
                        className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-200 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
                      >
                        {urlLoading ? <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : null}
                        Fetch
                      </button>
                    </div>
                    {inputText && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <p className="text-xs text-slate-500 font-medium mb-1">Fetched text preview</p>
                        <p className="text-xs text-slate-700 line-clamp-3">{inputText.slice(0, 250)}…</p>
                        <QualityGate wc={wc} />
                      </div>
                    )}
                  </div>
                )}

                {/* Error */}
                {error && (
                  <div className="flex items-center gap-2.5 rounded-xl bg-red-50 border border-red-200 px-4 py-3" role="alert">
                    <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <p className="text-sm text-red-700 font-medium">{error}</p>
                  </div>
                )}

                {/* Action row */}
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={handleAnalyze}
                    disabled={loading || !inputText.trim() || wc < 20}
                    aria-label="Analyze text (Ctrl+Enter)"
                    className="flex items-center gap-2.5 px-6 py-2.5 rounded-xl font-bold text-sm text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                    style={{ background: loading ? "#93c5fd" : "linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)" }}
                  >
                    {loading ? (
                      <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Analyzing…</>
                    ) : (
                      <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg>Analyze</>
                    )}
                  </button>
                  {(inputText || hasResults) && (
                    <button onClick={handleClear} className="px-4 py-2.5 rounded-xl text-sm font-semibold text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors">
                      Clear
                    </button>
                  )}
                  <span className="text-[10px] text-slate-300 ml-auto hidden sm:block">⌘ Enter to analyze</span>
                </div>
              </div>
            </div>

            {/* ── Combined Score Dashboard ────────────────────────────── */}
            {(loading || combined) && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-6 py-5">
                  {combined ? (
                    <div className="flex flex-col sm:flex-row items-center gap-6">
                      {/* Gauge */}
                      <div className="flex-shrink-0">
                        <CircularGauge pct={combined.avgAI} color={combined.tier.color} size={140} />
                      </div>

                      {/* Main verdict */}
                      <div className="flex-1 min-w-0 text-center sm:text-left">
                        <div className="flex items-center justify-center sm:justify-start gap-2 flex-wrap mb-1">
                          <span className="text-xl font-extrabold" style={{ color: combined.tier.color }}>{combined.tier.label}</span>
                          {loadingN && (
                            <span className="text-[10px] text-blue-500 font-semibold bg-blue-50 border border-blue-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                              <svg className="animate-spin h-2.5 w-2.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                              Neural engine running…
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-500 mb-3">Combined result from {neuralResult ? 3 : 2} detection engines</p>

                        <BreakdownBar ai={combined.avgAI} mixed={combined.avgMixed} human={combined.avgHuman} height={10} />
                        <div className="flex justify-between text-xs font-bold mt-1.5">
                          <span style={{ color: "#ef4444" }}>AI {combined.avgAI}%</span>
                          <span style={{ color: "#f59e0b" }}>Mixed {combined.avgMixed}%</span>
                          <span style={{ color: "#22c55e" }}>Human {combined.avgHuman}%</span>
                        </div>

                        {banner && (
                          <div className="mt-3 inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full border"
                            style={{ color: banner.color, background: banner.bg, borderColor: banner.border }}>
                            <span>{banner.icon}</span>
                            <span>{banner.text}</span>
                          </div>
                        )}

                        {/* FPR FIX: Consensus note — shown when engines disagree */}
                        {combined.consensusNote && (
                          <div className="mt-2 flex items-start gap-2 rounded-xl bg-yellow-50 border border-yellow-300 px-3 py-2.5">
                            <span className="text-yellow-600 text-sm flex-shrink-0">⚠</span>
                            <p className="text-xs font-semibold text-yellow-800 leading-snug">{combined.consensusNote}</p>
                          </div>
                        )}

                        {/* FPR FIX: Review-required banner for Needs Human Review tier */}
                        {combined.tier.needsReview && !combined.consensusNote && (
                          <div className="mt-2 flex items-start gap-2 rounded-xl bg-yellow-50 border border-yellow-300 px-3 py-2.5">
                            <span className="text-yellow-600 text-sm flex-shrink-0">🔍</span>
                            <p className="text-xs font-semibold text-yellow-800 leading-snug">
                              Score falls in the ambiguous zone — formal academic writing, research notes, and ESL prose can score here without being AI-generated. Human review is required before drawing any conclusion.
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col gap-2 flex-shrink-0 relative">
                        <button onClick={handleDownloadPDF} disabled={generatingPdf}
                          className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-700 disabled:bg-slate-200 text-white text-xs font-bold rounded-xl transition-colors">
                          {generatingPdf
                            ? <><svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Generating…</>
                            : <><svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>Download PDF</>}
                        </button>
                        <button onClick={() => setShowShare(!showShare)}
                          className="flex items-center gap-2 px-4 py-2.5 border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-bold rounded-xl transition-colors">
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"/></svg>
                          Export
                        </button>
                        {showShare && (
                          <ShareMenu perpResult={perpResult} burstResult={burstResult} neuralResult={neuralResult} onClose={() => setShowShare(false)} />
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4 py-2">
                      <div className="w-[140px] h-[140px] rounded-full bg-slate-100 animate-pulse flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-6 bg-slate-100 rounded-lg w-1/3 animate-pulse" />
                        <div className="h-4 bg-slate-100 rounded w-1/2 animate-pulse" />
                        <div className="h-2.5 bg-slate-100 rounded-full animate-pulse" />
                      </div>
                    </div>
                  )}
                </div>

                {/* Reviewer judgment strip (only when results ready) */}
                {combined && (
                  <div className="border-t border-slate-100 px-6 py-4 bg-slate-50/50">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-2.5">Reviewer Judgment <span className="normal-case font-normal text-slate-400">(optional — recorded in PDF report)</span></p>
                    <div className="flex flex-col sm:flex-row gap-3">
                      <div className="flex gap-2">
                        {([
                          { val: "AI-Generated"  as const, color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
                          { val: "Mixed"         as const, color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
                          { val: "Human-Written" as const, color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
                        ]).map(({ val, color, bg, border }) => (
                          <button key={val} onClick={() => setJudgment(judgment === val ? "" : val)}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold transition-all"
                            aria-pressed={judgment === val}
                            style={judgment === val
                              ? { background: bg, color, borderColor: border, boxShadow: `0 0 0 2px ${color}40` }
                              : { background: "#fff", color: "#94a3b8", borderColor: "#e2e8f0" }}>
                            {judgment === val && <span>✓</span>}
                            {val}
                          </button>
                        ))}
                      </div>
                      <textarea
                        value={judgeNotes}
                        onChange={e => setJudgeNotes(e.target.value)}
                        placeholder="Add reviewer notes…"
                        rows={1}
                        aria-label="Reviewer notes"
                        className="flex-1 resize-none bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition leading-relaxed"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Live Word Highlighter toggle ──────────────────────── */}
            {inputText.trim().length > 30 && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <button
                  onClick={() => setShowHighlighter(!showHighlighter)}
                  className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition-colors"
                  aria-expanded={showHighlighter}
                >
                  <span className="flex items-center gap-2.5">
                    <span className="w-2 h-2 rounded-full bg-red-400" />
                    <span className="text-sm font-semibold text-slate-700">Live AI Pattern Highlighter</span>
                    <span className="text-[10px] text-slate-400">Flags AI vocabulary as you type</span>
                  </span>
                  <svg className={`w-4 h-4 text-slate-400 transition-transform ${showHighlighter ? "rotate-180" : ""}`} viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd"/>
                  </svg>
                </button>
                {showHighlighter && (
                  <div className="border-t border-slate-100 px-5 pb-4 pt-3">
                    <LiveWordHighlighter text={inputText} />
                  </div>
                )}
              </div>
            )}

            {/* ── 3 Engine Cards ────────────────────────────────────── */}
            <div className="grid gap-5 sm:grid-cols-1 lg:grid-cols-3">
              <EngineCard
                name="Perplexity & Stylometry"
                badge="PS" badgeBg="#1b3a6b"
                icon="📊"
                result={perpResult} loading={loadingT}
                accentColor="#1b3a6b"
                originalText={inputText}
              />
              <EngineCard
                name="Burstiness & Cognitive"
                badge="BC" badgeBg="#16a34a"
                icon="📈"
                result={burstResult} loading={loadingG}
                accentColor="#16a34a"
                originalText={inputText}
              />
              <EngineCard
                name="Neural Perplexity"
                badge="NP" badgeBg="#7c3aed"
                icon="🧠"
                result={neuralResult} loading={loadingN}
                accentColor="#7c3aed"
                originalText={inputText}
              />
            </div>

            {/* ── Radar Chart ───────────────────────────────────────── */}
            {(perpResult || burstResult) && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden p-6">
                <p className="text-sm font-bold text-slate-800 mb-4">Writing Fingerprint</p>
                <RadarChartFingerprint perpResult={perpResult} burstResult={burstResult} />
              </div>
            )}

            {/* ── Methodology & Disclaimer ─────────────────────────── */}
            {(perpResult || burstResult) && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-6 py-5 grid sm:grid-cols-3 gap-5 text-xs leading-relaxed">
                  {[
                    { badge: "PS", bg: "#1b3a6b", label: "Perplexity & Stylometry", text: "24 signals across 5 tiers: lexical vocab density, transitions, bigrams; structural paragraph openers, conclusion clustering; stylistic hedging, clause stacking, passive voice; surface TTR, MTLD, nominalization; semantic self-similarity, tone flatness, vague citations, discourse schema." },
                    { badge: "BC", bg: "#16a34a", label: "Burstiness & Cognitive", text: "8 signals: sentence-length CV (burstiness), short-sentence absence, rhetorical variation, contractions, personal anecdote, numeric specificity. Personal anecdotes and precise numbers reduce AI score (human markers). CV < 0.22 = uniform AI rhythm; CV > 0.42 = natural human variation." },
                    { badge: "NP", bg: "#7c3aed", label: "Neural Perplexity", text: "LLM-based analysis: token predictability, semantic smoothness, structural uniformity, transition density, vocabulary authenticity, human markers, hedging density, named-entity grounding. Receives Engine A/B pre-scores as context to reason about signal disagreements." },
                  ].map(({ badge, bg, label, text }) => (
                    <div key={badge}>
                      <p className="font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
                        <span className="text-white text-[9px] font-black px-1.5 py-0.5 rounded" style={{ background: bg }}>{badge}</span>
                        {label}
                      </p>
                      <p className="text-slate-500">{text}</p>
                    </div>
                  ))}
                </div>
                <div className="mx-6 mb-5 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
                  <p className="text-xs font-semibold text-amber-800 mb-0.5">⚠ Important Disclaimer</p>
                  <p className="text-xs text-amber-700 leading-relaxed">Results are probabilistic pattern analysis only. Formal academic writing, ESL writing, and extensively revised human text may share surface patterns with AI-generated text. The system requires dual-engine agreement before issuing an AI verdict — single-engine results are routed to "Needs Human Review". No automated decision should be based on these results alone. Always apply professional judgment.</p>
                </div>
              </div>
            )}

            {/* How it works — always visible */}
            <HowItWorksSection />
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="mt-12 border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: "linear-gradient(135deg, #1e3a5f 0%, #3b82f6 100%)" }}>
              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 001.357 2.059L19.5 14.5M14.25 3.104c.251.023.501.05.75.082M19.5 14.5l-1.5 7m-10 0l-1.5-7"/>
              </svg>
            </div>
            <span className="text-xs font-bold text-slate-700">DetectAI Pro</span>
          </div>
          <p className="text-[11px] text-slate-400 text-center">
            Results are probabilistic. Dual-engine consensus required. Ambiguous zone flagged for human review.
          </p>
          <p className="text-[11px] text-slate-400">For academic &amp; research use.</p>
        </div>
      </footer>

    </main>
  );
}
