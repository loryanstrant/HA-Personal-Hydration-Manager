"""Coordinator that owns hydration state for a single profile."""
from __future__ import annotations

import logging
from datetime import datetime, time, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONF_AGE,
    CONF_DAY_END,
    CONF_DAY_START,
    CONF_GENDER,
    CONF_LACTATION,
    CONF_NAME,
    CONF_PREGNANCY,
    CONF_SOURCE_MODE,
    CONF_SOURCE_SENSOR,
    DEFAULT_DAY_END,
    DEFAULT_DAY_START,
    SIGNAL_UPDATE_FMT,
    SOURCE_MODE_ABSOLUTE,
    SOURCE_MODE_DELTA,
    STORAGE_KEY_FMT,
    STORAGE_VERSION,
    UNIT_ML,
    calculate_nasem_target,
    to_ml,
)

# Inlined — see config_flow.py for rationale.
CONF_UNIT = "unit"

_LOGGER = logging.getLogger(__name__)


def _parse_time(value: str | None, fallback: str) -> time:
    raw = value or fallback
    try:
        parts = [int(p) for p in raw.split(":")]
        while len(parts) < 3:
            parts.append(0)
        return time(parts[0], parts[1], parts[2])
    except (ValueError, AttributeError):
        return _parse_time(fallback, fallback)


class HydrationCoordinator:
    """Tracks one person's hydration target, consumption, and pace."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.entry_id = entry.entry_id
        self._store = Store(
            hass, STORAGE_VERSION, STORAGE_KEY_FMT.format(entry_id=entry.entry_id)
        )
        self._unsub_reset = None
        self._unsub_source = None
        self._unsub_pace = None

        self.consumed_ml: float = 0.0
        self.last_reset_date: str = dt_util.now().date().isoformat()
        self.target_override_ml: float = 0.0
        self._last_source_value: float | None = None

        cfg = {**entry.data, **entry.options}
        self.name: str = cfg.get(CONF_NAME, "Hydration")
        self.slug: str = self.name.lower().replace(" ", "_")
        self.age: int = int(cfg.get(CONF_AGE, 30))
        self.gender: str = cfg.get(CONF_GENDER, "female")
        self.pregnancy: bool = bool(cfg.get(CONF_PREGNANCY, False))
        self.lactation: bool = bool(cfg.get(CONF_LACTATION, False))
        self.day_start: time = _parse_time(cfg.get(CONF_DAY_START), DEFAULT_DAY_START)
        self.day_end: time = _parse_time(cfg.get(CONF_DAY_END), DEFAULT_DAY_END)
        self.source_sensor: str | None = cfg.get(CONF_SOURCE_SENSOR) or None
        self.source_mode: str = cfg.get(CONF_SOURCE_MODE, SOURCE_MODE_ABSOLUTE)
        # Display unit chosen by the user. Internal storage stays in mL —
        # the NASEM table is in mL and conversion happens only at the
        # sensor/number boundary via const.from_ml / const.to_ml.
        self.display_unit: str = cfg.get(CONF_UNIT, UNIT_ML)

    @property
    def signal(self) -> str:
        return SIGNAL_UPDATE_FMT.format(entry_id=self.entry_id)

    @property
    def target_ml(self) -> int:
        if self.target_override_ml and self.target_override_ml > 0:
            return int(round(self.target_override_ml))
        return calculate_nasem_target(
            self.age, self.gender, self.pregnancy, self.lactation
        )

    @property
    def remaining_ml(self) -> float:
        return max(self.target_ml - self.consumed_ml, 0.0)

    @property
    def progress_percent(self) -> float:
        target = self.target_ml or 1
        return round(min(100.0, (self.consumed_ml / target) * 100), 1)

    @property
    def hourly_pace_ml(self) -> float:
        """Recommended mL/h to finish by day_end (dynamic catch-up)."""
        now = dt_util.now()
        end_dt = now.replace(
            hour=self.day_end.hour,
            minute=self.day_end.minute,
            second=self.day_end.second,
            microsecond=0,
        )
        if end_dt <= now:
            # Day is over — pace would be infinite. Return remaining as-is
            # so the card can say "catch up: X mL".
            return round(self.remaining_ml, 1)
        hours_left = max((end_dt - now).total_seconds() / 3600, 0.25)
        return round(self.remaining_ml / hours_left, 1)

    async def async_initialize(self) -> None:
        """Load persisted state, schedule resets, attach source sensor."""
        stored: dict[str, Any] | None = await self._store.async_load()
        if stored:
            self.consumed_ml = float(stored.get("consumed_ml", 0.0))
            self.last_reset_date = stored.get(
                "last_reset_date", dt_util.now().date().isoformat()
            )
            self.target_override_ml = float(stored.get("target_override_ml", 0.0))
            self._last_source_value = stored.get("last_source_value")

        # Catch up on any missed daily reset.
        await self._maybe_daily_reset()

        # Schedule the daily reset at day_start.
        self._unsub_reset = async_track_time_change(
            self.hass,
            self._scheduled_reset,
            hour=self.day_start.hour,
            minute=self.day_start.minute,
            second=self.day_start.second,
        )

        # Re-emit pace every minute so the countdown stays current.
        self._unsub_pace = async_track_time_change(
            self.hass, self._tick, second=0
        )

        if self.source_sensor:
            self._unsub_source = self.hass.bus.async_listen(
                EVENT_STATE_CHANGED, self._handle_source_change
            )

        self._dispatch()

    async def async_shutdown(self) -> None:
        if self._unsub_reset:
            self._unsub_reset()
        if self._unsub_source:
            self._unsub_source()
        if self._unsub_pace:
            self._unsub_pace()
        await self._save()

    @callback
    def _tick(self, _now: datetime) -> None:
        self._dispatch()

    @callback
    def _scheduled_reset(self, _now: datetime) -> None:
        self.hass.async_create_task(self.async_reset_today())

    async def _maybe_daily_reset(self) -> None:
        today = dt_util.now().date().isoformat()
        if self.last_reset_date != today:
            self.consumed_ml = 0.0
            self.last_reset_date = today
            self._last_source_value = None
            await self._save()

    async def async_reset_today(self) -> None:
        self.consumed_ml = 0.0
        self.last_reset_date = dt_util.now().date().isoformat()
        self._last_source_value = None
        await self._save()
        self._dispatch()

    async def async_add_drink(self, volume: float, unit: str) -> None:
        await self._maybe_daily_reset()
        self.consumed_ml = max(0.0, self.consumed_ml + to_ml(float(volume), unit))
        await self._save()
        self._dispatch()

    async def async_set_consumed(self, volume: float, unit: str) -> None:
        await self._maybe_daily_reset()
        self.consumed_ml = max(0.0, to_ml(float(volume), unit))
        await self._save()
        self._dispatch()

    async def async_set_target_override(self, volume_ml: float) -> None:
        self.target_override_ml = max(0.0, float(volume_ml))
        await self._save()
        self._dispatch()

    async def _handle_source_change(self, event) -> None:
        data = event.data
        if data.get("entity_id") != self.source_sensor:
            return
        new_state = data.get("new_state")
        if new_state is None or new_state.state in ("unknown", "unavailable", None):
            return
        try:
            value = float(new_state.state)
        except (TypeError, ValueError):
            return
        # Treat source state as mL by default; if its unit is L, convert.
        unit_attr = new_state.attributes.get("unit_of_measurement", "").lower()
        if unit_attr in ("l", "liter", "liters", "litre", "litres"):
            value = value * 1000.0
        elif unit_attr in ("fl_oz", "floz", "oz"):
            value = value * 29.5735

        await self._maybe_daily_reset()

        if self.source_mode == SOURCE_MODE_ABSOLUTE:
            self.consumed_ml = max(0.0, value)
        else:
            # Delta mode: add positive deltas only.
            if self._last_source_value is not None and value >= self._last_source_value:
                delta = value - self._last_source_value
                if delta > 0:
                    self.consumed_ml = max(0.0, self.consumed_ml + delta)
            self._last_source_value = value

        await self._save()
        self._dispatch()

    async def _save(self) -> None:
        await self._store.async_save(
            {
                "consumed_ml": self.consumed_ml,
                "last_reset_date": self.last_reset_date,
                "target_override_ml": self.target_override_ml,
                "last_source_value": self._last_source_value,
            }
        )

    @callback
    def _dispatch(self) -> None:
        async_dispatcher_send(self.hass, self.signal)
