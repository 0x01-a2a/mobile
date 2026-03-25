package world.zerox1.pilot

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import java.io.File

/**
 * HighlightRecorder — manages screen recording via MediaProjection for agent highlight reels.
 *
 * Usage:
 *   1. User grants screen capture permission via NodeModule.requestScreenCapture().
 *   2. The resulting resultCode + data Intent are stored via setProjectionGrant().
 *   3. Agent calls POST /phone/highlight/start → start(context).
 *   4. Agent calls POST /phone/highlight/stop  → stop() returns the saved file URI.
 *
 * Recordings are saved to the camera roll (MediaStore.Video.Media DCIM/Highlights).
 */
object HighlightRecorder {

    private const val TAG = "HighlightRecorder"

    // Stored from onActivityResult in NodeModule
    @Volatile var projectionResultCode: Int = 0
    @Volatile var projectionResultData: Intent? = null

    @Volatile private var projection: MediaProjection? = null
    @Volatile private var recorder: MediaRecorder? = null
    @Volatile private var virtualDisplay: VirtualDisplay? = null
    @Volatile private var activeFile: File? = null
    @Volatile var isRecording = false
        private set

    /** True if the user has granted screen capture permission. */
    val hasGrant: Boolean get() = projectionResultCode != 0 && projectionResultData != null

    /**
     * Start recording. Returns null on success, error string on failure.
     * Must be called from any thread — internally uses main handler for MediaProjection setup.
     */
    fun start(context: Context): String? {
        if (isRecording) return "already_recording"
        if (!hasGrant) return "no_screen_capture_grant: call requestScreenCapture() first"

        return try {
            val metrics = DisplayMetrics()
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                context.display?.getRealMetrics(metrics)
            } else {
                @Suppress("DEPRECATION")
                wm.defaultDisplay.getRealMetrics(metrics)
            }
            val width  = metrics.widthPixels
            val height = metrics.heightPixels
            val dpi    = metrics.densityDpi

            // Temp file in cache dir — will be moved to MediaStore on stop
            val tmpFile = File(context.cacheDir, "highlight_${System.currentTimeMillis()}.mp4")
            activeFile = tmpFile

            val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            rec.apply {
                setVideoSource(MediaRecorder.VideoSource.SURFACE)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setVideoEncoder(MediaRecorder.VideoEncoder.H264)
                setVideoSize(width, height)
                setVideoFrameRate(30)
                setVideoEncodingBitRate(5_000_000)
                setOutputFile(tmpFile.absolutePath)
                prepare()
            }
            recorder = rec

            val mgr = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val proj = mgr.getMediaProjection(projectionResultCode, projectionResultData!!)
            projection = proj

            // MediaProjection callbacks must run on a looper thread
            val cb = object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.i(TAG, "MediaProjection stopped by system")
                    cleanupRecorder()
                }
            }
            proj.registerCallback(cb, Handler(Looper.getMainLooper()))

            virtualDisplay = proj.createVirtualDisplay(
                "HighlightRecorder",
                width, height, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                rec.surface, null, null,
            )

            rec.start()
            isRecording = true
            Log.i(TAG, "Highlight recording started → ${tmpFile.absolutePath}")
            null  // success
        } catch (e: Exception) {
            Log.e(TAG, "start() failed: $e")
            cleanupRecorder()
            "recorder_error: ${e.message}"
        }
    }

    /**
     * Stop recording and save to MediaStore (camera roll).
     * Returns a data class with the MediaStore URI and filename, or null on failure.
     */
    fun stop(context: Context): StopResult {
        if (!isRecording) return StopResult(ok = false, error = "not_recording")

        return try {
            recorder?.apply {
                stop()
                reset()
                release()
            }
            recorder = null
            virtualDisplay?.release()
            virtualDisplay = null
            projection?.stop()
            projection = null
            isRecording = false

            val tmp = activeFile ?: return StopResult(ok = false, error = "no_active_file")
            activeFile = null

            // Save to MediaStore Videos (DCIM/Highlights)
            val displayName = "Highlight_${System.currentTimeMillis()}.mp4"
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, displayName)
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                put(MediaStore.Video.Media.RELATIVE_PATH, "DCIM/Highlights")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(MediaStore.Video.Media.IS_PENDING, 1)
                }
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
                ?: return StopResult(ok = false, error = "mediastore_insert_failed")

            resolver.openOutputStream(uri)?.use { out ->
                tmp.inputStream().use { it.copyTo(out) }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.clear()
                values.put(MediaStore.Video.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            }

            tmp.delete()
            Log.i(TAG, "Highlight saved → $uri ($displayName)")
            StopResult(ok = true, uri = uri.toString(), filename = displayName)
        } catch (e: Exception) {
            Log.e(TAG, "stop() failed: $e")
            cleanupRecorder()
            StopResult(ok = false, error = "stop_error: ${e.message}")
        }
    }

    private fun cleanupRecorder() {
        runCatching { recorder?.reset(); recorder?.release() }
        recorder = null
        runCatching { virtualDisplay?.release() }
        virtualDisplay = null
        runCatching { projection?.stop() }
        projection = null
        activeFile?.delete()
        activeFile = null
        isRecording = false
    }

    data class StopResult(
        val ok: Boolean,
        val uri: String? = null,
        val filename: String? = null,
        val error: String? = null,
    )
}
