"""Shared fixtures for the behavioural tests.

`test_packaging.py` reads the tree from disk and needs none of this. Everything
here exists for the coordinator tests, which need a real `hass` (the coordinator
holds a `Store` and dispatches on the HA bus).
"""
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.personal_hydration_manager.const import (
    CONF_AGE,
    CONF_DAY_END,
    CONF_DAY_START,
    CONF_GENDER,
    CONF_NAME,
    CONF_SOURCE_MODE,
    CONF_SOURCE_SENSOR,
    DOMAIN,
    SOURCE_MODE_ABSOLUTE,
)
from custom_components.personal_hydration_manager.coordinator import (
    HydrationCoordinator,
)

SOURCE_ENTITY = "sensor.bottle_water_today"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Let Home Assistant load this repo's custom component."""
    return


@pytest.fixture(autouse=True)
async def utc_timezone(hass):
    """Pin the test timezone.

    `dt_util.now()` follows `hass.config.time_zone`, which the HA test harness
    does not default to UTC. Without this, a frozen "06:00" is not the 06:00 the
    coordinator sees and every pace assertion is off by the offset.
    """
    await hass.config.async_set_time_zone("UTC")


@pytest.fixture
def make_coordinator(hass):
    """Build a coordinator directly, without setting up the integration.

    `HydrationCoordinator` is a plain object rather than a `DataUpdateCoordinator`,
    so it can be constructed and driven on its own.
    """

    def _make(**options):
        data = {
            CONF_NAME: "Test",
            CONF_AGE: 40,
            CONF_GENDER: "male",
            CONF_DAY_START: "07:00:00",
            CONF_DAY_END: "23:00:00",
            CONF_SOURCE_SENSOR: SOURCE_ENTITY,
            CONF_SOURCE_MODE: SOURCE_MODE_ABSOLUTE,
        }
        data.update(options)
        entry = MockConfigEntry(domain=DOMAIN, data=data, title="Test")
        entry.add_to_hass(hass)
        return HydrationCoordinator(hass, entry)

    return _make


async def emit_source(hass, value, unit="mL", entity_id=SOURCE_ENTITY):
    """Push a reading from the source sensor through the real event path.

    Sets the state and lets the coordinator's `EVENT_STATE_CHANGED` listener see
    it, so tests exercise `_handle_source_change` exactly as HA would call it.

    `force_update` because HA only fires `state_changed` when something actually
    changed — a sensor re-reporting the same number with the same attributes
    fires `state_reported` instead. That is why prod sat quietly at 621 for two
    hours; tests that need the repeat delivered have to ask for it.
    """
    hass.states.async_set(
        entity_id, str(value), {"unit_of_measurement": unit}, force_update=True
    )
    await hass.async_block_till_done()


async def restart_source_entity(hass, value, unit="mL", entity_id=SOURCE_ENTITY):
    """Model the source entity being removed and re-created, as an HA restart does.

    This is the 09:01:18 event in the 2026-09-03 incident: the entity comes back
    with the same reading it had before, and that arrives as a `state_changed`.
    """
    hass.states.async_remove(entity_id)
    await hass.async_block_till_done()
    hass.states.async_set(entity_id, str(value), {"unit_of_measurement": unit})
    await hass.async_block_till_done()
