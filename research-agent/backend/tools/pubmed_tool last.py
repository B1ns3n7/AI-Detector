"""
tools/pubmed_tool.py — PubMed / NCBI API Tool
Free, no API key required.
API: https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
"""

import json
import requests
import xml.etree.ElementTree as ET
from urllib.parse import quote

BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
HEADERS = {"User-Agent": "ResearchAssistant/1.0 (academic use)"}


def search_pubmed(query: str, max_results: int = 5) -> str:
    """Search PubMed for biomedical papers. Returns titles, authors, abstracts, PMIDs."""
    try:
        # Step 1: Search for PMIDs
        search_r = requests.get(
            f"{BASE}/esearch.fcgi",
            params={
                "db": "pubmed",
                "term": query,
                "retmax": max_results,
                "retmode": "json",
                "sort": "relevance",
                "usehistory": "y"
            },
            headers=HEADERS,
            timeout=15
        )
        search_r.raise_for_status()
        search_data = search_r.json()
        pmids = search_data.get("esearchresult", {}).get("idlist", [])

        if not pmids:
            return json.dumps([])

        # Step 2: Fetch full details for all PMIDs
        fetch_r = requests.get(
            f"{BASE}/efetch.fcgi",
            params={
                "db": "pubmed",
                "id": ",".join(pmids),
                "retmode": "xml",
                "rettype": "abstract"
            },
            headers=HEADERS,
            timeout=20
        )
        fetch_r.raise_for_status()

        papers = _parse_pubmed_xml(fetch_r.text)
        return json.dumps(papers, ensure_ascii=False)

    except Exception as e:
        return json.dumps({"error": f"PubMed search error: {str(e)}"})


def get_pubmed_abstract(pmid: str) -> str:
    """Fetch full details of a PubMed paper by PMID."""
    try:
        r = requests.get(
            f"{BASE}/efetch.fcgi",
            params={
                "db": "pubmed",
                "id": pmid.strip(),
                "retmode": "xml",
                "rettype": "abstract"
            },
            headers=HEADERS,
            timeout=15
        )
        r.raise_for_status()
        papers = _parse_pubmed_xml(r.text)
        if papers:
            return json.dumps(papers[0], ensure_ascii=False)
        return json.dumps({"error": f"No paper found for PMID {pmid}"})
    except Exception as e:
        return json.dumps({"error": f"PubMed fetch error: {str(e)}"})


def search_pubmed_clinical(query: str, max_results: int = 5) -> str:
    """Search PubMed specifically for clinical trials and systematic reviews."""
    clinical_query = f"({query}) AND (clinical trial[pt] OR systematic review[pt] OR meta-analysis[pt])"
    return search_pubmed(clinical_query, max_results)


def _parse_pubmed_xml(xml_text: str) -> list:
    """Parse PubMed XML response into paper dicts."""
    papers = []
    try:
        root = ET.fromstring(xml_text)
        for article in root.findall(".//PubmedArticle"):
            try:
                medline = article.find("MedlineCitation")
                art = medline.find("Article")

                # Title
                title_el = art.find("ArticleTitle")
                title = _xml_text(title_el)

                # Authors
                authors = []
                author_list = art.find("AuthorList")
                if author_list is not None:
                    for author in author_list.findall("Author")[:6]:
                        last = _xml_text(author.find("LastName"))
                        fore = _xml_text(author.find("ForeName"))
                        if last:
                            authors.append(f"{fore} {last}".strip())

                # Abstract
                abstract_parts = []
                abstract_el = art.find("Abstract")
                if abstract_el is not None:
                    for text_el in abstract_el.findall("AbstractText"):
                        label = text_el.get("Label", "")
                        text = _xml_text(text_el)
                        if text:
                            abstract_parts.append(f"{label}: {text}" if label else text)
                abstract = " ".join(abstract_parts)

                # Journal
                journal_el = art.find("Journal/Title")
                journal = _xml_text(journal_el)

                # Year
                year = ""
                pub_date = art.find("Journal/JournalIssue/PubDate")
                if pub_date is not None:
                    year = _xml_text(pub_date.find("Year")) or _xml_text(pub_date.find("MedlineDate", ))[:4]

                # PMID
                pmid_el = medline.find("PMID")
                pmid = _xml_text(pmid_el)

                # DOI
                doi = ""
                for id_el in article.findall(".//ArticleId"):
                    if id_el.get("IdType") == "doi":
                        doi = id_el.text or ""
                        break

                # MeSH keywords
                keywords = []
                for mesh in medline.findall(".//MeshHeading/DescriptorName")[:5]:
                    kw = _xml_text(mesh)
                    if kw:
                        keywords.append(kw)

                # Publication types
                pub_types = []
                for pt in art.findall(".//PublicationType")[:3]:
                    pub_types.append(_xml_text(pt))

                papers.append({
                    "id": pmid,
                    "pmid": pmid,
                    "title": title,
                    "authors": authors,
                    "abstract": abstract or "Abstract not available",
                    "journal": journal,
                    "year": year,
                    "published": year,
                    "doi": doi,
                    "keywords": keywords,
                    "pub_types": pub_types,
                    "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                    "source": "PubMed",
                    "open_access": False
                })
            except Exception:
                continue
    except ET.ParseError as e:
        return [{"error": f"XML parse error: {str(e)}"}]
    return papers


def _xml_text(el) -> str:
    """Safely extract text from an XML element, including mixed content."""
    if el is None:
        return ""
    return "".join(el.itertext()).strip()
