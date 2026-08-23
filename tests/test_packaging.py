"""Packaging guards.

Every check here exists because the thing it catches has already shipped, in
this repo or a sibling one. They read the tree from disk and need no Home
Assistant instance, so they run in a second and belong in CI.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent
COMPONENT = REPO / "custom_components" / "personal_hydration_manager"
WWW = COMPONENT / "www"
BLUEPRINTS = REPO / "blueprints" / "automation" / "loryanstrant"
BUNDLED_BLUEPRINTS = COMPONENT / "blueprints" / "automation" / "loryanstrant"

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def _manifest() -> dict:
    return json.loads((COMPONENT / "manifest.json").read_text(encoding="utf-8"))


# --------------------------------------------------------------------------
# Manifest and HACS metadata
# --------------------------------------------------------------------------


def test_manifest_version_is_semver() -> None:
    assert SEMVER.match(_manifest()["version"])


def test_manifest_domain_matches_folder() -> None:
    assert _manifest()["domain"] == COMPONENT.name


def test_manifest_keys_are_sorted_the_way_hassfest_wants() -> None:
    """`domain`, `name`, then everything else alphabetically.

    Home Assistant's hassfest action enforces this and fails the build over it,
    which is a red CI run discovered after the release has been cut.
    """
    keys = list(_manifest())
    assert keys[0] == "domain"
    assert keys[1] == "name"
    assert keys[2:] == sorted(keys[2:]), f"rest must be alphabetical, got {keys[2:]}"


def test_hacs_filename_matches_domain() -> None:
    hacs = json.loads((REPO / "hacs.json").read_text(encoding="utf-8"))
    assert hacs["filename"] == f"{_manifest()['domain']}.zip"
    # zip_release is what makes HACS install the release artifact rather than
    # the repo tree, so it has to agree with release.yaml producing that zip.
    assert hacs["zip_release"] is True


@pytest.mark.parametrize(("name", "expected"), [("icon.png", 256), ("icon@2x.png", 512)])
def test_brand_icons_exist_at_the_size_hacs_expects(name: str, expected: int) -> None:
    """HACS fails validation without these, or a listing in the brands repo."""
    icon = COMPONENT / "brand" / name
    assert icon.exists(), f"{name} is missing"

    # PNG dimensions live in the IHDR chunk, 16 bytes in. Read them directly
    # rather than adding an image library just for this.
    header = icon.read_bytes()[:24]
    assert header[:8] == b"\x89PNG\r\n\x1a\n", f"{name} is not a PNG"
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    assert (width, height) == (expected, expected), f"{name} is {width}x{height}"


# --------------------------------------------------------------------------
# The bundled card
# --------------------------------------------------------------------------


@pytest.mark.parametrize("card", sorted(WWW.glob("*.js")) or [None])
def test_card_version_matches_manifest(card: Path | None) -> None:
    """Every bundled card is versioned in lockstep with the integration.

    A user reading a card's console banner should never be troubleshooting a
    different version from the one HACS installed. This repo shipped 0.1.13 and
    0.1.14 with the card still announcing itself as 0.1.12.
    """
    if card is None:
        pytest.skip("no bundled cards yet")
    found = re.search(r'CARD_VERSION\s*=\s*"([^"]+)"', card.read_text(encoding="utf-8"))
    assert found, f"{card.name} declares no CARD_VERSION"
    assert found.group(1) == _manifest()["version"], (
        f"{card.name} is at {found.group(1)}, manifest is at {_manifest()['version']}"
    )


def test_the_card_registers_its_elements() -> None:
    """A card that defines no custom element silently does nothing."""
    source = (WWW / "personal-hydration-card.js").read_text(encoding="utf-8")
    assert "customElements.define(CARD_TAG" in source
    assert "customElements.define(EDITOR_TAG" in source
    assert "window.customCards.push" in source


# --------------------------------------------------------------------------
# Blueprints
# --------------------------------------------------------------------------


def test_the_component_bundles_the_blueprints() -> None:
    """They ship inside the component so they install themselves.

    Home Assistant only loads blueprints from `config/blueprints`, so the
    integration copies them across at setup. If they are not in the zip there
    is nothing to copy, and the feature silently does not exist for anyone who
    installed through HACS.
    """
    assert BUNDLED_BLUEPRINTS.is_dir(), "no blueprints bundled in the component"
    assert sorted(p.name for p in BUNDLED_BLUEPRINTS.glob("*.yaml")), "bundle is empty"


def test_the_two_blueprint_copies_have_not_drifted() -> None:
    """The repo-root copy and the bundled copy must be byte-identical.

    The root copy is what an import-by-URL fetches; the bundled copy is what
    `blueprints_install.py` installs. When they drift, a user importing by URL
    quietly gets a different automation from the one the integration installed,
    and nothing complains. That is exactly what happened here: both blueprints
    carried the repo's pre-rename slug at the root and the current one in the
    bundle, a three-byte difference nobody could see.
    """
    root = {p.name: p.read_bytes() for p in BLUEPRINTS.glob("*.yaml")}
    bundled = {p.name: p.read_bytes() for p in BUNDLED_BLUEPRINTS.glob("*.yaml")}

    assert set(root) == set(bundled), (
        f"different files: root has {sorted(set(root) - set(bundled))}, "
        f"bundle has {sorted(set(bundled) - set(root))}"
    )
    drifted = [name for name in root if root[name] != bundled[name]]
    assert not drifted, f"copies have drifted apart: {drifted}"


def _repo_slug() -> str:
    """The GitHub `owner/repo` this component says it lives at."""
    documentation = _manifest()["documentation"]
    return "/".join(documentation.rstrip("/").split("/")[-2:])


class _BlueprintLoader(yaml.SafeLoader):
    """A safe loader that tolerates Home Assistant's own YAML tags.

    Blueprints are full of `!input`, which `yaml.safe_load` refuses outright.
    Every such tag is read as its plain scalar, which is all these tests need —
    the alternative is regexing the file, and that stops being a structural
    check the moment somebody reformats it.
    """


_BlueprintLoader.add_multi_constructor(
    "!", lambda loader, suffix, node: loader.construct_scalar(node)
)


def _blueprints_with_ids() -> tuple[list[Path], list[str]]:
    paths = sorted(BLUEPRINTS.glob("*.yaml")) + sorted(BUNDLED_BLUEPRINTS.glob("*.yaml"))
    ids = [
        f"{'bundled' if COMPONENT in p.parents else 'root'}/{p.name}" for p in paths
    ]
    return paths, ids


_BLUEPRINT_PATHS, _BLUEPRINT_IDS = _blueprints_with_ids()


@pytest.mark.parametrize("blueprint", _BLUEPRINT_PATHS, ids=_BLUEPRINT_IDS)
def test_blueprint_source_url_points_at_this_repo(blueprint: Path) -> None:
    """`source_url` must name the repository that actually exists.

    Byte-equality alone is satisfied by making *both* copies wrong, so this is
    the check that catches the real fault. Home Assistant stores `source_url`
    as an imported blueprint's identity and re-fetches it for *Re-import
    blueprint*; when it names the repo's pre-rename slug that URL 404s and the
    update check fails forever, silently. Both root copies shipped that way
    from the initial release until 0.2.0.
    """
    data = yaml.load(blueprint.read_text(encoding="utf-8"), Loader=_BlueprintLoader)
    source_url = data["blueprint"]["source_url"]
    assert f"github.com/{_repo_slug()}/" in source_url, (
        f"{blueprint.name} points at {source_url}, "
        f"but this component lives at github.com/{_repo_slug()}"
    )


# --------------------------------------------------------------------------
# Flow copy
# --------------------------------------------------------------------------


def test_translations_match_strings() -> None:
    """`translations/en.json` must be a copy of `strings.json`.

    Custom integrations load config- and options-flow text from
    `translations/<lang>.json` at runtime, not from `strings.json`. Anything
    only in `strings.json` renders as its raw key. This repo shipped with the
    `sum` source mode missing from the copy, so that option appeared in the
    setup dropdown as the bare word "sum".
    """
    strings = json.loads((COMPONENT / "strings.json").read_text(encoding="utf-8"))
    english = COMPONENT / "translations" / "en.json"
    assert english.exists(), "translations/en.json is missing"
    assert strings == json.loads(english.read_text(encoding="utf-8"))


def _walk_steps(node: dict):
    """Yield every step dict that declares a `data` block."""
    for value in node.values():
        if isinstance(value, dict):
            if isinstance(value.get("data"), dict):
                yield value
            yield from _walk_steps(value)


def test_every_field_has_helper_text() -> None:
    """Non-developers get no value from a bare field label."""
    data = json.loads((COMPONENT / "strings.json").read_text(encoding="utf-8"))
    missing: list[str] = []
    for step in _walk_steps(data):
        descriptions = step.get("data_description", {})
        for field in step["data"]:
            if field not in descriptions:
                missing.append(f"{step.get('title', '?')}.{field}")
    assert not missing, f"fields with no data_description: {missing}"


# --------------------------------------------------------------------------
# README
# --------------------------------------------------------------------------


def test_every_image_the_readme_points_at_exists() -> None:
    """A broken image is invisible until somebody opens the repo page.

    `_IMAGES/` is a session scratch directory that is not committed, so a
    README pointing into it renders as a broken link on GitHub.
    """
    readme = (REPO / "README.md").read_text(encoding="utf-8")
    referenced = set(re.findall(r"!\[[^\]]*\]\(([^)\s]+)\)", readme, re.S))
    referenced |= set(re.findall(r'<img[^>]+src="([^"]+)"', readme))
    local = [r for r in referenced if not r.startswith(("http://", "https://"))]

    missing = [r for r in local if not (REPO / r).exists()]
    assert not missing, f"README references images that are not in the repo: {missing}"

    # Also keep them light — a README that takes a minute to load is its own bug.
    heavy = [
        f"{r} ({(REPO / r).stat().st_size // 1024} KB)"
        for r in local
        if (REPO / r).stat().st_size > 400 * 1024
    ]
    assert not heavy, f"README images are too heavy: {heavy}"
