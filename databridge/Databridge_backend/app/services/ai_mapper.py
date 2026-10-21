import json
from groq import Groq
from rapidfuzz import fuzz
from app.config.settings import GROQ_API_KEY, GROQ_MODEL, TARGET_ENTITY
from app.services.dataverse_metadata import DataverseMetadataError, get_entity_fields

# =================Semantic Mapping=============
# CONFIG
# =========================================================

TARGET_SCHEMA_FILE = "app/schemas/target_schema.json"

# TASK-015: Module-level Groq singleton — instantiated once, not on every call
_groq_client: Groq | None = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


# =========================================================
# LOAD TARGET SCHEMA
# =========================================================

def load_target_schema():

    with open(TARGET_SCHEMA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def load_target_fields(entity_name=TARGET_ENTITY):
    try:
        fields = get_entity_fields(entity_name)
        print(f"Loaded {len(fields)} Dataverse fields from live metadata for {entity_name}")
        return fields
    except DataverseMetadataError as e:
        print(f"Dataverse metadata unavailable, using local target schema: {e}")
    except Exception as e:
        print(f"Unexpected Dataverse metadata error, using local target schema: {e}")

    # Fall back to local JSON schema
    try:
        schema = load_target_schema()
        fields = get_mappable_fields(schema, entity_name)
        if not fields:
            raise ValueError("Local schema returned 0 mappable fields")
        print(f"✅ Loaded {len(fields)} fields from local schema for '{entity_name}'")
        return fields
    except Exception as e:
        raise RuntimeError(
            f"Cannot load target fields for '{entity_name}' "
            f"from Dataverse or local schema: {e}"
        )

# =========================================================
# FILTER ONLY MAPPABLE FIELDS
# =========================================================

def get_mappable_fields(schema, entity_name=TARGET_ENTITY):

    fields = []

    if isinstance(schema, dict) and "entities" in schema:

        entities = schema["entities"]

        if isinstance(entities, dict):

            if entity_name in entities:
                entity_data = entities[entity_name]

            elif "account" in entities:
                entity_data = entities["account"]

            else:
                first_key = list(entities.keys())[0]
                entity_data = entities[first_key]

            if isinstance(entity_data, list):

                fields = entity_data

            elif isinstance(entity_data, dict):

                fields = (
                    entity_data.get("fields", [])
                    or entity_data.get("attributes", [])
                )

    mappable = [

        field for field in fields

        if isinstance(field, dict)
        and field.get("mappable") is True
        and field.get("read_only") is False
    ]

    return mappable


# =========================================================
# SYNONYM + FUZZY MATCHING
# =========================================================

def synonym_match(source_col, target_fields):
    """
    Multi-pass fuzzy synonym matching.
    Pass 1: exact synonym list match
    Pass 2: normalised column name (strip common prefixes, numbers)
    Returns best (field, score).
    """
    import re

    def _variants(col: str):
        """Generate multiple normalised variants of a column name."""
        base = col.lower().strip()
        variants = {base}
        # replace underscores/hyphens with space
        spaced = re.sub(r"[_\-]", " ", base).strip()
        variants.add(spaced)
        # strip common prefixes: cust_, cst_, src_, tgt_, fld_, col_
        stripped = re.sub(r"^(cust|cst|src|tgt|fld|col|f|c)[\s_]", "", spaced).strip()
        variants.add(stripped)
        # strip trailing numbers: phone1 → phone, email2 → email
        no_num = re.sub(r"\s*\d+$", "", stripped).strip()
        variants.add(no_num)
        # also try the original without spaces
        variants.add(base.replace(" ", ""))
        return variants

    source_variants = _variants(source_col)

    best_match = None
    best_score = 0

    for field in target_fields:
        synonyms = field.get("synonyms", []).copy()
        synonyms.append(field.get("display_name", "").lower())
        synonyms.append(field.get("logical_name", "").lower())
        # also add space-normalised logical name
        synonyms.append(re.sub(r"[_\-]", " ", field.get("logical_name", "")).lower())

        for src_variant in source_variants:
            for synonym in synonyms:
                if not synonym:
                    continue
                score = fuzz.token_sort_ratio(src_variant, synonym.lower())
                if score > best_score:
                    best_score = score
                    best_match = field

    return best_match, best_score


# =========================================================
# AI MAPPING
# =========================================================

def ai_mapping(source_col, samples, target_fields, entity: str = "account"):
    if not _groq_client:
        return None

    client = Groq(api_key=GROQ_API_KEY)

    samples_str = ", ".join([str(s) for s in samples])

    # Build a compact field list to keep the prompt short
    field_list = [
        {"logical_name": f["logical_name"], "display_name": f["display_name"],
         "description": f.get("description", ""), "synonyms": f.get("synonyms", [])}
        for f in target_fields
    ]

    prompt = f"""You are an expert Microsoft Dynamics 365 data migration specialist.

Target entity: {entity.upper()}

Map the source column to the BEST matching D365 {entity} field.

SOURCE COLUMN: {source_col}
SAMPLE VALUES: {samples_str}

AVAILABLE D365 {entity.upper()} FIELDS:
{json.dumps(field_list, indent=2)}

RULES:
1. Only use fields from the list above — they are specific to the {entity} entity
2. For name fields: "cust_fname"/"first_name"/"fname" → firstname, "cust_lname"/"last_name"/"lname" → lastname
3. For company/org fields on lead entity: "company_name"/"org" → companyname (NOT "name")
4. For phone: "mob_num"/"mobile"/"cell" → mobilephone, "phone"/"tel" → telephone1
5. For ID/reference fields: "cust_id"/"customer_id" → accountnumber (account) or use description field
6. Confidence 0.0-1.0 (not percentage)
7. If no good match, return confidence 0.0

Return ONLY valid JSON:
{{
  "target_field": "logical_name_here",
  "display_name": "Display Name Here",
  "confidence": 0.95,
  "reason": "Brief reason",
  "method": "semantic_ai_mapping"
}}"""

    try:

        response = _groq_client.chat.completions.create(

            model=GROQ_MODEL,

            messages=[
                {
                    "role": "user",
                    "content": prompt
                }
            ],

            response_format={
                "type": "json_object"
            }
        )

        result = response.choices[0].message.content

        return json.loads(result)

    except Exception as e:

        print(f"\n⚠️ AI ERROR for column {source_col}")
        print(e)

        return None


# =========================================================
# CONFIDENCE STATUS
# =========================================================

def get_status(confidence):

    if confidence >= 85:
        return "Auto Approved"

    elif confidence >= 60:
        return "Needs Review"

    return "Uncertain"


# =========================================================
# TIER 1 — HISTORY MATCH
# =========================================================

def history_match(source_col: str, entity: str, db) -> dict | None:
    """
    Check if a human has ever corrected this exact source column
    for this entity. If yes, use that correction — skip fuzzy and AI.
    Returns a mapping dict or None.
    """
    from app.services.postgres_services import get_mapping_correction

    correction = get_mapping_correction(
        db,
        source_column=source_col,
        target_entity=entity,
    )

    if not correction:
        return None

    confidence = min(90 + correction["times_confirmed"] * 2, 100)

    return {
        "source_column": source_col,
        "suggested_target": {
            "logical_name":  correction["d365_field"],
            "display_name":  correction["d365_display_name"],
        },
        "confidence":       confidence,
        "method":           "history_match",
        "status":           "Auto Approved",
        "notes":            f"Matched from human correction history "
                            f"(confirmed {correction['times_confirmed']} time(s))",
        "detected_pattern": "string",
        "excluded":         False,
    }


# =========================================================
# MAIN PROCESS— 3-tier pipeline
# =========================================================

def process_mapping(df, schema_profile, entity: str = TARGET_ENTITY, db=None):
    """
    3-tier mapping pipeline:
      Tier 1 — Human corrections history  (exact match, highest trust)
      Tier 2 — Synonym / fuzzy match      (threshold: 85)
      Tier 3 — Groq AI semantic match     (fallback)
    """

    print("\n================================================")
    print("STARTING AI MAPPING ENGINE")
    print("================================================\n")

    print("\n===== RECEIVED SCHEMA PROFILE =====")

    for item in schema_profile:
        print(item)

    print("===================================\n")
    try:
        target_fields = load_target_fields(entity)
    except RuntimeError as e:
        return {"error": str(e), "mappings": [], "summary_stats": {}}

    mappings = []

    stats = {
        "auto_approved": 0,
        "needs_review": 0,
        "uncertain": 0
    }

    # =====================================================
    # PROCESS EACH COLUMN
    # =====================================================

    for column in df.columns:

        print(f"🔍 Processing Column: {column}")

        # ---------------------------------------------
        # GET PROFILE METADATA
        # ---------------------------------------------

        column_profile = next(

            (
                item for item in schema_profile
                if item["column_name"] == column
            ),

            {}
        )

        samples = column_profile.get(
            "sample_values",
            []
        )

        pattern = column_profile.get(
            "detected_pattern",
            "string"
        )
        print(f"{column} → Pattern: {pattern}")
        print(f"{column} → Samples: {samples}")
        
        mapping = None

        # ── TIER 1: History match ─────────────────────────────────────────────
        if db is not None:
            mapping = history_match(column, entity, db)
            if mapping:
                mapping["detected_pattern"] = pattern
                print(f"  ✅ Tier 1 (history): {mapping['suggested_target']['logical_name']}")

        # ── TIER 2: Synonym / fuzzy match  (threshold: 85) ───────────────────
        if mapping is None:
            synonym_result, synonym_score = synonym_match(column, target_fields)

            if synonym_result and synonym_score >= 85:
                confidence = min(synonym_score + 5, 100)
                if synonym_result.get("confidence_boost", False):
                    confidence = min(confidence + 5, 100)

                mapping = {
                    "source_column":    column,
                    "suggested_target": {
                        "logical_name":  synonym_result["logical_name"],
                        "display_name":  synonym_result["display_name"],
                    },
                    "confidence":       confidence,
                    "method":           "synonym_match",
                    "status":           get_status(confidence),
                    "notes":            f"Fuzzy match score {synonym_score}",
                    "detected_pattern": pattern,
                    "excluded":         False,
                }
                print(f"  ✅ Tier 2 (fuzzy): {synonym_result['logical_name']} "
                      f"(score {synonym_score})")

        # ── TIER 3: AI semantic match ─────────────────────────────────────────
        if mapping is None:
            ai_result = ai_mapping(column, samples, target_fields, entity)

            if ai_result:
                confidence = int(ai_result.get("confidence", 0) * 100)

                if confidence < 50:
                    mapping = {
                        "source_column":    column,
                        "suggested_target": None,
                        "confidence":       0,
                        "method":           "semantic_ai_mapping",
                        "status":           "Uncertain",
                        "notes":            "No reliable mapping found",
                        "detected_pattern": pattern,
                        "excluded":         True,
                    }
                    print(f"  ⚠️  Tier 3 (AI): low confidence ({confidence}%)")
                else:
                    mapping = {
                        "source_column":    column,
                        "suggested_target": {
                            "logical_name":  ai_result.get("target_field"),
                            "display_name":  ai_result.get("display_name"),
                        },
                        "confidence":       confidence,
                        "method":           ai_result.get("method", "semantic_ai_mapping"),
                        "status":           get_status(confidence),
                        "notes":            ai_result.get("reason", "AI semantic mapping"),
                        "detected_pattern": pattern,
                        "excluded":         False,
                    }
                    print(f"  ✅ Tier 3 (AI): {ai_result.get('target_field')} "
                          f"({confidence}%)")
            else:
                mapping = {
                    "source_column":    column,
                    "suggested_target": None,
                    "confidence":       0,
                    "method":           "failed",
                    "status":           "Uncertain",
                    "notes":            "All mapping tiers failed",
                    "detected_pattern": pattern,
                    "excluded":         True,
                }
                print(f"  ❌ All tiers failed for column: {column}")

        # =====================================================
        # UPDATE STATS
        # =====================================================

        if mapping["status"] == "Auto Approved":

            stats["auto_approved"] += 1

        elif mapping["status"] == "Needs Review":

            stats["needs_review"] += 1

        else:

            stats["uncertain"] += 1

        mappings.append(mapping)

    # =====================================================
    # FINAL OUTPUT
    # =====================================================

    final_output = {

        "summary_stats": stats,

        "mappings": mappings
    }

    # TASK-004: Removed file write — ui_mapping_data.json was written on every
    # call, risking data leakage and disk accumulation. The return value is sufficient.
    return final_output
