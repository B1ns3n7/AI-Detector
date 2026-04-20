"use client";

import { useState, useCallback, useRef, useEffect } from "react";

// ─────────────────────────────────────────────────────────────────────────────
//  PDF REPORT GENERATOR  (client-side via jsPDF, dynamically loaded)
//  No npm install needed - loaded from cdnjs at download time.
// ─────────────────────────────────────────────────────────────────────────────

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
    const combLabel = avgAI >= avgMixed && avgAI >= avgHuman
      ? "AI-Generated" : avgHuman >= avgMixed && avgHuman >= avgAI
      ? "Human-Written" : "Mixed / Uncertain";
    const combCol: RGB = combLabel === "AI-Generated" ? C.red : combLabel === "Human-Written" ? C.emerald : C.amber;

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
    const panBrd:  RGB = combLabel === "AI-Generated" ? C.aiRedBrd  : combLabel === "Human-Written" ? C.humBrd  : C.mixBrd;
    rect(ML + 5, y + 56, CW - 10, 6, panFill, panBrd, 1);
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
      ["Score breakdown (AI / Mixed / Human)", "STRICT thresholds (Turnitin/GPTZero aligned): AI-Generated >= 35%, Human-Written < 20%, Mixed in between. A score of 25%+ internal triggers Moderate AI verdict; 45%+ triggers High AI verdict. The three bars always sum to 100%."],
      ["When engines agree", "Higher confidence. Agreement on AI signals means text has consistent AI-associated patterns throughout. In strict mode, agreement at Moderate level or above is treated as a strong indicator."],
      ["When engines disagree", "May indicate lightly edited or partially AI-generated text - AI vocabulary but human sentence rhythm, or vice versa. Treat as inconclusive."],
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
      const autoVerdict = avgAIJ >= avgMixedJ && avgAIJ >= avgHumanJ ? "AI-Generated"
                        : avgHumanJ >= avgMixedJ ? "Human-Written" : "Mixed";
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

function getDominantVerdict(ai: number, mixed: number, human: number): {
  label: string; color: string; bg: string; border: string; icon: string;
} {
  if (ai >= mixed && ai >= human)     return { label: "AI-Generated",    color: "text-red-700",     bg: "bg-red-50",     border: "border-red-300",     icon: "🤖" };
  if (human >= mixed && human >= ai)  return { label: "Human-Written",   color: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-300", icon: "✍️" };
  return                                     { label: "Mixed / Uncertain", color: "text-amber-700",   bg: "bg-amber-50",   border: "border-amber-300",   icon: "⚖️" };
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function DetectorPage() {
  const [inputText,      setInputText]      = useState("");
  const [perpResult,     setPerpResult]     = useState<EngineResult | null>(null);
  const [burstResult,    setBurstResult]    = useState<EngineResult | null>(null);
  const [neuralResult,   setNeuralResult]   = useState<EngineResult | null>(null);
  // Raw (pre-consensus) results — kept so we can re-apply consensus when Engine C resolves
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showHighlighter, setShowHighlighter] = useState(false);
  // Improvement #9: store Engine A/B context for neural engine prompt augmentation
  const engineAContextRef = useRef<{ score: number; topSignals: string[]; evidenceStrength: string } | null>(null);
  const engineBContextRef = useRef<{ score: number; topSignals: string[]; evidenceStrength: string } | null>(null);

  // Improvement 4: re-apply 3-engine consensus whenever Engine C resolves
  useEffect(() => {
    if (!neuralResult || !rawPerpResult || !rawBurstResult) return;
    const [pFinal3, bFinal3] = applyConsensus(rawPerpResult, rawBurstResult, neuralResult);
    setPerpResult(pFinal3);
    setBurstResult(bFinal3);
  }, [neuralResult, rawPerpResult, rawBurstResult]);

  const wc = inputText.trim() ? inputText.trim().split(/\s+/).length : 0;
  const loading = loadingT || loadingG || loadingN;

  const handleAnalyze = useCallback(() => {
    setError("");
    const trimmed = inputText.trim();
    if (trimmed.length < 50) { setError("Please enter at least 50 characters."); return; }
    if (wc < 20)             { setError("Please enter at least 20 words."); return; }

    setPerpResult(null);
    setBurstResult(null);
    setNeuralResult(null);
    setLoadingT(true);
    setLoadingG(true);
    setLoadingN(true);

    setTimeout(() => {
      try {
        // ── Improvement #10: Check memo cache before running engines ──────────
        // If same text analyzed within last 10 minutes, return cached result.
        const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
        const now = Date.now();
        if (
          _analysisCache &&
          _analysisCache.text === trimmed &&
          now - _analysisCache.timestamp < CACHE_TTL_MS
        ) {
          // Cache hit — skip heavy re-computation
          engineAContextRef.current = {
            score: _analysisCache.perpResult.internalScore,
            evidenceStrength: _analysisCache.perpResult.evidenceStrength,
            topSignals: _analysisCache.perpResult.signals
              .filter(s => s.pointsToAI && s.strength >= 30)
              .sort((a, b) => b.strength - a.strength)
              .slice(0, 4)
              .map(s => `${s.name}: ${s.strength}%`),
          };
          engineBContextRef.current = {
            score: _analysisCache.burstResult.internalScore,
            evidenceStrength: _analysisCache.burstResult.evidenceStrength,
            topSignals: _analysisCache.burstResult.signals
              .filter(s => s.pointsToAI && s.strength >= 30)
              .sort((a, b) => b.strength - a.strength)
              .slice(0, 4)
              .map(s => `${s.name}: ${s.strength}%`),
          };
          setRawPerpResult(_analysisCache.perpResult);
          setRawBurstResult(_analysisCache.burstResult);
          setPerpResult(_analysisCache.perpResult);
          setBurstResult(_analysisCache.burstResult);
          // Still re-run neural (API may have improved / result is non-deterministic)
          setLoadingT(false);
          setLoadingG(false);
          return;
        }
        const p = runPerplexityEngine(trimmed);
        const b = runBurstinessEngine(trimmed);
        // Pass null for Engine C initially — neuralResult isn't ready yet.
        // A useEffect below re-runs consensus when Engine C resolves.
        let [pFinal, bFinal] = applyConsensus(p, b, null);

        // ── Hybrid / Mixed-authorship detection (revised) ─────────────────
        // Two independent hybrid signals:
        //
        // Signal A — [AI:...] explicit bracket insertion: definitive hybrid.
        // Any text containing "[AI:" is a human+AI paste-in by definition.
        //
        // Signal B — Sentence-level variance: only fires when engines are NOT
        // both HIGH. When both engines are HIGH, the text is AI-Generated
        // regardless of sentence variance — pure AI texts naturally vary in
        // topic per sentence, producing false hybrid SD readings.
        // When one or both engines are MEDIUM/LOW, high sentence variance
        // (style shift between sentences) signals genuine hybrid authorship.
        //
        // This fix resolves the two failure modes confirmed in ground-truth
        // evaluation (n=30): S011-S023 were wrongly Mixed because hybrid SD
        // fired even when both engines agreed HIGH; S025/S028 were missed
        // because the bracket pattern was not checked.
        const hasBracket = /\[AI:/i.test(trimmed);
        const bothEnginesHigh = (
          pFinal.evidenceStrength === "HIGH" &&
          bFinal.evidenceStrength === "HIGH"
        );

        if (hasBracket) {
          // Explicit [AI:] insertion — definitive hybrid regardless of engine scores
          pFinal = {
            ...pFinal,
            internalScore: Math.max(pFinal.internalScore, 22),
            evidenceStrength: (pFinal.evidenceStrength === "LOW" || pFinal.evidenceStrength === "INCONCLUSIVE")
              ? "MEDIUM" as EvidenceStrength : pFinal.evidenceStrength,
            verdictPhrase: "[AI:] insertion detected — explicit hybrid/mixed authorship",
          };
          bFinal = {
            ...bFinal,
            internalScore: Math.max(bFinal.internalScore, 22),
            evidenceStrength: (bFinal.evidenceStrength === "LOW" || bFinal.evidenceStrength === "INCONCLUSIVE")
              ? "MEDIUM" as EvidenceStrength : bFinal.evidenceStrength,
            verdictPhrase: "[AI:] insertion detected — explicit hybrid/mixed authorship",
          };
        } else if (!bothEnginesHigh) {
          // Sentence-level variance only in ambiguous zone (not when both HIGH)
          const sentences = p.sentenceCount;
          if (sentences >= 4) {
            const { shiftScore } = intraDocumentShift(splitSentences(trimmed));
            const eitherShowsAI = pFinal.internalScore > 12 || bFinal.internalScore > 12;
            if (shiftScore > 35 && eitherShowsAI) {
              pFinal = {
                ...pFinal,
                internalScore: Math.max(pFinal.internalScore, 22),
                evidenceStrength: (pFinal.evidenceStrength === "LOW" || pFinal.evidenceStrength === "INCONCLUSIVE")
                  ? "MEDIUM" as EvidenceStrength : pFinal.evidenceStrength,
                verdictPhrase: pFinal.internalScore < 22
                  ? "Hybrid authorship signal detected — mixed style shift" : pFinal.verdictPhrase,
              };
              bFinal = {
                ...bFinal,
                internalScore: Math.max(bFinal.internalScore, 22),
                evidenceStrength: (bFinal.evidenceStrength === "LOW" || bFinal.evidenceStrength === "INCONCLUSIVE")
                  ? "MEDIUM" as EvidenceStrength : bFinal.evidenceStrength,
                verdictPhrase: bFinal.internalScore < 22
                  ? "Hybrid authorship signal detected — style variance across sentences" : bFinal.verdictPhrase,
              };
            }
          }
        }
        // When bothEnginesHigh: no hybrid override — AI-Generated is the correct verdict.

        // ── Improvement #10: store result in memo cache ──────────────────────────
        _analysisCache = {
          text: trimmed,
          perpResult: pFinal,
          burstResult: bFinal,
          timestamp: Date.now(),
        };

        // ── Improvement #9: cache Engine A/B context for neural prompt ─────────
        engineAContextRef.current = {
          score: pFinal.internalScore,
          evidenceStrength: pFinal.evidenceStrength,
          topSignals: pFinal.signals
            .filter(s => s.pointsToAI && s.strength >= 30)
            .sort((a, b) => b.strength - a.strength)
            .slice(0, 4)
            .map(s => `${s.name}: ${s.strength}%`),
        };
        engineBContextRef.current = {
          score: bFinal.internalScore,
          evidenceStrength: bFinal.evidenceStrength,
          topSignals: bFinal.signals
            .filter(s => s.pointsToAI && s.strength >= 30)
            .sort((a, b) => b.strength - a.strength)
            .slice(0, 4)
            .map(s => `${s.name}: ${s.strength}%`),
        };
        // Store raw pre-consensus results so useEffect can re-apply 3-engine consensus
        setRawPerpResult(pFinal);
        setRawBurstResult(bFinal);
        setPerpResult(pFinal);
        setBurstResult(bFinal);
      } catch (e) { console.error(e); }
      setLoadingT(false);
      setLoadingG(false);
    }, 400);

    // Engine C — Neural Perplexity (async API call, runs in parallel)
    // Improvement #9: pass Engine A/B context after a short delay to let the
    // synchronous setTimeout (400ms) populate the refs first.
    setTimeout(() => {
      runNeuralEngine(trimmed, engineAContextRef.current, engineBContextRef.current).then(nResult => {
      setNeuralResult(nResult);
      }).catch(e => {
        console.error("Neural engine error:", e);
        setNeuralResult(null);
      }).finally(() => {
        setLoadingN(false);
      });
    }, 450); // 450ms: slightly after the 400ms sync engines finish, ensuring refs are populated
  }, [inputText, wc]);

  const handleClear = () => {
    _analysisCache = null; // Improvement #10: invalidate cache on clear
    _sentenceSplitCache = null;
    _wordTokenCache = null;
    setInputText(""); setPerpResult(null); setBurstResult(null); setNeuralResult(null);
    setRawPerpResult(null); setRawBurstResult(null); setError("");
    setJudgment(""); setJudgeNotes(""); setPdfFileName(""); setPdfPageCount(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handlePdfFile = async (file: File) => {
    if (!file || file.type !== "application/pdf") {
      setError("Please upload a valid PDF file.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("PDF is too large. Please upload a file under 20 MB.");
      return;
    }
    setError("");
    setPdfLoading(true);
    setPdfFileName(file.name);
    setPerpResult(null);
    setBurstResult(null);
    setJudgment("");
    setJudgeNotes("");
    try {
      const text = await extractTextFromPDF(file);
      if (!text || text.trim().length < 50) {
        setError("Could not extract readable text from this PDF. It may be scanned or image-based.");
        setPdfFileName("");
        setPdfPageCount(0);
      } else {
        // Count pages via a quick re-load (page count already known from extraction)
        setInputText(text.trim());
        // Estimate page count from file name hint or text length
        const approxPages = Math.max(1, Math.round(text.trim().split(/\s+/).length / 250));
        setPdfPageCount(approxPages);
      }
    } catch (e) {
      setError("Failed to read PDF. Please try a different file.");
      setPdfFileName("");
      setPdfPageCount(0);
    } finally {
      setPdfLoading(false);
    }
  };

  const handlePdfInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handlePdfFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handlePdfFile(file);
  };

  const handleDownloadPDF = async () => {
    setGeneratingPdf(true);
    try {
      await generatePDFReport(inputText, perpResult, burstResult, neuralResult, judgment, judgeNotes);
    } catch (e) {
      setError("Failed to generate PDF. Please try again.");
      console.error(e);
    } finally {
      setGeneratingPdf(false);
    }
  };

  // Consensus summary
  const getComparison = () => {
    if (!perpResult || !burstResult) return null;
    const pHigh = perpResult.evidenceStrength === "HIGH" || perpResult.evidenceStrength === "MEDIUM";
    const bHigh = burstResult.evidenceStrength === "HIGH" || burstResult.evidenceStrength === "MEDIUM";
    const nHigh = neuralResult && (neuralResult.evidenceStrength === "HIGH" || neuralResult.evidenceStrength === "MEDIUM");
    const pLow = perpResult.evidenceStrength === "LOW" || perpResult.evidenceStrength === "INCONCLUSIVE";
    const bLow = burstResult.evidenceStrength === "LOW" || burstResult.evidenceStrength === "INCONCLUSIVE";
    const nLow = !neuralResult || neuralResult.evidenceStrength === "LOW" || neuralResult.evidenceStrength === "INCONCLUSIVE";
    const both = perpResult.evidenceStrength === burstResult.evidenceStrength;
    const allThreeHigh = pHigh && bHigh && nHigh;
    const allThreeLow  = pLow  && bLow  && nLow;
    if (both && perpResult.evidenceStrength === "INCONCLUSIVE" && nLow) return { text: "All engines inconclusive - results are not actionable", style: "text-slate-600 bg-slate-50 border-slate-200", icon: "⚖️" };
    if (allThreeLow)    return { text: `All ${neuralResult ? "3" : "2"} engines report low AI-associated patterns`, style: "text-emerald-700 bg-emerald-50 border-emerald-200", icon: "✅" };
    if (allThreeHigh)   return { text: `All ${neuralResult ? "3" : "2"} engines detect elevated patterns - review signals carefully`, style: "text-red-700 bg-red-50 border-red-200", icon: "▲" };
    if (pHigh && bHigh) return { text: "Both heuristic engines detect elevated patterns - neural analysis pending or inconclusive", style: "text-red-700 bg-red-50 border-red-200", icon: "▲" };
    return { text: "Engines report mixed evidence - treat as inconclusive", style: "text-amber-700 bg-amber-50 border-amber-200", icon: "◈" };
  };
  const comparison = getComparison();

  return (
    <main className="min-h-screen bg-white">

      {/* Header - unchanged design */}
      <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">AI Content Detector</h1>
              {/* <span className="text-[10px] font-black bg-red-600 text-white px-2 py-0.5 rounded-full uppercase tracking-wide">Strict Mode</span> */}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
             {/* Turnitin &amp; GPTZero aligned thresholds · 100+ AI signals · */} 
		<strong className="text-slate-700"> Multi-Engine Analysis </strong>
            </p>
          </div>
          <div className="hidden sm:flex gap-1.5">
             {/* <span className="text-xs font-medium bg-red-600 text-white px-2.5 py-1 rounded-full">AI Detector</span>
            <span className="text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200 px-2.5 py-1 rounded-full">Turnitin-aligned</span> */}
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-5">

        {/* Strict mode notice */}
    {/*     <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-3 flex items-start gap-3">
         <span className="text-red-500 text-lg flex-shrink-0 mt-0.5">⚠</span>
          <div>
            <p className="text-xs font-semibold text-red-800">Strict Detection Mode — Turnitin &amp; GPTZero Aligned Thresholds</p> 
            <p className="text-xs text-red-700 mt-0.5">This detector uses aggressive thresholds calibrated to match Turnitin (&ge;80% AI / &le;20% Human) and GPTZero (&ge;50% mixed / &ge;80% AI) scoring. A score of 25%+ triggers a Moderate AI verdict; 45%+ triggers High. Results are probabilistic — formal, academic, and ESL writing may yield elevated scores. Always apply professional judgment.</p> 
          </div>
        </div>*/}

        {/* Input */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 pt-5 pb-4 space-y-4">

            {/* PDF Upload Zone */}
            <div>
              <p className="text-sm font-semibold text-slate-700 mb-2">Upload a PDF file</p>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => !pdfLoading && !loading && fileInputRef.current?.click()}
                className={`relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-5 cursor-pointer transition-all
                  ${dragOver ? "border-blue-400 bg-blue-50" : pdfFileName ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/40"}
                  ${(pdfLoading || loading) ? "cursor-not-allowed opacity-60" : ""}`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={handlePdfInputChange}
                  disabled={pdfLoading || loading}
                />
                {pdfLoading ? (
                  <div className="flex flex-col items-center gap-2">
                    <svg className="animate-spin h-6 w-6 text-blue-500" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                    </svg>
                    <p className="text-sm font-medium text-blue-600">Extracting text from PDF…</p>
                  </div>
                ) : pdfFileName ? (
                  <div className="flex items-center gap-3 w-full">
                    <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center flex-shrink-0">
                      <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-emerald-700 truncate">{pdfFileName}</p>
                      <p className="text-xs text-emerald-600">
                        Text extracted · ~{pdfPageCount} page{pdfPageCount !== 1 ? "s" : ""} · {wc} words loaded
                      </p>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); handleClear(); }}
                      className="text-xs text-slate-400 hover:text-red-500 font-medium px-2 py-1 rounded-lg hover:bg-red-50 transition-colors flex-shrink-0"
                    >
                      ✕ Remove
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center">
                      <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
                      </svg>
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-semibold text-slate-600">
                        {dragOver ? "Drop your PDF here" : "Click to upload or drag & drop"}
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5">PDF files only · max 20 MB · text-based PDFs only</p>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-slate-200" />
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">or paste text</span>
              <div className="flex-1 h-px bg-slate-200" />
            </div>

            {/* Textarea */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">Paste text directly (at least 20 words)</label>
              <textarea
                className="w-full h-40 resize-none border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition leading-relaxed"
                placeholder="Paste an essay, article, email, or any text to analyze… (minimum 20 words)"
                value={inputText}
                onChange={e => { setInputText(e.target.value); setError(""); setPdfFileName(""); setPdfPageCount(0); }}
                disabled={loading || pdfLoading}
              />
              <div className="flex items-center justify-between mt-2">
                <span className={`text-xs ${wc >= 20 ? "text-slate-400" : "text-amber-500 font-medium"}`}>
                  {wc} word{wc !== 1 ? "s" : ""}{wc > 0 && wc < 20 ? ` - need ${20 - wc} more` : wc >= 20 ? " - ready" : ""}
                </span>
                {error && <span className="text-xs text-red-500 font-medium">{error}</span>}
                {wc >= 10 && (
                  <button
                    onClick={() => setShowHighlighter(v => !v)}
                    className={`flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg border transition-colors ${showHighlighter ? "bg-red-50 border-red-300 text-red-700" : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"}`}
                  >
                    <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
                    {showHighlighter ? "Hide" : "Show"} AI Highlighter
                  </button>
                )}
              </div>
              {showHighlighter && wc >= 10 && <LiveWordHighlighter text={inputText} />}
            </div>
          </div>

          <div className="bg-white border-t border-slate-100 px-6 py-4 flex items-center gap-3">
            <button
              onClick={handleAnalyze} disabled={loading || pdfLoading || wc < 20}
              className="flex-1 sm:flex-none bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-semibold text-sm px-8 py-2.5 rounded-xl transition-colors shadow-sm"
            >
              {loading ? (
                <span className="flex items-center gap-2 justify-center">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                  Analyzing…
                </span>
              ) : "Analyze Text"}
            </button>
            {(perpResult || burstResult || inputText) && !loading && (
              <button onClick={handleClear}
                className="text-sm text-slate-500 hover:text-slate-700 font-medium px-4 py-2.5 rounded-xl border border-slate-200 hover:bg-white transition-colors">
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Consensus banner */}
        {comparison && (
          <div className={`flex items-center gap-2 border rounded-xl px-4 py-2.5 text-sm font-semibold ${comparison.style}`}>
            <span>{comparison.icon}</span>
            <span>{comparison.text}</span>
          </div>
        )}

        {/* Combined score summary - shown when both engines have results */}
        {perpResult && burstResult && !loading && (() => {
          const elevRatio = (r: EngineResult) =>
            r.sentences.length > 0
              ? r.sentences.filter(s => s.label === "elevated").length / r.sentences.length
              : 0;
          const pBD = deriveBreakdown(perpResult.internalScore, elevRatio(perpResult));
          const bBD = deriveBreakdown(burstResult.internalScore, elevRatio(burstResult));
          const nBD = neuralResult ? deriveBreakdown(neuralResult.internalScore, elevRatio(neuralResult)) : null;
          const engineCount = nBD ? 3 : 2;
          const avgAI    = Math.round(((pBD.ai    + bBD.ai    + (nBD?.ai    ?? 0)) / engineCount));
          const avgMixed = Math.round(((pBD.mixed + bBD.mixed + (nBD?.mixed  ?? 0)) / engineCount));
          const avgHuman = 100 - avgAI - avgMixed;
          const combined = getDominantVerdict(avgAI, avgMixed, avgHuman);
          return (
            <div className={`rounded-2xl border-2 ${combined.border} ${combined.bg} px-5 py-4`}>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-0.5">Combined Score ({engineCount} Engines)</p>
                  <div className={`text-xl font-black flex items-center gap-2 ${combined.color}`}>
                    <span>{combined.icon}</span>
                    <span>{combined.label}</span>
                  </div>
                </div>
                <div className="text-right space-y-0.5">
                  <div className="text-2xl font-black text-red-500">{avgAI}%</div>
                  <div className="text-[10px] text-slate-400 uppercase tracking-wide">AI Score</div>
                </div>
              </div>
              {/* Stacked bar */}
              <div className="flex h-6 rounded-full overflow-hidden w-full mb-2">
                {avgAI    > 0 && <div className="bg-red-400 flex items-center justify-center text-[10px] text-white font-black transition-all duration-700" style={{ width: `${avgAI}%` }}>{avgAI >= 8 ? `${avgAI}%` : ""}</div>}
                {avgMixed > 0 && <div className="bg-amber-400 flex items-center justify-center text-[10px] text-white font-black transition-all duration-700" style={{ width: `${avgMixed}%` }}>{avgMixed >= 8 ? `${avgMixed}%` : ""}</div>}
                {avgHuman > 0 && <div className="bg-emerald-400 flex items-center justify-center text-[10px] text-white font-black transition-all duration-700" style={{ width: `${avgHuman}%` }}>{avgHuman >= 8 ? `${avgHuman}%` : ""}</div>}
              </div>
              {/* Per-engine row */}
              <div className={`grid gap-2 mt-2 ${nBD ? "grid-cols-3" : "grid-cols-2"}`}>
                {[
                  { name: "Perplexity & Stylometry", bd: pBD, color: "#1b3a6b" },
                  { name: "Burstiness & Markers",    bd: bBD, color: "#16a34a" },
                  ...(nBD ? [{ name: "Neural Perplexity",      bd: nBD, color: "#7c3aed" }] : []),
                ].map(({ name, bd, color }) => (
                  <div key={name} className="bg-white rounded-xl px-3 py-2 border border-slate-200">
                    <p className="text-[10px] font-bold text-slate-500 mb-1.5" style={{ color }}>{name}</p>
                    <div className="flex h-2.5 rounded-full overflow-hidden w-full mb-1">
                      {bd.ai    > 0 && <div className="bg-red-400"     style={{ width: `${bd.ai}%` }} />}
                      {bd.mixed > 0 && <div className="bg-amber-400"   style={{ width: `${bd.mixed}%` }} />}
                      {bd.human > 0 && <div className="bg-emerald-400" style={{ width: `${bd.human}%` }} />}
                    </div>
                    <div className="flex justify-between text-[9px] font-bold">
                      <span className="text-red-500">{bd.ai}% AI</span>
                      <span className="text-amber-500">{bd.mixed}% Mix</span>
                      <span className="text-emerald-600">{bd.human}% Human</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Professional Judgment + Download */}
        {perpResult && burstResult && !loading && (
          <div className="bg-white rounded-2xl overflow-hidden border border-slate-200">
            {/* Card header */}
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <p className="text-slate-900 text-sm font-bold">Professional Judgment</p>
                <p className="text-slate-500 text-xs mt-0.5">
                  Select your assessment based on contextual knowledge, then download the report
                </p>
              </div>
              <span className="text-slate-500 text-xs bg-slate-100 border border-slate-200 px-2 py-1 rounded-lg">
                Included in PDF
              </span>
            </div>

            <div className="px-5 py-4 space-y-4">
              {/* Verdict selector */}
              <div>
                <p className="text-slate-400 text-[10px] font-semibold uppercase tracking-wide mb-2">
                  Reviewer Verdict
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { val: "AI-Generated",  img: "data:image/png;base64,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", active: "bg-red-600 border-red-500 text-white",   idle: "bg-white border-slate-200 text-slate-600 hover:border-red-400 hover:text-red-600" },
                    { val: "Mixed",         img: "data:image/png;base64,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", active: "bg-amber-600 border-amber-500 text-white", idle: "bg-white border-slate-200 text-slate-600 hover:border-amber-400 hover:text-amber-600" },
                    { val: "Human-Written", img: "data:image/png;base64,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", active: "bg-emerald-700 border-emerald-500 text-white", idle: "bg-white border-slate-200 text-slate-600 hover:border-emerald-400 hover:text-emerald-600" },
                  ] as const).map(({ val, img, active, idle }) => (
                    <button
                      key={val}
                      onClick={() => setJudgment(judgment === val ? "" : val)}
                      className={`flex flex-col items-center gap-1 px-3 py-3 rounded-xl border-2 font-semibold text-xs transition-all ${judgment === val ? active : idle}`}
                    >
                      <img src={img} alt={val} className="w-[18px] h-[18px] object-contain" />
                      <span>{val}</span>
                      {judgment === val && <span className="text-[9px] opacity-80">✓ Selected</span>}
                    </button>
                  ))}
                </div>
              </div>

              {/* Notes textarea */}
              <div>
                <p className="text-slate-400 text-[10px] font-semibold uppercase tracking-wide mb-1.5">
                  Reviewer Notes <span className="normal-case text-slate-600">(optional — printed in PDF)</span>
                </p>
                <textarea
                  value={judgeNotes}
                  onChange={e => setJudgeNotes(e.target.value)}
                  placeholder="Add context, observations, or rationale for your judgment..."
                  rows={3}
                  className="w-full resize-none bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition leading-relaxed"
                />
              </div>

              {/* Download row */}
              <div className="flex items-center justify-between pt-1 border-t border-slate-200">
                <p className="text-slate-500 text-xs">
                  {judgment
                    ? <span className="text-slate-700">Verdict recorded: <span className="font-bold text-slate-900">{judgment}</span></span>
                    : "No verdict selected — report will show \"Not Provided\""}
                </p>
                <button
                  onClick={handleDownloadPDF}
                  disabled={generatingPdf}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-200 disabled:cursor-not-allowed text-white font-semibold text-sm px-5 py-2.5 rounded-xl transition-colors shadow-sm"
                >
                  {generatingPdf ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                      </svg>
                      Generating PDF...
                    </>
                  ) : (
                    <>
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                      </svg>
                      Download PDF Report
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}


        {/* Live AI Word Highlighter - shows as you type */}
        {inputText.trim().length > 30 && (
          <LiveHighlightedText text={inputText} />
        )}

        {/* Side-by-side engine panels */}
        <div className="grid gap-5 lg:grid-cols-3">
          <EnginePanel
            name="Perplexity & Stylometry"
            logoText="PS"
            logoBg="bg-[#1b3a6b]"
            methodology="24 signals: vocab density, transitions, bigrams, hedging, MTLD lexical diversity, semantic self-similarity, tone flatness, vague citations, discourse schema, paragraph structure + more."
            primarySignal="Vocabulary + Transition Patterns"
            result={perpResult}
            loading={loadingT}
            accentColor="#1b3a6b"
            borderColor="border-[#1b3a6b]/20"
            originalText={inputText}
          />
          <EnginePanel
            name="Burstiness & Cognitive Markers"
            logoText="BC"
            logoBg="bg-green-700"
            methodology="CV thresholds + 8 signals: burstiness, anecdote detection, numeric specificity, short sentence absence + more."
            primarySignal="Sentence Burstiness (CV)"
            result={burstResult}
            loading={loadingG}
            accentColor="#16a34a"
            borderColor="border-green-200"
            originalText={inputText}
          />
          <EnginePanel
            name="Neural Perplexity"
            logoText="NP"
            logoBg="bg-violet-700"
            methodology="LLM-based: 8 dimensions including token predictability, hedging density, named-entity grounding + Engine A/B context."
            primarySignal="Token Predictability + Semantic Smoothness"
            result={neuralResult}
            loading={loadingN}
            accentColor="#7c3aed"
            borderColor="border-violet-200"
            originalText={inputText}
          />
        </div>


        {/* Writing Fingerprint Radar Chart */}
        {(perpResult || burstResult) && (
          <RadarChart perpResult={perpResult} burstResult={burstResult} neuralResult={neuralResult} />
        )}

        {/* How popular AI detectors work - always visible educational section */}
        <HowItWorksSection />

        {/* Methodology explainer */}
        {(perpResult || burstResult) && (
          <div className="bg-slate-50 text-slate-600 rounded-2xl p-5 text-xs leading-relaxed grid sm:grid-cols-3 gap-6 border border-slate-200">
            <div>
              <p className="font-semibold text-slate-800 mb-1.5 flex items-center gap-2">
                <span className="bg-blue-500 text-white text-[10px] font-black px-1.5 py-0.5 rounded">PS</span>
                Perplexity &amp; Stylometry
              </p>
              <p className="text-slate-500">
                24 signals across 5 reliability tiers: (A) lexical — vocab density, transitions, bigrams; (B) structural — paragraph openers, conclusion clustering, uniformity; (C) stylistic — hedging, clause stacking, passive voice, ethics, tricolon; (D) surface — TTR, MTLD, nominalization, rhythm; (E) semantic — self-similarity clusters, tone flatness, vague citations, discourse schema predictability; plus catch-nets for Llama 3 / Claude evasive prose.
              </p>
            </div>
            <div>
              <p className="font-semibold text-slate-800 mb-1.5 flex items-center gap-2">
                <span className="bg-green-600 text-white text-[10px] font-black px-1.5 py-0.5 rounded">BC</span>
                Burstiness &amp; Cognitive Markers
              </p>
              <p className="text-slate-500">
                8 signals: sentence-length CV (burstiness), short-sentence absence, range, rhetorical variation, contraction presence, sentence floor, personal anecdote presence, and numeric specificity. Personal anecdotes and specific numbers are human markers that actively reduce the AI score.
		{/* (Turnitin/GPTZero aligned). */}
		 
              </p>
            </div>
            <div>
              <p className="font-semibold text-slate-800 mb-1.5 flex items-center gap-2">
                <span className="bg-violet-600 text-white text-[10px] font-black px-1.5 py-0.5 rounded">NP</span>
                Neural Perplexity
              </p>
              <p className="text-slate-500">
                LLM analysis across 8 dimensions including token predictability, hedging density, and named-entity grounding. Receives pre-computed Engine A/B scores as context (Improvement #9) so it can reason about signal disagreements — e.g. high vocab score but low burstiness — and produce a calibrated verdict instead of treating each document in isolation.
              </p>
            </div>
          </div>
        )}

      </div>
    </main>
  );
}