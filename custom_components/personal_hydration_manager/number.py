"""Manual target override number entity."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, ENTITY_ID_PREFIX
from .coordinator import HydrationCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: HydrationCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([TargetOverrideNumber(coordinator)])


class TargetOverrideNumber(NumberEntity):
    """Manual override for the daily target. Set to 0 to use the NASEM value."""

    _attr_should_poll = False
    _attr_has_entity_name = True
    _attr_name = "Target override"
    _attr_icon = "mdi:tune"
    _attr_native_unit_of_measurement = "mL"
    _attr_native_min_value = 0
    _attr_native_max_value = 8000
    _attr_native_step = 50
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator: HydrationCoordinator) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{coordinator.entry_id}_target_override"
        self.entity_id = f"number.{ENTITY_ID_PREFIX}_{coordinator.slug}_target_override"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.entry_id)},
            name=coordinator.name,
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, self._coordinator.signal, self._refresh
            )
        )

    @callback
    def _refresh(self) -> None:
        self.async_write_ha_state()

    @property
    def native_value(self) -> float:
        return self._coordinator.target_override_ml

    async def async_set_native_value(self, value: float) -> None:
        await self._coordinator.async_set_target_override(value)
