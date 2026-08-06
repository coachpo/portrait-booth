"""模板目录加载与校验：读取 templates/ 目录，按版本化 JSON Schema 校验，
计算 revision 内容哈希，合并可变 publication，执行发布组合规则。"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import jsonschema

_SCHEMA_PATH = Path(__file__).resolve().parents[2] / "templates" / "schema"
_REVISIONS_DIR = Path(__file__).resolve().parents[2] / "templates" / "revisions"
_PUBLICATIONS_FILE = Path(__file__).resolve().parents[2] / "templates" / "publications.json"

_UNSPECIFIED = object()


@dataclass(frozen=True)
class TemplateEntry:
    revision: dict
    contentHash: str
    publication: dict


def _load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path} 不是 JSON 对象")
    return data


def _content_hash(revision: dict) -> str:
    canonical = json.dumps(revision, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _schema_for(schema_version: int) -> dict:
    schema_file = _SCHEMA_PATH / f"template-revision-v{schema_version}.schema.json"
    return _load_json(schema_file)


def _validate_publication_rules(revision: dict, publication: dict) -> None:
    """SPEC §5.1 发布组合规则：active 模板必须可输出 MVP 支持的 JPEG。"""
    status = publication.get("status")
    if status not in ("active", "reference_only"):
        return
    output_kind = revision.get("output", {}).get("kind")
    if status == "active":
        if output_kind in ("portal_source", "guidance_only"):
            raise ValueError(f"{revision['revisionId']} active 模板不得使用 {output_kind}")
        if not revision.get("outputFile"):
            raise ValueError(f"{revision['revisionId']} active 模板必须具有 outputFile")
    if revision.get("documentType") != "portrait":
        size_limit = revision.get("outputFile", {}).get("sizeLimit")
        if size_limit and size_limit.get("normalization") == "unresolved":
            raise ValueError(f"{revision['revisionId']} unresolved 字节阈值不得激活")


def load_template_catalog(
    revisions_dir: Path | None = None,
    publications_file: Path | None = None,
) -> list[TemplateEntry]:
    revisions_dir = revisions_dir or _REVISIONS_DIR
    publications_file = publications_file or _PUBLICATIONS_FILE

    publications: dict[str, dict] = {}
    pubs = _load_json(publications_file)
    for pub in pubs.get("publications", []):
        publications[pub["revisionId"]] = pub

    entries: list[TemplateEntry] = []
    for path in sorted(revisions_dir.glob("*.json")):
        revision = _load_json(path)
        revision_id = revision.get("revisionId")
        expected_id = f"{revision.get('id')}@{revision.get('version')}"
        if revision_id != expected_id:
            raise ValueError(f"{path.name}: revisionId 必须为 {expected_id}")
        publication = publications.get(revision_id)
        if publication is None:
            raise ValueError(f"{path.name}: 缺少 publication 记录 {revision_id}")
        if publication.get("revisionId") != revision_id:
            raise ValueError(f"{path.name}: publication 与 revisionId 不匹配")

        schema = _schema_for(revision.get("schemaVersion", _UNSPECIFIED))
        jsonschema.validate(revision, schema)
        _validate_publication_rules(revision, publication)

        entries.append(
            TemplateEntry(
                revision=revision,
                contentHash=_content_hash(revision),
                publication=publication,
            )
        )
    if not entries:
        raise ValueError("模板目录为空")
    return entries


def catalog_etag(entries: list[TemplateEntry]) -> str:
    joint = "\n".join(
        f"{e.revision['revisionId']}:{e.contentHash}:{e.publication.get('publicationRevision')}"
        for e in sorted(entries, key=lambda e: e.revision["revisionId"])
    )
    return hashlib.sha256(joint.encode("utf-8")).hexdigest()


def catalog_payload(entries: list[TemplateEntry]) -> dict:
    return {
        "schemaVersion": 1,
        "catalogVersion": catalog_etag(entries),
        "templates": [
            {
                "revision": e.revision,
                "contentHash": e.contentHash,
                "publication": e.publication,
            }
            for e in sorted(entries, key=lambda e: e.revision["revisionId"])
        ],
    }
