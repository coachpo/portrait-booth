"""Template content toolchain (SPEC §5.3).

Usage:
    python -m app.template_tools validate    # schema + publication rules + reference
                                             # integrity + content hashes
    python -m app.template_tools rehash      # write current revision hashes back to
                                             # publications.json
    python -m app.template_tools report      # list status, review dates, and days left
                                             # to SLA
    python -m app.template_tools new --id x --jurisdiction US ...  # generate a revision
                                                                   # skeleton

validate is CI's content gate: broken references and drifted contentHash only
show up at runtime as "mask silently not drawn" or "a template was edited in
place without anyone noticing".
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from .template_store import (
    _content_hash,
    default_publications_file,
    default_revisions_dir,
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
    except Exception as exc:  # Readable location without a stack trace
        print(f"template validation failed: {exc}", file=sys.stderr)
        return 1

    missing_hash = [
        e.revision["revisionId"] for e in entries if e.publication.get("contentHash") is None
    ]
    if missing_hash:
        print(
            "the following publications lack contentHash; revisions could be edited in place "
            "without being noticed: " + ", ".join(sorted(missing_hash)),
            file=sys.stderr,
        )
        return 1

    print(f"template validation passed: {len(entries)} revisions")
    return 0


def cmd_rehash(_args: argparse.Namespace) -> int:
    pubs = _read(default_publications_file())
    hashes = {}
    for path in sorted(default_revisions_dir().glob("*.json")):
        revision = _read(path)
        hashes[revision["revisionId"]] = _content_hash(revision)

    changed = 0
    for pub in pubs["publications"]:
        expected = hashes.get(pub["revisionId"])
        if expected is None:
            print(f"publication {pub['revisionId']} has no matching revision file", file=sys.stderr)
            return 1
        if pub.get("contentHash") != expected:
            pub["contentHash"] = expected
            changed += 1
    _write(default_publications_file(), pubs)
    print(f"updated {changed} contentHash entries")
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
    print(f"{'revisionId'.ljust(width)}  status          verifiedAt   reviewDueAt  days left")
    for revision_id, status, verified, due, days in rows:
        flag = "  <- overdue" if days < 0 else ""
        print(
            f"{revision_id.ljust(width)}  {status.ljust(15)} {verified}   {due}   {days:>6}{flag}"
        )
    overdue = [r for r in rows if r[4] < 0]
    if overdue:
        print(
            f"\n{len(overdue)} templates past their review date (SLA {REVIEW_SLA_DAYS} days)",
            file=sys.stderr,
        )
        return 1
    return 0


def cmd_new(args: argparse.Namespace) -> int:
    revision_id = f"{args.id}@{args.version}"
    path = default_revisions_dir() / f"{revision_id}.json"
    if path.exists():
        print(f"{path.name} already exists", file=sys.stderr)
        return 1

    today = dt.date.today().isoformat()
    skeleton = {
        "revisionId": revision_id,
        "id": args.id,
        "version": args.version,
        "schemaVersion": 1,
        "label": {"en": args.label},
        "jurisdiction": args.jurisdiction,
        "documentType": args.document_type,
        "submissionChannel": args.channel,
        "applicantClass": "adult",
        "sources": [
            {
                "id": "official-source",
                "url": "https://example.invalid/replace-me",
                "title": "Official source title",
                "authority": "Issuing authority",
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
        "sourceNotes": {"en": ["To be filled in"]},
    }
    _write(path, skeleton)

    pubs = _read(default_publications_file())
    pubs["publications"].append(
        {
            "revisionId": revision_id,
            # New templates are always reference_only: until a review record
            # exists they must not produce artifacts
            "status": "reference_only",
            "statusReason": "Newly created skeleton; source verification and review "
            "not yet complete.",
            "owner": "Portrait Booth content maintainer",
            "reviewer": "Portrait Booth content reviewer",
            "verifiedAt": today,
            "reviewDueAt": (dt.date.today() + dt.timedelta(days=REVIEW_SLA_DAYS)).isoformat(),
            "effectiveAt": today,
            "publicationRevision": 1,
        }
    )
    _write(default_publications_file(), pubs)
    print(f"generated {path.name}; run rehash afterwards to write the contentHash")
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

    sub.add_parser("validate", help="validate all template content").set_defaults(func=cmd_validate)
    sub.add_parser("rehash", help="write back contentHash").set_defaults(func=cmd_rehash)
    sub.add_parser("report", help="review status report").set_defaults(func=cmd_report)

    new = sub.add_parser("new", help="generate a revision skeleton")
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
