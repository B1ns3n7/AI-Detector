"""
tools/pej_tool.py — Philippine E-Journals (PEJ)
Academic journals from Philippine universities and professional organizations.
URL: https://ejournals.ph
Covers: 100+ HEI journals, all disciplines — free, no API key needed.
Method: HTML scraping of ejournals.ph/search.php?searchStr=QUERY
         + article detail pages ejournals.ph/form.php?id=ARTICLE_ID
"""

import json
import requests
from bs4 import BeautifulSoup
import re

BASE = "https://ejournals.ph"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://ejournals.ph/",
}


def _parse_article_page(article_id: str) -> dict:
    """Fetch full details from an individual article page."""
    try:
        r = requests.get(
            f"{BASE}/form.php",
            params={"id": article_id},
            headers=HEADERS,
            timeout=15,
        )
        if r.status_code != 200:
            return {}
        soup = BeautifulSoup(r.text, "html.parser")
        data = {}

        # Title
        title_el = soup.find(["h1", "h2", "h3"], class_=re.compile(r"title|heading", re.I)) \
                   or soup.find("h1") or soup.find("h2")
        if title_el:
            data["title"] = title_el.get_text(strip=True)

        # Abstract
        abstract_el = soup.find(string=re.compile(r"abstract", re.I))
        if abstract_el:
            parent = abstract_el.find_parent()
            if parent:
                sib = parent.find_next_sibling()
                if sib:
                    data["abstract"] = sib.get_text(strip=True)[:500]

        # Authors — look for td/span near "Author"
        author_label = soup.find(string=re.compile(r"^author", re.I))
        if author_label:
            parent = author_label.find_parent()
            if parent:
                sib = parent.find_next_sibling() or parent.parent.find_next_sibling()
                if sib:
                    raw = sib.get_text(strip=True)
                    data["authors"] = [a.strip() for a in re.split(r"[;,]", raw) if a.strip()][:5]

        # Year
        year_match = re.search(r"\b(19|20)\d{2}\b", soup.get_text())
        if year_match:
            data["year"] = year_match.group(0)

        # Journal name
        journal_el = soup.find(string=re.compile(r"journal|publication", re.I))
        if journal_el:
            p = journal_el.find_parent()
            if p:
                sib = p.find_next_sibling()
                if sib:
                    data["journal"] = sib.get_text(strip=True)[:100]

        # DOI
        doi_match = re.search(r"10\.\d{4,}/\S+", soup.get_text())
        if doi_match:
            data["doi"] = doi_match.group(0).rstrip(".,;)")

        # PDF link
        pdf_link = soup.find("a", href=re.compile(r"\.pdf", re.I))
        if pdf_link:
            href = pdf_link.get("href", "")
            data["pdf_url"] = href if href.startswith("http") else BASE + href

        return data
    except Exception:
        return {}


def search_pej(query: str, max_results: int = 5) -> str:
    """
    Search Philippine E-Journals for academic articles from Philippine HEIs.
    Covers 100+ journals across education, health, social sciences, engineering, and more.
    """
    try:
        r = requests.get(
            f"{BASE}/search.php",
            params={"searchStr": query},
            headers=HEADERS,
            timeout=20,
        )
        if r.status_code == 403:
            return json.dumps({"error": "Philippine E-Journals blocked this request."})
        if r.status_code != 200:
            return json.dumps({"error": f"Philippine E-Journals returned HTTP {r.status_code}."})

        soup = BeautifulSoup(r.text, "html.parser")
        papers = []
        seen_titles = set()

        # PEJ search results: each result is a block with journal title, article titles, authors
        # Structure: div or td containing article name, journal, authors, year
        # Try table rows first (PEJ often uses tables)
        rows = soup.find_all("tr")
        for row in rows:
            cells = row.find_all(["td", "th"])
            if len(cells) < 2:
                continue

            # Look for a cell with a meaningful title-like link
            title_link = row.find("a", href=re.compile(r"form\.php|article|view", re.I))
            if not title_link:
                title_link = row.find("a")
            if not title_link:
                continue

            title = title_link.get_text(strip=True)
            if len(title) < 8 or title.lower() in seen_titles:
                continue
            seen_titles.add(title.lower())

            href = title_link.get("href", "")
            article_id = ""
            id_match = re.search(r"id=(\d+)", href)
            if id_match:
                article_id = id_match.group(1)
            full_url = (href if href.startswith("http") else BASE + "/" + href.lstrip("/")) if href else ""

            # Extract text from all cells
            row_text = row.get_text(" | ", strip=True)

            # Authors: look for names pattern (Firstname Lastname separated by commas/semicolons)
            authors = []
            author_match = re.search(
                r"(?:by|author[s]?:?\s*)([A-Z][a-z]+(?:\s[A-Z][a-z.]+)+(?:[;,]\s*[A-Z][a-z]+(?:\s[A-Z][a-z.]+)+)*)",
                row_text, re.I
            )
            if author_match:
                authors = [a.strip() for a in re.split(r"[;,]", author_match.group(1)) if a.strip()][:5]

            # Year
            year_match = re.search(r"\b(19|20)\d{2}\b", row_text)
            year = year_match.group(0) if year_match else ""

            # Journal name — often in a separate cell or italicised
            journal = ""
            journal_el = row.find(["em", "i", "span"], class_=re.compile(r"journal|source|pub", re.I))
            if not journal_el:
                journal_el = row.find(["em", "i"])
            if journal_el:
                journal = journal_el.get_text(strip=True)[:100]

            papers.append({
                "id": article_id or title[:40],
                "title": title,
                "authors": authors,
                "abstract": "See Philippine E-Journals for abstract.",
                "year": year,
                "published": year,
                "journal": journal,
                "doi": "",
                "pdf_url": "",
                "citations": None,
                "open_access": True,
                "source": "Philippine E-Journals",
                "url": full_url,
                "keywords": ["Philippine academic journal"],
            })

            if len(papers) >= max_results:
                break

        # Fallback: grab any article links from the page
        if not papers:
            links = soup.find_all("a", href=re.compile(r"form\.php\?id=\d+"))
            for a in links[:max_results]:
                title = a.get_text(strip=True)
                if len(title) < 5:
                    continue
                href = a.get("href", "")
                full_url = href if href.startswith("http") else BASE + "/" + href.lstrip("/")
                id_match = re.search(r"id=(\d+)", href)
                article_id = id_match.group(1) if id_match else ""

                # Try to get parent context for author/year
                parent = a.find_parent(["tr", "div", "li"])
                parent_text = parent.get_text(" ", strip=True) if parent else ""
                year_match = re.search(r"\b(19|20)\d{2}\b", parent_text)
                year = year_match.group(0) if year_match else ""

                papers.append({
                    "id": article_id,
                    "title": title,
                    "authors": [],
                    "abstract": "See Philippine E-Journals for abstract.",
                    "year": year,
                    "published": year,
                    "journal": "",
                    "doi": "",
                    "pdf_url": "",
                    "citations": None,
                    "open_access": True,
                    "source": "Philippine E-Journals",
                    "url": full_url,
                    "keywords": ["Philippine academic journal"],
                })
                seen_titles.add(title.lower())
                if len(papers) >= max_results:
                    break

        if not papers:
            return json.dumps({
                "error": (
                    f"No results found on Philippine E-Journals for '{query}'. "
                    "Try different keywords or visit https://ejournals.ph directly."
                )
            })

        return json.dumps(papers[:max_results], ensure_ascii=False)

    except requests.exceptions.Timeout:
        return json.dumps({"error": "Philippine E-Journals request timed out."})
    except requests.exceptions.ConnectionError:
        return json.dumps({"error": "Could not connect to ejournals.ph. Check your internet connection."})
    except Exception as e:
        return json.dumps({"error": f"Philippine E-Journals error: {str(e)}"})


def get_pej_article(article_id: str) -> str:
    """Get full details of a Philippine E-Journals article by its ID."""
    try:
        data = _parse_article_page(article_id.strip())
        if not data:
            return json.dumps({"error": f"Could not fetch PEJ article ID {article_id}"})
        data["source"] = "Philippine E-Journals"
        data["open_access"] = True
        data["url"] = f"{BASE}/form.php?id={article_id}"
        return json.dumps(data, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"PEJ article fetch error: {str(e)}"})
