"""Reads an exported Elara bundle with the OKF reference parser.

The parser is GoogleCloudPlatform/open-knowledge-format
src/reference_agent/bundle/document.py at a pinned commit, downloaded by the
lab workflow into /tmp/okf-ref/okf_document.py (it only needs PyYAML).
Usage: python3 lab/okf_ref_check.py <bundle-dir>  -> JSON on stdout.
"""
import json
import os
import sys

sys.path.insert(0, os.environ.get("OKF_REF_DIR", "/tmp/okf-ref"))
import okf_document as okf  # noqa: E402
import yaml  # noqa: E402

root = sys.argv[1]
docs = []
for dirpath, _dirnames, filenames in os.walk(root):
    for name in sorted(filenames):
        if not name.endswith(".md"):
            continue
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, root).replace(os.sep, "/")
        entry = {"path": rel, "reserved": name in ("index.md", "log.md")}
        try:
            with open(full, encoding="utf-8") as fh:
                doc = okf.OKFDocument.parse(fh.read())
            entry["ok"] = True
            # default=str: YAML 1.1 can still produce non-JSON types (dates, sets).
            entry["frontmatter"] = json.loads(json.dumps(doc.frontmatter, default=str))
            entry["body"] = doc.body
            try:
                doc.validate()
                entry["validateError"] = None
            except okf.OKFDocumentError as err:
                entry["validateError"] = str(err)
            entry["trustTier"] = okf.trust_tier(doc.frontmatter)
            entry["isStale"] = okf.is_stale(doc.frontmatter)
        except Exception as err:  # the reference parser raising is the finding
            entry["ok"] = False
            entry["error"] = f"{type(err).__name__}: {err}"
        docs.append(entry)

print(json.dumps({"parser": f"okf reference document.py, PyYAML {yaml.__version__}", "docs": docs}))
