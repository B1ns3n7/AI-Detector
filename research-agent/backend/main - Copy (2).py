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
        "ollama": groq_ok or gemini_ok,
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


# ── UKDR UPLB PROXY ROUTE ────────────────────────────────────────────────────
# The browser cannot fetch ukdr.uplb.edu.ph directly due to CORS.
# This route acts as a same-origin proxy — the Python server fetches UKDR
# on behalf of the browser and returns the results as JSON.
@app.get("/ukdr-search")
async def ukdr_search(q: str, max: int = 10):
    try:
        from tools.ukdr_tool import search_ukdr
        import json
        papers = json.loads(search_ukdr(q, max_results=max))
        return {"papers": papers}
    except Exception as e:
        print(f"[UKDR route] error: {e}")
        return {"papers": [], "error": str(e)}
# ─────────────────────────────────────────────────────────────────────────────


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
    """
    session = agent.sessions.get(query.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    papers = session.get("papers", [])
    if not papers:
        raise HTTPException(status_code=400, detail="No papers in session")

    from agent import _format_papers_as_context
    papers_context = _format_papers_as_context(papers)

    system_prompt = (
        "You are an expert academic writing assistant. "
        "Write using ONLY the papers provided. "
        "Always include APA 7 in-text citations and a full References section at the end. "
        "Be precise with author names and years from the metadata."
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"=== PAPERS ===\n{papers_context}\n\n=== TASK ===\n{query.query}"}
    ]

    groq_key = os.getenv("GROQ_API_KEY", "")
    groq_model = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
    gemini_key = os.getenv("GEMINI_API_KEY", "")

    def generate_stream():
        streamed_any = False

        # ── Try Groq streaming ──────────────────────────────────────────
        if groq_key and groq_key != "your_groq_api_key_here":
            try:
                r = req_lib.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {groq_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": groq_model,
                        "messages": messages,
                        "temperature": 0.2,
                        "max_tokens": 1400,
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
                                        yield f"data: {json.dumps({'text': delta})}\n\n"
                                        streamed_any = True
                                except Exception:
                                    continue
                    if streamed_any:
                        return
            except Exception:
                pass

        # ── Gemini fallback (non-streaming) ─────────────────────────────
        if gemini_key and gemini_key != "your_gemini_api_key_here":
            try:
                yield f"data: {json.dumps({'text': '⏳ Groq busy — using Gemini...\n\n'})}\n\n"
                contents = []
                sys_text = ""
                for m in messages:
                    if m["role"] == "system":
                        sys_text = m["content"]
                    elif m["role"] == "user":
                        contents.append({"role": "user", "parts": [{"text": m["content"]}]})
                body = {
                    "contents": contents,
                    "generationConfig": {"temperature": 0.2, "maxOutputTokens": 1400},
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
                        yield f"data: {json.dumps({'text': chunk})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
            except Exception as e:
                yield f"data: {json.dumps({'text': f'Error: {str(e)}'})}\n\n"

        yield f"data: {json.dumps({'text': 'Error: No LLM available. Check API keys.'})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
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
