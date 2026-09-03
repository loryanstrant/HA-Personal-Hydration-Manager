"""Sum mode: the source contributes its movement, not its whole daily total.

The 2026-09-03 incident these lock down: PHM read 621 mL with nothing drunk and
nothing logged, because every reset cleared the last source reading and the next
update assigned it straight back — re-adopting the source sensor's entire day.
See DECISIONS.md.
"""
import pytest

from custom_components.personal_hydration_manager.const import (
    SOURCE_MODE_ABSOLUTE,
    SOURCE_MODE_DELTA,
    SOURCE_MODE_SUM,
    STORAGE_KEY_FMT,
    STORAGE_VERSION,
)
from custom_components.personal_hydration_manager.coordinator import (
    HydrationCoordinator,
)

from .conftest import emit_source, restart_source_entity


@pytest.fixture
async def sum_coordinator(make_coordinator):
    coordinator = make_coordinator(source_mode=SOURCE_MODE_SUM)
    await coordinator.async_initialize()
    yield coordinator
    await coordinator.async_shutdown()


async def test_reset_survives_the_next_source_update(hass, sum_coordinator):
    """The incident. A reset must not be undone by the source reporting again."""
    await emit_source(hass, 621)
    assert sum_coordinator.consumed_ml == 621.0

    await sum_coordinator.async_reset_today()
    assert sum_coordinator.consumed_ml == 0.0

    # The bottle is still sitting at 621 and reports it again.
    await emit_source(hass, 621)
    assert sum_coordinator.consumed_ml == 0.0


async def test_reset_survives_an_ha_restart_replaying_the_source(hass, sum_coordinator):
    """The 09:01:18 event: the entity is re-created and re-reports 621."""
    await emit_source(hass, 621)
    await sum_coordinator.async_reset_today()

    await restart_source_entity(hass, 621)
    assert sum_coordinator.consumed_ml == 0.0


async def test_restart_of_the_integration_replays_from_the_store(hass, sum_coordinator):
    """The baseline is persisted, so a fresh coordinator does not re-import either."""
    await emit_source(hass, 621)
    await sum_coordinator.async_reset_today()
    await sum_coordinator.async_shutdown()

    # Same config entry, so the same Store key: this is HA restarting.
    reloaded = HydrationCoordinator(hass, sum_coordinator.entry)
    await reloaded.async_initialize()
    assert reloaded.consumed_ml == 0.0

    await restart_source_entity(hass, 621)
    assert reloaded.consumed_ml == 0.0
    await reloaded.async_shutdown()


async def test_only_movement_since_the_reset_counts(hass, sum_coordinator):
    await emit_source(hass, 621)
    await sum_coordinator.async_reset_today()

    await emit_source(hass, 871)
    assert sum_coordinator.consumed_ml == 250.0

    await emit_source(hass, 900)
    assert sum_coordinator.consumed_ml == 279.0


async def test_source_resetting_at_its_own_midnight_rebaselines(hass, sum_coordinator):
    """A source that rolls over its own day starts contributing from zero again."""
    await emit_source(hass, 621)
    await sum_coordinator.async_reset_today()

    # The bottle rolls its own day a moment after ours.
    await emit_source(hass, 0)
    assert sum_coordinator.consumed_ml == 0.0

    await emit_source(hass, 300)
    assert sum_coordinator.consumed_ml == 300.0


async def test_contribution_never_goes_negative(hass, sum_coordinator):
    await emit_source(hass, 621)
    await sum_coordinator.async_reset_today()

    # Below the baseline but not a clean zero — a replaced or partially reset
    # source. It rebaselines rather than subtracting.
    await emit_source(hass, 100)
    assert sum_coordinator.consumed_ml == 100.0


async def test_manual_and_source_add_up(hass, sum_coordinator):
    await emit_source(hass, 621)
    await sum_coordinator.async_reset_today()

    await sum_coordinator.async_add_drink(250, "mL")
    assert sum_coordinator.consumed_ml == 250.0

    await emit_source(hass, 821)
    assert sum_coordinator.consumed_ml == 450.0
    assert sum_coordinator.manual_consumed_ml == 250.0


async def test_set_consumed_solves_against_the_baselined_contribution(
    hass, sum_coordinator
):
    await emit_source(hass, 621)
    await sum_coordinator.async_reset_today()
    await emit_source(hass, 821)  # source contributes 200

    await sum_coordinator.async_set_consumed(500, "mL")
    assert sum_coordinator.consumed_ml == 500.0
    assert sum_coordinator.manual_consumed_ml == 300.0

    # And the total holds when the source moves again.
    await emit_source(hass, 871)
    assert sum_coordinator.consumed_ml == 550.0


async def test_dropout_holds_the_total_steady(hass, sum_coordinator):
    """Unavailable readings are ignored, not treated as zero."""
    await emit_source(hass, 621)
    await sum_coordinator.async_reset_today()
    await emit_source(hass, 871)

    await emit_source(hass, "unavailable")
    assert sum_coordinator.consumed_ml == 250.0
    await emit_source(hass, "unknown")
    assert sum_coordinator.consumed_ml == 250.0


async def test_store_written_before_0_4_0_loads_without_a_baseline(
    hass, hass_storage, make_coordinator
):
    """Back-compat: no baseline key means 0, reproducing the old arithmetic."""
    coordinator = make_coordinator(source_mode=SOURCE_MODE_SUM)
    hass_storage[STORAGE_KEY_FMT.format(entry_id=coordinator.entry_id)] = {
        "version": STORAGE_VERSION,
        "data": {
            "consumed_ml": 621.0,
            "manual_consumed_ml": 0.0,
            "last_reset_date": coordinator.last_reset_date,
            "target_override_ml": 0.0,
            "last_source_value": 621.0,
        },
    }

    await coordinator.async_initialize()
    assert coordinator.consumed_ml == 621.0

    # ...and the next reset establishes the real baseline, so it self-heals.
    await coordinator.async_reset_today()
    await emit_source(hass, 621)
    assert coordinator.consumed_ml == 0.0
    await coordinator.async_shutdown()


async def test_delta_mode_is_unchanged(hass, make_coordinator):
    coordinator = make_coordinator(source_mode=SOURCE_MODE_DELTA)
    await coordinator.async_initialize()

    await emit_source(hass, 100)  # first reading only rebaselines
    assert coordinator.consumed_ml == 0.0
    await emit_source(hass, 350)
    assert coordinator.consumed_ml == 250.0

    await coordinator.async_reset_today()
    await emit_source(hass, 400)  # rebaseline after reset, no spurious delta
    assert coordinator.consumed_ml == 0.0
    await emit_source(hass, 500)
    assert coordinator.consumed_ml == 100.0
    await coordinator.async_shutdown()


async def test_absolute_mode_is_unchanged(hass, make_coordinator):
    coordinator = make_coordinator(source_mode=SOURCE_MODE_ABSOLUTE)
    await coordinator.async_initialize()

    await emit_source(hass, 621)
    assert coordinator.consumed_ml == 621.0
    await emit_source(hass, 900)
    assert coordinator.consumed_ml == 900.0
    await coordinator.async_shutdown()
