"""Web search for the agent, through Tavily (https://tavily.com), with results trimmed for speech."""

import logging
import os
from urllib.parse import urlparse

import aiohttp

logger = logging.getLogger("avatar-agent")

TAVILY_URL = "https://api.tavily.com/search"
MAX_RESULTS = 4
SNIPPET_CHARS = 300


async def web(query: str) -> str:
    """Searches the web and returns a short answer plus the top sources, as plain text for the LLM."""
    key = os.environ.get("TAVILY_API_KEY")
    if not key:
        return "Web search isn't set up: there's no TAVILY_API_KEY."

    payload = {"query": query, "max_results": MAX_RESULTS, "search_depth": "basic", "include_answer": True}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as http:
            async with http.post(TAVILY_URL, json=payload, headers={"Authorization": f"Bearer {key}"}) as res:
                if res.status != 200:
                    return f"The search failed (HTTP {res.status})."
                data = await res.json()
    except (aiohttp.ClientError, TimeoutError) as err:
        logger.warning("web search failed: %s", err)
        return "The search failed: the search service didn't respond."

    lines = []
    if data.get("answer"):
        lines.append(f"Summary: {data['answer']}")
    for r in data.get("results", [])[:MAX_RESULTS]:
        source = urlparse(r.get("url", "")).netloc.removeprefix("www.")
        date = f", {r['published_date']}" if r.get("published_date") else ""
        snippet = " ".join((r.get("content") or "").split())[:SNIPPET_CHARS]
        lines.append(f"- {r.get('title', '')} ({source}{date}): {snippet}")
    logger.info("searched the web for %r: %d results", query, len(data.get("results", [])))
    return "\n".join(lines) or "The search found nothing."
