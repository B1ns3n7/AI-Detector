"""
tools/core_tool.py — CORE API Tool
Free, no API key required (rate limited).
Optional: free key at https://core.ac.uk/services/api for higher limits.
API: https://api.core.ac.uk/v3
"""

import json
import requests
import os
from dotenv import load_dotenv

load_dotenv()

CORE_API_KEY = os.getenv("CORE_API_KEY", "")
BASE = "https://api.core.ac.uk/v3"


def _headers():
    h = {"Accept": "application/json"}
    if CORE_API_KEY and CORE_API_KEY != "your_core_api_key_here":
        h["Authorization"] = f"Bearer {CORE_API_KEY}"
    return h


def search_core(query: str, max_results: int = 5, offset: int = 0) -> str:
    """Search CORE for open access full-text papers (230M+ works)."""
    try:
        r = requests.post(
            f"{BASE}/search/works",
            headers=_headers(),
            json={
                "q": query,
                "limit": max_results,
                "offset": offset,
                "fields": [
                    "id", "title", "authors", "abstract", "yearPublished",
                    "publisher", "journals", "doi", "downloadUrl",
                    "sourceFulltextUrls", "citationCount", "fieldOfStudy",
                    "documentType", "language"
                ]
            },
            timeout=15
        )
        if r.status_code == 429:
            return json.dumps({"error": "CORE rate limit hit. Add CORE_API_KEY to .env for higher limits: https://core.ac.uk/services/api"})
        r.raise_for_status()

        results = r.json().get("results", [])
        papers = []
        for item in results:
            authors = []
            for a in (item.get("authors") or [])[:6]:
                name = a.get("name", "")
                if name:
                    authors.append(name)

            journal = ""
            journals = item.get("journals") or []
            if journals and isinstance(journals, list):
                journal = journals[0].get("title", "") if isinstance(journals[0], dict) else str(journals[0])

            pdf_url = item.get("downloadUrl") or ""
            if not pdf_url:
                urls = item.get("sourceFulltextUrls") or []
                if urls:
                    pdf_url = urls[0]

            papers.append({
                "id": str(item.get("id", "")),
                "title": item.get("title", "Unknown"),
                "authors": authors,
                "abstract": item.get("abstract") or "Abstract not available",
                "year": item.get("yearPublished"),
                "published": str(item.get("yearPublished", "")),
                "publisher": item.get("publisher", ""),
                "journal": journal,
                "doi": item.get("doi", ""),
                "pdf_url": pdf_url,
                "citations": item.get("citationCount"),
                "keywords": item.get("fieldOfStudy") or [],
                "open_access": True,
                "source": "CORE",
                "url": f"https://core.ac.uk/works/{item.get('id', '')}"
            })
        return json.dumps(papers, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"CORE search error: {str(e)}"})


def get_core_paper(core_id: str) -> str:
    """Get full details of a CORE paper by its CORE ID."""
    try:
        r = requests.get(
            f"{BASE}/works/{core_id.strip()}",
            headers=_headers(),
            timeout=15
        )
        if r.status_code == 404:
            return json.dumps({"error": f"CORE paper not found: {core_id}"})
        r.raise_for_status()
        item = r.json()

        authors = [a.get("name", "") for a in (item.get("authors") or [])[:6] if a.get("name")]
        journal = ""
        journals = item.get("journals") or []
        if journals:
            journal = journals[0].get("title", "") if isinstance(journals[0], dict) else str(journals[0])

        pdf_url = item.get("downloadUrl") or ""
        if not pdf_url:
            urls = item.get("sourceFulltextUrls") or []
            if urls:
                pdf_url = urls[0]

        return json.dumps({
            "id": str(item.get("id", "")),
            "title": item.get("title", "Unknown"),
            "authors": authors,
            "abstract": item.get("abstract") or "Abstract not available",
            "year": item.get("yearPublished"),
            "journal": journal,
            "doi": item.get("doi", ""),
            "pdf_url": pdf_url,
            "citations": item.get("citationCount"),
            "open_access": True,
            "source": "CORE",
            "url": f"https://core.ac.uk/works/{item.get('id', '')}"
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"CORE fetch error: {str(e)}"})
