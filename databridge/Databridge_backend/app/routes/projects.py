"""
Projects Management Routes
List, retrieve, and manage migration projects
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text
from typing import List, Optional
from datetime import datetime

from app.services.postgres_services import get_db

router = APIRouter()


# =====================================================
# LIST ALL PROJECTS
# =====================================================

@router.get(
    "/projects",
    summary="List all migration projects",
    description="Get a list of all projects with their metadata and statistics"
)
def list_projects(
    db: Session = Depends(get_db),
    status: Optional[str] = None,
    limit: int = 100,
    offset: int = 0
):
    """
    List all projects with optional filtering by status.
    Returns project metadata, record counts, and migration status.
    """
    try:
        # Build query with optional status filter
        query = """
            SELECT 
                p.id,
                p.project_name,
                p.client_name,
                p.source_type,
                p.target_entity,
                p.total_source_records,
                p.created_at,
                p.updated_at,
                p.status,
                ms.loaded_records,
                ms.failed_records,
                ms.success_rate
            FROM metadata.projects p
            LEFT JOIN (
                SELECT DISTINCT ON (project_id)
                    project_id, loaded_records, failed_records, success_rate
                FROM reporting.migration_stats
                ORDER BY project_id, started_at DESC
            ) ms ON p.id = ms.project_id
        """
        
        params = {"limit": limit, "offset": offset}
        
        if status:
            query += " WHERE p.status = :status"
            params["status"] = status
        
        query += " ORDER BY p.created_at DESC LIMIT :limit OFFSET :offset"
        
        result = db.execute(text(query), params)
        rows = result.fetchall()
        
        projects = []
        for row in rows:
            # row indices:
            # 0=id, 1=project_name, 2=client_name, 3=source_type, 4=target_entity,
            # 5=total_source_records, 6=created_at, 7=updated_at,
            # 8=status, 9=loaded_records, 10=failed_records, 11=success_rate
            confidence = None
            if row[11]:  # success_rate (index 11)
                confidence = int(row[11])
            
            projects.append({
                "id": str(row[0]),
                "name": row[1] or "",
                "client": row[2] or "Demo Client",
                "entity": row[4] or "account",
                "status": row[8] or "in_progress",
                "sourceRecords": row[5],
                "loadedRecords": row[9],
                "failedRecords": row[10],
                "createdAt": row[6].isoformat() if row[6] else None,
                "confidence": confidence
            })
        
        return {
            "projects": projects,
            "total": len(projects),
            "limit": limit,
            "offset": offset
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list projects: {str(e)}"
        )


# =====================================================
# GET SINGLE PROJECT
# =====================================================

@router.get(
    "/projects/{project_id}",
    summary="Get project details",
    description="Retrieve detailed information about a specific project"
)
def get_project(
    project_id: str,
    db: Session = Depends(get_db)
):
    """
    Get detailed information about a single project including:
    - Project metadata
    - Record counts
    - Migration status
    - Mapping statistics
    """
    try:
        query = text("""
            SELECT 
                p.id,
                p.project_name,
                p.client_name,
                p.source_type,
                p.target_entity,
                p.total_source_records,
                p.duckdb_path,
                p.created_at,
                p.updated_at,
                p.status,
                ms.loaded_records,
                ms.failed_records,
                ms.success_rate,
                ms.started_at,
                ms.completed_at
            FROM metadata.projects p
            LEFT JOIN (
                SELECT DISTINCT ON (project_id)
                    project_id, loaded_records, failed_records, success_rate,
                    started_at, completed_at
                FROM reporting.migration_stats
                ORDER BY project_id, started_at DESC
            ) ms ON p.id = ms.project_id
            WHERE p.id = :project_id
        """)
        
        result = db.execute(query, {"project_id": project_id})
        row = result.fetchone()
        
        if not row:
            raise HTTPException(
                status_code=404,
                detail=f"Project {project_id} not found"
            )
        
        # Get mapping count
        mapping_query = text("""
            SELECT COUNT(*) 
            FROM metadata.field_mappings 
            WHERE project_id = :project_id
        """)
        mapping_count = db.execute(
            mapping_query, 
            {"project_id": project_id}
        ).scalar()
        
        return {
            "id": row[0],
            "name": row[1],
            "client": row[2] or "Demo Client",
            "sourceType": row[3],
            "entity": row[4] or "account",
            "sourceRecords": row[5],
            "duckdbPath": row[6],
            "createdAt": row[7].isoformat() if row[7] else None,
            "updatedAt": row[8].isoformat() if row[8] else None,
            "migrationStatus": row[9] or "not_started",
            "loadedRecords": row[10],
            "failedRecords": row[11],
            "successRate": float(row[12]) if row[12] else None,
            "migrationStartedAt": row[13].isoformat() if row[13] else None,
            "migrationCompletedAt": row[14].isoformat() if row[14] else None,
            "mappingCount": mapping_count
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get project: {str(e)}"
        )


# =====================================================
# GET PROJECT SCHEMA PROFILE
# =====================================================

@router.get(
    "/projects/{project_id}/schema",
    summary="Get project schema profile",
    description="Retrieve schema profile for a project's data"
)
def get_project_schema(
    project_id: str,
    db: Session = Depends(get_db)
):
    """
    Get the schema profile for a project.
    This reads from the DuckDB file and generates fresh statistics.
    """
    try:
        from app.services.duckdb_service import get_conn
        from app.services.profiling_service import generate_schema_profile
        
        # Verify project exists
        project_query = text("""
            SELECT total_source_records 
            FROM metadata.projects 
            WHERE id = :project_id
        """)
        project = db.execute(
            project_query, 
            {"project_id": project_id}
        ).fetchone()
        
        if not project:
            raise HTTPException(
                status_code=404,
                detail=f"Project {project_id} not found"
            )
        
        # Read data from DuckDB
        conn = get_conn(project_id)
        try:
            df = conn.execute("SELECT * FROM raw_data LIMIT 10000").fetchdf()
        finally:
            conn.close()
        
        if df.empty:
            return {"schema_profile": [], "total_rows": 0}
        
        # Generate schema profile
        schema_profile = generate_schema_profile(df)
        
        return {
            "schema_profile": schema_profile,
            "total_rows": project[0],
            "columns": len(schema_profile)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get schema: {str(e)}"
        )
