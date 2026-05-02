"""
agent.py — Multi-Source Research Agent
Architecture: Direct tool calls in Python (guaranteed results) + Groq for summarization only.

ROOT CAUSE OF PREVIOUS BUG:
  Groq 8b-instant hallucinates tool usage — writes "ArXiv: 20 results found" as fiction
  instead of actually emitting TOOL:/INPUT: format. So papers_found was always empty.

FIX: Call all search tools directly in Python. Groq only writes the summary.
"""

import asyncio
import uuid
import json
import requests
from typing import Optional
from datetime import datetime
import os
from dotenv import load_dotenv

load_dotenv()

from tools.arxiv_tool import search_arxiv, fetch_arxiv_paper
from tools.openalex_tool import search_openalex, get_citations, get_paper_metadata
from tools.crossref_tool import resolve_doi, search_crossref
from tools.unpaywall_tool import get_fulltext_url
from tools.summarizer import summarize_paper
from tools.scopus_tool import search_scopus, get_scopus_abstract, get_scopus_citations
from tools.pubmed_tool import search_pubmed, get_pubmed_abstract, search_pubmed_clinical
from tools.semantic_scholar_tool import (
    search_semantic_scholar,
    get_semantic_scholar_paper,
    get_semantic_scholar_citations,
    get_semantic_scholar_recommendations,
)
from tools.core_tool import search_core, get_core_paper
from tools.springer_tool import search_springer, get_springer_paper, search_springer_open_access
from tools.herdin_tool import search_herdin
from tools.pej_tool import search_pej, get_pej_article

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-2.0-flash"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"


def _papers_from_result(raw: str) -> list:
    """Safely extract papers list from a tool result JSON string."""
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return [d for d in data if isinstance(d, dict) and d.get("title")]
        if isinstance(data, dict):
            if data.get("title"):
                return [data]
            if isinstance(data.get("results"), list):
                return [d for d in data["results"] if isinstance(d, dict) and d.get("title")]
    except (json.JSONDecodeError, TypeError):
        pass
    return []


def _collect_papers(query: str, max_papers: int,
                    scopus_ok: bool, springer_ok: bool,
                    selected_sources: list = None,
                    page: int = 0,
                    seen_titles: set = None) -> list:
    """
    Call every available search tool directly in Python.
    Returns deduplicated paper list sorted by citations descending.
    This NEVER relies on Groq to issue tool calls.

    KEY DESIGN: ALL sources are always in the pool.
    Key-required sources (Scopus, Springer) are included if:
      a) their API key is configured, OR
      b) the user explicitly selected them (let the tool return its own error)
    This prevents the case where check_*_connection() returns False due to
    a .env loading issue, causing selected sources to silently do nothing.
    """
    raw_results = []
    sel_lower = {s.lower().strip() for s in (selected_sources or [])}
    user_wants_scopus   = "scopus" in sel_lower
    user_wants_springer = "springer nature" in sel_lower

    # Offset = page * max_papers so each "Search More" fetches the next batch
    offset = page * max_papers

    # Always include all free sources in pool
    all_search_fns = [
        ("arXiv",                  lambda q, o=offset: search_arxiv(q, offset=o)),
        ("Semantic Scholar",       lambda q, o=offset: search_semantic_scholar(q, offset=o)),
        ("OpenAlex",               lambda q, o=offset: search_openalex(q, offset=o)),
        ("CORE",                   lambda q, o=offset: search_core(q, offset=o)),
        ("PubMed",                 lambda q, o=offset: search_pubmed(q, offset=o)),
        ("CrossRef",               lambda q, o=offset: search_crossref(q, offset=o)),
        ("HERDIN Plus",            lambda q: search_herdin(q)),
        ("Philippine E-Journals",  lambda q: search_pej(q)),
    ]
    # Include key-required sources if key is configured OR user explicitly selected them
    if scopus_ok or user_wants_scopus:
        all_search_fns.append(("Scopus", lambda q, o=offset: search_scopus(q, offset=o)))
    if springer_ok or user_wants_springer:
        all_search_fns.append(("Springer Nature", lambda q, o=offset: search_springer(q, offset=o)))

    # Filter to user-selected sources (if provided and non-empty)
    if selected_sources and len(selected_sources) > 0:
        search_fns = [(name, fn) for name, fn in all_search_fns
                      if name.lower() in sel_lower]
        if not search_fns:
            # Fallback: use all if selection matches nothing
            search_fns = all_search_fns
    else:
        search_fns = all_search_fns

    # Collect all papers across sources
    for source_name, fn in search_fns:
        try:
            print(f"  Searching {source_name}...")
            result = fn(query)
            papers = _papers_from_result(result)
            print(f"    -> {len(papers)} papers from {source_name}")
            raw_results.extend(papers)
        except Exception as e:
            print(f"    -> {source_name} error: {e}")

    # Deduplicate by normalised title + exclude already-seen titles from previous pages
    prev_seen = {t.strip().lower()[:80] for t in (seen_titles or [])}
    seen = set()
    unique = []
    for p in raw_results:
        key = (p.get("title") or "").strip().lower()[:80]
        if key and key not in seen and key not in prev_seen:
            seen.add(key)
            unique.append(p)

    # Sort by citations descending (primary ranking)
    # Papers with no citation data sort after cited papers
    def _cit(p):
        c = p.get("citations")
        return c if c is not None else -1

    unique.sort(key=_cit, reverse=True)

    # ── DIVERSITY PASS ───────────────────────────────────────────────────────
    # After citation sort, check if top results are all from one source.
    # If so, inject 1 paper from each missing source into the final list
    # while keeping the citation-ranked papers as the majority.
    top = unique[:max_papers]
    sources_in_top = {p.get("source") for p in top}
    all_sources_with_results = {p.get("source") for p in unique}
    missing_sources = all_sources_with_results - sources_in_top

    if missing_sources:
        # Find best paper from each missing source (first occurrence = highest cited)
        injected = []
        already_injected = set()
        for p in unique:
            src = p.get("source")
            if src in missing_sources and src not in already_injected:
                injected.append(p)
                already_injected.add(src)

        # Replace the lowest-ranked papers in top with injected ones
        # so citation-ranked papers still dominate
        slots_to_replace = min(len(injected), max(1, max_papers // len(all_sources_with_results)))
        final = top[:max_papers - slots_to_replace] + injected[:slots_to_replace]
    else:
        final = top

    print(f"  Unique papers: {len(unique)}, sources in output: {len({p.get('source') for p in final})}")
    return final[:max_papers]


def _format_papers_for_summary(papers: list) -> str:
    """Format papers into readable text for Groq summary prompt."""
    if not papers:
        return "No papers found."
    lines = []
    for i, p in enumerate(papers, 1):
        lines.append(f"[{i}] {p.get('title', 'Unknown')}")
        authors = (p.get("authors") or [])[:3]
        if authors:
            lines.append(f"    Authors: {', '.join(authors)}")
        year = p.get("year") or p.get("published", "")
        if year:
            lines.append(f"    Year: {year}")
        if p.get("journal"):
            lines.append(f"    Journal: {p['journal']}")
        if p.get("citations") is not None:
            lines.append(f"    Citations: {p['citations']}")
        if p.get("source"):
            lines.append(f"    Source: {p['source']}")
        abstract = (p.get("abstract") or "")[:300]
        if abstract:
            lines.append(f"    Abstract: {abstract}...")
        lines.append("")
    return "\n".join(lines)


def _format_papers_as_context(papers: list) -> str:
    """Full paper context for follow-up Q&A."""
    if not papers:
        return "No papers available."
    lines = []
    for i, p in enumerate(papers):
        lines.append(f"--- Paper {i+1} ---")
        lines.append(f"Title: {p.get('title', 'Unknown')}")
        authors = p.get("authors", [])
        if authors:
            lines.append(f"Authors: {', '.join(authors[:5])}")
        year = p.get("year") or p.get("published", "")
        if year:
            lines.append(f"Year: {year}")
        if p.get("journal"):
            lines.append(f"Journal: {p['journal']}")
        if p.get("citations") is not None:
            lines.append(f"Citations: {p['citations']}")
        if p.get("source"):
            lines.append(f"Source: {p['source']}")
        if p.get("doi"):
            lines.append(f"DOI: {p['doi']}")
        abstract = p.get("abstract", "")
        if abstract:
            lines.append(f"Abstract: {abstract[:600]}")
        lines.append("")
    return "\n".join(lines)


class ResearchAgent:
    def __init__(self):
        from vector_store import VectorStore
        self.vector_store = VectorStore()
        self.sessions = {}

    def check_ollama_connection(self) -> bool:
        """Returns True if Groq OR Gemini is available."""
        return self.check_groq_connection() or self.check_gemini_connection()

    def check_groq_connection(self) -> bool:
        try:
            if not GROQ_API_KEY or GROQ_API_KEY == "your_groq_api_key_here":
                return False
            r = requests.get(
                "https://api.groq.com/openai/v1/models",
                headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                timeout=5,
            )
            return r.status_code == 200
        except Exception:
            return False

    def check_gemini_connection(self) -> bool:
        return bool(GEMINI_API_KEY and GEMINI_API_KEY not in ("your_gemini_api_key_here", ""))

    def check_scopus_connection(self) -> bool:
        key = os.getenv("SCOPUS_API_KEY", "")
        return bool(key and key not in ("your_scopus_api_key_here", ""))

    def check_springer_connection(self) -> bool:
        key = os.getenv("SPRINGER_API_KEY", "")
        return bool(key and key not in ("your_springer_api_key_here", ""))

    def check_core_connection(self) -> bool:
        return True

    def _call_groq(self, messages: list, max_tokens: int = 1200) -> str:
        """Call Groq. Returns None on 429 so caller can fallback."""
        if not GROQ_API_KEY or GROQ_API_KEY == "your_groq_api_key_here":
            return None
        try:
            r = requests.post(
                GROQ_URL,
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": GROQ_MODEL,
                    "messages": messages,
                    "temperature": 0.2,
                    "max_tokens": max_tokens,
                },
                timeout=60,
            )
            if r.status_code == 429:
                print("  [LLM] Groq rate limit hit — falling back to Gemini")
                return None  # signal fallback
            if r.status_code == 401:
                print("  [LLM] Groq invalid key — falling back to Gemini")
                return None
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"].strip()
        except Exception as e:
            print(f"  [LLM] Groq error: {e} — falling back to Gemini")
            return None

    def _call_gemini(self, messages: list, max_tokens: int = 1200) -> str:
        """Call Gemini Flash as fallback. Free: 1,500 req/day."""
        if not GEMINI_API_KEY or GEMINI_API_KEY == "your_gemini_api_key_here":
            return "Both Groq and Gemini are unavailable. Add GEMINI_API_KEY to .env as backup — free key at https://aistudio.google.com"
        try:
            # Convert OpenAI-style messages to Gemini format
            contents = []
            system_text = ""
            for m in messages:
                if m["role"] == "system":
                    system_text = m["content"]
                elif m["role"] == "user":
                    contents.append({"role": "user", "parts": [{"text": m["content"]}]})
                elif m["role"] == "assistant":
                    contents.append({"role": "model", "parts": [{"text": m["content"]}]})

            body = {
                "contents": contents,
                "generationConfig": {
                    "temperature": 0.2,
                    "maxOutputTokens": max_tokens,
                },
            }
            if system_text:
                body["systemInstruction"] = {"parts": [{"text": system_text}]}

            r = requests.post(
                f"{GEMINI_URL}/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}",
                headers={"Content-Type": "application/json"},
                json=body,
                timeout=60,
            )
            if r.status_code == 429:
                return "Both Groq and Gemini rate limits reached. Please try again in a few minutes."
            if r.status_code == 400:
                return "Gemini request error. Please try a different query."
            r.raise_for_status()
            candidates = r.json().get("candidates", [])
            if candidates:
                return candidates[0]["content"]["parts"][0]["text"].strip()
            return "No response from Gemini."
        except Exception as e:
            return f"Both LLM providers failed: {str(e)}"

    def _call_llm(self, messages: list, max_tokens: int = 1200) -> str:
        """
        Primary entry point for all LLM calls.
        Tries Groq first (fastest, 14,400/day free).
        Falls back to Gemini Flash on rate limit (1,500/day free).
        Combined capacity handles ~2,650 students/day for free.
        """
        result = self._call_groq(messages, max_tokens)
        if result is not None:
            return result
        # Groq unavailable or rate limited — use Gemini
        print("  [LLM] Using Gemini Flash")
        return self._call_gemini(messages, max_tokens)

    def _generate_summary(self, query: str, papers: list, mode: str) -> str:
        """Ask Groq to summarise the retrieved papers. Groq never calls tools here."""
        if not papers:
            return "No papers were found for this query. Try a different search term."

        papers_text = _format_papers_for_summary(papers)

        if mode == "compare":
            instruction = (
                "Compare these papers: methodology, findings, publication recency, "
                "citation impact. Highlight agreements and contradictions."
            )
        elif mode == "summary":
            instruction = "Write a concise abstract-style summary of the key findings."
        else:
            instruction = (
                "Write a comprehensive research overview covering: "
                "main themes, key papers and their contributions, "
                "methodological approaches, major findings, and research gaps."
            )

        messages = [
            {
                "role": "system",
                "content": (
                    "You are an academic research assistant. You have been given a list of "
                    "real papers retrieved from academic databases. Write a clear, accurate "
                    "summary based ONLY on the papers provided. Cite paper numbers like [1], [2]. "
                    "Do not make up papers or results not listed below."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Research query: {query}\n\n"
                    f"Retrieved papers:\n{papers_text}\n\n"
                    f"Task: {instruction}"
                ),
            },
        ]
        return self._call_llm(messages, max_tokens=1500)

    def _run_research(self, query: str, max_papers: int, mode: str,
                      selected_sources: list = None,
                      page: int = 0,
                      seen_titles: list = None) -> tuple:
        scopus_ok  = self.check_scopus_connection()
        springer_ok = self.check_springer_connection()

        print(f"\n[Research] query='{query}' max={max_papers} mode={mode}")

        # Step 1: Collect papers directly (no Groq involvement)
        papers = _collect_papers(query, max_papers, scopus_ok, springer_ok,
                               selected_sources, page=page,
                               seen_titles=set(seen_titles or []))
        print(f"[Research] Collected {len(papers)} unique papers")

        # Step 2: Groq writes summary from the real papers
        summary = self._generate_summary(query, papers, mode)

        return summary, papers, len(papers)

    async def run_research(self, query: str, max_papers: int = 5, mode: str = "full",
                           selected_sources: list = None,
                           page: int = 0,
                           seen_titles: list = None,
                           existing_session_id: str = None) -> dict:
        start_time = datetime.now()

        # For page > 0, reuse the existing session so follow-up Q&A
        # always has access to ALL papers collected across all pages.
        if page > 0 and existing_session_id and existing_session_id in self.sessions:
            session_id = existing_session_id
        else:
            session_id = str(uuid.uuid4())

        try:
            summary, papers, steps = await asyncio.get_event_loop().run_in_executor(
                None, lambda: self._run_research(query, max_papers, mode,
                                                  selected_sources, page, seen_titles)
            )
            for paper in papers:
                self.vector_store.add_paper(paper, session_id)

            if page > 0 and session_id in self.sessions:
                # APPEND new papers to the existing session
                existing = self.sessions[session_id]
                existing["papers"] = existing["papers"] + papers
                existing["steps_taken"] = existing.get("steps_taken", 0) + steps
                existing["page"] = page
                existing["duration_seconds"] = (datetime.now() - start_time).total_seconds()
                session_data = existing
            else:
                session_data = {
                    "session_id": session_id,
                    "query": query,
                    "timestamp": start_time.isoformat(),
                    "duration_seconds": (datetime.now() - start_time).total_seconds(),
                    "papers": papers,
                    "summary": summary,
                    "mode": mode,
                    "steps_taken": steps,
                    "page": page,
                    "scopus_enabled": self.check_scopus_connection(),
                    "springer_enabled": self.check_springer_connection(),
                }
                self.sessions[session_id] = session_data

            # Return only the new papers to the frontend (for appending),
            # but session stores the full cumulative list for follow-up Q&A.
            response = dict(session_data)
            response["papers"] = papers          # only NEW papers for this page
            response["total_papers"] = len(self.sessions[session_id]["papers"])
            return response
        except Exception as e:
            import traceback; traceback.print_exc()
            return {
                "session_id": session_id,
                "query": query,
                "error": str(e),
                "papers": [],
                "summary": f"Error: {str(e)}",
                "duration_seconds": 0,
                "steps_taken": 0,
                "scopus_enabled": False,
                "springer_enabled": False,
            }

    async def followup(self, query: str, session_id: str) -> dict:
        session = self.sessions.get(session_id)
        if not session:
            return {"error": "Session not found. Please run a search first."}

        papers = session.get("papers", [])
        summary = session.get("summary", "")
        original_query = session.get("query", "")
        papers_context = _format_papers_as_context(papers)

        messages = [
            {
                "role": "system",
                "content": (
                    "You are an academic research assistant. Answer questions about "
                    "the specific papers provided. Be precise, cite paper titles, "
                    "and only use information from the papers listed."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Original research topic: {original_query}\n\n"
                    f"=== PAPERS ===\n{papers_context}\n\n"
                    f"=== PRIOR SUMMARY ===\n{summary[:600]}\n\n"
                    f"=== FOLLOW-UP QUESTION ===\n{query}\n\n"
                    "Answer using only the papers above. Cite paper titles."
                ),
            },
        ]
        try:
            answer = await asyncio.get_event_loop().run_in_executor(
                None, lambda: self._call_llm(messages, max_tokens=1200)
            )
            return {
                "session_id": session_id,
                "query": query,
                "answer": answer,
                "papers_used": len(papers),
                "sources": [p.get("title", "Unknown") for p in papers[:5]],
            }
        except Exception as e:
            return {"error": str(e)}

    def get_session(self, session_id: str) -> Optional[dict]:
        return self.sessions.get(session_id)

    def clear_session(self, session_id: str):
        if session_id in self.sessions:
            del self.sessions[session_id]
        self.vector_store.clear_session(session_id)
