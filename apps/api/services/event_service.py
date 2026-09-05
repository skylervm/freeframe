"""Redis-backed SSE event bus for cross-process real-time events."""
import json
from typing import AsyncGenerator, Awaitable, Callable
import redis.asyncio as aioredis
from ..config import settings

_pool = None


def _get_redis():
    global _pool
    if _pool is None:
        _pool = aioredis.ConnectionPool.from_url(settings.redis_url, decode_responses=True)
    return aioredis.Redis(connection_pool=_pool)


async def publish(project_id: str, event_type: str, payload: dict) -> None:
    """Publish an event to a Redis channel for the project."""
    r = _get_redis()
    message = json.dumps({"type": event_type, "payload": payload})
    await r.publish(f"project:{project_id}", message)


async def event_stream(project_id: str, is_authorized: Callable[[], Awaitable[bool]] | None = None) -> AsyncGenerator[str, None]:
    """Subscribe to a Redis channel and stop when the caller loses access."""
    r = _get_redis()
    pubsub = r.pubsub()
    await pubsub.subscribe(f"project:{project_id}")
    try:
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=15.0)
            if is_authorized and not await is_authorized():
                break
            if message and message["type"] == "message":
                try:
                    parsed = json.loads(message["data"])
                    event_type = parsed.get("type", "message")
                    payload = json.dumps(parsed.get("payload", parsed))
                    yield f"event: {event_type}\ndata: {payload}\n\n"
                except (json.JSONDecodeError, TypeError):
                    yield f"data: {message['data']}\n\n"
            else:
                yield ": keepalive\n\n"
    finally:
        await pubsub.unsubscribe(f"project:{project_id}")
        await pubsub.aclose()
