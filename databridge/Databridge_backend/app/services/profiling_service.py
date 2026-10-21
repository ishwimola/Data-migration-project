import pandas as pd


# =================Schema Detection ==================================
# PATTERN DETECTION
# =====================================================

def detect_pattern(sample_values):

    sample_str = " ".join(
        [str(v).lower() for v in sample_values]
    )

    if "@" in sample_str:
        return "email"

    if "http" in sample_str or "www." in sample_str:
        return "website"

    if "-" in sample_str and any(char.isdigit() for char in sample_str):
        return "phone_or_date"

    if any(char.isdigit() for char in sample_str):
        return "numeric"

    return "string"


# =====================================================
# GENERATE SCHEMA PROFILE
# =====================================================

def generate_schema_profile(df):

    schema_profile = []

    for column in df.columns:

        sample_values = (
            df[column]
            .dropna()
            .astype(str)
            .head(5)
            .tolist()
        )

        profile = {

            "column_name": column,

            "data_type": str(df[column].dtype),

            "null_count": int(df[column].isnull().sum()),

            "sample_values": sample_values,

            "detected_pattern": detect_pattern(sample_values)
        }

        schema_profile.append(profile)

    return schema_profile