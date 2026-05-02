"""
tools/openalex_tool.py — OpenAlex API Tool
Free replacement for Semantic Scholar. No API key required.
"""

import json
import requests

BASE_URL = "https://api.openalex.org"
HEADERS  = {"User-Agent": "ResearchAssistant/2.0 (mailto:your@email.com)"}


def search_openalex(query: str, max_results: int = 5, offset: int = 0) -> str:
    """Search OpenAlex for academic papers."""
    try:
        params = {
            "search": query,
            "per-page": max_results,
            "page": (offset // max_results) + 1 if offset else 1,
            "select": "id,title,authorships,abstract_inverted_index,publication_year,cited_by_count,doi,concepts,open_access,primary_location",
            "sort": "cited_by_count:desc"
        }
        r = requests.get(f"{BASE_URL}/works", params=params, headers=HEADERS, timeout=15)
        r.raise_for_status()
        data = r.json()
        papers = []
        for work in data.get("results", []):
            abstract = _decode_abstract(work.get("abstract_inverted_index"))
            journal = ""
            loc = work.get("primary_location") or {}
            src = loc.get("source") or {}
            if src:
                journal = src.get("display_name", "")
            papers.append({
                "id": work.get("id",""),
                "title": work.get("title","Unknown"),
                "authors": [
                    a["author"]["display_name"]
                    for a in work.get("authorships",[])[:5]
                    if a.get("author")
                ],
                "abstract": abstract[:600] if abstract else "No abstract available",
                "year": work.get("publication_year"),
                "citations": work.get("cited_by_count", 0),
                "doi": work.get("doi",""),
                "journal": journal,
                "open_access": work.get("open_access",{}).get("is_oa", False),
                "concepts": [c["display_name"] for c in work.get("concepts",[])[:5]],
                "source": "OpenAlex"
            })
        return json.dumps(papers, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})


def get_citations(work_id: str) -> str:
    """Get papers that cite this work."""
    try:
        if work_id.startswith("https://doi.org/"):
            work_id = f"doi:{work_id.replace('https://doi.org/','')}"
        elif work_id.startswith("10."):
            work_id = f"doi:{work_id}"
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
                {"id": w.get("id"), "title": w.get("title"), "year": w.get("publication_year"), "citations": w.get("cited_by_count")}
                for w in citing[:8]
            ]
        }
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})


def get_paper_metadata(identifier: str) -> str:
    """Get full metadata for a paper."""
    try:
        if identifier.startswith("10.") or identifier.startswith("https://doi.org/"):
            doi = identifier.replace("https://doi.org/","")
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
            "concepts": [c["display_name"] for c in work.get("concepts",[])[:8]],
            "topics": [t["display_name"] for t in work.get("topics",[])[:5]],
            "open_access": work.get("open_access",{}),
            "source": "OpenAlex"
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})


def _decode_abstract(inverted_index: dict) -> str:
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
