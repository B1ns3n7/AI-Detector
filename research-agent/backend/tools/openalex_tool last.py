"""
tools/openalex_tool.py — OpenAlex API Tool (FREE replacement for Semantic Scholar)
No API key required. 100,000 calls/day free.
https://openalex.org/
"""

import json
import requests

BASE_URL = "https://api.openalex.org"
HEADERS = {"User-Agent": "ResearchAssistant/1.0 (research-tool; mailto:your@email.com)"}


def search_openalex(query: str, max_results: int = 5) -> str:
    """Search OpenAlex for academic papers."""
    try:
        params = {
            "search": query,
            "per-page": max_results,
            "select": "id,title,authorships,abstract_inverted_index,publication_year,cited_by_count,doi,concepts,open_access",
            "sort": "cited_by_count:desc"
        }
        r = requests.get(f"{BASE_URL}/works", params=params, headers=HEADERS, timeout=15)
        r.raise_for_status()
        data = r.json()

        papers = []
        for work in data.get("results", []):
            abstract = _decode_abstract(work.get("abstract_inverted_index"))
            papers.append({
                "id": work.get("id", ""),
                "title": work.get("title", "Unknown"),
                "authors": [
                    a["author"]["display_name"]
                    for a in work.get("authorships", [])[:5]
                    if a.get("author")
                ],
                "abstract": abstract[:600] if abstract else "No abstract available",
                "year": work.get("publication_year"),
                "citations": work.get("cited_by_count", 0),
                "doi": work.get("doi", ""),
                "open_access": work.get("open_access", {}).get("is_oa", False),
                "concepts": [c["display_name"] for c in work.get("concepts", [])[:5]],
                "source": "OpenAlex"
            })
        return json.dumps(papers, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})


def get_citations(work_id: str) -> str:
    """Get citation network for a paper (what it cites + what cites it)."""
    try:
        # Normalize ID
        if work_id.startswith("https://doi.org/"):
            work_id = f"doi:{work_id.replace('https://doi.org/', '')}"
        elif work_id.startswith("10."):
            work_id = f"doi:{work_id}"

        # Get what this paper references
        params = {
            "filter": f"cites:{work_id}",
            "per-page": 10,
            "select": "id,title,publication_year,cited_by_count,doi"
        }
        r = requests.get(f"{BASE_URL}/works", params=params, headers=HEADERS, timeout=15)
        r.raise_for_status()
        citing = r.json().get("results", [])

        result = {
            "cited_by": [
                {
                    "id": w.get("id"),
                    "title": w.get("title"),
                    "year": w.get("publication_year"),
                    "citations": w.get("cited_by_count")
                }
                for w in citing[:8]
            ]
        }
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})


def get_paper_metadata(identifier: str) -> str:
    """Get full metadata for a paper by DOI or OpenAlex ID."""
    try:
        if identifier.startswith("10.") or identifier.startswith("https://doi.org/"):
            doi = identifier.replace("https://doi.org/", "")
            url = f"{BASE_URL}/works/doi:{doi}"
        else:
            url = f"{BASE_URL}/works/{identifier}"

        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        work = r.json()

        abstract = _decode_abstract(work.get("abstract_inverted_index"))
        return json.dumps({
            "id": work.get("id"),
            "title": work.get("title"),
            "abstract": abstract[:800] if abstract else "",
            "year": work.get("publication_year"),
            "citations": work.get("cited_by_count"),
            "doi": work.get("doi"),
            "concepts": [c["display_name"] for c in work.get("concepts", [])[:8]],
            "topics": [t["display_name"] for t in work.get("topics", [])[:5]],
            "open_access": work.get("open_access", {}),
            "source": "OpenAlex"
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})


def _decode_abstract(inverted_index: dict) -> str:
    """Decode OpenAlex inverted index abstract format back to text."""
    if not inverted_index:
        return ""
    try:
        word_positions = []
        for word, positions in inverted_index.items():
            for pos in positions:
                word_positions.append((pos, word))
        word_positions.sort(key=lambda x: x[0])
        return " ".join(word for _, word in word_positions)
    except Exception:
        return ""