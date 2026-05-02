"""
main.py — FastAPI Backend for Multi-Document Research Assistant
Run: python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional
import os
import json
import requests as req_lib

from agent import ResearchAgent

app = FastAPI(title="Multi-Document Research Assistant", version="3.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.exists(frontend_path):
    app.mount("/static", StaticFiles(directory=frontend_path), name="static")

agent = ResearchAgent()


class ResearchQuery(BaseModel):
    query: str
    max_papers: Optional[int] = 5
    mode: Optional[str] = "full"
    sources: Optional[list] = None
    page: Optional[int] = 0
    seen_titles: Optional[list] = None
    session_id: Optional[str] = None   # passed back on page > 0 to append to same session


class FollowUpQuery(BaseModel):
    query: str
    session_id: str


@app.get("/")
async def serve_frontend():
    index_path = os.path.join(frontend_path, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"message": "Research Assistant API running. Frontend not found."}


@app.get("/health")
async def health_check():
    groq_ok   = agent.check_groq_connection()
    gemini_ok = agent.check_gemini_connection()
    return {
        "status": "ok",
        "ollama": groq_ok or gemini_ok,   # true if either LLM is available
        "groq": groq_ok,
        "gemini": gemini_ok,
        "active_llm": "Groq" if groq_ok else ("Gemini" if gemini_ok else "none"),
        "scopus": agent.check_scopus_connection(),
        "springer": agent.check_springer_connection(),
        "core": agent.check_core_connection(),
        "vector_store": "ready",
    }


@app.post("/research")
async def research(query: ResearchQuery):
    try:
        return await agent.run_research(
            query=query.query,
            max_papers=query.max_papers,
            mode=query.mode,
            selected_sources=query.sources,
            page=query.page or 0,
            seen_titles=query.seen_titles or [],
            existing_session_id=query.session_id,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/followup")
async def followup(query: FollowUpQuery):
    try:
        return await agent.followup(query=query.query, session_id=query.session_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/rrl-stream")
async def rrl_stream(query: FollowUpQuery):
    """
    Streaming endpoint for RRL generation.
    Streams Groq tokens directly to the browser as Server-Sent Events (SSE).
    This makes the RRL appear word-by-word instead of all at once after a delay.
    """
    session = agent.sessions.get(query.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    papers = session.get("papers", [])
    if not papers:
        raise HTTPException(status_code=400, detail="No papers in session")

    # Build a compact numbered paper index — maximizes papers that fit in context
    # while giving the AI enough info to cite each one correctly
    def build_rrl_context(papers):
        lines = [f"You have {len(papers)} papers. You MUST cite ALL of them in the RRL body and list ALL in References.\n"]
        for i, p in enumerate(papers, 1):
            authors = (p.get("authors") or [])
            if len(authors) == 1:
                apa_author = authors[0].split()[-1] if authors[0] else "Unknown"
            elif len(authors) == 2:
                a1 = authors[0].split()[-1] if authors[0] else ""
                a2 = authors[1].split()[-1] if authors[1] else ""
                apa_author = f"{a1} & {a2}"
            elif len(authors) >= 3:
                apa_author = (authors[0].split()[-1] if authors[0] else "Unknown") + " et al."
            else:
                apa_author = "Unknown"
            year = str(p.get("year") or p.get("published", "n.d."))[:4] or "n.d."
            title = (p.get("title") or "Untitled")[:100]
            journal = (p.get("journal") or p.get("publisher") or p.get("source") or "")[:60]
            doi = p.get("doi", "")
            abstract = (p.get("abstract") or "")[:300]
            cite_key = f"({apa_author}, {year})"
            lines.append(f"[{i}] CITE AS: {cite_key}")
            lines.append(f"    Title: {title}")
            if journal: lines.append(f"    Journal: {journal}")
            lines.append(f"    Year: {year}")
            if doi: lines.append(f"    DOI: {doi}")
            if authors: lines.append(f"    Authors: {'; '.join(authors[:5])}")
            if abstract: lines.append(f"    Abstract: {abstract}")
            lines.append("")
        return "\n".join(lines)

    papers_context = build_rrl_context(papers)

    system_prompt = (
        "You are an expert academic writing assistant producing a Review of Related Literature (RRL). "
        "CRITICAL RULES:\n"
        "1. You MUST cite ALL papers listed using their exact citation keys shown (e.g. (Smith et al., 2023))\n"
        "2. Every paragraph must contain at least one in-text citation\n"
        "3. The References section at the end must list ALL papers\n"
        "4. Do NOT skip any paper — every paper in the list must appear in both the body AND references\n"
        "5. APA 7 format for all citations and references"
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"=== PAPER LIST (cite ALL of these) ===\n{papers_context}\n\n=== TASK ===\n{query.query}"}
    ]

    # Load rotating key pool + better model for RRL
    from agent import _GROQ_KEYS, GROQ_MODEL_RRL
    groq_keys  = _GROQ_KEYS            # all available Groq keys
    groq_model = GROQ_MODEL_RRL        # llama-3.1-70b-versatile for RRL quality
    gemini_key = os.getenv("GEMINI_API_KEY", "")

    def generate_stream():
        """Try each Groq key in rotation, fall back to Gemini if all exhausted."""
        streamed_any = False

        # ── Try each Groq key in rotation ──────────────────────────────
        for attempt, g_key in enumerate(groq_keys):
            try:
                r = req_lib.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {g_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": groq_model,
                        "messages": messages,
                        "temperature": 0.2,
                        "max_tokens": 2500,
                        "stream": True,
                    },
                    stream=True,
                    timeout=90,
                )
                if r.status_code == 200:
                    for line in r.iter_lines():
                        if line:
                            line_str = line.decode("utf-8")
                            if line_str.startswith("data: "):
                                data_str = line_str[6:]
                                if data_str == "[DONE]":
                                    yield "data: [DONE]\n\n"
                                    streamed_any = True
                                    break
                                try:
                                    chunk = json.loads(data_str)
                                    delta = chunk["choices"][0]["delta"].get("content", "")
                                    if delta:
                                        _chunk = json.dumps({'text': delta})
                                        yield f"data: {_chunk}\n\n"
                                        streamed_any = True
                                except Exception:
                                    continue
                    if streamed_any:
                        return
                elif r.status_code == 429:
                    print(f"  [RRL] Groq key {attempt+1}/{len(groq_keys)} rate limited — trying next")
                    continue
                else:
                    print(f"  [RRL] Groq key {attempt+1} returned {r.status_code} — trying next")
                    continue
            except Exception as e:
                print(f"  [RRL] Groq key {attempt+1} error: {e} — trying next")
                continue

        # ── Gemini fallback (non-streaming) ────────────────────────────
        if gemini_key and gemini_key != "your_gemini_api_key_here":
            try:
                _msg = json.dumps({'text': '⏳ Groq busy — using Gemini...\n\n'})
                yield f"data: {_msg}\n\n"
                contents = []
                sys_text = ""
                for m in messages:
                    if m["role"] == "system":
                        sys_text = m["content"]
                    elif m["role"] == "user":
                        contents.append({"role": "user", "parts": [{"text": m["content"]}]})
                body = {
                    "contents": contents,
                    "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2500},
                }
                if sys_text:
                    body["systemInstruction"] = {"parts": [{"text": sys_text}]}
                gr = req_lib.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={gemini_key}",
                    headers={"Content-Type": "application/json"},
                    json=body, timeout=90,
                )
                if gr.status_code == 200:
                    text = gr.json()["candidates"][0]["content"]["parts"][0]["text"]
                    chunk_size = 8
                    words = text.split(" ")
                    for i in range(0, len(words), chunk_size):
                        chunk = " ".join(words[i:i+chunk_size])
                        if i + chunk_size < len(words):
                            chunk += " "
                        _c = json.dumps({'text': chunk})
                        yield f"data: {_c}\n\n"
                    yield "data: [DONE]\n\n"
                    return
            except Exception as e:
                _err_msg = json.dumps({'text': 'Error: ' + str(e)})
                yield f"data: {_err_msg}\n\n"

        _no_llm = json.dumps({'text': 'Error: No LLM available. Check API keys.'})
        yield f"data: {_no_llm}\n\n"
        yield "data: [DONE]\n\n"


    return StreamingResponse(
        generate_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        }
    )


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    session = agent.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.delete("/sessions/{session_id}")
async def clear_session(session_id: str):
    agent.clear_session(session_id)
    return {"message": "Session cleared"}
