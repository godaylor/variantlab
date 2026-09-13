/* @ts-self-types="./variantlab_wasm.d.ts" */

import * as wasm from "./variantlab_wasm_bg.wasm";
import { __wbg_set_wasm } from "./variantlab_wasm_bg.js";
__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    CompositorSession, TICKS_PER_SECOND, acknowledgeSyncOutbox, appendSyncOutbox, applyEffectPasses, applyMaskFeather, creativePreviewAssignments, floorToFrame, forkRecovered, formatTimecode, getLastFrameProfile, guessTimecodeFormat, initializeGpu, isFrameAligned, jobApplyEvent, jobBuildIdempotencyKey, jobCreate, lastFrameTime, mediaPlanDerivatives, mediaTimeAdd, mediaTimeClamp, mediaTimeFromFrame, mediaTimeFromSeconds, mediaTimeMax, mediaTimeMin, mediaTimeSub, mediaTimeToFrame, mediaTimeToSeconds, parseTimecode, probeLogoPng, renderApplyEvent, renderBuildArtifactReceipt, renderCodecPreflight, renderCreateLocalBatch, renderFilename, renderFramePlan, renderLogoOverlay, renderManifestChecksum, renderNormalizeDeliverableManifest, renderOverlays, renderRequiredAssets, renderSourceCrop, renderTextOverlay, renderTiming, renderUniqueFilenames, renderUntaggedVideoColorSpace, renderValidateBundleReceipts, roundToFrame, snappedSeekTime, studioCreateCampaign, studioPlanConnectedSync, studioPrepareCommand, studioSnapshotHash, timelineApplyEdit, timelineCreateStressFixture, timelineDefault, timelineSessionPreviewEdit, timelineSessionRelease, timelineSessionSetBase, timelineSessionVisibleClips, timelineVisibleClips, transcriptDiagnose, transcriptSegment, variantBrandKitFingerprint, variantBuildRenderManifest, variantProjectionPage, variantResolve, variantThumbnailSchedule
} from "./variantlab_wasm_bg.js";
