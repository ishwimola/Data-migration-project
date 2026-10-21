"""
Dataverse metadata service.

Fetches live CRM entity attributes and normalizes them into the same field
shape used by the local target_schema.json mapper.
"""

from __future__ import annotations

import re
from functools import lru_cache
from urllib.parse import urlparse

import msal
import requests

from app.config.settings import (
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET,
    AZURE_TENANT_ID,
    DATAVERSE_API_VERSION,
    DATAVERSE_METADATA_URL,
    DATAVERSE_URL,
)


class DataverseMetadataError(RuntimeError):
    """Raised when live Dataverse metadata cannot be loaded."""


def is_metadata_configured() -> bool:
    return all([get_dataverse_base_url(), AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID])


def get_dataverse_base_url() -> str:
    raw_url = DATAVERSE_URL or DATAVERSE_METADATA_URL
    if not raw_url:
        return ""

    parsed = urlparse(raw_url)
    if not parsed.scheme or not parsed.netloc:
        return raw_url.rstrip("/")

    return f"{parsed.scheme}://{parsed.netloc}"


def get_metadata_endpoint(entity_name: str) -> str:
    if DATAVERSE_METADATA_URL:
        return _normalize_version(DATAVERSE_METADATA_URL).rstrip("/")

    base_url = get_dataverse_base_url()
    api_version = _normalize_api_version(DATAVERSE_API_VERSION)
    return (
        f"{base_url}/api/data/{api_version}/"
        f"EntityDefinitions(LogicalName='{entity_name}')/Attributes"
    )


@lru_cache(maxsize=16)
def get_entity_fields(entity_name: str) -> list[dict]:
    if not is_metadata_configured():
        raise DataverseMetadataError("Dataverse metadata credentials are not configured.")

    endpoint = get_metadata_endpoint(entity_name)
    token = _get_access_token()

    response = requests.get(
        endpoint,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        },
        params={
            "$select": (
                "LogicalName,SchemaName,AttributeType,RequiredLevel,"
                "Description,DisplayName,IsValidForCreate,IsValidForUpdate,"
                "IsPrimaryId,IsLogical,AttributeOf"
            )
        },
        timeout=30,
    )

    if response.status_code >= 400:
        raise DataverseMetadataError(
            f"Dataverse metadata request failed: {response.status_code} {response.text[:300]}"
        )

    attributes = response.json().get("value", [])
    fields = [_normalize_attribute(attr) for attr in attributes]
    return [field for field in fields if field["mappable"]]


def _get_access_token() -> str:
    authority = f"https://login.microsoftonline.com/{AZURE_TENANT_ID}"
    scope = [f"{get_dataverse_base_url()}/.default"]

    app = msal.ConfidentialClientApplication(
        client_id=AZURE_CLIENT_ID,
        client_credential=AZURE_CLIENT_SECRET,
        authority=authority,
    )
    result = app.acquire_token_for_client(scopes=scope)

    if "access_token" not in result:
        error = result.get("error_description", result.get("error", "Unknown auth error"))
        raise DataverseMetadataError(f"Dataverse metadata authentication failed: {error}")

    return result["access_token"]


def _normalize_attribute(attribute: dict) -> dict:
    logical_name = attribute.get("LogicalName", "")
    display_name = _localized_label(attribute.get("DisplayName")) or attribute.get("SchemaName") or logical_name
    description = _localized_label(attribute.get("Description"))
    required_level = (attribute.get("RequiredLevel") or {}).get("Value", "")
    valid_for_create = bool(attribute.get("IsValidForCreate"))
    valid_for_update = bool(attribute.get("IsValidForUpdate"))
    is_primary_id = bool(attribute.get("IsPrimaryId"))
    is_logical = bool(attribute.get("IsLogical"))
    attribute_of = attribute.get("AttributeOf")
    read_only = not (valid_for_create or valid_for_update)

    return {
        "logical_name": logical_name,
        "display_name": display_name,
        "type": str(attribute.get("AttributeType", "")).lower(),
        "required": required_level in {"SystemRequired", "ApplicationRequired"},
        "mappable": not any([read_only, is_primary_id, is_logical, attribute_of]),
        "read_only": read_only,
        "max_length": None,           # attribute.get("MaxLength"),
        "confidence_boost": required_level in {"SystemRequired", "ApplicationRequired"},
        "description": description,
        "synonyms": _build_synonyms(logical_name, display_name),
    }


def _localized_label(label_container: dict | None) -> str:
    if not label_container:
        return ""

    user_label = label_container.get("UserLocalizedLabel")
    if user_label and user_label.get("Label"):
        return user_label["Label"]

    labels = label_container.get("LocalizedLabels") or []
    for label in labels:
        if label.get("Label"):
            return label["Label"]

    return ""


def _build_synonyms(logical_name: str, display_name: str) -> list[str]:

    # Common D365 field synonyms — maps logical_name to known aliases
    KNOWN_SYNONYMS = {
        "telephone1":            ["phone", "tel", "business phone", "office phone", "contact number", "phonenumber"],
        "telephone2":            ["phone2", "alternate phone", "secondary phone"],
        "mobilephone":           ["mobile", "cell", "cellphone", "mob", "mobile number"],
        "emailaddress1":         ["email", "mail", "email address", "e-mail"],
        "emailaddress2":         ["email2", "alternate email", "secondary email"],
        "websiteurl":            ["website", "web", "url", "site"],
        "address1_line1":        ["address", "street", "address line 1", "addr", "street address"],
        "address1_city":         ["city", "town"],
        "address1_stateorprovince": ["state", "province", "region"],
        "address1_postalcode":   ["zip", "postal code", "postcode", "pin", "pincode"],
        "address1_country":      ["country", "nation", "country name"],
        "name":                  ["company name", "account name", "org name", "organisation", "organization"],
        "accountnumber":         ["customer id", "account no", "cust id", "client id"],
        "revenue":               ["annual revenue", "turnover", "sales", "yearly revenue"],
        "numberofemployees":     ["employees", "headcount", "staff count", "team size", "no of employees"],
        "description":           ["notes", "comments", "remarks", "details"],
        "industrycode":          ["industry", "sector", "business type"],
        "firstname":             ["first name", "fname", "given name"],
        "lastname":              ["last name", "lname", "surname", "family name"],
        "jobtitle":              ["job title", "title", "designation", "position"],
        "parentaccountid":       ["parent company", "parent account", "parent org"],
        "ownerid":               ["owner", "assigned to", "account owner"],
        "createdon":             ["created date", "creation date", "date created"],
        "modifiedon":            ["modified date", "last updated", "update date"],
    }

    candidates = {
        logical_name,
        display_name,
        logical_name.replace("_", " "),
        _split_identifier(logical_name),
        _split_identifier(display_name),
    }

    # Add known synonyms if this field has them
    if logical_name in KNOWN_SYNONYMS:
        candidates.update(KNOWN_SYNONYMS[logical_name])


    return sorted({candidate.lower().strip() for candidate in candidates if candidate})


def _split_identifier(value: str) -> str:
    value = value.replace("_", " ")
    value = re.sub(r"(?<!^)(?=[A-Z])", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _normalize_api_version(version: str) -> str:
    version = version.strip().lower()
    if version in {"v9.x", "9.x"}:
        return "v9.2"
    if version.startswith("v"):
        return version
    return f"v{version}"


def _normalize_version(url: str) -> str:
    return url.replace("/v9.x/", "/v9.2/")
