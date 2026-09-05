import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from ..models.project import ProjectRole
from ..models.project_folder import ProjectFolderScope
from ..models.workspace import WorkspaceRole


class ProjectFolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: uuid.UUID | None = None
    scope: ProjectFolderScope | None = None
    is_private: bool = False

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name cannot be blank")
        return value


class ProjectFolderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: uuid.UUID | None = None
    is_private: bool | None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("name cannot be blank")
        return value


class ProjectFolderResponse(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    parent_id: uuid.UUID | None
    owner_id: uuid.UUID
    created_by: uuid.UUID
    name: str
    scope: ProjectFolderScope
    is_private: bool
    created_at: datetime
    model_config = {"from_attributes": True}


class ProjectFolderShareRequest(BaseModel):
    user_id: uuid.UUID
    role: ProjectRole = ProjectRole.viewer


class ProjectFolderShareResponse(BaseModel):
    id: uuid.UUID
    folder_id: uuid.UUID
    user_id: uuid.UUID
    role: ProjectRole
    shared_by: uuid.UUID
    model_config = {"from_attributes": True}


class ProjectFolderProjectMove(BaseModel):
    folder_id: uuid.UUID | None = None


class PersonalProjectPlacementRequest(BaseModel):
    folder_id: uuid.UUID | None = None


class PersonalProjectPlacementResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    project_id: uuid.UUID
    folder_id: uuid.UUID
    model_config = {"from_attributes": True}


class WorkspaceResponse(BaseModel):
    id: uuid.UUID
    name: str
    role: WorkspaceRole


class WorkspaceMemberRequest(BaseModel):
    user_id: uuid.UUID
    role: WorkspaceRole = WorkspaceRole.member


class WorkspaceMemberUpdate(BaseModel):
    role: WorkspaceRole


class WorkspaceMemberResponse(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    role: WorkspaceRole
    model_config = {"from_attributes": True}
