"""
tools/herdin_tool.py — HERDIN Plus (Health Research and Development Information Network)
Philippine national health research repository. Free, no API key needed.
URL: https://www.herdin.ph
Covers: 50,000+ Philippine health research — journals, theses, conference papers.
Method: HTML scraping (no official API exists).
"""

import json
import requests
from bs4 import BeautifulSoup
import re

BASE = "https://www.herdin.ph"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://www.herdin.ph/",
}


def search_herdin(query: str, max_results: int = 5) -> str:
    """
    Search HERDIN Plus for Philippine health research papers.
    Covers 50,000+ records from Philippine health institutions.
    """
    try:
        # Try the main search endpoint
        search_url = f"{BASE}/index.php"
        params = {
            "view": "research",
            "keywords": query,
            "pg": 1,
        }
        r = requests.get(search_url, params=params, headers=HEADERS, timeout=20)

        if r.status_code == 403:
            return json.dumps({"error": "HERDIN blocked this request. The site may require browser-like access."})
        if r.status_code != 200:
            # Try alternative search URL pattern
            alt_url = f"{BASE}/index.php/search?q={requests.utils.quote(query)}"
            r = requests.get(alt_url, headers=HEADERS, timeout=20)
            if r.status_code != 200:
                return json.dumps({"error": f"HERDIN returned HTTP {r.status_code}. Site may be temporarily unavailable."})

        soup = BeautifulSoup(r.text, "html.parser")
        papers = []

        # Try multiple possible HTML structures HERDIN uses
        # Pattern 1: div.research-item or similar
        items = (
            soup.find_all("div", class_=re.compile(r"research|result|item|record", re.I))
            or soup.find_all("tr", class_=re.compile(r"research|result|row", re.I))
            or soup.find_all("li", class_=re.compile(r"research|result|item", re.I))
        )

        for item in items[:max_results]:
            title_el = (
                item.find(["h2", "h3", "h4", "a"], class_=re.compile(r"title|name|heading", re.I))
                or item.find("a")
                or item.find(["h2", "h3", "h4"])
            )
            if not title_el:
                continue

            title = title_el.get_text(strip=True)
            if len(title) < 5:
                continue

            # URL
            link = title_el.get("href", "") if title_el.name == "a" else ""
            if link and not link.startswith("http"):
                link = BASE + link

            # Abstract / description
            abstract_el = item.find(
                ["p", "div", "span"],
                class_=re.compile(r"abstract|description|summary|excerpt", re.I)
            )
            abstract = abstract_el.get_text(strip=True)[:500] if abstract_el else ""

            # Authors
            author_el = item.find(
                ["span", "div", "p"],
                class_=re.compile(r"author|researcher|contributor", re.I)
            )
            authors = []
            if author_el:
                raw = author_el.get_text(strip=True)
                authors = [a.strip() for a in re.split(r"[;,]", raw) if a.strip()][:5]

            # Year
            year_match = re.search(r"\b(19|20)\d{2}\b", item.get_text())
            year = year_match.group(0) if year_match else ""

            papers.append({
                "id": link or title[:40],
                "title": title,
                "authors": authors,
                "abstract": abstract or "Abstract not available",
                "year": year,
                "published": year,
                "journal": "",
                "doi": "",
                "pdf_url": "",
                "citations": None,
                "open_access": True,
                "source": "HERDIN Plus",
                "url": link,
                "keywords": ["Philippine health research"],
            })

        if not papers:
            # Fallback: try to extract any meaningful content
            # HERDIN sometimes renders results differently
            all_links = soup.find_all("a", href=re.compile(r"view|research|article|record", re.I))
            seen = set()
            for a in all_links[:max_results * 2]:
                title = a.get_text(strip=True)
                if len(title) > 10 and title not in seen:
                    seen.add(title)
                    href = a.get("href", "")
                    if href and not href.startswith("http"):
                        href = BASE + href
                    papers.append({
                        "id": href or title[:40],
                        "title": title,
                        "authors": [],
                        "abstract": "See HERDIN Plus for full details.",
                        "year": "",
                        "published": "",
                        "journal": "",
                        "doi": "",
                        "pdf_url": "",
                        "citations": None,
                        "open_access": True,
                        "source": "HERDIN Plus",
                        "url": href,
                        "keywords": ["Philippine health research"],
                    })
                    if len(papers) >= max_results:
                        break

        if not papers:
            return json.dumps({
                "error": (
                    "HERDIN Plus returned no parseable results. "
                    "The site may have changed its HTML structure. "
                    f"Try visiting https://www.herdin.ph manually and searching for: {query}"
                )
            })

        return json.dumps(papers[:max_results], ensure_ascii=False)

    except requests.exceptions.Timeout:
        return json.dumps({"error": "HERDIN Plus request timed out. The site may be slow or unavailable."})
    except requests.exceptions.ConnectionError:
        return json.dumps({"error": "Could not connect to HERDIN Plus (herdin.ph). Check your internet connection."})
    except Exception as e:
        return json.dumps({"error": f"HERDIN Plus error: {str(e)}"})
