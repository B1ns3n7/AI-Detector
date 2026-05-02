"""
tools/crossref_tool.py — CrossRef API (DOI resolution, paper search)
Free, no API key required.
"""

import json
import requests

CROSSREF_URL = "https://api.crossref.org"
HEADERS = {"User-Agent": "ResearchAssistant/2.0 (mailto:your@email.com)"}


def resolve_doi(doi: str) -> str:
    """Resolve a DOI to get paper details from CrossRef."""
    try:
        doi = doi.strip().replace("https://doi.org/", "").replace("doi:", "")
        r = requests.get(f"{CROSSREF_URL}/works/{doi}", headers=HEADERS, timeout=15)
        r.raise_for_status()
        work = r.json().get("message", {})
        return json.dumps({
            "doi": doi,
            "title": " ".join(work.get("title", ["Unknown"])),
            "authors": [
                f"{a.get('given','')} {a.get('family','')}".strip()
                for a in work.get("author", [])[:5]
            ],
            "publisher": work.get("publisher"),
            "journal": work.get("container-title", [""])[0] if work.get("container-title") else "",
            "year": work.get("published", {}).get("date-parts", [[None]])[0][0],
            "citations": work.get("is-referenced-by-count", 0),
            "abstract": work.get("abstract", "")[:500],
            "source": "CrossRef"
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})


def search_crossref(query: str, max_results: int = 5, offset: int = 0) -> str:
    """Search CrossRef for academic papers."""
    try:
        params = {
            "query": query,
            "rows": max_results,
            "offset": offset,
            "select": "DOI,title,author,published,is-referenced-by-count,abstract,container-title,publisher",
            "sort": "is-referenced-by-count",
            "order": "desc",
            "filter": "type:journal-article"
        }
        r = requests.get(
            f"{CROSSREF_URL}/works",
            params=params,
            headers=HEADERS,
            timeout=15
        )
        r.raise_for_status()
        items = r.json().get("message", {}).get("items", [])
        papers = []
        for item in items:
            title = " ".join(item.get("title", ["Unknown"]))
            if not title or title == "Unknown":
                continue
            authors = [
                f"{a.get('given','')} {a.get('family','')}".strip()
                for a in item.get("author", [])[:5]
                if a.get('family')
            ]
            year = None
            pub = item.get("published") or item.get("published-print") or item.get("published-online")
            if pub:
                parts = pub.get("date-parts", [[None]])[0]
                year = parts[0] if parts else None
            journal = ""
            if item.get("container-title"):
                journal = item["container-title"][0]
            papers.append({
                "doi": item.get("DOI", ""),
                "title": title,
                "authors": authors,
                "journal": journal,
                "year": year,
                "citations": item.get("is-referenced-by-count", 0),
                "abstract": item.get("abstract", "")[:500].replace("<jats:p>","").replace("</jats:p>",""),
                "source": "CrossRef"
            })
        print(f"  CrossRef raw items: {len(items)}, valid papers: {len(papers)}")
        return json.dumps(papers, ensure_ascii=False)
    except Exception as e:
        print(f"  CrossRef exception: {e}")
        return json.dumps({"error": str(e)})
