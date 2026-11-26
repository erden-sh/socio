package expo.modules.socioscanner

import android.annotation.SuppressLint
import android.content.Context
import android.os.SystemClock
import android.util.Log
import android.util.Size
import android.view.ViewGroup
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The QR scanner's camera (README.md): CameraX's back camera in a PreviewView, and an ImageAnalysis
 * (about 1280x720, only the latest frame kept) whose Y plane goes to ZXing (QrDecoder). Bound to the
 * activity's lifecycle, so CameraX stops it in the background and starts it again on return; this
 * view unbinds its own use cases (never anyone else's) when it leaves the window, when `active` goes
 * false and when the view is destroyed. A code is sent once, then again only after DEBOUNCE_MS or
 * when another code comes. Events are sent on the main thread.
 */
@SuppressLint("ViewConstructor")
class SocioScannerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onCode by EventDispatcher<Map<String, String>>()
  private val onMountError by EventDispatcher<Map<String, String>>()

  private val previewView = PreviewView(context).apply {
    // A TextureView: it sits in React Native's view tree like any view (a SurfaceView draws in a
    // window of its own, behind or over the screen's other views).
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }

  private var provider: ProcessCameraProvider? = null
  private var preview: Preview? = null
  private var analysis: ImageAnalysis? = null
  private var camera: Camera? = null
  private var analyzer: ExecutorService? = null

  private var torch = false
  private var active = true
  private var attached = false
  private var released = false

  @Volatile private var lastCode: String? = null
  @Volatile private var lastCodeAt = 0L
  private var frames = 0

  init {
    addView(previewView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  // React Native lays this view out but not the PreviewView inside it, so measure and place it here.
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    measureChild(previewView, widthMeasureSpec, heightMeasureSpec)
    setMeasuredDimension(
      ViewGroup.resolveSize(previewView.measuredWidth, widthMeasureSpec),
      ViewGroup.resolveSize(previewView.measuredHeight, heightMeasureSpec)
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    previewView.measure(
      MeasureSpec.makeMeasureSpec(right - left, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(bottom - top, MeasureSpec.EXACTLY)
    )
    previewView.layout(0, 0, right - left, bottom - top)
  }

  fun setTorch(on: Boolean) {
    torch = on
    camera?.let { if (it.cameraInfo.hasFlashUnit()) it.cameraControl.enableTorch(on) }
  }

  fun setActive(on: Boolean) {
    if (active == on) return
    active = on
    if (on) start() else stop()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    attached = true
    start()
  }

  override fun onDetachedFromWindow() {
    attached = false
    stop()
    super.onDetachedFromWindow()
  }

  /** The view is gone for good: its use cases unbound and its analyzer thread ended. */
  fun release() {
    released = true
    stop()
    analyzer?.shutdown()
    analyzer = null
  }

  private fun start() {
    if (!attached || !active || released || camera != null) return
    val owner = appContext.currentActivity as? LifecycleOwner
    if (owner == null) {
      mountError("No activity to run the camera in.")
      return
    }
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      try {
        val cameraProvider = future.get()
        provider = cameraProvider
        // The view may have left, or been turned off, while the provider came.
        if (!attached || !active || released || camera != null) return@addListener
        bind(cameraProvider, owner)
      } catch (e: Exception) {
        mountError(e.message ?: "The camera didn't start.")
      }
    }, ContextCompat.getMainExecutor(context))
  }

  private fun bind(cameraProvider: ProcessCameraProvider, owner: LifecycleOwner) {
    val selector = CameraSelector.DEFAULT_BACK_CAMERA
    if (!cameraProvider.hasCamera(selector)) {
      mountError("This device has no back camera.")
      return
    }
    val newPreview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
    val executor = analyzer ?: Executors.newSingleThreadExecutor().also { analyzer = it }
    val decoder = QrDecoder()
    val newAnalysis = ImageAnalysis.Builder()
      .setResolutionSelector(
        ResolutionSelector.Builder()
          .setResolutionStrategy(
            ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)
          )
          .build()
      )
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
      .build()
      .also { it.setAnalyzer(executor) { image -> analyze(image, decoder) } }
    try {
      camera = cameraProvider.bindToLifecycle(owner, selector, newPreview, newAnalysis)
      preview = newPreview
      analysis = newAnalysis
      setTorch(torch)
    } catch (e: Exception) {
      newAnalysis.clearAnalyzer()
      mountError(e.message ?: "The camera didn't start.")
    }
  }

  private fun stop() {
    val cameraProvider = provider
    analysis?.clearAnalyzer()
    if (cameraProvider != null) {
      val ours = listOfNotNull(preview, analysis)
      if (ours.isNotEmpty()) cameraProvider.unbind(*ours.toTypedArray())
    }
    preview = null
    analysis = null
    camera = null
  }

  /** On the analyzer thread: the frame's Y plane, packed, to the decoder; the frame is always closed. */
  private fun analyze(image: ImageProxy, decoder: QrDecoder) {
    try {
      val luma = lumaOf(image)
      // The middle of the frame (the on-screen frame and a margin) every time, the whole frame every
      // third, for a code held off-center or far away.
      frames = (frames + 1) % 3
      val text = decoder.decode(luma, image.width, image.height, CENTER_FRACTION)
        ?: if (frames == 0) decoder.decode(luma, image.width, image.height, 1.0) else null
      if (text != null) send(text)
    } catch (e: Exception) {
      Log.w(TAG, "A frame couldn't be read", e)
    } finally {
      image.close()
    }
  }

  private fun send(text: String) {
    val now = SystemClock.elapsedRealtime()
    if (text == lastCode && now - lastCodeAt < DEBOUNCE_MS) return
    lastCode = text
    lastCodeAt = now
    post { if (!released) onCode(mapOf("data" to text)) }
  }

  private fun mountError(message: String) {
    post { if (!released) onMountError(mapOf("message" to message)) }
  }

  companion object {
    private const val TAG = "SocioScanner"
    /** How much of the frame's shorter side the first look covers, centered. */
    const val CENTER_FRACTION = 0.75
    /** The same code is sent again only after this long. */
    const val DEBOUNCE_MS = 1500L

    /** A YUV_420_888 frame's Y plane as width x height bytes, rows packed (the plane's rows may be padded). */
    fun lumaOf(image: ImageProxy): ByteArray {
      val plane = image.planes[0]
      val buffer = plane.buffer.duplicate()
      val width = image.width
      val height = image.height
      val rowStride = plane.rowStride
      val pixelStride = plane.pixelStride
      val out = ByteArray(width * height)
      if (pixelStride == 1 && rowStride == width) {
        buffer.rewind()
        buffer.get(out, 0, out.size)
        return out
      }
      val row = ByteArray(rowStride)
      for (y in 0 until height) {
        buffer.position(y * rowStride)
        val length = minOf(rowStride, buffer.remaining())
        buffer.get(row, 0, length)
        if (pixelStride == 1) {
          System.arraycopy(row, 0, out, y * width, width)
        } else {
          for (x in 0 until width) out[y * width + x] = row[x * pixelStride]
        }
      }
      return out
    }
  }
}
