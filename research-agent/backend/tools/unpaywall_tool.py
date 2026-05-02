"""
tools/unpaywall_tool.py — Get free full-text URLs via Unpaywall
Requires only an email address (no account/key needed).
"""

import json
import requests
import os

EMAIL = os.getenv("UNPAYWALL_EMAIL", "your@email.com")


def get_fulltext_url(doi: str) -> str:
    """Get open-access full-text URL for a paper via Unpaywall."""
    try:
        doi = doi.strip().replace("https://doi.org/", "")
        url = f"https://api.unpaywall.org/v2/{doi}?email={EMAIL}"
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        data = r.json()
        best_oa = data.get("best_oa_location", {})
        return json.dumps({
            "doi": doi,
            "title": data.get("title"),
            "is_oa": data.get("is_oa", False),
            "oa_status": data.get("oa_status"),
            "pdf_url": best_oa.get("url_for_pdf") if best_oa else None,
            "landing_page": best_oa.get("url_for_landing_page") if best_oa else None,
            "host_type": best_oa.get("host_type") if best_oa else None,
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})