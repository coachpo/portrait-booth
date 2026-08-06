import copy
import json

import jsonschema
import pytest

from app.template_store import (
    _content_hash,
    catalog_etag,
    catalog_payload,
    load_template_catalog,
)

MINIMAL_REVISION = {
    "revisionId": "test@1",
    "id": "test",
    "version": 1,
    "schemaVersion": 1,
    "label": {"zh": "测试模板"},
    "jurisdiction": "XX",
    "documentType": "portrait",
    "submissionChannel": "digital_upload",
    "applicantClass": "adult",
    "sources": [
        {
            "id": "s1",
            "url": "https://example.com/spec",
            "title": "官方规格",
            "authority": "测试机构",
            "accessedAt": "2026-08-06",
        }
    ],
    "output": {
        "kind": "exact_pixels",
        "widthPx": 100,
        "heightPx": 100,
        "aspect": {
            "width": 1,
            "height": 1,
            "enforcement": "mandatory",
            "provenance": "derived",
        },
    },
    "outputFile": {"mime": ["image/jpeg"]},
    "cropRules": [],
    "captureRules": [],
    "overlay": {"kind": "none", "ruleIds": []},
    "capabilities": {
        "selfCapture": "allowed",
        "crop": "allowed",
        "rotate": "allowed",
        "mirror": "warn",
        "retouch": "forbidden",
        "backgroundReplace": "forbidden",
        "requiresOriginalCameraFile": False,
        "requiresProfessionalPhotographer": False,
    },
    "sourceNotes": {"zh": []},
}

MINIMAL_PUBLICATION = {
    "revisionId": "test@1",
    "status": "active",
    "statusReason": "测试",
    "owner": "测试维护",
    "reviewer": "测试复核",
    "verifiedAt": "2026-08-06",
    "reviewDueAt": "2026-11-04",
    "effectiveAt": "2026-08-06",
    "publicationRevision": 1,
}


def write_catalog(tmp_path, revisions, publications):
    (tmp_path / "revisions").mkdir(exist_ok=True)
    for revision in revisions:
        path = tmp_path / "revisions" / f"{revision['revisionId']}.json"
        path.write_text(json.dumps(revision, ensure_ascii=False), encoding="utf-8")
    pubs_file = tmp_path / "publications.json"
    pubs_file.write_text(
        json.dumps({"schemaVersion": 1, "publications": publications}, ensure_ascii=False),
        encoding="utf-8",
    )
    return tmp_path


def test_loads_real_catalog(tmp_path):
    entries = load_template_catalog()
    assert len(entries) == 6
    assert [e.revision["revisionId"] for e in entries] == sorted(
        e.revision["revisionId"] for e in entries
    )
    assert all(e.revision["schemaVersion"] == 1 for e in entries)
    active = {e.revision["id"] for e in entries if e.publication["status"] == "active"}
    assert active == {"generic-portrait-square", "us-visa-digital", "fi-police-digital"}
    reference_only = {
        e.revision["id"] for e in entries if e.publication["status"] == "reference_only"
    }
    assert reference_only == {"us-passport-paper", "cn-visa-digital-ma-rabat", "jp-passport-paper"}


def test_content_hash_is_stable_and_sensitive(tmp_path):
    assert _content_hash(MINIMAL_REVISION) == _content_hash(MINIMAL_REVISION)
    mutated = copy.deepcopy(MINIMAL_REVISION)
    mutated["version"] = 2
    assert _content_hash(mutated) != _content_hash(MINIMAL_REVISION)


def test_catalog_etag_changes_with_revision_and_publication(tmp_path):
    tmp = write_catalog(tmp_path, revisions=[MINIMAL_REVISION], publications=[MINIMAL_PUBLICATION])
    entries = load_template_catalog(tmp / "revisions", tmp / "publications.json")
    first = catalog_etag(entries)

    new_pub = copy.deepcopy(MINIMAL_PUBLICATION)
    new_pub["publicationRevision"] = 2
    tmp = write_catalog(tmp_path=tmp, revisions=[MINIMAL_REVISION], publications=[new_pub])
    entries = load_template_catalog(tmp / "revisions", tmp / "publications.json")
    assert catalog_etag(entries) != first

    new_rev = copy.deepcopy(MINIMAL_REVISION)
    new_rev["label"] = {"zh": "改了"}
    tmp = write_catalog(tmp_path=tmp, revisions=[new_rev], publications=[MINIMAL_PUBLICATION])
    entries = load_template_catalog(tmp / "revisions", tmp / "publications.json")
    assert catalog_etag(entries) != first


def test_payload_merges_revision_hash_publication(tmp_path):
    tmp = write_catalog(tmp_path, revisions=[MINIMAL_REVISION], publications=[MINIMAL_PUBLICATION])
    payload = catalog_payload(load_template_catalog(tmp / "revisions", tmp / "publications.json"))
    assert payload["schemaVersion"] == 1
    assert payload["catalogVersion"] == catalog_etag(
        load_template_catalog(tmp / "revisions", tmp / "publications.json")
    )
    (entry,) = payload["templates"]
    assert entry["revision"]["revisionId"] == "test@1"
    assert entry["contentHash"] == _content_hash(MINIMAL_REVISION)
    assert entry["publication"]["status"] == "active"


def test_rejects_revision_id_mismatch(tmp_path):
    bad = copy.deepcopy(MINIMAL_REVISION)
    bad["revisionId"] = "other@1"
    tmp = write_catalog(tmp_path, revisions=[bad], publications=[MINIMAL_PUBLICATION])
    with pytest.raises(ValueError, match="revisionId"):
        load_template_catalog(tmp / "revisions", tmp / "publications.json")


def test_rejects_missing_publication(tmp_path):
    tmp = write_catalog(tmp_path, revisions=[MINIMAL_REVISION], publications=[])
    with pytest.raises(ValueError, match="缺少 publication"):
        load_template_catalog(tmp / "revisions", tmp / "publications.json")


def test_rejects_schema_violation(tmp_path):
    bad = copy.deepcopy(MINIMAL_REVISION)
    bad["output"] = {"kind": "exact_pixels", "widthPx": 100, "heightPx": 100}
    tmp = write_catalog(tmp_path, revisions=[bad], publications=[MINIMAL_PUBLICATION])
    with pytest.raises(jsonschema.ValidationError):
        load_template_catalog(tmp / "revisions", tmp / "publications.json")


def test_rejects_unknown_schema_version(tmp_path):
    bad = copy.deepcopy(MINIMAL_REVISION)
    bad["schemaVersion"] = 99
    tmp = write_catalog(tmp_path, revisions=[bad], publications=[MINIMAL_PUBLICATION])
    with pytest.raises((jsonschema.ValidationError, FileNotFoundError)):
        load_template_catalog(tmp / "revisions", tmp / "publications.json")


def test_rejects_active_portal_source(tmp_path):
    bad = copy.deepcopy(MINIMAL_REVISION)
    del bad["output"]
    bad["output"] = {"kind": "portal_source", "officialPortalPerformsCrop": True}
    del bad["outputFile"]
    tmp = write_catalog(tmp_path, revisions=[bad], publications=[MINIMAL_PUBLICATION])
    with pytest.raises(ValueError, match="active 模板不得使用 portal_source"):
        load_template_catalog(tmp / "revisions", tmp / "publications.json")


def test_rejects_active_without_output_file(tmp_path):
    bad = copy.deepcopy(MINIMAL_REVISION)
    del bad["outputFile"]
    tmp = write_catalog(tmp_path, revisions=[bad], publications=[MINIMAL_PUBLICATION])
    with pytest.raises(ValueError, match="active 模板必须具有 outputFile"):
        load_template_catalog(tmp / "revisions", tmp / "publications.json")


def test_rejects_unresolved_size_limit_on_non_portrait(tmp_path):
    bad = copy.deepcopy(MINIMAL_REVISION)
    bad["documentType"] = "visa"
    bad["outputFile"] = {
        "mime": ["image/jpeg"],
        "sizeLimit": {"sourceLiteral": "未知", "normalization": "unresolved"},
    }
    tmp = write_catalog(tmp_path, revisions=[bad], publications=[MINIMAL_PUBLICATION])
    with pytest.raises(ValueError, match="unresolved"):
        load_template_catalog(tmp / "revisions", tmp / "publications.json")


def test_allows_reference_only_portal_source(tmp_path):
    rev = copy.deepcopy(MINIMAL_REVISION)
    rev["output"] = {"kind": "portal_source", "officialPortalPerformsCrop": True}
    del rev["outputFile"]
    pub = copy.deepcopy(MINIMAL_PUBLICATION)
    pub["status"] = "reference_only"
    tmp = write_catalog(tmp_path, revisions=[rev], publications=[pub])
    entries = load_template_catalog(tmp / "revisions", tmp / "publications.json")
    assert entries[0].publication["status"] == "reference_only"
