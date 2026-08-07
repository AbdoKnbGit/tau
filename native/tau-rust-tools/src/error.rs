use std::fmt::{Display, Formatter};
use std::path::PathBuf;

#[derive(Debug)]
pub enum Error {
    Usage(String),
    Io {
        operation: &'static str,
        path: PathBuf,
        source: std::io::Error,
    },
    ManifestNotFound(PathBuf),
    Manifest {
        path: PathBuf,
        detail: String,
    },
    Workspace(String),
    InvalidData(String),
    Json(serde_json::Error),
}

impl Error {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Usage(_) => 2,
            _ => 1,
        }
    }
}

impl Display for Error {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Usage(message) => write!(f, "{message}"),
            Self::Io {
                operation,
                path,
                source,
            } => write!(f, "failed to {operation} {}: {source}", path.display()),
            Self::ManifestNotFound(path) => {
                write!(f, "no Cargo.toml was found at or above {}", path.display())
            }
            Self::Manifest { path, detail } => {
                write!(f, "failed to inspect {}: {detail}", path.display())
            }
            Self::Workspace(detail) => write!(f, "failed to resolve Cargo workspace: {detail}"),
            Self::InvalidData(detail) => write!(f, "invalid analysis input: {detail}"),
            Self::Json(source) => write!(f, "failed to serialize workspace context: {source}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Json(source) => Some(source),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

pub type Result<T> = std::result::Result<T, Error>;
