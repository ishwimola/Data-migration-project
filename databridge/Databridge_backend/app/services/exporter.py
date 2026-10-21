"""
Export service — professional Excel & PDF reports for DataBridge migrations.

Sheets in the full Excel report:
  1. Cover          — project title, branding, key stats, AI executive summary
  2. Summary        — KPI metrics table
  3. Field Mappings — all approved mappings with confidence bars
  4. Validation     — error breakdown + per-row error list
  5. Audit Trail    — full chronological audit log
"""

import io
import datetime
import pandas as pd


# ─────────────────────────────────────────────────────────────────────────────
# COLOUR PALETTE  (DataBridge brand)
# ─────────────────────────────────────────────────────────────────────────────
C_NAVY      = "#1E293B"   # header background
C_BLUE      = "#2563EB"   # accent / links
C_GREEN     = "#16A34A"   # success
C_RED       = "#DC2626"   # error
C_AMBER     = "#D97706"   # warning
C_LIGHT     = "#F8FAFC"   # alternating row light
C_WHITE     = "#FFFFFF"
C_BORDER    = "#E2E8F0"


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _pct_bar(score: float) -> str:
    """Return a unicode progress bar string for confidence scores."""
    filled = round(score * 10)
    return "█" * filled + "░" * (10 - filled) + f"  {round(score * 100)}%"


def _confidence_colour(score: float) -> str:
    if score >= 0.85:
        return C_GREEN
    if score >= 0.60:
        return C_AMBER
    return C_RED


def _ai_executive_summary(project: dict, stats: dict, mappings: list,
                           validation: dict, audit: list) -> str:
    """
    Call Groq to generate a 3-paragraph professional executive summary.
    Falls back to a template if Groq is unavailable.
    """
    try:
        from app.config.settings import GROQ_API_KEY, GROQ_MODEL
        if not GROQ_API_KEY:
            raise ValueError("No Groq key")

        from groq import Groq
        client = Groq(api_key=GROQ_API_KEY)

        total    = stats.get("total_records", 0)
        loaded   = stats.get("loaded_records", 0)
        failed   = stats.get("failed_records", 0)
        rate     = stats.get("success_rate", 0)
        entity   = stats.get("target_entity", "account")
        invalid  = validation.get("invalid_count", 0)
        mappings_count = len(mappings)
        auto_approved  = sum(1 for m in mappings if m.get("mapping_method") in ("synonym_match", "semantic_ai_mapping"))

        prompt = f"""You are a senior data migration consultant writing a professional executive summary 
for a Microsoft Dynamics 365 data migration report. Write exactly 3 short paragraphs (no headers, no bullet points).

Migration facts:
- Project: {project.get('project_name', 'N/A')}
- Client: {project.get('client_name', 'N/A')}
- Target entity: {entity.title()}
- Total source records: {total:,}
- Successfully loaded: {loaded:,} ({rate}% success rate)
- Failed records: {failed:,}
- Validation errors found: {invalid:,}
- Field mappings configured: {mappings_count} ({auto_approved} AI-mapped)
- Migration date: {datetime.date.today().strftime('%d %B %Y')}

Write a concise, professional executive summary suitable for a client-facing report.
Paragraph 1: Overview of what was migrated and the outcome.
Paragraph 2: Data quality findings from validation.
Paragraph 3: Recommendations or next steps.
Keep each paragraph to 2-3 sentences. Use formal business language."""

        response = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )
        return response.choices[0].message.content.strip()

    except Exception:
        # Fallback template
        total  = stats.get("total_records", 0)
        loaded = stats.get("loaded_records", 0)
        rate   = stats.get("success_rate", 0)
        entity = stats.get("target_entity", "account").title()
        return (
            f"The DataBridge migration project successfully transferred {loaded:,} of {total:,} "
            f"source records into the Microsoft Dynamics 365 {entity} entity, achieving a {rate}% "
            f"success rate. The migration was executed using AI-assisted field mapping and automated "
            f"validation rules to ensure data integrity.\n\n"
            f"Pre-migration validation identified data quality issues which were reviewed prior to "
            f"execution. Records that failed validation were excluded from the migration to prevent "
            f"corrupt data entering the target system.\n\n"
            f"It is recommended that the client reviews any failed or excluded records and corrects "
            f"the underlying data quality issues before attempting a re-migration. All mapping "
            f"configurations and audit logs have been preserved for traceability."
        )


# ─────────────────────────────────────────────────────────────────────────────
# SHEET BUILDERS
# ─────────────────────────────────────────────────────────────────────────────

def _build_cover_sheet(wb, ws, project: dict, stats: dict,
                        validation: dict, mappings: list, audit: list):
    """Sheet 1 — Cover page with branding, KPIs, and AI executive summary."""

    # ── formats ──────────────────────────────────────────────────────────────
    fmt_title = wb.add_format({
        "bold": True, "font_size": 28, "font_color": C_WHITE,
        "bg_color": C_NAVY, "align": "center", "valign": "vcenter",
        "font_name": "Calibri",
    })
    fmt_subtitle = wb.add_format({
        "font_size": 13, "font_color": "#94A3B8",
        "bg_color": C_NAVY, "align": "center", "valign": "vcenter",
        "font_name": "Calibri",
    })
    fmt_section = wb.add_format({
        "bold": True, "font_size": 11, "font_color": C_WHITE,
        "bg_color": C_BLUE, "left": 4, "left_color": C_BLUE,
        "font_name": "Calibri", "valign": "vcenter",
    })
    fmt_kpi_label = wb.add_format({
        "font_size": 10, "font_color": "#64748B",
        "bg_color": C_LIGHT, "font_name": "Calibri",
        "border": 1, "border_color": C_BORDER,
        "align": "center", "valign": "vcenter",
    })
    fmt_kpi_green = wb.add_format({
        "bold": True, "font_size": 22, "font_color": C_GREEN,
        "bg_color": C_WHITE, "font_name": "Calibri",
        "border": 1, "border_color": C_BORDER,
        "align": "center", "valign": "vcenter",
    })
    fmt_kpi_red = wb.add_format({
        "bold": True, "font_size": 22, "font_color": C_RED,
        "bg_color": C_WHITE, "font_name": "Calibri",
        "border": 1, "border_color": C_BORDER,
        "align": "center", "valign": "vcenter",
    })
    fmt_kpi_blue = wb.add_format({
        "bold": True, "font_size": 22, "font_color": C_BLUE,
        "bg_color": C_WHITE, "font_name": "Calibri",
        "border": 1, "border_color": C_BORDER,
        "align": "center", "valign": "vcenter",
    })
    fmt_body = wb.add_format({
        "font_size": 10, "font_color": C_NAVY,
        "bg_color": C_WHITE, "font_name": "Calibri",
        "text_wrap": True, "valign": "top",
        "left": 1, "right": 1, "bottom": 1, "top": 1,
        "border_color": C_BORDER,
    })
    fmt_meta_label = wb.add_format({
        "bold": True, "font_size": 10, "font_color": "#64748B",
        "bg_color": C_LIGHT, "font_name": "Calibri",
        "border": 1, "border_color": C_BORDER,
    })
    fmt_meta_value = wb.add_format({
        "font_size": 10, "font_color": C_NAVY,
        "bg_color": C_WHITE, "font_name": "Calibri",
        "border": 1, "border_color": C_BORDER,
    })
    fmt_footer = wb.add_format({
        "font_size": 9, "font_color": "#94A3B8",
        "bg_color": C_NAVY, "align": "center",
        "font_name": "Calibri",
    })

    ws.set_column("A:A", 3)
    ws.set_column("B:B", 22)
    ws.set_column("C:C", 22)
    ws.set_column("D:D", 22)
    ws.set_column("E:E", 22)
    ws.set_column("F:F", 3)

    # ── Title banner (rows 1-5) ───────────────────────────────────────────────
    ws.set_row(0, 15)
    ws.set_row(1, 55)
    ws.set_row(2, 30)
    ws.set_row(3, 20)
    ws.set_row(4, 15)

    for r in [0, 1, 2, 3, 4]:
        for c in range(6):
            ws.write(r, c, "", wb.add_format({"bg_color": C_NAVY}))

    ws.merge_range("B2:E2", "DataBridge.AI — Migration Report", fmt_title)
    ws.merge_range("B3:E3",
        f"{project.get('project_name', 'Migration Project')}  ·  "
        f"{project.get('client_name', '')}  ·  "
        f"D365 {project.get('target_entity', 'Account').title()}",
        fmt_subtitle,
    )

    # ── Project metadata (rows 6-10) ─────────────────────────────────────────
    ws.set_row(5, 8)
    ws.set_row(6, 22)
    ws.set_row(7, 22)
    ws.set_row(8, 22)
    ws.set_row(9, 22)
    ws.set_row(10, 8)

    meta = [
        ("Project Name",   project.get("project_name", "—")),
        ("Client",         project.get("client_name", "—")),
        ("Target Entity",  project.get("target_entity", "account").title()),
        ("Report Date",    datetime.date.today().strftime("%d %B %Y")),
    ]
    for i, (label, value) in enumerate(meta):
        ws.write(6 + i, 1, label, fmt_meta_label)
        ws.merge_range(6 + i, 2, 6 + i, 4, value, fmt_meta_value)

    # ── KPI section header (row 11) ───────────────────────────────────────────
    ws.set_row(11, 28)
    ws.merge_range("B12:E12", "  Migration Outcome", fmt_section)

    # ── KPI boxes (rows 12-15) ────────────────────────────────────────────────
    ws.set_row(12, 14)
    ws.set_row(13, 50)
    ws.set_row(14, 22)
    ws.set_row(15, 8)

    total   = stats.get("total_records", 0)
    loaded  = stats.get("loaded_records", 0)
    failed  = stats.get("failed_records", 0)
    rate    = stats.get("success_rate", 0)
    invalid = validation.get("invalid_count", 0)

    kpis = [
        ("Total Records",    f"{total:,}",          fmt_kpi_blue),
        ("Loaded to D365",   f"{loaded:,}",          fmt_kpi_green),
        ("Failed Records",   f"{failed:,}",          fmt_kpi_red if failed > 0 else fmt_kpi_green),
        ("Success Rate",     f"{rate}%",             fmt_kpi_green if rate >= 90 else fmt_kpi_red),
    ]
    for col_offset, (label, value, fmt_val) in enumerate(kpis):
        col = 1 + col_offset
        ws.write(13, col, value, fmt_val)
        ws.write(14, col, label, fmt_kpi_label)

    # ── Executive summary (rows 16-26) ────────────────────────────────────────
    ws.set_row(16, 28)
    ws.merge_range("B17:E17", "  AI-Generated Executive Summary", fmt_section)
    ws.set_row(17, 8)

    summary_text = _ai_executive_summary(project, stats, mappings, validation, audit)

    ws.set_row(18, 120)
    ws.merge_range("B19:E19", summary_text, fmt_body)

    # ── Footer ────────────────────────────────────────────────────────────────
    ws.set_row(20, 8)
    ws.set_row(21, 20)
    for c in range(6):
        ws.write(21, c, "", wb.add_format({"bg_color": C_NAVY}))
    ws.merge_range("B22:E22",
        f"Generated by DataBridge.AI  ·  {datetime.datetime.now().strftime('%d %b %Y %H:%M')}  ·  Confidential",
        fmt_footer,
    )

    ws.hide_gridlines(2)


def _build_summary_sheet(wb, ws, project: dict, stats: dict, validation: dict, mappings: list):
    """Sheet 2 — Detailed KPI summary table."""

    fmt_title = wb.add_format({
        "bold": True, "font_size": 14, "font_color": C_WHITE,
        "bg_color": C_NAVY, "font_name": "Calibri",
        "valign": "vcenter", "left": 1, "right": 1,
    })
    fmt_section = wb.add_format({
        "bold": True, "font_size": 10, "font_color": C_WHITE,
        "bg_color": C_BLUE, "font_name": "Calibri",
        "border": 1, "border_color": C_BLUE,
    })
    fmt_label = wb.add_format({
        "bold": True, "font_size": 10, "font_color": "#475569",
        "bg_color": C_LIGHT, "font_name": "Calibri",
        "border": 1, "border_color": C_BORDER,
    })
    fmt_value = wb.add_format({
        "font_size": 10, "font_color": C_NAVY,
        "bg_color": C_WHITE, "font_name": "Calibri",
        "border": 1, "border_color": C_BORDER,
    })
    fmt_value_green = wb.add_format({
        "bold": True, "font_size": 10, "font_color": C_GREEN,
        "bg_color": "#F0FDF4", "font_name": "Calibri",
        "border": 1, "border_color": C_BORDER,
    })
    fmt_value_red = wb.add_format({
        "bold": True, "font_size": 10, "font_color": C_RED,
        "bg_color": "#FEF2F2", "font_name": "Calibri",
        "border": 1, "border_color": C_BORDER,
    })

    ws.set_column("A:A", 3)
    ws.set_column("B:B", 35)
    ws.set_column("C:C", 30)
    ws.set_column("D:D", 3)

    row = 0
    ws.set_row(row, 8); row += 1

    # Title
    ws.set_row(row, 30)
    ws.merge_range(row, 1, row, 2, "  Migration Summary", fmt_title)
    row += 1
    ws.set_row(row, 8); row += 1

    total   = stats.get("total_records", 0)
    loaded  = stats.get("loaded_records", 0)
    failed  = stats.get("failed_records", 0)
    rate    = stats.get("success_rate", 0)
    invalid = validation.get("invalid_count", 0)
    valid   = validation.get("valid_count", 0)
    entity  = stats.get("target_entity", "account").title()
    started = stats.get("started_at", "—")
    completed = stats.get("completed_at", "—")

    # Section: Migration Results
    ws.set_row(row, 22)
    ws.merge_range(row, 1, row, 2, "Migration Results", fmt_section); row += 1

    migration_rows = [
        ("Total Source Records",    f"{total:,}",   fmt_value),
        ("Successfully Loaded",     f"{loaded:,}",  fmt_value_green),
        ("Failed Records",          f"{failed:,}",  fmt_value_red if failed > 0 else fmt_value_green),
        ("Success Rate",            f"{rate}%",     fmt_value_green if rate >= 90 else fmt_value_red),
        ("Target D365 Entity",      entity,         fmt_value),
        ("Migration Started",       str(started)[:19] if started else "—",   fmt_value),
        ("Migration Completed",     str(completed)[:19] if completed else "—", fmt_value),
    ]
    for label, value, vfmt in migration_rows:
        ws.set_row(row, 20)
        ws.write(row, 1, label, fmt_label)
        ws.write(row, 2, value, vfmt)
        row += 1

    ws.set_row(row, 12); row += 1

    # Section: Data Quality
    ws.set_row(row, 22)
    ws.merge_range(row, 1, row, 2, "Data Quality", fmt_section); row += 1

    quality_rows = [
        ("Total Records Validated",  f"{total:,}",   fmt_value),
        ("Valid Records",            f"{valid:,}",   fmt_value_green),
        ("Invalid Records",          f"{invalid:,}", fmt_value_red if invalid > 0 else fmt_value_green),
        ("Validation Pass Rate",
         f"{round(valid / total * 100, 1) if total else 0}%",
         fmt_value_green if total and valid / total >= 0.9 else fmt_value_red),
    ]
    for label, value, vfmt in quality_rows:
        ws.set_row(row, 20)
        ws.write(row, 1, label, fmt_label)
        ws.write(row, 2, value, vfmt)
        row += 1

    ws.set_row(row, 12); row += 1

    # Section: Mapping
    ws.set_row(row, 22)
    ws.merge_range(row, 1, row, 2, "Field Mapping", fmt_section); row += 1

    approved = [m for m in mappings if m.get("d365_field") and m.get("d365_field") != "no_match"]
    auto_mapped = sum(1 for m in approved if m.get("mapping_method") in ("synonym_match", "semantic_ai_mapping"))
    manual      = len(approved) - auto_mapped
    avg_conf    = (
        sum(float(m.get("confidence_score", 0)) for m in approved) / len(approved)
        if approved else 0
    )

    mapping_rows = [
        ("Total Approved Mappings",  str(len(approved)),          fmt_value),
        ("AI-Mapped Fields",         str(auto_mapped),            fmt_value_green),
        ("Manually Mapped Fields",   str(manual),                 fmt_value),
        ("Average Confidence Score", f"{round(avg_conf * 100 if avg_conf <= 1 else avg_conf, 1)}%", fmt_value),
    ]
    for label, value, vfmt in mapping_rows:
        ws.set_row(row, 20)
        ws.write(row, 1, label, fmt_label)
        ws.write(row, 2, value, vfmt)
        row += 1

    ws.hide_gridlines(2)


def _build_mappings_sheet(wb, ws, mappings: list):
    """Sheet 3 — Field mapping configuration with confidence bars."""

    fmt_header = wb.add_format({
        "bold": True, "font_size": 10, "font_color": C_WHITE,
        "bg_color": C_NAVY, "border": 1, "border_color": C_NAVY,
        "font_name": "Calibri", "align": "center", "valign": "vcenter",
    })
    fmt_title = wb.add_format({
        "bold": True, "font_size": 14, "font_color": C_WHITE,
        "bg_color": C_NAVY, "font_name": "Calibri", "valign": "vcenter",
    })
    fmt_row_light = wb.add_format({
        "font_size": 10, "font_color": C_NAVY,
        "bg_color": C_WHITE, "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri", "valign": "vcenter",
    })
    fmt_row_alt = wb.add_format({
        "font_size": 10, "font_color": C_NAVY,
        "bg_color": C_LIGHT, "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri", "valign": "vcenter",
    })
    fmt_code = wb.add_format({
        "font_size": 9, "font_color": C_BLUE,
        "bg_color": "#EFF6FF", "border": 1, "border_color": C_BORDER,
        "font_name": "Courier New", "valign": "vcenter",
    })
    fmt_code_alt = wb.add_format({
        "font_size": 9, "font_color": C_BLUE,
        "bg_color": "#DBEAFE", "border": 1, "border_color": C_BORDER,
        "font_name": "Courier New", "valign": "vcenter",
    })
    fmt_green = wb.add_format({
        "bold": True, "font_size": 9, "font_color": C_GREEN,
        "bg_color": "#F0FDF4", "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri", "align": "center",
    })
    fmt_amber = wb.add_format({
        "bold": True, "font_size": 9, "font_color": C_AMBER,
        "bg_color": "#FFFBEB", "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri", "align": "center",
    })
    fmt_red_conf = wb.add_format({
        "bold": True, "font_size": 9, "font_color": C_RED,
        "bg_color": "#FEF2F2", "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri", "align": "center",
    })
    fmt_method = wb.add_format({
        "font_size": 9, "font_color": "#7C3AED",
        "bg_color": "#F5F3FF", "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri", "align": "center",
    })

    ws.set_column("A:A", 3)
    ws.set_column("B:B", 25)   # Source Column
    ws.set_column("C:C", 28)   # D365 Display Name
    ws.set_column("D:D", 22)   # API Field Name
    ws.set_column("E:E", 18)   # Confidence
    ws.set_column("F:F", 20)   # Method
    ws.set_column("G:G", 3)

    row = 0
    ws.set_row(row, 8); row += 1
    ws.set_row(row, 30)
    ws.merge_range(row, 1, row, 5, "  Field Mapping Configuration", fmt_title)
    row += 1
    ws.set_row(row, 8); row += 1

    # Header row
    ws.set_row(row, 24)
    headers = ["Source Column", "D365 Display Name", "API Field Name", "Confidence", "Method"]
    for col_offset, h in enumerate(headers):
        ws.write(row, 1 + col_offset, h, fmt_header)
    row += 1

    approved = [m for m in mappings if m.get("d365_field") and m.get("d365_field") != "no_match"]

    for i, m in enumerate(approved):
        ws.set_row(row, 20)
        is_alt = i % 2 == 1
        base_fmt  = fmt_row_alt  if is_alt else fmt_row_light
        code_fmt  = fmt_code_alt if is_alt else fmt_code

        conf_raw = float(m.get("confidence_score", 0))
        conf     = conf_raw if conf_raw <= 1 else conf_raw / 100
        conf_pct = round(conf * 100)

        if conf >= 0.85:
            conf_fmt = fmt_green
            conf_str = f"✓ {conf_pct}%"
        elif conf >= 0.60:
            conf_fmt = fmt_amber
            conf_str = f"~ {conf_pct}%"
        else:
            conf_fmt = fmt_red_conf
            conf_str = f"✗ {conf_pct}%"

        method_raw = m.get("mapping_method", "manual")
        method_display = {
            "synonym_match":       "Synonym Match",
            "semantic_ai_mapping": "AI Semantic",
            "manual":              "Manual",
            "reused":              "Reused",
        }.get(method_raw, method_raw.replace("_", " ").title())

        ws.write(row, 1, m.get("source_column", ""), code_fmt)
        ws.write(row, 2, m.get("d365_display_name", ""), base_fmt)
        ws.write(row, 3, m.get("d365_field", ""), code_fmt)
        ws.write(row, 4, conf_str, conf_fmt)
        ws.write(row, 5, method_display, fmt_method)
        row += 1

    ws.hide_gridlines(2)
    ws.freeze_panes(4, 0)


def _build_validation_sheet(wb, ws, validation_breakdown: dict,
                              validation_errors: list, total: int):
    """Sheet 4 — Validation error breakdown and per-row error list."""

    fmt_title = wb.add_format({
        "bold": True, "font_size": 14, "font_color": C_WHITE,
        "bg_color": C_NAVY, "font_name": "Calibri", "valign": "vcenter",
    })
    fmt_section = wb.add_format({
        "bold": True, "font_size": 10, "font_color": C_WHITE,
        "bg_color": C_RED, "font_name": "Calibri",
        "border": 1, "border_color": C_RED,
    })
    fmt_header = wb.add_format({
        "bold": True, "font_size": 10, "font_color": C_WHITE,
        "bg_color": C_NAVY, "border": 1, "border_color": C_NAVY,
        "font_name": "Calibri", "align": "center",
    })
    fmt_row = wb.add_format({
        "font_size": 10, "font_color": C_NAVY,
        "bg_color": C_WHITE, "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri",
    })
    fmt_row_alt = wb.add_format({
        "font_size": 10, "font_color": C_NAVY,
        "bg_color": "#FEF2F2", "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri",
    })
    fmt_rule = wb.add_format({
        "bold": True, "font_size": 9, "font_color": C_RED,
        "bg_color": "#FEF2F2", "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri",
    })
    fmt_count = wb.add_format({
        "bold": True, "font_size": 10, "font_color": C_RED,
        "bg_color": C_WHITE, "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri", "align": "center",
    })

    ws.set_column("A:A", 3)
    ws.set_column("B:B", 10)   # Row #
    ws.set_column("C:C", 22)   # Field
    ws.set_column("D:D", 22)   # Rule
    ws.set_column("E:E", 55)   # Message
    ws.set_column("F:F", 25)   # Original Value
    ws.set_column("G:G", 3)

    row = 0
    ws.set_row(row, 8); row += 1
    ws.set_row(row, 30)
    ws.merge_range(row, 1, row, 5, "  Validation Report", fmt_title)
    row += 1
    ws.set_row(row, 8); row += 1

    # Breakdown summary
    ws.set_row(row, 22)
    ws.merge_range(row, 1, row, 5, "Error Breakdown by Rule", fmt_section); row += 1

    ws.set_row(row, 22)
    for col_offset, h in enumerate(["Rule Type", "Error Count", "% of Total", "", ""]):
        ws.write(row, 1 + col_offset, h, fmt_header)
    row += 1

    for rule, count in sorted(validation_breakdown.items(), key=lambda x: -x[1]):
        ws.set_row(row, 20)
        pct = round(count / total * 100, 1) if total else 0
        ws.write(row, 1, rule.replace("_", " ").title(), fmt_rule)
        ws.write(row, 2, count, fmt_count)
        ws.write(row, 3, f"{pct}%", fmt_row)
        ws.write(row, 4, "", fmt_row)
        ws.write(row, 5, "", fmt_row)
        row += 1

    ws.set_row(row, 12); row += 1

    # Per-row errors
    ws.set_row(row, 22)
    ws.merge_range(row, 1, row, 5, f"Validation Errors ({len(validation_errors)} rows)", fmt_section)
    row += 1

    ws.set_row(row, 22)
    for col_offset, h in enumerate(["Row #", "Field", "Rule", "Error Message", "Original Value"]):
        ws.write(row, 1 + col_offset, h, fmt_header)
    row += 1

    for i, e in enumerate(validation_errors[:500]):   # cap at 500 rows
        ws.set_row(row, 18)
        base = fmt_row_alt if i % 2 == 1 else fmt_row
        ws.write(row, 1, e.get("row_number", ""), base)
        ws.write(row, 2, e.get("source_column", ""), base)
        ws.write(row, 3, e.get("rule_type", "").replace("_", " ").title(), fmt_rule)
        ws.write(row, 4, e.get("error_message", ""), base)
        ws.write(row, 5, str(e.get("original_value", ""))[:100], base)
        row += 1

    ws.hide_gridlines(2)
    ws.freeze_panes(8, 0)


def _build_audit_sheet(wb, ws, audit_log: list):
    """Sheet 5 — Full chronological audit trail."""

    fmt_title = wb.add_format({
        "bold": True, "font_size": 14, "font_color": C_WHITE,
        "bg_color": C_NAVY, "font_name": "Calibri", "valign": "vcenter",
    })
    fmt_header = wb.add_format({
        "bold": True, "font_size": 10, "font_color": C_WHITE,
        "bg_color": C_NAVY, "border": 1, "border_color": C_NAVY,
        "font_name": "Calibri", "align": "center",
    })
    fmt_row = wb.add_format({
        "font_size": 10, "font_color": C_NAVY,
        "bg_color": C_WHITE, "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri",
    })
    fmt_row_alt = wb.add_format({
        "font_size": 10, "font_color": C_NAVY,
        "bg_color": C_LIGHT, "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri",
    })
    fmt_success = wb.add_format({
        "bold": True, "font_size": 9, "font_color": C_GREEN,
        "bg_color": "#F0FDF4", "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri", "align": "center",
    })
    fmt_failed = wb.add_format({
        "bold": True, "font_size": 9, "font_color": C_RED,
        "bg_color": "#FEF2F2", "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri", "align": "center",
    })
    fmt_warning = wb.add_format({
        "bold": True, "font_size": 9, "font_color": C_AMBER,
        "bg_color": "#FFFBEB", "border": 1, "border_color": C_BORDER,
        "font_name": "Calibri", "align": "center",
    })

    ws.set_column("A:A", 3)
    ws.set_column("B:B", 22)   # Timestamp
    ws.set_column("C:C", 30)   # Action
    ws.set_column("D:D", 12)   # Status
    ws.set_column("E:E", 55)   # Details
    ws.set_column("F:F", 3)

    row = 0
    ws.set_row(row, 8); row += 1
    ws.set_row(row, 30)
    ws.merge_range(row, 1, row, 4, "  Audit Trail", fmt_title)
    row += 1
    ws.set_row(row, 8); row += 1

    ws.set_row(row, 24)
    for col_offset, h in enumerate(["Timestamp", "Action", "Status", "Details"]):
        ws.write(row, 1 + col_offset, h, fmt_header)
    row += 1

    for i, entry in enumerate(audit_log):
        ws.set_row(row, 20)
        base = fmt_row_alt if i % 2 == 1 else fmt_row

        ts = entry.get("action_at", "")
        if ts:
            ts = str(ts)[:19].replace("T", " ")

        action = entry.get("action", "").replace("_", " ").title()
        status = entry.get("status", "success")

        details_raw = entry.get("details", "")
        if isinstance(details_raw, dict):
            details_str = "  |  ".join(f"{k}: {v}" for k, v in details_raw.items())
        else:
            details_str = str(details_raw or "")

        if status == "success":
            status_fmt = fmt_success
            status_str = "✓ Success"
        elif status == "failed":
            status_fmt = fmt_failed
            status_str = "✗ Failed"
        else:
            status_fmt = fmt_warning
            status_str = "⚠ Warning"

        ws.write(row, 1, ts, base)
        ws.write(row, 2, action, base)
        ws.write(row, 3, status_str, status_fmt)
        ws.write(row, 4, details_str[:200], base)
        row += 1

    ws.hide_gridlines(2)
    ws.freeze_panes(4, 0)


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

def generate_full_report_excel(
    project: dict,
    stats: dict,
    mappings: list,
    validation_breakdown: dict,
    validation_errors: list,
    validation_summary: dict,
    audit_log: list,
) -> bytes:
    """
    Generate a professional multi-sheet Excel migration report.
    Returns raw bytes ready to stream as a download.
    """
    output = io.BytesIO()

    with pd.ExcelWriter(output, engine="xlsxwriter") as writer:
        wb = writer.book

        # ── Sheet 1: Cover ────────────────────────────────────────────────────
        wb.add_worksheet("Cover")
        ws_cover = writer.sheets.get("Cover") or wb.worksheets()[0]
        # xlsxwriter doesn't expose add_worksheet via pandas writer directly,
        # so we write a dummy df then grab the sheet
        pd.DataFrame().to_excel(writer, sheet_name="Cover", index=False)
        ws_cover = writer.sheets["Cover"]
        _build_cover_sheet(wb, ws_cover, project, stats, validation_summary, mappings, audit_log)

        # ── Sheet 2: Summary ──────────────────────────────────────────────────
        pd.DataFrame().to_excel(writer, sheet_name="Summary", index=False)
        ws_summary = writer.sheets["Summary"]
        _build_summary_sheet(wb, ws_summary, project, stats, validation_summary, mappings)

        # ── Sheet 3: Field Mappings ───────────────────────────────────────────
        pd.DataFrame().to_excel(writer, sheet_name="Field Mappings", index=False)
        ws_map = writer.sheets["Field Mappings"]
        _build_mappings_sheet(wb, ws_map, mappings)

        # ── Sheet 4: Validation ───────────────────────────────────────────────
        pd.DataFrame().to_excel(writer, sheet_name="Validation", index=False)
        ws_val = writer.sheets["Validation"]
        total = validation_summary.get("total_count", 0)
        _build_validation_sheet(wb, ws_val, validation_breakdown, validation_errors, total)

        # ── Sheet 5: Audit Trail ──────────────────────────────────────────────
        pd.DataFrame().to_excel(writer, sheet_name="Audit Trail", index=False)
        ws_audit = writer.sheets["Audit Trail"]
        _build_audit_sheet(wb, ws_audit, audit_log)

        # ── Workbook properties ───────────────────────────────────────────────
        wb.set_properties({
            "title":    f"DataBridge Migration Report — {project.get('project_name', '')}",
            "subject":  "D365 Data Migration",
            "author":   "DataBridge.AI",
            "company":  project.get("client_name", ""),
            "comments": "Generated by DataBridge.AI",
        })

    return output.getvalue()


# ─────────────────────────────────────────────────────────────────────────────
# LEGACY HELPERS (kept for existing endpoints)
# ─────────────────────────────────────────────────────────────────────────────

def generate_error_excel(errors: list, project_name: str = "Project") -> bytes:
    """Generate Excel error report from validation failures."""
    rows = []
    for e in errors:
        rows.append({
            "Row Number":     e.get("row_number"),
            "Source Column":  e.get("source_column", ""),
            "Rule Type":      e.get("rule_type", "").replace("_", " ").title(),
            "Error Message":  e.get("error_message", ""),
            "Original Value": e.get("original_value", ""),
            "Resolved":       "Yes" if e.get("is_resolved") else "No",
        })

    df = pd.DataFrame(rows) if rows else pd.DataFrame(
        columns=["Row Number", "Source Column", "Rule Type",
                 "Error Message", "Original Value", "Resolved"]
    )

    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="xlsxwriter") as writer:
        df.to_excel(writer, index=False, sheet_name="Validation Errors")
        wb = writer.book
        ws = writer.sheets["Validation Errors"]

        header_fmt = wb.add_format({
            "bold": True, "bg_color": C_NAVY,
            "font_color": "white", "border": 1,
        })
        error_fmt = wb.add_format({"bg_color": "#FEE2E2"})

        for col_num, col_name in enumerate(df.columns):
            ws.write(0, col_num, col_name, header_fmt)

        ws.set_column(0, 0, 12)
        ws.set_column(1, 1, 25)
        ws.set_column(2, 2, 25)
        ws.set_column(3, 3, 60)
        ws.set_column(4, 4, 30)
        ws.set_column(5, 5, 10)

        for row_idx, row in df.iterrows():
            for col_idx in range(len(df.columns)):
                ws.write(row_idx + 1, col_idx, row.iloc[col_idx], error_fmt)

    return output.getvalue()


def generate_migration_excel(load_errors: list, project_name: str = "Project") -> bytes:
    """Generate Excel report of Dataverse load failures."""
    rows = []
    for e in load_errors:
        rows.append({
            "Row Number":    e.get("row_number"),
            "Error Type":    e.get("error_type", "").replace("_", " ").title(),
            "Error Message": e.get("error_message", ""),
        })

    df = pd.DataFrame(rows) if rows else pd.DataFrame(
        columns=["Row Number", "Error Type", "Error Message"]
    )

    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="xlsxwriter") as writer:
        df.to_excel(writer, index=False, sheet_name="Migration Errors")
        wb = writer.book
        ws = writer.sheets["Migration Errors"]
        header_fmt = wb.add_format({
            "bold": True, "bg_color": C_RED, "font_color": "white",
        })
        for col_num, col_name in enumerate(df.columns):
            ws.write(0, col_num, col_name, header_fmt)
        ws.set_column(0, 0, 12)
        ws.set_column(1, 1, 25)
        ws.set_column(2, 2, 80)

    return output.getvalue()
