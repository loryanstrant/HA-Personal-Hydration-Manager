"""Sensor entities for Personal Hydration Manager."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, UNIT_FL_OZ, UNIT_L, UNIT_ML
from .coordinator import HydrationCoordinator

# Short prefix for entity IDs (e.g. sensor.phm_alex_consumed_today).
# Inlined rather than imported from const.py so platform setup doesn't break
# if a HACS update lands the new sensor.py before const.py is refreshed.
ENTITY_ID_PREFIX = "phm"

# Unit conversion helpers are inlined for the same reason — partial-update
# resilience. Mirrors the canonical definitions in const.py.
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


def _pace_unit_label(unit: str) -> str:
    return f"{_unit_label(unit)}/h"


def _safe_display_unit(coordinator: HydrationCoordinator) -> str:
    """Read coordinator.display_unit defensively.

    If HACS landed a partial update where sensor.py is new but coordinator.py
    is still the stale v0.1.3 revision (no display_unit attribute), fall back
    to mL so the entity still registers instead of silently failing during
    platform setup.
    """
    return getattr(coordinator, "display_unit", UNIT_ML)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: HydrationCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            DailyTargetSensor(coordinator),
            ConsumedTodaySensor(coordinator),
            ManualConsumedSensor(coordinator),
            RemainingSensor(coordinator),
            HourlyPaceSensor(coordinator),
            ProgressSensor(coordinator),
        ]
    )


class _BaseHydrationSensor(SensorEntity):
    """Common base — wires dispatcher updates and the device entry."""

    _attr_should_poll = False
    _attr_has_entity_name = True

    def __init__(self, coordinator: HydrationCoordinator, key: str, name: str) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{coordinator.entry_id}_{key}"
        self._attr_name = name
        # Pin entity_id so all profile entities share a stable prefix
        # (sensor.phm_<profile>_<key>). _attr_has_entity_name keeps the
        # display name clean ("Daily target") on the device card.
        self.entity_id = f"sensor.{ENTITY_ID_PREFIX}_{coordinator.slug}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.entry_id)},
            name=coordinator.name,
            manufacturer="Loryan Strant",
            model="Personal Hydration Manager",
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


class _VolumeSensor(_BaseHydrationSensor):
    """Sensor whose value is a millilitre figure rendered in the chosen unit."""

    @property
    def native_unit_of_measurement(self) -> str:
        return _unit_label(_safe_display_unit(self._coordinator))


class DailyTargetSensor(_VolumeSensor):
    _attr_state_class = SensorStateClass.TOTAL
    _attr_icon = "mdi:target"

    def __init__(self, coordinator: HydrationCoordinator) -> None:
        super().__init__(coordinator, "daily_target", "Daily target")

    @property
    def native_value(self) -> float:
        return round(_from_ml(self._coordinator.target_ml, _safe_display_unit(self._coordinator)), 2)

    @property
    def extra_state_attributes(self) -> dict:
        c = self._coordinator
        return {
            "age": c.age,
            "gender": c.gender,
            "pregnancy": c.pregnancy,
            "lactation": c.lactation,
            "override_ml": c.target_override_ml or None,
            "target_ml": c.target_ml,
        }


class ConsumedTodaySensor(_VolumeSensor):
    _attr_state_class = SensorStateClass.TOTAL_INCREASING
    _attr_icon = "mdi:cup-water"

    def __init__(self, coordinator: HydrationCoordinator) -> None:
        super().__init__(coordinator, "consumed_today", "Consumed today")

    @property
    def native_value(self) -> float:
        return round(_from_ml(self._coordinator.consumed_ml, _safe_display_unit(self._coordinator)), 2)

    @property
    def extra_state_attributes(self) -> dict:
        return {"consumed_ml": round(self._coordinator.consumed_ml, 1)}


class ManualConsumedSensor(_VolumeSensor):
    """Manual-only running total.

    Always exposed regardless of source mode — it's the load-bearing
    contributor in sum mode, and an at-a-glance "how much have I logged
    by hand" figure in delta/absolute modes.
    """

    _attr_state_class = SensorStateClass.TOTAL_INCREASING
    _attr_icon = "mdi:hand-water"

    def __init__(self, coordinator: HydrationCoordinator) -> None:
        super().__init__(coordinator, "manual_consumed", "Manual consumed")

    @property
    def native_value(self) -> float:
        # getattr fallback: a partial HACS update could land sensor.py before
        # coordinator.py is refreshed with the new field.
        manual_ml = getattr(self._coordinator, "manual_consumed_ml", 0.0)
        return round(_from_ml(manual_ml, _safe_display_unit(self._coordinator)), 2)

    @property
    def extra_state_attributes(self) -> dict:
        manual_ml = getattr(self._coordinator, "manual_consumed_ml", 0.0)
        return {"manual_consumed_ml": round(manual_ml, 1)}


class RemainingSensor(_VolumeSensor):
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:water-percent"

    def __init__(self, coordinator: HydrationCoordinator) -> None:
        super().__init__(coordinator, "remaining", "Remaining")

    @property
    def native_value(self) -> float:
        return round(_from_ml(self._coordinator.remaining_ml, _safe_display_unit(self._coordinator)), 2)

    @property
    def extra_state_attributes(self) -> dict:
        return {"remaining_ml": round(self._coordinator.remaining_ml, 1)}


class HourlyPaceSensor(_BaseHydrationSensor):
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:speedometer"

    def __init__(self, coordinator: HydrationCoordinator) -> None:
        super().__init__(coordinator, "hourly_pace", "Hourly pace")

    @property
    def native_unit_of_measurement(self) -> str:
        return _pace_unit_label(_safe_display_unit(self._coordinator))

    @property
    def native_value(self) -> float:
        return round(_from_ml(self._coordinator.hourly_pace_ml, _safe_display_unit(self._coordinator)), 2)

    @property
    def extra_state_attributes(self) -> dict:
        return {"pace_ml_per_h": self._coordinator.hourly_pace_ml}


class ProgressSensor(_BaseHydrationSensor):
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:chart-donut"

    def __init__(self, coordinator: HydrationCoordinator) -> None:
        super().__init__(coordinator, "progress", "Progress")

    @property
    def native_value(self) -> float:
        return self._coordinator.progress_percent
