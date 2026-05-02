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

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"


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
                    scopus_ok: bool, springer_ok: bool) -> list:
    """
    Call every available search tool directly in Python.
    Returns deduplicated paper list sorted by citations descending.
    This NEVER relies on Groq to issue tool calls.
    """
    raw_results = []

    # Always-on free sources
    search_fns = [
        ("arXiv",            lambda q: search_arxiv(q)),
        ("Semantic Scholar", lambda q: search_semantic_scholar(q)),
        ("OpenAlex",         lambda q: search_openalex(q)),
        ("CORE",             lambda q: search_core(q)),
        ("PubMed",           lambda q: search_pubmed(q)),
        ("CrossRef",         lambda q: search_crossref(q)),
    ]
    if scopus_ok:
        search_fns.append(("Scopus", lambda q: search_scopus(q)))
    if springer_ok:
        search_fns.append(("Springer Nature", lambda q: search_springer(q)))

    for source_name, fn in search_fns:
        try:
            print(f"  Searching {source_name}...")
            result = fn(query)
            papers = _papers_from_result(result)
            print(f"    -> {len(papers)} papers from {source_name}")
            raw_results.extend(papers)
        except Exception as e:
            print(f"    -> {source_name} error: {e}")

    # Deduplicate by normalised title
    seen = set()
    unique = []
    for p in raw_results:
        key = (p.get("title") or "").strip().lower()[:80]
        if key and key not in seen:
            seen.add(key)
            unique.append(p)

    # Sort: papers with citations first (highest first), then uncited
    cited     = sorted([p for p in unique if p.get("citations")],
                       key=lambda p: p["citations"], reverse=True)
    uncited   = [p for p in unique if not p.get("citations")]
    merged    = cited + uncited

    return merged[:max_papers]


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

    def check_scopus_connection(self) -> bool:
        key = os.getenv("SCOPUS_API_KEY", "")
        return bool(key and key not in ("your_scopus_api_key_here", ""))

    def check_springer_connection(self) -> bool:
        key = os.getenv("SPRINGER_API_KEY", "")
        return bool(key and key not in ("your_springer_api_key_here", ""))

    def check_core_connection(self) -> bool:
        return True

    def _call_groq(self, messages: list, max_tokens: int = 1200) -> str:
        if not GROQ_API_KEY or GROQ_API_KEY == "your_groq_api_key_here":
            return "Groq API key not set. Add GROQ_API_KEY to .env — get a free key at https://console.groq.com"
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
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"].strip()
        except requests.exceptions.HTTPError:
            code = r.status_code
            if code == 401:
                return "Invalid Groq API key. Check GROQ_API_KEY in .env"
            if code == 429:
                return "Groq rate limit hit. Please wait a moment and try again."
            return f"Groq HTTP error {code}."
        except Exception as e:
            return f"Error calling Groq: {str(e)}"

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
        return self._call_groq(messages, max_tokens=1500)

    def _run_research(self, query: str, max_papers: int, mode: str) -> tuple:
        scopus_ok  = self.check_scopus_connection()
        springer_ok = self.check_springer_connection()

        print(f"\n[Research] query='{query}' max={max_papers} mode={mode}")

        # Step 1: Collect papers directly (no Groq involvement)
        papers = _collect_papers(query, max_papers, scopus_ok, springer_ok)
        print(f"[Research] Collected {len(papers)} unique papers")

        # Step 2: Groq writes summary from the real papers
        summary = self._generate_summary(query, papers, mode)

        return summary, papers, len(papers)

    async def run_research(self, query: str, max_papers: int = 5, mode: str = "full") -> dict:
        session_id = str(uuid.uuid4())
        start_time = datetime.now()
        try:
            summary, papers, steps = await asyncio.get_event_loop().run_in_executor(
                None, lambda: self._run_research(query, max_papers, mode)
            )
            for paper in papers:
                self.vector_store.add_paper(paper, session_id)

            session_data = {
                "session_id": session_id,
                "query": query,
                "timestamp": start_time.isoformat(),
                "duration_seconds": (datetime.now() - start_time).total_seconds(),
                "papers": papers,
                "summary": summary,
                "mode": mode,
                "steps_taken": steps,
                "scopus_enabled": self.check_scopus_connection(),
                "springer_enabled": self.check_springer_connection(),
            }
            self.sessions[session_id] = session_data
            return session_data
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
                None, lambda: self._call_groq(messages, max_tokens=1200)
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
