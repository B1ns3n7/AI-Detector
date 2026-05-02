"""
tools/semantic_scholar_tool.py — Semantic Scholar API Tool
Free, no API key required.
API: https://api.semanticscholar.org/graph/v1
"""

import json
import requests
from urllib.parse import quote

BASE = "https://api.semanticscholar.org/graph/v1"
HEADERS = {
    "User-Agent": "ResearchAssistant/1.0 (academic use)",
    "Accept": "application/json"
}

PAPER_FIELDS = "paperId,title,authors,year,abstract,citationCount,referenceCount,influentialCitationCount,isOpenAccess,openAccessPdf,externalIds,journal,publicationTypes,tldr,fieldsOfStudy,publicationDate"
AUTHOR_FIELDS = "authorId,name,paperCount,citationCount,hIndex"


def search_semantic_scholar(query: str, max_results: int = 5, offset: int = 0) -> str:
    """Search Semantic Scholar for papers. Returns titles, abstracts, TLDRs, citation counts."""
    try:
        r = requests.get(
            f"{BASE}/paper/search",
            params={
                "query": query,
                "limit": max_results,
                "offset": offset,
                "fields": PAPER_FIELDS
            },
            headers=HEADERS,
            timeout=15
        )
        if r.status_code == 429:
            return json.dumps({"error": "Semantic Scholar rate limit hit. Please wait a moment and try again."})
        r.raise_for_status()

        data = r.json()
        papers = []
        for item in data.get("data", []):
            papers.append(_format_paper(item))
        return json.dumps(papers, ensure_ascii=False)

    except Exception as e:
        return json.dumps({"error": f"Semantic Scholar search error: {str(e)}"})


def get_semantic_scholar_paper(paper_id: str) -> str:
    """Get full details of a paper by Semantic Scholar ID, DOI, arXiv ID, or PubMed ID.
    Accepts formats: S2 paper ID, DOI:10.xxx, ARXIV:xxxx, PMID:xxxx
    """
    try:
        # Normalize identifier
        pid = paper_id.strip()
        if pid.startswith("10."):
            pid = f"DOI:{pid}"
        elif pid.startswith("arXiv:") or pid.startswith("arxiv:"):
            pid = f"ARXIV:{pid.split(':',1)[1]}"

        r = requests.get(
            f"{BASE}/paper/{pid}",
            params={"fields": PAPER_FIELDS},
            headers=HEADERS,
            timeout=15
        )
        if r.status_code == 404:
            return json.dumps({"error": f"Paper not found: {paper_id}"})
        if r.status_code == 429:
            return json.dumps({"error": "Semantic Scholar rate limit. Please wait."})
        r.raise_for_status()

        return json.dumps(_format_paper(r.json()), ensure_ascii=False)

    except Exception as e:
        return json.dumps({"error": f"Semantic Scholar fetch error: {str(e)}"})


def get_semantic_scholar_citations(paper_id: str, max_results: int = 8) -> str:
    """Get papers that cite a given Semantic Scholar paper."""
    try:
        pid = paper_id.strip()
        if pid.startswith("10."):
            pid = f"DOI:{pid}"

        r = requests.get(
            f"{BASE}/paper/{pid}/citations",
            params={
                "fields": "paperId,title,authors,year,citationCount,abstract",
                "limit": max_results
            },
            headers=HEADERS,
            timeout=15
        )
        if r.status_code == 429:
            return json.dumps({"error": "Semantic Scholar rate limit. Please wait."})
        r.raise_for_status()

        data = r.json()
        citing = []
        for item in data.get("data", []):
            p = item.get("citingPaper", {})
            citing.append({
                "title": p.get("title", "Unknown"),
                "authors": [a.get("name", "") for a in p.get("authors", [])[:3]],
                "year": p.get("year"),
                "citations": p.get("citationCount", 0),
                "paper_id": p.get("paperId", ""),
                "abstract": p.get("abstract", "")[:300]
            })
        return json.dumps({"paper_id": paper_id, "cited_by": citing}, ensure_ascii=False)

    except Exception as e:
        return json.dumps({"error": f"Semantic Scholar citations error: {str(e)}"})


def get_semantic_scholar_recommendations(paper_id: str) -> str:
    """Get recommended papers similar to a given paper."""
    try:
        pid = paper_id.strip()
        r = requests.get(
            f"https://api.semanticscholar.org/recommendations/v1/papers/forpaper/{pid}",
            params={
                "fields": "paperId,title,authors,year,citationCount,abstract,isOpenAccess",
                "limit": 5
            },
            headers=HEADERS,
            timeout=15
        )
        if r.status_code == 429:
            return json.dumps({"error": "Semantic Scholar rate limit. Please wait."})
        r.raise_for_status()

        recs = []
        for item in r.json().get("recommendedPapers", []):
            recs.append({
                "title": item.get("title", "Unknown"),
                "authors": [a.get("name", "") for a in item.get("authors", [])[:3]],
                "year": item.get("year"),
                "citations": item.get("citationCount", 0),
                "open_access": item.get("isOpenAccess", False),
                "abstract": item.get("abstract", "")[:300],
                "paper_id": item.get("paperId", ""),
                "source": "Semantic Scholar"
            })
        return json.dumps({"recommendations": recs}, ensure_ascii=False)

    except Exception as e:
        return json.dumps({"error": f"Semantic Scholar recommendations error: {str(e)}"})


def _format_paper(item: dict) -> dict:
    """Normalize a Semantic Scholar paper object into the app's standard format."""
    authors = [a.get("name", "") for a in item.get("authors", [])[:6]]

    # TLDR is an AI-generated one-sentence summary — very useful
    tldr = ""
    if item.get("tldr"):
        tldr = item["tldr"].get("text", "")

    # Open access PDF
    pdf_url = ""
    if item.get("openAccessPdf"):
        pdf_url = item["openAccessPdf"].get("url", "")

    # External IDs
    ext = item.get("externalIds", {}) or {}
    doi = ext.get("DOI", "")
    pmid = ext.get("PubMed", "")
    arxiv_id = ext.get("ArXiv", "")

    # Journal
    journal = ""
    if item.get("journal"):
        journal = item["journal"].get("name", "")

    # Fields of study
    fields = item.get("fieldsOfStudy") or []

    abstract = item.get("abstract") or ""
    if tldr and not abstract:
        abstract = f"[AI Summary] {tldr}"
    elif tldr:
        abstract = f"{abstract}\n\n[AI Summary] {tldr}"

    return {
        "id": item.get("paperId", ""),
        "paper_id": item.get("paperId", ""),
        "title": item.get("title", "Unknown"),
        "authors": authors,
        "year": item.get("year"),
        "published": str(item.get("year", "")),
        "abstract": abstract,
        "tldr": tldr,
        "citations": item.get("citationCount", 0),
        "influential_citations": item.get("influentialCitationCount", 0),
        "references": item.get("referenceCount", 0),
        "journal": journal,
        "doi": doi,
        "pmid": pmid,
        "arxiv_id": arxiv_id,
        "pdf_url": pdf_url,
        "open_access": item.get("isOpenAccess", False),
        "keywords": fields,
        "pub_types": item.get("publicationTypes") or [],
        "source": "Semantic Scholar",
        "url": f"https://www.semanticscholar.org/paper/{item.get('paperId','')}"
    }
