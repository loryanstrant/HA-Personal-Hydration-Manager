"""Serve the Lovelace card as a static resource and auto-register it."""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

CARD_URL = "/personal_hydration_manager/personal-hydration-card.js"
CARD_FILE = "personal-hydration-card.js"
CARD_VERSION = "0.1.1"

_REGISTERED = "personal_hydration_manager_frontend_registered"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Expose the card at a known URL and add it as a frontend JS module."""
    if hass.data.get(_REGISTERED):
        return

    card_path = Path(__file__).parent / "www" / CARD_FILE
    if not card_path.is_file():
        _LOGGER.error("Card bundle missing: %s", card_path)
        return

    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(card_path), cache_headers=False)]
    )
    add_extra_js_url(hass, f"{CARD_URL}?v={CARD_VERSION}")
    hass.data[_REGISTERED] = True
    _LOGGER.debug("Registered hydration card at %s", CARD_URL)
