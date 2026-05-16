"""Manual target override number entity."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, UNIT_FL_OZ, UNIT_L, UNIT_ML, to_ml
from .coordinator import HydrationCoordinator

# Inlined to avoid breakage on partial HACS updates — see sensor.py.
ENTITY_ID_PREFIX = "phm"
_ML_PER_FL_OZ = 29.5735


def _from_ml(volume_ml: float, unit: str) -> float:
    if unit == UNIT_L:
        return volume_ml / 1000.0
    if unit == UNIT_FL_OZ:
        return volume_ml / _ML_PER_FL_OZ
    return volume_ml


def _unit_label(unit: str) -> str:
    if unit == UNIT_FL_OZ:
        return "fl oz"
    return unit  # mL or L

# Override range per unit. Internally we always store mL (cap 8000); the
# user-facing range is just the same cap converted to their chosen unit.
_RANGE_BY_UNIT = {
    UNIT_ML: (0, 8000, 50),
    UNIT_L: (0, 8, 0.05),
    UNIT_FL_OZ: (0, 270, 1),
}


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
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator: HydrationCoordinator) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{coordinator.entry_id}_target_override"
        self.entity_id = f"number.{ENTITY_ID_PREFIX}_{coordinator.slug}_target_override"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.entry_id)},
            name=coordinator.name,
        )

    @property
    def native_unit_of_measurement(self) -> str:
        return _unit_label(self._coordinator.display_unit)

    @property
    def native_min_value(self) -> float:
        return _RANGE_BY_UNIT.get(self._coordinator.display_unit, _RANGE_BY_UNIT[UNIT_ML])[0]

    @property
    def native_max_value(self) -> float:
        return _RANGE_BY_UNIT.get(self._coordinator.display_unit, _RANGE_BY_UNIT[UNIT_ML])[1]

    @property
    def native_step(self) -> float:
        return _RANGE_BY_UNIT.get(self._coordinator.display_unit, _RANGE_BY_UNIT[UNIT_ML])[2]

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
        return round(_from_ml(self._coordinator.target_override_ml, self._coordinator.display_unit), 2)

    async def async_set_native_value(self, value: float) -> None:
        ml = to_ml(float(value), self._coordinator.display_unit)
        await self._coordinator.async_set_target_override(ml)
