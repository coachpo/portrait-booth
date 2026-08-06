"""模板内容门（C13）：引用完整性、contentHash 绑定与工具链。"""

import copy
import json

import jsonschema
import pytest

from app import template_tools
from app.template_store import _content_hash, load_template_catalog


@pytest.fixture()
def template_dir(tmp_path):
    """把仓库里的真实模板复制一份，供各用例破坏后验证门禁。"""
    from app.template_store import _PUBLICATIONS_FILE, _REVISIONS_DIR

    revisions = tmp_path / "revisions"
    revisions.mkdir()
    for path in _REVISIONS_DIR.glob("*.json"):
        (revisions / path.name).write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    publications = tmp_path / "publications.json"
    publications.write_text(_PUBLICATIONS_FILE.read_text(encoding="utf-8"), encoding="utf-8")
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
        # 坏引用在 EDT-008 上线后只表现为「蒙版静默不画」
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
        with pytest.raises(ValueError, match="重复"):
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
        # 早退等于放行：未知状态曾被当成「不用检查」
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
        assert "模板校验通过" in capsys.readouterr().out

    def test_report_lists_every_template(self, capsys):
        assert template_tools.main(["report"]) == 0
        out = capsys.readouterr().out
        assert "fi-police-digital@1" in out
        assert "reviewDueAt" in out
