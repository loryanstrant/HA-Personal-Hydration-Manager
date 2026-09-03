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
    SOURCE_MODE_SUM,
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
        # Running total of manual additions (log_drink / quick-add / set_consumed).
        # Always tracked so the user can see how much they've logged by hand,
        # but only used as a contributor to consumed_ml in SOURCE_MODE_SUM.
        self.manual_consumed_ml: float = 0.0
        self.last_reset_date: str = dt_util.now().date().isoformat()
        self.target_override_ml: float = 0.0
        # In delta mode this is the previous reading for delta calculation.
        # In sum mode this is the latest known external reading. Survives
        # bottle dropouts so the total holds steady at the last-known-good
        # value until the next update.
        self._last_source_value: float | None = None
        # Sum mode only: the source's reading at the last reset. The source is
        # an absolute daily counter, so what it contributes today is how far it
        # has moved since the reset — not its whole total. Without this, any
        # reset is undone by the very next source update.
        self._source_baseline_ml: float = 0.0

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
        """Recommended mL/h across the day_start -> day_end window.

        The window is what the pace is *for*: it describes the hours you want to
        drink across, and nothing else. It does not gate what counts — water
        drunk outside it still lands on the calendar day it happened.

        Before the window opens: the steady rate that would carry you across the
        whole window. Inside it: the rate needed to finish by day_end, so it
        climbs if you fall behind. Past day_end there is no rate left to quote,
        so it returns the outstanding volume for the card's "catch up: X mL".
        """
        now = dt_util.now()
        start_dt = now.replace(
            hour=self.day_start.hour,
            minute=self.day_start.minute,
            second=self.day_start.second,
            microsecond=0,
        )
        end_dt = now.replace(
            hour=self.day_end.hour,
            minute=self.day_end.minute,
            second=self.day_end.second,
            microsecond=0,
        )
        if end_dt <= start_dt:
            # Empty or inverted window (an overnight window is not modelled).
            # Fall back to the catch-up figure rather than dividing by <= 0.
            return round(self.remaining_ml, 1)
        if now >= end_dt:
            # Day is over — pace would be infinite. Return remaining as-is
            # so the card can say "catch up: X mL".
            return round(self.remaining_ml, 1)
        if now < start_dt:
            window_hours = (end_dt - start_dt).total_seconds() / 3600
            return round(self.remaining_ml / window_hours, 1)
        hours_left = max((end_dt - now).total_seconds() / 3600, 0.25)
        return round(self.remaining_ml / hours_left, 1)

    async def async_initialize(self) -> None:
        """Load persisted state, schedule resets, attach source sensor."""
        stored: dict[str, Any] | None = await self._store.async_load()
        if stored:
            self.consumed_ml = float(stored.get("consumed_ml", 0.0))
            self.manual_consumed_ml = float(stored.get("manual_consumed_ml", 0.0))
            self.last_reset_date = stored.get(
                "last_reset_date", dt_util.now().date().isoformat()
            )
            self.target_override_ml = float(stored.get("target_override_ml", 0.0))
            self._last_source_value = stored.get("last_source_value")
            # Absent in stores written before 0.4.0. Defaulting to 0 reproduces
            # the old arithmetic for one day rather than guessing: on load we
            # cannot tell a legitimately-counted source total from a re-imported
            # one, and guessing wrong would delete real water. The next reset
            # establishes the true baseline.
            self._source_baseline_ml = float(stored.get("source_baseline") or 0.0)

        # Catch up on any missed daily reset.
        await self._maybe_daily_reset()

        # Schedule the daily reset at local midnight. This is the calendar-day
        # boundary _maybe_daily_reset already keys off, and it matches the
        # rollover of source sensors that count a day (a smart bottle), so the
        # two totals agree. day_start is a pacing window, not a reset trigger.
        self._unsub_reset = async_track_time_change(
            self.hass,
            self._scheduled_reset,
            hour=0,
            minute=0,
            second=0,
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

    def _reset_state(self) -> None:
        """Zero today's counters. The single definition of what a reset means.

        Both reset paths call this. They used to carry their own copy, and the
        copies had to agree about _last_source_value — which is exactly where
        the sum-mode re-import bug lived.
        """
        self.consumed_ml = 0.0
        self.manual_consumed_ml = 0.0
        self.last_reset_date = dt_util.now().date().isoformat()
        if self.source_mode == SOURCE_MODE_SUM:
            # Hold on to the reading and move the baseline up to it, so the
            # source contributes only what it counts from here on. Clearing the
            # reading instead would make the next update re-import the source's
            # whole daily total and undo this reset.
            self._source_baseline_ml = self._last_source_value or 0.0
        else:
            # Delta mode needs the next reading to rebaseline silently rather
            # than arrive as one large delta; absolute mode overwrites anyway.
            self._last_source_value = None
            self._source_baseline_ml = 0.0

    async def _maybe_daily_reset(self) -> None:
        today = dt_util.now().date().isoformat()
        if self.last_reset_date != today:
            self._reset_state()
            await self._save()

    async def async_reset_today(self) -> None:
        self._reset_state()
        await self._save()
        self._dispatch()

    def _source_contribution_ml(self) -> float:
        """How much the source sensor contributes today, in sum mode.

        The source is an absolute daily counter, so its contribution is how far
        it has moved since the baseline set at the last reset — never its whole
        total, and never negative.
        """
        return max(0.0, (self._last_source_value or 0.0) - self._source_baseline_ml)

    def _recompute_sum_consumed(self) -> None:
        """Refresh consumed_ml from manual + external in sum mode."""
        self.consumed_ml = max(
            0.0, self.manual_consumed_ml + self._source_contribution_ml()
        )

    async def async_add_drink(self, volume: float, unit: str) -> None:
        await self._maybe_daily_reset()
        added_ml = to_ml(float(volume), unit)
        # Manual sensor mirrors every hand-entered drink regardless of mode —
        # useful as transparency in delta/absolute and load-bearing in sum.
        self.manual_consumed_ml = max(0.0, self.manual_consumed_ml + added_ml)
        if self.source_mode == SOURCE_MODE_SUM:
            self._recompute_sum_consumed()
        else:
            self.consumed_ml = max(0.0, self.consumed_ml + added_ml)
        await self._save()
        self._dispatch()

    async def async_set_consumed(self, volume: float, unit: str) -> None:
        await self._maybe_daily_reset()
        target_ml = max(0.0, to_ml(float(volume), unit))
        if self.source_mode == SOURCE_MODE_SUM:
            # Solve for manual so that manual + external == target.
            self.manual_consumed_ml = max(
                0.0, target_ml - self._source_contribution_ml()
            )
            self._recompute_sum_consumed()
        else:
            self.consumed_ml = target_ml
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
            self._last_source_value = value
        elif self.source_mode == SOURCE_MODE_SUM:
            # Sum mode: the source's movement since the baseline is added to
            # manual_consumed_ml. Holding _last_source_value at the latest known
            # value means a bottle dropout leaves the total unchanged until it
            # reports again, which is exactly the resilience the user is after.
            self._last_source_value = value
            if value < self._source_baseline_ml:
                # The source rolled over its own day, or was reset or replaced.
                # Everything it reports from here is new water.
                self._source_baseline_ml = 0.0
            self._recompute_sum_consumed()
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
                "manual_consumed_ml": self.manual_consumed_ml,
                "last_reset_date": self.last_reset_date,
                "target_override_ml": self.target_override_ml,
                "last_source_value": self._last_source_value,
                "source_baseline": self._source_baseline_ml,
            }
        )

    @callback
    def _dispatch(self) -> None:
        async_dispatcher_send(self.hass, self.signal)
