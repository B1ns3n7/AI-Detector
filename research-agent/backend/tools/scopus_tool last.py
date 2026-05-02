"""
tools/scopus_tool.py — Scopus API Tool (Elsevier)
Free API key at https://dev.elsevier.com
Note: Full access requires institutional IP or approved personal access.
"""

import json
import requests
import os
from dotenv import load_dotenv

load_dotenv()

SCOPUS_API_KEY = os.getenv("SCOPUS_API_KEY", "")
SCOPUS_BASE = "https://api.elsevier.com/content"
HEADERS_BASE = {
    "Accept": "application/json",
    "X-ELS-APIKey": SCOPUS_API_KEY
}


def search_scopus(query: str, max_results: int = 5) -> str:
    """Search Scopus for academic papers."""
    if not SCOPUS_API_KEY or SCOPUS_API_KEY == "your_scopus_api_key_here":
        return json.dumps({"error": "Scopus API key not set. Add SCOPUS_API_KEY to .env file. Get free key at https://dev.elsevier.com"})
    try:
        params = {
            "query": query,
            "count": max_results,
            "field": "dc:title,dc:creator,prism:publicationName,prism:coverDate,dc:description,prism:doi,citedby-count,openaccess,authkeywords",
            "sort": "citedby-count",
        }
        r = requests.get(
            f"{SCOPUS_BASE}/search/scopus",
            headers=HEADERS_BASE,
            params=params,
            timeout=15
        )
        if r.status_code == 401:
            return json.dumps({"error": "Scopus 401 Unauthorized — your IP may not be whitelisted. Try from a university network or request personal access at integrationsupport@elsevier.com"})
        if r.status_code == 429:
            return json.dumps({"error": "Scopus rate limit reached. Please wait and try again."})
        r.raise_for_status()

        entries = r.json().get("search-results", {}).get("entry", [])
        papers = []
        for entry in entries:
            doi = entry.get("prism:doi", "")
            papers.append({
                "id": entry.get("dc:identifier", "").replace("SCOPUS_ID:", ""),
                "title": entry.get("dc:title", "Unknown"),
                "authors": [entry.get("dc:creator", "Unknown Author")],
                "journal": entry.get("prism:publicationName", ""),
                "published": entry.get("prism:coverDate", "")[:4],
                "year": entry.get("prism:coverDate", "")[:4],
                "doi": doi,
                "citations": int(entry.get("citedby-count", 0)),
                "abstract": entry.get("dc:description", "Abstract not available"),
                "open_access": entry.get("openaccess", "0") == "1",
                "keywords": entry.get("authkeywords", "").split(" | ") if entry.get("authkeywords") else [],
                "source": "Scopus"
            })
        return json.dumps(papers, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"Scopus search error: {str(e)}"})


def get_scopus_abstract(scopus_id: str) -> str:
    """Get full abstract for a Scopus paper by Scopus ID or DOI."""
    if not SCOPUS_API_KEY or SCOPUS_API_KEY == "your_scopus_api_key_here":
        return json.dumps({"error": "Scopus API key not set."})
    try:
        # Try DOI-based lookup first
        if scopus_id.startswith("10."):
            url = f"{SCOPUS_BASE}/abstract/doi/{scopus_id}"
        else:
            url = f"{SCOPUS_BASE}/abstract/scopus_id/{scopus_id}"

        r = requests.get(
            url,
            headers={**HEADERS_BASE, "X-ELS-ResourceVersion": "XOCS"},
            timeout=15
        )
        if r.status_code == 401:
            return json.dumps({"error": "Scopus 401 — IP not whitelisted for abstract retrieval."})
        r.raise_for_status()

        data = r.json().get("abstracts-retrieval-response", {})
        coredata = data.get("coredata", {})
        authors = data.get("authors", {}).get("author", [])

        author_names = []
        if isinstance(authors, list):
            for a in authors[:6]:
                name = a.get("preferred-name", {})
                full = f"{name.get('ce:given-name', '')} {name.get('ce:surname', '')}".strip()
                if full:
                    author_names.append(full)

        return json.dumps({
            "id": scopus_id,
            "title": coredata.get("dc:title", "Unknown"),
            "authors": author_names,
            "abstract": coredata.get("dc:description", "No abstract available"),
            "journal": coredata.get("prism:publicationName", ""),
            "year": coredata.get("prism:coverDate", "")[:4],
            "doi": coredata.get("prism:doi", ""),
            "citations": coredata.get("citedby-count", 0),
            "open_access": coredata.get("openaccess", "0") == "1",
            "source": "Scopus"
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"Scopus abstract error: {str(e)}"})


def get_scopus_citations(scopus_id: str) -> str:
    """Get papers that cite a given Scopus paper."""
    if not SCOPUS_API_KEY or SCOPUS_API_KEY == "your_scopus_api_key_here":
        return json.dumps({"error": "Scopus API key not set."})
    try:
        params = {
            "query": f"refeid({scopus_id})",
            "count": 8,
            "field": "dc:title,dc:creator,prism:coverDate,citedby-count,prism:doi"
        }
        r = requests.get(
            f"{SCOPUS_BASE}/search/scopus",
            headers=HEADERS_BASE,
            params=params,
            timeout=15
        )
        r.raise_for_status()
        entries = r.json().get("search-results", {}).get("entry", [])
        citing = []
        for entry in entries:
            citing.append({
                "title": entry.get("dc:title", "Unknown"),
                "author": entry.get("dc:creator", ""),
                "year": entry.get("prism:coverDate", "")[:4],
                "citations": entry.get("citedby-count", 0),
                "doi": entry.get("prism:doi", ""),
            })
        return json.dumps({"scopus_id": scopus_id, "cited_by": citing}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"Scopus citation error: {str(e)}"})