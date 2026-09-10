use crate::{JobFailure, JobState};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use thiserror::Error;
use ts_rs::TS;

pub const RENDER_JOB_SCHEMA_VERSION: u32 = 1;
pub const LOCAL_RENDER_BATCH_LIMIT: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RenderPhase {
    Preflight,
    Preparing,
    Rendering,
    Muxing,
    Verifying,
    Persisting,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct RenderJobSpec {
    pub schema_version: u32,
    pub job_id: String,
    pub campaign_id: String,
    pub master_sequence_id: String,
    pub cell_id: String,
    pub campaign_revision: u32,
    pub render_manifest_sha256: String,
    pub preset: String,
    pub filename: String,
    pub destination: String,
    pub idempotency_key: String,
    pub engine_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderAttempt {
    pub attempt: u32,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub failure: Option<JobFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PersistedRenderJob {
    pub spec: RenderJobSpec,
    pub state: JobState,
    pub phase: RenderPhase,
    pub progress_milli: u16,
    pub stale: bool,
    pub resumable_local: bool,
    pub attempt: RenderAttempt,
    pub artifact_path: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LocalRenderBatch {
    pub jobs: Vec<PersistedRenderJob>,
    pub skipped_succeeded_idempotency_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "event", rename_all = "snake_case")]
#[ts(export)]
pub enum RenderJobEvent {
    Start,
    Progress {
        phase: RenderPhase,
        progress_milli: u16,
    },
    Cancel,
    ConfirmCancelled,
    Fail {
        failure: JobFailure,
    },
    Succeed {
        artifact_path: String,
    },
    RecoverAfterReload,
    Retry,
    MarkStale,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RenderJobError {
    #[error("local render batch must contain between 1 and {LOCAL_RENDER_BATCH_LIMIT} cells")]
    BatchLimit,
    #[error(
        "connected render batch must contain between 1 and {CONNECTED_RENDER_BATCH_LIMIT} cells"
    )]
    ConnectedBatchLimit,
    #[error("render job identity or immutable manifest fields are invalid")]
    InvalidSpec,
    #[error("render batch contains duplicate cells or idempotency keys")]
    DuplicateJob,
    #[error("render progress is outside 0..=1000")]
    InvalidProgress,
    #[error("invalid render transition")]
    InvalidTransition,
    #[error("only retryable failed renders can be retried")]
    NotRetryable,
}

pub fn create_local_render_batch(
    specs: Vec<RenderJobSpec>,
    succeeded_idempotency_keys: &BTreeSet<String>,
    now: String,
) -> Result<LocalRenderBatch, RenderJobError> {
    if specs.is_empty() || specs.len() > LOCAL_RENDER_BATCH_LIMIT {
        return Err(RenderJobError::BatchLimit);
    }
    let mut cells = BTreeSet::new();
    let mut keys = BTreeSet::new();
    let mut jobs = Vec::new();
    let mut skipped = Vec::new();
    for spec in specs {
        validate_render_spec(&spec)?;
        if !cells.insert(spec.cell_id.clone()) || !keys.insert(spec.idempotency_key.clone()) {
            return Err(RenderJobError::DuplicateJob);
        }
        if succeeded_idempotency_keys.contains(&spec.idempotency_key) {
            skipped.push(spec.idempotency_key);
            continue;
        }
        jobs.push(PersistedRenderJob {
            spec,
            state: JobState::Queued,
            phase: RenderPhase::Preflight,
            progress_milli: 0,
            stale: false,
            resumable_local: true,
            attempt: RenderAttempt {
                attempt: 1,
                started_at: None,
                finished_at: None,
                failure: None,
            },
            artifact_path: None,
            updated_at: now.clone(),
        });
    }
    skipped.sort();
    Ok(LocalRenderBatch {
        jobs,
        skipped_succeeded_idempotency_keys: skipped,
    })
}

pub fn apply_render_event(
    job: &PersistedRenderJob,
    event: RenderJobEvent,
    now: String,
) -> Result<PersistedRenderJob, RenderJobError> {
    validate_render_spec(&job.spec)?;
    let mut next = job.clone();
    match event {
        RenderJobEvent::Start if job.state == JobState::Queued => {
            next.state = JobState::Preparing;
            next.phase = RenderPhase::Preparing;
            next.attempt.started_at = Some(now.clone());
        }
        RenderJobEvent::Progress {
            phase,
            progress_milli,
        } if matches!(job.state, JobState::Preparing | JobState::Running) => {
            if progress_milli > 1000 {
                return Err(RenderJobError::InvalidProgress);
            }
            next.state = JobState::Running;
            next.phase = phase;
            next.progress_milli = progress_milli;
        }
        RenderJobEvent::Cancel
            if matches!(
                job.state,
                JobState::Queued | JobState::Preparing | JobState::Running
            ) =>
        {
            next.state = JobState::Cancelling;
        }
        RenderJobEvent::ConfirmCancelled if job.state == JobState::Cancelling => {
            next.state = JobState::Cancelled;
            next.attempt.finished_at = Some(now.clone());
        }
        RenderJobEvent::Fail { failure }
            if matches!(
                job.state,
                JobState::Preparing | JobState::Running | JobState::Cancelling
            ) =>
        {
            next.state = JobState::Failed;
            next.attempt.finished_at = Some(now.clone());
            next.attempt.failure = Some(failure);
        }
        RenderJobEvent::Succeed { artifact_path }
            if matches!(job.state, JobState::Preparing | JobState::Running) =>
        {
            next.state = JobState::Succeeded;
            next.phase = RenderPhase::Complete;
            next.progress_milli = 1000;
            next.artifact_path = Some(artifact_path);
            next.attempt.finished_at = Some(now.clone());
        }
        RenderJobEvent::RecoverAfterReload
            if matches!(
                job.state,
                JobState::Preparing | JobState::Running | JobState::Cancelling
            ) =>
        {
            next.state = JobState::Queued;
            next.phase = RenderPhase::Preflight;
            next.progress_milli = 0;
            next.attempt.attempt += 1;
            next.attempt.started_at = None;
            next.attempt.finished_at = None;
            next.attempt.failure = None;
        }
        RenderJobEvent::Retry if job.state == JobState::Failed => {
            if !job
                .attempt
                .failure
                .as_ref()
                .is_some_and(|failure| failure.retryable)
            {
                return Err(RenderJobError::NotRetryable);
            }
            next.state = JobState::Queued;
            next.phase = RenderPhase::Preflight;
            next.progress_milli = 0;
            next.attempt.attempt += 1;
            next.attempt.started_at = None;
            next.attempt.finished_at = None;
            next.attempt.failure = None;
            next.artifact_path = None;
        }
        RenderJobEvent::MarkStale => next.stale = true,
        _ => return Err(RenderJobError::InvalidTransition),
    }
    next.updated_at = now;
    Ok(next)
}

fn validate_render_spec(spec: &RenderJobSpec) -> Result<(), RenderJobError> {
    if spec.schema_version != RENDER_JOB_SCHEMA_VERSION
        || spec.job_id.trim().is_empty()
        || spec.campaign_id.trim().is_empty()
        || spec.master_sequence_id.trim().is_empty()
        || spec.cell_id.trim().is_empty()
        || spec.filename.trim().is_empty()
        || spec.idempotency_key.len() != 64
        || spec.render_manifest_sha256.len() != 64
    {
        return Err(RenderJobError::InvalidSpec);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(index: usize) -> RenderJobSpec {
        RenderJobSpec {
            schema_version: RENDER_JOB_SCHEMA_VERSION,
            job_id: format!("job-{index}"),
            campaign_id: "campaign".into(),
            master_sequence_id: "sequence".into(),
            cell_id: format!("cell-{index}"),
            campaign_revision: 7,
            render_manifest_sha256: format!("{index:064x}"),
            preset: "webm_vp9_opus".into(),
            filename: format!("cell-{index}.webm"),
            destination: "browser_download".into(),
            idempotency_key: format!("{:064x}", index + 20),
            engine_version: "variantlab-m7-v1".into(),
        }
    }

    #[test]
    fn rust_enforces_eight_cell_local_limit() {
        assert!(
            create_local_render_batch((0..8).map(spec).collect(), &BTreeSet::new(), "t0".into())
                .is_ok()
        );
        assert_eq!(
            create_local_render_batch((0..9).map(spec).collect(), &BTreeSet::new(), "t0".into()),
            Err(RenderJobError::BatchLimit)
        );
    }

    #[test]
    fn rust_enforces_fifty_cell_connected_limit_and_cloud_durability() {
        let batch = create_connected_render_batch(
            "tenant-a".into(),
            "batch-a".into(),
            (0..50).map(spec).collect(),
            &BTreeSet::new(),
            "t0".into(),
        )
        .unwrap();
        assert_eq!(batch.jobs.len(), 50);
        assert!(batch.jobs.iter().all(|job| !job.resumable_local));
        assert_eq!(
            create_connected_render_batch(
                "tenant-a".into(),
                "batch-over-limit".into(),
                (0..51).map(spec).collect(),
                &BTreeSet::new(),
                "t0".into(),
            ),
            Err(RenderJobError::ConnectedBatchLimit)
        );
    }

    #[test]
    fn reload_is_honest_retry_is_failed_only_and_success_is_deduplicated() {
        let queued = create_local_render_batch(vec![spec(1)], &BTreeSet::new(), "t0".into())
            .unwrap()
            .jobs
            .remove(0);
        let preparing = apply_render_event(&queued, RenderJobEvent::Start, "t1".into()).unwrap();
        let running = apply_render_event(
            &preparing,
            RenderJobEvent::Progress {
                phase: RenderPhase::Rendering,
                progress_milli: 400,
            },
            "t2".into(),
        )
        .unwrap();
        let recovered =
            apply_render_event(&running, RenderJobEvent::RecoverAfterReload, "t3".into()).unwrap();
        assert_eq!(recovered.state, JobState::Queued);
        assert_eq!(recovered.attempt.attempt, 2);
        assert_eq!(
            apply_render_event(&recovered, RenderJobEvent::Retry, "t4".into()),
            Err(RenderJobError::InvalidTransition)
        );
        let succeeded = BTreeSet::from([recovered.spec.idempotency_key.clone()]);
        let batch =
            create_local_render_batch(vec![recovered.spec], &succeeded, "t4".into()).unwrap();
        assert!(batch.jobs.is_empty());
        assert_eq!(batch.skipped_succeeded_idempotency_keys.len(), 1);
    }

    #[test]
    fn cancellation_is_supported_in_prepare_render_and_mux() {
        for phase in [
            RenderPhase::Preparing,
            RenderPhase::Rendering,
            RenderPhase::Muxing,
        ] {
            let queued = create_local_render_batch(vec![spec(2)], &BTreeSet::new(), "t0".into())
                .unwrap()
                .jobs
                .remove(0);
            let preparing =
                apply_render_event(&queued, RenderJobEvent::Start, "t1".into()).unwrap();
            let active = if phase == RenderPhase::Preparing {
                preparing
            } else {
                apply_render_event(
                    &preparing,
                    RenderJobEvent::Progress {
                        phase,
                        progress_milli: 500,
                    },
                    "t2".into(),
                )
                .unwrap()
            };
            let cancelling =
                apply_render_event(&active, RenderJobEvent::Cancel, "t3".into()).unwrap();
            assert_eq!(cancelling.state, JobState::Cancelling);
        }
    }
}
pub const CONNECTED_RENDER_BATCH_LIMIT: usize = 50;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConnectedRenderBatch {
    pub tenant_id: String,
    pub batch_id: String,
    pub jobs: Vec<PersistedRenderJob>,
    pub skipped_succeeded_idempotency_keys: Vec<String>,
}

pub fn create_connected_render_batch(
    tenant_id: String,
    batch_id: String,
    specs: Vec<RenderJobSpec>,
    succeeded_idempotency_keys: &BTreeSet<String>,
    now: String,
) -> Result<ConnectedRenderBatch, RenderJobError> {
    if tenant_id.trim().is_empty() || batch_id.trim().is_empty() {
        return Err(RenderJobError::InvalidSpec);
    }
    if specs.is_empty() || specs.len() > CONNECTED_RENDER_BATCH_LIMIT {
        return Err(RenderJobError::ConnectedBatchLimit);
    }
    let mut cells = BTreeSet::new();
    let mut keys = BTreeSet::new();
    let mut jobs = Vec::new();
    let mut skipped = Vec::new();
    for spec in specs {
        validate_render_spec(&spec)?;
        if !cells.insert(spec.cell_id.clone()) || !keys.insert(spec.idempotency_key.clone()) {
            return Err(RenderJobError::DuplicateJob);
        }
        if succeeded_idempotency_keys.contains(&spec.idempotency_key) {
            skipped.push(spec.idempotency_key);
            continue;
        }
        jobs.push(PersistedRenderJob {
            spec,
            state: JobState::Queued,
            phase: RenderPhase::Preflight,
            progress_milli: 0,
            stale: false,
            resumable_local: false,
            attempt: RenderAttempt {
                attempt: 1,
                started_at: None,
                finished_at: None,
                failure: None,
            },
            artifact_path: None,
            updated_at: now.clone(),
        });
    }
    skipped.sort();
    Ok(ConnectedRenderBatch {
        tenant_id,
        batch_id,
        jobs,
        skipped_succeeded_idempotency_keys: skipped,
    })
}
