"""Serve the Lovelace card and register exactly one module loader.

Storage-mode dashboards load the bundle through ``lovelace_resources``. YAML-mode
dashboards have no resource collection, so only they use ``add_extra_js_url``.
Loading the same URL through both mechanisms is unsafe during frontend bootstrap:
the extra module can define the card on Home Assistant's temporary custom-element
registry, then the later Lovelace import is skipped by the browser module cache.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_when_setup

_LOGGER = logging.getLogger(__name__)

CARD_VERSION = "0.4.1"
STATIC_URL_BASE = "/personal_hydration_manager_static"
CARD_FILE = "personal-hydration-card.js"
CARD_URL = f"{STATIC_URL_BASE}/{CARD_FILE}"
CARD_URL_VERSIONED = f"{CARD_URL}?v={CARD_VERSION}"

_DATA_STATIC = "personal_hydration_manager_static_registered"
_DATA_EXTRA_JS = "personal_hydration_manager_extra_js_registered"
_DATA_LOVELACE_WAIT = "personal_hydration_manager_lovelace_wait_registered"
_DATA_LOVELACE_LOCK = "personal_hydration_manager_lovelace_resource_lock"


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

    # 2. Choose one loader after Lovelace is ready. Storage-mode dashboards use
    #    their resource collection; YAML mode has no collection and falls back
    #    to frontend extra modules. Never register both for the same URL.
    if hass.data.get("lovelace") is not None:
        await _async_register_card_loader(hass)
    elif not hass.data.get(_DATA_LOVELACE_WAIT):
        hass.data[_DATA_LOVELACE_WAIT] = True

        async def _on_lovelace_ready(_hass: HomeAssistant, _component: str) -> None:
            _hass.data.pop(_DATA_LOVELACE_WAIT, None)
            await _async_register_card_loader(_hass)

        async_when_setup(hass, "lovelace", _on_lovelace_ready)


async def _async_register_card_loader(hass: HomeAssistant) -> None:
    """Register the card through the loader appropriate to Lovelace's mode."""
    lovelace_data = hass.data.get("lovelace")
    resources = getattr(lovelace_data, "resources", None)
    if resources is not None and hasattr(resources, "async_create_item"):
        await _async_register_lovelace_resource(hass)
        return

    if not hass.data.get(_DATA_EXTRA_JS):
        add_extra_js_url(hass, CARD_URL_VERSIONED)
        hass.data[_DATA_EXTRA_JS] = True
        _LOGGER.debug("Registered hydration card as YAML-mode extra module")


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

    lock = hass.data.setdefault(_DATA_LOVELACE_LOCK, asyncio.Lock())
    async with lock:
        try:
            # Make sure the collection has loaded its items at least once.
            if hasattr(resources, "async_load") and not getattr(
                resources, "loaded", True
            ):
                await resources.async_load()

            existing = [
                item
                for item in resources.async_items()
                if item.get("url", "").split("?", 1)[0] == CARD_URL
            ]
            payload = {"res_type": "module", "url": CARD_URL_VERSIONED}

            if not existing:
                await resources.async_create_item(payload)
                _LOGGER.info(
                    "Registered hydration card as Lovelace resource %s",
                    CARD_URL_VERSIONED,
                )
                return

            primary, *duplicates = existing
            if (
                primary.get("url") != CARD_URL_VERSIONED
                or primary.get("res_type") != "module"
            ):
                await resources.async_update_item(primary["id"], payload)
                _LOGGER.info(
                    "Updated hydration card Lovelace resource to %s",
                    CARD_URL_VERSIONED,
                )

            for duplicate in duplicates:
                await resources.async_delete_item(duplicate["id"])
                _LOGGER.info(
                    "Removed duplicate hydration card Lovelace resource %s",
                    duplicate["id"],
                )
        except Exception as err:  # noqa: BLE001  # pragma: no cover - optional UI
            _LOGGER.warning("Could not register Lovelace resource: %s", err)
