"""模板内容工具链（SPEC §5.3）。

用法：
    python -m app.template_tools validate    # schema + 发布规则 + 引用完整性 + 内容哈希
    python -m app.template_tools rehash      # 把当前 revision 哈希写回 publications.json
    python -m app.template_tools report      # 列出状态、复核日期与距 SLA 的天数
    python -m app.template_tools new --id x --jurisdiction US ...   # 生成 revision 骨架

validate 是 CI 的内容门：坏引用与漂移的 contentHash 在运行期只会表现为
「蒙版静默不画」或「模板被就地改了数字却没人发现」。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from .template_store import (
    _PUBLICATIONS_FILE,
    _REVISIONS_DIR,
    _content_hash,
    load_template_catalog,
)

REVIEW_SLA_DAYS = 90


def _read(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _write(path: Path, data: dict) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def cmd_validate(_args: argparse.Namespace) -> int:
    try:
        entries = load_template_catalog()
    except Exception as exc:  # 输出可读定位，不打印堆栈
        print(f"模板校验失败：{exc}", file=sys.stderr)
        return 1

    missing_hash = [
        e.revision["revisionId"] for e in entries if e.publication.get("contentHash") is None
    ]
    if missing_hash:
        print(
            "以下 publication 缺少 contentHash，revision 可被就地修改而不被发现："
            + ", ".join(sorted(missing_hash)),
            file=sys.stderr,
        )
        return 1

    print(f"模板校验通过：{len(entries)} 个 revision")
    return 0


def cmd_rehash(_args: argparse.Namespace) -> int:
    pubs = _read(_PUBLICATIONS_FILE)
    hashes = {}
    for path in sorted(_REVISIONS_DIR.glob("*.json")):
        revision = _read(path)
        hashes[revision["revisionId"]] = _content_hash(revision)

    changed = 0
    for pub in pubs["publications"]:
        expected = hashes.get(pub["revisionId"])
        if expected is None:
            print(f"publication {pub['revisionId']} 没有对应的 revision 文件", file=sys.stderr)
            return 1
        if pub.get("contentHash") != expected:
            pub["contentHash"] = expected
            changed += 1
    _write(_PUBLICATIONS_FILE, pubs)
    print(f"已更新 {changed} 条 contentHash")
    return 0


def cmd_report(_args: argparse.Namespace) -> int:
    entries = load_template_catalog()
    today = dt.date.today()
    rows = []
    for entry in sorted(entries, key=lambda e: e.publication.get("reviewDueAt", "")):
        pub = entry.publication
        due = dt.date.fromisoformat(pub["reviewDueAt"])
        rows.append(
            (
                entry.revision["revisionId"],
                pub["status"],
                pub["verifiedAt"],
                pub["reviewDueAt"],
                (due - today).days,
            )
        )
    width = max(len(r[0]) for r in rows)
    print(f"{'revisionId'.ljust(width)}  status          verifiedAt   reviewDueAt  剩余天数")
    for revision_id, status, verified, due, days in rows:
        flag = "  ← 已逾期" if days < 0 else ""
        print(
            f"{revision_id.ljust(width)}  {status.ljust(15)} {verified}   {due}   {days:>6}{flag}"
        )
    overdue = [r for r in rows if r[4] < 0]
    if overdue:
        print(f"\n{len(overdue)} 个模板已过复核期（SLA {REVIEW_SLA_DAYS} 天）", file=sys.stderr)
        return 1
    return 0


def cmd_new(args: argparse.Namespace) -> int:
    revision_id = f"{args.id}@{args.version}"
    path = _REVISIONS_DIR / f"{revision_id}.json"
    if path.exists():
        print(f"{path.name} 已存在", file=sys.stderr)
        return 1

    today = dt.date.today().isoformat()
    skeleton = {
        "revisionId": revision_id,
        "id": args.id,
        "version": args.version,
        "schemaVersion": 1,
        "label": {"zh": args.label, "en": args.label},
        "jurisdiction": args.jurisdiction,
        "documentType": args.document_type,
        "submissionChannel": args.channel,
        "applicantClass": "adult",
        "sources": [
            {
                "id": "official-source",
                "url": "https://example.invalid/replace-me",
                "title": "官方来源标题",
                "authority": "签发机关",
                "sourceUpdatedAt": today,
                "accessedAt": today,
            }
        ],
        "output": _output_skeleton(args.output_kind),
        "cropRules": [],
        "captureRules": [],
        "overlay": {"kind": "none", "ruleIds": []},
        "capabilities": {
            "selfCapture": "allowed",
            "crop": "allowed",
            "rotate": "allowed",
            "mirror": "forbidden",
            "retouch": "forbidden",
            "backgroundReplace": "forbidden",
            "requiresOriginalCameraFile": False,
            "requiresProfessionalPhotographer": False,
        },
        "sourceNotes": {"zh": ["待补充"], "en": ["To be filled in"]},
    }
    _write(path, skeleton)

    pubs = _read(_PUBLICATIONS_FILE)
    pubs["publications"].append(
        {
            "revisionId": revision_id,
            # 新模板一律 reference_only：没有复核记录之前不得用于产出成品
            "status": "reference_only",
            "statusReason": "新建骨架，尚未完成来源核对与复核。",
            "owner": "Portrait Booth 内容维护",
            "reviewer": "Portrait Booth 内容复核",
            "verifiedAt": today,
            "reviewDueAt": (dt.date.today() + dt.timedelta(days=REVIEW_SLA_DAYS)).isoformat(),
            "effectiveAt": today,
            "publicationRevision": 1,
        }
    )
    _write(_PUBLICATIONS_FILE, pubs)
    print(f"已生成 {path.name}，随后运行 rehash 写入 contentHash")
    return 0


def _output_skeleton(kind: str) -> dict:
    if kind == "exact_pixels":
        return {
            "kind": "exact_pixels",
            "widthPx": 600,
            "heightPx": 600,
            "aspect": {
                "width": 1,
                "height": 1,
                "enforcement": "mandatory",
                "provenance": "derived",
            },
        }
    if kind == "physical_raster":
        return {
            "kind": "physical_raster",
            "widthMm": 35,
            "heightMm": 45,
            "printPpi": 300,
            "rounding": "nearest",
            "widthPx": 413,
            "heightPx": 531,
            "pixelDerivation": "round(mm / 25.4 * printPpi)",
            "ppiProvenance": "source_literal",
            "calibrationProfileId": "none",
        }
    return {"kind": kind}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="template_tools", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("validate", help="校验全部模板内容").set_defaults(func=cmd_validate)
    sub.add_parser("rehash", help="写回 contentHash").set_defaults(func=cmd_rehash)
    sub.add_parser("report", help="复核状态报表").set_defaults(func=cmd_report)

    new = sub.add_parser("new", help="生成 revision 骨架")
    new.add_argument("--id", required=True)
    new.add_argument("--version", type=int, default=1)
    new.add_argument("--label", required=True)
    new.add_argument("--jurisdiction", required=True)
    new.add_argument("--document-type", required=True)
    new.add_argument("--channel", required=True)
    new.add_argument("--output-kind", default="exact_pixels")
    new.set_defaults(func=cmd_new)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
