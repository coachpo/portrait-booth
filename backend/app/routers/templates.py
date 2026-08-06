"""模板目录路由：目录 + ETag 条件请求；按 revisionId 获取固定版本。"""

from __future__ import annotations

import json
from functools import lru_cache

from fastapi import APIRouter, HTTPException, Request, Response

from app.template_store import TemplateEntry, catalog_payload, load_template_catalog

router = APIRouter(prefix="/api/v1/templates", tags=["templates"])

_CACHE_CONTROL = "public, max-age=300"


@lru_cache(maxsize=1)
def _catalog() -> tuple[list[TemplateEntry], str]:
    entries = load_template_catalog()
    return entries, catalog_payload(entries)["catalogVersion"]


def _json(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


@router.get("")
def list_templates(request: Request) -> Response:
    entries, etag = _catalog()
    if request.headers.get("if-none-match") == f'"{etag}"':
        return Response(status_code=304, headers={"ETag": f'"{etag}"'})
    return Response(
        content=_json(catalog_payload(entries)),
        media_type="application/json",
        headers={"ETag": f'"{etag}"', "Cache-Control": _CACHE_CONTROL},
    )


@router.get("/{revision_id}")
def get_template(revision_id: str) -> Response:
    entries, _ = _catalog()
    for entry in entries:
        if entry.revision["revisionId"] == revision_id:
            return Response(
                content=_json(
                    {
                        "revision": entry.revision,
                        "contentHash": entry.contentHash,
                        "publication": entry.publication,
                    }
                ),
                media_type="application/json",
                headers={"Cache-Control": _CACHE_CONTROL},
            )
    raise HTTPException(status_code=404, detail="TEMPLATE_NOT_FOUND")
