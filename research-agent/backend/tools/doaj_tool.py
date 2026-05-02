"""
tools/doaj_tool.py — DOAJ (Directory of Open Access Journals) Tool
Free, no API key required.
API v4: https://doaj.org/api/v4/docs
Every paper returned is 100% open access with free full text.
Coverage: 10M+ articles from 20,000+ peer-reviewed journals.
"""

import json
import requests

BASE = "https://doaj.org/api/v4"
HEADERS = {"Accept": "application/json"}


def search_doaj(query: str, max_results: int = 5, offset: int = 0) -> str:
    """
    Search DOAJ for open access articles.
    Every result is guaranteed open access with a free full-text URL.
    """
    try:
        params = {
            "search.query": query,
            "search.field": "all",
            "pageSize": max_results,
            "page": (offset // max_results) + 1 if offset else 1,
            "sort": "relevance",
        }
        r = requests.get(
            f"{BASE}/search/articles/{requests.utils.quote(query)}",
            params={"pageSize": max_results,
                    "page": (offset // max_results) + 1 if offset else 1},
            headers=HEADERS,
            timeout=15,
        )
        if r.status_code == 429:
            return json.dumps({"error": "DOAJ rate limit hit. Please wait a moment."})
        r.raise_for_status()

        data = r.json()
        results = data.get("results", [])
        papers = []

        for item in results:
            bib = item.get("bibjson", {})

            # Authors
            authors = []
            for a in (bib.get("author") or [])[:6]:
                name = a.get("name", "")
                if name:
                    authors.append(name)

            # Year
            year = str(bib.get("year", "")) if bib.get("year") else ""

            # Journal info
            journal_info = bib.get("journal", {})
            journal = journal_info.get("title", "")
            volume  = str(journal_info.get("volume", ""))
            issue   = str(journal_info.get("number", ""))

            # Pages
            start_page = bib.get("start_page", "")
            end_page   = bib.get("end_page", "")
            pages = f"{start_page}–{end_page}" if start_page and end_page else start_page

            # DOI
            doi = ""
            for ident in (bib.get("identifier") or []):
                if ident.get("type") == "doi":
                    doi = ident.get("id", "")
                    break

            # Full text URL — DOAJ always has one
            full_text_url = ""
            for link in (bib.get("link") or []):
                if link.get("type") == "fulltext":
                    full_text_url = link.get("url", "")
                    break

            # Abstract
            abstract = bib.get("abstract", "Abstract not available")

            # Keywords / subjects
            keywords = []
            for subj in (bib.get("subject") or [])[:5]:
                term = subj.get("term", "")
                if term:
                    keywords.append(term)

            # ISSN
            issn = ""
            for ident in (bib.get("identifier") or []):
                if ident.get("type") in ("pissn", "eissn"):
                    issn = ident.get("id", "")
                    break

            papers.append({
                "id": item.get("id", ""),
                "title": bib.get("title", "Unknown"),
                "authors": authors,
                "abstract": abstract,
                "year": year,
                "published": year,
                "journal": journal,
                "volume": volume,
                "issue": issue,
                "pages": pages,
                "issn": issn,
                "doi": doi,
                "pdf_url": full_text_url,
                "url": full_text_url or (f"https://doi.org/{doi}" if doi else ""),
                "keywords": keywords,
                "citations": None,          # DOAJ does not track citation counts
                "open_access": True,        # DOAJ is 100% open access by definition
                "source": "DOAJ",
            })

        return json.dumps(papers, ensure_ascii=False)

    except requests.exceptions.Timeout:
        return json.dumps({"error": "DOAJ request timed out. Try again."})
    except Exception as e:
        return json.dumps({"error": f"DOAJ search error: {str(e)}"})


def get_doaj_article(doaj_id: str) -> str:
    """Get full metadata for a DOAJ article by its DOAJ ID."""
    try:
        r = requests.get(
            f"{BASE}/articles/{doaj_id.strip()}",
            headers=HEADERS,
            timeout=15,
        )
        if r.status_code == 404:
            return json.dumps({"error": f"DOAJ article not found: {doaj_id}"})
        r.raise_for_status()

        item = r.json()
        bib = item.get("bibjson", {})

        authors = [a.get("name", "") for a in (bib.get("author") or [])[:6] if a.get("name")]
        doi = next((i.get("id", "") for i in (bib.get("identifier") or []) if i.get("type") == "doi"), "")
        full_text_url = next((l.get("url", "") for l in (bib.get("link") or []) if l.get("type") == "fulltext"), "")
        journal_info = bib.get("journal", {})

        return json.dumps({
            "id": item.get("id", ""),
            "title": bib.get("title", "Unknown"),
            "authors": authors,
            "abstract": bib.get("abstract", "Abstract not available"),
            "year": str(bib.get("year", "")),
            "journal": journal_info.get("title", ""),
            "volume": str(journal_info.get("volume", "")),
            "issue": str(journal_info.get("number", "")),
            "doi": doi,
            "pdf_url": full_text_url,
            "open_access": True,
            "source": "DOAJ",
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({"error": f"DOAJ fetch error: {str(e)}"})
