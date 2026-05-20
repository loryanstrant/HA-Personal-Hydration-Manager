"""Constants and NASEM Adequate Intake table for Personal Hydration Manager."""
from __future__ import annotations

DOMAIN = "personal_hydration_manager"
PLATFORMS = ["sensor", "number"]

# Short prefix for entity IDs (e.g. sensor.phm_alex_consumed_today).
# Keeps profile entities grouped and easy to filter in the entity list.
ENTITY_ID_PREFIX = "phm"

CONF_NAME = "name"
CONF_AGE = "age"
CONF_GENDER = "gender"
CONF_PREGNANCY = "pregnancy"
CONF_LACTATION = "lactation"
CONF_DAY_START = "day_start"
CONF_DAY_END = "day_end"
CONF_SOURCE_SENSOR = "source_sensor"
CONF_SOURCE_MODE = "source_mode"
CONF_UNIT = "unit"

GENDER_MALE = "male"
GENDER_FEMALE = "female"
GENDERS = [GENDER_MALE, GENDER_FEMALE]

SOURCE_MODE_DELTA = "delta"
SOURCE_MODE_SUM = "sum"
SOURCE_MODE_ABSOLUTE = "absolute"
# Order here drives the dropdown order in the config flow.
SOURCE_MODES = [SOURCE_MODE_ABSOLUTE, SOURCE_MODE_DELTA, SOURCE_MODE_SUM]

DEFAULT_DAY_START = "07:00:00"
DEFAULT_DAY_END = "22:00:00"

EVENT_DRINK = "personal_hydration_manager_drink"

SERVICE_LOG_DRINK = "log_drink"
SERVICE_RESET_TODAY = "reset_today"
SERVICE_SET_CONSUMED = "set_consumed"

UNIT_ML = "mL"
UNIT_L = "L"
UNIT_FL_OZ = "fl_oz"
UNITS = [UNIT_ML, UNIT_L, UNIT_FL_OZ]

ATTR_PROFILE = "profile"
ATTR_VOLUME = "volume"
ATTR_UNIT = "unit"

STORAGE_VERSION = 1
STORAGE_KEY_FMT = "personal_hydration_manager.{entry_id}"

SIGNAL_UPDATE_FMT = "personal_hydration_manager_update_{entry_id}"

# NASEM Adequate Intake for Total Beverages (mL/day).
# Source: Institute of Medicine (US) Panel on Dietary Reference Intakes for
# Electrolytes and Water. Dietary Reference Intakes for Water, Potassium,
# Sodium, Chloride, and Sulfate. National Academies Press, 2005.
# Values represent liquid-only intake; the ~20% of water from food is excluded.
NASEM_TABLE: list[tuple[int, int, str | None, int]] = [
    (1, 3, None, 900),
    (4, 8, None, 1200),
    (9, 13, GENDER_MALE, 1900),
    (9, 13, GENDER_FEMALE, 1600),
    (14, 18, GENDER_MALE, 2600),
    (14, 18, GENDER_FEMALE, 1800),
    (19, 200, GENDER_MALE, 3000),
    (19, 200, GENDER_FEMALE, 2200),
]

PREGNANCY_TARGET_ML = 2400
LACTATION_TARGET_ML = 3000
FALLBACK_TARGET_ML = 2200


def calculate_nasem_target(
    age: int, gender: str, pregnancy: bool, lactation: bool
) -> int:
    """Return the NASEM AI daily target in millilitres."""
    if lactation:
        return LACTATION_TARGET_ML
    if pregnancy:
        return PREGNANCY_TARGET_ML
    for min_age, max_age, row_gender, target in NASEM_TABLE:
        if min_age <= age <= max_age and (row_gender is None or row_gender == gender):
            return target
    return FALLBACK_TARGET_ML


def to_ml(volume: float, unit: str) -> float:
    """Convert a volume in any supported unit to millilitres."""
    if unit == UNIT_L:
        return volume * 1000.0
    if unit == UNIT_FL_OZ:
        return volume * 29.5735
    return volume


def from_ml(volume_ml: float, unit: str) -> float:
    """Convert millilitres to the chosen display unit."""
    if unit == UNIT_L:
        return volume_ml / 1000.0
    if unit == UNIT_FL_OZ:
        return volume_ml / 29.5735
    return volume_ml


def unit_label(unit: str) -> str:
    """Human-readable label for a unit value."""
    if unit == UNIT_FL_OZ:
        return "fl oz"
    return unit  # mL or L

def pace_unit_label(unit: str) -> str:
    """Per-hour label for the hourly pace sensor."""
    return f"{unit_label(unit)}/h"
