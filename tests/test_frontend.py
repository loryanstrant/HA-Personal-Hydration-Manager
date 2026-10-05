"""Regression tests for deterministic Lovelace card registration.

The card must have exactly one loader. Loading it first as a frontend extra module
can run it against Home Assistant's temporary bootstrap custom-element registry;
when HA swaps registries, the console banner remains but the card definition is
lost. Re-importing the same URL as a Lovelace resource then hits the browser's
module cache and does not execute the bundle again.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from custom_components.personal_hydration_manager import frontend


class FakeResources:
    """Minimal storage-mode Lovelace resource collection."""

    def __init__(self, items=(), *, loaded=True, create_barrier=None):
        self.loaded = loaded
        self._items = [dict(item) for item in items]
        self._create_barrier = create_barrier
        self.async_load = AsyncMock(side_effect=self._load)
        self.async_create_item = AsyncMock(side_effect=self._create)
        self.async_update_item = AsyncMock(side_effect=self._update)
        self.async_delete_item = AsyncMock(side_effect=self._delete)

    async def _load(self):
        self.loaded = True

    async def _create(self, payload):
        if self._create_barrier is not None:
            self._create_barrier.set()
            await asyncio.sleep(0)
        self._items.append({"id": f"created-{len(self._items)}", **payload})

    async def _update(self, item_id, payload):
        item = next(item for item in self._items if item["id"] == item_id)
        item.update(payload)

    async def _delete(self, item_id):
        self._items = [item for item in self._items if item["id"] != item_id]

    def async_items(self):
        return tuple(self._items)


@pytest.fixture
def fake_hass(monkeypatch):
    hass = SimpleNamespace(
        data={},
        http=SimpleNamespace(async_register_static_paths=AsyncMock()),
    )
    monkeypatch.setattr(Path, "is_file", lambda _self: True)
    monkeypatch.setattr(frontend, "add_extra_js_url", Mock())
    return hass


@pytest.mark.asyncio
async def test_storage_mode_uses_only_lovelace_resource(fake_hass):
    """Never execute the same module through the bootstrap extra-module path."""
    resources = FakeResources()
    fake_hass.data["lovelace"] = SimpleNamespace(resources=resources)

    await frontend.async_register_frontend(fake_hass)

    frontend.add_extra_js_url.assert_not_called()
    resources.async_create_item.assert_awaited_once_with(
        {"res_type": "module", "url": frontend.CARD_URL_VERSIONED}
    )


@pytest.mark.asyncio
async def test_yaml_mode_uses_extra_module_once(fake_hass):
    """YAML mode has no resource collection, so it needs the fallback loader."""
    yaml_resources = SimpleNamespace(async_items=lambda: ())
    fake_hass.data["lovelace"] = SimpleNamespace(resources=yaml_resources)

    await frontend.async_register_frontend(fake_hass)
    await frontend.async_register_frontend(fake_hass)

    frontend.add_extra_js_url.assert_called_once_with(
        fake_hass, frontend.CARD_URL_VERSIONED
    )


@pytest.mark.asyncio
async def test_cold_start_registers_one_lovelace_ready_callback(fake_hass, monkeypatch):
    """Global setup plus profile setup must not queue duplicate callbacks."""
    callbacks = []
    monkeypatch.setattr(
        frontend,
        "async_when_setup",
        lambda _hass, component, callback: callbacks.append((component, callback)),
    )

    await frontend.async_register_frontend(fake_hass)
    await frontend.async_register_frontend(fake_hass)

    assert len(callbacks) == 1
    assert callbacks[0][0] == "lovelace"

    resources = FakeResources()
    fake_hass.data["lovelace"] = SimpleNamespace(resources=resources)
    await callbacks[0][1](fake_hass, "lovelace")

    resources.async_create_item.assert_awaited_once()
    assert frontend._DATA_LOVELACE_WAIT not in fake_hass.data


@pytest.mark.asyncio
async def test_concurrent_storage_registration_creates_one_resource(fake_hass):
    """Multiple profile setups can race, but persistence must stay idempotent."""
    create_started = asyncio.Event()
    resources = FakeResources(create_barrier=create_started)
    fake_hass.data["lovelace"] = SimpleNamespace(resources=resources)

    first = asyncio.create_task(frontend.async_register_frontend(fake_hass))
    await create_started.wait()
    second = asyncio.create_task(frontend.async_register_frontend(fake_hass))
    await asyncio.gather(first, second)

    hydration = [
        item
        for item in resources.async_items()
        if item["url"].split("?", 1)[0] == frontend.CARD_URL
    ]
    assert len(hydration) == 1
    resources.async_create_item.assert_awaited_once()


@pytest.mark.asyncio
async def test_storage_resource_is_loaded_updated_and_deduplicated(fake_hass):
    """A stale URL and duplicate entry converge to one current module resource."""
    resources = FakeResources(
        [
            {"id": "keep", "url": f"{frontend.CARD_URL}?v=0.3.0", "res_type": "module"},
            {"id": "duplicate", "url": frontend.CARD_URL, "res_type": "module"},
            {"id": "other", "url": "/local/other-card.js", "res_type": "module"},
        ],
        loaded=False,
    )
    fake_hass.data["lovelace"] = SimpleNamespace(resources=resources)

    await frontend.async_register_frontend(fake_hass)

    resources.async_load.assert_awaited_once_with()
    hydration = [
        item
        for item in resources.async_items()
        if item["url"].split("?", 1)[0] == frontend.CARD_URL
    ]
    assert hydration == [
        {"id": "keep", "url": frontend.CARD_URL_VERSIONED, "res_type": "module"}
    ]
    resources.async_delete_item.assert_awaited_once_with("duplicate")


@pytest.mark.asyncio
async def test_storage_load_failure_does_not_abort_integration_setup(fake_hass, caplog):
    """An unavailable optional Lovelace store must not fail the integration."""
    resources = FakeResources(loaded=False)
    resources.async_load.side_effect = RuntimeError("store unavailable")
    fake_hass.data["lovelace"] = SimpleNamespace(resources=resources)

    await frontend.async_register_frontend(fake_hass)

    resources.async_create_item.assert_not_awaited()
    assert "Could not register Lovelace resource: store unavailable" in caplog.text
