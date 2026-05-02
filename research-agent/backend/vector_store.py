"""
vector_store.py — Simple in-memory paper store (no blocking model load)
Falls back gracefully if sentence-transformers is unavailable.
"""
import json
import hashlib


class VectorStore:
    def __init__(self, persist_dir: str = "./chroma_db"):
        # Simple in-memory store — no blocking downloads, no ChromaDB issues
        self._store: dict = {}  # session_id -> list of {text, title, paper}
        print("VectorStore ready (in-memory).")

    def add_paper(self, paper: dict, session_id: str):
        try:
            if session_id not in self._store:
                self._store[session_id] = []
            text = f"{paper.get('title', '')} {paper.get('abstract', '')}"
            self._store[session_id].append({
                "text": text,
                "title": paper.get("title", ""),
                "paper": paper
            })
        except Exception as e:
            print(f"VectorStore add error: {e}")

    def search(self, query: str, session_id: str, top_k: int = 5) -> list:
        """Simple keyword search — no embeddings needed."""
        try:
            docs = self._store.get(session_id, [])
            q = query.lower()
            scored = []
            for doc in docs:
                score = sum(1 for word in q.split() if word in doc["text"].lower())
                scored.append((score, doc))
            scored.sort(key=lambda x: x[0], reverse=True)
            return [d for _, d in scored[:top_k]]
        except Exception as e:
            print(f"VectorStore search error: {e}")
            return []

    def clear_session(self, session_id: str):
        self._store.pop(session_id, None)
