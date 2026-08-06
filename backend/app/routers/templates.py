"""模板目录路由：目录 + ETag 条件请求；按 revisionId 获取固定版本。"""

from __future__ import annotations

import json
from functools import lru_cache

from fastapi import APIRouter, HTTPException, Request, Response

from app.template_store import (
    _PUBLICATIONS_FILE,
    _REVISIONS_DIR,
    TemplateEntry,
    catalog_payload,
    load_template_catalog,
)

router = APIRouter(prefix="/api/v1/templates", tags=["templates"])

# must-revalidate 是紧急停用信号能生效的前提：没有它，
# 中间缓存可以在整整 300 秒里继续供应一个已被停用的模板（§5.3）。
_CACHE_CONTROL = "public, max-age=300, must-revalidate"


def _content_key() -> tuple[int, int]:
    """模板文件的修改时间。内容改了就换缓存键——否则紧急停用要等进程重启。"""
    revisions = [p.stat().st_mtime_ns for p in _REVISIONS_DIR.glob("*.json")]
    return (_PUBLICATIONS_FILE.stat().st_mtime_ns, max(revisions, default=0))


@lru_cache(maxsize=4)
def _catalog_for(_key: tuple[int, int]) -> tuple[list[TemplateEntry], str]:
    entries = load_template_catalog()
    return entries, catalog_payload(entries)["catalogVersion"]


def _catalog() -> tuple[list[TemplateEntry], str]:
    return _catalog_for(_content_key())


def _json(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def etag_matches(header: str | None, etag: str) -> bool:
    """按 RFC 9110 解析 If-None-Match。

    只做全等字符串比较是不够的：经 CDN 或反代改写成弱形式（W/"..."）之后，
    条件请求会永远不命中，304 退化成每次返回全量 catalog。
    """
    if not header:
        return False
    for candidate in header.split(","):
        token = candidate.strip()
        if token == "*":
            return True
        if token.startswith("W/"):
            token = token[2:]
        if token.strip('"') == etag:
            return True
    return False


@router.get("")
def list_templates(request: Request) -> Response:
    entries, etag = _catalog()
    if etag_matches(request.headers.get("if-none-match"), etag):
        return Response(
            status_code=304, headers={"ETag": f'"{etag}"', "Cache-Control": _CACHE_CONTROL}
        )
    return Response(
        content=_json(catalog_payload(entries)),
        media_type="application/json",
        headers={"ETag": f'"{etag}"', "Cache-Control": _CACHE_CONTROL},
    )


def _template_response(entry: TemplateEntry) -> Response:
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


@router.get("/{template_id}/versions/{version}")
def get_template_version(template_id: str, version: int) -> Response:
    """§6.1 规定的固定版本端点。"""
    entries, _ = _catalog()
    for entry in entries:
        if entry.revision["id"] == template_id and entry.revision["version"] == version:
            return _template_response(entry)
    raise HTTPException(status_code=404, detail="TEMPLATE_NOT_FOUND")


@router.get("/{revision_id}")
def get_template(revision_id: str) -> Response:
    """按 revisionId 取固定版本（保留为兼容别名）。"""
    entries, _ = _catalog()
    for entry in entries:
        if entry.revision["revisionId"] == revision_id:
            return _template_response(entry)
    raise HTTPException(status_code=404, detail="TEMPLATE_NOT_FOUND")
