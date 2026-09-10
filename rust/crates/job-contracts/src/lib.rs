use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use ts_rs::TS;

mod cloud;
pub use cloud::*;
mod render;
pub use render::*;

pub const JOB_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum JobKind {
    Probe,
    Proxy,
    Waveform,
    Transcription,
    Thumbnail,
    Render,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum JobState {
    Queued,
    Preparing,
    Running,
    Pausing,
    Paused,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JobSpec {
    pub schema_version: u32,
    pub job_id: String,
    pub campaign_id: String,
    pub asset_hash: String,
    pub kind: JobKind,
    pub idempotency_key: String,
    pub engine_version: String,
    pub normalized_options_json: String,
    pub priority: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JobFailure {
    pub code: String,
    pub message: String,
    pub action: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JobAttempt {
    pub attempt: u32,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub failure: Option<JobFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PersistedJob {
    pub spec: JobSpec,
    pub state: JobState,
    pub phase: String,
    #[ts(type = "number")]
    pub completed_units: u64,
    #[ts(type = "number")]
    pub total_units: u64,
    pub attempt: JobAttempt,
    pub created_at: String,
    pub updated_at: String,
    pub artifact_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "event", rename_all = "snake_case")]
#[ts(export)]
pub enum JobEvent {
    StartPreparing,
    StartRunning,
    Progress {
        phase: String,
        #[ts(type = "number")]
        completed_units: u64,
        #[ts(type = "number")]
        total_units: u64,
    },
    RequestPause,
    ConfirmPaused,
    Resume,
    RequestCancel,
    ConfirmCancelled,
    Succeed {
        artifact_path: String,
    },
    Fail {
        failure: JobFailure,
    },
    RecoverAfterReload,
    Retry,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum JobError {
    #[error("unsupported job schema version {0}")]
    UnsupportedSchema(u32),
    #[error("job identity fields must not be empty")]
    EmptyIdentity,
    #[error("job progress is outside the declared range")]
    InvalidProgress,
    #[error("invalid transition from {from:?} using {event}")]
    InvalidTransition { from: JobState, event: String },
    #[error("failed jobs may only be retried when the failure is retryable")]
    NotRetryable,
    #[error("job contract JSON failed: {0}")]
    Contract(String),
}

pub fn build_idempotency_key(
    kind: JobKind,
    asset_hash: &str,
    normalized_options_json: &str,
    engine_version: &str,
) -> String {
    let canonical = format!("{kind:?}\n{asset_hash}\n{normalized_options_json}\n{engine_version}");
    Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn create_job(spec: JobSpec, now: String) -> Result<PersistedJob, JobError> {
    validate_spec(&spec)?;
    Ok(PersistedJob {
        spec,
        state: JobState::Queued,
        phase: "queued".to_owned(),
        completed_units: 0,
        total_units: 1,
        attempt: JobAttempt {
            attempt: 1,
            started_at: None,
            finished_at: None,
            failure: None,
        },
        created_at: now.clone(),
        updated_at: now,
        artifact_path: None,
    })
}

pub fn apply_event(
    job: &PersistedJob,
    event: JobEvent,
    now: String,
) -> Result<PersistedJob, JobError> {
    validate_spec(&job.spec)?;
    let mut next = job.clone();
    let event_name = event_name(&event).to_owned();
    match event {
        JobEvent::StartPreparing if job.state == JobState::Queued => {
            next.state = JobState::Preparing;
            next.phase = "preparing".to_owned();
            next.attempt.started_at = Some(now.clone());
        }
        JobEvent::StartRunning if job.state == JobState::Preparing => {
            next.state = JobState::Running;
            next.phase = "running".to_owned();
        }
        JobEvent::Progress {
            phase,
            completed_units,
            total_units,
        } if matches!(job.state, JobState::Preparing | JobState::Running) => {
            if total_units == 0 || completed_units > total_units {
                return Err(JobError::InvalidProgress);
            }
            next.phase = phase;
            next.completed_units = completed_units;
            next.total_units = total_units;
        }
        JobEvent::RequestPause if job.state == JobState::Running => {
            next.state = JobState::Pausing;
            next.phase = "pausing".to_owned();
        }
        JobEvent::ConfirmPaused if job.state == JobState::Pausing => {
            next.state = JobState::Paused;
            next.phase = "paused".to_owned();
        }
        JobEvent::Resume if job.state == JobState::Paused => {
            next.state = JobState::Queued;
            next.phase = "queued".to_owned();
            next.attempt.attempt += 1;
            next.attempt.started_at = None;
            next.attempt.finished_at = None;
            next.attempt.failure = None;
        }
        JobEvent::RequestCancel
            if matches!(
                job.state,
                JobState::Queued
                    | JobState::Preparing
                    | JobState::Running
                    | JobState::Pausing
                    | JobState::Paused
            ) =>
        {
            next.state = JobState::Cancelling;
            next.phase = "cancelling".to_owned();
        }
        JobEvent::ConfirmCancelled if job.state == JobState::Cancelling => {
            next.state = JobState::Cancelled;
            next.phase = "cancelled".to_owned();
            next.attempt.finished_at = Some(now.clone());
        }
        JobEvent::Succeed { artifact_path }
            if matches!(job.state, JobState::Preparing | JobState::Running) =>
        {
            next.state = JobState::Succeeded;
            next.phase = "succeeded".to_owned();
            next.completed_units = next.total_units.max(1);
            next.total_units = next.total_units.max(1);
            next.artifact_path = Some(artifact_path);
            next.attempt.finished_at = Some(now.clone());
        }
        JobEvent::Fail { failure }
            if matches!(
                job.state,
                JobState::Preparing | JobState::Running | JobState::Pausing | JobState::Cancelling
            ) =>
        {
            next.state = JobState::Failed;
            next.phase = "failed".to_owned();
            next.attempt.finished_at = Some(now.clone());
            next.attempt.failure = Some(failure);
        }
        JobEvent::RecoverAfterReload
            if matches!(
                job.state,
                JobState::Preparing | JobState::Running | JobState::Pausing | JobState::Cancelling
            ) =>
        {
            next.state = JobState::Queued;
            next.phase = "recovering".to_owned();
            next.attempt.attempt += 1;
            next.attempt.started_at = None;
            next.attempt.finished_at = None;
            next.attempt.failure = None;
        }
        JobEvent::RecoverAfterReload
            if matches!(job.state, JobState::Queued | JobState::Paused) => {}
        JobEvent::Retry if job.state == JobState::Failed => {
            if !job
                .attempt
                .failure
                .as_ref()
                .is_some_and(|failure| failure.retryable)
            {
                return Err(JobError::NotRetryable);
            }
            next.state = JobState::Queued;
            next.phase = "queued".to_owned();
            next.completed_units = 0;
            next.total_units = 1;
            next.attempt.attempt += 1;
            next.attempt.started_at = None;
            next.attempt.finished_at = None;
            next.attempt.failure = None;
            next.artifact_path = None;
        }
        _ => {
            return Err(JobError::InvalidTransition {
                from: job.state,
                event: event_name,
            });
        }
    }
    next.updated_at = now;
    Ok(next)
}

pub fn create_job_json(spec_json: &str, now: String) -> Result<String, JobError> {
    let spec: JobSpec =
        serde_json::from_str(spec_json).map_err(|error| JobError::Contract(error.to_string()))?;
    serde_json::to_string(&create_job(spec, now)?)
        .map_err(|error| JobError::Contract(error.to_string()))
}

pub fn apply_event_json(job_json: &str, event_json: &str, now: String) -> Result<String, JobError> {
    let job: PersistedJob =
        serde_json::from_str(job_json).map_err(|error| JobError::Contract(error.to_string()))?;
    let event: JobEvent =
        serde_json::from_str(event_json).map_err(|error| JobError::Contract(error.to_string()))?;
    serde_json::to_string(&apply_event(&job, event, now)?)
        .map_err(|error| JobError::Contract(error.to_string()))
}

fn validate_spec(spec: &JobSpec) -> Result<(), JobError> {
    if spec.schema_version != JOB_SCHEMA_VERSION {
        return Err(JobError::UnsupportedSchema(spec.schema_version));
    }
    if spec.job_id.trim().is_empty()
        || spec.campaign_id.trim().is_empty()
        || spec.asset_hash.trim().is_empty()
        || spec.idempotency_key.trim().is_empty()
        || spec.engine_version.trim().is_empty()
    {
        return Err(JobError::EmptyIdentity);
    }
    Ok(())
}

fn event_name(event: &JobEvent) -> &'static str {
    match event {
        JobEvent::StartPreparing => "start_preparing",
        JobEvent::StartRunning => "start_running",
        JobEvent::Progress { .. } => "progress",
        JobEvent::RequestPause => "request_pause",
        JobEvent::ConfirmPaused => "confirm_paused",
        JobEvent::Resume => "resume",
        JobEvent::RequestCancel => "request_cancel",
        JobEvent::ConfirmCancelled => "confirm_cancelled",
        JobEvent::Succeed { .. } => "succeed",
        JobEvent::Fail { .. } => "fail",
        JobEvent::RecoverAfterReload => "recover_after_reload",
        JobEvent::Retry => "retry",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(kind: JobKind) -> JobSpec {
        let options = "{\"tier\":\"preview_720p\"}";
        JobSpec {
            schema_version: JOB_SCHEMA_VERSION,
            job_id: "job-1".into(),
            campaign_id: "campaign-1".into(),
            asset_hash: "a".repeat(64),
            kind,
            idempotency_key: build_idempotency_key(kind, &"a".repeat(64), options, "m2-v1"),
            engine_version: "m2-v1".into(),
            normalized_options_json: options.into(),
            priority: 20,
        }
    }

    #[test]
    fn duplicate_enqueue_has_identical_key() {
        assert_eq!(
            spec(JobKind::Proxy).idempotency_key,
            spec(JobKind::Proxy).idempotency_key
        );
        assert_ne!(
            spec(JobKind::Proxy).idempotency_key,
            spec(JobKind::Waveform).idempotency_key
        );
    }

    #[test]
    fn reload_during_proxy_returns_same_job_to_queue_with_new_attempt() {
        let queued = create_job(spec(JobKind::Proxy), "t0".into()).unwrap();
        let preparing = apply_event(&queued, JobEvent::StartPreparing, "t1".into()).unwrap();
        let running = apply_event(&preparing, JobEvent::StartRunning, "t2".into()).unwrap();
        let recovered = apply_event(&running, JobEvent::RecoverAfterReload, "t3".into()).unwrap();
        assert_eq!(recovered.spec.job_id, "job-1");
        assert_eq!(recovered.state, JobState::Queued);
        assert_eq!(recovered.attempt.attempt, 2);
    }

    #[test]
    fn worker_crash_is_retryable_and_retry_creates_attempt() {
        let queued = create_job(spec(JobKind::Waveform), "t0".into()).unwrap();
        let preparing = apply_event(&queued, JobEvent::StartPreparing, "t1".into()).unwrap();
        let failed = apply_event(
            &preparing,
            JobEvent::Fail {
                failure: JobFailure {
                    code: "worker_crash".into(),
                    message: "Worker stopped".into(),
                    action: "Retry waveform".into(),
                    retryable: true,
                },
            },
            "t2".into(),
        )
        .unwrap();
        let retried = apply_event(&failed, JobEvent::Retry, "t3".into()).unwrap();
        assert_eq!(retried.state, JobState::Queued);
        assert_eq!(retried.attempt.attempt, 2);
    }

    #[test]
    fn cancel_has_explicit_cancelling_state() {
        let queued = create_job(spec(JobKind::Probe), "t0".into()).unwrap();
        let cancelling = apply_event(&queued, JobEvent::RequestCancel, "t1".into()).unwrap();
        assert_eq!(cancelling.state, JobState::Cancelling);
        let cancelled = apply_event(&cancelling, JobEvent::ConfirmCancelled, "t2".into()).unwrap();
        assert_eq!(cancelled.state, JobState::Cancelled);
    }
    #[test]
    fn transcription_cancel_worker_error_retry_and_stale_request_are_deterministic() {
        let queued = create_job(spec(JobKind::Transcription), "t0".into()).unwrap();
        let preparing = apply_event(&queued, JobEvent::StartPreparing, "t1".into()).unwrap();
        let running = apply_event(&preparing, JobEvent::StartRunning, "t2".into()).unwrap();
        let stale = apply_event(&running, JobEvent::RecoverAfterReload, "t3".into()).unwrap();
        assert_eq!(stale.state, JobState::Queued);
        assert_eq!(stale.attempt.attempt, 2);
        let preparing = apply_event(&stale, JobEvent::StartPreparing, "t4".into()).unwrap();
        let failed = apply_event(
            &preparing,
            JobEvent::Fail {
                failure: JobFailure {
                    code: "transcription_worker_error".into(),
                    message: "Worker stopped".into(),
                    action: "Retry transcription".into(),
                    retryable: true,
                },
            },
            "t5".into(),
        )
        .unwrap();
        let retried = apply_event(&failed, JobEvent::Retry, "t6".into()).unwrap();
        assert_eq!(retried.attempt.attempt, 3);
        let cancelling = apply_event(&retried, JobEvent::RequestCancel, "t7".into()).unwrap();
        let cancelled = apply_event(&cancelling, JobEvent::ConfirmCancelled, "t8".into()).unwrap();
        assert_eq!(cancelled.state, JobState::Cancelled);
    }

    #[test]
    fn thumbnail_uses_shared_idempotency_and_cancellation_state_machine() {
        let first = spec(JobKind::Thumbnail);
        let second = spec(JobKind::Thumbnail);
        assert_eq!(first.idempotency_key, second.idempotency_key);
        assert_ne!(first.idempotency_key, spec(JobKind::Proxy).idempotency_key);
        let queued = create_job(first, "t0".into()).unwrap();
        let preparing = apply_event(&queued, JobEvent::StartPreparing, "t1".into()).unwrap();
        let running = apply_event(&preparing, JobEvent::StartRunning, "t2".into()).unwrap();
        let cancelling = apply_event(&running, JobEvent::RequestCancel, "t3".into()).unwrap();
        let cancelled = apply_event(&cancelling, JobEvent::ConfirmCancelled, "t4".into()).unwrap();
        assert_eq!(cancelled.state, JobState::Cancelled);
    }
}
