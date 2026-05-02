"""
tools/arxiv_tool.py — arXiv Paper Search & Fetch Tool
No API key required.
"""

import json
import arxiv


def search_arxiv(query: str, max_results: int = 5, offset: int = 0) -> str:
    """Search arXiv for papers matching the query."""
    try:
        client = arxiv.Client()
        search = arxiv.Search(
            query=query,
            max_results=max_results + offset,
            sort_by=arxiv.SortCriterion.Relevance
        )
        papers = []
        for idx, result in enumerate(client.results(search)):
            if idx < offset: continue
            papers.append({
                "id": result.entry_id.split("/")[-1],
                "title": result.title,
                "authors": [a.name for a in result.authors[:5]],
                "abstract": result.summary[:600],
                "published": str(result.published.date()),
                "year": result.published.year,
                "categories": result.categories,
                "pdf_url": result.pdf_url,
                "doi": result.doi or "",
                "citations": None,
                "source": "arXiv"
            })
        return json.dumps(papers, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})


def fetch_arxiv_paper(paper_id: str) -> str:
    """Fetch full details of a specific arXiv paper by ID."""
    try:
        client = arxiv.Client()
        paper_id = paper_id.strip().replace("arXiv:","").replace("arxiv:","")
        search = arxiv.Search(id_list=[paper_id])
        results = list(client.results(search))
        if not results:
            return json.dumps({"error": f"Paper {paper_id} not found"})
        r = results[0]
        return json.dumps({
            "id": paper_id,
            "title": r.title,
            "authors": [a.name for a in r.authors],
            "abstract": r.summary,
            "published": str(r.published.date()),
            "year": r.published.year,
            "categories": r.categories,
            "doi": r.doi or "",
            "pdf_url": r.pdf_url,
            "journal_ref": r.journal_ref,
            "citations": None,
            "source": "arXiv"
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})
