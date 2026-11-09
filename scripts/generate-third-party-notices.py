#!/usr/bin/env python3
"""Collect locked dependency declarations and cached license texts, without network.

Requires Python 3.11+. Metadata is evidence, not a license compatibility verdict.
The same standalone script lives in each product so a clone needs no sibling repo.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import tomllib


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def license_expression(value):
    # Preserve legacy arrays and objects rather than inventing an SPDX expression.
    if value is None or isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def license_paths(directory):
    pattern = re.compile(r"^(licen[cs]e|copying|notice|copyright)([._ -]|$)", re.I)
    paths = []
    for child in sorted(directory.iterdir()):
        if child.is_file() and pattern.match(child.name):
            paths.append(child)
        elif child.is_dir() and child.name.lower() in {"licenses", "licences"}:
            paths.extend(p for p in sorted(child.rglob("*")) if p.is_file())
    return paths


class Collector:
    def __init__(self):
        self.texts = {}

    def add_text(self, record, name, raw):
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return
        if not text.strip() or "\x00" in text:
            return
        sha = digest(raw)
        self.texts.setdefault(sha, text.replace("\r\n", "\n").replace("\r", "\n"))
        record["licenseFiles"].append({"path": name, "sha256": sha})

    def attach_texts(self, record, directory):
        record["licenseFiles"] = []
        for path in license_paths(directory):
            self.add_text(record, path.relative_to(directory).as_posix(), path.read_bytes())


def npm_records(root, collector):
    lock = load_json(root / "package-lock.json")
    records = []
    for location, entry in sorted(lock["packages"].items()):
        if "node_modules/" not in location or entry.get("link"):
            continue
        name = entry.get("name") or location.rsplit("node_modules/", 1)[1]
        record = {
            "name": name, "version": entry.get("version"), "lockPath": location,
            "developmentOnly": bool(entry.get("dev")),
            "optional": bool(entry.get("optional") or entry.get("devOptional")),
            "declaredLicense": license_expression(entry.get("license")),
            "evidence": "lock-only", "licenseFiles": [],
        }
        manifest = root / location / "package.json"
        if manifest.is_file():
            installed = load_json(manifest)
            if installed.get("version") != entry.get("version"):
                raise ValueError(f"Installed version differs from lock: {location}")
            record["evidence"] = "installed-package"
            record["packageLicense"] = license_expression(
                installed.get("license", installed.get("licenses")))
            collector.attach_texts(record, manifest.parent)
        records.append(record)
    return records


def cargo_records(root, collector):
    manifest = root / "apps/tauri/src-tauri/Cargo.toml"
    if not manifest.is_file():
        return [], []
    project = tomllib.loads(manifest.read_text(encoding="utf-8"))
    lock_path = manifest.with_name("Cargo.lock")
    lock = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    cargo_home = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")))
    registry_caches = sorted((cargo_home / "registry/cache").glob("*"))
    patches = project.get("patch", {}).get("crates-io", {})
    records = []
    for package in lock["package"]:
        name, version = package["name"], package["version"]
        if not package.get("source") and name == project["package"]["name"]:
            continue
        record = {"name": name, "version": version, "declaredLicense": None,
                  "evidence": "lock-only", "licenseFiles": []}
        directory = None
        if not package.get("source"):
            patch = patches.get(name, {})
            if patch.get("path"):
                directory = (manifest.parent / patch["path"]).resolve()
                record["vendorPath"] = directory.relative_to(root).as_posix()
        record["sourceKind"] = "vendored" if "vendorPath" in record else (
            "registry" if package.get("source", "").startswith("registry+") else "other")
        if directory and (directory / "Cargo.toml").is_file():
            metadata = tomllib.loads((directory / "Cargo.toml").read_text(encoding="utf-8"))["package"]
            if metadata.get("name") != name or metadata.get("version") != version:
                raise ValueError(f"Cargo source differs from lock: {name}@{version}")
            record["declaredLicense"] = metadata.get("license")
            record["evidence"] = "vendored-source" if "vendorPath" in record else "cached-source"
            collector.attach_texts(record, directory)
            # Some crates explicitly name a license file with a nonstandard name.
            license_file = metadata.get("license-file")
            if license_file:
                record["declaredLicenseFile"] = license_file
                license_path = (directory / license_file).resolve()
                if (license_path.is_relative_to(directory.resolve()) and license_path.is_file()
                        and license_file not in {p["path"] for p in record["licenseFiles"]}):
                    collector.add_text(record, license_file, license_path.read_bytes())
        elif record["sourceKind"] == "registry":
            for cache in registry_caches:
                archive = cache / f"{name}-{version}.crate"
                if not archive.is_file() or digest(archive.read_bytes()) != package.get("checksum"):
                    continue
                # Read the verified archive without extracting or exposing cache paths.
                with tarfile.open(archive, "r:gz") as bundle:
                    prefix = f"{name}-{version}/"
                    metadata = tomllib.loads(bundle.extractfile(prefix + "Cargo.toml").read().decode("utf-8"))["package"]
                    if metadata.get("name") != name or metadata.get("version") != version:
                        raise ValueError(f"Cargo archive differs from lock: {name}@{version}")
                    record["declaredLicense"] = metadata.get("license")
                    record["evidence"] = "checksum-verified-cached-archive"
                    named_file = metadata.get("license-file")
                    if named_file:
                        record["declaredLicenseFile"] = named_file
                    for member in sorted(bundle.getmembers(), key=lambda item: item.name):
                        if not member.isfile() or not member.name.startswith(prefix):
                            continue
                        relative = member.name[len(prefix):]
                        parts = Path(relative).parts
                        is_root_license = len(parts) == 1 and re.match(
                            r"^(licen[cs]e|copying|notice|copyright)([._ -]|$)", relative, re.I)
                        is_license_dir = parts and parts[0].lower() in {"licenses", "licences"}
                        if is_root_license or is_license_dir or relative == named_file:
                            collector.add_text(record, relative, bundle.extractfile(member).read())
                break
        records.append(record)
    records.sort(key=lambda item: (item["name"], item["version"]))
    return records, [lock_path]


def source_assets(root, collector):
    # Explicit source assets: not dependent on the caller's machine or build output.
    records = []
    fonts = root / "packages/workbench/e2e/fixtures/fonts"
    if fonts.is_dir():
        record = {"name": "UI regression fonts", "sourcePath": fonts.relative_to(root).as_posix(),
                  "declaredLicense": "See original license files", "evidence": "source-assets"}
        collector.attach_texts(record, fonts)
        records.append(record)
    return records


def review_items(groups):
    items = []
    for group, records in groups.items():
        for record in records:
            issues = []
            expression = record.get("declaredLicense") or record.get("packageLicense")
            if not expression:
                issues.append("missing-license-declaration")
            elif any(token in expression for token in ("MPL", "GPL", "LGPL", "AGPL", "AFL")):
                issues.append("review-license-obligations-and-alternatives")
            if expression and (expression.startswith(("[", "{")) or "/" in expression or "SEE LICENSE" in expression.upper()):
                issues.append("review-non-spdx-or-file-declaration")
            if record.get("evidence") == "lock-only":
                issues.append("source-not-installed-or-cached")
            if not record.get("licenseFiles"):
                issues.append("no-license-text-collected")
            if issues:
                items.append({"ecosystem": group, "name": record["name"],
                              "version": record.get("version"),
                              "lockPath": record.get("lockPath"), "issues": issues})
    return items


def generate(root):
    collector = Collector()
    npm = npm_records(root, collector)
    cargo, cargo_locks = cargo_records(root, collector)
    assets = source_assets(root, collector)
    groups = {"npm": npm, "cargo": cargo, "assets": assets}
    locks = [root / "package-lock.json", *cargo_locks]
    inventory = {
        "schemaVersion": 1,
        "scope": "All locked npm/Cargo entries; includes development, optional and cross-platform dependencies. Not a binary bill of materials or compatibility approval.",
        "lockfiles": {p.relative_to(root).as_posix(): digest(p.read_bytes()) for p in locks},
        "summary": {name: len(records) for name, records in groups.items()},
        **groups, "reviewRequired": review_items(groups),
    }
    text = ["Third-party license texts collected from local dependency sources.\n"
            "See third-party-inventory.json for exact versions, file SHA-256 and coverage gaps.\n"
            "Each SHA-256 identifies the original file bytes; text here is UTF-8 with LF newlines.\n"
            "These third-party terms are not replaced by the application's source license.\n"]
    for sha, content in sorted(collector.texts.items()):
        text.append(f"\n{'=' * 72}\nOriginal file SHA-256: {sha}\n{'=' * 72}\n{content.rstrip()}\n")
    return {
        "third-party-inventory.json": json.dumps(inventory, ensure_ascii=False, indent=2) + "\n",
        "third-party-license-texts.txt": "".join(text),
    }, inventory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Compare without modifying generated documents")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    outputs, inventory = generate(root)
    directory = root / "docs/legal"
    stale = []
    for name, content in outputs.items():
        destination = directory / name
        if args.check:
            if not destination.is_file() or destination.read_text(encoding="utf-8") != content:
                stale.append(name)
        else:
            directory.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(destination.suffix + ".tmp")
            temporary.write_text(content, encoding="utf-8")
            temporary.replace(destination)
    print(json.dumps({"counts": inventory["summary"], "reviewRequired": len(inventory["reviewRequired"]),
                      "staleFiles": stale}, ensure_ascii=False))
    return 1 if stale else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as error:
        print(f"Cannot generate notices: {error}", file=sys.stderr)
        sys.exit(1)
