"""
ukdr_tool.py — UKDR UPLB search tool for the Research Assistant backend.
Searches the University Knowledge Digital Repository (Digital Commons/bepress)
via its public RSS feed. No API key needed.

Save this file at: D:\Agentic Rag\backend\tools\ukdr_tool.py
"""

import requests
import re
import json
from xml.etree import ElementTree

UKDR_SEARCH_URL = "https://www.ukdr.uplb.edu.ph/do/search/"
DC_NS = "http://purl.org/dc/elements/1.1/"


def search_ukdr(query: str, max_results: int = 10) -> str:
    """
    Search UKDR UPLB via the Digital Commons public RSS feed.
    Returns a JSON string of paper dicts compatible with the app's paper format.
    """
    params = {
        "q": query,
        "start": "0",
        "feed": "rss",
    }
    headers = {
        "User-Agent": "ResearchAgent/2.0 (academic research tool)",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
    }

    try:
        resp = requests.get(
            UKDR_SEARCH_URL,
            params=params,
            headers=headers,
            timeout=15,
        )
        resp.raise_for_status()
        xml_text = resp.text
    except requests.RequestException as e:
        print(f"[UKDR] fetch error: {e}")
        return json.dumps([])

    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as e:
        print(f"[UKDR] XML parse error: {e}")
        return json.dumps([])

    papers = []
    items = root.findall(".//item")[:max_results]

    for item in items:
        def get(tag, el=item):
            node = el.find(tag)
            return node.text.strip() if node is not None and node.text else ""

        def get_all_ns(tag, el=item):
            return [
                node.text.strip()
                for node in el.findall(f"{{{DC_NS}}}{tag}")
                if node.text and node.text.strip()
            ]

        title = get("title")
        if not title:
            continue

        link = get("link")

        # Year from pubDate e.g. "Thu, 01 Jan 2024 00:00:00 GMT"
        pub_date = get("pubDate")
        year_match = re.search(r"\d{4}", pub_date)
        year = year_match.group() if year_match else ""

        # Authors from dc:creator
        authors = get_all_ns("creator")
        if not authors:
            fallback = get("author")
            if fallback:
                authors = [fallback]

        # Abstract — strip HTML tags from description
        raw_desc = get("description")
        abstract = re.sub(r"<[^>]+>", "", raw_desc).strip()
        abstract = re.sub(r"\s+", " ", abstract)

        # DOI from dc:identifier
        identifiers = get_all_ns("identifier")
        doi = next(
            (v for v in identifiers if v.startswith("10.") or "doi.org/" in v),
            "",
        )
        if "doi.org/" in doi:
            doi = doi.split("doi.org/")[-1]

        source_list = get_all_ns("source")
        journal = source_list[0] if source_list else "UKDR UPLB"

        papers.append({
            "title": title,
            "authors": authors,
            "year": year,
            "abstract": abstract,
            "doi": doi,
            "url": link,
            "pdf_url": link,
            "journal": journal,
            "source": "UKDR UPLB",
            "open_access": True,
            "citations": None,
        })

    print(f"[UKDR] Found {len(papers)} papers for query: {query!r}")
    return json.dumps(papers)
