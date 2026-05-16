"""Serve the Lovelace card and register it as a dashboard resource.

Two-pronged registration so the card is reliably picked up:

1.  Serve the bundled JS at a stable URL via ``async_register_static_paths`` and
    add it as a frontend extra-module via ``add_extra_js_url``. This covers
    YAML-mode dashboards and is what shows the card in the card picker.

2.  When Lovelace is in storage mode (the default for most users), also write
    a ``lovelace_resources`` entry so the card loads even after the user
    clears their browser cache and even on dashboards that have not been
    edited yet.

Re-running registration on every entry setup is safe — both helpers dedupe
on the URL.
"""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

CARD_VERSION = "0.1.6"
STATIC_URL_BASE = "/personal_hydration_manager_static"
CARD_FILE = "personal-hydration-card.js"
CARD_URL = f"{STATIC_URL_BASE}/{CARD_FILE}"
CARD_URL_VERSIONED = f"{CARD_URL}?v={CARD_VERSION}"

_DATA_STATIC = "personal_hydration_manager_static_registered"
_DATA_EXTRA_JS = "personal_hydration_manager_extra_js_registered"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Expose the card bundle and register it as a Lovelace resource."""
    www_path = Path(__file__).parent / "www"
    card_path = www_path / CARD_FILE
    if not card_path.is_file():
        _LOGGER.error("Card bundle missing at %s", card_path)
        return

    # 1. Serve the entire www directory under our own static URL prefix.
    if not hass.data.get(_DATA_STATIC):
        try:
            await hass.http.async_register_static_paths(
                [StaticPathConfig(STATIC_URL_BASE, str(www_path), cache_headers=False)]
            )
            hass.data[_DATA_STATIC] = True
            _LOGGER.debug("Registered static path %s -> %s", STATIC_URL_BASE, www_path)
        except RuntimeError as err:
            # Already registered (happens on reload). Treat as success.
            _LOGGER.debug("Static path already registered: %s", err)
            hass.data[_DATA_STATIC] = True

    # 2. Inject the card as a frontend ES module — handles YAML dashboards
    #    and the card picker.
    if not hass.data.get(_DATA_EXTRA_JS):
        add_extra_js_url(hass, CARD_URL_VERSIONED)
        hass.data[_DATA_EXTRA_JS] = True

    # 3. Belt-and-braces: register it in the Lovelace resources collection
    #    used by storage-mode dashboards. This is the same store HACS writes
    #    to and is what makes cards survive cache wipes and fresh dashboards.
    await _async_register_lovelace_resource(hass)


async def _async_register_lovelace_resource(hass: HomeAssistant) -> None:
    """Ensure the card has a /lovelace_resources entry (storage mode)."""
    lovelace_data = hass.data.get("lovelace")
    if lovelace_data is None:
        _LOGGER.debug("Lovelace not loaded yet — skipping resource registration")
        return

    resources = getattr(lovelace_data, "resources", None)
    if resources is None:
        # YAML mode — there is no storage collection to update.
        _LOGGER.debug("Lovelace is in YAML mode — using extra_js_url only")
        return

    # Make sure the collection has loaded its items at least once.
    if hasattr(resources, "async_load") and not getattr(resources, "loaded", True):
        try:
            await resources.async_load()
        except Exception as err:  # pragma: no cover - defensive
            _LOGGER.debug("Could not pre-load Lovelace resources: %s", err)

    existing = None
    for item in resources.async_items():
        url = item.get("url", "")
        if url.split("?", 1)[0] == CARD_URL:
            existing = item
            break

    payload = {"res_type": "module", "url": CARD_URL_VERSIONED}

    try:
        if existing is None:
            await resources.async_create_item(payload)
            _LOGGER.info("Registered hydration card as Lovelace resource %s", CARD_URL_VERSIONED)
        elif existing.get("url") != CARD_URL_VERSIONED:
            await resources.async_update_item(existing["id"], payload)
            _LOGGER.info("Updated hydration card Lovelace resource to %s", CARD_URL_VERSIONED)
    except Exception as err:  # pragma: no cover - defensive
        _LOGGER.warning("Could not register Lovelace resource: %s", err)
