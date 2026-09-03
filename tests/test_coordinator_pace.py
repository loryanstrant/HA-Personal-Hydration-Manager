"""`hourly_pace_ml` across the day_start -> day_end window.

The window drives the required rate and nothing else. It does not gate what
counts — that is `test_coordinator_reset.py`.
"""
from datetime import datetime

import pytest

DAY_START = "07:00:00"
DAY_END = "23:00:00"
TARGET = 2000.0


@pytest.fixture
async def paced(make_coordinator):
    """A 07:00-23:00 window (16 h) with a 2000 mL target."""
    coordinator = make_coordinator(day_start=DAY_START, day_end=DAY_END)
    await coordinator.async_set_target_override(TARGET)
    return coordinator


def at(freezer, hhmm):
    freezer.move_to(datetime.fromisoformat(f"2026-09-03T{hhmm}+00:00"))


async def test_before_the_window_is_the_steady_rate_across_it(freezer, paced):
    at(freezer, "06:00:00")
    # 2000 mL over the 16 h window.
    assert paced.hourly_pace_ml == 125.0


async def test_before_the_window_accounts_for_water_already_drunk(freezer, paced):
    at(freezer, "03:00:00")
    await paced.async_add_drink(500, "mL")
    # A 3am glass counts, so the day needs less: 1500 over 16 h.
    assert paced.hourly_pace_ml == 93.8


async def test_inside_the_window_is_the_rate_needed_to_finish(freezer, paced):
    at(freezer, "15:00:00")
    await paced.async_set_consumed(1000, "mL")
    # 1000 mL remaining over the 8 h left.
    assert paced.hourly_pace_ml == 125.0


async def test_inside_the_window_climbs_when_behind(freezer, paced):
    at(freezer, "15:00:00")
    await paced.async_set_consumed(200, "mL")
    assert paced.hourly_pace_ml == 225.0  # 1800 / 8


async def test_the_window_boundary_is_continuous(freezer, paced):
    at(freezer, "06:59:59")
    before = paced.hourly_pace_ml
    at(freezer, "07:00:00")
    assert paced.hourly_pace_ml == before


async def test_after_the_window_returns_the_outstanding_volume(freezer, paced):
    at(freezer, "23:30:00")
    await paced.async_set_consumed(1000, "mL")
    assert paced.hourly_pace_ml == paced.remaining_ml == 1000.0


async def test_the_last_quarter_hour_is_floored(freezer, paced):
    at(freezer, "22:55:00")
    await paced.async_set_consumed(1900, "mL")
    # hours_left floors at 0.25 rather than running away to infinity.
    assert paced.hourly_pace_ml == 400.0


async def test_an_inverted_window_does_not_divide_by_zero(freezer, make_coordinator):
    coordinator = make_coordinator(day_start="22:00:00", day_end="07:00:00")
    await coordinator.async_set_target_override(TARGET)
    at(freezer, "12:00:00")
    # No sensible rate exists, so it falls back to the outstanding volume.
    assert coordinator.hourly_pace_ml == 2000.0


async def test_an_empty_window_does_not_divide_by_zero(freezer, make_coordinator):
    coordinator = make_coordinator(day_start="09:00:00", day_end="09:00:00")
    await coordinator.async_set_target_override(TARGET)
    at(freezer, "08:00:00")
    assert coordinator.hourly_pace_ml == 2000.0


async def test_a_met_target_paces_at_zero(freezer, paced):
    at(freezer, "06:00:00")
    await paced.async_set_consumed(TARGET, "mL")
    assert paced.hourly_pace_ml == 0.0
    at(freezer, "15:00:00")
    assert paced.hourly_pace_ml == 0.0


async def test_the_pace_sensor_publishes_the_window(freezer, paced):
    """So an automation can read the real window instead of hardcoding hours."""
    from custom_components.personal_hydration_manager.sensor import HourlyPaceSensor

    at(freezer, "15:00:00")
    await paced.async_set_consumed(1000, "mL")
    attrs = HourlyPaceSensor(paced).extra_state_attributes

    assert attrs["day_start"] == DAY_START
    assert attrs["day_end"] == DAY_END
    assert attrs["pace_ml_per_h"] == 125.0
