"""
main.py — FastAPI Backend for Multi-Document Research Assistant
Run: python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
import os

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
