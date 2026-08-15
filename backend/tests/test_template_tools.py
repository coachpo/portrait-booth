"""Template content gate (C13): reference integrity, contentHash binding, and
the toolchain."""

import copy
import json

import jsonschema
import pytest

from app import template_tools
from app.template_store import _content_hash, load_template_catalog


@pytest.fixture()
def template_dir(tmp_path):
    """Copy the repository's real templates so each case can break them and
    verify the gate."""
    from app.template_store import default_publications_file, default_revisions_dir

    revisions = tmp_path / "revisions"
    revisions.mkdir()
    for path in default_revisions_dir().glob("*.json"):
        (revisions / path.name).write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    publications = tmp_path / "publications.json"
    publications.write_text(
        default_publications_file().read_text(encoding="utf-8"), encoding="utf-8"
    )
    return revisions, publications


def _load(revisions, publications):
    return load_template_catalog(revisions_dir=revisions, publications_file=publications)


def _rewrite(path, mutate):
    data = json.loads(path.read_text(encoding="utf-8"))
    mutate(data)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


class TestReferenceIntegrity:
    def test_repository_templates_load_cleanly(self, template_dir):
        entries = _load(*template_dir)
        assert len(entries) >= 6

    def test_rejects_an_overlay_pointing_at_a_missing_rule(self, template_dir):
        revisions, publications = template_dir
        target = revisions / "fi-police-digital@1.json"
        _rewrite(target, lambda d: d["overlay"]["ruleIds"].append("no-such-rule"))
        # A broken reference only shows up as "mask silently not drawn" once
        # EDT-008 is live
        with pytest.raises(ValueError, match="overlay.ruleIds"):
            _load(revisions, publications)

    def test_rejects_a_source_ref_that_does_not_exist(self, template_dir):
        revisions, publications = template_dir
        target = revisions / "fi-police-digital@1.json"
        _rewrite(target, lambda d: d["cropRules"][0]["sourceRefs"].append("ghost-source"))
        with pytest.raises(ValueError, match="sourceRefs"):
            _load(revisions, publications)

    def test_rejects_duplicate_rule_ids(self, template_dir):
        revisions, publications = template_dir
        target = revisions / "fi-police-digital@1.json"
        _rewrite(target, lambda d: d["cropRules"].append(copy.deepcopy(d["cropRules"][0])))
        with pytest.raises(ValueError, match="duplicate rule id"):
            _load(revisions, publications)


class TestContentHashBinding:
    def test_detects_a_revision_edited_without_a_version_bump(self, template_dir):
        revisions, publications = template_dir
        target = revisions / "fi-police-digital@1.json"
        _rewrite(target, lambda d: d["cropRules"][0].__setitem__("min", 1))
        with pytest.raises(ValueError, match="contentHash"):
            _load(revisions, publications)

    def test_accepts_a_matching_hash(self, template_dir):
        revisions, publications = template_dir
        entries = _load(revisions, publications)
        for entry in entries:
            assert entry.publication["contentHash"] == _content_hash(entry.revision)


class TestPublicationSchema:
    def test_rejects_an_unknown_status(self, template_dir):
        revisions, publications = template_dir
        # Early return equals allow: an unknown status used to be treated as
        # "nothing to check"
        _rewrite(
            publications,
            lambda d: d["publications"][0].__setitem__("status", "experimental"),
        )
        with pytest.raises(Exception, match="experimental|status"):
            _load(revisions, publications)

    def test_rejects_a_missing_required_field(self, template_dir):
        revisions, publications = template_dir
        _rewrite(publications, lambda d: d["publications"][0].pop("reviewer"))
        with pytest.raises(jsonschema.ValidationError, match="reviewer"):
            _load(revisions, publications)


class TestCli:
    def test_validate_passes_on_the_repository(self, capsys):
        assert template_tools.main(["validate"]) == 0
        assert "template validation passed" in capsys.readouterr().out

    def test_report_lists_every_template(self, capsys):
        assert template_tools.main(["report"]) == 0
        out = capsys.readouterr().out
        assert "fi-police-digital@1" in out
        assert "reviewDueAt" in out
