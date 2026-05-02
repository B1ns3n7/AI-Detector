"""
tools/summarizer.py — Paper Summarization using Groq API
"""

import requests
import json
import os
from dotenv import load_dotenv

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama3-8b-8192")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"


def _call_groq(prompt: str) -> str:
    if not GROQ_API_KEY or GROQ_API_KEY == "your_groq_api_key_here":
        return "Error: Groq API key not set in .env file."
    try:
        r = requests.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": GROQ_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "max_tokens": 512,
            },
            timeout=60
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]
    except Exception as e:
        return f"Error: {str(e)}"


def summarize_paper(text: str) -> str:
    """Summarize a paper abstract or text."""
    prompt = f"""Summarize this academic paper in 3-4 concise sentences.
Focus on: main contribution, methodology, key findings, and significance.

Paper:
{text[:2000]}

Summary:"""
    return _call_groq(prompt)


def compare_papers(papers_json: str) -> str:
    """Compare multiple papers."""
    try:
        papers = json.loads(papers_json) if isinstance(papers_json, str) else papers_json
        papers_text = "\n\n".join([
            f"Paper {i+1}: {p.get('title', 'Unknown')}\n{p.get('abstract', '')[:400]}"
            for i, p in enumerate(papers[:5])
        ])
        prompt = f"""Compare these papers and provide:
1. Common themes
2. Key differences
3. Research gaps
4. Most significant contributions

Papers:
{papers_text}

Analysis:"""
        return _call_groq(prompt)
    except Exception as e:
        return f"Error: {str(e)}"