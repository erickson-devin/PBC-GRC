"""Stdlib validator for the ingest contract (contract/ingest.schema.json).

It mirrors server/vm/ingestSchema.ts, not textbook JSON Schema: same first-error order, same messages for unknown
fields / required fields / date-times / total findings / duplicate agent_id, lengths in UTF-16 code units (zod counts
JS string length), and a bool is never a number.
"""

import functools
import hashlib
import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

CONTRACT_PATH = Path(__file__).resolve().parent / "contract" / "ingest.schema.json"
MAX_TOTAL_FINDINGS = 50000

# Annotations are ignored; everything else must be in SUPPORTED_KEYWORDS or assert_supported_keywords raises, so a
# contract that gains a keyword (say minItems) fails the Python tests instead of being silently unchecked.
ANNOTATION_KEYWORDS = frozenset({"$schema", "$id", "title", "description"})
SUPPORTED_KEYWORDS = ANNOTATION_KEYWORDS | frozenset(
    {
        "type", "additionalProperties", "required", "properties", "const", "enum", "minLength", "maxLength",
        "pattern", "minimum", "maximum", "maxItems", "items", "$ref", "$defs", "format",
    }
)
_SCHEMA_MAP_KEYWORDS = ("properties", "$defs")

_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*\Z")
# ASCII [0-9] on purpose: Python's \d also matches other Unicode digits, the server's regex does not.
_RFC3339 = re.compile(
    r"\A([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})\Z"
)
DATE_TIME_MESSAGE = "not a valid date-time"


def contract_bytes() -> bytes:
    return CONTRACT_PATH.read_bytes()


def contract_sha256() -> str:
    return hashlib.sha256(contract_bytes()).hexdigest()


def load_contract() -> dict:
    return json.loads(contract_bytes().decode("utf-8"))


@functools.lru_cache(maxsize=1)
def _default_schema() -> dict:
    return load_contract()


def assert_supported_keywords(schema: dict) -> None:
    def walk(node: Any, where: str) -> None:
        if not isinstance(node, dict):
            raise ValueError(f"{where}: schema node is not an object")
        for key, value in node.items():
            if key not in SUPPORTED_KEYWORDS:
                raise ValueError(f"{where}: unsupported schema keyword {key!r}")
            if key == "additionalProperties" and value is not False:
                raise ValueError(f"{where}: only additionalProperties: false is supported")
            if key in _SCHEMA_MAP_KEYWORDS:
                for name, sub in value.items():
                    walk(sub, f"{where}/{key}/{name}")
            elif key == "items":
                walk(value, f"{where}/items")

    walk(schema, "#")


def format_json_path(path: Sequence[str | int]) -> str:
    out = "$"
    for seg in path:
        if isinstance(seg, int):
            out += f"[{seg}]"
        elif _IDENTIFIER.match(seg):
            out += f".{seg}"
        else:
            out += f"[{json.dumps(seg, ensure_ascii=False)}]"
    return out


def utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def parse_rfc3339(s: str) -> tuple[datetime, int, int] | None:
    """(local naive datetime, milliseconds, offset in minutes east of UTC) or None. No timezone arithmetic here."""
    m = _RFC3339.match(s)
    if not m:
        return None
    year, month, day, hour, minute, second = (int(m.group(i)) for i in range(1, 7))
    zone = m.group(8)
    offset = 0
    if zone != "Z":
        oh, om = int(zone[1:3]), int(zone[4:6])
        if oh > 23 or om > 59:
            return None
        offset = (oh * 60 + om) * (-1 if zone[0] == "-" else 1)
    try:
        local = datetime(year, month, day, hour, minute, second)
    except ValueError:
        return None
    millis = int(((m.group(7) or "") + "000")[:3])
    return local, millis, offset


def _is_number(v: Any) -> bool:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    try:
        return math.isfinite(v)
    except OverflowError:
        return False


_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "number": _is_number,
    "null": lambda v: v is None,
}


@functools.lru_cache(maxsize=None)
def _compile(pattern: str) -> re.Pattern:
    # Python's `$` also matches before a trailing newline, so "a\n" would pass the line pattern. \Z does not.
    if pattern.endswith("$") and not pattern.endswith("\\$"):
        pattern = pattern[:-1] + r"\Z"
    return re.compile(pattern)


def _resolve(schema: dict, root: dict) -> dict:
    ref = schema.get("$ref")
    if ref is None:
        return schema
    prefix = "#/$defs/"
    if not ref.startswith(prefix) or ref[len(prefix):] not in root.get("$defs", {}):
        raise ValueError(f"unsupported $ref {ref!r}")
    return root["$defs"][ref[len(prefix):]]


def _check(value: Any, schema: dict, path: list, root: dict) -> str | None:
    schema = _resolve(schema, root)
    here = format_json_path(path)

    types = schema.get("type")
    if types is not None:
        names = [types] if isinstance(types, str) else list(types)
        if not any(_TYPE_CHECKS[name](value) for name in names):
            return f"{here}: expected {' or '.join(names)}"

    if "const" in schema:
        c = schema["const"]
        if isinstance(value, bool) or not (value == c and type(value) in (type(c), float)):
            return f"{here}: must be {json.dumps(c)}"
    if "enum" in schema:
        if not any(type(value) is type(e) and value == e for e in schema["enum"]):
            return f"{here}: must be one of {', '.join(json.dumps(e) for e in schema['enum'])}"

    if isinstance(value, str):
        if "minLength" in schema and utf16_len(value) < schema["minLength"]:
            return f"{here}: must be at least {schema['minLength']} characters"
        if "maxLength" in schema and utf16_len(value) > schema["maxLength"]:
            return f"{here}: must be at most {schema['maxLength']} characters"
        if "pattern" in schema and not _compile(schema["pattern"]).search(value):
            return f"{here}: invalid format"
        if schema.get("format") == "date-time" and parse_rfc3339(value) is None:
            return f"{here}: {DATE_TIME_MESSAGE}"

    if _is_number(value):
        if "minimum" in schema and value < schema["minimum"]:
            return f"{here}: must be at least {schema['minimum']}"
        if "maximum" in schema and value > schema["maximum"]:
            return f"{here}: must be at most {schema['maximum']}"

    if isinstance(value, list):
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            return f"{here}: at most {schema['maxItems']} items"
        item_schema = schema.get("items")
        if item_schema is not None:
            for i, item in enumerate(value):
                err = _check(item, item_schema, path + [i], root)
                if err:
                    return err

    if isinstance(value, dict):
        props = schema.get("properties", {})
        required = schema.get("required", [])
        for key, sub in props.items():
            if key in value:
                err = _check(value[key], sub, path + [key], root)
                if err:
                    return err
            elif key in required:
                return f"{format_json_path(path + [key])}: required"
        for key in required:
            if key not in props and key not in value:
                return f"{format_json_path(path + [key])}: required"
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props:
                    return f"{format_json_path(path + [key])}: unknown field"
    return None


def validate_payload(obj: Any, schema: dict | None = None) -> str | None:
    """The first error as `$.path: message`, or None when the payload satisfies the contract."""
    root = schema if schema is not None else _default_schema()
    err = _check(obj, root, [], root)
    if err:
        return err
    hosts = obj["hosts"]
    total = sum(len(h["findings"]) for h in hosts)
    if total > MAX_TOTAL_FINDINGS:
        return f"$.hosts: at most {MAX_TOTAL_FINDINGS} findings in total"
    seen: dict[str, int] = {}
    for j, host in enumerate(hosts):
        agent = host["agent_id"]
        if agent in seen:
            return f"$.hosts[{j}].agent_id: duplicate agent_id (also at $.hosts[{seen[agent]}])"
        seen[agent] = j
    return None
