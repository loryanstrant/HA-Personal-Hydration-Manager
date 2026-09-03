"""The daily reset happens at local midnight, not at day_start.

That is the boundary `_maybe_daily_reset` already keys off, and it matches the
rollover of a source sensor that counts a calendar day — so the two totals agree
instead of drifting for the hours between midnight and day_start.
"""
from datetime import datetime
from unittest.mock import patch

from .conftest import emit_source


async def test_the_reset_is_scheduled_at_midnight(make_coordinator):
    coordinator = make_coordinator(day_start="07:00:00")
    with patch(
        "custom_components.personal_hydration_manager.coordinator"
        ".async_track_time_change"
    ) as track:
        await coordinator.async_initialize()

    reset_call = track.call_args_list[0]
    assert reset_call.kwargs == {"hour": 0, "minute": 0, "second": 0}
    assert reset_call.args[1] == coordinator._scheduled_reset
    await coordinator.async_shutdown()


async def test_day_start_no_longer_schedules_anything(make_coordinator):
    """Regression guard: day_start is a pacing window, not a reset trigger."""
    coordinator = make_coordinator(day_start="07:00:00")
    with patch(
        "custom_components.personal_hydration_manager.coordinator"
        ".async_track_time_change"
    ) as track:
        await coordinator.async_initialize()

    assert not any(c.kwargs.get("hour") == 7 for c in track.call_args_list)
    await coordinator.async_shutdown()


async def test_water_drunk_before_day_start_counts_towards_that_day(
    freezer, make_coordinator
):
    """A 3am glass lands on the day it happened, and is not swept away at 07:00."""
    coordinator = make_coordinator(day_start="07:00:00")
    await coordinator.async_initialize()

    freezer.move_to(datetime.fromisoformat("2026-09-03T03:00:00+00:00"))
    coordinator.last_reset_date = "2026-09-02"

    await coordinator.async_add_drink(500, "mL")
    assert coordinator.consumed_ml == 500.0
    assert coordinator.last_reset_date == "2026-09-03"

    # Reaching day_start does not wipe it.
    freezer.move_to(datetime.fromisoformat("2026-09-03T07:00:01+00:00"))
    await coordinator._maybe_daily_reset()
    assert coordinator.consumed_ml == 500.0
    await coordinator.async_shutdown()


async def test_crossing_midnight_rolls_the_day_over(hass, freezer, make_coordinator):
    coordinator = make_coordinator(day_start="07:00:00")
    await coordinator.async_initialize()

    freezer.move_to(datetime.fromisoformat("2026-09-03T22:00:00+00:00"))
    coordinator.last_reset_date = "2026-09-03"
    await coordinator.async_add_drink(500, "mL")
    assert coordinator.consumed_ml == 500.0

    freezer.move_to(datetime.fromisoformat("2026-09-04T00:30:00+00:00"))
    await coordinator._maybe_daily_reset()
    assert coordinator.consumed_ml == 0.0
    assert coordinator.last_reset_date == "2026-09-04"
    await coordinator.async_shutdown()
