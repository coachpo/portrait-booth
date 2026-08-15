"""Template catalog loading and validation: reads the templates/ directory,
validates against versioned JSON Schemas, computes revision content hashes,
merges mutable publications, and enforces publication composition rules."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

import jsonschema

# Source layout: backend/app/template_store.py -> parents[2] is the repository
# root. The container layout is NOT the same - the image puts the code at
# /app/app and the templates at /app/templates, so parents[2] resolves to "/"
# and the catalog would be looked up in a nonexistent /templates, failing every
# template request with a 500 while /api/v1/health still reports healthy.
# PORTRAIT_TEMPLATES_DIR pins the directory for such deployments; the Dockerfile
# sets it alongside the other path variables.
_DEFAULT_TEMPLATES_DIR = Path(__file__).resolve().parents[2] / "templates"

_UNSPECIFIED = object()


def templates_dir() -> Path:
    """Templates root. Read per call rather than frozen at import, matching
    config.get_settings, so tests can point it at a fixture directory."""
    raw = os.environ.get("PORTRAIT_TEMPLATES_DIR", "").strip()
    return Path(raw) if raw else _DEFAULT_TEMPLATES_DIR


def default_revisions_dir() -> Path:
    return templates_dir() / "revisions"


def default_publications_file() -> Path:
    return templates_dir() / "publications.json"


@dataclass(frozen=True)
class TemplateEntry:
    revision: dict
    contentHash: str
    publication: dict


def _load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object")
    return data


def _content_hash(revision: dict) -> str:
    canonical = json.dumps(revision, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _schema_for(schema_version: int) -> dict:
    schema_file = templates_dir() / "schema" / f"template-revision-v{schema_version}.schema.json"
    return _load_json(schema_file)


PUBLICATION_STATUSES = ("active", "reference_only", "deprecated", "unsupported")


def _validate_references(revision: dict) -> None:
    """Reference integrity: once EDT-008 masks shipped, a broken reference
    shows up as "silently not drawn", which is extremely hard to diagnose."""
    revision_id = revision.get("revisionId")
    source_ids = {s.get("id") for s in revision.get("sources", [])}

    rule_ids: set[str] = set()
    for rule in list(revision.get("cropRules", [])) + list(revision.get("captureRules", [])):
        rule_id = rule.get("id")
        if rule_id in rule_ids:
            raise ValueError(f"{revision_id}: duplicate rule id {rule_id}")
        rule_ids.add(rule_id)
        for ref in rule.get("sourceRefs", []):
            if ref not in source_ids:
                raise ValueError(
                    f"{revision_id}: rule {rule_id} sourceRefs {ref} is not in sources"
                )

    crop_by_id = {r.get("id"): r for r in revision.get("cropRules", [])}
    for ref in revision.get("overlay", {}).get("ruleIds", []):
        rule = crop_by_id.get(ref)
        if rule is None:
            raise ValueError(f"{revision_id}: overlay.ruleIds {ref} is not in cropRules")
        # Pose-angle rules have no output-pixel coordinates and cannot draw a mask
        if rule.get("coordinateSpace") == "pose_camera_degrees":
            raise ValueError(
                f"{revision_id}: overlay cannot reference pose_camera_degrees rule {ref}"
            )


def _validate_publication_rules(revision: dict, publication: dict) -> None:
    """SPEC §5.1 publication composition rules: active templates must be able to
    output the MVP-supported JPEG."""
    status = publication.get("status")
    if status not in PUBLICATION_STATUSES:
        # Early return equals allow: an unknown status must fail loading, not
        # be treated as "nothing to check"
        raise ValueError(f"{revision.get('revisionId')}: unknown publication status {status!r}")
    if status not in ("active", "reference_only"):
        return
    output_kind = revision.get("output", {}).get("kind")
    if status == "active":
        if output_kind in ("portal_source", "guidance_only"):
            raise ValueError(f"{revision['revisionId']} active template must not use {output_kind}")
        if not revision.get("outputFile"):
            raise ValueError(f"{revision['revisionId']} active template must have an outputFile")
    if revision.get("documentType") != "portrait":
        size_limit = revision.get("outputFile", {}).get("sizeLimit")
        if size_limit and size_limit.get("normalization") == "unresolved":
            raise ValueError(
                f"{revision['revisionId']} unresolved byte threshold must not be activated"
            )


def load_template_catalog(
    revisions_dir: Path | None = None,
    publications_file: Path | None = None,
) -> list[TemplateEntry]:
    root = templates_dir()
    revisions_dir = revisions_dir or root / "revisions"
    publications_file = publications_file or root / "publications.json"

    publications: dict[str, dict] = {}
    pubs = _load_json(publications_file)
    jsonschema.validate(pubs, _load_json(root / "schema" / "template-publication-v1.schema.json"))
    for pub in pubs.get("publications", []):
        publications[pub["revisionId"]] = pub

    entries: list[TemplateEntry] = []
    for path in sorted(revisions_dir.glob("*.json")):
        revision = _load_json(path)
        revision_id = revision.get("revisionId")
        expected_id = f"{revision.get('id')}@{revision.get('version')}"
        if revision_id != expected_id:
            raise ValueError(f"{path.name}: revisionId must be {expected_id}")
        publication = publications.get(revision_id)
        if publication is None:
            raise ValueError(f"{path.name}: missing publication record for {revision_id}")
        if publication.get("revisionId") != revision_id:
            raise ValueError(f"{path.name}: publication and revisionId do not match")

        schema = _schema_for(revision.get("schemaVersion", _UNSPECIFIED))
        jsonschema.validate(revision, schema)
        _validate_references(revision)
        _validate_publication_rules(revision, publication)

        content_hash = _content_hash(revision)
        declared = publication.get("contentHash")
        if declared is not None and declared != content_hash:
            raise ValueError(
                f"{path.name}: publication.contentHash does not match the revision "
                f"content - was the revision edited in place without bumping version? "
                f"expected {content_hash}, declared {declared}"
            )

        entries.append(
            TemplateEntry(
                revision=revision,
                contentHash=content_hash,
                publication=publication,
            )
        )
    if not entries:
        raise ValueError("template directory is empty")
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
