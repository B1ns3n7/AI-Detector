"""
tools/springer_tool.py — Springer Nature API Tool
Free API key at https://dev.springernature.com (instant signup, no payment)
API: https://api.springernature.com
"""

import json
import requests
import os
from dotenv import load_dotenv

load_dotenv()

SPRINGER_API_KEY = os.getenv("SPRINGER_API_KEY", "")
BASE = "https://api.springernature.com"


def search_springer(query: str, max_results: int = 5) -> str:
    """Search Springer Nature for peer-reviewed articles (13M+ papers)."""
    if not SPRINGER_API_KEY or SPRINGER_API_KEY == "your_springer_api_key_here":
        return json.dumps({"error": "Springer API key not set. Get a free key at https://dev.springernature.com then add SPRINGER_API_KEY to .env"})
    try:
        r = requests.get(
            f"{BASE}/meta/v2/json",
            params={
                "api_key": SPRINGER_API_KEY,
                "q": query,
                "p": max_results,
                "s": 1,
            },
            timeout=15
        )
        if r.status_code == 401:
            return json.dumps({"error": "Springer 401 — invalid API key. Check SPRINGER_API_KEY in .env"})
        if r.status_code == 429:
            return json.dumps({"error": "Springer rate limit hit. Please wait and try again."})
        r.raise_for_status()

        records = r.json().get("records", [])
        papers = []
        for item in records:
            authors = [
                f"{a.get('creator', '')}" for a in (item.get("creators") or [])[:6]
                if a.get("creator")
            ]

            doi = item.get("doi", "")
            pdf_url = ""
            for url_obj in (item.get("url") or []):
                if isinstance(url_obj, dict) and url_obj.get("format") == "pdf":
                    pdf_url = url_obj.get("value", "")
                    break

            open_access = item.get("openaccess", "false").lower() == "true"

            papers.append({
                "id": doi or item.get("identifier", ""),
                "title": item.get("title", "Unknown"),
                "authors": authors,
                "abstract": item.get("abstract") or "Abstract not available",
                "year": item.get("publicationDate", "")[:4],
                "published": item.get("publicationDate", "")[:4],
                "journal": item.get("publicationName", ""),
                "publisher": item.get("publisher", "Springer Nature"),
                "doi": doi,
                "pdf_url": pdf_url,
                "isbn": item.get("isbn", ""),
                "issn": item.get("issn", ""),
                "keywords": [k.get("keyword", "") for k in (item.get("keyword") or [])[:5]],
                "open_access": open_access,
                "content_type": item.get("contentType", ""),
                "source": "Springer Nature",
                "url": f"https://doi.org/{doi}" if doi else ""
            })
        return json.dumps(papers, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"Springer search error: {str(e)}"})


def get_springer_paper(doi: str) -> str:
    """Get full metadata for a Springer paper by DOI."""
    if not SPRINGER_API_KEY or SPRINGER_API_KEY == "your_springer_api_key_here":
        return json.dumps({"error": "Springer API key not set."})
    try:
        r = requests.get(
            f"{BASE}/meta/v2/json",
            params={
                "api_key": SPRINGER_API_KEY,
                "q": f"doi:{doi.strip()}",
                "p": 1,
            },
            timeout=15
        )
        r.raise_for_status()
        records = r.json().get("records", [])
        if not records:
            return json.dumps({"error": f"No Springer paper found for DOI: {doi}"})

        item = records[0]
        authors = [a.get("creator", "") for a in (item.get("creators") or [])[:6] if a.get("creator")]
        return json.dumps({
            "title": item.get("title", "Unknown"),
            "authors": authors,
            "abstract": item.get("abstract") or "Abstract not available",
            "year": item.get("publicationDate", "")[:4],
            "journal": item.get("publicationName", ""),
            "doi": item.get("doi", ""),
            "open_access": item.get("openaccess", "false").lower() == "true",
            "source": "Springer Nature"
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"Springer fetch error: {str(e)}"})


def search_springer_open_access(query: str, max_results: int = 5) -> str:
    """Search Springer Nature for open access articles only."""
    if not SPRINGER_API_KEY or SPRINGER_API_KEY == "your_springer_api_key_here":
        return json.dumps({"error": "Springer API key not set."})
    try:
        r = requests.get(
            f"{BASE}/openaccess/json",
            params={
                "api_key": SPRINGER_API_KEY,
                "q": query,
                "p": max_results,
                "s": 1,
            },
            timeout=15
        )
        r.raise_for_status()
        records = r.json().get("records", [])
        papers = []
        for item in records:
            authors = [a.get("creator", "") for a in (item.get("creators") or [])[:6] if a.get("creator")]
            doi = item.get("doi", "")
            papers.append({
                "id": doi,
                "title": item.get("title", "Unknown"),
                "authors": authors,
                "abstract": item.get("abstract") or "Abstract not available",
                "year": item.get("publicationDate", "")[:4],
                "journal": item.get("publicationName", ""),
                "doi": doi,
                "open_access": True,
                "source": "Springer Nature",
                "url": f"https://doi.org/{doi}" if doi else ""
            })
        return json.dumps(papers, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"Springer OA search error: {str(e)}"})
