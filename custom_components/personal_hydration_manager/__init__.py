"""Personal Hydration Manager integration."""
from __future__ import annotations

import logging
import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.helpers import config_validation as cv

from .const import (
    ATTR_PROFILE,
    ATTR_UNIT,
    ATTR_VOLUME,
    DOMAIN,
    EVENT_DRINK,
    PLATFORMS,
    SERVICE_LOG_DRINK,
    SERVICE_RESET_TODAY,
    SERVICE_SET_CONSUMED,
    UNIT_ML,
    UNITS,
)
from .coordinator import HydrationCoordinator
from .frontend import async_register_frontend

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

SERVICE_LOG_DRINK_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_PROFILE): cv.string,
        vol.Required(ATTR_VOLUME): vol.Coerce(float),
        vol.Optional(ATTR_UNIT, default=UNIT_ML): vol.In(UNITS),
    }
)

SERVICE_RESET_SCHEMA = vol.Schema({vol.Required(ATTR_PROFILE): cv.string})

SERVICE_SET_CONSUMED_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_PROFILE): cv.string,
        vol.Required(ATTR_VOLUME): vol.Coerce(float),
        vol.Optional(ATTR_UNIT, default=UNIT_ML): vol.In(UNITS),
    }
)


def _resolve_coordinator(
    hass: HomeAssistant, profile: str
) -> HydrationCoordinator | None:
    """Match a profile arg to a coordinator by entry_id or name slug."""
    coordinators: dict[str, HydrationCoordinator] = hass.data.get(DOMAIN, {})
    if profile in coordinators:
        return coordinators[profile]
    profile_slug = profile.lower().replace(" ", "_")
    for coord in coordinators.values():
        if coord.slug == profile_slug:
            return coord
    return None


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the integration (services + frontend)."""
    hass.data.setdefault(DOMAIN, {})
    await async_register_frontend(hass)

    async def handle_log_drink(call: ServiceCall) -> None:
        profile = call.data[ATTR_PROFILE]
        coord = _resolve_coordinator(hass, profile)
        if coord is None:
            _LOGGER.warning("Unknown hydration profile: %s", profile)
            return
        await coord.async_add_drink(call.data[ATTR_VOLUME], call.data[ATTR_UNIT])

    async def handle_reset_today(call: ServiceCall) -> None:
        profile = call.data[ATTR_PROFILE]
        coord = _resolve_coordinator(hass, profile)
        if coord is None:
            _LOGGER.warning("Unknown hydration profile: %s", profile)
            return
        await coord.async_reset_today()

    async def handle_set_consumed(call: ServiceCall) -> None:
        profile = call.data[ATTR_PROFILE]
        coord = _resolve_coordinator(hass, profile)
        if coord is None:
            _LOGGER.warning("Unknown hydration profile: %s", profile)
            return
        await coord.async_set_consumed(call.data[ATTR_VOLUME], call.data[ATTR_UNIT])

    hass.services.async_register(
        DOMAIN, SERVICE_LOG_DRINK, handle_log_drink, schema=SERVICE_LOG_DRINK_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_RESET_TODAY, handle_reset_today, schema=SERVICE_RESET_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_CONSUMED, handle_set_consumed, schema=SERVICE_SET_CONSUMED_SCHEMA
    )

    @callback
    def handle_drink_event(event) -> None:
        data = event.data
        profile = data.get(ATTR_PROFILE)
        volume = data.get(ATTR_VOLUME)
        unit = data.get(ATTR_UNIT, UNIT_ML)
        if profile is None or volume is None:
            return
        coord = _resolve_coordinator(hass, profile)
        if coord is None:
            return
        hass.async_create_task(coord.async_add_drink(float(volume), unit))

    hass.bus.async_listen(EVENT_DRINK, handle_drink_event)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up a profile config entry."""
    hass.data.setdefault(DOMAIN, {})
    coordinator = HydrationCoordinator(hass, entry)
    await coordinator.async_initialize()
    hass.data[DOMAIN][entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload when options change."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a profile config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        coord: HydrationCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coord.async_shutdown()
    return unloaded
