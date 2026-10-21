"""
Dataverse Loader — loads clean data into D365 via OData $batch API.

Uses changesets for write operations (required by Dataverse).
Batch size capped at 100 to avoid connection drops on free-tier D365.
DNS resolved to IPv4 at startup to avoid Windows IPv6 issues.
"""

import json
import re
import socket
import time
import uuid
import logging
from typing import Callable, Optional
from urllib.parse import urlparse

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from app.config.settings import (
    DATAVERSE_URL,
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET,
    AZURE_TENANT_ID,
    D365_USERNAME,
    D365_PASSWORD,
    BATCH_SIZE,
    is_dataverse_configured,
)

logger = logging.getLogger(__name__)

# ── Token cache ───────────────────────────────────────────────────────────────
_token_cache: dict = {}

# ── Safe batch size — keep small to avoid Dataverse connection drops ──────────
# Non-changeset batches can be larger, but 20 is a safe starting point.
# Increase to 100 once confirmed working.
_SAFE_BATCH_SIZE = 20

# ── Resolve Dataverse hostname to IPv4 at import time (Windows IPv6 fix) ──────
def _resolve_base_url(url: str) -> str:
    """Replace hostname in URL with its first IPv4 address."""
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        infos = socket.getaddrinfo(hostname, 443, socket.AF_INET, socket.SOCK_STREAM)
        ipv4 = infos[0][4][0]
        # Rebuild with IPv4 but keep original hostname in Host header via session
        return url  # keep original URL — use resolved IP only for the session below
    except Exception:
        return url

# Build a session with retry + connection pooling
def _make_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["POST"],
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=8)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session

_session = _make_session()

# ── Entity field definitions ──────────────────────────────────────────────────
_ENTITY_EXCLUSIVE_FIELDS: dict[str, set] = {
    "account": {
        "name", "accountnumber", "accountcategorycode", "accountclassificationcode",
        "accountratingcode", "businesstypecode", "customersizecode", "customertypecode",
        "ownershipcode", "parentaccountid", "primarycontactid", "revenue",
        "numberofemployees", "industrycode", "sic", "stockexchange", "tickersymbol",
        "websiteurl", "department",
    },
    "contact": {
        "firstname", "lastname", "fullname", "middlename", "salutation",
        "birthdate", "gendercode", "familystatuscode", "educationcode",
        "parentcustomerid", "spousesname", "anniversary",
        "department", "jobtitle", "assistantname", "assistantphone",
        "managername", "managerphone",
    },
    "lead": {
        "firstname", "lastname", "fullname", "middlename", "salutation",
        "subject", "companyname", "jobtitle", "leadsourcecode",
        "prioritycode", "salesstagecode", "initialcommunication",
        "need", "purchasetimeframe", "estimatedvalue", "closeprobability",
        "qualificationcomments", "schedulecontactid",
        "department", "websiteurl", "industrycode", "numberofemployees", "revenue",
    },
}

_SHARED_FIELDS = {
    "emailaddress1", "emailaddress2", "emailaddress3",
    "telephone1", "telephone2", "telephone3", "mobilephone", "fax",
    "address1_line1", "address1_line2", "address1_line3",
    "address1_city", "address1_stateorprovince", "address1_postalcode",
    "address1_country", "address1_county",
    "address2_line1", "address2_city", "address2_country",
    "description", "preferredcontactmethodcode",
    "donotbulkemail", "donotemail", "donotphone", "donotfax",
    "statuscode", "statecode",
    # Additional shared fields that are valid across entities
    "department", "jobtitle", "createdon", "modifiedon",
    "yomifullname", "yomifirstname", "yomilastname",
    "address1_telephone1", "address1_telephone2",
    "pager", "home2", "aging30", "aging60", "aging90",
    "creditlimit", "creditonhold",
    "numberofchildren", "nickname",
    "ftpsiteurl", "entityimageid",
}

# All valid D365 fields across all entities — anything not in this set is dropped
_ALL_KNOWN_FIELDS = (
    _SHARED_FIELDS
    | _ENTITY_EXCLUSIVE_FIELDS["account"]
    | _ENTITY_EXCLUSIVE_FIELDS["contact"]
    | _ENTITY_EXCLUSIVE_FIELDS["lead"]
)

_NUMERIC_FIELDS = {"revenue", "numberofemployees", "closeprobability", "estimatedvalue"}

_STRING_FIELDS = {
    "telephone1", "telephone2", "mobilephone", "fax",
    "emailaddress1", "emailaddress2", "websiteurl",
    "firstname", "lastname", "fullname", "companyname",
    "jobtitle", "address1_city", "address1_country",
    "address1_line1", "address1_postalcode", "description",
    "subject", "accountnumber", "name",
    "address1_stateorprovince", "address1_line2", "address1_county",
    "address2_line1", "address2_city", "address2_country",
    "middlename", "salutation", "department",
    "sic", "stockexchange", "tickersymbol",
    "telephone3", "emailaddress3",
    "address1_line3", "address1_country",
    "yomifullname", "yomifirstname", "yomilastname",
    "nickname", "ftpsiteurl",
}

_OPTIONSET_FIELDS = {
    "industrycode", "customertypecode", "accountcategorycode",
    "accountclassificationcode", "accountratingcode",
    "address1_addresstypecode", "address1_freighttermscode",
    "address1_shippingmethodcode", "address2_addresstypecode",
    "address2_freighttermscode", "address2_shippingmethodcode",
    "businesstypecode", "customersizecode", "ownershipcode",
    "preferredcontactmethodcode", "shippingmethodcode",
    "statuscode", "statecode",
    "gendercode", "familystatuscode", "educationcode",
    "leadsourcecode", "prioritycode", "salesstagecode",
    "initialcommunication", "need", "purchasetimeframe",
}

_LOOKUP_FIELDS = {
    "parentaccountid", "parentcustomerid", "primarycontactid",
    "ownerid", "transactioncurrencyid", "slaid", "masterid",
    "originatingleadid", "customerid", "schedulecontactid",
}

_BOOL_FIELDS = {"donotbulkemail", "donotemail", "donotphone", "donotfax"}

_GUID_PATTERN = re.compile(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
)


# ── Auth ──────────────────────────────────────────────────────────────────────

def get_access_token(force_refresh: bool = False) -> str:
    cache_key = "dataverse_token"
    if not force_refresh and cache_key in _token_cache:
        token, expiry = _token_cache[cache_key]
        if time.time() < expiry - 60:
            return token

    import msal
    authority = f"https://login.microsoftonline.com/{AZURE_TENANT_ID}"
    scope     = [f"{DATAVERSE_URL}/.default"]

    if AZURE_CLIENT_SECRET:
        app = msal.ConfidentialClientApplication(
            client_id=AZURE_CLIENT_ID,
            client_credential=AZURE_CLIENT_SECRET,
            authority=authority,
        )
    else:
        app = msal.PublicClientApplication(client_id=AZURE_CLIENT_ID, authority=authority)

    result = app.acquire_token_by_username_password(
        username=D365_USERNAME, password=D365_PASSWORD, scopes=scope,
    )
    if "access_token" not in result:
        error = result.get("error_description", result.get("error", "Unknown error"))
        raise RuntimeError(f"Dataverse authentication failed: {error}")

    token      = result["access_token"]
    expires_in = result.get("expires_in", 3600)
    _token_cache[cache_key] = (token, time.time() + expires_in)
    return token


# ── Entity helpers ────────────────────────────────────────────────────────────

def get_entity_plural(entity: str) -> str:
    plurals = {"account": "accounts", "contact": "contacts", "lead": "leads"}
    return plurals.get(entity.lower(), f"{entity.lower()}s")


# ── Main entry point ──────────────────────────────────────────────────────────

def load_to_dataverse(
    df: pd.DataFrame,
    entity: str,
    project_id: str,
    approved_mappings: list,
    progress_callback: Optional[Callable] = None,
) -> dict:
    if not is_dataverse_configured():
        return {
            "total_attempted": len(df),
            "total_success":   0,
            "total_failed":    len(df),
            "simulation_mode": True,
            "error": "Dataverse credentials not configured in .env",
        }

    entity_plural = get_entity_plural(entity)
    base_url      = DATAVERSE_URL.rstrip("/")
    entity_url    = f"{base_url}/api/data/v9.2/{entity_plural}"

    total         = len(df)
    total_success = 0
    total_failed  = 0
    load_errors: list[dict] = []

    try:
        token = get_access_token()
    except Exception as e:
        return {"total_attempted": total, "total_success": 0, "total_failed": total, "error": str(e)}

    headers = {
        "Authorization":    f"Bearer {token}",
        "Content-Type":     "application/json;odata.metadata=minimal",
        "Accept":           "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version":    "4.0",
        "Prefer":           "return=minimal",
    }

    for row_offset, (_, row) in enumerate(df.iterrows()):
        row_number = row_offset + 1
        payload    = _row_to_payload(row, entity)
        payload    = _ensure_required_fields(payload, entity)

        if not payload:
            logger.warning(f"Row {row_number}: empty payload — skipping")
            total_failed += 1
            load_errors.append({
                "row_number":    row_number,
                "error_type":    "empty_payload",
                "error_message": "All fields were null or unmapped",
            })
            continue

        # Refresh token if close to expiry (every 100 rows)
        if row_offset > 0 and row_offset % 100 == 0:
            try:
                token = get_access_token()
                headers["Authorization"] = f"Bearer {token}"
            except Exception:
                pass

        success, err_msg = _post_single(entity_url, payload, headers)
        if success:
            total_success += 1
        else:
            total_failed += 1
            load_errors.append({
                "row_number":    row_number,
                "error_type":    "api_error",
                "error_message": err_msg,
            })
            logger.warning(f"Row {row_number} failed: {err_msg[:200]}")

        if progress_callback and row_offset % 10 == 0:
            progress_callback(row_offset + 1, total, total_success, total_failed)

    if progress_callback:
        progress_callback(total, total, total_success, total_failed)

    return {
        "total_attempted": total,
        "total_success":   total_success,
        "total_failed":    total_failed,
        "success_rate":    round(total_success / total * 100, 2) if total > 0 else 0,
        "errors":          load_errors,
        "simulation_mode": False,
    }


def _post_single(
    entity_url: str,
    payload: dict,
    headers: dict,
    max_retries: int = 3,
) -> tuple[bool, str]:
    """POST a single record to Dataverse. Returns (success, error_message)."""
    for attempt in range(max_retries):
        try:
            resp = _session.post(
                entity_url,
                json=payload,          # requests handles JSON serialisation + Content-Length
                headers=headers,
                timeout=30,
            )

            if resp.status_code == 429:
                wait = int(resp.headers.get("Retry-After", 15))
                logger.warning(f"Rate limited — waiting {wait}s")
                time.sleep(wait)
                continue

            if resp.status_code in (200, 201, 204):
                return True, ""

            # Parse Dataverse error
            try:
                err_json = resp.json()
                msg = (
                    err_json.get("error", {}).get("message", "")
                    or err_json.get("error", {}).get("code", "")
                    or resp.text[:300]
                )
            except Exception:
                msg = resp.text[:300]

            # Don't retry 4xx client errors — they won't change
            if 400 <= resp.status_code < 500:
                return False, f"HTTP {resp.status_code}: {msg}"

            # Retry 5xx
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
                continue

            return False, f"HTTP {resp.status_code}: {msg}"

        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
                continue
            return False, f"Connection error: {str(e)[:200]}"
        except Exception as e:
            return False, f"Exception: {str(e)[:200]}"

    return False, "Max retries exceeded"


# ── Batch sender ──────────────────────────────────────────────────────────────

def _send_batch(
    payloads: list[tuple[int, dict]],
    entity_url: str,
    batch_url: str,
    token: str,
    max_retries: int = 3,
) -> tuple[bool, int, int, list[dict]]:
    boundary  = f"batch_{uuid.uuid4().hex}"
    body      = _build_batch_body(payloads, entity_url, boundary)
    first_row = payloads[0][0] if payloads else 0

    headers = {
        "Authorization":    f"Bearer {token}",
        "Content-Type":     f"multipart/mixed; boundary={boundary}",
        "Accept":           "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version":    "4.0",
    }

    for attempt in range(max_retries):
        try:
            # Send as raw bytes — body already contains CRLF line endings
            resp = _session.post(
                batch_url,
                data=body.encode("utf-8"),
                headers=headers,
                timeout=60,
            )

            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", 30))
                logger.warning(f"Rate limited — waiting {retry_after}s")
                time.sleep(retry_after)
                continue

            if resp.status_code == 401:
                return False, 0, len(payloads), [
                    {"row_number": first_row, "error_type": "auth_error",
                     "error_message": "Token expired mid-batch"}
                ]

            # Dataverse $batch returns 200 or 202 for a well-formed batch request.
            # It can also return 400 if the outer envelope is malformed — BUT
            # sometimes it returns 400 at the outer level while still processing
            # individual records (each sub-response has its own status).
            # Always try to parse the response body regardless of outer status.
            if resp.status_code not in (200, 202, 400):
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                return False, 0, len(payloads), [
                    {"row_number": first_row, "error_type": f"http_{resp.status_code}",
                     "error_message": resp.text[:500]}
                ]

            # Parse the batch response — works for both 200 and 400 outer status
            parsed_success, parsed_failed, parsed_errors = _parse_batch_response(resp.text, payloads)

            # If we got sub-responses, use them regardless of outer status
            if parsed_success + parsed_failed > 0:
                return True, parsed_success, parsed_failed, parsed_errors

            # No sub-responses parsed — treat as total failure
            if resp.status_code == 400:
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                return False, 0, len(payloads), [
                    {"row_number": first_row, "error_type": "http_400",
                     "error_message": resp.text[:500]}
                ]

            return True, parsed_success, parsed_failed, parsed_errors

        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
                continue
            return False, 0, len(payloads), [
                {"row_number": first_row, "error_type": "connection_error",
                 "error_message": str(e)[:300]}
            ]
        except Exception as e:
            return False, 0, len(payloads), [
                {"row_number": first_row, "error_type": "exception",
                 "error_message": str(e)[:300]}
            ]

    return False, 0, len(payloads), [
        {"row_number": first_row, "error_type": "max_retries",
         "error_message": f"Failed after {max_retries} attempts"}
    ]


def _build_batch_body(
    payloads: list[tuple[int, dict]],
    entity_url: str,
    boundary: str,
) -> str:
    """
    Build OData $batch body WITHOUT a changeset wrapper.

    Each part is a self-contained HTTP POST request.
    Content-Length uses the UTF-8 byte length (not character count).

    CRITICAL FORMAT RULES (Dataverse is strict):
    - All line endings MUST be CRLF (\\r\\n)
    - Each part: boundary → part headers → blank line → HTTP request line
      → request headers → blank line → JSON body
    - Content-Length MUST match the UTF-8 byte length of the JSON body
    """
    CRLF = "\r\n"
    parts: list[str] = []

    for content_id, (_, payload) in enumerate(payloads, start=1):
        body_json  = json.dumps(payload, ensure_ascii=False)
        # Use byte length — critical when payload contains non-ASCII characters
        body_bytes = body_json.encode("utf-8")
        content_len = len(body_bytes)

        part = (
            f"--{boundary}{CRLF}"
            f"Content-Type: application/http{CRLF}"
            f"Content-Transfer-Encoding: binary{CRLF}"
            f"Content-ID: {content_id}{CRLF}"
            f"{CRLF}"
            f"POST {entity_url} HTTP/1.1{CRLF}"
            f"Content-Type: application/json;odata.metadata=minimal{CRLF}"
            f"Content-Length: {content_len}{CRLF}"
            f"Prefer: return=minimal{CRLF}"
            f"Accept: application/json{CRLF}"
            f"{CRLF}"
            f"{body_json}{CRLF}"
        )
        parts.append(part)

    return "".join(parts) + f"--{boundary}--{CRLF}"


def _parse_batch_response(
    response_text: str,
    payloads: list[tuple[int, dict]],
) -> tuple[int, int, list[dict]]:
    """
    Parse OData $batch response (non-changeset format).

    Response structure per part:
        --batchresponse_<uuid>
        Content-Type: application/http
        Content-Transfer-Encoding: binary
        <blank line>
        HTTP/1.1 204 No Content        ← this is what we parse
        OData-Version: 4.0
        ...
        <blank line>
        <optional JSON error body>
        --batchresponse_<uuid>
        ...
        --batchresponse_<uuid>--
    """
    logger.debug(f"Batch response (first 1000 chars): {response_text[:1000]}")

    success_count = 0
    failed_count  = 0
    errors: list[dict] = []

    # Split on the batch boundary to get individual sub-response parts
    # The boundary is in the response itself: --batchresponse_<uuid>
    boundary_match = re.search(r'--batchresponse_([a-f0-9\-]+)', response_text)
    if not boundary_match:
        logger.error(f"No batch boundary found in response: {response_text[:500]}")
        return 0, len(payloads), [{
            "row_number":    payloads[0][0] if payloads else 1,
            "error_type":    "parse_error",
            "error_message": f"No batch boundary in response: {response_text[:200]}",
        }]

    boundary_id = boundary_match.group(1)
    # Split on the boundary (handles both \r\n and \n)
    parts = re.split(rf'--batchresponse_{re.escape(boundary_id)}', response_text)
    # parts[0] = empty, parts[1..N] = sub-responses, parts[-1] = "--\r\n"
    sub_parts = [p for p in parts[1:] if p.strip() and p.strip() != '--']

    logger.info(f"Batch: {len(sub_parts)} sub-parts found for {len(payloads)} payloads")

    for i, part in enumerate(sub_parts):
        row_number = payloads[i][0] if i < len(payloads) else i + 1

        # Find the HTTP status line inside this part
        # Part structure: \r\n<part-headers>\r\n\r\nHTTP/1.1 NNN ...\r\n<response-headers>\r\n\r\n<body>
        status_match = re.search(r'HTTP/1\.1\s+(\d{3})', part)
        if not status_match:
            # No HTTP status in this part — skip (could be the closing boundary)
            continue

        status_code = int(status_match.group(1))

        if status_code in (200, 201, 204):
            success_count += 1
        else:
            failed_count += 1
            # Extract the JSON error body — it's after the double blank line
            # following the HTTP response headers
            error_body = ""
            # Find the section after the HTTP status line
            after_status = part[status_match.end():]
            # Body is after the first double blank line in the response headers section
            body_match = re.search(r'\r?\n\r?\n([\s\S]+)', after_status)
            if body_match:
                raw_body = body_match.group(1).strip()
                if raw_body:
                    try:
                        err_json = json.loads(raw_body)
                        error_body = (
                            err_json.get("error", {}).get("message", "")
                            or err_json.get("error", {}).get("code", "")
                            or raw_body[:300]
                        )
                    except (json.JSONDecodeError, AttributeError):
                        # Not JSON — use raw but strip boundary lines
                        lines = [l for l in raw_body.splitlines()
                                 if not l.startswith("--batchresponse")]
                        error_body = " ".join(lines).strip()[:300]

            errors.append({
                "row_number":    row_number,
                "error_type":    f"api_{status_code}",
                "error_message": error_body or f"HTTP {status_code}",
            })

    # If we parsed fewer parts than payloads, mark the rest as missing
    parsed = success_count + failed_count
    for i in range(parsed, len(payloads)):
        failed_count += 1
        errors.append({
            "row_number":    payloads[i][0],
            "error_type":    "missing_response",
            "error_message": "No sub-response for this record",
        })

    logger.info(f"Batch parsed: {success_count} success, {failed_count} failed")
    return success_count, failed_count, errors


# ── Payload builder ───────────────────────────────────────────────────────────

def _row_to_payload(row: pd.Series, entity: str = "account") -> dict:
    """
    Convert a DataFrame row to a Dataverse API payload.
    Only includes fields known to Dataverse for the target entity.
    Applies correct type coercion per field type.
    """
    entity_lower = entity.lower()

    # Determine which fields are valid for this entity
    entity_fields = _ENTITY_EXCLUSIVE_FIELDS.get(entity_lower, set())
    valid_fields  = entity_fields | _SHARED_FIELDS

    payload: dict = {}
    for field, val in row.items():
        field = str(field)

        # Skip internal / unknown fields
        if field == "_row_number":
            continue
        if field not in _ALL_KNOWN_FIELDS:
            continue
        if field not in valid_fields:
            continue

        # Skip null / empty
        if val is None or (isinstance(val, float) and pd.isna(val)):
            continue
        str_val = str(val).strip()
        if not str_val or str_val.lower() in ("nan", "none", "null"):
            continue

        # ── Type coercion ──────────────────────────────────────────────────────
        if field in _BOOL_FIELDS:
            payload[field] = str_val.lower() in ("true", "1", "yes")

        elif field in _LOOKUP_FIELDS:
            if _GUID_PATTERN.match(str_val):
                payload[field] = str_val
            # else skip — non-GUID lookup values cause 0x80048d19

        elif field in _NUMERIC_FIELDS:
            try:
                clean = re.sub(r"[^\d.\-]", "", str_val)
                num = float(clean)
                # numberofemployees must be an integer in Dataverse
                if field == "numberofemployees":
                    payload[field] = int(num)
                else:
                    payload[field] = num
            except (ValueError, TypeError):
                pass  # skip non-numeric values for numeric fields

        elif field in _OPTIONSET_FIELDS:
            try:
                payload[field] = int(float(str_val))
            except (ValueError, TypeError):
                pass  # skip non-integer picklist values

        elif field in _STRING_FIELDS:
            payload[field] = str_val[:4000]  # Dataverse string max

        else:
            # Unknown type — send as string, truncated
            payload[field] = str_val[:4000]

    return payload


def _ensure_required_fields(payload: dict, entity: str) -> dict:
    """Add entity-specific required fields if missing."""
    entity_lower = entity.lower()
    if entity_lower == "lead":
        if "subject" not in payload:
            name = payload.get("lastname") or payload.get("companyname") or "Lead"
            payload["subject"] = f"Lead - {name}"
        if "lastname" not in payload and "fullname" not in payload:
            payload["lastname"] = payload.get("companyname", "Unknown")
    elif entity_lower == "contact":
        if "lastname" not in payload and "fullname" not in payload:
            payload["lastname"] = payload.get("companyname", "Unknown")
    elif entity_lower == "account":
        if "name" not in payload:
            # name is required for account — use any available identifier
            payload["name"] = (
                payload.get("accountnumber")
                or payload.get("description", "")[:160]
                or "Unknown Account"
            )
    return payload


def _clean_phone(val) -> Optional[str]:
    if val is None or str(val).strip() == "":
        return None
    s        = str(val).strip()
    has_plus = s.startswith("+")
    digits   = re.sub(r"[^\d]", "", s)
    return ("+" if has_plus else "") + digits[:19]


def transform_for_dataverse(df: pd.DataFrame, approved_mappings: list) -> pd.DataFrame:
    """Rename source columns to D365 API field names."""
    rename_map = {
        m["source_column"]: m["d365_field"]
        for m in approved_mappings
        if m.get("d365_field") and m["d365_field"] != "no_match"
        and m["source_column"] in df.columns
    }
    result    = df.rename(columns=rename_map)
    d365_cols = list(rename_map.values())
    result    = result[[c for c in d365_cols if c in result.columns]]
    return result
