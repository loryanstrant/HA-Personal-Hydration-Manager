"""Config flow for Personal Hydration Manager."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers import selector

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
    DOMAIN,
    GENDERS,
    SOURCE_MODE_ABSOLUTE,
    SOURCE_MODES,
    UNIT_FL_OZ,
    UNIT_L,
    UNIT_ML,
)

# Inlined to survive partial HACS updates — if a deploy lands the new
# config_flow.py before const.py is refreshed, importing CONF_UNIT from
# const would fail and HA would refuse to load the handler with
# "Invalid handler specified".
CONF_UNIT = "unit"


def _profile_schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    d = defaults or {}
    schema: dict[Any, Any] = {
        vol.Required(CONF_NAME, default=d.get(CONF_NAME, "")): str,
        vol.Required(CONF_AGE, default=d.get(CONF_AGE, 30)): selector.NumberSelector(
            selector.NumberSelectorConfig(
                min=1, max=120, step=1, mode=selector.NumberSelectorMode.BOX
            )
        ),
        vol.Required(CONF_GENDER, default=d.get(CONF_GENDER, "female")): selector.SelectSelector(
            selector.SelectSelectorConfig(
                options=GENDERS,
                translation_key="gender",
                mode=selector.SelectSelectorMode.DROPDOWN,
            )
        ),
        vol.Optional(CONF_PREGNANCY, default=d.get(CONF_PREGNANCY, False)): bool,
        vol.Optional(CONF_LACTATION, default=d.get(CONF_LACTATION, False)): bool,
        vol.Required(CONF_DAY_START, default=d.get(CONF_DAY_START, DEFAULT_DAY_START)): selector.TimeSelector(),
        vol.Required(CONF_DAY_END, default=d.get(CONF_DAY_END, DEFAULT_DAY_END)): selector.TimeSelector(),
    }

    # Optional source sensor: only attach a default when one is actually
    # configured. An empty-string default fails EntitySelector validation
    # ("Entity is neither a valid entity ID nor a valid UUID").
    existing_source = d.get(CONF_SOURCE_SENSOR)
    if existing_source:
        schema[vol.Optional(CONF_SOURCE_SENSOR, default=existing_source)] = (
            selector.EntitySelector(selector.EntitySelectorConfig(domain="sensor"))
        )
    else:
        schema[vol.Optional(CONF_SOURCE_SENSOR)] = selector.EntitySelector(
            selector.EntitySelectorConfig(domain="sensor")
        )

    schema[
        vol.Optional(CONF_SOURCE_MODE, default=d.get(CONF_SOURCE_MODE, SOURCE_MODE_ABSOLUTE))
    ] = selector.SelectSelector(
        selector.SelectSelectorConfig(
            options=SOURCE_MODES,
            translation_key="source_mode",
            mode=selector.SelectSelectorMode.DROPDOWN,
        )
    )

    # Inline labels (not translation_key) because hassfest forbids the
    # uppercase 'mL'/'L' keys we use as canonical unit strings.
    schema[
        vol.Required(CONF_UNIT, default=d.get(CONF_UNIT, UNIT_ML))
    ] = selector.SelectSelector(
        selector.SelectSelectorConfig(
            options=[
                selector.SelectOptionDict(value=UNIT_ML, label="Millilitres (mL)"),
                selector.SelectOptionDict(value=UNIT_L, label="Litres (L)"),
                selector.SelectOptionDict(value=UNIT_FL_OZ, label="Fluid ounces (fl oz)"),
            ],
            mode=selector.SelectSelectorMode.DROPDOWN,
        )
    )

    return vol.Schema(schema)


class HydrationConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Initial setup flow — one config entry per person."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            name = user_input[CONF_NAME].strip()
            await self.async_set_unique_id(f"{DOMAIN}_{name.lower().replace(' ', '_')}")
            self._abort_if_unique_id_configured()
            if not user_input.get(CONF_SOURCE_SENSOR):
                user_input.pop(CONF_SOURCE_SENSOR, None)
            return self.async_create_entry(title=name, data=user_input)

        return self.async_show_form(
            step_id="user", data_schema=_profile_schema(), errors=errors
        )

    @staticmethod
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> "HydrationOptionsFlow":
        return HydrationOptionsFlow(config_entry)


class HydrationOptionsFlow(config_entries.OptionsFlow):
    """Edit an existing profile."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self.config_entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.FlowResult:
        if user_input is not None:
            if not user_input.get(CONF_SOURCE_SENSOR):
                user_input.pop(CONF_SOURCE_SENSOR, None)
            return self.async_create_entry(title="", data=user_input)

        merged = {**self.config_entry.data, **self.config_entry.options}
        return self.async_show_form(step_id="init", data_schema=_profile_schema(merged))
